"""اللوحة — الكتالوج والتسعير والموردون والتصنيفات، على السلك.

حارس التسرّب لهذه النقاط (شرط الاستثناء 3): test_admin_guards — الصلاحية المعلنة والرفض بدونها،
والتكاليف المحجوبة عمّن لا يملك «التكاليف» مع شاهد المالك. وهنا سلوكها في الاتجاهين.
"""
from __future__ import annotations

from decimal import Decimal

from tests.api.test_admin_guards import SUP_ALL, supervisors
from tests.api.world_api import live_world
from tests.db.world import MARGIN_CANARY, act


async def test_catalog_lists_items_with_costs_for_owner_only(db, client):
    live = await live_world(db, client)
    sup = (await supervisors(db, client))[SUP_ALL]
    owner = (await client.get("/api/admin/catalog", headers=live.auth("admin"))).json()
    assert owner[0]["margin_value"] == str(MARGIN_CANARY) and owner[0]["mode"] == "margin_pct"
    hidden = (await client.get("/api/admin/catalog", headers=sup)).json()
    assert hidden[0]["id"] == live.w.item
    assert not {"margin_value", "cost_ref", "mode"} & set(hidden[0]), hidden[0]   # غائبة لا null


async def test_item_pricing_history_hides_purchases_without_costs(db, client):
    live = await live_world(db, client)
    sup = (await supervisors(db, client))[SUP_ALL]
    await act(db, "supplier", live.w.sup_user)
    await db.execute("UPDATE supplier_offers SET purchase_price = 780 WHERE id = $1", live.w.offer)
    url = f"/api/admin/catalog/{live.w.item}"
    owner = (await client.get(url, headers=live.auth("admin"))).json()
    assert any(h["kind"] == "purchase" for h in owner["history"]) and owner["item"]["needs_review"] is True
    s = (await client.get(url, headers=sup)).json()
    assert all(h["kind"] == "sale" for h in s["history"])
    assert all("purchase_price" not in x for x in s["sources_detail"])


async def test_pricing_needs_costs_permission_and_reprices(db, client):
    live = await live_world(db, client)
    sup = (await supervisors(db, client))[SUP_ALL]
    url = f"/api/admin/catalog/{live.w.item}/pricing"
    body = {"mode": "manual", "manual_price": "950.000"}
    assert (await client.put(url, headers=sup, json=body)).status_code == 403
    r = await client.put(url, headers=live.auth("admin"), json=body)
    assert r.status_code == 200, r.text
    assert r.json()["item"]["sale_price"] == "950.000"


async def test_hiding_an_item_removes_it_from_the_customer_catalog(db, client):
    live = await live_world(db, client)
    r = await client.patch(f"/api/admin/catalog/{live.w.item}", headers=live.auth("admin"), json={"visibility": "hidden"})
    assert r.status_code == 200 and r.json()["visibility"] == "hidden"
    cat = (await client.get("/api/customer/catalog", headers=live.auth("customer"))).json()
    assert all(i["id"] != live.w.item for i in cat)


async def test_categories_tree_and_new_subcategory(db, client):
    live = await live_world(db, client)
    tree = (await client.get("/api/admin/categories", headers=live.auth("admin"))).json()
    food = next(c for c in tree if c["icon_key"] == "food" and c["children"])
    assert any(k["name_ar"] == "خضار وفواكه" for k in food["children"])
    r = await client.post("/api/admin/categories", headers=live.auth("admin"),
                          json={"parent_id": food["id"], "name_ar": "بهارات", "name_en": "Spices"})
    assert r.status_code == 201, r.text


async def test_supplier_proposal_is_approved_from_the_panel(db, client):
    live = await live_world(db, client)
    await act(db, "supplier", live.w.sup_user)
    pid = await db.fetchval("INSERT INTO products (name_ar, category_id, status, proposed_by_supplier_id) "
                            "VALUES ('فلفل ملوّن', $1, 'proposed', $2) RETURNING id", live.w.category, live.w.supplier)
    lst = (await client.get("/api/admin/proposals", headers=live.auth("admin"))).json()
    assert [x["id"] for x in lst] == [pid]
    r = await client.post(f"/api/admin/proposals/{pid}", headers=live.auth("admin"), json={"decision": "approve"})
    assert r.status_code == 200 and r.json() == []
    assert await db.fetchval("SELECT status::text FROM products WHERE id = $1", pid) == "approved"


async def test_supplier_offers_and_comparison(db, client):
    live = await live_world(db, client)
    sup = (await supervisors(db, client))[SUP_ALL]
    d = (await client.get(f"/api/admin/suppliers/{live.w.supplier}", headers=live.auth("admin"))).json()
    assert d["offers"][0]["purchase_price"] == "777.770"
    cmp_owner = (await client.get(f"/api/admin/products/{live.w.product}/offers", headers=live.auth("admin"))).json()
    cmp_sup = (await client.get(f"/api/admin/products/{live.w.product}/offers", headers=sup)).json()
    assert cmp_owner[0]["in_catalog"] is True and "purchase_price" in cmp_owner[0]
    assert "purchase_price" not in cmp_sup[0]
    assert Decimal(cmp_owner[0]["available_qty"]) >= 0
