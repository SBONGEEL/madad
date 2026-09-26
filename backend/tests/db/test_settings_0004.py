"""قرارات المالك، الدفعة الثانية (2026-09-26، الترحيلة 0004) — كل إعداد بكل قيمة، في الاتجاهين.

قاعدة الإعدادات: قيمة ابتدائية، وتغيير مُدقَّق، ولا يسري على طلبية قائمة.
"""
from __future__ import annotations

import json
from decimal import Decimal

import asyncpg
import pytest

from tests.db.world import (act, balance, build, collect_all, confirm_and_assign, deliver_in_one, draft, place)

BCRYPT = "$2b$12$" + "a" * 53
BCRYPT2 = "$2b$12$" + "b" * 53


async def raises(coro, needle: str):
    with pytest.raises(asyncpg.PostgresError) as e:
        await coro
    assert needle in str(e.value), f"توقعت «{needle}» فجاء: {e.value}"


async def setting(db, w, **kv):
    await act(db, "admin", w.owner)
    for k, v in kv.items():
        await db.execute(f"UPDATE city_settings SET {k} = $1 WHERE city = 'TIP'", v)


async def notes(db, kind: str) -> list[dict]:
    return [dict(r) for r in await db.fetch("SELECT user_id, payload::text AS payload FROM notifications "
                                            "WHERE kind = $1 ORDER BY id", kind)]


async def supplier_price(db, w, price: str):
    await act(db, "supplier", w.sup_user)
    await db.execute("UPDATE supplier_offers SET purchase_price = $2 WHERE id = $1", w.offer, Decimal(price))


async def purchaser(db, w, phone="+218910000009", branch=None) -> int:
    await act(db, "system")
    uid = await db.fetchval("INSERT INTO app_users (phone, audience, full_name) VALUES ($1, 'customer', 'مسؤول') "
                            "RETURNING id", phone)
    branch = branch or await db.fetchval("SELECT id FROM customer_locations WHERE customer_id = $1", w.customer)
    await act(db, "customer", w.cust_user)
    await db.execute("INSERT INTO customer_members (customer_id, user_id, role, branch_id) "
                     "VALUES ($1, $2, 'purchaser', $3)", w.customer, uid, branch)
    return uid


async def new_branch(db, w, name="فرع قرقارش", approve=True, lat="32.88", lng="13.12") -> int:
    await act(db, "customer", w.cust_user)
    bid = await db.fetchval("INSERT INTO customer_locations (customer_id, city, lat, lng, address_text, name) "
                            "VALUES ($1, 'TIP', $2, $3, 'قرقارش', $4) RETURNING id", w.customer,
                            Decimal(lat), Decimal(lng), name)
    if approve:
        await act(db, "admin", w.owner)
        await db.execute("UPDATE customer_locations SET status = 'approved' WHERE id = $1", bid)
    return bid


# ——— القيم الابتدائية وتدقيق التغيير ————————————————————————————————————————————
async def test_initial_values(db):
    w = await build(db)
    row = await db.fetchrow("SELECT reprice_on_cost_change, cancel_policy::text, oversell_policy::text, "
                            "pickup_proof_required FROM city_settings WHERE city = 'TIP'")
    assert tuple(row) == (False, "until_collecting", "forbid", True)
    assert await db.fetchval("SELECT current_cogs_method('TIP')::text") == "average"
    assert await db.fetchval("SELECT purchaser_mode::text FROM customers WHERE id = $1", w.customer) == "direct"
    chans = [tuple(r) for r in await db.fetch("SELECT channel::text, position, enabled FROM otp_channels ORDER BY position")]
    assert chans == [("whatsapp_official", 1, True), ("whatsapp_linked", 2, True), ("sms", 3, True)]


async def test_every_setting_change_is_audited_with_who_and_when(db):
    w = await build(db)
    await setting(db, w, cancel_policy="anytime")
    row = await db.fetchrow("SELECT actor_role, actor_id, before->>'cancel_policy' AS b, after->>'cancel_policy' AS a "
                            "FROM audit_log WHERE table_name = 'city_settings' ORDER BY id DESC LIMIT 1")
    assert tuple(row) == ("admin", w.owner, "until_collecting", "anytime")


async def test_settings_are_the_admins_alone(db):
    w = await build(db)
    await act(db, "customer", w.cust_user)
    await raises(db.execute("UPDATE city_settings SET oversell_policy = 'allow'"), "forbidden_role")


# ——— م-6 ————————————————————————————————————————————————————————————————
async def test_m6_manual_marks_review_and_always_notifies_owner(db):
    w = await build(db)
    before = await db.fetchval("SELECT sale_price FROM catalog_items WHERE id = $1", w.item)
    await supplier_price(db, w, "780")
    assert await db.fetchval("SELECT sale_price FROM catalog_items WHERE id = $1", w.item) == before
    assert await db.fetchval("SELECT needs_review FROM catalog_item_pricing WHERE catalog_item_id = $1", w.item)
    n = await notes(db, "price_changed")
    assert [x["user_id"] for x in n] == [w.owner] and json.loads(n[0]["payload"])["new_price"] == 780
    assert await db.fetchval("SELECT count(*) FROM supplier_offer_price_history WHERE offer_id = $1", w.offer) == 2


async def test_m6_auto_reprices_with_the_item_margin_and_still_notifies(db):
    w = await build(db)
    await setting(db, w, reprice_on_cost_change=True)
    await supplier_price(db, w, "780")
    assert await db.fetchval("SELECT sale_price FROM catalog_items WHERE id = $1", w.item) == Decimal("913.926")
    assert not await db.fetchval("SELECT needs_review FROM catalog_item_pricing WHERE catalog_item_id = $1", w.item)
    assert len(await notes(db, "price_changed")) == 1
    assert await db.fetchval("SELECT count(*) FROM catalog_price_history WHERE catalog_item_id = $1", w.item) == 2


@pytest.mark.parametrize("project,override,repriced", [(False, True, True), (True, False, False)])
async def test_m6_item_exception_overrides_the_project(db, project, override, repriced):
    w = await build(db)
    await setting(db, w, reprice_on_cost_change=project)
    await db.execute("UPDATE catalog_item_pricing SET reprice_override = $2 WHERE catalog_item_id = $1", w.item, override)
    await supplier_price(db, w, "780")
    price = await db.fetchval("SELECT sale_price FROM catalog_items WHERE id = $1", w.item)
    assert (price == Decimal("913.926")) is repriced


@pytest.mark.parametrize("auto", [False, True])
async def test_m6_never_sold_below_cost_whatever_the_setting(db, auto):
    w = await build(db)
    await setting(db, w, reprice_on_cost_change=auto)
    await db.execute("UPDATE catalog_item_pricing SET mode = 'manual', margin_value = NULL, manual_price = 800 "
                     "WHERE catalog_item_id = $1", w.item)
    await supplier_price(db, w, "850")
    assert await db.fetchval("SELECT below_cost FROM catalog_items WHERE id = $1", w.item)
    assert await db.fetchval("SELECT count(*) FROM v_customer_catalog WHERE id = $1", w.item) == 0
    await act(db, "customer", w.cust_user)
    oid = await db.fetchval("INSERT INTO orders (customer_id) VALUES ($1) RETURNING id", w.customer)
    await raises(db.execute("INSERT INTO order_items (order_id, catalog_item_id, qty) VALUES ($1, $2, 1)", oid, w.item),
                 "item_below_cost")
    assert len(await notes(db, "below_cost")) == 1
    # والعكس: المالك يرفع سعر البيع فيعود الصنف
    await act(db, "admin", w.owner)
    await db.execute("UPDATE catalog_item_pricing SET manual_price = 900 WHERE catalog_item_id = $1", w.item)
    assert not await db.fetchval("SELECT below_cost FROM catalog_items WHERE id = $1", w.item)
    assert await db.fetchval("SELECT count(*) FROM v_customer_catalog WHERE id = $1", w.item) == 1


async def test_m6_below_cost_blocks_an_existing_cart_at_placing(db):
    w = await build(db)
    oid = await draft(db, w)
    await act(db, "admin", w.owner)
    await db.execute("UPDATE catalog_item_pricing SET mode = 'manual', margin_value = NULL, manual_price = 800 "
                     "WHERE catalog_item_id = $1", w.item)
    await supplier_price(db, w, "850")
    await raises(place(db, w, oid), "item_below_cost")


async def test_m6_below_cost_flag_is_derived(db):
    w = await build(db)
    await act(db, "admin", w.owner)
    await raises(db.execute("UPDATE catalog_items SET below_cost = true WHERE id = $1", w.item),
                 "derived_field_write: catalog_items.below_cost")


# ——— م-7 ————————————————————————————————————————————————————————————————
async def test_m7_until_collecting_allows_before_and_refuses_after(db):
    w = await build(db)
    oid = await draft(db, w)
    await place(db, w, oid)
    await confirm_and_assign(db, w, oid)
    await act(db, "customer", w.cust_user)
    await db.execute("UPDATE orders SET status = 'cancelled' WHERE id = $1", oid)
    oid2 = await draft(db, w)
    await place(db, w, oid2)
    await confirm_and_assign(db, w, oid2)
    await collect_all(db, w, oid2)
    await act(db, "customer", w.cust_user)
    await raises(db.execute("UPDATE orders SET status = 'cancelled' WHERE id = $1", oid2),
                 "invalid_transition: collecting -> cancelled by customer")


async def test_m7_anytime_allows_after_collecting_and_owner_decides_refund(db):
    w = await build(db)
    await setting(db, w, cancel_policy="anytime")
    oid = await draft(db, w)
    await place(db, w, oid)
    await confirm_and_assign(db, w, oid)
    await collect_all(db, w, oid)
    await act(db, "customer", w.cust_user)
    await db.execute("UPDATE orders SET status = 'cancelled' WHERE id = $1", oid)
    d = await db.fetchrow("SELECT kind::text, status::text FROM disputes WHERE order_id = $1", oid)
    assert tuple(d) == ("other", "open")
    # البضاعة المستلمة من المورد مستحقة له (2 × 777.77)
    assert await balance(db, "supplier_payable", w.supplier) == Decimal("-1555.540")


async def test_m7_setting_does_not_reach_an_existing_order(db):
    w = await build(db)
    oid = await draft(db, w)
    await place(db, w, oid)                               # لقطة: until_collecting
    await setting(db, w, cancel_policy="anytime")
    await confirm_and_assign(db, w, oid)
    await collect_all(db, w, oid)
    await act(db, "customer", w.cust_user)
    await raises(db.execute("UPDATE orders SET status = 'cancelled' WHERE id = $1", oid), "invalid_transition")


# ——— م-8 ————————————————————————————————————————————————————————————————
async def test_m8_direct_purchaser_places_alone(db):
    w = await build(db)
    p = await purchaser(db, w)
    await act(db, "customer", p)
    oid = await db.fetchval("INSERT INTO orders (customer_id) VALUES ($1) RETURNING id", w.customer)
    await db.execute("INSERT INTO order_items (order_id, catalog_item_id, qty) VALUES ($1, $2, 1)", oid, w.item)
    await db.execute("UPDATE orders SET status = 'placed' WHERE id = $1", oid)


async def test_m8_owner_confirms_mode(db):
    w = await build(db)
    p = await purchaser(db, w)
    await act(db, "admin", w.owner)
    await db.execute("UPDATE customers SET purchaser_mode = 'owner_confirms' WHERE id = $1", w.customer)
    await act(db, "customer", p)
    oid = await db.fetchval("INSERT INTO orders (customer_id) VALUES ($1) RETURNING id", w.customer)
    await db.execute("INSERT INTO order_items (order_id, catalog_item_id, qty) VALUES ($1, $2, 1)", oid, w.item)
    await raises(db.execute("UPDATE orders SET status = 'placed' WHERE id = $1", oid), "owner_confirmation_required")
    await db.execute("UPDATE orders SET ready_for_owner_at = now() WHERE id = $1", oid)
    assert [n["user_id"] for n in await notes(db, "order_awaiting_owner")] == [w.cust_user]
    await act(db, "customer", w.cust_user)
    await db.execute("UPDATE orders SET status = 'placed' WHERE id = $1", oid)


async def test_m8_only_owner_adds_users_and_branches_and_only_admin_sets_mode(db):
    w = await build(db)
    p = await purchaser(db, w)
    await act(db, "system")
    other = await db.fetchval("INSERT INTO app_users (phone, audience, full_name) VALUES ('+218910000010', "
                              "'customer', 'آخر') RETURNING id")
    await act(db, "customer", p)
    await raises(db.execute("INSERT INTO customer_members (customer_id, user_id, role) VALUES ($1, $2, 'owner')",
                            w.customer, other), "forbidden_owner_member")
    await raises(db.execute("INSERT INTO customer_locations (customer_id, city, lat, lng, address_text, name) "
                            "VALUES ($1, 'TIP', 32.9, 13.1, 'x', 'فرع')", w.customer), "forbidden_owner_member")
    await act(db, "customer", w.cust_user)
    await raises(db.execute("UPDATE customers SET purchaser_mode = 'owner_confirms' WHERE id = $1", w.customer),
                 "forbidden_role")


# ——— م-9 ————————————————————————————————————————————————————————————————
async def test_m9_branch_needs_approval_and_orders_bind_one_branch(db):
    w = await build(db)
    b = await new_branch(db, w, approve=False)
    assert await db.fetchval("SELECT status::text FROM customer_locations WHERE id = $1", b) == "pending"
    assert len(await notes(db, "branch_pending")) == 1
    await act(db, "customer", w.cust_user)
    await raises(db.execute("INSERT INTO orders (customer_id, branch_id) VALUES ($1, $2)", w.customer, b),
                 "branch_not_approved")
    await act(db, "admin", w.owner)
    await db.execute("UPDATE customer_locations SET status = 'approved' WHERE id = $1", b)
    await act(db, "customer", w.cust_user)
    await raises(db.execute("INSERT INTO orders (customer_id) VALUES ($1)", w.customer), "branch_required")
    oid = await db.fetchval("INSERT INTO orders (customer_id, branch_id) VALUES ($1, $2) RETURNING id", w.customer, b)
    await raises(db.execute("UPDATE orders SET branch_id = (SELECT min(id) FROM customer_locations) WHERE id = $1", oid),
                 "order_identity_immutable")


async def test_m9_branch_purchaser_is_isolated_from_other_branches(db):
    w = await build(db)
    main = await db.fetchval("SELECT id FROM customer_locations WHERE customer_id = $1", w.customer)
    other = await new_branch(db, w)
    p = await purchaser(db, w, branch=main)
    await act(db, "customer", p)
    await raises(db.execute("INSERT INTO orders (customer_id, branch_id) VALUES ($1, $2)", w.customer, other),
                 "forbidden_branch")
    await act(db, "customer", w.cust_user)
    theirs = await db.fetchval("INSERT INTO orders (customer_id, branch_id) VALUES ($1, $2) RETURNING id",
                               w.customer, other)
    await act(db, "customer", p)
    await raises(db.execute("INSERT INTO order_items (order_id, catalog_item_id, qty) VALUES ($1, $2, 1)",
                            theirs, w.item), "forbidden_branch")
    await raises(db.execute("UPDATE orders SET status = 'cancelled' WHERE id = $1", theirs), "forbidden_branch")
    # ويطلب لفرعه بلا ذكره
    mine = await db.fetchval("INSERT INTO orders (customer_id) VALUES ($1) RETURNING branch_id", w.customer)
    assert mine == main


async def test_m9_every_ledger_entry_carries_the_branch(db):
    w = await build(db)
    oid = await draft(db, w)
    await place(db, w, oid)
    await confirm_and_assign(db, w, oid)
    await collect_all(db, w, oid)
    await deliver_in_one(db, w, oid)
    branch = await db.fetchval("SELECT branch_id FROM orders WHERE id = $1", oid)
    rows = await db.fetch("SELECT DISTINCT branch_id FROM ledger_transactions WHERE order_id = $1", oid)
    assert [r["branch_id"] for r in rows] == [branch]
    # حساب العميل على مستوى المنشأة: حساب واحد
    assert await db.fetchval("SELECT count(*) FROM ledger_accounts WHERE kind = 'customer_receivable' "
                             "AND customer_id = $1", w.customer) == 1


async def test_m9_recurring_lists_are_per_branch(db):
    w = await build(db)
    main = await db.fetchval("SELECT id FROM customer_locations WHERE customer_id = $1", w.customer)
    other = await new_branch(db, w)
    await act(db, "customer", w.cust_user)
    # فرعان: القائمة بلا فرع مرفوضة باسم الخطأ
    await raises(db.execute("INSERT INTO recurring_lists (customer_id, name, created_by) VALUES ($1, 'x', $2)",
                            w.customer, w.cust_user), "branch_required")
    await db.execute("INSERT INTO recurring_lists (customer_id, branch_id, name, created_by) "
                     "VALUES ($1, $2, 'طلب السبت', $3)", w.customer, main, w.cust_user)
    await db.execute("INSERT INTO recurring_lists (customer_id, branch_id, name, created_by) "
                     "VALUES ($1, $2, 'طلب السبت', $3)", w.customer, other, w.cust_user)
    assert await db.fetchval("SELECT count(DISTINCT branch_id) FROM recurring_lists") == 2


# ——— م-12 ————————————————————————————————————————————————————————————————
async def _stock(db, w):
    await act(db, "admin", w.owner)
    wh = await db.fetchval("INSERT INTO warehouses (city, name, lat, lng, address_text) "
                           "VALUES ('TIP', 'الظهرة', 32.89, 13.18, 'الظهرة') RETURNING id")
    for cost in ("10", "20"):
        await db.execute("INSERT INTO stock_movements (warehouse_id, catalog_item_id, kind, qty_delta, unit_cost) "
                         "VALUES ($1, $2, 'intake', 5, $3)", wh, w.item, Decimal(cost))
    return wh


async def _count_out(db, wh, item) -> tuple:
    return tuple(await db.fetchrow(
        "INSERT INTO stock_movements (warehouse_id, catalog_item_id, kind, qty_delta) VALUES ($1, $2, "
        "'count_adjust', -3) RETURNING round(unit_cost, 3) AS c, cost_method::text AS m", wh, item))


async def test_m12_average_then_fifo_from_its_date_without_recomputing(db):
    w = await build(db)
    wh = await _stock(db, w)
    first = await _count_out(db, wh, w.item)
    assert first == (Decimal("15.000"), "average")
    await db.execute("INSERT INTO cogs_method_periods (city, method) VALUES ('TIP', 'fifo')")
    second = await _count_out(db, wh, w.item)
    assert second == (Decimal("13.333"), "fifo")          # 2 × 10 + 1 × 20 (الأقدم أولاً)
    # الحركة الأولى باقية كما سُجّلت، والفترتان مسجّلتان بتاريخهما
    assert await db.fetchval("SELECT count(*) FROM stock_movements WHERE cost_method = 'average'") == 1
    assert [r["method"] for r in await db.fetch(
        "SELECT method::text FROM cogs_method_periods ORDER BY effective_from")] == ["average", "fifo"]


async def test_m12_method_is_admin_only_and_not_backdated(db):
    w = await build(db)
    await act(db, "customer", w.cust_user)
    await raises(db.execute("INSERT INTO cogs_method_periods (city, method) VALUES ('TIP', 'fifo')"), "forbidden_role")
    await act(db, "admin", w.owner)
    at = await db.fetchval("INSERT INTO cogs_method_periods (city, method, effective_from) "
                           "VALUES ('TIP', 'fifo', '2020-01-01') RETURNING effective_from")
    assert at.year >= 2026
    await raises(db.execute("UPDATE cogs_method_periods SET method = 'average'"), "append_only_update")


# ——— م-13 ————————————————————————————————————————————————————————————————
@pytest.mark.parametrize("capacity,over", [("4", True), ("10", False)])
async def test_m13_driver_sees_over_capacity(db, capacity, over):
    w = await build(db)
    await act(db, "admin", w.owner)
    await db.execute("UPDATE catalog_items SET weight_kg = 2.5 WHERE id = $1", w.item)
    await db.execute("UPDATE drivers SET capacity_kg = $1", Decimal(capacity))
    oid = await draft(db, w)                               # كمية 2 × 2.5 = 5 كغ
    await place(db, w, oid)
    await confirm_and_assign(db, w, oid)
    row = await db.fetchrow("SELECT load_kg, over_capacity FROM v_driver_orders WHERE id = $1", oid)
    assert (row["load_kg"], row["over_capacity"]) == (Decimal("5.0"), over)


# ——— م-15 ————————————————————————————————————————————————————————————————
async def test_m15_forbid_shows_the_available_limit(db):
    w = await build(db)
    await raises(draft(db, w, qty="150"), "qty_exceeds_available: 100")


async def test_m15_allow_places_and_notifies_owner_when_no_source_suffices(db):
    w = await build(db)
    await setting(db, w, oversell_policy="allow")
    oid = await draft(db, w, qty="150")
    await place(db, w, oid)
    await act(db, "admin", w.owner)
    await db.execute("UPDATE orders SET status = 'confirmed' WHERE id = $1", oid)
    assert not await db.fetchval("SELECT plan_complete FROM orders WHERE id = $1", oid)
    assert json.loads((await notes(db, "plan_short"))[0]["payload"]) == {"order_id": oid}


# ——— م-16 ————————————————————————————————————————————————————————————————
SQUARE = json.dumps([[32.8, 13.1], [32.8, 13.3], [33.0, 13.3], [33.0, 13.1]])   # يحوي فرع العالم (32.887, 13.191)


async def _by_zone(db, w, zone_fee: str | None, area_fee: str | None):
    await setting(db, w, fee_mode="by_zone")
    if zone_fee is not None:
        z = await db.fetchval("INSERT INTO delivery_zones (city, name_ar, fee) VALUES ('TIP', 'الأندلس', $1) "
                              "RETURNING id", Decimal(zone_fee))
        await db.execute("UPDATE customer_locations SET zone_id = $1", z)
    if area_fee is not None:
        await db.execute("INSERT INTO delivery_areas (city, name_ar, fee, polygon) VALUES ('TIP', 'غرب', $1, $2)",
                         Decimal(area_fee), SQUARE)


@pytest.mark.parametrize("zone,area,fee", [("10", None, "10"), (None, "15", "15"), ("12", "12", "12")])
async def test_m16_fee_from_neighborhood_or_drawn_area(db, zone, area, fee):
    w = await build(db)
    await _by_zone(db, w, zone, area)
    oid = await draft(db, w)
    await place(db, w, oid)
    assert await db.fetchval("SELECT delivery_fee FROM orders WHERE id = $1", oid) == Decimal(fee)


async def test_m16_conflict_stops_and_waits_for_the_owner(db):
    w = await build(db)
    await _by_zone(db, w, "10", "15")
    oid = await draft(db, w)
    await raises(place(db, w, oid), "zone_conflict")


async def test_m16_point_in_polygon_both_ways(db):
    await build(db)
    assert await db.fetchval("SELECT point_in_polygon(32.887, 13.191, $1::jsonb)", SQUARE)
    assert not await db.fetchval("SELECT point_in_polygon(32.5, 13.191, $1::jsonb)", SQUARE)


# ——— م-20 ————————————————————————————————————————————————————————————————
async def test_m20_owner_resets_from_panel_audited_and_forces_change(db):
    w = await build(db)
    await act(db, "system")
    await db.execute("UPDATE app_users SET phone_verified_at = now(), password_hash = $1 WHERE id = $2", BCRYPT, w.cust_user)
    await act(db, "admin", w.owner)
    await db.execute("UPDATE app_users SET password_hash = $1 WHERE id = $2", BCRYPT2, w.cust_user)
    assert await db.fetchval("SELECT must_change_password FROM app_users WHERE id = $1", w.cust_user)
    ev = await db.fetchrow("SELECT method::text, actor_id FROM password_reset_events WHERE user_id = $1", w.cust_user)
    assert tuple(ev) == ("admin", w.owner)
    assert await db.fetchval("SELECT count(*) FROM audit_log WHERE table_name = 'password_reset_events'") == 1
    assert "aaaa" not in await db.fetchval("SELECT string_agg(coalesce(after::text,''), '') FROM audit_log "
                                           "WHERE table_name = 'password_reset_events'")


async def test_m20_otp_reset_clears_the_forced_change_and_is_logged(db):
    w = await build(db)
    await act(db, "system")
    await db.execute("UPDATE app_users SET phone_verified_at = now(), password_hash = $1 WHERE id = $2", BCRYPT, w.cust_user)
    await db.execute("UPDATE app_users SET password_hash = $1 WHERE id = $2", BCRYPT2, w.cust_user)
    ev = await db.fetchval("SELECT method::text FROM password_reset_events WHERE user_id = $1", w.cust_user)
    assert ev == "otp"


async def test_m20_only_the_owner_resets(db):
    w = await build(db)
    await act(db, "system")
    await db.execute("UPDATE app_users SET phone_verified_at = now(), password_hash = $1 WHERE id = $2", BCRYPT, w.cust_user)
    sup = await db.fetchval("INSERT INTO app_users (phone, audience, full_name) VALUES ('+218910000011', 'admin', "
                            "'مشرف') RETURNING id")
    await db.execute("INSERT INTO admin_members (user_id, role) VALUES ($1, 'supervisor')", sup)
    await db.execute("INSERT INTO admin_permissions (user_id, permission) VALUES ($1, 'users')", sup)
    await act(db, "admin", sup)
    await raises(db.execute("UPDATE app_users SET password_hash = $1 WHERE id = $2", BCRYPT2, w.cust_user),
                 "forbidden_owner_only")
    await act(db, "customer", w.cust_user)
    await raises(db.execute("UPDATE app_users SET password_hash = $1 WHERE id = $2", BCRYPT2, w.cust_user),
                 "forbidden_role")


# ——— م-21 ————————————————————————————————————————————————————————————————
async def test_m21_withdrawal_is_a_ledger_entry_within_the_treasury(db):
    w = await build(db)
    await act(db, "admin", w.owner)
    ins = ("INSERT INTO owner_withdrawals (city, amount, occurred_on, note, created_by) "
           "VALUES ('TIP', $1, '2026-09-26', 'سحب', $2)")
    await raises(db.execute(ins, Decimal("100"), w.owner), "withdrawal_exceeds_treasury")
    await db.execute("INSERT INTO owner_capital_entries (city, kind, amount, occurred_on, note, created_by) "
                     "VALUES ('TIP', 'opening_cash', 1000, '2026-09-26', 'افتتاح', $1)", w.owner)
    await db.execute(ins, Decimal("300.250"), w.owner)
    assert await balance(db, "treasury") == Decimal("699.750")
    assert await balance(db, "owner_drawings") == Decimal("300.250")
    await raises(db.execute("DELETE FROM owner_withdrawals"), "append_only_delete")


async def test_m21_owner_only(db):
    w = await build(db)
    await act(db, "system")
    sup = await db.fetchval("INSERT INTO app_users (phone, audience, full_name) VALUES ('+218910000011', 'admin', "
                            "'مشرف') RETURNING id")
    await db.execute("INSERT INTO admin_members (user_id, role) VALUES ($1, 'supervisor')", sup)
    await db.execute("INSERT INTO admin_permissions (user_id, permission) VALUES ($1, 'money')", sup)
    await act(db, "admin", sup)
    await raises(db.execute("INSERT INTO owner_withdrawals (city, amount, occurred_on, note, created_by) "
                            "VALUES ('TIP', 1, '2026-09-26', 'x', $1)", sup), "forbidden_owner_only")


# ——— م-22 ————————————————————————————————————————————————————————————————
async def _collect_without_proof(db, w, oid):
    await act(db, "driver", w.drv_user)
    await db.execute("UPDATE orders SET status = 'collecting' WHERE id = $1", oid)
    stop = await db.fetchval("SELECT id FROM pickup_stops WHERE order_id = $1", oid)
    await db.execute("UPDATE pickup_stop_lines SET collected_qty = planned_qty WHERE stop_id = $1", stop)
    return db.execute("UPDATE pickup_stops SET status = 'collected' WHERE id = $1", stop)


async def test_m22_required_refuses_collection_without_proof(db):
    w = await build(db)
    oid = await draft(db, w)
    await place(db, w, oid)
    await confirm_and_assign(db, w, oid)
    await raises(await _collect_without_proof(db, w, oid), "pickup_proof_required")


async def test_m22_optional_allows_collection_without_proof(db):
    w = await build(db)
    await setting(db, w, pickup_proof_required=False)
    oid = await draft(db, w)
    await place(db, w, oid)
    await confirm_and_assign(db, w, oid)
    await (await _collect_without_proof(db, w, oid))


async def test_m22_setting_does_not_reach_an_existing_order(db):
    w = await build(db)
    oid = await draft(db, w)
    await place(db, w, oid)                               # لقطة: إلزامي
    await setting(db, w, pickup_proof_required=False)
    await confirm_and_assign(db, w, oid)
    await raises(await _collect_without_proof(db, w, oid), "pickup_proof_required")


# ——— م-24 ————————————————————————————————————————————————————————————————
async def test_m24_owner_orders_channels_and_sms_stays_last(db):
    w = await build(db)
    await act(db, "admin", w.owner)
    async with db.transaction():
        await db.execute("UPDATE otp_channels SET position = 1 WHERE channel = 'whatsapp_linked'")
        await db.execute("UPDATE otp_channels SET position = 2 WHERE channel = 'whatsapp_official'")
    await db.execute("UPDATE otp_channels SET enabled = false WHERE channel = 'whatsapp_official'")
    with pytest.raises(asyncpg.PostgresError) as e:
        async with db.transaction():
            await db.execute("UPDATE otp_channels SET position = 1 WHERE channel = 'sms'")
            await db.execute("UPDATE otp_channels SET position = 3 WHERE channel = 'whatsapp_linked'")
    assert "sms_must_be_last" in str(e.value)
    await raises(db.execute("DELETE FROM otp_channels WHERE channel = 'sms'"), "otp_channels_fixed")
    assert await db.fetchval("SELECT count(*) FROM audit_log WHERE table_name = 'otp_channels'") >= 3


async def test_m24_failed_channel_notifies_owner(db):
    w = await build(db)
    await act(db, "system")
    ch = await db.fetchval("INSERT INTO otp_challenges (phone, audience, code_hash, expires_at, channel) VALUES "
                           "('+218920000001', 'customer', 'x', now() + interval '5 min', 'whatsapp_official') RETURNING id")
    await db.execute("INSERT INTO otp_deliveries (challenge_id, channel, ok) VALUES ($1, 'whatsapp_official', true)", ch)
    assert await notes(db, "otp_channel_failed") == []
    await db.execute("INSERT INTO otp_deliveries (challenge_id, channel, ok, error) VALUES ($1, 'whatsapp_linked', "
                     "false, 'number_blocked')", ch)
    assert [n["user_id"] for n in await notes(db, "otp_channel_failed")] == [w.owner]
