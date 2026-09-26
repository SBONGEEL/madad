"""العزل على مستوى القاعدة (القاعدة 11.1): عروض الجماهير لا تحمل سعر شراء ولا
هامشاً ولا اسم مورد، وعرض المورد لا يحمل عميلاً ولا سعر بيع ولا وجهة.

كل فحص يُجرَّب أولاً على شاهد إيجابي — مصدرٍ يجب أن يحمل القيمة — فإن لم
يمسكها فالفحص أعمى ونظافة الباقي بلا معنى.

هذا حارس طبقة القاعدة. حرّاس الـAPI (تعداد OpenAPI، استدعاء كل مسار برمز
جمهوره، بايتات PDF) تُكتب قبل أول نقطة API في جزء الخلفية (القسم 14).
"""
from __future__ import annotations

import json
import re

from tests.db.world import (ADDRESS_CANARY, CUSTOMER_CANARY, MARGIN_CANARY, PURCHASE_CANARY, SALE_PRICE,
                            SUPPLIER_CANARY, act, build, collect_all, confirm_and_assign, draft, place)

COST_CANARIES = [str(PURCHASE_CANARY), str(MARGIN_CANARY), SUPPLIER_CANARY, "1555.54"]  # 1555.54 = تكلفة السطر
SUPPLIER_FORBIDDEN = [CUSTOMER_CANARY, ADDRESS_CANARY, str(SALE_PRICE)]

CUSTOMER_VIEWS = ["v_customer_catalog", "v_customer_order_lines", "v_customer_lists"]
DRIVER_VIEWS = ["v_driver_orders", "v_driver_stops", "v_driver_stop_lines"]
SUPPLIER_VIEWS = ["v_supplier_pickups"]

FORBIDDEN_COLUMNS = {
    "customer": re.compile(r"purchase|cost|margin|profit|supplier"),
    "driver": re.compile(r"purchase|cost|margin|profit|supplier"),
    "supplier": re.compile(r"customer|sale_price|total|dest|margin|profit"),
}


def leaks(text: str, canaries: list[str]) -> list[str]:
    return [c for c in canaries if c in text]


async def dump(c, relation: str) -> str:
    rows = await c.fetch(f"SELECT row_to_json(t)::text AS j FROM {relation} t")
    return "\n".join(r["j"] for r in rows)


async def _world_with_live_order(db):
    w = await build(db)
    oid = await draft(db, w)
    await place(db, w, oid)
    await confirm_and_assign(db, w, oid)
    await collect_all(db, w, oid)
    await act(db, "driver", w.drv_user)
    bid = await db.fetchval("INSERT INTO order_batches (order_id, seq) VALUES ($1, 1) RETURNING id", oid)
    await db.execute("INSERT INTO order_batch_lines (batch_id, order_item_id, qty) "
                     "SELECT $1, id, qty FROM order_items WHERE order_id = $2", bid, oid)
    await db.execute("UPDATE order_batches SET status = 'notified' WHERE id = $1", bid)
    await act(db, "customer", w.cust_user)
    lst = await db.fetchval("INSERT INTO recurring_lists (customer_id, name, created_by) "
                            "VALUES ($1, 'طلب السبت', $2) RETURNING id", w.customer, w.cust_user)
    await db.execute("INSERT INTO recurring_list_items (list_id, catalog_item_id, qty) VALUES ($1, $2, 3)",
                     lst, w.item)
    return w


async def test_positive_witness_scanner_sees_canaries(db):
    await _world_with_live_order(db)
    admin_side = "\n".join([await dump(db, "supplier_offers"), await dump(db, "catalog_item_pricing"),
                            await dump(db, "suppliers"),
                            await dump(db, "(SELECT round(l.planned_qty * c.unit_cost, 2) AS cost "
                                           "FROM pickup_stop_lines l JOIN pickup_line_costs c "
                                           "ON c.stop_line_id = l.id)")])
    assert sorted(leaks(admin_side, COST_CANARIES)) == sorted(COST_CANARIES)
    customer_side = "\n".join([await dump(db, "customers"), await dump(db, "customer_locations"),
                               await dump(db, "catalog_items")])
    assert sorted(leaks(customer_side, SUPPLIER_FORBIDDEN)) == sorted(SUPPLIER_FORBIDDEN)
    # والمسبار على أسماء الأعمدة يرى عموداً محظوراً حين يوجد
    assert FORBIDDEN_COLUMNS["customer"].search("purchase_price")
    assert FORBIDDEN_COLUMNS["supplier"].search("customer_name")


async def test_customer_and_driver_views_carry_no_cost_or_supplier(db):
    await _world_with_live_order(db)
    for view in CUSTOMER_VIEWS + DRIVER_VIEWS:
        text = await dump(db, view)
        assert text, f"{view} فارغ — فحص بلا موضوع لا يثبت شيئاً"
        assert leaks(text, COST_CANARIES) == [], f"تسريب في {view}"


async def test_supplier_view_carries_no_customer_or_sale_price(db):
    await _world_with_live_order(db)
    for view in SUPPLIER_VIEWS:
        text = await dump(db, view)
        assert text, f"{view} فارغ — فحص بلا موضوع لا يثبت شيئاً"
        assert leaks(text, SUPPLIER_FORBIDDEN) == [], f"تسريب في {view}"


async def test_view_columns_are_clean(db):
    for audience, views in (("customer", CUSTOMER_VIEWS), ("driver", DRIVER_VIEWS), ("supplier", SUPPLIER_VIEWS)):
        for view in views:
            cols = [r["column_name"] for r in await db.fetch(
                "SELECT column_name FROM information_schema.columns WHERE table_schema = 'madad' "
                "AND table_name = $1", view)]
            assert cols, view
            bad = [c for c in cols if FORBIDDEN_COLUMNS[audience].search(c)]
            assert bad == [], f"{view}: {bad}"


async def test_customer_notifications_carry_no_cost_or_supplier(db):
    await _world_with_live_order(db)
    rows = await db.fetch("SELECT row_to_json(n)::text AS j FROM notifications n")
    assert rows, "لا إشعار — فحص بلا موضوع"
    text = "\n".join(r["j"] for r in rows)
    assert json.loads(rows[0]["j"])["kind"] == "batch_departure"
    assert leaks(text, COST_CANARIES) == []
