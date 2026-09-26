"""عالم اختبار صغير: مالك، عميل، مورد، سائق، صنف واحد — مبنيّ عبر المسارات
الحقيقية (أدوار الفاعل والمشغّلات)، لا بإدخال مباشر يتخطّاها.

الشواهد: كل ما يجب ألا يخرج من اللوحة يحمل قيمة مميّزة يُبحث عنها نصّاً.
"""
from __future__ import annotations

from dataclasses import dataclass
from decimal import Decimal

import asyncpg

PURCHASE_CANARY = Decimal("777.77")
MARGIN_CANARY = Decimal("17.17")          # هامش %
SALE_PRICE = Decimal("911.313")           # round(777.77 × 1.1717, 3) — M-1
SUPPLIER_CANARY = "SUPPLIER_LEAK_CANARY"
CUSTOMER_CANARY = "CUSTOMER_LEAK_CANARY"
ADDRESS_CANARY = "ADDRESS_LEAK_CANARY"


async def act(c: asyncpg.Connection, role: str, uid: int | None = None) -> None:
    await c.execute(
        "SELECT set_config('madad.actor_role', $1, false), set_config('madad.actor_id', $2, false)",
        role, "" if uid is None else str(uid))


@dataclass
class World:
    owner: int
    cust_user: int
    customer: int
    sup_user: int
    supplier: int
    location: int
    drv_user: int
    driver: int
    media: int
    category: int
    product: int
    offer: int
    item: int


async def build(c: asyncpg.Connection, *, settings: bool = True) -> World:
    await act(c, "system")
    owner = await c.fetchval("INSERT INTO app_users (phone, audience, full_name) "
                             "VALUES ('+218910000001', 'admin', 'المالك') RETURNING id")
    await c.execute("INSERT INTO admin_members (user_id, role) VALUES ($1, 'owner')", owner)
    media = await c.fetchval("INSERT INTO media_files (storage_key, mime_type, byte_size, sha256, is_private) "
                             "VALUES ('m/1.jpg', 'image/jpeg', 100, repeat('a', 64), false) RETURNING id")

    # العميل يسجّل نفسه، والمالك يعتمده
    cust_user = await c.fetchval("INSERT INTO app_users (phone, audience, full_name) "
                                 "VALUES ('+218910000002', 'customer', 'صاحب المطعم') RETURNING id")
    await act(c, "customer", cust_user)
    customer = await c.fetchval(
        "INSERT INTO customers (city, name, kind, contact_name, phone, facade_media_id) "
        "VALUES ('TIP', $1, 'restaurant', 'علي', '+218910000002', $2) RETURNING id", CUSTOMER_CANARY, media)
    await c.execute("INSERT INTO customer_members (customer_id, user_id, role) VALUES ($1, $2, 'owner')",
                    customer, cust_user)
    await c.execute("INSERT INTO customer_locations (customer_id, city, lat, lng, address_text) "
                    "VALUES ($1, 'TIP', 32.887, 13.191, $2)", customer, ADDRESS_CANARY)

    sup_user = await c.fetchval("INSERT INTO app_users (phone, audience, full_name) "
                                "VALUES ('+218910000003', 'supplier', 'المورد') RETURNING id")
    supplier = await c.fetchval(
        "INSERT INTO suppliers (city, name, contact_name, phone, owner_id_media_id) "
        "VALUES ('TIP', $1, 'سالم', '+218910000003', $2) RETURNING id", SUPPLIER_CANARY, media)
    await c.execute("INSERT INTO supplier_members (supplier_id, user_id) VALUES ($1, $2)", supplier, sup_user)
    location = await c.fetchval(
        "INSERT INTO supplier_pickup_locations (supplier_id, city, label, lat, lng, address_text) "
        "VALUES ($1, 'TIP', 'المخزن الرئيسي', 32.85, 13.10, 'سوق الثلاثاء') RETURNING id", supplier)

    drv_user = await c.fetchval("INSERT INTO app_users (phone, audience, full_name) "
                                "VALUES ('+218910000004', 'driver', 'السائق') RETURNING id")
    driver = await c.fetchval(
        "INSERT INTO drivers (user_id, city, full_name, phone, id_media_id, license_media_id, photo_media_id, vehicle) "
        "VALUES ($1, 'TIP', 'السائق', '+218910000004', $2, $2, $2, 'van') RETURNING id", drv_user, media)

    await act(c, "admin", owner)
    await c.execute("UPDATE drivers SET pay_method = 'periodic'")  # M-11: استثناء معلن §11.3
    for table in ("customers", "drivers"):
        await c.execute(f"UPDATE {table} SET status = 'approved', reviewed_by = $1, reviewed_at = now()", owner)
    await c.execute("UPDATE suppliers SET status = 'approved', payout_cycle = 'weekly', reviewed_by = $1, "
                    "reviewed_at = now()", owner)
    if settings:
        await c.execute("""UPDATE city_settings SET min_order_decided = true, min_order_amount = 100,
                           fee_mode = 'flat', delivery_fee_flat = 10, oos_policy = 'auto_hide',
                           driver_pay_base = 5, driver_pay_per_stop = 2, driver_pay_per_km = 0.5,
                           driver_cash_cap = 5000 WHERE city = 'TIP'""")

    category = await c.fetchval("INSERT INTO categories (name_ar, name_en, icon_key) "
                                "VALUES ('مواد غذائية', 'Food', 'food') RETURNING id")
    product = await c.fetchval("INSERT INTO products (name_ar, category_id, status) "
                               "VALUES ('طماطم', $1, 'approved') RETURNING id", category)

    await act(c, "supplier", sup_user)
    offer = await c.fetchval(
        "INSERT INTO supplier_offers (supplier_id, product_id, unit, unit_size, purchase_price, reported_qty, "
        "pickup_location_id) VALUES ($1, $2, 'kg', 1, $3, 100, $4) RETURNING id",
        supplier, product, PURCHASE_CANARY, location)

    await act(c, "admin", owner)
    item = await c.fetchval("INSERT INTO catalog_items (city, product_id, category_id, name_ar, unit, unit_size) "
                            "VALUES ('TIP', $1, $2, 'طماطم', 'kg', 1) RETURNING id", product, category)
    await c.execute("INSERT INTO catalog_item_sources (catalog_item_id, offer_id, priority) VALUES ($1, $2, 1)",
                    item, offer)
    await c.execute("INSERT INTO catalog_item_pricing (catalog_item_id, mode, margin_value) "
                    "VALUES ($1, 'margin_pct', $2)", item, MARGIN_CANARY)
    await c.execute("UPDATE catalog_items SET visibility = 'visible' WHERE id = $1", item)
    return World(owner, cust_user, customer, sup_user, supplier, location, drv_user, driver, media,
                 category, product, offer, item)


async def draft(c: asyncpg.Connection, w: World, qty: str = "2") -> int:
    await act(c, "customer", w.cust_user)
    oid = await c.fetchval("INSERT INTO orders (customer_id) VALUES ($1) RETURNING id", w.customer)
    await c.execute("INSERT INTO order_items (order_id, catalog_item_id, qty) VALUES ($1, $2, $3)",
                    oid, w.item, Decimal(qty))
    return oid


async def place(c: asyncpg.Connection, w: World, oid: int) -> None:
    await act(c, "customer", w.cust_user)
    await c.execute("UPDATE orders SET status = 'placed' WHERE id = $1", oid)


async def confirm_and_assign(c: asyncpg.Connection, w: World, oid: int, km: str = "10") -> None:
    await act(c, "admin", w.owner)
    await c.execute("UPDATE orders SET status = 'confirmed' WHERE id = $1", oid)
    await c.execute("UPDATE orders SET route_km = $2 WHERE id = $1", oid, Decimal(km))
    await c.execute("UPDATE orders SET status = 'assigned', driver_id = $2 WHERE id = $1", oid, w.driver)


async def collect_all(c: asyncpg.Connection, w: World, oid: int) -> None:
    await act(c, "driver", w.drv_user)
    await c.execute("UPDATE orders SET status = 'collecting' WHERE id = $1", oid)
    for stop in await c.fetch("SELECT id FROM pickup_stops WHERE order_id = $1 AND status = 'pending'", oid):
        await c.execute("UPDATE pickup_stop_lines SET collected_qty = planned_qty WHERE stop_id = $1", stop["id"])
        await c.execute("UPDATE pickup_stops SET status = 'collected' WHERE id = $1", stop["id"])


async def deliver_in_one(c: asyncpg.Connection, w: World, oid: int) -> int:
    await act(c, "driver", w.drv_user)
    bid = await c.fetchval("INSERT INTO order_batches (order_id, seq) VALUES ($1, 1) RETURNING id", oid)
    await c.execute("INSERT INTO order_batch_lines (batch_id, order_item_id, qty) "
                    "SELECT $1, id, qty FROM order_items WHERE order_id = $2", bid, oid)
    for st in ("notified", "departed", "delivered"):
        await c.execute("UPDATE order_batches SET status = $2 WHERE id = $1", bid, st)
    return bid


async def balance(c: asyncpg.Connection, kind: str, party: int | None = None) -> Decimal:
    return await c.fetchval("SELECT ledger_balance($1::ledger_account_kind, 'TIP', $2)", kind, party)
