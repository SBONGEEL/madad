"""م-20 وم-24 على السلك، وحارس التسرّب لنقاطهما:

- استعادة كلمة المرور برمز جديد، وإعادة تعيينها من اللوحة بيد المالك (تُلزم بالتغيير).
- إرسال الرمز عبر القنوات بترتيب المالك، والانتقال للتالية عند الفشل مع إشعار المالك.
- رمز «console» يستحيل على الإنتاج.

حارس التسرّب لهذه النقاط (شرط استثناء 3): لا استجابة تحمل تجزئة كلمة مرور ولا شاهداً من
شواهد العزل — test_recovery_responses_carry_no_hash_or_canary.
"""
from __future__ import annotations

import pydantic
import pytest

from app.core.config import Settings
from app.services import otp
from app.services.otp.providers import ProviderError
from tests.api.world_api import PASSWORD, PHONES, live_world, login
from tests.db.test_isolation import COST_CANARIES, SUPPLIER_FORBIDDEN, leaks
from tests.db.world import act

HASH_MARK = "$2b$"
NEW_PW = "fresh-pass-2026"


def clean(*responses) -> None:
    for r in responses:
        assert HASH_MARK not in r.text, r.text[:200]
        assert leaks(r.text, COST_CANARIES + SUPPLIER_FORBIDDEN) == [], r.text[:200]


async def _reset(client, app, audience="customer", phone=None, password=NEW_PW):
    phone = phone or PHONES[audience]
    r1 = await client.post(f"/api/auth/{audience}/reset/start", json={"phone": phone})
    assert r1.status_code == 202, r1.text
    code = app.state.otp_outbox[-1]["code"]
    r2 = await client.post(f"/api/auth/{audience}/reset/verify", json={"phone": phone, "code": code})
    assert r2.status_code == 200, r2.text
    r3 = await client.post(f"/api/auth/{audience}/reset/complete",
                           json={"ticket": r2.json()["ticket"], "password": password})
    return r1, r2, r3


async def test_recovery_responses_carry_no_hash_or_canary(db, client, app):
    live = await live_world(db, client)
    r1, r2, r3 = await _reset(client, app)
    reset = await client.post(f"/api/admin/users/{live.w.cust_user}/reset-password", headers=live.auth("admin"))
    assert reset.status_code == 200
    clean(r1, r2, r3, reset)
    assert set(reset.json()) == {"temporary_password"}


async def test_reset_by_new_code_both_ways(db, client, app):
    live = await live_world(db, client)
    old = await login(client, "customer")
    _, _, r3 = await _reset(client, app)
    assert r3.status_code == 200 and set(r3.json()) == {"access_token", "refresh_token", "token_type"}
    assert (await client.post("/api/auth/customer/login", json={"phone": PHONES["customer"], "password": PASSWORD})).status_code == 401
    assert (await client.post("/api/auth/customer/login", json={"phone": PHONES["customer"], "password": NEW_PW})).status_code == 200
    # كلمة جديدة تُبطل الجلسات القديمة
    assert (await client.post("/api/auth/refresh", json={"refresh_token": old["refresh_token"]})).status_code == 401
    assert await db.fetchval("SELECT method::text FROM password_reset_events WHERE user_id = $1", live.w.cust_user) == "otp"


async def test_reset_needs_an_existing_account_and_its_own_ticket(db, client, app):
    await live_world(db, client)
    r = await client.post("/api/auth/customer/reset/start", json={"phone": "+218920000077"})
    assert r.status_code == 404 and r.json()["code"] == "not_registered"
    # تذكرة تسجيل لا تكمل استعادة
    await client.post("/api/auth/customer/register/start", json={"phone": "+218920000078"})
    code = app.state.otp_outbox[-1]["code"]
    t = (await client.post("/api/auth/customer/register/verify", json={"phone": "+218920000078", "code": code})).json()
    bad = await client.post("/api/auth/customer/reset/complete", json={"ticket": t["ticket"], "password": NEW_PW})
    assert bad.status_code == 401 and bad.json()["code"] == "ticket_invalid"


async def test_owner_reset_forces_a_change_before_anything_else(db, client, app):
    live = await live_world(db, client)
    temp = (await client.post(f"/api/admin/users/{live.w.cust_user}/reset-password",
                              headers=live.auth("admin"))).json()["temporary_password"]
    r = await client.post("/api/auth/customer/login", json={"phone": PHONES["customer"], "password": temp})
    assert r.status_code == 200 and r.json()["must_change_password"] is True
    h = {"Authorization": f"Bearer {r.json()['access_token']}"}
    blocked = await client.get("/api/customer/me", headers=h)
    assert blocked.status_code == 403 and blocked.json()["code"] == "password_change_required"
    ch = await client.post("/api/auth/password", headers=h, json={"current_password": temp, "new_password": NEW_PW})
    assert ch.status_code == 204, ch.text
    r = await client.post("/api/auth/customer/login", json={"phone": PHONES["customer"], "password": NEW_PW})
    assert r.json()["must_change_password"] is False
    assert (await client.get("/api/customer/me", headers={"Authorization": f"Bearer {r.json()['access_token']}"})).status_code == 200
    methods = [x["method"] for x in await db.fetch(
        "SELECT method::text FROM password_reset_events WHERE user_id = $1 ORDER BY id", live.w.cust_user)]
    assert methods == ["admin", "self"]


async def test_only_the_owner_resets_from_the_panel(db, client):
    live = await live_world(db, client)
    await act(db, "system")
    sup = await db.fetchval("INSERT INTO app_users (phone, audience, full_name, phone_verified_at, password_hash) "
                            "SELECT '+218910000031', 'admin', 'مشرف', now(), password_hash FROM app_users WHERE id = $1 "
                            "RETURNING id", live.w.owner)
    await db.execute("INSERT INTO admin_members (user_id, role) VALUES ($1, 'supervisor')", sup)
    await db.execute("INSERT INTO admin_permissions (user_id, permission) VALUES ($1, 'users')", sup)
    tok = (await client.post("/api/auth/admin/login", json={"phone": "+218910000031", "password": PASSWORD})).json()
    r = await client.post(f"/api/admin/users/{live.w.cust_user}/reset-password",
                          headers={"Authorization": f"Bearer {tok['access_token']}"})
    assert r.status_code == 403 and r.json()["code"] == "forbidden_owner_only"


# ——— م-24 ————————————————————————————————————————————————————————————————
class Fake:
    def __init__(self, fail: bool):
        self.fail, self.sent = fail, []

    async def send(self, phone, code):
        if self.fail:
            raise ProviderError("number_blocked")
        self.sent.append((phone, code))


async def _challenge(db) -> int:
    await act(db, "system")
    return await db.fetchval("INSERT INTO otp_challenges (phone, audience, code_hash, expires_at) VALUES "
                             "('+218920000001', 'customer', 'x', now() + interval '5 min') RETURNING id")


async def test_failover_to_the_next_channel_and_owner_is_notified(db, client, app):
    live = await live_world(db, client)
    app.state.settings.otp_sender = "channels"
    ch = await _challenge(db)
    official, linked = Fake(fail=True), Fake(fail=False)
    used = await otp.send(app, challenge_id=ch, phone="+218920000001", audience="customer", code="123456",
                          providers={"whatsapp_official": official, "whatsapp_linked": linked, "sms": None})
    assert used == "whatsapp_linked" and linked.sent == [("+218920000001", "123456")]
    rows = [tuple(r) for r in await db.fetch("SELECT channel::text, ok FROM otp_deliveries ORDER BY id")]
    assert rows == [("whatsapp_official", False), ("whatsapp_linked", True)]
    assert await db.fetchval("SELECT user_id FROM notifications WHERE kind = 'otp_channel_failed'") == live.w.owner


async def test_owner_order_and_disabled_channels_are_respected(db, client, app):
    live = await live_world(db, client)
    app.state.settings.otp_sender = "channels"
    await act(db, "admin", live.w.owner)
    await db.execute("UPDATE otp_channels SET enabled = false WHERE channel IN ('whatsapp_official', 'whatsapp_linked')")
    ch = await _challenge(db)
    sms = Fake(fail=False)
    used = await otp.send(app, challenge_id=ch, phone="+218920000001", audience="customer", code="1",
                          providers={"whatsapp_official": Fake(False), "whatsapp_linked": Fake(False), "sms": sms})
    assert used == "sms" and sms.sent


async def test_every_channel_failing_is_a_clear_refusal(db, client, app):
    await live_world(db, client)
    app.state.settings.otp_sender = "channels"
    ch = await _challenge(db)
    with pytest.raises(Exception) as e:
        await otp.send(app, challenge_id=ch, phone="+218920000001", audience="customer", code="1",
                       providers={"whatsapp_official": Fake(True), "whatsapp_linked": Fake(True), "sms": Fake(True)})
    assert getattr(e.value, "code", "") == "otp_channel_unavailable"
    assert await db.fetchval("SELECT count(*) FROM otp_deliveries WHERE NOT ok") == 3


async def test_no_provider_configured_refuses_on_the_wire(db, client, app):
    await live_world(db, client)
    app.state.settings.otp_sender = "channels"     # لا متغيرات مزوّد في بيئة الاختبار
    r = await client.post("/api/auth/customer/register/start", json={"phone": "+218920000055"})
    assert r.status_code == 503 and r.json()["code"] == "otp_channel_unavailable"
    # ولا تُحجز مهلة الإعادة بلا رمز
    app.state.settings.otp_sender = "console"
    assert (await client.post("/api/auth/customer/register/start", json={"phone": "+218920000055"})).status_code == 202


@pytest.mark.parametrize("env", ["production", "staging"])
def test_console_code_is_impossible_outside_development(env):
    with pytest.raises(pydantic.ValidationError) as e:
        Settings(database_url="postgresql+asyncpg://x/y", jwt_secret="s" * 40, env=env, otp_sender="console")
    assert "console" in str(e.value)


def test_console_is_allowed_in_development_and_default_is_production_channels():
    Settings(database_url="postgresql+asyncpg://x/y", jwt_secret="s" * 40, env="development", otp_sender="console")
    s = Settings(database_url="postgresql+asyncpg://x/y", jwt_secret="s" * 40)
    assert (s.env, s.otp_sender) == ("production", "channels")
