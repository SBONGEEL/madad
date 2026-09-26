"""قرارات المالك، الدفعة الرابعة (2026-09-26، الترحيلة 0008) — كل قيمة في الاتجاهين.

م-27 تداخل منطقتين مرسومتين · م-28 تكلفة أصناف مخزن مَدَد.
"""
from __future__ import annotations

import json
from decimal import Decimal

import asyncpg
import pytest

from tests.db.world import act, build, draft, place

WEST = json.dumps([[32.8, 13.1], [32.8, 13.3], [33.0, 13.3], [33.0, 13.1]])      # يحوي الفرع (32.887, 13.191)
MID = json.dumps([[32.85, 13.15], [32.85, 13.25], [32.95, 13.25], [32.95, 13.15]])  # داخل الأولى جزئياً ويحوي الفرع
FAR = json.dumps([[31.0, 12.0], [31.0, 12.1], [31.1, 12.1]])


async def raises(coro, needle: str):
    with pytest.raises(asyncpg.PostgresError) as e:
        await coro
    assert needle in str(e.value), f"توقعت «{needle}» فجاء: {e.value}"


async def setting(db, w, **kv):
    await act(db, "admin", w.owner)
    for k, v in kv.items():
        await db.execute(f"UPDATE city_settings SET {k} = $1 WHERE city = 'TIP'", v)


async def _two_areas(db, w):
    await setting(db, w, fee_mode="by_zone")
    await db.execute("INSERT INTO delivery_areas (city, name_ar, fee, polygon) VALUES ('TIP', 'غرب', 10, $1)", WEST)
    await db.execute("INSERT INTO delivery_areas (city, name_ar, fee, polygon) VALUES ('TIP', 'وسط', 15, $1)", MID)


# ——— م-27 ————————————————————————————————————————————————————————————————
async def test_m27_default_stops_the_order(db):
    w = await build(db)
    assert await db.fetchval("SELECT area_overlap_rule::text FROM city_settings") == "stop"
    await _two_areas(db, w)
    oid = await draft(db, w)
    await raises(place(db, w, oid), "area_overlap")


@pytest.mark.parametrize("rule,fee", [("higher", "15"), ("lower", "10")])
async def test_m27_higher_or_lower(db, rule, fee):
    w = await build(db)
    await _two_areas(db, w)
    await setting(db, w, area_overlap_rule=rule)
    oid = await draft(db, w)
    await place(db, w, oid)
    assert await db.fetchval("SELECT delivery_fee FROM orders WHERE id = $1", oid) == Decimal(fee)
    assert await db.fetchval("SELECT area_overlap_rule::text FROM orders WHERE id = $1", oid) == rule


async def test_m27_setting_is_audited_and_snapshot_is_derived(db):
    w = await build(db)
    await setting(db, w, area_overlap_rule="lower")
    row = await db.fetchrow("SELECT actor_id, after->>'area_overlap_rule' AS v FROM audit_log "
                            "WHERE table_name = 'city_settings' ORDER BY id DESC LIMIT 1")
    assert tuple(row) == (w.owner, "lower")
    oid = await draft(db, w)
    await act(db, "customer", w.cust_user)
    await raises(db.execute("UPDATE orders SET area_overlap_rule = 'higher' WHERE id = $1", oid),
                 "derived_field_write: orders.area_overlap_rule")


async def test_m27_owner_is_alerted_with_areas_and_branches(db):
    w = await build(db)
    await _two_areas(db, w)
    n = await db.fetch("SELECT user_id, payload FROM notifications WHERE kind = 'area_overlap'")
    assert [r["user_id"] for r in n] == [w.owner]
    assert len(json.loads(n[0]["payload"])["branches"]) == 1
    ov = await db.fetch("SELECT name_a, name_b, branches FROM v_area_overlaps")
    assert [(r["name_a"], r["name_b"]) for r in ov] == [("غرب", "وسط")]


async def test_m27_no_alert_without_new_overlap(db):
    w = await build(db)
    await setting(db, w, fee_mode="by_zone")
    await db.execute("INSERT INTO delivery_areas (city, name_ar, fee, polygon) VALUES ('TIP', 'غرب', 10, $1)", WEST)
    await db.execute("INSERT INTO delivery_areas (city, name_ar, fee, polygon) VALUES ('TIP', 'بعيد', 15, $1)", FAR)
    assert await db.fetchval("SELECT count(*) FROM notifications WHERE kind = 'area_overlap'") == 0
    await db.execute("INSERT INTO delivery_areas (city, name_ar, fee, polygon) VALUES ('TIP', 'وسط', 15, $1)", MID)
    assert await db.fetchval("SELECT count(*) FROM notifications WHERE kind = 'area_overlap'") == 1
    await db.execute("UPDATE delivery_areas SET name_ar = 'وسط المدينة' WHERE name_ar = 'وسط'")   # تداخل قائم
    assert await db.fetchval("SELECT count(*) FROM notifications WHERE kind = 'area_overlap'") == 1


# ——— م-28 ————————————————————————————————————————————————————————————————
async def _warehouse_only(db, w, price: str):
    """صنف يُباع بسعر يدوي من مخزن مَدَد وحده."""
    await act(db, "admin", w.owner)
    await db.execute("UPDATE catalog_item_pricing SET mode = 'manual', margin_value = NULL, manual_price = $2 "
                     "WHERE catalog_item_id = $1", w.item, Decimal(price))
    await db.execute("DELETE FROM catalog_item_sources WHERE catalog_item_id = $1", w.item)
    wh = await db.fetchval("INSERT INTO warehouses (city, name, lat, lng, address_text) "
                           "VALUES ('TIP', 'الظهرة', 32.89, 13.18, 'الظهرة') RETURNING id")
    for cost in ("850", "950"):
        await db.execute("INSERT INTO stock_movements (warehouse_id, catalog_item_id, kind, qty_delta, unit_cost) "
                         "VALUES ($1, $2, 'intake', 5, $3)", wh, w.item, Decimal(cost))
    return wh


async def flags(db, w):
    r = await db.fetchrow("SELECT below_cost, cost_missing FROM catalog_items WHERE id = $1", w.item)
    return r["below_cost"], r["cost_missing"]


async def test_m28_auto_average_is_the_default(db):
    w = await build(db)
    await _warehouse_only(db, w, "880")                 # المتوسط 900
    assert await db.fetchval("SELECT warehouse_cost_mode::text FROM catalog_item_pricing WHERE catalog_item_id = $1", w.item) == "auto"
    assert await flags(db, w) == (True, False)
    assert await db.fetchval("SELECT count(*) FROM v_customer_catalog WHERE id = $1", w.item) == 0


async def test_m28_auto_follows_the_m12_method(db):
    w = await build(db)
    await _warehouse_only(db, w, "880")
    await db.execute("INSERT INTO cogs_method_periods (city, method) VALUES ('TIP', 'fifo')")   # الأقدم 850
    assert await flags(db, w) == (False, False)
    await db.execute("INSERT INTO cogs_method_periods (city, method) VALUES ('TIP', 'average')")
    assert await flags(db, w) == (True, False)


async def test_m28_manual_cost(db):
    w = await build(db)
    await _warehouse_only(db, w, "880")
    await db.execute("UPDATE catalog_item_pricing SET warehouse_cost_mode = 'manual', warehouse_manual_cost = 800 "
                     "WHERE catalog_item_id = $1", w.item)
    assert await flags(db, w) == (False, False)
    await db.execute("UPDATE catalog_item_pricing SET warehouse_manual_cost = 890 WHERE catalog_item_id = $1", w.item)
    assert await flags(db, w) == (True, False)


async def test_m28_manual_without_cost_is_not_for_sale(db):
    w = await build(db)
    await _warehouse_only(db, w, "2000")
    oid = await draft(db, w)                             # سلة قبل الإيقاف
    await act(db, "admin", w.owner)
    await db.execute("UPDATE catalog_item_pricing SET warehouse_cost_mode = 'manual' WHERE catalog_item_id = $1", w.item)
    assert await flags(db, w) == (False, True)
    assert await db.fetchval("SELECT count(*) FROM v_customer_catalog WHERE id = $1", w.item) == 0
    assert await db.fetchval("SELECT count(*) FROM notifications WHERE kind = 'cost_missing'") == 1
    await raises(place(db, w, oid), "item_cost_missing")
    await act(db, "admin", w.owner)
    await db.execute("UPDATE catalog_item_pricing SET warehouse_manual_cost = 900 WHERE catalog_item_id = $1", w.item)
    assert await flags(db, w) == (False, False)
    await place(db, w, oid)


async def test_m28_supplier_and_warehouse_take_the_higher(db):
    w = await build(db)                                  # المورد 777.77
    await act(db, "admin", w.owner)
    await db.execute("UPDATE catalog_item_pricing SET mode = 'manual', margin_value = NULL, manual_price = 900 "
                     "WHERE catalog_item_id = $1", w.item)
    wh = await db.fetchval("INSERT INTO warehouses (city, name, lat, lng, address_text) "
                           "VALUES ('TIP', 'الظهرة', 32.89, 13.18, 'الظهرة') RETURNING id")
    assert await db.fetchval("SELECT item_cost_ref($1)", w.item) == Decimal("777.77")
    await db.execute("INSERT INTO stock_movements (warehouse_id, catalog_item_id, kind, qty_delta, unit_cost) "
                     "VALUES ($1, $2, 'intake', 5, 950)", wh, w.item)
    assert await db.fetchval("SELECT round(item_cost_ref($1), 3)", w.item) == Decimal("950.000")
    assert await flags(db, w) == (True, False)


async def test_m28_cost_missing_is_derived(db):
    w = await build(db)
    await act(db, "admin", w.owner)
    await raises(db.execute("UPDATE catalog_items SET cost_missing = true WHERE id = $1", w.item),
                 "derived_field_write: catalog_items.cost_missing")
