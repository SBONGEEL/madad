"""تطبيق المورد على السلك (الجزء 12)، وحرّاس الترحيلة 0010 — كل قاعدة في الاتجاهين.

حارس التسرّب لنقاطه (شرط الاستثناء 3): test_leak_responses بحالاتها في audience_cases.py، وtest_leak_openapi،
وtest_audience_cases — وهنا ما يخصّ كل نقطة، ومنه أن المورد لا يرى مورداً آخر.
"""
from __future__ import annotations

import asyncpg
import pytest

from tests.api.world_api import PASSWORD, live_world, login, set_passwords
from tests.db.world import act, build, collect_all, confirm_and_assign, draft, place

H = lambda tok: {"Authorization": f"Bearer {tok}"}  # noqa: E731
JPEG = b"\xff\xd8\xff\xe0" + b"0" * 64


async def _world(db, client):
    w = await build(db)
    await set_passwords(db)
    return w, (await login(client, "supplier"))["access_token"]


async def _second_supplier(db, w, phone="+218910000031") -> int:
    await act(db, "system")
    uid = await db.fetchval("INSERT INTO app_users (phone, audience, full_name) VALUES ($1, 'supplier', 'آخر') RETURNING id", phone)
    sid = await db.fetchval("INSERT INTO suppliers (city, name, contact_name, phone, owner_id_media_id) "
                            "VALUES ('TIP', 'مورد آخر', 'ع', $1, $2) RETURNING id", phone, w.media)
    await db.execute("INSERT INTO supplier_members (supplier_id, user_id) VALUES ($1, $2)", sid, uid)
    loc = await db.fetchval("INSERT INTO supplier_pickup_locations (supplier_id, city, label, lat, lng, address_text) "
                            "VALUES ($1, 'TIP', 'مخزنه', 32.8, 13.1, 'س') RETURNING id", sid)
    await act(db, "admin", w.owner)
    await db.execute("UPDATE suppliers SET status = 'approved', payout_cycle = 'weekly', reviewed_by = $1, reviewed_at = now() "
                     "WHERE id = $2", w.owner, sid)
    await act(db, "supplier", uid)
    await db.execute("INSERT INTO supplier_offers (supplier_id, product_id, unit, unit_size, purchase_price, reported_qty, "
                     "pickup_location_id) VALUES ($1, $2, 'kg', 1, 5.5, 10, $3)", sid, w.product, loc)
    return sid


# ——— العروض ——————————————————————————————————————————————————————————————————————
async def test_offers_are_own_only_with_previous_price(db, client):
    w, tok = await _world(db, client)
    await _second_supplier(db, w)
    r = (await client.get("/api/supplier/offers", headers=H(tok))).json()
    assert [o["id"] for o in r] == [w.offer] and r[0]["previous_price"] is None
    p = (await client.patch(f"/api/supplier/offers/{w.offer}", headers=H(tok), json={"purchase_price": "780"})).json()
    assert p[0]["purchase_price"] == "780.000" and p[0]["previous_price"] == "777.770"


async def test_offer_of_another_supplier_is_not_found(db, client):
    w, tok = await _world(db, client)
    await _second_supplier(db, w)
    other = await db.fetchval("SELECT id FROM supplier_offers WHERE supplier_id <> $1", w.supplier)
    r = await client.patch(f"/api/supplier/offers/{other}", headers=H(tok), json={"active": False})
    assert r.status_code == 404 and r.json()["code"] == "offer_not_found"


async def test_add_pause_and_resume_offer(db, client):
    w, tok = await _world(db, client)
    body = {"product_id": w.product, "unit": "carton", "unit_size": "12", "purchase_price": "50.125",
            "reported_qty": "5", "pickup_location_id": w.location, "active": False}
    r = await client.post("/api/supplier/offers", headers=H(tok), json=body)
    assert r.status_code == 201 and {o["status"] for o in r.json()} == {"active", "paused"}
    bad = await client.post("/api/supplier/offers", headers=H(tok), json={**body, "purchase_price": "1.2345"})
    assert bad.status_code == 422                         # م-1: ثلاث خانات
    new = next(o for o in r.json() if o["unit"] == "carton")
    on = (await client.patch(f"/api/supplier/offers/{new['id']}", headers=H(tok), json={"active": True})).json()
    assert next(o for o in on if o["id"] == new["id"])["status"] == "active"


async def test_offer_on_another_suppliers_location_is_refused(db, client):
    w, tok = await _world(db, client)
    await _second_supplier(db, w)
    theirs = await db.fetchval("SELECT id FROM supplier_pickup_locations WHERE supplier_id <> $1", w.supplier)
    r = await client.post("/api/supplier/offers", headers=H(tok), json={
        "product_id": w.product, "unit": "bag", "unit_size": "1", "purchase_price": "5", "reported_qty": "1",
        "pickup_location_id": theirs})
    assert r.status_code == 409                           # المفتاح المركّب: الموقع من مواقعه هو


async def test_offer_photo_is_public_and_own(db, client, app):
    w, tok = await _world(db, client)
    mid = (await client.post("/api/supplier/media", headers=H(tok), data={"purpose": "offer_photo"},
                             files={"file": ("o.jpg", JPEG, "image/jpeg")})).json()["id"]
    r = (await client.put(f"/api/supplier/offers/{w.offer}/media", headers=H(tok), json={"media_ids": [mid]})).json()
    assert r[0]["image_media_id"] == mid
    img = await client.get(f"/api/media/{mid}")
    assert img.status_code == 200 and img.content == JPEG
    private = (await client.post("/api/supplier/media", headers=H(tok), data={"purpose": "owner_id"},
                                 files={"file": ("i.jpg", JPEG, "image/jpeg")})).json()["id"]
    assert (await client.get(f"/api/media/{private}")).status_code == 404


# ——— القاموس والاقتراح (م-4) ————————————————————————————————————————————————————————
async def test_products_hide_other_suppliers_proposals(db, client):
    w, tok = await _world(db, client)
    other = await _second_supplier(db, w)
    uid = await db.fetchval("SELECT user_id FROM supplier_members WHERE supplier_id = $1", other)
    await act(db, "supplier", uid)
    await db.execute("INSERT INTO products (name_ar, category_id, status, proposed_by_supplier_id) "
                     "VALUES ('طماطم كرزية', $1, 'proposed', $2)", w.category, other)
    r = await client.post("/api/supplier/products", headers=H(tok), json={"name_ar": "طماطم مجففة", "category_id": w.category})
    assert r.status_code == 201 and r.json()["product"]["status"] == "proposed" and r.json()["similar"] == ["طماطم"]
    names = {p["name_ar"] for p in (await client.get("/api/supplier/products?q=طماطم", headers=H(tok))).json()}
    assert names == {"طماطم", "طماطم مجففة"}


# ——— المواقع ——————————————————————————————————————————————————————————————————————
async def test_location_with_active_offers_cannot_be_disabled(db, client):
    w, tok = await _world(db, client)
    r = await client.patch(f"/api/supplier/locations/{w.location}", headers=H(tok), json={"active": False})
    assert r.status_code == 409 and r.json()["code"] == "location_in_use"
    await client.patch(f"/api/supplier/offers/{w.offer}", headers=H(tok), json={"active": False})
    ok = await client.patch(f"/api/supplier/locations/{w.location}", headers=H(tok), json={"active": False})
    assert ok.status_code == 200 and ok.json()[0]["active"] is False


async def test_location_of_another_supplier_is_not_found(db, client):
    w, tok = await _world(db, client)
    await _second_supplier(db, w)
    theirs = await db.fetchval("SELECT id FROM supplier_pickup_locations WHERE supplier_id <> $1", w.supplier)
    r = await client.patch(f"/api/supplier/locations/{theirs}", headers=H(tok), json={"label": "x"})
    assert r.status_code == 404


# ——— الاستلام والمستحقات ————————————————————————————————————————————————————————————————
async def test_pickups_dues_and_payout_notice(db, client):
    from tests.db.world import deliver_in_one

    class Live:  # المستحق يُقيَّد عند التسليم، لا عند الجمع
        pass
    live = Live()
    live.w = await build(db)
    oid = await draft(db, live.w)
    await place(db, live.w, oid)
    await confirm_and_assign(db, live.w, oid)
    await collect_all(db, live.w, oid)
    await deliver_in_one(db, live.w, oid)
    await set_passwords(db)
    tok = (await login(client, "supplier"))["access_token"]
    pk = (await client.get("/api/supplier/pickups", headers=H(tok))).json()
    assert pk[0]["seq"] == 1 and pk[0]["location_label"] == "المخزن الرئيسي" and pk[0]["handover_method"] == "code_entry"
    d = (await client.get("/api/supplier/dues", headers=H(tok))).json()
    assert d["due"] == "1555.540" and d["received"][0]["amount"] == "1555.540" and d["payout_cycle"] == "weekly"
    dash = (await client.get("/api/supplier/dashboard", headers=H(tok))).json()
    assert dash["month_sales"] == "1555.540" and dash["active_offers"] == 1
    await act(db, "admin", live.w.owner)
    await db.execute("INSERT INTO supplier_payouts (supplier_id, amount, period_start, period_end, paid_by) "
                     "VALUES ($1, 1555.54, '2026-09-01', '2026-09-30', $2)", live.w.supplier, live.w.owner)
    await act(db, "system")
    assert await db.fetchval("SELECT emit_supplier_events()") >= 1
    note = (await client.get("/api/supplier/notifications", headers=H(tok))).json()
    assert "supplier_payout" in {n["kind"] for n in note}
    pay = (await client.get("/api/supplier/dues", headers=H(tok))).json()["payouts"][0]
    pdf = await client.get(f"/api/supplier/dues.pdf?payout_id={pay['id']}", headers=H(tok))
    assert pdf.content.startswith(b"%PDF")


async def test_pickup_request_notice_names_no_customer(db, client):
    w = await build(db)
    oid = await draft(db, w)
    await place(db, w, oid)
    await confirm_and_assign(db, w, oid)
    await act(db, "system")
    assert await db.fetchval("SELECT emit_supplier_events()") == 1
    body = await db.fetchval("SELECT body FROM notifications WHERE kind = 'pickup_request' AND user_id = $1", w.sup_user)
    assert "CUSTOMER" not in body and "ADDRESS" not in body and "911" not in body


# ——— التسجيل وحرّاس 0010 ——————————————————————————————————————————————————————————————
async def _new_supplier_user(app, client, phone="+218910000033"):
    await client.post("/api/auth/supplier/register/start", json={"phone": phone})
    code = app.state.otp_outbox[-1]["code"]
    t = (await client.post("/api/auth/supplier/register/verify", json={"phone": phone, "code": code})).json()["ticket"]
    r = await client.post("/api/auth/supplier/register/complete", json={"ticket": t, "password": PASSWORD, "full_name": "—"})
    return r.json()["access_token"]


async def test_registration_needs_a_location_and_starts_pending(db, client, app):
    await build(db)
    tok = await _new_supplier_user(app, client)
    mid = (await client.post("/api/supplier/media", headers=H(tok), data={"purpose": "owner_id"},
                             files={"file": ("i.jpg", JPEG, "image/jpeg")})).json()["id"]
    none = await client.post("/api/supplier/registration", headers=H(tok), json={
        "name": "محل", "contact_name": "سالم", "owner_id_media_id": mid, "locations": []})
    assert none.status_code == 422
    r = await client.post("/api/supplier/registration", headers=H(tok), json={
        "name": "محل", "contact_name": "سالم", "owner_id_media_id": mid,
        "locations": [{"label": "المحل", "lat": "32.8", "lng": "13.1", "address_text": "سوق الثلاثاء"}]})
    assert r.status_code == 201 and r.json()["status"] == "pending"
    me = (await client.get("/api/supplier/me", headers=H(tok))).json()
    assert me["full_name"] == "سالم" and me["supplier"]["status"] == "pending"
    # غير معتمد: لا عرض بعد
    loc = (await client.get("/api/supplier/locations", headers=H(tok))).json()[0]["id"]
    off = await client.post("/api/supplier/offers", headers=H(tok), json={
        "product_id": 1, "unit": "kg", "unit_size": "1", "purchase_price": "5", "reported_qty": "1", "pickup_location_id": loc})
    assert off.status_code in (403, 409)


async def raises(coro, needle):
    with pytest.raises(asyncpg.PostgresError) as e:
        await coro
    assert needle in str(e.value), str(e.value)


async def test_supplier_cannot_add_members_or_self_approve(db):
    w = await build(db)
    await act(db, "system")
    uid = await db.fetchval("INSERT INTO app_users (phone, audience, full_name) VALUES ('+218910000034', 'supplier', 'س') RETURNING id")
    await act(db, "supplier", w.sup_user)
    await raises(db.execute("INSERT INTO supplier_members (supplier_id, user_id) VALUES ($1, $2)", w.supplier, uid),
                 "supplier members are managed by MADAD")
    await act(db, "supplier", uid)
    await raises(db.execute("INSERT INTO suppliers (city, name, contact_name, phone, owner_id_media_id, status, payout_cycle) "
                            "VALUES ('TIP', 'م', 'س', '+218910000034', $1, 'approved', 'daily')", w.media),
                 "a new party starts pending")
    sid = await db.fetchval("INSERT INTO suppliers (city, name, contact_name, phone, owner_id_media_id) "
                            "VALUES ('TIP', 'م', 'س', '+218910000034', $1) RETURNING id", w.media)
    await db.execute("INSERT INTO supplier_members (supplier_id, user_id) VALUES ($1, $2)", sid, uid)   # أول عضو: نفسه
    await raises(db.execute("INSERT INTO supplier_pickup_locations (supplier_id, city, label, lat, lng, address_text) "
                            "VALUES ($1, 'TIP', 'x', 32.8, 13.1, 'x')", w.supplier), "forbidden_not_member")


async def test_supplier_media_of_someone_else_is_refused(db):
    w = await build(db)
    await act(db, "customer", w.cust_user)
    theirs = await db.fetchval("INSERT INTO media_files (storage_key, mime_type, byte_size, sha256, is_private) "
                               "VALUES ('m/c', 'image/jpeg', 10, repeat('d', 64), true) RETURNING id")
    await act(db, "system")
    uid = await db.fetchval("INSERT INTO app_users (phone, audience, full_name) VALUES ('+218910000035', 'supplier', 'س') RETURNING id")
    await act(db, "supplier", uid)
    await raises(db.execute("INSERT INTO suppliers (city, name, contact_name, phone, owner_id_media_id) "
                            "VALUES ('TIP', 'م', 'س', '+218910000035', $1)", theirs), "media_not_owned")
    await act(db, "supplier", w.sup_user)
    await raises(db.execute("INSERT INTO supplier_offer_media (offer_id, media_id) VALUES ($1, $2)", w.offer, theirs),
                 "media_not_owned")



async def test_offer_on_a_proposed_item_stays_paused(db, client):
    """م-4 (لوحة «إضافة عرض»): عرض على صنف مقترح يبقى موقوفاً حتى يعتمده مَدَد — في الاتجاهين."""
    w, tok = await _world(db, client)
    pid = (await client.post("/api/supplier/products", headers=H(tok), json={"name_ar": "زعتر بري", "category_id": w.category}
                             )).json()["product"]["id"]
    body = {"product_id": pid, "unit": "bag", "unit_size": "1", "purchase_price": "5", "reported_qty": "3",
            "pickup_location_id": w.location}
    on = await client.post("/api/supplier/offers", headers=H(tok), json={**body, "active": True})
    assert on.status_code == 409 and on.json()["code"] == "offer_on_proposed_product"
    off = await client.post("/api/supplier/offers", headers=H(tok), json={**body, "active": False})
    assert off.status_code == 201
    oid = next(o["id"] for o in off.json() if o["product_id"] == pid)
    await act(db, "admin", w.owner)
    await db.execute("UPDATE products SET status = 'approved' WHERE id = $1", pid)
    ok = await client.patch(f"/api/supplier/offers/{oid}", headers=H(tok), json={"active": True})
    assert ok.status_code == 200 and next(o for o in ok.json() if o["id"] == oid)["status"] == "active"
