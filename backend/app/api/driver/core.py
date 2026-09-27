"""السائق — الملف والتسجيل والوثائق، والكاش والأجر (م-11)، والتسويات وكشفها، والإشعارات.

رصيده وتسوياته من driver_own_balances وv_driver_settlements: صفوفه هو وحدها. قرار المالك 27/09:
يرى حالة وثائقه لا صورها.
"""
from __future__ import annotations

from datetime import date

from fastapi import APIRouter, Depends, File, Form, Request, Response, UploadFile

from app.api.deps import Principal, driver_user
from app.core.db import Tx
from app.core.errors import ApiError
from app.core.money import fmt
from app.schemas.driver import (AvailabilityIn, ContactOut, DeviceIn, DriverOut, MediaOut, Me2Out, NotificationOut, ReadIn, RegistrationIn,
                                SettlementOut, WalletOut)
from app.services.media import PUBLIC, PURPOSES
from app.services.pdf import esc, render, rows

router = APIRouter()

DRIVER_SQL = """
SELECT d.id, d.full_name, d.status::text AS status, d.pay_method::text AS pay_method, d.vehicle::text AS vehicle,
       d.capacity_kg, d.phone, ci.name_ar AS city_name, d.city,
       (d.id_media_id IS NOT NULL AND d.license_media_id IS NOT NULL AND d.license_back_media_id IS NOT NULL
        AND d.photo_media_id IS NOT NULL) AS documents_complete, d.accepting
  FROM drivers d JOIN cities ci ON ci.code = d.city WHERE d.user_id = :u"""


async def driver(t: Tx, user_id: int) -> dict:
    row = await t.one(DRIVER_SQL, u=user_id)
    if row is None:
        raise ApiError(404, "no_driver")
    return row


def _out(d: dict) -> DriverOut:
    return DriverOut(**{k: v for k, v in d.items() if k != "city"})


@router.get("/me", response_model=Me2Out)
async def me(request: Request, p: Principal = Depends(driver_user)) -> Me2Out:
    async with request.app.state.db.tx("driver", p.user_id) as t:
        name = await t.val("SELECT full_name FROM app_users WHERE id = :u", u=p.user_id)
        unread = await t.val("SELECT count(*) FROM notifications WHERE user_id = :u AND read_at IS NULL", u=p.user_id)
        d = await t.one(DRIVER_SQL, u=p.user_id)
        c = await t.one("SELECT contact_phone AS phone, contact_whatsapp AS whatsapp FROM city_settings WHERE city = :c",
                        c=request.app.state.settings.auth_city)
    return Me2Out(full_name=d["full_name"] if d else name, driver=_out(d) if d else None, unread=unread,
                  contact=ContactOut(**c) if c else None)


@router.put("/availability", response_model=Me2Out)
async def availability(body: AvailabilityIn, request: Request, p: Principal = Depends(driver_user)) -> Me2Out:
    # §12-ط «أستقبل طلبيات الآن»: غير المتاح لا تُعرض عليه طلبيات ولا يقبل ولا يعرض أجرة (القاعدة)
    async with request.app.state.db.tx("driver", p.user_id) as t:
        await driver(t, p.user_id)
        await t.run("UPDATE drivers SET accepting = :a WHERE user_id = :u", a=body.accepting, u=p.user_id)
    return await me(request, p)


@router.post("/media", response_model=MediaOut, status_code=201)
async def upload(request: Request, purpose: str = Form(...), file: UploadFile = File(...),
                 p: Principal = Depends(driver_user)) -> MediaOut:
    if purpose not in PURPOSES["driver"]:
        raise ApiError(422, "media_purpose_unknown")
    key, mime, size, sha = request.app.state.media.put(await file.read())
    async with request.app.state.db.tx("driver", p.user_id) as t:
        mid = await t.val("INSERT INTO media_files (storage_key, mime_type, byte_size, sha256, is_private) "
                          "VALUES (:k, :m, :s, :h, :pv) RETURNING id", k=key, m=mime, s=size, h=sha, pv=purpose not in PUBLIC)
    return MediaOut(id=mid)


@router.post("/registration", response_model=DriverOut, status_code=201)
async def register(body: RegistrationIn, request: Request, p: Principal = Depends(driver_user)) -> DriverOut:
    """الخطوة 4: الاسم والمركبة وسعتها، والهوية والرخصة بوجهيها والصورة — بانتظار اعتماد اللوحة."""
    async with request.app.state.db.tx("driver", p.user_id) as t:
        if await t.val("SELECT 1 FROM drivers WHERE user_id = :u", u=p.user_id):
            raise ApiError(409, "driver_exists")
        phone = await t.val("SELECT phone FROM app_users WHERE id = :u", u=p.user_id)
        await t.run("INSERT INTO drivers (user_id, city, full_name, phone, id_media_id, license_media_id, license_back_media_id, "
                    "photo_media_id, vehicle, capacity_kg) VALUES (:u, :c, :n, :ph, :i, :l, :lb, :pm, CAST(:v AS vehicle_type), :cap)",
                    u=p.user_id, c=request.app.state.settings.auth_city, n=body.full_name.strip(), ph=phone,
                    i=body.id_media_id, l=body.license_media_id, lb=body.license_back_media_id, pm=body.photo_media_id,
                    v=body.vehicle, cap=body.capacity_kg)
        await t.run("UPDATE app_users SET full_name = :n WHERE id = :u", n=body.full_name.strip(), u=p.user_id)
        return _out(await driver(t, p.user_id))


# ——— الكاش والأجر والتسويات (م-11) ———————————————————————————————————————————————————
@router.get("/wallet", response_model=WalletOut)
async def wallet(request: Request, p: Principal = Depends(driver_user)) -> WalletOut:
    """الكاش بحوزتي مقابل السقف، وأجري المستحق، وما أسلّمه: بالمقاصّة الكاشُ ناقص الأجر، وإلا الكاش كله."""
    async with request.app.state.db.tx("driver", p.user_id) as t:
        d = await driver(t, p.user_id)
        b = await t.one("SELECT cash_held, wage_due FROM driver_own_balances()")
        cap = await t.val("SELECT driver_cash_cap FROM city_settings WHERE city = :c", c=d["city"])
    handover = max(b["cash_held"] - b["wage_due"], 0) if d["pay_method"] == "offset_on_settlement" else b["cash_held"]
    rule = {"offset_on_settlement": "at_next_handover", "periodic": "pending_decision"}.get(d["pay_method"] or "")
    return WalletOut(cash_held=b["cash_held"], cash_cap=cap, over_cap=cap is not None and b["cash_held"] > cap,
                     wage_due=b["wage_due"], pay_method=d["pay_method"], handover_due=handover,
                     next_payout_on=None, next_payout_rule=rule)


def _month(month: str | None) -> date:
    if not month:
        return date.today().replace(day=1)
    try:
        y, m = (int(x) for x in month.split("-"))
        return date(y, m, 1)
    except ValueError:
        raise ApiError(422, "month_invalid") from None


async def _settlements(t: Tx, month: str | None) -> tuple[date, list[SettlementOut]]:
    start = _month(month)
    got = await t.all("SELECT kind, id, amount, offset_amount, order_id, received_by, at FROM v_driver_settlements "
                      "WHERE at >= :s AND at < (CAST(:s AS date) + interval '1 month') ORDER BY at DESC, id DESC", s=start)
    return start, [SettlementOut(**r) for r in got]


@router.get("/settlements", response_model=list[SettlementOut])
async def settlements(request: Request, month: str | None = None, p: Principal = Depends(driver_user)) -> list[SettlementOut]:
    async with request.app.state.db.tx("driver", p.user_id) as t:
        await driver(t, p.user_id)
        return (await _settlements(t, month))[1]


KIND_AR = {"handover": "تسليم كاش للخزينة", "payout": "صرف أجر", "wage": "أجر طلبية"}


@router.get("/settlements.pdf", response_class=Response, responses={200: {"content": {"application/pdf": {}}}})
async def statement(request: Request, month: str | None = None, p: Principal = Depends(driver_user)) -> Response:
    """كشف الشهر: ما سلّمه، وما صُرف له، وأجر كل طلبية — بلا سعر شراء ولا مورد."""
    async with request.app.state.db.tx("driver", p.user_id) as t:
        d = await driver(t, p.user_id)
        start, items = await _settlements(t, month)
    body = (f"<h1>كشف {esc(d['full_name'])}</h1><p>الشهر <span class='num'>{start:%m/%Y}</span></p>"
            "<table><thead><tr><th>اليوم</th><th>الحركة</th><th>الطلبية</th><th>المبلغ</th></tr></thead><tbody>"
            + rows([[s.at.strftime("%d/%m") if s.at else "", KIND_AR.get(s.kind, s.kind),
                     f"#{s.order_id}" if s.order_id else "", fmt(s.amount)] for s in items], numeric_from=2)
            + "</tbody></table>")
    return Response(render(title="كشف السائق", body=body), media_type="application/pdf")


# ——— الإشعارات ————————————————————————————————————————————————————————————————————
async def _inbox(t: Tx, user_id: int) -> list[NotificationOut]:
    got = await t.all("SELECT id, kind, title, body, order_id, created_at, read_at IS NOT NULL AS read FROM notifications "
                      "WHERE user_id = :u ORDER BY created_at DESC, id DESC LIMIT 100", u=user_id)
    return [NotificationOut(**r) for r in got]


@router.get("/notifications", response_model=list[NotificationOut])
async def notifications(request: Request, p: Principal = Depends(driver_user)) -> list[NotificationOut]:
    async with request.app.state.db.tx("driver", p.user_id) as t:
        return await _inbox(t, p.user_id)


@router.post("/notifications/read", response_model=list[NotificationOut])
async def read(body: ReadIn, request: Request, p: Principal = Depends(driver_user)) -> list[NotificationOut]:
    async with request.app.state.db.tx("driver", p.user_id) as t:
        await t.run("UPDATE notifications SET read_at = now() WHERE user_id = :u AND read_at IS NULL "
                    "AND (:all OR id = ANY(CAST(:ids AS bigint[])))", u=p.user_id, all=body.all, ids=body.ids)
        return await _inbox(t, p.user_id)


@router.post("/devices", status_code=204)
async def device(body: DeviceIn, request: Request, p: Principal = Depends(driver_user)) -> Response:
    async with request.app.state.db.tx("driver", p.user_id) as t:
        await t.run("INSERT INTO device_tokens (user_id, fcm_token, platform) VALUES (:u, :tok, :pl) "
                    "ON CONFLICT (fcm_token) DO UPDATE SET user_id = EXCLUDED.user_id, platform = EXCLUDED.platform, "
                    "updated_at = now()", u=p.user_id, tok=body.fcm_token, pl=body.platform)
    return Response(status_code=204)
