"""الدخول (م-14): رمز التحقق مرة واحدة عند التسجيل، ثم الهاتف وكلمة المرور دائماً،
في الجماهير الأربعة. الوصول قصير، والتجديد يُدوَّر، وإعادة استعمال رمز مستهلك تُبطل
العائلة كلها. حدّ المحاولات على (رقم + نوع الحساب).

كل عمليات هذا الموجّه بفاعل «system»: لا مستخدم مسمّى قبل الدخول.
"""
from __future__ import annotations

import uuid
from datetime import timedelta
from enum import Enum

import jwt
from fastapi import APIRouter, Depends, Request, Response

from app.core import security
from app.core.db import Tx
from app.core.errors import ApiError
from app.api.deps import Principal, any_user
from app.schemas.auth import (ChangePasswordIn, CompleteIn, LoginIn, LoginOut, RefreshIn, ResetCompleteIn, StartIn,
                              StartOut, TicketOut, TokensOut, VerifyIn)
from app.services import otp

router = APIRouter(prefix="/api/auth", tags=["auth"])

RESEND_SECONDS = 60


class Aud(str, Enum):
    customer = "customer"
    supplier = "supplier"
    driver = "driver"
    admin = "admin"


def _s(request: Request):
    return request.app.state.settings


async def _limits(t: Tx, city: str) -> tuple[int, int]:
    row = await t.one("SELECT login_max_failures AS m, login_lock_minutes AS l FROM city_settings WHERE city = :c",
                      c=city)
    if row is None:
        raise ApiError(500, "missing_setting", setting="city_settings.login_*")
    return row["m"], row["l"]


async def _locked_for(t: Tx, phone: str, aud: str) -> int | None:
    """ثوانٍ باقية على القفل، أو None."""
    return await t.val("SELECT ceil(extract(epoch FROM locked_until - now()))::int FROM auth_throttle "
                       "WHERE phone = :p AND audience = CAST(:a AS audience) AND locked_until > now()",
                       p=phone, a=aud)


async def _fail(t: Tx, phone: str, aud: str, city: str) -> int:
    """يسجّل محاولة خاطئة ويقفل عند الحدّ. يعيد المحاولات الباقية (0 = قُفل الآن)."""
    max_f, lock_min = await _limits(t, city)
    count = await t.val(
        "INSERT INTO auth_throttle (phone, audience, failed_count) VALUES (:p, CAST(:a AS audience), 1) "
        "ON CONFLICT (phone, audience) DO UPDATE SET failed_count = auth_throttle.failed_count + 1 "
        "RETURNING failed_count", p=phone, a=aud)
    if count >= max_f:
        await t.run("UPDATE auth_throttle SET failed_count = 0, locked_until = now() + make_interval(mins => :m) "
                    "WHERE phone = :p AND audience = CAST(:a AS audience)", m=lock_min, p=phone, a=aud)
        return 0
    return max_f - count


async def _issue(request: Request, t: Tx, user_id: int, aud: str, family: str | None = None,
                 out: type[TokensOut] = TokensOut) -> TokensOut:
    s = _s(request)
    # م-20: بعد إعادة التعيين من اللوحة يحمل الرمز mc، فلا يفتح إلا تغيير كلمة المرور
    mc = bool(await t.val("SELECT must_change_password FROM app_users WHERE id = :u", u=user_id))
    access = security.sign(s.jwt_secret, typ="access", ttl=timedelta(minutes=s.access_ttl_minutes),
                           sub=str(user_id), au=aud, mc=mc)
    refresh = security.new_refresh_token()
    await t.run("INSERT INTO refresh_tokens (user_id, audience, family_id, token_hash, expires_at) "
                "VALUES (:u, CAST(:a AS audience), CAST(:f AS uuid), :h, now() + make_interval(days => :d))",
                u=user_id, a=aud, f=family or str(uuid.uuid4()), h=security.token_hash(refresh),
                d=s.refresh_ttl_days)
    extra = {"must_change_password": mc} if out is LoginOut else {}
    return out(access_token=access, refresh_token=refresh, **extra)


async def _start(request: Request, aud: str, phone: str, purpose: str) -> StartOut:
    """ينشئ تحدياً ثم يرسله عبر القنوات. التحدي يُودَع قبل الإرسال لتُربط به محاولات
    الإرسال، ويُحذف إن لم تصل أي قناة فلا يحجز مهلة الإعادة بلا رمز."""
    s = _s(request)
    code = security.new_otp_code()
    async with request.app.state.db.tx("system") as t:
        if await t.val("SELECT 1 FROM otp_challenges WHERE phone = :p AND audience = CAST(:a AS audience) "
                       "AND consumed_at IS NULL AND created_at > now() - make_interval(secs => :s)",
                       p=phone, a=aud, s=RESEND_SECONDS):
            raise ApiError(429, "otp_too_soon", retry_after_seconds=RESEND_SECONDS)
        ch = await t.val("INSERT INTO otp_challenges (phone, audience, code_hash, expires_at, purpose) "
                         "VALUES (:p, CAST(:a AS audience), :h, now() + make_interval(mins => :m), :pu) RETURNING id",
                         p=phone, a=aud, h=security.otp_hash(s.jwt_secret, phone, aud, code),
                         m=s.otp_ttl_minutes, pu=purpose)
    try:
        channel = await otp.send(request.app, challenge_id=ch, phone=phone, audience=aud, code=code)
    except ApiError:
        async with request.app.state.db.tx("system") as t:
            await t.run("UPDATE otp_challenges SET expires_at = created_at + interval '1 second', "
                        "created_at = created_at - make_interval(secs => :s) WHERE id = :c", c=ch, s=RESEND_SECONDS)
        raise
    return StartOut(channel=channel, expires_in=s.otp_ttl_minutes * 60)


async def _verify(request: Request, aud: str, body: VerifyIn, purpose: str) -> TicketOut:
    s = _s(request)
    left = None
    async with request.app.state.db.tx("system") as t:
        if (wait := await _locked_for(t, body.phone, aud)) is not None:
            raise ApiError(429, "login_locked", retry_after_seconds=wait)
        ch = await t.one("SELECT id, code_hash FROM otp_challenges WHERE phone = :p AND audience = CAST(:a AS audience) "
                         "AND purpose = :pu AND consumed_at IS NULL AND expires_at > now() "
                         "ORDER BY created_at DESC LIMIT 1", p=body.phone, a=aud, pu=purpose)
        if ch is None:
            raise ApiError(409, "otp_expired")
        if ch["code_hash"] != security.otp_hash(s.jwt_secret, body.phone, aud, body.code):
            left = await _fail(t, body.phone, aud, s.auth_city)
    if left is not None:  # المحاولة الخاطئة حُفظت؛ الرفض بعد الإيداع
        raise ApiError(409, "otp_invalid", attempts_left=left)
    return TicketOut(ticket=security.sign(s.jwt_secret, typ=purpose, ttl=timedelta(minutes=s.ticket_ttl_minutes),
                                          ch=ch["id"], ph=body.phone, au=aud))


@router.post("/{audience}/register/start", status_code=202, response_model=StartOut)
async def register_start(audience: Aud, body: StartIn, request: Request) -> StartOut:
    aud = audience
    async with request.app.state.db.tx("system") as t:
        user = await t.one("SELECT id, password_hash FROM app_users WHERE phone = :p AND audience = CAST(:a AS audience)",
                           p=body.phone, a=aud.value)
    if user and user["password_hash"]:
        raise ApiError(409, "already_registered")
    if aud is Aud.admin and user is None:
        raise ApiError(404, "not_invited")  # المشرف يضيفه المالك، ثم يفعّل حسابه
    if not _s(request).otp_sender:
        raise ApiError(503, "otp_channel_unavailable")
    return await _start(request, aud.value, body.phone, "register")


@router.post("/{audience}/register/verify", response_model=TicketOut)
async def register_verify(audience: Aud, body: VerifyIn, request: Request) -> TicketOut:
    return await _verify(request, audience.value, body, "register")


@router.post("/{audience}/register/complete", response_model=TokensOut)
async def register_complete(audience: Aud, body: CompleteIn, request: Request) -> TokensOut:
    aud = audience
    s = _s(request)
    try:
        claims = security.read(s.jwt_secret, body.ticket, typ="register")
    except jwt.PyJWTError:
        raise ApiError(401, "ticket_invalid") from None
    if claims["au"] != aud.value:
        raise ApiError(403, "wrong_audience")
    async with request.app.state.db.tx("system") as t:
        # الاستهلاك مرة واحدة: الشرط هنا، والفهرس otp_register_once في القاعدة
        if not await t.val("UPDATE otp_challenges SET consumed_at = now() WHERE id = :i AND consumed_at IS NULL "
                           "RETURNING id", i=claims["ch"]):
            raise ApiError(409, "otp_already_used")
        user = await t.one("SELECT id, password_hash FROM app_users WHERE phone = :p AND audience = CAST(:a AS audience)",
                           p=claims["ph"], a=aud.value)
        if user and user["password_hash"]:
            raise ApiError(409, "already_registered")
        pw = security.hash_password(body.password)
        if user:
            uid = user["id"]
            await t.run("UPDATE app_users SET phone_verified_at = now(), password_hash = :h, password_set_at = now() "
                        "WHERE id = :u", h=pw, u=uid)
        else:
            uid = await t.val("INSERT INTO app_users (phone, audience, full_name, phone_verified_at, password_hash, "
                              "password_set_at) VALUES (:p, CAST(:a AS audience), :n, now(), :h, now()) RETURNING id",
                              p=claims["ph"], a=aud.value, n=body.full_name.strip(), h=pw)
        return await _issue(request, t, uid, aud.value)


@router.post("/{audience}/login", response_model=LoginOut)
async def login(audience: Aud, body: LoginIn, request: Request) -> LoginOut:
    aud = audience
    s = _s(request)
    left = None
    async with request.app.state.db.tx("system") as t:
        if (wait := await _locked_for(t, body.phone, aud.value)) is not None:
            raise ApiError(429, "login_locked", retry_after_seconds=wait)
        user = await t.one("SELECT id, password_hash, active FROM app_users WHERE phone = :p "
                           "AND audience = CAST(:a AS audience)", p=body.phone, a=aud.value)
        if user is None or not security.verify_password(body.password, user["password_hash"]):
            left = await _fail(t, body.phone, aud.value, s.auth_city)
        elif not user["active"]:
            raise ApiError(403, "account_disabled")
        else:
            await t.run("DELETE FROM auth_throttle WHERE phone = :p AND audience = CAST(:a AS audience)",
                        p=body.phone, a=aud.value)
            return await _issue(request, t, user["id"], aud.value, out=LoginOut)
    # attempts_left = 0: هذه آخر محاولة، والرقم موقوف الآن على هذا الجمهور
    raise ApiError(401, "login_failed", attempts_left=left)


@router.post("/refresh", response_model=TokensOut)
async def refresh(body: RefreshIn, request: Request) -> TokensOut:
    verdict = None
    async with request.app.state.db.tx("system") as t:
        row = await t.one(
            "SELECT r.id, r.user_id, r.audience::text AS audience, r.family_id::text AS family, r.consumed_at, "
            "r.revoked_at, r.expires_at <= now() AS expired, u.active "
            "FROM refresh_tokens r JOIN app_users u ON u.id = r.user_id WHERE r.token_hash = :h FOR UPDATE OF r",
            h=security.token_hash(body.refresh_token))
        if row is None:
            verdict = "refresh_invalid"
        elif row["revoked_at"] is not None:
            verdict = "refresh_revoked"
        elif row["consumed_at"] is not None:
            # سرقة محتملة: تُبطَل العائلة كلها، ويُودَع الإبطال قبل الرفض
            await t.run("UPDATE refresh_tokens SET revoked_at = now() WHERE family_id = CAST(:f AS uuid) "
                        "AND revoked_at IS NULL", f=row["family"])
            verdict = "refresh_reused"
        elif row["expired"]:
            verdict = "refresh_token_expired"
        elif not row["active"]:
            verdict = "account_disabled"
        else:
            await t.run("UPDATE refresh_tokens SET consumed_at = now() WHERE id = :i", i=row["id"])
            return await _issue(request, t, row["user_id"], row["audience"], family=row["family"])
    raise ApiError(401, verdict)


@router.post("/logout", status_code=204)
async def logout(body: RefreshIn, request: Request) -> Response:
    async with request.app.state.db.tx("system") as t:
        await t.run("UPDATE refresh_tokens SET revoked_at = now() WHERE revoked_at IS NULL AND family_id = "
                    "(SELECT family_id FROM refresh_tokens WHERE token_hash = :h)",
                    h=security.token_hash(body.refresh_token))
    return Response(status_code=204)


# ——— م-20: استعادة كلمة المرور برمز جديد ————————————————————————————————————————
@router.post("/{audience}/reset/start", status_code=202, response_model=StartOut)
async def reset_start(audience: Aud, body: StartIn, request: Request) -> StartOut:
    async with request.app.state.db.tx("system") as t:
        user = await t.one("SELECT password_hash FROM app_users WHERE phone = :p AND audience = CAST(:a AS audience) "
                           "AND active", p=body.phone, a=audience.value)
    if not user or not user["password_hash"]:
        raise ApiError(404, "not_registered")
    if not _s(request).otp_sender:
        raise ApiError(503, "otp_channel_unavailable")
    return await _start(request, audience.value, body.phone, "reset")


@router.post("/{audience}/reset/verify", response_model=TicketOut)
async def reset_verify(audience: Aud, body: VerifyIn, request: Request) -> TicketOut:
    return await _verify(request, audience.value, body, "reset")


@router.post("/{audience}/reset/complete", response_model=TokensOut)
async def reset_complete(audience: Aud, body: ResetCompleteIn, request: Request) -> TokensOut:
    s = _s(request)
    try:
        claims = security.read(s.jwt_secret, body.ticket, typ="reset")
    except jwt.PyJWTError:
        raise ApiError(401, "ticket_invalid") from None
    if claims["au"] != audience.value:
        raise ApiError(403, "wrong_audience")
    async with request.app.state.db.tx("system") as t:
        if not await t.val("UPDATE otp_challenges SET consumed_at = now() WHERE id = :i AND consumed_at IS NULL "
                           "RETURNING id", i=claims["ch"]):
            raise ApiError(409, "otp_already_used")
        uid = await t.val("SELECT id FROM app_users WHERE phone = :p AND audience = CAST(:a AS audience)",
                          p=claims["ph"], a=audience.value)
        await t.run("SELECT set_config('madad.reset_method', 'otp', true)")
        await t.run("UPDATE app_users SET password_hash = :h WHERE id = :u", h=security.hash_password(body.password), u=uid)
        # كلمة جديدة تُبطل كل الجلسات القائمة
        await t.run("UPDATE refresh_tokens SET revoked_at = now() WHERE user_id = :u AND revoked_at IS NULL", u=uid)
        return await _issue(request, t, uid, audience.value)


# ——— تغيير كلمة المرور بيد صاحبها (ومنه الإلزامي بعد إعادة تعيين المالك) —————————————————
@router.post("/password", status_code=204)
async def change_password(body: ChangePasswordIn, request: Request, p: Principal = Depends(any_user)) -> Response:
    async with request.app.state.db.tx("system") as t:
        current = await t.val("SELECT password_hash FROM app_users WHERE id = :u", u=p.user_id)
        if not security.verify_password(body.current_password, current):
            raise ApiError(401, "login_failed")
        await t.run("SELECT set_config('madad.reset_method', 'self', true)")
        await t.run("UPDATE app_users SET password_hash = :h WHERE id = :u",
                    h=security.hash_password(body.new_password), u=p.user_id)
    return Response(status_code=204)
