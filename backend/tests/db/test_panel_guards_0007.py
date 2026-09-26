"""ت-40 وت-41 (الترحيلة 0007): إدارة مستخدمي اللوحة وصلاحياتهم، وتوزيع الإشعار الجماعي — في الاتجاهين."""
from __future__ import annotations

import asyncpg
import pytest

from tests.db.world import act, build


async def raises(coro, needle: str):
    with pytest.raises(asyncpg.PostgresError) as e:
        await coro
    assert needle in str(e.value), f"توقعت «{needle}» فجاء: {e.value}"


async def _supervisor(db, w, phone, perms):
    await act(db, "admin", w.owner)
    uid = await db.fetchval("INSERT INTO app_users (phone, audience, full_name) VALUES ($1, 'admin', 'مشرف') RETURNING id", phone)
    await db.execute("INSERT INTO admin_members (user_id, role) VALUES ($1, 'supervisor')", uid)
    for p in perms:
        await db.execute("INSERT INTO admin_permissions (user_id, permission) VALUES ($1, $2::admin_permission)", uid, p)
    return uid


async def test_owner_manages_the_panel_users(db):
    w = await build(db)
    uid = await _supervisor(db, w, "+218910000051", ["users", "orders"])
    assert await db.fetchval("SELECT count(*) FROM admin_permissions WHERE user_id = $1", uid) == 2


async def test_supervisor_grants_only_what_it_holds_and_never_to_itself(db):
    w = await build(db)
    boss = await _supervisor(db, w, "+218910000051", ["users", "orders"])
    other = await _supervisor(db, w, "+218910000052", [])
    await act(db, "admin", boss)
    await db.execute("INSERT INTO admin_permissions (user_id, permission) VALUES ($1, 'orders')", other)
    await raises(db.execute("INSERT INTO admin_permissions (user_id, permission) VALUES ($1, 'costs_view')", other),
                 "forbidden_grant: costs_view")
    await raises(db.execute("INSERT INTO admin_permissions (user_id, permission) VALUES ($1, 'money')", boss),
                 "forbidden_self_edit")
    await raises(db.execute("DELETE FROM admin_members WHERE user_id = $1", w.owner), "forbidden_owner_only")
    await raises(db.execute("UPDATE admin_members SET role = 'owner' WHERE user_id = $1", other), "forbidden_owner_only")


async def test_without_users_permission_nothing_changes(db):
    w = await build(db)
    plain = await _supervisor(db, w, "+218910000053", ["orders"])
    other = await _supervisor(db, w, "+218910000054", [])
    await act(db, "admin", plain)
    await raises(db.execute("INSERT INTO admin_permissions (user_id, permission) VALUES ($1, 'orders')", other),
                 "forbidden_permission: users")


@pytest.mark.parametrize("audience,who", [("customer", "cust_user"), ("driver", "drv_user")])
async def test_broadcast_reaches_its_audience_only(db, audience, who):
    w = await build(db)
    await act(db, "admin", w.owner)
    await db.execute("INSERT INTO broadcasts (city, audience, title, body, created_by) VALUES ('TIP', $1, 'عطلة', 'نغلق الجمعة', $2)",
                     audience, w.owner)
    got = [r["user_id"] for r in await db.fetch("SELECT user_id FROM notifications WHERE kind = 'broadcast'")]
    assert got == [getattr(w, who)]


async def test_broadcast_needs_the_notifications_permission(db):
    w = await build(db)
    plain = await _supervisor(db, w, "+218910000057", ["orders"])
    await act(db, "admin", plain)
    await raises(db.execute("INSERT INTO broadcasts (city, audience, title, body, created_by) VALUES ('TIP', 'customer', 'x', 'y', $1)",
                            plain), "forbidden_permission: notifications")
