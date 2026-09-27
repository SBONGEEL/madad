"""الترحيلة 0014 — العناصر السبعة (§12-ط)، كل قاعدة في الاتجاهين."""
from __future__ import annotations

from datetime import date, timedelta
from decimal import Decimal

import asyncpg
import pytest

from tests.db.world import act, build, collect_all, confirm_and_assign, draft, place


async def raises(coro, needle):
    with pytest.raises(asyncpg.PostgresError) as e:
        await coro
    assert needle in str(e.value), str(e.value)


async def _out_of_stock(db, w):
    await act(db, "supplier", w.sup_user)
    await db.execute("UPDATE supplier_offers SET reported_qty = 0 WHERE id = $1", w.offer)
    assert not await db.fetchval("SELECT is_available FROM catalog_items WHERE id = $1", w.item)


# ——— ١) نبّهني حين يتوفر ————————————————————————————————————————————————————————
async def test_alert_only_on_out_of_stock_item(db):
    w = await build(db)
    await act(db, "customer", w.cust_user)
    await raises(db.execute("INSERT INTO stock_alerts (user_id, catalog_item_id) VALUES ($1, $2)", w.cust_user, w.item),
                 "alert_item_available")
    await _out_of_stock(db, w)
    await act(db, "customer", w.cust_user)
    await db.execute("INSERT INTO stock_alerts (user_id, catalog_item_id) VALUES ($1, $2)", w.cust_user, w.item)
    assert await db.fetchval("SELECT count(*) FROM stock_alerts") == 1


async def test_alert_is_the_customers_own(db):
    w = await build(db)
    await _out_of_stock(db, w)
    await act(db, "customer", w.cust_user)
    await raises(db.execute("INSERT INTO stock_alerts (user_id, catalog_item_id) VALUES ($1, $2)", w.drv_user, w.item),
                 "an alert is the customer's own")


async def test_back_in_stock_notifies_once_then_alert_is_gone(db):
    w = await build(db)
    await _out_of_stock(db, w)
    await act(db, "customer", w.cust_user)
    await db.execute("INSERT INTO stock_alerts (user_id, catalog_item_id) VALUES ($1, $2)", w.cust_user, w.item)
    await act(db, "supplier", w.sup_user)
    await db.execute("UPDATE supplier_offers SET reported_qty = 50 WHERE id = $1", w.offer)
    rows = await db.fetch("SELECT user_id, title FROM notifications WHERE kind = 'back_in_stock'")
    assert [(r["user_id"], r["title"]) for r in rows] == [(w.cust_user, "عاد «طماطم» متاحاً")]
    assert await db.fetchval("SELECT count(*) FROM stock_alerts") == 0
    await db.execute("UPDATE supplier_offers SET reported_qty = 0 WHERE id = $1", w.offer)
    await db.execute("UPDATE supplier_offers SET reported_qty = 60 WHERE id = $1", w.offer)
    assert await db.fetchval("SELECT count(*) FROM notifications WHERE kind = 'back_in_stock'") == 1


# ——— ٢) الإلغاء حسب م-7 والحالة ————————————————————————————————————————————————
async def test_customer_can_cancel_follows_policy_and_status(db):
    w = await build(db)
    oid = await draft(db, w)
    await place(db, w, oid)
    assert await db.fetchval("SELECT customer_can_cancel($1)", oid) is True
    await confirm_and_assign(db, w, oid)
    policy = await db.fetchval("SELECT cancel_policy::text FROM orders WHERE id = $1", oid)
    expected = policy in ("until_collecting", "anytime")
    assert await db.fetchval("SELECT customer_can_cancel($1)", oid) is expected
    await collect_all(db, w, oid)
    assert await db.fetchval("SELECT customer_can_cancel($1)", oid) is (policy == "anytime")


async def test_policy_snapshot_decides_not_todays_setting(db):
    w = await build(db)
    oid = await draft(db, w)
    await place(db, w, oid)
    await confirm_and_assign(db, w, oid)
    before = await db.fetchval("SELECT customer_can_cancel($1)", oid)
    await act(db, "admin", w.owner)
    await db.execute("UPDATE city_settings SET cancel_policy = 'anytime'")
    assert await db.fetchval("SELECT customer_can_cancel($1)", oid) is before


# ——— ٣) رقم التواصل ————————————————————————————————————————————————————————————
async def test_contact_numbers_are_the_owners_setting(db):
    w = await build(db)
    await act(db, "admin", w.owner)
    await db.execute("UPDATE city_settings SET contact_phone = '+218921112233', contact_whatsapp = '+218921112234'")
    await raises(db.execute("UPDATE city_settings SET contact_phone = '0921112233'"), "contact_phone")
    await act(db, "customer", w.cust_user)
    await raises(db.execute("UPDATE city_settings SET contact_phone = '+218921112299'"), "")
    assert await db.fetchval("SELECT count(*) FROM audit_log WHERE table_name = 'city_settings'") >= 1


# ——— ٤) المستلم ——————————————————————————————————————————————————————————————————
async def test_branch_default_recipient_is_snapshotted_at_placement(db):
    w = await build(db)
    await act(db, "customer", w.cust_user)
    await db.execute("UPDATE customer_locations SET default_recipient = 'سالم' WHERE customer_id = $1", w.customer)
    assert await db.fetchval("SELECT status::text FROM customer_locations WHERE customer_id = $1", w.customer) == "approved"
    a = await draft(db, w)
    await place(db, w, a)
    assert await db.fetchval("SELECT recipient_name FROM orders WHERE id = $1", a) == "سالم"
    b = await draft(db, w)
    await act(db, "customer", w.cust_user)
    await db.execute("UPDATE orders SET recipient_name = 'علي' WHERE id = $1", b)
    await place(db, w, b)
    assert await db.fetchval("SELECT recipient_name FROM orders WHERE id = $1", b) == "علي"
    await confirm_and_assign(db, w, b)
    assert await db.fetchval("SELECT recipient_name FROM v_driver_orders WHERE id = $1", b) == "علي"


# ——— ٥) التوفر ————————————————————————————————————————————————————————————————————
async def _confirmed(db, w):
    oid = await draft(db, w)
    await place(db, w, oid)
    await act(db, "admin", w.owner)
    await db.execute("UPDATE orders SET status = 'confirmed', route_km = 10 WHERE id = $1", oid)
    return oid


async def test_unavailable_driver_sees_nothing_and_cannot_self_assign(db):
    w = await build(db)
    oid = await _confirmed(db, w)
    await act(db, "driver", w.drv_user)
    assert await db.fetchval("SELECT count(*) FROM v_driver_available") == 1
    await db.execute("UPDATE drivers SET accepting = false WHERE user_id = $1", w.drv_user)
    assert await db.fetchval("SELECT count(*) FROM v_driver_available") == 0
    await raises(db.execute("UPDATE orders SET driver_id = $2, status = 'assigned' WHERE id = $1", oid, w.driver),
                 "driver_unavailable")
    await raises(db.execute("INSERT INTO driver_pay_offers (order_id, driver_id, amount) VALUES ($1, $2, 20)", oid, w.driver),
                 "driver_unavailable")


async def test_owner_may_still_assign_an_unavailable_driver(db):
    w = await build(db)
    oid = await _confirmed(db, w)
    await act(db, "driver", w.drv_user)
    await db.execute("UPDATE drivers SET accepting = false WHERE user_id = $1", w.drv_user)
    await act(db, "admin", w.owner)
    await db.execute("UPDATE orders SET driver_id = $2, status = 'assigned' WHERE id = $1", oid, w.driver)
    assert await db.fetchval("SELECT status::text FROM orders WHERE id = $1", oid) == "assigned"


async def test_driver_changes_only_his_own_availability(db):
    w = await build(db)
    await act(db, "driver", w.drv_user)
    await raises(db.execute("UPDATE drivers SET capacity_kg = 900 WHERE user_id = $1", w.drv_user), "changes only his availability")
    await act(db, "system")
    other = await db.fetchval("INSERT INTO app_users (phone, audience, full_name) VALUES ('+218910000049', 'driver', 'آ') RETURNING id")
    await act(db, "driver", other)
    await raises(db.execute("UPDATE drivers SET accepting = false WHERE id = $1", w.driver), "not your driver profile")


# ——— ٦) الموعد والوصول ——————————————————————————————————————————————————————————————
async def test_driver_sets_eta_and_arrival_once_supplier_sees_it(db):
    w = await build(db)
    oid = await draft(db, w)
    await place(db, w, oid)
    await confirm_and_assign(db, w, oid)
    stop = await db.fetchval("SELECT id FROM pickup_stops WHERE order_id = $1", oid)
    await act(db, "driver", w.drv_user)
    await db.execute("UPDATE orders SET status = 'collecting' WHERE id = $1", oid)
    await db.execute("UPDATE pickup_stops SET eta_at = now() + interval '30 minutes' WHERE id = $1", stop)
    await db.execute("UPDATE pickup_stops SET arrived_at = '2000-01-01' WHERE id = $1", stop)   # الوقت من القاعدة
    arrived = await db.fetchval("SELECT arrived_at FROM pickup_stops WHERE id = $1", stop)
    assert arrived.year > 2000
    await raises(db.execute("UPDATE pickup_stops SET arrived_at = now() WHERE id = $1", stop), "stop_already_arrived")
    await act(db, "supplier", w.sup_user)
    row = await db.fetchrow("SELECT eta_at, arrived_at FROM v_supplier_pickups WHERE id = $1", stop)
    assert row["eta_at"] is not None and row["arrived_at"] == arrived


async def test_only_the_assigned_driver_sets_eta(db):
    w = await build(db)
    oid = await draft(db, w)
    await place(db, w, oid)
    await confirm_and_assign(db, w, oid)
    stop = await db.fetchval("SELECT id FROM pickup_stops WHERE order_id = $1", oid)
    await act(db, "supplier", w.sup_user)
    await raises(db.execute("UPDATE pickup_stops SET eta_at = now() WHERE id = $1", stop), "forbidden")
    await act(db, "system")
    other = await db.fetchval("INSERT INTO app_users (phone, audience, full_name) VALUES ('+218910000047', 'driver', 'آ') RETURNING id")
    await act(db, "driver", w.drv_user)
    await db.execute("UPDATE orders SET status = 'collecting' WHERE id = $1", oid)
    await act(db, "driver", other)
    await raises(db.execute("UPDATE pickup_stops SET eta_at = now() WHERE id = $1", stop), "forbidden")


# ——— ٧) الصرف القادم ————————————————————————————————————————————————————————————————
async def test_supplier_next_payout_from_cycle_and_last_payout(db):
    w = await build(db)                                      # weekly
    approved = await db.fetchval("SELECT reviewed_at::date FROM suppliers WHERE id = $1", w.supplier)
    assert await db.fetchval("SELECT supplier_next_payout($1)", w.supplier) == approved + timedelta(days=7)
    await act(db, "admin", w.owner)
    await db.execute("INSERT INTO owner_capital_entries (city, kind, amount, occurred_on, note, created_by) "
                     "VALUES ('TIP', 'opening_cash', 5000, $2, 'افتتاح', $1)", w.owner, date.today())
    await db.execute("UPDATE suppliers SET payout_cycle = 'monthly' WHERE id = $1", w.supplier)
    nxt = await db.fetchval("SELECT supplier_next_payout($1)", w.supplier)
    assert nxt.month == (approved.month % 12) + 1 or nxt.year > approved.year
    assert Decimal(1)  # يُبقي الاستيراد


async def test_supplier_without_cycle_has_no_next_payout(db):
    w = await build(db)
    await act(db, "system")
    sid = await db.fetchval("INSERT INTO suppliers (city, name, contact_name, phone, owner_id_media_id) "
                            "VALUES ('TIP', 'م', 'س', '+218910000048', $1) RETURNING id", w.media)
    assert await db.fetchval("SELECT supplier_next_payout($1)", sid) is None
