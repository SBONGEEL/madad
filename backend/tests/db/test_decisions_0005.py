"""قرارات المالك، الدفعة الثالثة (2026-09-26، الترحيلة 0005) — كل قيمة في الاتجاهين.

م-25 حسم تعارض الرسم · م-26 علامة تجاوز الربح · م-6 أساس التكلفة · أمانة السائق بعد الإلغاء.
"""
from __future__ import annotations

import json
from decimal import Decimal

import asyncpg
import pytest

from tests.db.world import act, balance, build, collect_all, confirm_and_assign, deliver_in_one, draft, place

SQUARE = json.dumps([[32.8, 13.1], [32.8, 13.3], [33.0, 13.3], [33.0, 13.1]])


async def raises(coro, needle: str):
    with pytest.raises(asyncpg.PostgresError) as e:
        await coro
    assert needle in str(e.value), f"توقعت «{needle}» فجاء: {e.value}"


async def setting(db, w, **kv):
    await act(db, "admin", w.owner)
    for k, v in kv.items():
        await db.execute(f"UPDATE city_settings SET {k} = $1 WHERE city = 'TIP'", v)


# ——— م-25 ————————————————————————————————————————————————————————————————
async def _conflict(db, w):
    await setting(db, w, fee_mode="by_zone")
    z = await db.fetchval("INSERT INTO delivery_zones (city, name_ar, fee) VALUES ('TIP', 'الأندلس', 10) RETURNING id")
    await db.execute("UPDATE customer_locations SET zone_id = $1", z)
    await db.execute("INSERT INTO delivery_areas (city, name_ar, fee, polygon) VALUES ('TIP', 'غرب', 15, $1)", SQUARE)


@pytest.mark.parametrize("rule,fee", [("area_wins", "15"), ("zone_wins", "10"), ("higher", "15"), ("lower", "10")])
async def test_m25_each_rule_decides_the_fee(db, rule, fee):
    w = await build(db)
    await _conflict(db, w)
    await setting(db, w, fee_conflict_rule=rule)
    oid = await draft(db, w)
    await place(db, w, oid)
    assert await db.fetchval("SELECT delivery_fee FROM orders WHERE id = $1", oid) == Decimal(fee)
    assert await db.fetchval("SELECT fee_conflict_rule::text FROM orders WHERE id = $1", oid) == rule


async def test_m25_starts_at_drawn_zone_and_is_audited(db):
    w = await build(db)
    assert await db.fetchval("SELECT fee_conflict_rule::text FROM city_settings") == "area_wins"
    await setting(db, w, fee_conflict_rule="lower")
    row = await db.fetchrow("SELECT actor_id, after->>'fee_conflict_rule' AS v FROM audit_log "
                            "WHERE table_name = 'city_settings' ORDER BY id DESC LIMIT 1")
    assert tuple(row) == (w.owner, "lower")


async def test_m25_setting_does_not_reach_an_existing_order(db):
    w = await build(db)
    await _conflict(db, w)
    oid = await draft(db, w)
    await place(db, w, oid)                                  # لقطة: area_wins → 15
    await setting(db, w, fee_conflict_rule="zone_wins")
    await act(db, "customer", w.cust_user)
    await db.execute("UPDATE order_items SET qty = 3 WHERE order_id = $1", oid)   # يعيد حساب الرسم
    assert await db.fetchval("SELECT delivery_fee FROM orders WHERE id = $1", oid) == Decimal("15")


async def test_m25_rule_snapshot_is_derived(db):
    w = await build(db)
    oid = await draft(db, w)
    await act(db, "customer", w.cust_user)
    await raises(db.execute("UPDATE orders SET fee_conflict_rule = 'lower' WHERE id = $1", oid),
                 "derived_field_write: orders.fee_conflict_rule")


# ——— م-26 ————————————————————————————————————————————————————————————————
INS = ("INSERT INTO owner_withdrawals (city, amount, occurred_on, note, created_by) "
       "VALUES ('TIP', $1, '2026-09-26', 'سحب', $2) RETURNING exceeds_profit, profit_at_time")


async def test_m26_over_profit_is_flagged_not_blocked(db):
    w = await build(db)
    await act(db, "admin", w.owner)
    await db.execute("INSERT INTO owner_capital_entries (city, kind, amount, occurred_on, note, created_by) "
                     "VALUES ('TIP', 'opening_cash', 1000, '2026-09-26', 'افتتاح', $1)", w.owner)
    row = await db.fetchrow(INS, Decimal("100"), w.owner)        # لا ربح بعد: يمرّ مُعلَّماً
    assert (row["exceeds_profit"], row["profit_at_time"]) == (True, Decimal("0"))
    await raises(db.execute(INS, Decimal("5000"), w.owner), "withdrawal_exceeds_treasury")   # الخزينة تمنع


async def test_m26_within_profit_is_not_flagged(db):
    w = await build(db)
    oid = await draft(db, w)
    await place(db, w, oid)
    await confirm_and_assign(db, w, oid)
    await collect_all(db, w, oid)
    await deliver_in_one(db, w, oid)
    await act(db, "admin", w.owner)
    await db.execute("INSERT INTO cash_handovers (driver_id, amount, received_by) VALUES ($1, 500, $2)",
                     w.driver, w.owner)
    avail = await db.fetchval("SELECT profit_available('TIP')")
    assert avail > 0
    row = await db.fetchrow(INS, Decimal("100"), w.owner)
    assert row["exceeds_profit"] is False
    # السحب التالي يُحسب بعد خصم الأول
    assert await db.fetchval("SELECT profit_available('TIP')") == avail - 100


async def test_m26_flag_is_derived(db):
    w = await build(db)
    await act(db, "admin", w.owner)
    await db.execute("INSERT INTO owner_capital_entries (city, kind, amount, occurred_on, note, created_by) "
                     "VALUES ('TIP', 'opening_cash', 1000, '2026-09-26', 'افتتاح', $1)", w.owner)
    await raises(db.execute("INSERT INTO owner_withdrawals (city, amount, occurred_on, note, created_by, exceeds_profit) "
                            "VALUES ('TIP', 1, '2026-09-26', 'x', $1, true)", w.owner),
                 "derived_field_write: owner_withdrawals.exceeds_profit")


# ——— م-6 أساس التكلفة ——————————————————————————————————————————————————————
async def _two_sources(db, w):
    """المصدر الأول 777.77، والثاني 900، والبيع يدوي 850."""
    await act(db, "supplier", w.sup_user)
    loc2 = await db.fetchval("INSERT INTO supplier_pickup_locations (supplier_id, city, label, lat, lng, address_text) "
                             "VALUES ($1, 'TIP', 'مخزن 2', 32.86, 13.11, 'الظهرة') RETURNING id", w.supplier)
    off2 = await db.fetchval("INSERT INTO supplier_offers (supplier_id, product_id, unit, unit_size, purchase_price, "
                             "reported_qty, pickup_location_id) VALUES ($1, $2, 'kg', 1, 900, 50, $3) RETURNING id",
                             w.supplier, w.product, loc2)
    await act(db, "admin", w.owner)
    await db.execute("INSERT INTO catalog_item_sources (catalog_item_id, offer_id, priority) VALUES ($1, $2, 2)", w.item, off2)
    await db.execute("UPDATE catalog_item_pricing SET mode = 'manual', margin_value = NULL, manual_price = 850 "
                     "WHERE catalog_item_id = $1", w.item)


async def below(db, w) -> bool:
    return await db.fetchval("SELECT below_cost FROM catalog_items WHERE id = $1", w.item)


async def test_m6_basis_max_source_is_the_default(db):
    w = await build(db)
    assert await db.fetchval("SELECT cost_guard_basis::text FROM city_settings") == "max_source"
    await _two_sources(db, w)
    assert await below(db, w)                                    # 850 < 900


async def test_m6_basis_first_priority(db):
    w = await build(db)
    await _two_sources(db, w)
    await setting(db, w, cost_guard_basis="first_priority")
    assert not await below(db, w)                                # 850 > 777.77
    await setting(db, w, cost_guard_basis="max_source")
    assert await below(db, w)


@pytest.mark.parametrize("project,item,is_below", [("max_source", "first_priority", False),
                                                    ("first_priority", "max_source", True)])
async def test_m6_basis_item_exception(db, project, item, is_below):
    w = await build(db)
    await _two_sources(db, w)
    await setting(db, w, cost_guard_basis=project)
    await db.execute("UPDATE catalog_item_pricing SET cost_basis_override = $2 WHERE catalog_item_id = $1", w.item, item)
    assert await below(db, w) is is_below


# ——— الأمانة بعد الإلغاء ————————————————————————————————————————————————————
async def _cancelled_after_collect(db, w):
    await setting(db, w, cancel_policy="anytime")
    oid = await draft(db, w)
    await place(db, w, oid)
    await confirm_and_assign(db, w, oid)
    await collect_all(db, w, oid)
    await act(db, "customer", w.cust_user)
    await db.execute("UPDATE orders SET status = 'cancelled' WHERE id = $1", oid)
    return oid, await db.fetchval("SELECT id FROM driver_custody WHERE order_id = $1", oid)


async def test_custody_is_recorded_with_the_driver_and_in_the_ledger(db):
    w = await build(db)
    oid, cid = await _cancelled_after_collect(db, w)
    row = await db.fetchrow("SELECT driver_id, qty, status::text, dispute_id FROM driver_custody WHERE id = $1", cid)
    assert (row["driver_id"], row["qty"], row["status"]) == (w.driver, Decimal("2"), "open")
    assert row["dispute_id"] == await db.fetchval("SELECT id FROM disputes WHERE order_id = $1", oid)
    assert await balance(db, "goods_in_custody", w.driver) == Decimal("1555.540")
    assert await balance(db, "supplier_payable", w.supplier) == Decimal("-1555.540")
    assert await balance(db, "cost_of_goods") == Decimal("0")
    # السائق يرى صنفه وكميته، بلا تكلفة ولا مورد
    cols = {r["column_name"] for r in await db.fetch(
        "SELECT column_name FROM information_schema.columns WHERE table_name = 'v_driver_custody'")}
    assert "unit_cost" not in cols and not any("supplier" in c for c in cols)


async def test_custody_blocks_driver_settlement_until_decided(db):
    w = await build(db)
    _, cid = await _cancelled_after_collect(db, w)
    await act(db, "admin", w.owner)
    wh = await db.fetchval("INSERT INTO warehouses (city, name, lat, lng, address_text) "
                           "VALUES ('TIP', 'الظهرة', 32.89, 13.18, 'الظهرة') RETURNING id")
    await raises(db.execute("INSERT INTO cash_handovers (driver_id, amount, received_by) VALUES ($1, 1, $2)",
                            w.driver, w.owner), "custody_open")
    await db.execute("UPDATE driver_custody SET fate = 'to_warehouse', target_warehouse_id = $2 WHERE id = $1", cid, wh)
    # بعد الحسم لا يمنع الأمانةُ التسوية (يمنعها فقط غياب الكاش هنا)
    await raises(db.execute("INSERT INTO cash_handovers (driver_id, amount, received_by) VALUES ($1, 1, $2)",
                            w.driver, w.owner), "handover_exceeds_cash")


async def test_custody_to_warehouse_at_its_cost(db):
    w = await build(db)
    _, cid = await _cancelled_after_collect(db, w)
    await act(db, "admin", w.owner)
    wh = await db.fetchval("INSERT INTO warehouses (city, name, lat, lng, address_text) "
                           "VALUES ('TIP', 'الظهرة', 32.89, 13.18, 'الظهرة') RETURNING id")
    await db.execute("UPDATE driver_custody SET fate = 'to_warehouse', target_warehouse_id = $2 WHERE id = $1", cid, wh)
    st = await db.fetchrow("SELECT on_hand, round(avg_cost, 3) AS c FROM warehouse_stock WHERE warehouse_id = $1", wh)
    assert (st["on_hand"], st["c"]) == (Decimal("2"), Decimal("777.770"))
    assert await balance(db, "goods_in_custody", w.driver) == Decimal("0")
    assert await balance(db, "warehouse_inventory", wh) == Decimal("1555.540")
    assert await db.fetchval("SELECT status::text FROM driver_custody WHERE id = $1", cid) == "resolved"


async def test_custody_return_to_supplier_reverses_the_payable(db):
    w = await build(db)
    _, cid = await _cancelled_after_collect(db, w)
    await act(db, "admin", w.owner)
    await db.execute("UPDATE driver_custody SET fate = 'return_supplier' WHERE id = $1", cid)
    assert await balance(db, "supplier_payable", w.supplier) == Decimal("0")
    assert await balance(db, "goods_in_custody", w.driver) == Decimal("0")


async def test_custody_to_another_order_then_delivered(db):
    w = await build(db)
    _, cid = await _cancelled_after_collect(db, w)
    target = await draft(db, w)
    await place(db, w, target)
    await act(db, "admin", w.owner)
    await db.execute("UPDATE orders SET status = 'confirmed' WHERE id = $1", target)
    await db.execute("UPDATE driver_custody SET fate = 'to_order', target_order_id = $2 WHERE id = $1", cid, target)
    srcs = [r["source"] for r in await db.fetch(
        "SELECT source::text FROM pickup_stops WHERE order_id = $1 AND status = 'pending'", target)]
    assert srcs == ["custody"]
    assert await db.fetchval("SELECT plan_complete FROM orders WHERE id = $1", target)
    await db.execute("UPDATE orders SET route_km = 5 WHERE id = $1", target)
    await db.execute("UPDATE orders SET status = 'assigned', driver_id = $2 WHERE id = $1", target, w.driver)
    await collect_all(db, w, target)
    await deliver_in_one(db, w, target)
    assert await db.fetchval("SELECT status::text FROM driver_custody WHERE id = $1", cid) == "resolved"
    assert await balance(db, "goods_in_custody", w.driver) == Decimal("0")


async def test_custody_decision_rules(db):
    w = await build(db)
    _, cid = await _cancelled_after_collect(db, w)
    other = await draft(db, w)                                   # مسودة: لا تقبل الأمانة
    await act(db, "customer", w.cust_user)
    await raises(db.execute("UPDATE driver_custody SET fate = 'return_supplier' WHERE id = $1", cid), "forbidden_role")
    await act(db, "admin", w.owner)
    await raises(db.execute("UPDATE driver_custody SET fate = 'to_order', target_order_id = $2 WHERE id = $1", cid, other),
                 "custody_target_not_plannable")
    await db.execute("UPDATE driver_custody SET fate = 'return_supplier' WHERE id = $1", cid)
    await raises(db.execute("UPDATE driver_custody SET fate = 'to_order', target_order_id = $2 WHERE id = $1", cid, other),
                 "custody_already_decided")
    await raises(db.execute("DELETE FROM driver_custody WHERE id = $1", cid), "append_only_delete")
