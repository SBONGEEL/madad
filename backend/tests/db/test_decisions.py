"""قرارات المالك 2026-09-26 (الترحيلتان 0002 و0003) — كلٌّ في الاتجاهين."""
from __future__ import annotations

from decimal import Decimal

import asyncpg
import pytest

from tests.db.world import (SUPPLIER_CANARY, act, balance, build, collect_all, confirm_and_assign,
                            deliver_in_one, draft, place)

BCRYPT = "$2b$12$" + "a" * 53


async def raises(coro, needle: str):
    with pytest.raises(asyncpg.PostgresError) as e:
        await coro
    assert needle in str(e.value), f"توقعت «{needle}» فجاء: {e.value}"


async def _assigned_order(db):
    w = await build(db)
    oid = await draft(db, w)
    await place(db, w, oid)
    await confirm_and_assign(db, w, oid)
    return w, oid


# ——— M-1 ————————————————————————————————————————————————————————————————
async def test_m1_prices_round_to_three_places(db):
    w = await build(db)
    await act(db, "admin", w.owner)
    await db.execute("UPDATE catalog_item_pricing SET margin_value = 12.5 WHERE catalog_item_id = $1", w.item)
    # 777.77 × 1.125 = 874.99125 → 874.991
    assert await db.fetchval("SELECT sale_price FROM catalog_items WHERE id = $1", w.item) == Decimal("874.991")


# ——— M-2 ————————————————————————————————————————————————————————————————
async def test_m2_supplier_name_for_driver_follows_setting(db):
    w, oid = await _assigned_order(db)
    label = "SELECT pickup_label FROM v_driver_stop_labels WHERE order_id = $1"
    assert await db.fetchval(label, oid) == "نقطة استلام 1"
    text = "\n".join(r["j"] for r in await db.fetch("SELECT row_to_json(v)::text AS j FROM v_driver_stop_labels v"))
    assert SUPPLIER_CANARY not in text
    await act(db, "admin", w.owner)
    await db.execute("UPDATE city_settings SET driver_sees_supplier_name = true")
    assert await db.fetchval(label, oid) == SUPPLIER_CANARY          # شاهد إيجابي: الفحص يرى الاسم حين يُفتح


async def test_m2_setting_is_owner_controlled(db):
    w = await build(db)
    await act(db, "driver", w.drv_user)
    await raises(db.execute("UPDATE city_settings SET driver_sees_supplier_name = true"), "forbidden_role")


# ——— M-19 ———————————————————————————————————————————————————————————————
async def test_m19_customer_sees_driver_only_when_enabled(db):
    w, oid = await _assigned_order(db)
    q = "SELECT driver_first_name, driver_phone FROM v_customer_order_driver WHERE order_id = $1"
    row = await db.fetchrow(q, oid)
    assert (row["driver_first_name"], row["driver_phone"]) == (None, None)
    await act(db, "admin", w.owner)
    await db.execute("UPDATE city_settings SET customer_sees_driver_name = true")
    row = await db.fetchrow(q, oid)
    assert (row["driver_first_name"], row["driver_phone"]) == ("السائق", None)
    await db.execute("UPDATE city_settings SET customer_can_call_driver = true")
    assert (await db.fetchrow(q, oid))["driver_phone"] == "+218910000004"


# ——— M-3 ————————————————————————————————————————————————————————————————
async def test_m3_handover_by_qr_scan_or_code_entry(db):
    w, oid = await _assigned_order(db)
    stop = await db.fetchrow("SELECT id, pickup_code, supplier_code FROM pickup_stops WHERE order_id = $1", oid)
    ins = "INSERT INTO pickup_handovers (stop_id, method, code_given) VALUES ($1, $2, $3)"
    # (أ) المورد يمسح QR السائق
    await act(db, "supplier", w.sup_user)
    wrong = "000000" if stop["pickup_code"] != "000000" else "111111"
    await raises(db.execute(ins, stop["id"], "qr_scan", wrong), "pickup_code_mismatch")
    await raises(db.execute(ins, stop["id"], "code_entry", stop["supplier_code"]), "forbidden_handover")
    await db.execute(ins, stop["id"], "qr_scan", stop["pickup_code"])
    assert await db.fetchval("SELECT actor_role FROM pickup_handovers WHERE stop_id = $1", stop["id"]) == "supplier"


async def test_m3_driver_types_supplier_code(db):
    w, oid = await _assigned_order(db)
    stop = await db.fetchrow("SELECT id, pickup_code, supplier_code FROM pickup_stops WHERE order_id = $1", oid)
    ins = "INSERT INTO pickup_handovers (stop_id, method, code_given) VALUES ($1, $2, $3)"
    await act(db, "driver", w.drv_user)
    await raises(db.execute(ins, stop["id"], "code_entry", stop["pickup_code"] if stop["pickup_code"] != stop["supplier_code"] else "999999"),
                 "pickup_code_mismatch")
    await db.execute(ins, stop["id"], "code_entry", stop["supplier_code"])


async def test_m3_each_side_sees_only_its_own_code(db):
    cols = lambda v: db.fetch("SELECT column_name FROM information_schema.columns WHERE table_schema = 'madad' "
                              "AND table_name = $1", v)
    sup = {r["column_name"] for r in await cols("v_supplier_pickups")}
    drv = {r["column_name"] for r in await cols("v_driver_stops")}
    assert "supplier_code" in sup and "pickup_code" not in sup
    assert "pickup_code" in drv and "supplier_code" not in drv


# ——— M-4 ————————————————————————————————————————————————————————————————
async def test_m4_ten_brand_categories_with_subcategories(db):
    top = await db.fetch("SELECT icon_key FROM categories WHERE parent_id IS NULL AND icon_key IS NOT NULL ORDER BY sort")
    assert [r["icon_key"] for r in top][:10] == ['food', 'beverages', 'kitchen_tools', 'cleaning', 'packaging',
                                                  'general', 'equipment', 'cooling', 'paper', 'more']
    subs = await db.fetchval("SELECT count(*) FROM categories c JOIN categories p ON p.id = c.parent_id "
                             "WHERE p.icon_key = 'food'")
    assert subs == 6


async def test_m4_supplier_proposes_admin_approves(db):
    w = await build(db)
    await act(db, "supplier", w.sup_user)
    await raises(db.execute("INSERT INTO products (name_ar, category_id, status) VALUES ('زعتر', $1, 'approved')",
                            w.category), "supplier_may_only_propose")
    pid = await db.fetchval("INSERT INTO products (name_ar, category_id, status, proposed_by_supplier_id) "
                            "VALUES ('زعتر', $1, 'proposed', $2) RETURNING id", w.category, w.supplier)
    await raises(db.execute("UPDATE products SET status = 'approved' WHERE id = $1", pid), "forbidden_role")
    await act(db, "admin", w.owner)
    await db.execute("UPDATE products SET status = 'approved' WHERE id = $1", pid)
    await db.execute("INSERT INTO categories (parent_id, name_ar, name_en) VALUES ($1, 'بهارات', 'Spices')", w.category)


# ——— M-11 ———————————————————————————————————————————————————————————————
async def test_m11_driver_approval_requires_pay_method(db):
    w = await build(db)
    await act(db, "system")
    u = await db.fetchval("INSERT INTO app_users (phone, audience, full_name) VALUES ('+218910000077', 'driver', 'ب') RETURNING id")
    d = await db.fetchval("INSERT INTO drivers (user_id, city, full_name, phone, id_media_id, license_media_id, "
                          "photo_media_id, vehicle) VALUES ($1, 'TIP', 'ب', '+218910000077', $2, $2, $2, 'car') RETURNING id",
                          u, w.media)
    await act(db, "admin", w.owner)
    approve = "UPDATE drivers SET status = 'approved', reviewed_by = $2, reviewed_at = now() WHERE id = $1"
    await raises(db.execute(approve, d, w.owner), "pay_method_on_approval")
    await db.execute("UPDATE drivers SET pay_method = 'offset_on_settlement' WHERE id = $1", d)
    await db.execute(approve, d, w.owner)


async def test_m11_offset_and_periodic_follow_method(db):
    w, oid = await _assigned_order(db)
    await collect_all(db, w, oid)
    await deliver_in_one(db, w, oid)
    await act(db, "admin", w.owner)
    # السائق التجريبي «دوري»: المقاصّة تُرفض، والصرف الدوري يمرّ
    await raises(db.execute("INSERT INTO cash_handovers (driver_id, amount, wallet_offset, received_by) "
                            "VALUES ($1, 100, 12, $2)", w.driver, w.owner), "pay_method_not_offset")
    await db.execute("INSERT INTO driver_payouts (driver_id, amount, paid_by) VALUES ($1, 12, $2)", w.driver, w.owner)
    assert await balance(db, "driver_wallet", w.driver) == 0
    await db.execute("UPDATE drivers SET pay_method = 'offset_on_settlement' WHERE id = $1", w.driver)
    await raises(db.execute("INSERT INTO driver_payouts (driver_id, amount, paid_by) VALUES ($1, 1, $2)", w.driver, w.owner),
                 "pay_method_not_periodic")


# ——— M-10 ———————————————————————————————————————————————————————————————
async def _delivered_with_dispute(db):
    w, oid = await _assigned_order(db)
    await collect_all(db, w, oid)
    await deliver_in_one(db, w, oid)
    await act(db, "customer", w.cust_user)
    item = await db.fetchval("SELECT id FROM order_items WHERE order_id = $1", oid)
    did = await db.fetchval("INSERT INTO disputes (order_id, order_item_id, opened_by_role, opened_by, kind, description) "
                            "VALUES ($1, $2, 'customer', $3, 'damaged', 'تالف') RETURNING id", oid, item, w.cust_user)
    return w, oid, did


async def test_m10_resolution_needs_refund_and_loss_decision(db):
    w, oid, did = await _delivered_with_dispute(db)
    await act(db, "admin", w.owner)
    await raises(db.execute("UPDATE disputes SET status = 'resolved', resolution = 'partial_discount', "
                            "resolution_amount = 9, resolved_by = $2, resolved_at = now() WHERE id = $1", did, w.owner),
                 "dispute_money_needs_decision")


async def test_m10_credit_on_supplier_then_next_order_collects_less(db):
    w, oid, did = await _delivered_with_dispute(db)
    await act(db, "admin", w.owner)
    payable = await balance(db, "supplier_payable", w.supplier)
    await db.execute("UPDATE disputes SET status = 'resolved', resolution = 'partial_discount', resolution_amount = 9, "
                     "refund_method = 'credit_next_order', loss_bearer = 'supplier', loss_supplier_id = $3, "
                     "resolved_by = $2, resolved_at = now() WHERE id = $1", did, w.owner, w.supplier)
    assert await balance(db, "customer_receivable", w.customer) == Decimal("-9")
    assert await balance(db, "supplier_payable", w.supplier) == payable + 9
    assert await db.fetchval("SELECT ledger_posted FROM disputes WHERE id = $1", did)
    # الطلبية التالية: السائق يحصّل الإجمالي ناقص 9
    cash_before = await balance(db, "driver_cash", w.driver)
    oid2 = await draft(db, w)
    await place(db, w, oid2)
    await confirm_and_assign(db, w, oid2)
    await collect_all(db, w, oid2)
    total2 = await db.fetchval("SELECT total FROM orders WHERE id = $1", oid2)
    assert await db.fetchval("SELECT amount_to_collect FROM v_driver_orders WHERE id = $1", oid2) == total2 - 9
    await deliver_in_one(db, w, oid2)
    assert await balance(db, "driver_cash", w.driver) == cash_before + total2 - 9
    assert await balance(db, "customer_receivable", w.customer) == 0


async def test_m10_cash_refund_via_driver_loss_on_madad(db):
    w, oid, did = await _delivered_with_dispute(db)
    await act(db, "admin", w.owner)
    held = await balance(db, "driver_cash", w.driver)
    await db.execute("UPDATE disputes SET status = 'resolved', resolution = 'return', resolution_amount = 9, "
                     "refund_method = 'cash_via_driver', refund_driver_id = $3, loss_bearer = 'madad', "
                     "resolved_by = $2, resolved_at = now() WHERE id = $1", did, w.owner, w.driver)
    assert await balance(db, "driver_cash", w.driver) == held - 9
    assert await balance(db, "customer_receivable", w.customer) == 0
    assert await balance(db, "sales_adjustment") == 9
    await raises(db.execute("UPDATE disputes SET resolution_note = 'x' WHERE id = $1", did), "dispute_already_resolved")


# ——— M-14 ———————————————————————————————————————————————————————————————
async def test_m14_password_only_as_bcrypt_after_verification(db):
    w = await build(db)
    await act(db, "system")
    await raises(db.execute("UPDATE app_users SET phone_verified_at = now(), password_hash = 'Secret123' WHERE id = $1",
                            w.cust_user), "password_hash_bcrypt")
    await raises(db.execute("UPDATE app_users SET password_hash = $2 WHERE id = $1", w.cust_user, BCRYPT),
                 "password_after_verification")
    await db.execute("UPDATE app_users SET phone_verified_at = now(), password_hash = $2 WHERE id = $1", w.cust_user, BCRYPT)


async def test_m14_otp_verifies_a_number_once(db):
    await act(db, "system")
    ins = ("INSERT INTO otp_challenges (phone, audience, code_hash, expires_at, consumed_at, channel) "
           "VALUES ('+218910000050', 'customer', 'h', now() + interval '5 minutes', now(), 'whatsapp')")
    await db.execute(ins)
    await raises(db.execute(ins), "otp_register_once")


# ——— رأس المال ————————————————————————————————————————————————————————————
async def test_capital_opening_cash_and_injection_balance(db):
    w = await build(db)
    await act(db, "admin", w.owner)
    ins = ("INSERT INTO owner_capital_entries (city, kind, amount, occurred_on, note, created_by) "
           "VALUES ('TIP', $1, $2, current_date, $3, $4)")
    await db.execute(ins, "opening_cash", Decimal("20000"), "رصيد البداية", w.owner)
    await raises(db.execute(ins, "opening_cash", Decimal("5"), "مكرر", w.owner), "one_opening_cash_per_city")
    await db.execute(ins, "injection", Decimal("5000.250"), "ضخّ لشراء مخزون", w.owner)
    assert await balance(db, "treasury") == Decimal("25000.250")
    assert await balance(db, "owner_equity") == Decimal("-25000.250")
    await raises(db.execute("UPDATE owner_capital_entries SET amount = 1"), "append_only_update")


async def test_capital_owner_only_and_opening_stock(db):
    w = await build(db)
    await act(db, "system")
    sup = await db.fetchval("INSERT INTO app_users (phone, audience, full_name) VALUES ('+218910000060', 'admin', 'مشرف') RETURNING id")
    await db.execute("INSERT INTO admin_members (user_id, role) VALUES ($1, 'supervisor')", sup)
    await db.execute("INSERT INTO admin_permissions (user_id, permission) VALUES ($1, 'money'), ($1, 'warehouses')", sup)
    await act(db, "admin", sup)
    await raises(db.execute("INSERT INTO owner_capital_entries (city, kind, amount, occurred_on, note, created_by) "
                            "VALUES ('TIP', 'injection', 10, current_date, 'x', $1)", sup), "forbidden_owner_only")
    await act(db, "admin", w.owner)
    wh = await db.fetchval("INSERT INTO warehouses (city, name, lat, lng, address_text) VALUES ('TIP', 'م', 1, 1, 'x') RETURNING id")
    await db.execute("INSERT INTO stock_movements (warehouse_id, catalog_item_id, kind, qty_delta, unit_cost, funded_by_owner) "
                     "VALUES ($1, $2, 'intake', 10, 8.5, true)", wh, w.item)
    assert await balance(db, "warehouse_inventory", wh) == Decimal("85")
    assert await balance(db, "owner_equity") == Decimal("-85")
    assert await db.fetchval("SELECT on_hand FROM warehouse_stock WHERE warehouse_id = $1", wh) == 10
