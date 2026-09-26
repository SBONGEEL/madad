"""م-14 على السلك: رمز مرة واحدة عند التسجيل، ثم الهاتف وكلمة المرور دائماً.
وتجديد جلسة كامل لكل جمهور (§11.6)، وحدّ المحاولات على (رقم + نوع الحساب).
"""
from __future__ import annotations

import pytest

from tests.api.world_api import PASSWORD, PHONES, live_world, login
from tests.db.world import act, build

NEW = "+218920000009"


async def _register(client, app, audience="customer", phone=NEW, password="new-pass-2026"):
    r = await client.post(f"/api/auth/{audience}/register/start", json={"phone": phone})
    assert r.status_code == 202, r.text
    assert r.json()["channel"] == "whatsapp"
    code = app.state.otp_outbox[-1]["code"]
    r = await client.post(f"/api/auth/{audience}/register/verify", json={"phone": phone, "code": code})
    assert r.status_code == 200, r.text
    r = await client.post(f"/api/auth/{audience}/register/complete",
                          json={"ticket": r.json()["ticket"], "password": password, "full_name": "مستخدم جديد"})
    return r


async def test_register_once_then_password_login(db, client, app):
    await build(db)
    r = await _register(client, app)
    assert r.status_code == 200, r.text
    assert set(r.json()) == {"access_token", "refresh_token", "token_type"}

    r = await client.post("/api/auth/customer/login", json={"phone": NEW, "password": "new-pass-2026"})
    assert r.status_code == 200, r.text

    # لا رمز ثانٍ لرقم مسجَّل: التسجيل مرة واحدة، والدخول بكلمة المرور
    again = await client.post("/api/auth/customer/register/start", json={"phone": NEW})
    assert again.status_code == 409 and again.json()["code"] == "already_registered"

    # الرقم نفسه يجوز أن يكون مورداً بحساب منفصل (§1.1)
    assert (await _register(client, app, audience="supplier")).status_code == 200


async def test_password_is_stored_as_bcrypt_only(db, client, app):
    await build(db)
    await _register(client, app, password="plain-visible-2026")
    stored = await db.fetchval("SELECT password_hash FROM app_users WHERE phone = $1", NEW)
    assert stored.startswith("$2") and "plain-visible-2026" not in stored


async def test_wrong_code_is_rejected_and_code_is_not_reusable(db, client, app):
    await build(db)
    await client.post("/api/auth/customer/register/start", json={"phone": NEW})
    code = app.state.otp_outbox[-1]["code"]
    bad = "000000" if code != "000000" else "111111"
    r = await client.post("/api/auth/customer/register/verify", json={"phone": NEW, "code": bad})
    assert r.status_code == 409 and r.json()["code"] == "otp_invalid"
    ticket = (await client.post("/api/auth/customer/register/verify", json={"phone": NEW, "code": code})).json()["ticket"]
    body = {"ticket": ticket, "password": "new-pass-2026", "full_name": "م"}
    assert (await client.post("/api/auth/customer/register/complete", json=body)).status_code == 200
    reuse = await client.post("/api/auth/customer/register/complete", json=body)
    assert reuse.status_code == 409, reuse.text


async def test_short_password_is_refused(db, client, app):
    await build(db)
    r = await _register(client, app, password="short")
    assert r.status_code == 422


async def test_admin_cannot_self_register(db, client):
    await build(db)
    r = await client.post("/api/auth/admin/register/start", json={"phone": NEW})
    assert r.status_code == 404 and r.json()["code"] == "not_invited"


async def test_no_otp_channel_is_a_clear_refusal(db, client, app):
    await build(db)
    app.state.settings.otp_sender = ""
    r = await client.post("/api/auth/customer/register/start", json={"phone": NEW})
    assert r.status_code == 503 and r.json()["code"] == "otp_channel_unavailable"


async def test_lockout_is_per_phone_and_account_type(db, client):
    live = await live_world(db, client)
    for _ in range(5):
        r = await client.post("/api/auth/customer/login", json={"phone": PHONES["customer"], "password": "wrong-1234"})
        assert r.status_code == 401
    locked = await client.post("/api/auth/customer/login", json={"phone": PHONES["customer"], "password": PASSWORD})
    assert locked.status_code == 429 and locked.json()["code"] == "login_locked"
    # الرقم نفسه على جمهور آخر غير موقوف: الحدّ على (رقم + نوع)
    await act(db, "system")
    await db.execute("UPDATE app_users SET phone = $1 WHERE id = $2", PHONES["customer"], live.w.drv_user)
    r = await client.post("/api/auth/driver/login", json={"phone": PHONES["customer"], "password": PASSWORD})
    assert r.status_code == 200, r.text


@pytest.mark.parametrize("audience", ["customer", "supplier", "driver", "admin"])
async def test_full_session_renewal_per_audience(db, client, audience):
    await live_world(db, client)
    first = await login(client, audience)
    me = f"/api/{audience}/me"
    assert (await client.get(me, headers={"Authorization": f"Bearer {first['access_token']}"})).status_code == 200

    second = (await client.post("/api/auth/refresh", json={"refresh_token": first["refresh_token"]})).json()
    assert second["refresh_token"] != first["refresh_token"]
    assert (await client.get(me, headers={"Authorization": f"Bearer {second['access_token']}"})).status_code == 200

    # إعادة استعمال رمز مستهلك تُبطل العائلة كلها
    reuse = await client.post("/api/auth/refresh", json={"refresh_token": first["refresh_token"]})
    assert reuse.status_code == 401 and reuse.json()["code"] == "refresh_reused"
    dead = await client.post("/api/auth/refresh", json={"refresh_token": second["refresh_token"]})
    assert dead.status_code == 401

    third = await login(client, audience)
    assert (await client.post("/api/auth/logout", json={"refresh_token": third["refresh_token"]})).status_code == 204
    assert (await client.post("/api/auth/refresh", json={"refresh_token": third["refresh_token"]})).status_code == 401
