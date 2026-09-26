"""تطبيق العميل على السلك (الجزء 11): كل نقطة في الاتجاهين.

حارس التسرّب لكل نقاطه (شرط الاستثناء 3): test_leak_responses::test_every_audience_operation_is_clean_on_the_wire
بحالاتها في audience_cases.py، وtest_leak_openapi (أسماء الحقول) — وهنا ما يخصّ كل نقطة.
"""
from __future__ import annotations

from decimal import Decimal

from tests.api.world_api import PASSWORD, live_world, login, set_passwords
from tests.db.test_settings_0004 import new_branch, purchaser
from tests.db.world import act, build, confirm_and_assign, draft, place

H = lambda tok: {"Authorization": f"Bearer {tok}"}  # noqa: E731
JPEG = b"\xff\xd8\xff\xe0" + b"0" * 64


async def _world(db, client):
    w = await build(db)
    await set_passwords(db)
    return w, (await login(client, "customer"))["access_token"]


async def _purchaser_login(db, client, w, branch=None, phone="+218910000009"):
    uid = await purchaser(db, w, phone=phone, branch=branch)
    await set_passwords(db)
    r = await client.post("/api/auth/customer/login", json={"phone": phone, "password": PASSWORD})
    return uid, r.json()["access_token"]


# ——— م-9: الطلبيات والإيصال حسب الفرع (كان الخلل: المسؤول يرى كل الفروع) ————————————————————
async def test_purchaser_sees_own_branch_orders_only(db, client):
    w, tok = await _world(db, client)
    main = await db.fetchval("SELECT id FROM customer_locations WHERE customer_id = $1", w.customer)
    oid = await draft(db, w)
    await place(db, w, oid)
    other = await new_branch(db, w)
    _, ptok = await _purchaser_login(db, client, w, branch=other)
    assert (await client.get("/api/customer/orders", headers=H(ptok))).json() == []
    r = await client.get(f"/api/customer/orders/{oid}", headers=H(ptok))
    assert r.status_code == 403 and r.json()["code"] == "forbidden_branch"
    pdf = await client.get(f"/api/customer/orders/{oid}/receipt.pdf", headers=H(ptok))
    assert pdf.status_code == 403
    mine = await client.get("/api/customer/orders", headers=H(tok))
    assert [o["id"] for o in mine.json()] == [oid] and mine.json()[0]["branch_id"] == main


async def test_order_of_another_establishment_is_not_found(db, client):
    live = await live_world(db, client)
    r = await client.get("/api/customer/orders/999999", headers=live.auth("customer"))
    assert r.status_code == 404 and r.json()["code"] == "order_not_found"


async def test_order_detail_has_events_and_amount_due_but_no_actor(db, client):
    live = await live_world(db, client)
    o = (await client.get(f"/api/customer/orders/{live.order}", headers=live.auth("customer"))).json()
    assert [e["status"] for e in o["events"]][:2] == ["draft", "placed"]
    assert all(set(e) == {"status", "at"} for e in o["events"])
    assert Decimal(o["amount_due"]) == Decimal(o["total"]) and o["branch_name"] == "الفرع الرئيسي"
    assert o["editable"] is False


# ——— التسجيل والوسائط ————————————————————————————————————————————————————————————————
async def _new_user(app, client, phone="+218910000066"):
    await client.post("/api/auth/customer/register/start", json={"phone": phone})
    code = app.state.otp_outbox[-1]["code"]  # قناة console في الاختبار
    t = (await client.post("/api/auth/customer/register/verify", json={"phone": phone, "code": code})).json()["ticket"]
    r = await client.post("/api/auth/customer/register/complete", json={"ticket": t, "password": PASSWORD, "full_name": "—"})
    return r.json()["access_token"]


async def test_registration_creates_pending_establishment_with_own_media(db, client, app):
    await build(db)
    tok = await _new_user(app, client)
    up = await client.post("/api/customer/media", headers=H(tok), data={"purpose": "facade"},
                           files={"file": ("f.jpg", JPEG, "image/jpeg")})
    assert up.status_code == 201, up.text
    mid = up.json()["id"]
    assert (await client.get(f"/api/media/{mid}")).status_code == 404          # خاصّ: لا يُخدَم علناً
    body = {"name": "مقهى الركن", "kind": "cafe", "contact_name": "سالم", "lat": "32.88", "lng": "13.19",
            "address_text": "قرقارش", "facade_media_id": mid}
    r = await client.post("/api/customer/registration", headers=H(tok), json=body)
    assert r.status_code == 201 and r.json()["status"] == "pending"
    me = (await client.get("/api/customer/me", headers=H(tok))).json()
    assert me["full_name"] == "سالم" and me["member"]["role"] == "owner" and me["customer"]["status"] == "pending"
    again = await client.post("/api/customer/registration", headers=H(tok), json=body)
    assert again.status_code == 409 and again.json()["code"] == "establishment_exists"
    # لا سلة في القاعدة قبل الاعتماد: تبقى في الجهاز
    cart = await client.put("/api/customer/cart/items/1", headers=H(tok), json={"qty": "1"})
    assert cart.status_code == 409 and cart.json()["code"] == "party_not_approved"


async def test_media_rejects_unknown_type_and_purpose(db, client, app):
    await build(db)
    tok = await _new_user(app, client)
    bad = await client.post("/api/customer/media", headers=H(tok), data={"purpose": "facade"},
                            files={"file": ("x.txt", b"hello", "image/jpeg")})
    assert bad.status_code == 422 and bad.json()["code"] == "media_type_unsupported"
    wrong = await client.post("/api/customer/media", headers=H(tok), data={"purpose": "offer_photo"},
                              files={"file": ("f.jpg", JPEG, "image/jpeg")})
    assert wrong.status_code == 422 and wrong.json()["code"] == "media_purpose_unknown"


async def test_registration_cannot_use_someone_elses_media(db, client, app):
    await build(db)
    a = await _new_user(app, client, "+218910000066")
    b = await _new_user(app, client, "+218910000067")
    mid = (await client.post("/api/customer/media", headers=H(b), data={"purpose": "facade"},
                             files={"file": ("f.jpg", JPEG, "image/jpeg")})).json()["id"]
    r = await client.post("/api/customer/registration", headers=H(a), json={
        "name": "م", "kind": "cafe", "contact_name": "س", "lat": "32.8", "lng": "13.1", "address_text": "ع", "facade_media_id": mid})
    assert r.status_code == 403 and r.json()["code"] == "media_not_owned"


# ——— السلة والتأكيد ——————————————————————————————————————————————————————————————————
async def test_cart_preview_then_place(db, client):
    w, tok = await _world(db, client)
    c = (await client.put(f"/api/customer/cart/items/{w.item}", headers=H(tok), json={"qty": "2"})).json()
    assert c["lines"][0]["qty"] == "2" and c["subtotal"] == "1822.626"
    assert c["delivery_fee"] == "10.000" and c["fee_error"] is None and c["below_min_by"] == "0.000"
    cat = (await client.get("/api/customer/catalog", headers=H(tok))).json()
    assert cat[0]["cart_qty"] == "2"
    o = await client.post("/api/customer/cart/place", headers=H(tok), json={"notes": "الباب الخلفي"})
    assert o.status_code == 200, o.text
    assert o.json()["status"] == "placed" and o.json()["notes"] == "الباب الخلفي" and o.json()["editable"] is True
    empty = (await client.get("/api/customer/cart", headers=H(tok))).json()
    assert empty["order_id"] is None and empty["lines"] == []


async def test_place_below_minimum_is_refused(db, client):
    w, tok = await _world(db, client)
    await act(db, "admin", w.owner)
    await db.execute("UPDATE city_settings SET min_order_amount = 5000")
    c = (await client.put(f"/api/customer/cart/items/{w.item}", headers=H(tok), json={"qty": "1"})).json()
    assert Decimal(c["below_min_by"]) > 0
    r = await client.post("/api/customer/cart/place", headers=H(tok), json={})
    assert r.status_code == 409 and r.json()["code"] == "min_order_amount"


async def test_cart_qty_zero_removes_the_line(db, client):
    w, tok = await _world(db, client)
    await client.put(f"/api/customer/cart/items/{w.item}", headers=H(tok), json={"qty": "3"})
    c = (await client.put(f"/api/customer/cart/items/{w.item}", headers=H(tok), json={"qty": "0"})).json()
    assert c["lines"] == []


async def test_available_qty_shows_only_under_forbid(db, client):
    w, tok = await _world(db, client)
    item = (await client.get(f"/api/customer/catalog/{w.item}", headers=H(tok))).json()["item"]
    assert item["available_qty"] == "100"                                 # الابتدائي forbid (م-15)
    await act(db, "admin", w.owner)
    await db.execute("UPDATE city_settings SET oversell_policy = 'allow'")
    item = (await client.get(f"/api/customer/catalog/{w.item}", headers=H(tok))).json()["item"]
    assert "available_qty" not in item


async def test_owner_confirms_mode_ready_then_owner_places(db, client):
    w, tok = await _world(db, client)
    await act(db, "admin", w.owner)
    await db.execute("UPDATE customers SET purchaser_mode = 'owner_confirms' WHERE id = $1", w.customer)
    _, ptok = await _purchaser_login(db, client, w)
    await client.put(f"/api/customer/cart/items/{w.item}", headers=H(ptok), json={"qty": "1"})
    direct = await client.post("/api/customer/cart/place", headers=H(ptok), json={})
    assert direct.status_code == 403 and direct.json()["code"] == "owner_confirmation_required"
    rd = (await client.post("/api/customer/cart/ready", headers=H(ptok), json={})).json()
    assert rd["ready_for_owner_at"] is not None and rd["prepared_by"] == "مسؤول"
    ready = (await client.get("/api/customer/carts/ready", headers=H(tok))).json()
    assert len(ready) == 1 and ready[0]["prepared_by"] == "مسؤول"
    note = (await client.get("/api/customer/notifications", headers=H(tok))).json()
    assert note[0]["kind"] == "order_awaiting_owner"
    assert (await client.post("/api/customer/cart/place", headers=H(tok), json={})).json()["status"] == "placed"


# ——— تعديل الطلبية حتى التأكيد، وإعادة الطلب ————————————————————————————————————————————
async def test_customer_edits_until_confirmed(db, client):
    w, tok = await _world(db, client)
    oid = await draft(db, w)
    await place(db, w, oid)
    r = await client.put(f"/api/customer/orders/{oid}/items/{w.item}", headers=H(tok), json={"qty": "5"})
    assert r.status_code == 200 and r.json()["lines"][0]["qty"] == "5"
    await confirm_and_assign(db, w, oid)
    late = await client.put(f"/api/customer/orders/{oid}/items/{w.item}", headers=H(tok), json={"qty": "6"})
    assert late.status_code in (403, 409)


async def test_reorder_fills_the_cart_and_skips_unavailable(db, client):
    live = await live_world(db, client)
    r = (await client.post(f"/api/customer/orders/{live.order}/reorder", headers=live.auth("customer"))).json()
    assert r["skipped"] == [] and r["cart"]["lines"][0]["catalog_item_id"] == live.w.item
    await act(db, "admin", live.w.owner)
    await db.execute("UPDATE catalog_items SET visibility = 'hidden' WHERE id = $1", live.w.item)
    await client.put(f"/api/customer/cart/items/{live.w.item}", headers=live.auth("customer"), json={"qty": "0"})
    r = (await client.post(f"/api/customer/orders/{live.order}/reorder", headers=live.auth("customer"))).json()
    assert r["skipped"] == ["طماطم"] and r["cart"]["lines"] == []


# ——— النزاع (م-10) ————————————————————————————————————————————————————————————————————
async def test_dispute_open_list_and_one_per_item(db, client):
    live = await live_world(db, client)
    item = await db.fetchval("SELECT id FROM order_items WHERE order_id = $1", live.order)
    url = f"/api/customer/orders/{live.order}/disputes"
    r = await client.post(url, headers=live.auth("customer"), json={"order_item_id": item, "kind": "damaged",
                                                                     "description": "تالف"})
    assert r.status_code == 201 and r.json()[0]["status"] == "open" and r.json()[0]["item"] == "طماطم"
    assert not {"loss_bearer", "loss_supplier_id", "loss_driver_id", "refund_driver_id"} & set(r.json()[0])
    dup = await client.post(url, headers=live.auth("customer"), json={"order_item_id": item, "kind": "short", "description": "x"})
    assert dup.status_code == 409 and dup.json()["code"] == "dispute_open_per_item"


# ——— الفروع والمستخدمون (م-8، م-9) ——————————————————————————————————————————————————————
async def test_owner_adds_branch_pending_and_purchaser_sees_own(db, client):
    w, tok = await _world(db, client)
    r = await client.post("/api/customer/branches", headers=H(tok), json={"name": "فرع قرقارش", "lat": "32.88",
                                                                          "lng": "13.12", "address_text": "قرقارش"})
    assert r.status_code == 201 and {b["status"] for b in r.json()} == {"approved", "pending"}
    _, ptok = await _purchaser_login(db, client, w)
    mine = (await client.get("/api/customer/branches", headers=H(ptok))).json()
    assert len(mine) == 1 and mine[0]["name"] == "الفرع الرئيسي"
    no = await client.post("/api/customer/branches", headers=H(ptok), json={"name": "x", "lat": "32.8", "lng": "13.1",
                                                                           "address_text": "x"})
    assert no.status_code == 403 and no.json()["code"] == "forbidden_owner_member"


async def test_owner_adds_purchaser_who_cannot_add(db, client):
    w, tok = await _world(db, client)
    main = await db.fetchval("SELECT id FROM customer_locations WHERE customer_id = $1", w.customer)
    r = await client.post("/api/customer/members", headers=H(tok), json={"phone": "+218910000055", "full_name": "سالم",
                                                                         "role": "purchaser", "branch_id": main})
    assert r.status_code == 201
    new = next(m for m in r.json() if m["phone"] == "+218910000055")
    assert (new["role"], new["branch_name"], new["activated"]) == ("purchaser", "الفرع الرئيسي", False)
    _, ptok = await _purchaser_login(db, client, w, phone="+218910000009")
    no = await client.post("/api/customer/members", headers=H(ptok), json={"phone": "+218910000056", "full_name": "ع",
                                                                          "role": "owner"})
    assert no.status_code == 403


# ——— القوائم المتكررة (§3.1) ————————————————————————————————————————————————————————————
async def test_list_create_remind_and_to_cart(db, client):
    w, tok = await _world(db, client)
    r = await client.post("/api/customer/lists", headers=H(tok), json={"name": "طلب السبت",
                                                                       "items": [{"catalog_item_id": w.item, "qty": "4"}]})
    assert r.status_code == 201, r.text
    lid = r.json()["list"]["id"]
    p = await client.patch(f"/api/customer/lists/{lid}", headers=H(tok), json={"reminder_days": [6], "reminder_time": "08:30"})
    assert p.json()["list"]["reminder_days"] == [6] and p.json()["list"]["reminder_time"] == "08:30"
    half = await client.patch(f"/api/customer/lists/{lid}", headers=H(tok), json={"reminder_days": [6]})
    assert half.status_code == 422
    c = (await client.post(f"/api/customer/lists/{lid}/to-cart", headers=H(tok), json={})).json()
    assert c["cart"]["lines"][0]["qty"] == "4"
    dup = await client.post("/api/customer/lists", headers=H(tok), json={"name": "طلب السبت"})
    assert dup.status_code == 409 and dup.json()["code"] == "list_name_per_branch"
    assert (await client.delete(f"/api/customer/lists/{lid}", headers=H(tok))).status_code == 204
    assert (await client.get("/api/customer/lists", headers=H(tok))).json() == []


async def test_list_with_unavailable_item_needs_skip(db, client):
    w, tok = await _world(db, client)
    lid = (await client.post("/api/customer/lists", headers=H(tok), json={
        "name": "ق", "items": [{"catalog_item_id": w.item, "qty": "1"}]})).json()["list"]["id"]
    await act(db, "admin", w.owner)
    await db.execute("UPDATE catalog_items SET visibility = 'hidden' WHERE id = $1", w.item)
    lst = (await client.get("/api/customer/lists", headers=H(tok))).json()[0]
    assert lst["list"]["has_unavailable"] is True and lst["lines"][0]["orderable"] is False
    r = await client.post(f"/api/customer/lists/{lid}/to-cart", headers=H(tok), json={})
    assert r.status_code == 409 and r.json()["items"] == ["طماطم"]
    ok = (await client.post(f"/api/customer/lists/{lid}/to-cart", headers=H(tok), json={"skip_unavailable": True})).json()
    assert ok["skipped"] == ["طماطم"] and ok["cart"]["lines"] == []


# ——— الإشعارات والتقارير ————————————————————————————————————————————————————————————————
async def test_notifications_read_is_own_only(db, client):
    w, tok = await _world(db, client)
    await act(db, "system")
    await db.execute("INSERT INTO notifications (user_id, kind, title, body) VALUES ($1, 'broadcast', 'عطلة', 'ب'), "
                     "($2, 'broadcast', 'غيري', 'ب')", w.cust_user, w.drv_user)
    lst = (await client.get("/api/customer/notifications", headers=H(tok))).json()
    assert [n["title"] for n in lst] == ["عطلة"] and lst[0]["read"] is False
    assert (await client.get("/api/customer/me", headers=H(tok))).json()["unread"] == 1
    after = (await client.post("/api/customer/notifications/read", headers=H(tok), json={"all": True})).json()
    assert after[0]["read"] is True
    assert await db.fetchval("SELECT read_at IS NULL FROM notifications WHERE user_id = $1", w.drv_user)


async def test_report_counts_delivered_orders_per_branch(db, client):
    from tests.db.world import collect_all, deliver_in_one
    w = await build(db)
    oid = await draft(db, w)
    await place(db, w, oid)
    await confirm_and_assign(db, w, oid)
    await collect_all(db, w, oid)
    await deliver_in_one(db, w, oid)
    await set_passwords(db)
    tok = (await login(client, "customer"))["access_token"]
    r = (await client.get("/api/customer/reports", headers=H(tok))).json()
    assert r["orders"] == 1 and r["branches"][0]["orders"] == 1 and Decimal(r["amount"]) > 0
    pdf = await client.get("/api/customer/reports.pdf", headers=H(tok))
    assert pdf.content.startswith(b"%PDF")
