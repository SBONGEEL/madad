"""قرارات الدفعة السابعة (§12-ي) على السلك — كل نقطة في الاتجاهين.

حارس التسرّب للنقاط الجديدة (شرط الاستثناء 3): test_leak_responses بحالتها في audience_cases.py (السائق)،
وtest_admin_guards بحالاتها في admin_cases.py (اللوحة)، وtest_leak_openapi — وهنا محتوى كل نقطة، ومنه أن
Mapbox لا يصله إلا الإحداثيات، وأن المورد لا يرى شيئاً عن العميل في الموعد المحسوب.
"""
from __future__ import annotations

from pathlib import Path

import httpx

from app.services.routing import Router
from tests.api.test_admin_guards import SUP_ALL, supervisors
from tests.api.world_api import login, set_passwords
from tests.db.test_isolation import SUPPLIER_FORBIDDEN, leaks
from tests.db.world import ADDRESS_CANARY, CUSTOMER_CANARY, act, build, confirm_and_assign, draft, place
from tests.test_backup_restore import FakeS3

H = lambda tok: {"Authorization": f"Bearer {tok}"}  # noqa: E731


async def _tokens(db, client, *aud):
    await set_passwords(db)
    return [(await login(client, a))["access_token"] for a in aud]


# ——— D-1 وموعد الصرف ————————————————————————————————————————————————————————————————
async def test_general_driver_cycle_reaches_the_driver_wallet(db, client):
    w = await build(db)
    adm, drv = await _tokens(db, client, "admin", "driver")
    g = (await client.get("/api/admin/settings/payout", headers=H(adm))).json()
    assert (g["general"]["mode"], g["general"]["driver_cycle"]) == ("rolling", None)
    wal = (await client.get("/api/driver/wallet", headers=H(drv))).json()
    assert (wal["next_payout_rule"], wal["next_payout_on"]) == ("pending_decision", None)
    r = await client.put("/api/admin/settings/payout", headers=H(adm), json={"mode": "rolling", "driver_cycle": "weekly"})
    assert r.status_code == 200 and r.json()["general"]["driver_cycle"] == "weekly"
    assert r.json()["history"][0]["by"] == "المالك"
    wal = (await client.get("/api/driver/wallet", headers=H(drv))).json()
    assert (wal["next_payout_rule"], wal["payout_cycle"]) == ("periodic", "weekly") and wal["next_payout_on"]
    settle = (await client.get("/api/admin/drivers/settlement", headers=H(adm))).json()
    assert next(x for x in settle if x["id"] == w.driver)["next_payout_on"] == wal["next_payout_on"]


async def test_fixed_days_need_their_days_and_settings_permission(db, client):
    await build(db)
    adm, = await _tokens(db, client, "admin")
    bad = await client.put("/api/admin/settings/payout", headers=H(adm), json={"mode": "fixed", "fixed_weekday": 6})
    assert bad.status_code == 422
    ok = await client.put("/api/admin/settings/payout", headers=H(adm), json={
        "mode": "fixed", "fixed_weekday": 6, "fixed_month_day": 1, "fixed_semimonth_days": [1, 15]})
    assert ok.json()["general"]["fixed_semimonth_days"] == [1, 15]
    none = await client.put("/api/admin/settings/payout", headers=H(adm), json={"driver_cycle": "weekly"})
    assert none.status_code == 422 and none.json()["code"] == "payout_mode_required"


async def test_driver_exception_from_his_file_and_back_to_general(db, client):
    w = await build(db)
    adm, drv = await _tokens(db, client, "admin", "driver")
    await client.put("/api/admin/settings/payout", headers=H(adm), json={"mode": "rolling", "driver_cycle": "weekly"})
    r = (await client.put(f"/api/admin/drivers/{w.driver}/payout", headers=H(adm), json={"driver_cycle": "daily"})).json()
    assert (r["override"]["driver_cycle"], r["payout_cycle"], r["pay_method"]) == ("daily", "daily", "periodic")
    assert (await client.get("/api/driver/wallet", headers=H(drv))).json()["payout_cycle"] == "daily"
    r = (await client.put(f"/api/admin/drivers/{w.driver}/payout", headers=H(adm), json={})).json()
    assert r["override"] is None and r["payout_cycle"] == "weekly" and len(r["history"]) == 2


async def test_supplier_exception_is_schedule_only(db, client):
    w = await build(db)
    adm, sup = await _tokens(db, client, "admin", "supplier")
    no = await client.put(f"/api/admin/suppliers/{w.supplier}/payout", headers=H(adm), json={"driver_cycle": "daily"})
    assert no.status_code == 422 and no.json()["code"] == "supplier_has_own_cycle"
    r = (await client.put(f"/api/admin/suppliers/{w.supplier}/payout", headers=H(adm), json={
        "mode": "fixed", "fixed_weekday": 0, "fixed_month_day": 5, "fixed_semimonth_days": [5, 20]})).json()
    assert r["override"]["mode"] == "fixed" and r["payout_cycle"] == "weekly"
    dues = (await client.get("/api/admin/supplier-dues", headers=H(adm))).json()
    assert next(x for x in dues if x["id"] == w.supplier)["next_payout_on"] == r["next_payout_on"]
    assert (await client.get("/api/supplier/dues", headers=H(sup))).json()["next_payout_on"] == r["next_payout_on"]


async def test_payout_exception_needs_money_permission(db, client):
    w = await build(db)
    await set_passwords(db)
    hdr = (await supervisors(db, client))[SUP_ALL]                     # بلا «التكاليف» — و«المال» معه
    ok = await client.put(f"/api/admin/drivers/{w.driver}/payout", headers=hdr, json={"driver_cycle": "daily"})
    assert ok.status_code == 200
    await act(db, "system")
    await db.execute("DELETE FROM admin_permissions WHERE permission = 'money' AND user_id <> $1", w.owner)
    no = await client.put(f"/api/admin/drivers/{w.driver}/payout", headers=hdr, json={"driver_cycle": "weekly"})
    assert no.status_code == 403


# ——— ن-4 نص الإشعار ——————————————————————————————————————————————————————————————————
async def test_push_text_setting(db, client):
    await build(db)
    adm, = await _tokens(db, client, "admin")
    assert (await client.get("/api/admin/settings/push-text", headers=H(adm))).json() == {"mode": "generic"}
    assert (await client.put("/api/admin/settings/push-text", headers=H(adm), json={"mode": "full"})).json() == {"mode": "full"}
    assert (await client.put("/api/admin/settings/push-text", headers=H(adm), json={"mode": "loud"})).status_code == 422


# ——— ن-3 النسخ الاحتياطية ————————————————————————————————————————————————————————————
async def _ok_run(db, name="madad-20260927-040000.mdbk", data=b"MADADBK1-local", *, local=True, offsite=False):
    await act(db, "system")
    if local:
        Path("storage/backups").mkdir(parents=True, exist_ok=True)
        (Path("storage/backups") / name).write_bytes(data)
    return await db.fetchval(
        "INSERT INTO backup_runs (kind, plan, location, status, finished_at, file_name, byte_size, sha256, local_ok, offsite_ok) "
        "VALUES ('daily', 'daily7_weekly12', $2, 'ok', now(), $1, 14, repeat('a', 64), $3, $4) RETURNING id",
        name, "both" if local and offsite else ("local" if local else "offsite"), local, offsite)


async def test_backups_are_the_owners_alone(db, client):
    await build(db)
    adm, = await _tokens(db, client, "admin")
    hdr = (await supervisors(db, client))[SUP_ALL]
    b = (await client.get("/api/admin/backups", headers=H(adm))).json()
    assert (b["policy"]["plan"], b["policy"]["location"], b["alert"], b["offsite_configured"]) == \
        ("daily7_weekly12", "both", None, False)
    rid = await _ok_run(db)
    for method, url, body in (("GET", "/api/admin/backups", None), ("PUT", "/api/admin/backups/policy",
                                                                    {"plan": "daily30", "location": "local"}),
                              ("GET", f"/api/admin/backups/{rid}/download", None)):
        assert (await client.request(method, url, headers=hdr, json=body)).status_code == 403
    r = await client.put("/api/admin/backups/policy", headers=H(adm), json={"plan": "daily30", "location": "local"})
    assert (r.json()["policy"]["plan"], r.json()["policy"]["location"]) == ("daily30", "local")
    assert await db.fetchval("SELECT count(*) FROM backup_downloads") == 0


async def test_owner_downloads_the_encrypted_copy_and_it_is_logged(db, client, app):
    w = await build(db)
    adm, = await _tokens(db, client, "admin")
    rid = await _ok_run(db)
    r = await client.get(f"/api/admin/backups/{rid}/download", headers=H(adm))
    assert r.status_code == 200 and r.content == b"MADADBK1-local"
    assert "madad-20260927-040000.mdbk" in r.headers["content-disposition"]
    assert await db.fetchval("SELECT user_id FROM backup_downloads WHERE run_id = $1", rid) == w.owner
    # نسخة في المساحة المنفصلة وحدها
    fake = FakeS3()
    fake.objects["madad-20260927-050000.mdbk"] = b"MADADBK1-offsite"
    s = app.state.settings
    s.backup_s3_endpoint, s.backup_s3_bucket, s.backup_s3_access_key, s.backup_s3_secret_key = \
        "https://r2.test", "madad-backups", "AKTEST", "secret-test"
    app.state.s3_transport = fake
    off = await _ok_run(db, "madad-20260927-050000.mdbk", local=False, offsite=True)
    r = await client.get(f"/api/admin/backups/{off}/download", headers=H(adm))
    assert r.status_code == 200 and r.content == b"MADADBK1-offsite"
    assert (await client.get("/api/admin/backups", headers=H(adm))).json()["offsite_configured"] is True


async def test_failed_backup_shows_the_alert_and_cannot_be_downloaded(db, client):
    await build(db)
    adm, = await _tokens(db, client, "admin")
    await act(db, "system")
    rid = await db.fetchval("INSERT INTO backup_runs (kind, plan, location) VALUES ('daily', 'daily7_weekly12', 'both') RETURNING id")
    await db.execute("UPDATE backup_runs SET status = 'failed', finished_at = now(), error = 'passphrase_missing' WHERE id = $1", rid)
    b = (await client.get("/api/admin/backups", headers=H(adm))).json()
    assert b["alert"] == "failed" and b["runs"][0]["error"] == "passphrase_missing" and not b["runs"][0]["downloadable"]
    r = await client.get(f"/api/admin/backups/{rid}/download", headers=H(adm))
    assert r.status_code == 409 and r.json()["code"] == "backup_unavailable"
    inbox = (await client.get("/api/admin/inbox", headers=H(adm))).json()
    assert any(n["kind"] == "backup_failed" for n in inbox)


# ——— ن-5 Mapbox ——————————————————————————————————————————————————————————————————————
class FakeMapbox(httpx.AsyncBaseTransport):
    def __init__(self, status: int = 200) -> None:
        self.status, self.urls = status, []

    async def handle_async_request(self, request: httpx.Request) -> httpx.Response:
        self.urls.append(str(request.url))
        if self.status != 200:
            return httpx.Response(self.status)
        return httpx.Response(200, json={"routes": [{"distance": 12345.6, "duration": 1500}]})


async def _confirmed(db, w):
    oid = await draft(db, w)
    await place(db, w, oid)
    await act(db, "admin", w.owner)
    await db.execute("UPDATE orders SET status = 'confirmed' WHERE id = $1", oid)
    return oid


async def test_route_km_from_mapbox_then_owner_edits_it(db, client, app):
    w = await build(db)
    oid = await _confirmed(db, w)
    adm, = await _tokens(db, client, "admin")
    r = (await client.post(f"/api/admin/orders/{oid}/route-km/compute", headers=H(adm))).json()
    assert r["routing"] == {"status": "unavailable", "reason": "no_key", "route_km": None} and r["detail"]["route_km"] is None
    fake = FakeMapbox()
    app.state.router = Router("pk.test-token", "https://mapbox.test", transport=fake)
    r = (await client.post(f"/api/admin/orders/{oid}/route-km/compute", headers=H(adm))).json()
    assert r["routing"]["status"] == "ok" and r["detail"]["route_km"] == "12.35" and r["detail"]["route_km_source"] == "mapbox"
    # لا يصل Mapbox إلا الإحداثيات (والرمز)
    url = fake.urls[0]
    assert "/directions/v5/mapbox/driving/13.100000,32.850000;13.191000,32.887000" in url
    for canary in (CUSTOMER_CANARY, ADDRESS_CANARY, "+2189", "السائق", "علي"):
        assert canary not in url
    e = (await client.put(f"/api/admin/orders/{oid}/route-km", headers=H(adm), json={"route_km": "14"})).json()
    assert (e["route_km"], e["route_km_source"]) == ("14.00", "manual")


async def test_mapbox_failure_is_explicit_and_changes_nothing(db, client, app):
    w = await build(db)
    oid = await _confirmed(db, w)
    adm, = await _tokens(db, client, "admin")
    await client.put(f"/api/admin/orders/{oid}/route-km", headers=H(adm), json={"route_km": "9"})
    app.state.router = Router("pk.test-token", "https://mapbox.test", transport=FakeMapbox(503))
    r = (await client.post(f"/api/admin/orders/{oid}/route-km/compute", headers=H(adm))).json()
    assert r["routing"] == {"status": "unavailable", "reason": "error", "route_km": None}
    assert (r["detail"]["route_km"], r["detail"]["route_km_source"]) == ("9.00", "manual")


async def test_driver_eta_from_mapbox_editable_and_seen_by_supplier_without_customer(db, client, app):
    w = await build(db)
    oid = await draft(db, w)
    await place(db, w, oid)
    await confirm_and_assign(db, w, oid)
    drv, sup = await _tokens(db, client, "driver", "supplier")
    stop = (await client.get(f"/api/driver/orders/{oid}", headers=H(drv))).json()["stops"][0]["id"]
    pos = {"lat": "32.9000", "lng": "13.2000"}
    r = (await client.post(f"/api/driver/stops/{stop}/eta/auto", headers=H(drv), json=pos)).json()
    assert r["routing"] == {"status": "unavailable", "reason": "no_key"} and r["order"]["stops"][0]["eta_at"] is None
    fake = FakeMapbox()
    app.state.router = Router("pk.test-token", "https://mapbox.test", transport=fake)
    r = (await client.post(f"/api/driver/stops/{stop}/eta/auto", headers=H(drv), json=pos)).json()
    s = r["order"]["stops"][0]
    assert r["routing"]["status"] == "ok" and s["eta_at"] is not None and s["eta_source"] == "mapbox"
    assert "/driving/13.200000,32.900000;13.100000,32.850000" in fake.urls[0]
    pk = await client.get("/api/supplier/pickups", headers=H(sup))
    assert pk.json()[0]["eta_source"] == "mapbox" and not leaks(pk.text, SUPPLIER_FORBIDDEN)
    m = (await client.put(f"/api/driver/stops/{stop}/eta", headers=H(drv), json={"eta_at": "2026-09-27T11:00:00+02:00"})).json()
    assert m["stops"][0]["eta_source"] == "manual"
    assert (await client.get("/api/supplier/pickups", headers=H(sup))).json()[0]["eta_source"] == "manual"
