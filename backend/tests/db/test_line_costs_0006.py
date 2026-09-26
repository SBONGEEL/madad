"""ت-39 (الترحيلة 0006): سطر يضيفه المالك يدوياً في مخطط الاستلام يأخذ تكلفته، فيُدان مورده عند التسليم."""
from __future__ import annotations

from decimal import Decimal

from tests.db.world import act, balance, build, collect_all, deliver_in_one, draft, place


async def _confirmed(db):
    w = await build(db)
    oid = await draft(db, w)
    await place(db, w, oid)
    await act(db, "admin", w.owner)
    await db.execute("UPDATE orders SET status = 'confirmed' WHERE id = $1", oid)
    return w, oid


async def test_manual_line_gets_its_cost_and_the_supplier_is_owed(db):
    w, oid = await _confirmed(db)
    line = await db.fetchrow("SELECT l.id, l.stop_id, l.order_item_id FROM pickup_stop_lines l "
                             "JOIN pickup_stops s ON s.id = l.stop_id WHERE s.order_id = $1", oid)
    # المالك يعيد بناء السطر يدوياً
    await db.execute("DELETE FROM pickup_stop_lines WHERE id = $1", line["id"])
    new = await db.fetchval("INSERT INTO pickup_stop_lines (stop_id, order_item_id, offer_id, planned_qty) "
                            "VALUES ($1, $2, $3, 2) RETURNING id", line["stop_id"], line["order_item_id"], w.offer)
    assert await db.fetchval("SELECT unit_cost FROM pickup_line_costs WHERE stop_line_id = $1", new) == Decimal("777.77")
    await db.execute("UPDATE orders SET route_km = 5 WHERE id = $1", oid)
    await db.execute("UPDATE orders SET status = 'assigned', driver_id = $2 WHERE id = $1", oid, w.driver)
    await collect_all(db, w, oid)
    await deliver_in_one(db, w, oid)
    assert await balance(db, "supplier_payable", w.supplier) == Decimal("-1555.540")


async def test_planned_lines_keep_the_cost_the_plan_wrote(db):
    w, oid = await _confirmed(db)
    n = await db.fetchval("SELECT count(*) FROM pickup_line_costs c JOIN pickup_stop_lines l ON l.id = c.stop_line_id "
                          "JOIN pickup_stops s ON s.id = l.stop_id WHERE s.order_id = $1", oid)
    assert n == 1                                           # لا تكرار ولا تعارض مع ما كتبه المخطط
