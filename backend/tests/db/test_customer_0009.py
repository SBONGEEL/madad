"""الترحيلة 0009 — تطبيق العميل: كل قاعدة في الاتجاهين.

- م-9 في القراءة: المسؤول يرى طلبيات فرعه وفروعه وحدها، والصاحب يرى الكل.
- طرف جديد يبدأ «بانتظار الاعتماد»، ووسائطه له لا لغيره.
- النزاع يفتحه عضو منشأة الطلبية أو سائقها، مفتوحاً بلا قرار، ونزاع مفتوح واحد لكل صنف.
- الإشعار يعلّمه صاحبه مقروءاً وحده، ولا يُعدَّل غير read_at.
- معاينة رسم التوصيل بإعدادات اليوم، وإشعارات الأحداث الدنيا مرة واحدة لكل حدث (§7).
"""
from __future__ import annotations

from decimal import Decimal

from tests.db.test_settings_0004 import new_branch, purchaser, raises, setting
from tests.db.world import act, build, collect_all, confirm_and_assign, deliver_in_one, draft, place


async def _orders_on_two_branches(db):
    w = await build(db)
    main = await db.fetchval("SELECT id FROM customer_locations WHERE customer_id = $1", w.customer)
    other = await new_branch(db, w)
    p = await purchaser(db, w, branch=main)
    await act(db, "customer", w.cust_user)
    theirs = await db.fetchval("INSERT INTO orders (customer_id, branch_id) VALUES ($1, $2) RETURNING id", w.customer, other)
    mine = await db.fetchval("INSERT INTO orders (customer_id, branch_id) VALUES ($1, $2) RETURNING id", w.customer, main)
    return w, p, mine, theirs


# ——— م-9 في القراءة ————————————————————————————————————————————————————————————
async def test_purchaser_reads_own_branch_orders_only(db):
    w, p, mine, theirs = await _orders_on_two_branches(db)
    await act(db, "customer", p)
    assert [r["id"] for r in await db.fetch("SELECT id FROM v_customer_orders")] == [mine]
    assert await db.fetchval("SELECT customer_order_access($1)", mine) == mine
    await raises(db.fetchval("SELECT customer_order_access($1)", theirs), "forbidden_branch")
    assert await db.fetchval("SELECT count(*) FROM v_customer_branches") == 1


async def test_owner_reads_every_branch(db):
    w, p, mine, theirs = await _orders_on_two_branches(db)
    await act(db, "customer", w.cust_user)
    assert sorted(r["id"] for r in await db.fetch("SELECT id FROM v_customer_orders")) == sorted([mine, theirs])
    assert await db.fetchval("SELECT customer_order_access($1)", theirs) == theirs
    assert await db.fetchval("SELECT count(*) FROM v_customer_branches") == 2


async def test_another_establishment_sees_nothing(db):
    w, p, mine, theirs = await _orders_on_two_branches(db)
    await act(db, "system")
    stranger = await db.fetchval("INSERT INTO app_users (phone, audience, full_name) VALUES ('+218910000077', "
                                 "'customer', 'غريب') RETURNING id")
    await act(db, "customer", stranger)
    assert await db.fetchval("SELECT count(*) FROM v_customer_orders") == 0
    assert await db.fetchval("SELECT customer_order_access($1)", mine) is None


# ——— طرف جديد ووسائطه ————————————————————————————————————————————————————————
async def _new_customer(db, uid: int, media: int, status: str = "pending"):
    return db.fetchval("INSERT INTO customers (city, name, kind, contact_name, phone, facade_media_id, status) "
                       "VALUES ('TIP', 'مقهى', 'cafe', 'سالم', '+218910000078', $1, $2) RETURNING id", media, status)


async def _user(db, phone: str) -> int:
    await act(db, "system")
    return await db.fetchval("INSERT INTO app_users (phone, audience, full_name) VALUES ($1, 'customer', 'س') "
                             "RETURNING id", phone)


async def _media(db, uid: int) -> int:
    await act(db, "customer", uid)
    return await db.fetchval("INSERT INTO media_files (storage_key, mime_type, byte_size, sha256, is_private) "
                             "VALUES ('m/' || $1, 'image/jpeg', 10, repeat('b', 64), true) RETURNING id", str(uid))


async def test_new_customer_starts_pending_with_own_media(db):
    await build(db)
    uid = await _user(db, "+218910000078")
    media = await _media(db, uid)
    assert await db.fetchval("SELECT uploaded_by FROM media_files WHERE id = $1", media) == uid
    assert await (await _new_customer(db, uid, media))


async def test_new_customer_cannot_self_approve(db):
    await build(db)
    uid = await _user(db, "+218910000078")
    media = await _media(db, uid)
    await raises(await _new_customer(db, uid, media, "approved"), "a new party starts pending")


async def test_new_customer_cannot_use_someone_elses_media(db):
    await build(db)
    a = await _user(db, "+218910000078")
    b = await _user(db, "+218910000079")
    theirs = await _media(db, b)
    await act(db, "customer", a)
    await raises(await _new_customer(db, a, theirs), "media_not_owned")


async def test_media_uploader_is_the_actor_not_the_caller(db):
    await build(db)
    a = await _user(db, "+218910000078")
    b = await _user(db, "+218910000079")
    await act(db, "customer", a)
    mid = await db.fetchval("INSERT INTO media_files (storage_key, mime_type, byte_size, sha256, is_private, uploaded_by) "
                            "VALUES ('m/x', 'image/png', 10, repeat('c', 64), false, $1) RETURNING id", b)
    assert await db.fetchval("SELECT uploaded_by FROM media_files WHERE id = $1", mid) == a


# ——— النزاع ————————————————————————————————————————————————————————————————————
async def _delivered(db):
    w = await build(db)
    oid = await draft(db, w)
    await place(db, w, oid)
    await confirm_and_assign(db, w, oid)
    await collect_all(db, w, oid)
    await deliver_in_one(db, w, oid)
    item = await db.fetchval("SELECT id FROM order_items WHERE order_id = $1", oid)
    return w, oid, item


def _dispute(db, oid, item, by=0):
    return db.fetchval("INSERT INTO disputes (order_id, order_item_id, opened_by_role, opened_by, kind, description) "
                       "VALUES ($1, $2, 'customer', $3, 'damaged', 'تالف') RETURNING id", oid, item, by)


async def test_member_opens_dispute_as_themselves(db):
    w, oid, item = await _delivered(db)
    await act(db, "customer", w.cust_user)
    did = await _dispute(db, oid, item, by=w.owner)            # يُكتب الفاتح من الجلسة لا من الطلب
    row = await db.fetchrow("SELECT opened_by, opened_by_role::text AS r, status::text AS s FROM disputes WHERE id = $1", did)
    assert (row["opened_by"], row["r"], row["s"]) == (w.cust_user, "customer", "open")


async def test_stranger_cannot_open_dispute_on_the_order(db):
    w, oid, item = await _delivered(db)
    stranger = await _user(db, "+218910000078")
    await act(db, "customer", stranger)
    await raises(_dispute(db, oid, item), "forbidden_not_member")


async def test_dispute_item_must_belong_to_the_order(db):
    w, oid, item = await _delivered(db)
    other = await draft(db, w)
    other_item = await db.fetchval("SELECT id FROM order_items WHERE order_id = $1", other)
    await act(db, "customer", w.cust_user)
    await raises(_dispute(db, oid, other_item), "line_not_found")


async def test_dispute_cannot_start_decided(db):
    w, oid, item = await _delivered(db)
    await act(db, "customer", w.cust_user)
    await raises(db.execute("INSERT INTO disputes (order_id, order_item_id, opened_by_role, opened_by, kind, description, "
                            "refund_method) VALUES ($1, $2, 'customer', $3, 'damaged', 'x', 'cash_via_driver')",
                            oid, item, w.cust_user), "a dispute starts open")


async def test_one_open_dispute_per_item(db):
    w, oid, item = await _delivered(db)
    await act(db, "customer", w.cust_user)
    await _dispute(db, oid, item)
    await raises(_dispute(db, oid, item), "dispute_open_per_item")


async def test_only_the_assigned_driver_opens_a_driver_dispute(db):
    w, oid, item = await _delivered(db)
    await act(db, "driver", w.drv_user)
    assert await db.fetchval("INSERT INTO disputes (order_id, opened_by_role, opened_by, kind, description) "
                             "VALUES ($1, 'driver', 0, 'refused', 'رفض') RETURNING opened_by", oid) == w.drv_user
    await act(db, "system")
    other = await db.fetchval("INSERT INTO app_users (phone, audience, full_name) VALUES ('+218910000078', 'driver', 'س') "
                              "RETURNING id")
    await act(db, "driver", other)
    await raises(db.execute("INSERT INTO disputes (order_id, opened_by_role, opened_by, kind, description) "
                            "VALUES ($1, 'driver', 0, 'refused', 'رفض')", oid), "forbidden_not_assigned")


# ——— الإشعار ————————————————————————————————————————————————————————————————————
async def _note(db, uid: int) -> int:
    await act(db, "system")
    return await db.fetchval("INSERT INTO notifications (user_id, kind, title, body) VALUES ($1, 'broadcast', 't', 'b') "
                             "RETURNING id", uid)


async def test_owner_of_notification_marks_it_read(db):
    w = await build(db)
    nid = await _note(db, w.cust_user)
    await act(db, "customer", w.cust_user)
    await db.execute("UPDATE notifications SET read_at = now() WHERE id = $1", nid)
    assert await db.fetchval("SELECT read_at IS NOT NULL FROM notifications WHERE id = $1", nid)


async def test_notification_is_not_someone_elses_to_touch(db):
    w = await build(db)
    nid = await _note(db, w.cust_user)
    await act(db, "driver", w.drv_user)
    await raises(db.execute("UPDATE notifications SET read_at = now() WHERE id = $1", nid), "not your notification")
    await act(db, "customer", w.cust_user)
    await raises(db.execute("UPDATE notifications SET title = 'x' WHERE id = $1", nid), "change read_at only")


# ——— معاينة رسم التوصيل ————————————————————————————————————————————————————————————
async def test_fee_preview_flat_and_free_threshold(db):
    w = await build(db)                                          # flat 10
    branch = await db.fetchval("SELECT id FROM customer_locations WHERE customer_id = $1", w.customer)
    assert await db.fetchval("SELECT fee_preview($1, 50)", branch) == Decimal("10")
    await setting(db, w, free_delivery_threshold=Decimal("40"))
    assert await db.fetchval("SELECT fee_preview($1, 50)", branch) == Decimal("0")
    assert await db.fetchval("SELECT fee_preview($1, 30)", branch) == Decimal("10")


async def test_fee_preview_by_zone_and_missing_zone(db):
    w = await build(db)
    branch = await db.fetchval("SELECT id FROM customer_locations WHERE customer_id = $1", w.customer)
    await setting(db, w, fee_mode="by_zone")
    await raises(db.fetchval("SELECT fee_preview($1, 50)", branch), "zone_missing")
    zone = await db.fetchval("INSERT INTO delivery_zones (city, name_ar, fee) VALUES ('TIP', 'وسط', 12) RETURNING id")
    await act(db, "system")
    await db.execute("UPDATE customer_locations SET zone_id = $1 WHERE id = $2", zone, branch)
    assert await db.fetchval("SELECT fee_preview($1, 50)", branch) == Decimal("12")


# ——— §7 أحداث العميل ——————————————————————————————————————————————————————————————
async def test_order_events_notify_branch_members_once(db):
    w = await build(db)
    p = await purchaser(db, w)
    oid = await draft(db, w)
    await place(db, w, oid)
    await confirm_and_assign(db, w, oid)
    await collect_all(db, w, oid)
    await deliver_in_one(db, w, oid)
    await act(db, "system")
    assert await db.fetchval("SELECT emit_customer_order_events()") == 3
    assert await db.fetchval("SELECT emit_customer_order_events()") == 0          # لا تكرار
    rows = await db.fetch("SELECT user_id, kind FROM notifications WHERE kind IN ('order_confirmed', 'order_assigned', "
                          "'order_arrived') ORDER BY id")
    assert {(r["user_id"], r["kind"]) for r in rows} == {(u, k) for u in (w.cust_user, p)
                                                           for k in ("order_confirmed", "order_assigned", "order_arrived")}


async def test_other_branch_purchaser_is_not_notified(db):
    w = await build(db)
    oid = await draft(db, w)                                   # على الفرع الرئيسي قبل فتح فرع ثانٍ
    other = await new_branch(db, w)
    p = await purchaser(db, w, branch=other)
    await place(db, w, oid)
    await confirm_and_assign(db, w, oid)
    await act(db, "system")
    await db.fetchval("SELECT emit_customer_order_events()")
    assert await db.fetchval("SELECT count(*) FROM notifications WHERE user_id = $1", p) == 0
    assert await db.fetchval("SELECT count(*) FROM notifications WHERE user_id = $1", w.cust_user) == 2
