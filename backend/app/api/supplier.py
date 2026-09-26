"""موجّه المورد. يقرأ من v_supplier_pickups وحده، ولا يرى إلا نقاط مورده."""
from __future__ import annotations

from fastapi import APIRouter, Depends, Request, Response

from app.api.deps import Principal, supplier_user
from app.core.db import Tx
from app.core.errors import ApiError
from app.schemas.common import HandoverOut
from app.schemas.supplier import MeOut, PickupLineOut, PickupOut, ScanIn
from app.services import documents

router = APIRouter(prefix="/api/supplier", tags=["supplier"])


async def _supplier(t: Tx, user_id: int) -> dict:
    row = await t.one("SELECT s.id, s.name, s.status::text AS status FROM supplier_members m "
                      "JOIN suppliers s ON s.id = m.supplier_id WHERE m.user_id = :u ORDER BY s.id LIMIT 1", u=user_id)
    if row is None:
        raise ApiError(404, "no_supplier")
    return row


async def load_pickups(t: Tx, user_id: int, stop_id: int | None = None) -> list[PickupOut]:
    s = await _supplier(t, user_id)
    rows = await t.all(
        "SELECT id, status::text AS status, supplier_code, handed_over, assigned_at, product_name, "
        "unit::text AS unit, unit_size, planned_qty, collected_qty FROM v_supplier_pickups "
        "WHERE supplier_id = :s AND (CAST(:stop AS bigint) IS NULL OR id = :stop) ORDER BY id, line_id",
        s=s["id"], stop=stop_id)
    out: dict[int, PickupOut] = {}
    for r in rows:
        p = out.get(r["id"]) or out.setdefault(r["id"], PickupOut(
            id=r["id"], status=r["status"], supplier_code=r["supplier_code"], handed_over=r["handed_over"],
            assigned_at=r["assigned_at"], lines=[]))
        p.lines.append(PickupLineOut(product_name=r["product_name"], unit=r["unit"], unit_size=r["unit_size"],
                                     planned_qty=r["planned_qty"], collected_qty=r["collected_qty"]))
    return list(out.values())


@router.get("/me", response_model=MeOut)
async def me(request: Request, p: Principal = Depends(supplier_user)) -> MeOut:
    async with request.app.state.db.tx("supplier", p.user_id) as t:
        name = await t.val("SELECT full_name FROM app_users WHERE id = :u", u=p.user_id)
        s = await _supplier(t, p.user_id)
    return MeOut(full_name=name, name=s["name"], status=s["status"])


@router.get("/pickups", response_model=list[PickupOut])
async def pickups(request: Request, p: Principal = Depends(supplier_user)) -> list[PickupOut]:
    async with request.app.state.db.tx("supplier", p.user_id) as t:
        return await load_pickups(t, p.user_id)


@router.post("/pickups/{stop_id}/scan", response_model=HandoverOut)
async def scan(stop_id: int, body: ScanIn, request: Request, p: Principal = Depends(supplier_user)) -> HandoverOut:
    """م-3 (أ): المورد يمسح رمز QR في هاتف السائق. المطابقة والصلاحية في القاعدة (trg_handover_before)."""
    async with request.app.state.db.tx("supplier", p.user_id) as t:
        s = await _supplier(t, p.user_id)
        if not await t.val("SELECT 1 FROM pickup_stops WHERE id = :i AND supplier_id = :s", i=stop_id, s=s["id"]):
            raise ApiError(404, "stop_not_found")
        await t.run("INSERT INTO pickup_handovers (stop_id, method, code_given) VALUES (:i, 'qr_scan', :c)",
                    i=stop_id, c=body.code)
    return HandoverOut(handed_over=True, method="qr_scan")


@router.get("/pickups/{stop_id}/slip.pdf", response_class=Response,
            responses={200: {"content": {"application/pdf": {}}}})
async def slip(stop_id: int, request: Request, p: Principal = Depends(supplier_user)) -> Response:
    async with request.app.state.db.tx("supplier", p.user_id) as t:
        found = await load_pickups(t, p.user_id, stop_id)
    if not found:
        raise ApiError(404, "stop_not_found")
    return Response(documents.supplier_slip(found[0]), media_type="application/pdf")
