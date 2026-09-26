"""اللوحة — الدفتر، وتسوية السائقين (م-11)، وصرف الموردين، والمصروفات، وتقرير الربح (م-12)، والسحوبات (م-21).

كل حركة مال تكتبها القاعدة قيداً مزدوجاً (مشغّلات cash_handovers/driver_payouts/supplier_payouts/…).
تنبيه «السحب يتجاوز الربح» قبل التأكيد (م-26) إضافةٌ بانتظار اعتماد تصميمها: لا نقطة لها بعد.
"""
from __future__ import annotations

from datetime import date, timedelta

from fastapi import APIRouter, Depends, Request

from app.api.admin.common import P, city
from app.api.deps import Principal, admin_user
from app.core.db import Tx
from app.core.errors import ApiError
from app.schemas.admin import (AccountOut, DriverSettleOut, EntryOut, ExpenseIn, HandoverIn, PayMethodIn, PayoutIn,
                               ProfitLineOut, ProfitOut, SupplierDueOut, SupplierPayoutIn, TxnOut, WithdrawalIn,
                               WithdrawalOut, WithdrawalsOut)

router = APIRouter()

PARTY = ("coalesce(c.name, d.full_name, s.name, w.name)")
ACC_JOIN = ("FROM ledger_accounts a LEFT JOIN customers c ON c.id = a.customer_id LEFT JOIN drivers d ON d.id = a.driver_id "
            "LEFT JOIN suppliers s ON s.id = a.supplier_id LEFT JOIN warehouses w ON w.id = a.warehouse_id")


@router.get("/ledger/accounts", response_model=list[AccountOut], **P("money"))
async def accounts(request: Request, p: Principal = Depends(admin_user)) -> list[AccountOut]:
    async with request.app.state.db.tx("admin", p.user_id) as t:
        rows = await t.all(f"SELECT a.id, a.kind::text AS kind, {PARTY} AS party, a.balance {ACC_JOIN} "
                           "WHERE a.city = :c ORDER BY a.kind, party", c=city(request))
    return [AccountOut(**r) for r in rows]


@router.get("/ledger/transactions", response_model=list[TxnOut], **P("money"))
async def transactions(request: Request, kind: str | None = None, order_id: int | None = None,
                       account_id: int | None = None, p: Principal = Depends(admin_user)) -> list[TxnOut]:
    async with request.app.state.db.tx("admin", p.user_id) as t:
        txns = await t.all(
            "SELECT t.id, t.kind::text AS kind, t.memo, t.order_id, br.name AS branch, t.occurred_at, "
            "coalesce(u.full_name, t.actor_role) AS actor FROM ledger_transactions t "
            "LEFT JOIN customer_locations br ON br.id = t.branch_id LEFT JOIN app_users u ON u.id = t.actor_id "
            "WHERE t.city = :c AND (CAST(:k AS text) IS NULL OR t.kind::text = :k) "
            "AND (CAST(:o AS bigint) IS NULL OR t.order_id = :o) "
            "AND (CAST(:a AS bigint) IS NULL OR EXISTS (SELECT 1 FROM ledger_entries e WHERE e.transaction_id = t.id "
            "AND e.account_id = :a)) ORDER BY t.id DESC LIMIT 200", c=city(request), k=kind, o=order_id, a=account_id)
        ents = await t.all(f"SELECT e.transaction_id, a.kind::text || coalesce(' — ' || {PARTY}, '') AS account, e.amount "
                           f"FROM ledger_entries e JOIN ledger_accounts a ON a.id = e.account_id "
                           f"LEFT JOIN customers c ON c.id = a.customer_id LEFT JOIN drivers d ON d.id = a.driver_id "
                           f"LEFT JOIN suppliers s ON s.id = a.supplier_id LEFT JOIN warehouses w ON w.id = a.warehouse_id "
                           f"WHERE e.transaction_id = ANY(:ids) ORDER BY e.id", ids=[x["id"] for x in txns] or [0])
    return [TxnOut(**x, entries=[EntryOut(account=e["account"], amount=e["amount"]) for e in ents
                                 if e["transaction_id"] == x["id"]]) for x in txns]


# ——— تسوية السائقين (م-11) ————————————————————————————————————————————————————
async def _drivers(t: Tx, c: str) -> list[DriverSettleOut]:
    cap = await t.val("SELECT driver_cash_cap FROM city_settings WHERE city = :c", c=c)
    rows = await t.all(
        "SELECT d.id, d.full_name, d.pay_method::text AS pay_method, "
        "coalesce((SELECT balance FROM ledger_accounts WHERE kind = 'driver_cash' AND driver_id = d.id), 0) AS cash_held, "
        "-coalesce((SELECT balance FROM ledger_accounts WHERE kind = 'driver_wallet' AND driver_id = d.id), 0) AS wallet_owed "
        "FROM drivers d WHERE d.city = :c AND d.status = 'approved' ORDER BY d.full_name", c=c)
    return [DriverSettleOut(**r, cash_cap=cap, over_cap=cap is not None and r["cash_held"] > cap) for r in rows]


@router.get("/drivers/settlement", response_model=list[DriverSettleOut], **P("money"))
async def settlement(request: Request, p: Principal = Depends(admin_user)) -> list[DriverSettleOut]:
    async with request.app.state.db.tx("admin", p.user_id) as t:
        return await _drivers(t, city(request))


@router.post("/drivers/{driver_id}/handover", response_model=list[DriverSettleOut], **P("money"))
async def handover(driver_id: int, body: HandoverIn, request: Request, p: Principal = Depends(admin_user)) -> list[DriverSettleOut]:
    async with request.app.state.db.tx("admin", p.user_id) as t:
        await t.run("INSERT INTO cash_handovers (driver_id, amount, received_by, note, wallet_offset) "
                    "VALUES (:d, :a, :u, :n, :w)", d=driver_id, a=body.amount, u=p.user_id, n=body.note, w=body.wallet_offset)
        return await _drivers(t, city(request))


@router.post("/drivers/{driver_id}/payout", response_model=list[DriverSettleOut], **P("money"))
async def driver_payout(driver_id: int, body: PayoutIn, request: Request, p: Principal = Depends(admin_user)) -> list[DriverSettleOut]:
    async with request.app.state.db.tx("admin", p.user_id) as t:
        await t.run("INSERT INTO driver_payouts (driver_id, amount, paid_by, note) VALUES (:d, :a, :u, :n)",
                    d=driver_id, a=body.amount, u=p.user_id, n=body.note)
        return await _drivers(t, city(request))


@router.put("/drivers/{driver_id}/pay-method", response_model=list[DriverSettleOut], **P("money"))
async def pay_method(driver_id: int, body: PayMethodIn, request: Request, p: Principal = Depends(admin_user)) -> list[DriverSettleOut]:
    async with request.app.state.db.tx("admin", p.user_id) as t:
        await t.run("UPDATE drivers SET pay_method = CAST(:m AS driver_pay_method) WHERE id = :d", m=body.pay_method, d=driver_id)
        return await _drivers(t, city(request))


# ——— صرف الموردين والمصروفات ——————————————————————————————————————————————————
async def _dues(t: Tx, c: str) -> list[SupplierDueOut]:
    rows = await t.all(
        "SELECT s.id, s.name, s.payout_cycle::text AS payout_cycle, "
        "-coalesce((SELECT balance FROM ledger_accounts WHERE kind = 'supplier_payable' AND supplier_id = s.id), 0) AS payable, "
        "(SELECT max(created_at) FROM supplier_payouts WHERE supplier_id = s.id) AS last_payout "
        "FROM suppliers s WHERE s.city = :c AND s.status IN ('approved', 'suspended') ORDER BY payable DESC, s.name", c=c)
    return [SupplierDueOut(**r) for r in rows]


@router.get("/supplier-dues", response_model=list[SupplierDueOut], **P("money"))
async def dues(request: Request, p: Principal = Depends(admin_user)) -> list[SupplierDueOut]:
    async with request.app.state.db.tx("admin", p.user_id) as t:
        return await _dues(t, city(request))


@router.post("/suppliers/{supplier_id}/payout", response_model=list[SupplierDueOut], **P("money"))
async def supplier_payout(supplier_id: int, body: SupplierPayoutIn, request: Request,
                          p: Principal = Depends(admin_user)) -> list[SupplierDueOut]:
    async with request.app.state.db.tx("admin", p.user_id) as t:
        await t.run("INSERT INTO supplier_payouts (supplier_id, amount, period_start, period_end, paid_by) "
                    "VALUES (:s, :a, :f, :e, :u)", s=supplier_id, a=body.amount, f=body.period_start, e=body.period_end,
                    u=p.user_id)
        return await _dues(t, city(request))


@router.post("/expenses", response_model=list[AccountOut], status_code=201, **P("money"))
async def expense(body: ExpenseIn, request: Request, p: Principal = Depends(admin_user)) -> list[AccountOut]:
    async with request.app.state.db.tx("admin", p.user_id) as t:
        await t.run("INSERT INTO expenses (city, category, amount, spent_on, note, created_by) VALUES (:c, :k, :a, :d, :n, :u)",
                    c=city(request), k=body.category.strip(), a=body.amount, d=body.spent_on, n=body.note, u=p.user_id)
    return await accounts(request, p)


# ——— تقرير الربح (م-12: يذكر طريقة تكلفة المخزن لكل فترة) ——————————————————————————————
BY = {"item": "ci.name_ar", "customer": "c.name", "order": "'#' || o.id", "day": "to_char(o.delivered_at, 'YYYY-MM-DD')"}


@router.get("/reports/profit", response_model=ProfitOut, **P("costs_view"))
async def profit(request: Request, date_from: date | None = None, date_to: date | None = None, by: str = "item",
                 p: Principal = Depends(admin_user)) -> ProfitOut:
    if by not in BY:
        raise ApiError(422, "by_invalid")
    date_to = date_to or date.today()
    date_from = date_from or date_to.replace(day=1)
    c = city(request)
    async with request.app.state.db.tx("admin", p.user_id) as t:
        rng = {"c": c, "f": date_from, "t": date_to + timedelta(days=1)}
        tot = await t.one(
            "SELECT coalesce(-sum(e.amount) FILTER (WHERE a.kind IN ('sales_revenue', 'delivery_fee_revenue', 'sales_adjustment')), 0) AS sales, "
            "coalesce(sum(e.amount) FILTER (WHERE a.kind = 'cost_of_goods'), 0) AS cost, "
            "coalesce(sum(e.amount) FILTER (WHERE a.kind = 'driver_pay_expense'), 0) AS driver_pay, "
            "coalesce(sum(e.amount) FILTER (WHERE a.kind = 'operating_expense'), 0) AS expenses "
            "FROM ledger_entries e JOIN ledger_transactions x ON x.id = e.transaction_id JOIN ledger_accounts a ON a.id = e.account_id "
            "WHERE x.city = :c AND x.occurred_at >= :f AND x.occurred_at < :t", **rng)
        lines = await t.all(f"""
SELECT {BY[by]} AS key, CASE WHEN :by = 'item' THEN sum(oi.delivered_qty) END AS qty,
       coalesce(sum(round(oi.delivered_qty * oi.unit_price, 3)), 0) AS sales,
       coalesce(sum((SELECT sum(round(l.collected_qty * pc.unit_cost, 3)) FROM pickup_stop_lines l
                      JOIN pickup_line_costs pc ON pc.stop_line_id = l.id WHERE l.order_item_id = oi.id)), 0) AS cost
  FROM orders o JOIN order_items oi ON oi.order_id = o.id JOIN catalog_items ci ON ci.id = oi.catalog_item_id
  JOIN customers c ON c.id = o.customer_id
 WHERE o.city = :c AND o.delivered_at >= :f AND o.delivered_at < :t
 GROUP BY 1 ORDER BY 3 DESC""", by=by, **rng)
        periods = await t.all("SELECT method::text AS method, effective_from FROM cogs_method_periods WHERE city = :c "
                              "AND effective_from < :t ORDER BY effective_from", c=c, t=rng["t"])
    kept = [x for i, x in enumerate(periods) if i + 1 == len(periods) or periods[i + 1]["effective_from"].date() > date_from]
    return ProfitOut(date_from=date_from, date_to=date_to, **tot,
                     profit=tot["sales"] - tot["cost"] - tot["driver_pay"] - tot["expenses"],
                     cogs_periods=[{"method": x["method"], "from": x["effective_from"].isoformat()} for x in kept], by=by,
                     lines=[ProfitLineOut(**r, gross=r["sales"] - r["cost"]) for r in lines])


# ——— سحوبات المالك (م-21) ——————————————————————————————————————————————————————
async def _withdrawals(t: Tx, c: str) -> WithdrawalsOut:
    rows = await t.all("SELECT w.id, w.amount, w.occurred_on, w.note, u.full_name AS created_by_name, w.created_at "
                       "FROM owner_withdrawals w JOIN app_users u ON u.id = w.created_by WHERE w.city = :c "
                       "ORDER BY w.occurred_on DESC, w.id DESC", c=c)
    treasury = await t.val("SELECT ledger_balance('treasury', :c)", c=c)
    drawn = await t.val("SELECT coalesce((SELECT balance FROM ledger_accounts WHERE kind = 'owner_drawings' AND city = :c), 0)", c=c)
    return WithdrawalsOut(treasury=treasury, drawings_total=drawn, entries=[WithdrawalOut(**r) for r in rows])


@router.get("/withdrawals", response_model=WithdrawalsOut, **P("owner"))
async def withdrawals(request: Request, p: Principal = Depends(admin_user)) -> WithdrawalsOut:
    async with request.app.state.db.tx("admin", p.user_id) as t:
        return await _withdrawals(t, city(request))


@router.post("/withdrawals", response_model=WithdrawalsOut, status_code=201, **P("owner"))
async def withdraw(body: WithdrawalIn, request: Request, p: Principal = Depends(admin_user)) -> WithdrawalsOut:
    async with request.app.state.db.tx("admin", p.user_id) as t:
        await t.run("INSERT INTO owner_withdrawals (city, amount, occurred_on, note, created_by) VALUES (:c, :a, :d, :n, :u)",
                    c=city(request), a=body.amount, d=body.occurred_on, n=body.note.strip(), u=p.user_id)
        return await _withdrawals(t, city(request))
