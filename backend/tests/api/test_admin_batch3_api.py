"""إضافات الدفعة الثالثة المعتمدة (§12-ز)، على السلك:

- م-26: علامة تجاوز الربح في سجل السحب في الاتجاهين (شرط الاستثناء 6)، ومعاينة ما قبل التأكيد.
- الأمانة ومصيرها في اللوحة، وأمانة السائق في تطبيقه بلا تكلفة.
- إعدادا م-25 وأساس التكلفة (م-6) واستثناء الصنف.

حارس التسرّب لهذه النقاط (شرط الاستثناء 3): test_admin_guards (اللوحة) وtest_leak_responses (السائق).
"""
from __future__ import annotations

from decimal import Decimal

from tests.api.test_admin_guards import SUP_ALL, supervisors
from tests.api.world_api import live_world, login, set_passwords
from tests.db.world import act, build, collect_all, confirm_and_assign, deliver_in_one, draft, place

H = lambda tok: {"Authorization": f"Bearer {tok}"}  # noqa: E731
BODY = {"occurred_on": "2026-09-26", "note": "سحب"}


async def _profitable(db, client):
    """طلبية مسلَّمة وكاش مسلَّم للخزينة: ربح متاح ونقد يكفي."""
    w = await build(db)
    oid = await draft(db, w)
    await place(db, w, oid)
    await confirm_and_assign(db, w, oid)
    await collect_all(db, w, oid)
    await deliver_in_one(db, w, oid)
    await act(db, "admin", w.owner)
    await db.execute("INSERT INTO cash_handovers (driver_id, amount, received_by) VALUES ($1, 500, $2)", w.driver, w.owner)
    await db.execute("INSERT INTO owner_capital_entries (city, kind, amount, occurred_on, note, created_by) "
                     "VALUES ('TIP', 'opening_cash', 5000, '2026-09-26', 'افتتاح', $1)", w.owner)
    await set_passwords(db)
    return w, (await login(client, "admin"))["access_token"]


async def test_m26_mark_is_false_within_profit_and_true_above_it(db, client):
    w, tok = await _profitable(db, client)
    avail = Decimal((await client.get("/api/admin/withdrawals/preview?amount=1", headers=H(tok))).json()["profit_available"])
    assert avail > 0
    within = await client.post("/api/admin/withdrawals", headers=H(tok), json={**BODY, "amount": "1"})
    assert within.status_code == 201 and within.json()["entries"][0]["exceeds_profit"] is False
    above = await client.post("/api/admin/withdrawals", headers=H(tok), json={**BODY, "amount": str(avail + 100)})
    assert above.status_code == 201 and above.json()["entries"][0]["exceeds_profit"] is True
    assert Decimal(above.json()["entries"][0]["profit_at_time"]) == avail - 1


async def test_m26_preview_warns_but_only_the_treasury_blocks(db, client):
    w, tok = await _profitable(db, client)
    p = (await client.get("/api/admin/withdrawals/preview?amount=100000", headers=H(tok))).json()
    assert p["blocked"] is True and p["exceeds"] is True
    avail = Decimal(p["profit_available"])
    q = (await client.get(f"/api/admin/withdrawals/preview?amount={avail + 10}", headers=H(tok))).json()
    assert q["blocked"] is False and q["exceeds"] is True and q["over_by"] == "10.000"
    r = (await client.get("/api/admin/withdrawals/preview?amount=1", headers=H(tok))).json()
    assert (r["blocked"], r["exceeds"], r["over_by"]) == (False, False, "0.000")


async def _custody(db, client):
    w = await build(db)
    await act(db, "admin", w.owner)
    await db.execute("UPDATE city_settings SET cancel_policy = 'anytime'")
    oid = await draft(db, w)
    await place(db, w, oid)
    await confirm_and_assign(db, w, oid)
    await collect_all(db, w, oid)
    await act(db, "customer", w.cust_user)
    await db.execute("UPDATE orders SET status = 'cancelled' WHERE id = $1", oid)
    await set_passwords(db)
    return w, oid, (await login(client, "admin"))["access_token"]


async def test_custody_listed_and_decided_from_the_panel(db, client):
    w, oid, tok = await _custody(db, client)
    lst = (await client.get("/api/admin/custody", headers=H(tok))).json()
    assert len(lst) == 1 and lst[0]["value"] == "1555.540" and lst[0]["status"] == "open"
    did = lst[0]["dispute_id"]
    assert (await client.get(f"/api/admin/disputes/{did}/custody", headers=H(tok))).json()[0]["id"] == lst[0]["id"]
    sup = (await supervisors(db, client))[SUP_ALL]
    hidden = (await client.get("/api/admin/custody", headers=sup)).json()
    assert "unit_cost" not in hidden[0] and "value" not in hidden[0]
    r = await client.post(f"/api/admin/custody/{lst[0]['id']}/decide", headers=H(tok), json={"fate": "return_supplier"})
    assert r.status_code == 200 and r.json()[0]["status"] == "resolved"
    again = await client.post(f"/api/admin/custody/{lst[0]['id']}/decide", headers=H(tok), json={"fate": "return_supplier"})
    assert again.status_code == 409 and again.json()["code"] == "custody_already_decided"


async def test_driver_sees_custody_item_and_qty_only(db, client):
    w, oid, tok = await _custody(db, client)
    drv = (await login(client, "driver"))["access_token"]
    r = await client.get("/api/driver/custody", headers=H(drv))
    assert r.status_code == 200 and r.json()[0]["qty"] == "2"
    assert "777.77" not in r.text and "SUPPLIER" not in r.text and "unit_cost" not in r.text


async def test_settings_m25_and_cost_basis(db, client):
    live = await live_world(db, client)
    r = await client.put("/api/admin/settings", headers=live.auth("admin"),
                         json={"fee_conflict_rule": "higher", "cost_guard_basis": "first_priority"})
    assert (r.json()["fee_conflict_rule"], r.json()["cost_guard_basis"]) == ("higher", "first_priority")
    bad = await client.put("/api/admin/settings", headers=live.auth("admin"), json={"area_overlap_rule": "higher"})
    assert bad.status_code == 422                         # م-27 بانتظار اعتماد تصميمه


async def test_item_cost_basis_exception(db, client):
    live = await live_world(db, client)
    url = f"/api/admin/catalog/{live.w.item}/pricing"
    r = await client.put(url, headers=live.auth("admin"), json={"mode": "margin_pct", "margin_value": "17.17",
                                                                "cost_basis_override": "first_priority"})
    assert r.status_code == 200 and r.json()["cost_basis_override"] == "first_priority"
    r = await client.put(url, headers=live.auth("admin"), json={"mode": "margin_pct", "margin_value": "17.17"})
    assert r.json()["cost_basis_override"] is None
