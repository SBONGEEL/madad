"""صلاحيتا النسخ الاحتياطية على السلك (§12-ك ٢) — كل صلاحية في الاتجاهين، والمالك وحده للتنزيل والإعدادات.

حالاتها في admin_cases.py (test_admin_guards)، والتعداد في test_leak_openapi (اللوحة 106 ← 109).
"""
from __future__ import annotations

from app.core.db import Db
from app.services import backup
from tests.api.world_api import PASSWORD, login, set_passwords
from tests.conftest import _dsn
from tests.db.world import act, build

H = lambda tok: {"Authorization": f"Bearer {tok}"}  # noqa: E731


async def _sup(db, client, phone, perms) -> dict:
    await act(db, "system")
    h = await db.fetchval("SELECT password_hash FROM app_users WHERE phone = '+218910000001'")
    uid = await db.fetchval("INSERT INTO app_users (phone, audience, full_name, phone_verified_at, password_hash) "
                            "VALUES ($1, 'admin', $2, now(), $3) RETURNING id", phone, "مشرف " + phone[-2:], h)
    await db.execute("INSERT INTO admin_members (user_id, role) VALUES ($1, 'supervisor')", uid)
    for p in perms:
        await db.execute("INSERT INTO admin_permissions (user_id, permission) VALUES ($1, $2::admin_permission)", uid, p)
    tok = (await client.post("/api/auth/admin/login", json={"phone": phone, "password": PASSWORD})).json()["access_token"]
    return H(tok)


async def _ok_run(db):
    await act(db, "system")
    return await db.fetchval(
        "INSERT INTO backup_runs (kind, plan, location, status, finished_at, file_name, byte_size, sha256, local_ok) VALUES "
        "('daily', 'daily7_weekly12', 'local', 'ok', now(), 'madad-20260927-060000.mdbk', 1, repeat('a', 64), true) RETURNING id")


async def test_view_permission_sees_status_only(db, client):
    await build(db)
    await set_passwords(db)
    none = await _sup(db, client, "+218910000091", ["settings", "money", "users"])
    view = await _sup(db, client, "+218910000092", ["backups_view"])
    rid = await _ok_run(db)
    assert (await client.get("/api/admin/backups/status", headers=none)).status_code == 403
    r = await client.get("/api/admin/backups/status", headers=view)
    assert r.status_code == 200 and r.json()["runs"][0]["id"] == rid and r.json()["runs"][0]["downloadable"] is False
    assert r.json()["plan"] == "daily7_weekly12"
    for method, url, body in (("GET", "/api/admin/backups", None), ("GET", f"/api/admin/backups/{rid}/download", None),
                              ("PUT", "/api/admin/backups/policy", {"plan": "daily30", "location": "local"}),
                              ("GET", "/api/admin/backups/access", None), ("POST", "/api/admin/backups/run", {})):
        assert (await client.request(method, url, headers=view, json=body)).status_code == 403, url
    assert await db.fetchval("SELECT count(*) FROM backup_access_log WHERE action = 'view'") == 1


async def test_run_permission_requests_a_backup_the_worker_takes(db, client, tmp_path):
    await build(db)
    await set_passwords(db)
    none = await _sup(db, client, "+218910000091", ["backups_view"])
    run = await _sup(db, client, "+218910000092", ["backups_run"])
    assert (await client.post("/api/admin/backups/run", headers=none)).status_code == 403
    assert (await client.post("/api/admin/backups/run", headers=run)).status_code == 202
    again = await client.post("/api/admin/backups/run", headers=run)
    assert again.status_code == 409 and again.json()["code"] == "backup_in_progress"
    assert (await client.get("/api/admin/backups/status", headers=run)).status_code == 403
    # العامل يأخذ الطلب: نسخة يدوية مربوطة به (بلا كلمة سر ← فاشلة ومنبَّه عنها، وهذا يكفي هنا)
    name = await db.fetchval("SELECT current_database()")
    dbx = Db(_dsn(name).replace("postgresql://", "postgresql+asyncpg://"))
    try:
        req = await backup.pending_request(dbx)
        rid = await backup.run_once(dbx, _dsn(name), tmp_path / "m", backup.Places(tmp_path / "l", None), "", request_id=req)
    finally:
        await dbx.close()
    assert await db.fetchval("SELECT kind FROM backup_runs WHERE id = $1", rid) == "manual"
    assert await db.fetchval("SELECT run_id FROM backup_requests WHERE id = $1", req) == rid
    assert (await client.post("/api/admin/backups/run", headers=run)).status_code == 202      # انتهى الأول فيُقبل


async def test_owner_sees_who_did_what_and_when(db, client):
    await build(db)
    await set_passwords(db)
    view = await _sup(db, client, "+218910000092", ["backups_view"])
    run = await _sup(db, client, "+218910000093", ["backups_run"])
    adm = H((await login(client, "admin"))["access_token"])
    rid = await _ok_run(db)
    await client.get("/api/admin/backups/status", headers=view)
    await client.post("/api/admin/backups/run", headers=run)
    await client.get(f"/api/admin/backups/{rid}/download", headers=adm)
    log = (await client.get("/api/admin/backups/access", headers=adm)).json()
    got = {(x["who"], x["action"]) for x in log}
    assert {("مشرف 92", "view"), ("مشرف 93", "create"), ("المالك", "download")} <= got
    assert next(x for x in log if x["action"] == "download")["file_name"] == "madad-20260927-060000.mdbk"


async def test_supervisor_with_users_cannot_grant_backup_permissions(db, client):
    await build(db)
    await set_passwords(db)
    boss = await _sup(db, client, "+218910000094", ["users", "orders"])
    target = await _sup(db, client, "+218910000095", [])
    tid = await db.fetchval("SELECT id FROM app_users WHERE phone = '+218910000095'")
    no = await client.put(f"/api/admin/admins/{tid}/permissions", headers=boss, json={"permissions": ["backups_view"]})
    assert no.status_code == 403
    adm = H((await login(client, "admin"))["access_token"])
    ok = await client.put(f"/api/admin/admins/{tid}/permissions", headers=adm,
                          json={"permissions": ["backups_view", "backups_run"]})
    assert ok.status_code == 200
    assert (await client.get("/api/admin/backups/status", headers=target)).status_code == 200
