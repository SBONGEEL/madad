"""اللوحة — الطلبيات والمخطط والإسناد والنزاعات، على السلك.

حارس التسرّب لهذه النقاط (شرط الاستثناء 3): test_admin_guards (الصلاحية، وحجب التكلفة في المخطط).
"""
from __future__ import annotations

from decimal import Decimal

from tests.api.test_admin_guards import SUP_ALL, supervisors
from tests.api.world_api import login, set_passwords
from tests.db.world import act, build, draft, place

H = lambda tok: {"Authorization": f"Bearer {tok}"}  # noqa: E731


async def _placed(db, client):
    w = await build(db)
    oid = await draft(db, w)
    await place(db, w, oid)
    await set_passwords(db)
    return w, oid, (await login(client, "admin"))["access_token"]


async def test_confirm_builds_plan_then_assign(db, client):
    w, oid, tok = await _placed(db, client)
    r = await client.post(f"/api/admin/orders/{oid}/confirm", headers=H(tok))
    assert r.status_code == 200 and r.json()["order"]["status"] == "confirmed"
    plan = (await client.get(f"/api/admin/orders/{oid}/plan", headers=H(tok))).json()
    assert plan["plan_complete"] and plan["stops"][0]["lines"][0]["unit_cost"] == "777.770"
    drivers = (await client.get("/api/admin/drivers/available", headers=H(tok))).json()
    assert drivers[0]["id"] == w.driver and drivers[0]["over_cap"] is False
    r = await client.post(f"/api/admin/orders/{oid}/assign", headers=H(tok), json={"driver_id": w.driver, "route_km": "8"})
    assert r.status_code == 200, r.text
    assert r.json()["order"]["status"] == "assigned" and r.json()["driver_pay"] == "11.000"   # 5 + 2×1 + 0.5×8


async def test_plan_edit_adds_a_costed_line_and_hides_cost_without_permission(db, client):
    w, oid, tok = await _placed(db, client)
    await client.post(f"/api/admin/orders/{oid}/confirm", headers=H(tok))
    item = await db.fetchval("SELECT id FROM order_items WHERE order_id = $1", oid)
    line = await db.fetchval("SELECT l.id FROM pickup_stop_lines l JOIN pickup_stops s ON s.id = l.stop_id WHERE s.order_id = $1", oid)
    assert (await client.patch(f"/api/admin/plan/lines/{line}", headers=H(tok), json={"qty": "1"})).status_code == 200
    r = await client.post(f"/api/admin/orders/{oid}/plan/lines", headers=H(tok),
                          json={"order_item_id": item, "offer_id": w.offer, "qty": "1"})
    assert r.status_code == 200, r.text
    lines = [ln for s in r.json()["stops"] for ln in s["lines"]]
    assert sum(Decimal(ln["planned_qty"]) for ln in lines) == 2 and r.json()["plan_complete"]
    sup = (await supervisors(db, client))[SUP_ALL]
    hidden = (await client.get(f"/api/admin/orders/{oid}/plan", headers=sup)).json()
    assert all("unit_cost" not in ln for s in hidden["stops"] for ln in s["lines"])


async def test_cancel_needs_a_reason(db, client):
    w, oid, tok = await _placed(db, client)
    assert (await client.post(f"/api/admin/orders/{oid}/cancel", headers=H(tok), json={"reason": ""})).status_code == 422
    r = await client.post(f"/api/admin/orders/{oid}/cancel", headers=H(tok), json={"reason": "نفاد"})
    assert r.json()["order"]["status"] == "cancelled" and r.json()["events"][-1]["reason"] == "نفاد"


async def test_dispute_resolved_with_credit_posts_to_ledger(db, client):
    w, oid, tok = await _placed(db, client)
    await act(db, "customer", w.cust_user)
    did = await db.fetchval("INSERT INTO disputes (order_id, opened_by_role, opened_by, kind, description) "
                            "VALUES ($1, 'customer', $2, 'damaged', 'تالف') RETURNING id", oid, w.cust_user)
    lst = (await client.get("/api/admin/disputes?status=open", headers=H(tok))).json()
    assert [d["id"] for d in lst] == [did]
    bad = await client.post(f"/api/admin/disputes/{did}/resolve", headers=H(tok),
                            json={"resolution": "partial_discount", "resolution_amount": "9.000"})
    assert bad.status_code == 409 and bad.json()["code"] == "dispute_money_needs_decision"
    ok = await client.post(f"/api/admin/disputes/{did}/resolve", headers=H(tok), json={
        "resolution": "partial_discount", "resolution_amount": "9.000", "refund_method": "credit_next_order",
        "loss_bearer": "supplier", "loss_supplier_id": w.supplier})
    assert ok.status_code == 200, ok.text
    assert ok.json()["dispute"]["status"] == "resolved"
    assert await db.fetchval("SELECT ledger_posted FROM disputes WHERE id = $1", did)
