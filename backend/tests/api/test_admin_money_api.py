"""اللوحة — الدفتر والتسويات والصرف والربح والسحوبات والمخازن، على السلك.

حارس التسرّب لهذه النقاط (شرط الاستثناء 3): test_admin_guards (الصلاحية؛ متوسط تكلفة المخزن والربح
محجوبان بلا «التكاليف»؛ السحوبات للمالك وحده).
"""
from __future__ import annotations

from decimal import Decimal

from tests.api.test_admin_guards import SUP_ALL, supervisors
from tests.api.world_api import login, set_passwords
from tests.db.world import act, build, collect_all, confirm_and_assign, deliver_in_one, draft, place

H = lambda tok: {"Authorization": f"Bearer {tok}"}  # noqa: E731


async def _delivered(db, client):
    w = await build(db)
    oid = await draft(db, w)
    await place(db, w, oid)
    await confirm_and_assign(db, w, oid)
    await collect_all(db, w, oid)
    await deliver_in_one(db, w, oid)
    await set_passwords(db)
    return w, oid, (await login(client, "admin"))["access_token"]


async def test_driver_handover_and_payout(db, client):
    w, oid, tok = await _delivered(db, client)
    rows = (await client.get("/api/admin/drivers/settlement", headers=H(tok))).json()
    d = next(r for r in rows if r["id"] == w.driver)
    assert Decimal(d["cash_held"]) > 0 and Decimal(d["wallet_owed"]) > 0 and d["pay_method"] == "periodic"
    r = await client.post(f"/api/admin/drivers/{w.driver}/handover", headers=H(tok), json={"amount": d["cash_held"]})
    assert r.status_code == 200, r.text
    assert next(x for x in r.json() if x["id"] == w.driver)["cash_held"] == "0.000"
    r = await client.post(f"/api/admin/drivers/{w.driver}/payout", headers=H(tok), json={"amount": d["wallet_owed"]})
    assert r.status_code == 200 and next(x for x in r.json() if x["id"] == w.driver)["wallet_owed"] == "0.000"
    over = await client.post(f"/api/admin/drivers/{w.driver}/payout", headers=H(tok), json={"amount": "1"})
    assert over.status_code == 409 and over.json()["code"] == "payout_exceeds_wallet"


async def test_supplier_payout_against_payable(db, client):
    w, oid, tok = await _delivered(db, client)
    dues = (await client.get("/api/admin/supplier-dues", headers=H(tok))).json()
    assert next(x for x in dues if x["id"] == w.supplier)["payable"] == "1555.540"
    body = {"amount": "2000", "period_start": "2026-09-01", "period_end": "2026-09-26"}
    bad = await client.post(f"/api/admin/suppliers/{w.supplier}/payout", headers=H(tok), json=body)
    assert bad.status_code == 409 and bad.json()["code"] == "payout_exceeds_payable"
    ok = await client.post(f"/api/admin/suppliers/{w.supplier}/payout", headers=H(tok), json={**body, "amount": "1555.540"})
    assert ok.status_code == 200 and next(x for x in ok.json() if x["id"] == w.supplier)["payable"] == "0.000"


async def test_ledger_shows_balanced_transactions_with_branch(db, client):
    w, oid, tok = await _delivered(db, client)
    txns = (await client.get(f"/api/admin/ledger/transactions?order_id={oid}", headers=H(tok))).json()
    assert txns and all(sum(Decimal(e["amount"]) for e in x["entries"]) == 0 for x in txns)
    assert all(x["branch"] == "الفرع الرئيسي" for x in txns)


async def test_profit_report_names_the_cost_method_and_needs_costs(db, client):
    w, oid, tok = await _delivered(db, client)
    r = (await client.get("/api/admin/reports/profit?by=item", headers=H(tok))).json()
    assert r["lines"][0]["key"] == "طماطم" and Decimal(r["lines"][0]["gross"]) > 0
    assert r["cogs_periods"][0]["method"] == "average"
    sup = (await supervisors(db, client))[SUP_ALL]
    assert (await client.get("/api/admin/reports/profit", headers=sup)).status_code == 403


async def test_warehouse_intake_transfer_and_hidden_cost(db, client):
    w, oid, tok = await _delivered(db, client)
    a = (await client.post("/api/admin/warehouses", headers=H(tok), json={"name": "الظهرة", "lat": "32.89", "lng": "13.18",
                                                                          "address_text": "الظهرة"})).json()["id"]
    b = (await client.post("/api/admin/warehouses", headers=H(tok), json={"name": "المطار", "lat": "32.7", "lng": "13.1",
                                                                          "address_text": "طريق المطار"})).json()["id"]
    r = await client.post(f"/api/admin/warehouses/{a}/movements", headers=H(tok),
                          json={"kind": "intake", "item_id": w.item, "qty": "10", "unit_cost": "8.5"})
    assert r.status_code == 200, r.text
    r = await client.post(f"/api/admin/warehouses/{a}/movements", headers=H(tok),
                          json={"kind": "transfer", "item_id": w.item, "qty": "4", "to_warehouse_id": b})
    st = {x["warehouse"]: x for x in r.json()}
    assert (st["الظهرة"]["on_hand"], st["المطار"]["on_hand"]) == ("6", "4") and st["المطار"]["avg_cost"] == "8.500"
    sup = (await supervisors(db, client))[SUP_ALL]
    hidden = (await client.get("/api/admin/stock", headers=sup)).json()
    assert hidden and all("avg_cost" not in x and "value" not in x for x in hidden)


async def test_withdrawals_are_the_owners(db, client):
    w, oid, tok = await _delivered(db, client)
    await act(db, "admin", w.owner)
    await db.execute("INSERT INTO owner_capital_entries (city, kind, amount, occurred_on, note, created_by) "
                     "VALUES ('TIP', 'opening_cash', 1000, '2026-09-26', 'افتتاح', $1)", w.owner)
    r = await client.post("/api/admin/withdrawals", headers=H(tok), json={"amount": "300", "occurred_on": "2026-09-26", "note": "سحب"})
    assert r.status_code == 201 and r.json()["drawings_total"] == "300.000"
    assert "exceeds_profit" not in r.json()["entries"][0]          # تنبيه م-26 بانتظار اعتماد تصميمه
    sup = (await supervisors(db, client))[SUP_ALL]
    assert (await client.get("/api/admin/withdrawals", headers=sup)).status_code == 403
