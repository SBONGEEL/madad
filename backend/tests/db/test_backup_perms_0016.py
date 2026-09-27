"""الترحيلة 0016 — صلاحيتا النسخ الاحتياطية (§12-ك ٢)، كل قاعدة في الاتجاهين."""
from __future__ import annotations

import asyncpg
import pytest

from tests.db.world import act, build


async def raises(coro, needle):
    with pytest.raises(asyncpg.PostgresError) as e:
        await coro
    assert needle in str(e.value), str(e.value)


async def supervisor(db, perms: list[str], phone="+218910000081") -> int:
    await act(db, "system")
    uid = await db.fetchval("INSERT INTO app_users (phone, audience, full_name) VALUES ($1, 'admin', 'مشرف') RETURNING id", phone)
    await db.execute("INSERT INTO admin_members (user_id, role) VALUES ($1, 'supervisor')", uid)
    for p in perms:
        await db.execute("INSERT INTO admin_permissions (user_id, permission) VALUES ($1, $2::admin_permission)", uid, p)
    return uid


async def test_only_the_owner_grants_the_backup_permissions(db):
    w = await build(db)
    # يملكهما هو نفسه (فيمرّ حارس 0007: لا يمنح إلا ما يملك)، ومع ذلك لا يمنحهما
    boss = await supervisor(db, ["users", "orders", "backups_view", "backups_run"])
    other = await supervisor(db, [], "+218910000082")
    await act(db, "admin", boss)
    await db.execute("INSERT INTO admin_permissions (user_id, permission) VALUES ($1, 'orders')", other)   # المعتاد يمرّ
    for perm in ("backups_view", "backups_run"):
        await raises(db.execute("INSERT INTO admin_permissions (user_id, permission) VALUES ($1, $2::admin_permission)",
                                other, perm), "forbidden_owner_only")
    await act(db, "admin", w.owner)
    await db.execute("INSERT INTO admin_permissions (user_id, permission) VALUES ($1, 'backups_view')", other)
    await act(db, "admin", boss)
    await raises(db.execute("DELETE FROM admin_permissions WHERE user_id = $1 AND permission = 'backups_view'", other),
                 "forbidden_owner_only")


async def test_viewing_needs_backups_view_and_is_logged(db):
    await build(db)
    no = await supervisor(db, ["settings", "money"])
    yes = await supervisor(db, ["backups_view"], "+218910000082")
    await act(db, "admin", no)
    await raises(db.execute("INSERT INTO backup_access_log (action) VALUES ('view')"), "forbidden_permission")
    await act(db, "admin", yes)
    await db.execute("INSERT INTO backup_access_log (action) VALUES ('view')")
    assert await db.fetchval("SELECT user_id FROM backup_access_log WHERE action = 'view'") == yes
    for action in ("create", "download"):
        await raises(db.execute("INSERT INTO backup_access_log (action) VALUES ($1)", action), "forbidden_role")
    await raises(db.execute("DELETE FROM backup_access_log"), "append_only")


async def test_creating_needs_backups_run_one_at_a_time_and_is_logged(db):
    await build(db)
    view_only = await supervisor(db, ["backups_view"])
    runner = await supervisor(db, ["backups_run"], "+218910000082")
    await act(db, "admin", view_only)
    await raises(db.execute("INSERT INTO backup_requests (requested_by) VALUES ($1)", view_only), "forbidden_permission")
    await act(db, "admin", runner)
    rid = await db.fetchval("INSERT INTO backup_requests (requested_by) VALUES ($1) RETURNING id", runner)
    await raises(db.execute("INSERT INTO backup_requests (requested_by) VALUES ($1)", runner), "backup_in_progress")
    assert await db.fetchval("SELECT user_id FROM backup_access_log WHERE action = 'create'") == runner
    await raises(db.execute("UPDATE backup_requests SET run_id = NULL WHERE id = $1", rid), "append_only")
    # العامل يربطه بتشغيله مرة واحدة، فيُقبل طلب جديد بعد انتهائه
    await act(db, "system")
    run = await db.fetchval("INSERT INTO backup_runs (kind, plan, location) VALUES ('manual', 'daily30', 'local') RETURNING id")
    await db.execute("UPDATE backup_requests SET run_id = $2 WHERE id = $1", rid, run)
    await raises(db.execute("UPDATE backup_requests SET run_id = $2 WHERE id = $1", rid, run), "append_only")
    await act(db, "admin", runner)
    await raises(db.execute("INSERT INTO backup_requests (requested_by) VALUES ($1)", runner), "backup_in_progress")  # ما زال يعمل
    await act(db, "system")
    await db.execute("UPDATE backup_runs SET status = 'failed', finished_at = now(), error = 'x' WHERE id = $1", run)
    await act(db, "admin", runner)
    await db.execute("INSERT INTO backup_requests (requested_by) VALUES ($1)", runner)


async def test_download_and_settings_stay_the_owners_alone_and_download_is_logged(db):
    w = await build(db)
    both = await supervisor(db, ["backups_view", "backups_run", "settings", "money", "users"])
    await act(db, "system")
    rid = await db.fetchval(
        "INSERT INTO backup_runs (kind, plan, location, status, finished_at, file_name, byte_size, sha256, local_ok) VALUES "
        "('daily', 'daily30', 'local', 'ok', now(), 'madad-20260927-030000.mdbk', 1, repeat('a', 64), true) RETURNING id")
    await act(db, "admin", both)
    await raises(db.execute("INSERT INTO backup_downloads (run_id) VALUES ($1)", rid), "forbidden_owner_only")
    await raises(db.execute("INSERT INTO backup_policies (plan, location) VALUES ('daily30', 'local')"), "forbidden_owner_only")
    await act(db, "admin", w.owner)
    await db.execute("INSERT INTO backup_downloads (run_id) VALUES ($1)", rid)
    row = await db.fetchrow("SELECT user_id, run_id FROM backup_access_log WHERE action = 'download'")
    assert (row["user_id"], row["run_id"]) == (w.owner, rid)
