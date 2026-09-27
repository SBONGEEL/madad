"""قرارات الدفعة السادسة (§12-ط) على السلك: م-27، م-28، والعناصر السبعة — كل نقطة في الاتجاهين.

حارس التسرّب للنقاط الجديدة (شرط الاستثناء 3): test_leak_responses بحالاتها في audience_cases.py (العميل
والسائق)، وtest_admin_guards بحالاتها في admin_cases.py (اللوحة)، وtest_leak_openapi — وهنا محتوى كل نقطة،
ومنه أن المورد لا يرى شيئاً عن العميل أو وجهة الطلبية في الموعد والوصول.
"""
from __future__ import annotations

from decimal import Decimal

from tests.api.test_admin_guards import SUP_ALL, supervisors
from tests.api.world_api import live_world, login, set_passwords
from tests.db.test_isolation import SUPPLIER_FORBIDDEN, leaks
from tests.db.world import act, build, confirm_and_assign, draft, place

H = lambda tok: {"Authorization": f"Bearer {tok}"}  # noqa: E731
SQUARE = [["32.80", "13.10"], ["32.80", "13.30"], ["33.00", "13.30"], ["33.00", "13.10"]]


async def _tokens(db, client, *aud):
    await set_passwords(db)
    return [(await login(client, a))["access_token"] for a in aud]


# ——— م-27 ————————————————————————————————————————————————————————————————————————
async def test_m27_rule_setting_and_overlap_listing(db, client):
    w = await build(db)
    adm, = await _tokens(db, client, "admin")
    r = (await client.get("/api/admin/settings/area-overlap", headers=H(adm))).json()
    assert r == {"rule": "stop", "overlaps": []}
    await client.post("/api/admin/areas", headers=H(adm), json={"name_ar": "وسط", "fee": "12", "polygon": SQUARE})
    await client.post("/api/admin/areas", headers=H(adm), json={"name_ar": "شرق", "fee": "15", "polygon": SQUARE})
    r = (await client.get("/api/admin/settings/area-overlap", headers=H(adm))).json()
    assert len(r["overlaps"]) == 1 and {r["overlaps"][0]["name_a"], r["overlaps"][0]["name_b"]} == {"وسط", "شرق"}
    assert r["overlaps"][0]["branches"][0]["branch"].endswith("الفرع الرئيسي")          # الفرع (32.887، 13.191) فيهما
    for rule in ("higher", "lower", "stop"):
        assert (await client.put("/api/admin/settings/area-overlap", headers=H(adm), json={"rule": rule})).json()["rule"] == rule
    bad = await client.put("/api/admin/settings/area-overlap", headers=H(adm), json={"rule": "any"})
    assert bad.status_code == 422


async def test_m27_overlap_check_before_saving(db, client):
    await build(db)
    adm, = await _tokens(db, client, "admin")
    await client.post("/api/admin/areas", headers=H(adm), json={"name_ar": "وسط", "fee": "12", "polygon": SQUARE})
    hit = (await client.post("/api/admin/areas/overlap-check", headers=H(adm), json={"polygon": SQUARE, "fee": "15"})).json()
    assert [h["name_ar"] for h in hit] == ["وسط"] and len(hit[0]["branches"]) == 1
    same_fee = (await client.post("/api/admin/areas/overlap-check", headers=H(adm), json={"polygon": SQUARE, "fee": "12"})).json()
    assert same_fee == []                                                      # الرسم نفسه لا تعارض فيه
    far = [["30.0", "10.0"], ["30.0", "10.1"], ["30.1", "10.1"]]
    assert (await client.post("/api/admin/areas/overlap-check", headers=H(adm), json={"polygon": far, "fee": "15"})).json() == []


# ——— م-28 ————————————————————————————————————————————————————————————————————————
async def test_m28_warehouse_cost_setting_both_ways(db, client):
    w = await build(db)
    adm, = await _tokens(db, client, "admin")
    url = f"/api/admin/catalog/{w.item}/warehouse-cost"
    p = (await client.get(f"/api/admin/catalog/{w.item}", headers=H(adm))).json()
    assert p["warehouse_cost_mode"] == "auto"
    m = (await client.put(url, headers=H(adm), json={"mode": "manual", "manual_cost": "8.900"})).json()
    assert m["warehouse_cost_mode"] == "manual" and m["warehouse_manual_cost"] == "8.900"
    a = (await client.put(url, headers=H(adm), json={"mode": "auto"})).json()
    assert a["warehouse_cost_mode"] == "auto" and a["warehouse_manual_cost"] is None
    bad = await client.put(url, headers=H(adm), json={"mode": "auto", "manual_cost": "5"})
    assert bad.status_code == 422
    sup = (await supervisors(db, client))[SUP_ALL]
    hidden = (await client.get(f"/api/admin/catalog/{w.item}", headers=sup)).json()
    assert "warehouse_cost_mode" not in hidden and "warehouse_cost" not in hidden


# ——— رقم التواصل ————————————————————————————————————————————————————————————————————
async def test_contact_numbers_reach_the_three_apps(db, client):
    await build(db)
    adm, cust, sup, drv = await _tokens(db, client, "admin", "customer", "supplier", "driver")
    r = await client.put("/api/admin/settings/contact", headers=H(adm),
                         json={"phone": "+218921112233", "whatsapp": "+218921112234"})
    assert r.json() == {"phone": "+218921112233", "whatsapp": "+218921112234"}
    assert (await client.get("/api/customer/me", headers=H(cust))).json()["context"]["contact_whatsapp"] == "+218921112234"
    assert (await client.get("/api/supplier/me", headers=H(sup))).json()["contact"]["phone"] == "+218921112233"
    assert (await client.get("/api/driver/me", headers=H(drv))).json()["contact"]["phone"] == "+218921112233"
    bad = await client.put("/api/admin/settings/contact", headers=H(adm), json={"phone": "0921112233"})
    assert bad.status_code == 422


# ——— نبّهني حين يتوفر ————————————————————————————————————————————————————————————————
async def test_back_in_stock_alert_flow(db, client):
    w = await build(db)
    cust, = await _tokens(db, client, "customer")
    url = f"/api/customer/catalog/{w.item}/alert"
    avail = await client.post(url, headers=H(cust))
    assert avail.status_code == 409 and avail.json()["code"] == "alert_item_available"
    await act(db, "admin", w.owner)
    await db.execute("UPDATE catalog_items SET oos_policy = 'mark_out' WHERE id = $1", w.item)
    await act(db, "supplier", w.sup_user)
    await db.execute("UPDATE supplier_offers SET reported_qty = 0 WHERE id = $1", w.offer)
    r = await client.post(url, headers=H(cust))
    assert r.status_code == 200 and r.json()["item"]["alert"] is True and r.json()["item"]["out_of_stock"] is True
    off = (await client.delete(url, headers=H(cust))).json()
    assert off["item"]["alert"] is False
    await client.post(url, headers=H(cust))
    await act(db, "supplier", w.sup_user)
    await db.execute("UPDATE supplier_offers SET reported_qty = 40 WHERE id = $1", w.offer)
    notes = (await client.get("/api/customer/notifications", headers=H(cust))).json()
    assert notes[0]["kind"] == "back_in_stock"
    assert (await client.get(f"/api/customer/catalog/{w.item}", headers=H(cust))).json()["item"]["alert"] is False


# ——— الإلغاء حسب م-7 ————————————————————————————————————————————————————————————————
async def test_cancel_button_follows_policy_and_status(db, client):
    w = await build(db)
    oid = await draft(db, w)
    await place(db, w, oid)
    cust, = await _tokens(db, client, "customer")
    o = (await client.get(f"/api/customer/orders/{oid}", headers=H(cust))).json()
    assert o["cancellable"] is True
    r = await client.post(f"/api/customer/orders/{oid}/cancel", headers=H(cust), json={})
    assert r.status_code == 200 and r.json()["status"] == "cancelled" and r.json()["cancellable"] is False


async def test_cancel_refused_once_collecting_under_default_policy(db, client):
    live = await live_world(db, client)                              # يجري التجميع، والسياسة الابتدائية حتى التجميع
    o = (await client.get(f"/api/customer/orders/{live.order}", headers=live.auth("customer"))).json()
    assert o["cancellable"] is False
    r = await client.post(f"/api/customer/orders/{live.order}/cancel", headers=live.auth("customer"), json={})
    assert r.status_code == 409 and r.json()["code"] == "invalid_transition"


# ——— المستلم ————————————————————————————————————————————————————————————————————————
async def test_recipient_default_override_and_driver_sees_it(db, client):
    w = await build(db)
    cust, drv, adm = await _tokens(db, client, "customer", "driver", "admin")
    br = (await client.get("/api/customer/branches", headers=H(cust))).json()[0]
    upd = await client.patch(f"/api/customer/branches/{br['id']}", headers=H(cust), json={
        "name": br["name"], "lat": br["lat"], "lng": br["lng"], "address_text": br["address_text"], "default_recipient": "سالم"})
    assert upd.json()[0]["default_recipient"] == "سالم" and upd.json()[0]["status"] == "approved"
    await client.put(f"/api/customer/cart/items/{w.item}", headers=H(cust), json={"qty": "1"})
    o = (await client.post("/api/customer/cart/place", headers=H(cust), json={"recipient_name": "علي"})).json()
    assert o["recipient_name"] == "علي"
    await confirm_and_assign(db, w, o["id"])
    d = (await client.get(f"/api/driver/orders/{o['id']}", headers=H(drv))).json()
    assert d["recipient_name"] == "علي"


# ——— التوفر ———————————————————————————————————————————————————————————————————————————
async def test_availability_hides_offers_and_owner_sees_it(db, client):
    w = await build(db)
    oid = await draft(db, w)
    await place(db, w, oid)
    await act(db, "admin", w.owner)
    await db.execute("UPDATE orders SET status = 'confirmed', route_km = 10 WHERE id = $1", oid)
    drv, adm = await _tokens(db, client, "driver", "admin")
    assert len((await client.get("/api/driver/available", headers=H(drv))).json()) == 1
    me = (await client.put("/api/driver/availability", headers=H(drv), json={"accepting": False})).json()
    assert me["driver"]["accepting"] is False
    assert (await client.get("/api/driver/available", headers=H(drv))).json() == []
    no = await client.post(f"/api/driver/orders/{oid}/accept", headers=H(drv))
    assert no.status_code == 409
    listed = (await client.get("/api/admin/drivers/available", headers=H(adm))).json()
    assert next(x for x in listed if x["id"] == w.driver)["accepting"] is False
    ok = await client.post(f"/api/admin/orders/{oid}/assign", headers=H(adm), json={"driver_id": w.driver, "route_km": "10"})
    assert ok.status_code == 200 and ok.json()["order"]["status"] == "assigned"          # يدوياً رغم ذلك
    back = (await client.put("/api/driver/availability", headers=H(drv), json={"accepting": True})).json()
    assert back["driver"]["accepting"] is True


# ——— الموعد والوصول، والمورد لا يرى العميل —————————————————————————————————————————————————
async def test_eta_and_arrival_reach_the_supplier_without_customer_data(db, client):
    w = await build(db)
    oid = await draft(db, w)
    await place(db, w, oid)
    await confirm_and_assign(db, w, oid)
    drv, sup = await _tokens(db, client, "driver", "supplier")
    stop = (await client.get(f"/api/driver/orders/{oid}", headers=H(drv))).json()["stops"][0]["id"]
    r = await client.put(f"/api/driver/stops/{stop}/eta", headers=H(drv), json={"eta_at": "2026-09-27T10:30:00+02:00"})
    assert r.status_code == 200 and r.json()["stops"][0]["eta_at"] is not None
    a = await client.post(f"/api/driver/stops/{stop}/arrive", headers=H(drv))
    assert a.json()["stops"][0]["arrived_at"] is not None
    twice = await client.post(f"/api/driver/stops/{stop}/arrive", headers=H(drv))
    assert twice.status_code == 409 and twice.json()["code"] == "stop_already_arrived"
    pk = await client.get("/api/supplier/pickups", headers=H(sup))
    got = pk.json()[0]
    assert got["eta_at"] is not None and got["arrived_at"] is not None
    assert not leaks(pk.text, SUPPLIER_FORBIDDEN)
    dash = (await client.get("/api/supplier/dashboard", headers=H(sup))).json()
    assert dash["first_eta"] is not None and dash["next_payout_on"] is not None


# ——— الصرف القادم ————————————————————————————————————————————————————————————————————
async def test_next_payout_for_supplier_and_driver_rule(db, client):
    w = await build(db)
    sup, drv = await _tokens(db, client, "supplier", "driver")
    d = (await client.get("/api/supplier/dues", headers=H(sup))).json()
    assert d["payout_cycle"] == "weekly" and d["next_payout_on"] is not None
    wal = (await client.get("/api/driver/wallet", headers=H(drv))).json()
    assert (wal["pay_method"], wal["next_payout_rule"], wal["next_payout_on"]) == ("periodic", "pending_decision", None)
    await act(db, "admin", w.owner)
    await db.execute("UPDATE drivers SET pay_method = 'offset_on_settlement' WHERE id = $1", w.driver)
    wal = (await client.get("/api/driver/wallet", headers=H(drv))).json()
    assert wal["next_payout_rule"] == "at_next_handover"
    assert Decimal(wal["wage_due"]) == 0
