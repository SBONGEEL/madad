"""موجّه لوحة المالك — الشريحة الأولى: إعدادات الإظهار (م-2، م-19)، ورأس المال،
وتكلفة الطلبية. الصلاحيات تُفحص في القاعدة (require_admin / require_owner)."""
from __future__ import annotations

from fastapi import APIRouter, Depends, Request

from app.api.deps import Principal, admin_user
from app.core.db import Tx
from app.core.errors import ApiError
from app.schemas.admin import CapitalEntryOut, CapitalIn, CapitalOut, CostLineOut, MeOut, Visibility

router = APIRouter(prefix="/api/admin", tags=["admin"])

VIS_COLS = "driver_sees_supplier_name, customer_sees_driver_name, customer_can_call_driver"


async def _require(t: Tx, perm: str) -> None:
    await t.run("SELECT require_admin(CAST(:p AS admin_permission))", p=perm)


def _city(request: Request) -> str:
    return request.app.state.settings.auth_city


@router.get("/me", response_model=MeOut)
async def me(request: Request, p: Principal = Depends(admin_user)) -> MeOut:
    async with request.app.state.db.tx("admin", p.user_id) as t:
        row = await t.one("SELECT u.full_name, m.role::text AS role FROM admin_members m JOIN app_users u "
                          "ON u.id = m.user_id WHERE m.user_id = :u", u=p.user_id)
        if row is None:
            raise ApiError(403, "forbidden_role")
        perms = [r["permission"] for r in await t.all(
            "SELECT permission::text AS permission FROM admin_permissions WHERE user_id = :u ORDER BY 1", u=p.user_id)]
    return MeOut(**row, permissions=perms)


@router.get("/settings/visibility", response_model=Visibility)
async def get_visibility(request: Request, p: Principal = Depends(admin_user)) -> Visibility:
    async with request.app.state.db.tx("admin", p.user_id) as t:
        await _require(t, "settings")
        return Visibility(**await t.one(f"SELECT {VIS_COLS} FROM city_settings WHERE city = :c", c=_city(request)))


@router.put("/settings/visibility", response_model=Visibility)
async def put_visibility(body: Visibility, request: Request, p: Principal = Depends(admin_user)) -> Visibility:
    async with request.app.state.db.tx("admin", p.user_id) as t:
        row = await t.one(
            "UPDATE city_settings SET driver_sees_supplier_name = :a, customer_sees_driver_name = :b, "
            f"customer_can_call_driver = :c WHERE city = :city RETURNING {VIS_COLS}",
            a=body.driver_sees_supplier_name, b=body.customer_sees_driver_name, c=body.customer_can_call_driver,
            city=_city(request))
    return Visibility(**row)


async def _capital(t: Tx, city: str) -> CapitalOut:
    rows = await t.all("SELECT e.id, e.kind::text AS kind, e.amount, e.occurred_on, e.note, "
                       "u.full_name AS created_by_name, e.created_at FROM owner_capital_entries e "
                       "JOIN app_users u ON u.id = e.created_by WHERE e.city = :c ORDER BY e.occurred_on DESC, e.id DESC",
                       c=city)
    # الرصيد من الدفتر وحده (دائن حساب رأس المال)، لا من جمع السجل
    bal = await t.val("SELECT coalesce((SELECT -balance FROM ledger_accounts WHERE kind = 'owner_equity' "
                      "AND city = :c), 0)", c=city)
    return CapitalOut(equity_balance=bal, entries=[CapitalEntryOut(**r) for r in rows])


@router.get("/capital", response_model=CapitalOut)
async def get_capital(request: Request, p: Principal = Depends(admin_user)) -> CapitalOut:
    async with request.app.state.db.tx("admin", p.user_id) as t:
        await _require(t, "money")
        return await _capital(t, _city(request))


@router.post("/capital", response_model=CapitalOut, status_code=201)
async def post_capital(body: CapitalIn, request: Request, p: Principal = Depends(admin_user)) -> CapitalOut:
    async with request.app.state.db.tx("admin", p.user_id) as t:
        await t.run("INSERT INTO owner_capital_entries (city, kind, amount, occurred_on, note, created_by) "
                    "VALUES (:c, CAST(:k AS capital_kind), :a, :d, :n, :u)", c=_city(request), k=body.kind.value,
                    a=body.amount, d=body.occurred_on, n=body.note.strip(), u=p.user_id)
        return await _capital(t, _city(request))


@router.get("/orders/{order_id}/costs", response_model=list[CostLineOut])
async def order_costs(order_id: int, request: Request, p: Principal = Depends(admin_user)) -> list[CostLineOut]:
    async with request.app.state.db.tx("admin", p.user_id) as t:
        await _require(t, "costs_view")
        rows = await t.all(
            "SELECT s.id AS stop_id, ci.name_ar, sp.name AS supplier_name, so.purchase_price, c.unit_cost, "
            "l.planned_qty, round(l.planned_qty * c.unit_cost, 3) AS line_cost "
            "FROM pickup_stop_lines l JOIN pickup_stops s ON s.id = l.stop_id "
            "JOIN pickup_line_costs c ON c.stop_line_id = l.id "
            "JOIN order_items oi ON oi.id = l.order_item_id JOIN catalog_items ci ON ci.id = oi.catalog_item_id "
            "LEFT JOIN supplier_offers so ON so.id = l.offer_id LEFT JOIN suppliers sp ON sp.id = s.supplier_id "
            "WHERE s.order_id = :o ORDER BY s.seq, l.id", o=order_id)
    return [CostLineOut(**r) for r in rows]
