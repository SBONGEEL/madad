"""قواعد القسم 11.2 مفروضة في القاعدة — كلٌّ في الاتجاهين:
الخرق يُمسك ويُسمّى، والمسار السليم يمرّ.
"""
from __future__ import annotations

from decimal import Decimal

import asyncpg
import pytest

from tests.db.world import (SALE_PRICE, act, balance, build, collect_all, confirm_and_assign,
                            deliver_in_one, draft, place)


async def raises(c, coro, needle: str):
    with pytest.raises(asyncpg.PostgresError) as e:
        await coro
    assert needle in str(e.value), f"توقعت «{needle}» فجاء: {e.value}"


# ——— الفاعل —————————————————————————————————————————————————————————————
async def test_write_without_actor_is_rejected(db):
    await raises(db, db.execute("INSERT INTO orders (customer_id) VALUES (1)"), "actor_missing")
    await raises(db, db.execute("UPDATE city_settings SET fee_mode = 'flat', delivery_fee_flat = 1"),
                 "actor_missing")


# ——— المال ——————————————————————————————————————————————————————————————
async def test_money_precision(db):
    assert await db.fetchval("SELECT 12.34::money_lyd") == Decimal("12.34")
    await raises(db, db.fetchval("SELECT 12.345::money_lyd"), "money_precision")


# ——— الحقول المشتقة ————————————————————————————————————————————————————
async def test_derived_fields_reject_app_writes(db):
    w = await build(db)
    await act(db, "admin", w.owner)
    await raises(db, db.execute("UPDATE catalog_items SET sale_price = 1 WHERE id = $1", w.item),
                 "derived_field_write: catalog_items.sale_price")
    oid = await draft(db, w)
    await act(db, "customer", w.cust_user)
    await raises(db, db.execute("UPDATE order_items SET unit_price = 1 WHERE order_id = $1", oid),
                 "derived_field_write: order_items.unit_price")
    await raises(db, db.execute("UPDATE orders SET subtotal = 1 WHERE id = $1", oid),
                 "derived_field_write: orders.subtotal")
    await act(db, "supplier", w.sup_user)
    await raises(db, db.execute("UPDATE supplier_offers SET reserved_qty = 5 WHERE id = $1", w.offer),
                 "derived_field_write: supplier_offers.reserved_qty")
    # المسار السليم: السعر يتغيّر بكاتبه — التسعير
    await act(db, "admin", w.owner)
    await db.execute("UPDATE catalog_item_pricing SET mode = 'manual', margin_value = NULL, manual_price = 950 "
                     "WHERE catalog_item_id = $1", w.item)
    assert await db.fetchval("SELECT sale_price FROM catalog_items WHERE id = $1", w.item) == Decimal("950")


async def test_trigger_only_tables_reject_app_writes(db):
    await act(db, "system")
    await raises(db, db.execute("INSERT INTO ledger_transactions (kind, city, memo, actor_role) "
                                "VALUES ('expense', 'TIP', 'x', 'system')"), "derived_field_write: ledger_transactions")
    await raises(db, db.execute("INSERT INTO audit_log (table_name, row_pk, op, actor_role) "
                                "VALUES ('x', '1', 'INSERT', 'system')"), "derived_field_write: audit_log")


def _registry_gaps(guarded: set[tuple[str, str]], registry: set[tuple[str, str]]) -> set[tuple[str, str]]:
    return guarded - registry


async def test_every_guarded_column_has_a_declared_writer(db):
    rows = await db.fetch("""
        SELECT c.relname, encode(t.tgargs, 'escape') AS args
          FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid
          JOIN pg_proc p ON p.oid = t.tgfoid
         WHERE p.proname = 'guard_derived'""")
    guarded = set()
    for r in rows:
        for arg in r["args"].split("\\000"):
            if arg:
                guarded.add((r["relname"], arg.split(":", 1)[0]))
    assert len(guarded) > 20, "الحارس لم يرَ أعمدة — المسبار أعمى"
    registry = {(r["table_name"], r["column_name"])
                for r in await db.fetch("SELECT table_name, column_name FROM derived_fields")}
    assert _registry_gaps(guarded, registry) == set()
    # شاهد إيجابي: عمود محروس غير مسجّل يُمسك
    assert _registry_gaps(guarded | {("orders", "phantom")}, registry) == {("orders", "phantom")}


# ——— الملحق فقط ——————————————————————————————————————————————————————————
async def test_append_only(db):
    w = await build(db)
    oid = await draft(db, w)
    await act(db, "admin", w.owner)
    await raises(db, db.execute("DELETE FROM order_status_events WHERE order_id = $1", oid),
                 "derived_field_write: order_status_events")
    n = await db.fetchval("SELECT count(*) FROM supplier_offer_price_history WHERE offer_id = $1", w.offer)
    assert n == 1


# ——— الاعتماد والقيود البنيوية ————————————————————————————————————————————
async def test_supplier_approval_requires_payout_cycle(db):
    w = await build(db)
    await act(db, "admin", w.owner)
    await raises(db, db.execute("UPDATE suppliers SET payout_cycle = NULL WHERE id = $1", w.supplier),
                 "payout_cycle_on_approval")


async def test_v1_credit_and_referrer_disabled(db):
    w = await build(db)
    await act(db, "admin", w.owner)
    await raises(db, db.execute("UPDATE customers SET credit_limit = 100"), "v1_credit_disabled")
    await raises(db, db.execute("UPDATE customers SET referrer_id = 1"), "v1_referrer_disabled")


async def test_offer_location_must_belong_to_supplier(db):
    w = await build(db)
    await act(db, "system")
    other = await db.fetchval("INSERT INTO suppliers (city, name, contact_name, phone, owner_id_media_id) "
                              "VALUES ('TIP', 'آخر', 'x', '+218910000009', $1) RETURNING id", w.media)
    foreign_loc = await db.fetchval(
        "INSERT INTO supplier_pickup_locations (supplier_id, city, label, lat, lng, address_text) "
        "VALUES ($1, 'TIP', 'x', 1, 1, 'x') RETURNING id", other)
    await act(db, "supplier", w.sup_user)
    await raises(db, db.execute("UPDATE supplier_offers SET pickup_location_id = $2 WHERE id = $1",
                                w.offer, foreign_loc), "foreign key")


async def test_unapproved_party_cannot_operate(db):
    w = await build(db)
    await act(db, "admin", w.owner)
    await db.execute("UPDATE customers SET status = 'suspended' WHERE id = $1", w.customer)
    await act(db, "customer", w.cust_user)
    await raises(db, db.execute("INSERT INTO orders (customer_id) VALUES ($1)", w.customer), "party_not_approved")


async def test_duplicate_product_names_are_one(db):
    w = await build(db)
    await act(db, "system")
    await raises(db, db.execute("INSERT INTO products (name_ar, category_id, status, proposed_by_supplier_id) "
                                "VALUES (' طماطم ', $1, 'proposed', $2)", w.category, w.supplier),
                 "products_unique_name")


# ——— الحد الأدنى للطلبية ——————————————————————————————————————————————————
async def test_min_order_enforced(db):
    w = await build(db)
    await act(db, "admin", w.owner)
    await db.execute("UPDATE city_settings SET min_order_amount = 1000")
    oid = await draft(db, w, "1")                 # 911.31 < 1000
    await raises(db, place(db, w, oid), "min_order_amount")
    await act(db, "customer", w.cust_user)
    await db.execute("UPDATE order_items SET qty = 2 WHERE order_id = $1", oid)
    await place(db, w, oid)
    assert await db.fetchval("SELECT status FROM orders WHERE id = $1", oid) == "placed"
    # تعديل العميل بعد placed لا يهبط تحت الحد (مشغّل مؤجّل عند الإيداع)
    await raises(db, db.execute("UPDATE order_items SET qty = 1 WHERE order_id = $1", oid), "min_order_amount")


async def test_min_order_undecided_stops_explicitly(db):
    w = await build(db, settings=False)
    await act(db, "admin", w.owner)
    await db.execute("UPDATE city_settings SET fee_mode = 'flat', delivery_fee_flat = 10")
    oid = await draft(db, w)
    await raises(db, place(db, w, oid), "missing_setting: TIP.min_order")


# ——— آلة الحالة ————————————————————————————————————————————————————————————
async def test_state_machine(db):
    w = await build(db)
    oid = await draft(db, w)
    await act(db, "customer", w.cust_user)
    await raises(db, db.execute("UPDATE orders SET status = 'delivered' WHERE id = $1", oid), "invalid_transition")
    await place(db, w, oid)
    await raises(db, db.execute("UPDATE orders SET status = 'confirmed' WHERE id = $1", oid),
                 "invalid_transition: placed -> confirmed by customer")
    await act(db, "admin", w.owner)
    await raises(db, db.execute("UPDATE orders SET status = 'cancelled' WHERE id = $1", oid), "orders_check")
    await db.execute("UPDATE orders SET status = 'cancelled', cancel_reason = 'طلب العميل' WHERE id = $1", oid)
    events = [r["to_status"] for r in await db.fetch(
        "SELECT to_status FROM order_status_events WHERE order_id = $1 ORDER BY id", oid)]
    assert events == ["draft", "placed", "cancelled"]


async def test_customer_edits_until_confirmed_only(db):
    w = await build(db)
    oid = await draft(db, w)
    await place(db, w, oid)
    await act(db, "customer", w.cust_user)
    await db.execute("UPDATE order_items SET qty = 3 WHERE order_id = $1", oid)
    await act(db, "admin", w.owner)
    await db.execute("UPDATE orders SET status = 'confirmed' WHERE id = $1", oid)
    await act(db, "customer", w.cust_user)
    await raises(db, db.execute("UPDATE order_items SET qty = 4 WHERE order_id = $1", oid),
                 "order_locked_for_customer")


async def test_price_locked_at_placement(db):
    w = await build(db)
    oid = await draft(db, w)
    await place(db, w, oid)
    await act(db, "admin", w.owner)
    await db.execute("UPDATE catalog_item_pricing SET mode = 'manual', margin_value = NULL, manual_price = 1200 "
                     "WHERE catalog_item_id = $1", w.item)
    assert await db.fetchval("SELECT unit_price FROM order_items WHERE order_id = $1", oid) == SALE_PRICE
    assert await db.fetchval("SELECT subtotal FROM orders WHERE id = $1", oid) == SALE_PRICE * 2


# ——— الدفعات ——————————————————————————————————————————————————————————————
async def test_batch_cannot_depart_without_notice(db):
    w = await build(db)
    oid = await draft(db, w)
    await place(db, w, oid)
    await confirm_and_assign(db, w, oid)
    await collect_all(db, w, oid)
    bid = await db.fetchval("INSERT INTO order_batches (order_id, seq) VALUES ($1, 1) RETURNING id", oid)
    await db.execute("INSERT INTO order_batch_lines (batch_id, order_item_id, qty) "
                     "SELECT $1, id, 1 FROM order_items WHERE order_id = $2", bid, oid)
    await raises(db, db.execute("UPDATE order_batches SET status = 'departed' WHERE id = $1", bid),
                 "invalid_batch_transition: planned -> departed")
    # ما سيصل لاحقاً يحتاج موعداً
    await raises(db, db.execute("UPDATE order_batches SET status = 'notified' WHERE id = $1", bid),
                 "batch_notice_needs_later_eta")
    await db.execute("UPDATE order_batches SET next_eta_at = now() + interval '2 hours' WHERE id = $1", bid)
    await db.execute("UPDATE order_batches SET status = 'notified' WHERE id = $1", bid)
    note = await db.fetchrow("SELECT n.* FROM notifications n JOIN order_batches b ON b.notification_id = n.id "
                             "WHERE b.id = $1", bid)
    assert note["kind"] == "batch_departure" and "sms" in note["channels"]
    await db.execute("UPDATE order_batches SET status = 'departed' WHERE id = $1", bid)
    await db.execute("UPDATE order_batches SET status = 'delivered' WHERE id = $1", bid)
    assert await db.fetchval("SELECT status FROM orders WHERE id = $1", oid) == "partially_delivered"


async def test_batch_constraint_is_a_backstop(db):
    # القيد البنيوي نفسه يمسك صفاً «منطلقاً» بلا إشعار حتى لو تخطّى أحدٌ المشغّل
    row = await db.fetchval("""SELECT pg_get_constraintdef(oid) FROM pg_constraint
                               WHERE conname = 'batch_departure_requires_notice'""")
    assert "notification_id IS NOT NULL" in row


# ——— الدورة الكاملة والدفتر ——————————————————————————————————————————————
async def test_full_cycle_posts_a_balanced_ledger(db):
    w = await build(db)
    oid = await draft(db, w)
    await place(db, w, oid)
    await act(db, "admin", w.owner)
    await db.execute("UPDATE orders SET status = 'confirmed' WHERE id = $1", oid)
    assert await db.fetchval("SELECT reserved_qty FROM supplier_offers WHERE id = $1", w.offer) == 2
    assert await db.fetchval("SELECT plan_complete FROM orders WHERE id = $1", oid)
    await raises(db, db.execute("UPDATE orders SET status = 'assigned', driver_id = $2 WHERE id = $1",
                                oid, w.driver), "route_km_missing")
    await db.execute("UPDATE orders SET route_km = 10 WHERE id = $1", oid)
    await db.execute("UPDATE orders SET status = 'assigned', driver_id = $2 WHERE id = $1", oid, w.driver)
    assert await db.fetchval("SELECT driver_pay FROM orders WHERE id = $1", oid) == Decimal("12.00")
    await collect_all(db, w, oid)
    assert await db.fetchval("SELECT reserved_qty FROM supplier_offers WHERE id = $1", w.offer) == 0
    assert await db.fetchval("SELECT consumed_qty FROM supplier_offers WHERE id = $1", w.offer) == 2
    assert await db.fetchval("SELECT available_qty FROM supplier_offers WHERE id = $1", w.offer) == 98
    # إبلاغ جديد من المورد بكمية = جردٌ جديد: المستهلَك يُصفَّر ولا يُطرح مرتين
    await act(db, "supplier", w.sup_user)
    await db.execute("UPDATE supplier_offers SET reported_qty = 50 WHERE id = $1", w.offer)
    assert await db.fetchval("SELECT available_qty FROM supplier_offers WHERE id = $1", w.offer) == 50
    await deliver_in_one(db, w, oid)
    assert await db.fetchval("SELECT status FROM orders WHERE id = $1", oid) == "delivered"

    total = SALE_PRICE * 2 + 10
    cost = Decimal("777.77") * 2
    assert await balance(db, "customer_receivable", w.customer) == 0
    assert await balance(db, "driver_cash", w.driver) == total
    assert await balance(db, "driver_wallet", w.driver) == Decimal("-12.00")
    assert await balance(db, "supplier_payable", w.supplier) == -cost
    assert await balance(db, "sales_revenue") == -(SALE_PRICE * 2)
    assert await balance(db, "delivery_fee_revenue") == -10
    assert await balance(db, "cost_of_goods") == cost
    assert await db.fetchval("SELECT sum(balance) FROM ledger_accounts") == 0
    unbalanced = await db.fetchval("SELECT count(*) FROM (SELECT transaction_id FROM ledger_entries "
                                   "GROUP BY 1 HAVING sum(amount) <> 0) x")
    assert unbalanced == 0
    await act(db, "admin", w.owner)
    await raises(db, db.execute("UPDATE ledger_accounts SET balance = 0"),
                 "derived_field_write: ledger_accounts.balance")

    # التسوية والصرف
    await act(db, "admin", w.owner)
    await raises(db, db.execute("INSERT INTO cash_handovers (driver_id, amount, received_by) VALUES ($1, $2, $3)",
                                w.driver, total + 1, w.owner), "handover_exceeds_cash")
    await db.execute("INSERT INTO cash_handovers (driver_id, amount, received_by) VALUES ($1, $2, $3)",
                     w.driver, total, w.owner)
    await db.execute("INSERT INTO supplier_payouts (supplier_id, amount, period_start, period_end, paid_by) "
                     "VALUES ($1, $2, current_date, current_date, $3)", w.supplier, cost, w.owner)
    assert await balance(db, "driver_cash", w.driver) == 0
    assert await balance(db, "supplier_payable", w.supplier) == 0
    assert await balance(db, "treasury") == total - cost


async def test_ledger_rejects_unbalanced_transaction(db):
    """شاهد إيجابي لحارس التوازن: حركة غير متوازنة تُكتب عبر مشغّل (المسار الوحيد
    المسموح) فيُمسكها المشغّل المؤجّل عند الإيداع."""
    await act(db, "system")
    await db.execute("""
        CREATE TABLE probe (x int);
        CREATE FUNCTION probe_post() RETURNS trigger AS $$ BEGIN
            PERFORM ledger_post('expense', 'TIP', 'probe', jsonb_build_array(
                jsonb_build_array(ledger_account('treasury', 'TIP'), 10),
                jsonb_build_array(ledger_account('operating_expense', 'TIP'), -9)));
            RETURN NULL; END $$ LANGUAGE plpgsql;
        CREATE TRIGGER probe AFTER INSERT ON probe FOR EACH ROW EXECUTE FUNCTION probe_post();
    """)
    await raises(db, db.execute("INSERT INTO probe VALUES (1)"), "ledger_unbalanced")
    assert await db.fetchval("SELECT count(*) FROM ledger_transactions") == 0


async def test_driver_cash_cap_blocks_new_assignments(db):
    w = await build(db)
    await act(db, "admin", w.owner)
    await db.execute("UPDATE city_settings SET driver_cash_cap = 1000")
    first = await draft(db, w)
    await place(db, w, first)
    await confirm_and_assign(db, w, first)
    await collect_all(db, w, first)
    await deliver_in_one(db, w, first)              # 1832.62 بحوزة السائق > 1000
    second = await draft(db, w)
    await place(db, w, second)
    await act(db, "admin", w.owner)
    await db.execute("UPDATE orders SET status = 'confirmed', route_km = 3 WHERE id = $1", second)
    await raises(db, db.execute("UPDATE orders SET status = 'assigned', driver_id = $2 WHERE id = $1",
                                second, w.driver), "driver_cash_cap_exceeded")
    await db.execute("INSERT INTO cash_handovers (driver_id, amount, received_by) VALUES ($1, 1000, $2)",
                     w.driver, w.owner)
    await db.execute("UPDATE orders SET status = 'assigned', driver_id = $2 WHERE id = $1", second, w.driver)


async def test_driver_counter_offer_accepted_by_owner(db):
    w = await build(db)
    oid = await draft(db, w)
    await place(db, w, oid)
    await act(db, "admin", w.owner)
    await db.execute("UPDATE orders SET status = 'confirmed' WHERE id = $1", oid)
    await act(db, "driver", w.drv_user)
    await raises(db, db.execute("UPDATE orders SET driver_pay = 30 WHERE id = $1", oid),
                 "derived_field_write: orders.driver_pay")
    off = await db.fetchval("INSERT INTO driver_pay_offers (order_id, driver_id, amount) VALUES ($1, $2, 30) "
                            "RETURNING id", oid, w.driver)
    await raises(db, db.execute("UPDATE driver_pay_offers SET status = 'accepted' WHERE id = $1", off),
                 "forbidden_role")
    await act(db, "admin", w.owner)
    await db.execute("UPDATE driver_pay_offers SET status = 'accepted' WHERE id = $1", off)
    row = await db.fetchrow("SELECT status, driver_id, driver_pay FROM orders WHERE id = $1", oid)
    assert (row["status"], row["driver_id"], row["driver_pay"]) == ("assigned", w.driver, Decimal("30"))


# ——— التوفّر وسياسة النفاد ————————————————————————————————————————————————
async def test_out_of_stock_policy(db):
    w = await build(db)
    await act(db, "supplier", w.sup_user)
    await db.execute("UPDATE supplier_offers SET reported_qty = 0 WHERE id = $1", w.offer)
    assert await db.fetchval("SELECT count(*) FROM v_customer_catalog") == 0          # auto_hide
    await act(db, "admin", w.owner)
    await db.execute("UPDATE catalog_items SET oos_policy = 'mark_out' WHERE id = $1", w.item)
    row = await db.fetchrow("SELECT orderable, out_of_stock FROM v_customer_catalog WHERE id = $1", w.item)
    assert (row["orderable"], row["out_of_stock"]) == (False, True)
    await act(db, "customer", w.cust_user)
    oid = await db.fetchval("INSERT INTO orders (customer_id) VALUES ($1) RETURNING id", w.customer)
    await raises(db, db.execute("INSERT INTO order_items (order_id, catalog_item_id, qty) VALUES ($1, $2, 1)",
                                oid, w.item), "item_not_orderable")
    await act(db, "supplier", w.sup_user)
    await db.execute("UPDATE supplier_offers SET reported_qty = 5 WHERE id = $1", w.offer)
    assert await db.fetchval("SELECT orderable FROM v_customer_catalog WHERE id = $1", w.item)


async def test_cancel_releases_reservation(db):
    w = await build(db)
    oid = await draft(db, w)
    await place(db, w, oid)
    await act(db, "admin", w.owner)
    await db.execute("UPDATE orders SET status = 'confirmed' WHERE id = $1", oid)
    assert await db.fetchval("SELECT available_qty FROM supplier_offers WHERE id = $1", w.offer) == 98
    await db.execute("UPDATE orders SET status = 'cancelled', cancel_reason = 'نفاد' WHERE id = $1", oid)
    assert await db.fetchval("SELECT available_qty FROM supplier_offers WHERE id = $1", w.offer) == 100


# ——— المخازن ——————————————————————————————————————————————————————————————
async def test_warehouse_first_and_stock_ledger(db):
    w = await build(db)
    await act(db, "admin", w.owner)
    wh = await db.fetchval("INSERT INTO warehouses (city, name, lat, lng, address_text) "
                           "VALUES ('TIP', 'مخزن مَدَد', 1, 1, 'x') RETURNING id")
    await db.execute("INSERT INTO stock_movements (warehouse_id, catalog_item_id, kind, qty_delta, unit_cost, "
                     "supplier_id) VALUES ($1, $2, 'intake', 5, 700, $3)", wh, w.item, w.supplier)
    await raises(db, db.execute("INSERT INTO stock_movements (warehouse_id, catalog_item_id, kind, qty_delta) "
                                "VALUES ($1, $2, 'count_adjust', -6)", wh, w.item), "stock_negative")
    oid = await draft(db, w)
    await place(db, w, oid)
    await confirm_and_assign(db, w, oid)
    stops = await db.fetch("SELECT source FROM pickup_stops WHERE order_id = $1", oid)
    assert [s["source"] for s in stops] == ["warehouse"]
    await collect_all(db, w, oid)
    assert await db.fetchval("SELECT on_hand FROM warehouse_stock WHERE warehouse_id = $1", wh) == 3
    await deliver_in_one(db, w, oid)
    assert await balance(db, "warehouse_inventory", wh) == Decimal("2100.00")   # 3 × 700
    assert await balance(db, "supplier_payable", w.supplier) == Decimal("-3500.00")
    # تحويل بلا نصف وارد يُرفض عند الإيداع
    await act(db, "admin", w.owner)
    wh2 = await db.fetchval("INSERT INTO warehouses (city, name, lat, lng, address_text) "
                            "VALUES ('TIP', 'مخزن 2', 1, 1, 'x') RETURNING id")
    await raises(db, db.execute("INSERT INTO stock_movements (warehouse_id, catalog_item_id, kind, qty_delta, "
                                "transfer_id) VALUES ($1, $2, 'transfer_out', -1, gen_random_uuid())", wh, w.item),
                 "transfer_unpaired")
    async with db.transaction():
        await db.execute("""INSERT INTO stock_movements (warehouse_id, catalog_item_id, kind, qty_delta, transfer_id)
                            VALUES ($1, $3, 'transfer_out', -1, '00000000-0000-0000-0000-000000000001'),
                                   ($2, $3, 'transfer_in', 1, '00000000-0000-0000-0000-000000000001')""",
                         wh, wh2, w.item)
    assert await balance(db, "warehouse_inventory", wh2) == Decimal("700.00")
