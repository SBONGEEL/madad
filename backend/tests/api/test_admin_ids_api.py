"""معرّفات تحتاجها شاشات اللوحة لتربط الأسطر بمصادرها بلا مطابقة بالاسم، وبحث القاموس.

حارس التسرّب لنقطة /api/admin/products (شرط الاستثناء 3): test_admin_guards (الصلاحية معلنة، ومشرف
بلا «الكتالوج» مرفوض، ولا تكلفة فيها لمشرف بلا «التكاليف») — وهذا الملف يثبت أنها لا تحمل سعر شراء.
"""
from __future__ import annotations

from tests.api.admin_cases import _dispute
from tests.api.test_admin_batch3_api import _custody
from tests.api.world_api import live_world
from tests.db.world import PURCHASE_CANARY


async def test_products_search_finds_dictionary_items_without_prices(db, client):
    live = await live_world(db, client)
    r = await client.get("/api/admin/products?q=طما", headers=live.auth("admin"))
    assert r.status_code == 200
    row = r.json()[0]
    assert (row["id"], row["name_ar"], row["offers"], row["in_catalog"]) == (live.w.product, "طماطم", 1, True)
    assert str(PURCHASE_CANARY) not in r.text
    assert (await client.get("/api/admin/products?q=لا-يوجد", headers=live.auth("admin"))).json() == []


async def test_catalog_and_offers_carry_product_id_and_item_overrides(db, client):
    live = await live_world(db, client)
    row = (await client.get("/api/admin/catalog", headers=live.auth("admin"))).json()[0]
    assert row["product_id"] == live.w.product
    assert row["reprice_override"] is None and row["cost_basis_override"] is None
    sup = (await client.get(f"/api/admin/suppliers/{live.w.supplier}", headers=live.auth("admin"))).json()
    assert sup["offers"][0]["product_id"] == live.w.product


async def test_order_and_plan_lines_carry_their_ids(db, client):
    live = await live_world(db, client)
    d = (await client.get(f"/api/admin/orders/{live.order}", headers=live.auth("admin"))).json()
    assert d["lines"][0]["catalog_item_id"] == live.w.item and d["driver_id"] == live.w.driver
    plan = (await client.get(f"/api/admin/orders/{live.order}/plan", headers=live.auth("admin"))).json()
    line = plan["stops"][0]["lines"][0]
    assert line["order_item_id"] == d["lines"][0]["id"] and line["offer_id"] == live.w.offer
    assert line["warehouse_id"] is None


async def test_dispute_and_custody_name_their_parties(db, client):
    w, oid, tok = await _custody(db, client)
    h = {"Authorization": f"Bearer {tok}"}
    c = (await client.get("/api/admin/custody", headers=h)).json()[0]
    assert c["source_kind"] == "supplier"
    d = (await client.get(f"/api/admin/disputes/{c['dispute_id']}", headers=h)).json()
    assert (d["order_item_id"], d["supplier_id"], d["driver_id"]) == (None, None, w.driver)   # نزاع الطلبية كلها


async def test_item_dispute_names_its_supplier(db, client):
    live = await live_world(db, client)
    did = await _dispute(db, live)
    d = (await client.get(f"/api/admin/disputes/{did}", headers=live.auth("admin"))).json()
    assert d["order_item_id"] is not None and (d["supplier_id"], d["driver_id"]) == (live.w.supplier, live.w.driver)
