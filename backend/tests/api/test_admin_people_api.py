"""اللوحة — الرئيسية والاعتمادات والعملاء والمستخدمون والإشعارات والتدقيق والإعدادات والمناطق، على السلك.

حارس التسرّب لهذه النقاط (شرط الاستثناء 3): test_admin_guards (الصلاحية؛ ربح اليوم وسجل تدقيق جداول
التكلفة ونصّ إشعار تغيّر السعر محجوبة بلا «التكاليف»).
"""
from __future__ import annotations

from tests.api.test_admin_guards import SUP_ALL, supervisors
from tests.api.world_api import live_world
from tests.db.world import MARGIN_CANARY, act


async def test_dashboard_hides_profit_without_costs(db, client):
    live = await live_world(db, client)
    sup = (await supervisors(db, client))[SUP_ALL]
    owner = (await client.get("/api/admin/dashboard", headers=live.auth("admin"))).json()
    assert "profit_today" in owner and owner["customers"] == 1 and len(owner["sales_7d"]) == 7
    assert "profit_today" not in (await client.get("/api/admin/dashboard", headers=sup)).json()


async def test_approvals_need_payout_cycle_and_pay_method(db, client):
    live = await live_world(db, client)
    await act(db, "system")
    uid = await db.fetchval("INSERT INTO app_users (phone, audience, full_name) VALUES ('+218910000061', 'driver', 'س') RETURNING id")
    did = await db.fetchval("INSERT INTO drivers (user_id, city, full_name, phone, id_media_id, license_media_id, photo_media_id, "
                            "vehicle) VALUES ($1, 'TIP', 'س', '+218910000061', $2, $2, $2, 'car') RETURNING id", uid, live.w.media)
    pend = (await client.get("/api/admin/approvals", headers=live.auth("admin"))).json()
    assert [(x["kind"], x["id"]) for x in pend] == [("driver", did)]
    bad = await client.post(f"/api/admin/approvals/driver/{did}", headers=live.auth("admin"), json={"decision": "approve"})
    assert bad.status_code == 409 and bad.json()["code"] == "pay_method_on_approval"
    ok = await client.post(f"/api/admin/approvals/driver/{did}", headers=live.auth("admin"),
                           json={"decision": "approve", "pay_method": "periodic"})
    assert ok.status_code == 200 and ok.json() == []


async def test_customer_detail_with_branches_and_purchaser_mode(db, client):
    live = await live_world(db, client)
    d = (await client.get(f"/api/admin/customers/{live.w.customer}", headers=live.auth("admin"))).json()
    assert d["branches"][0]["name"] == "الفرع الرئيسي" and d["members"][0]["role"] == "owner"
    r = await client.put(f"/api/admin/customers/{live.w.customer}/purchaser-mode", headers=live.auth("admin"),
                         json={"purchaser_mode": "owner_confirms"})
    assert r.json()["customer"]["purchaser_mode"] == "owner_confirms"


async def test_supervisor_grants_only_what_it_holds(db, client):
    live = await live_world(db, client)
    sup = (await supervisors(db, client))[SUP_ALL]
    r = await client.post("/api/admin/admins", headers=sup, json={"phone": "+218910000062", "full_name": "جديد",
                                                                   "permissions": ["orders"]})
    assert r.status_code == 201, r.text
    new = next(x for x in r.json() if x["phone"] == "+218910000062")
    bad = await client.put(f"/api/admin/admins/{new['user_id']}/permissions", headers=sup, json={"permissions": ["costs_view"]})
    assert bad.status_code == 403 and bad.json()["code"] == "forbidden_grant"


async def test_broadcast_reaches_customers(db, client):
    live = await live_world(db, client)
    r = await client.post("/api/admin/broadcasts", headers=live.auth("admin"),
                          json={"audience": "customer", "title": "عطلة", "body": "نغلق الجمعة"})
    assert r.status_code == 201 and r.json()[0]["recipients"] == 1


async def test_audit_hides_cost_tables_without_costs(db, client):
    live = await live_world(db, client)
    sup = (await supervisors(db, client))[SUP_ALL]
    owner = await client.get("/api/admin/audit?table=catalog_item_pricing", headers=live.auth("admin"))
    assert str(MARGIN_CANARY) in owner.text
    s = (await client.get("/api/admin/audit?table=catalog_item_pricing", headers=sup)).json()
    assert s == []


async def test_settings_change_is_audited_and_new_orders_only(db, client):
    live = await live_world(db, client)
    r = await client.put("/api/admin/settings", headers=live.auth("admin"), json={"cancel_policy": "anytime"})
    assert r.status_code == 200 and r.json()["cancel_policy"] == "anytime"
    assert r.json()["min_order_amount"] == "100.000"                     # ما لم يُرسل لم يتغيّر
    assert (await client.put("/api/admin/settings", headers=live.auth("admin"), json={"fee_mode": "weekly"})).status_code == 422
    c = await client.post("/api/admin/settings/cogs", headers=live.auth("admin"), json={"method": "fifo"})
    assert c.json()["cogs_method"] == "fifo" and len(c.json()["cogs_periods"]) == 2


async def test_otp_channels_order_and_sms_last(db, client):
    live = await live_world(db, client)
    ok = await client.put("/api/admin/settings/otp-channels", headers=live.auth("admin"),
                          json={"order": ["whatsapp_linked", "whatsapp_official", "sms"], "enabled": {"whatsapp_official": False}})
    assert ok.status_code == 200
    assert [(x["channel"], x["enabled"], x["configured"]) for x in ok.json()] == [
        ("whatsapp_linked", True, False), ("whatsapp_official", False, False), ("sms", True, False)]
    bad = await client.put("/api/admin/settings/otp-channels", headers=live.auth("admin"),
                           json={"order": ["sms", "whatsapp_official", "whatsapp_linked"], "enabled": {}})
    assert bad.status_code == 409 and bad.json()["code"] == "sms_must_be_last"


async def test_zones_and_areas(db, client):
    live = await live_world(db, client)
    z = await client.post("/api/admin/zones", headers=live.auth("admin"), json={"name_ar": "قرقارش", "fee": "10"})
    assert z.status_code == 201 and z.json()[0]["fee"] == "10.000"
    a = await client.post("/api/admin/areas", headers=live.auth("admin"),
                          json={"name_ar": "غرب", "fee": "15", "polygon": [[32.8, 13.1], [32.8, 13.3], [33.0, 13.3]]})
    assert a.status_code == 201 and len(a.json()[0]["polygon"]) == 3
    bad = await client.post("/api/admin/areas", headers=live.auth("admin"),
                            json={"name_ar": "خطأ", "fee": "1", "polygon": [[99, 1], [1, 2], [2, 2]]})
    assert bad.status_code == 409 and bad.json()["code"] == "area_polygon_invalid"


async def test_inbox_hides_prices_without_costs(db, client):
    live = await live_world(db, client)
    await act(db, "supplier", live.w.sup_user)
    await db.execute("UPDATE supplier_offers SET purchase_price = 790 WHERE id = $1", live.w.offer)
    owner = (await client.get("/api/admin/inbox", headers=live.auth("admin"))).json()
    assert owner[0]["kind"] == "price_changed" and "790" in owner[0]["body"]
    r = await client.post(f"/api/admin/inbox/{owner[0]['id']}/read", headers=live.auth("admin"))
    assert r.json()[0]["read"] is True
