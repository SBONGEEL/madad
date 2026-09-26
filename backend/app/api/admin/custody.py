"""اللوحة — الأمانات بعهدة السائقين ومصير بضاعة الإلغاء بعد الجمع (معتمد في §12-ز).

القيود (مخزن/عكس مستحق المورد/نقطة «من السائق» في طلبية أخرى) تكتبها القاعدة (trg_custody_*).
التكلفة وقيمة الأمانة تُحجبان بلا «التكاليف».
"""
from __future__ import annotations

from fastapi import APIRouter, Depends, Request

from app.api.admin.common import P, city, sees_costs
from app.api.deps import Principal, admin_user
from app.core.db import Tx
from app.schemas.admin import CustodyDecideIn, CustodyOut

router = APIRouter()

SQL = """
SELECT dc.id, dc.order_id, dc.dispute_id, dc.driver_id, d.full_name AS driver_name, ci.name_ar AS item, dc.qty,
       coalesce(sp.name, w.name) AS source, dc.status::text AS status, dc.fate::text AS fate,
       coalesce(tw.name, '#' || dc.target_order_id) AS target, dc.created_at, dc.unit_cost,
       round(dc.qty * dc.unit_cost, 3) AS value
  FROM driver_custody dc JOIN drivers d ON d.id = dc.driver_id JOIN catalog_items ci ON ci.id = dc.catalog_item_id
  LEFT JOIN suppliers sp ON sp.id = dc.supplier_id LEFT JOIN warehouses w ON w.id = dc.warehouse_id
  LEFT JOIN warehouses tw ON tw.id = dc.target_warehouse_id
"""


async def _list(t: Tx, where: str, hide: bool, **params) -> list[CustodyOut]:
    rows = await t.all(SQL + " WHERE " + where + " ORDER BY dc.status, dc.id", **params)
    return [CustodyOut(**r).hide_costs(hide) for r in rows]


@router.get("/custody", response_model=list[CustodyOut], **P("orders"))
async def custody(request: Request, open_only: bool = True, p: Principal = Depends(admin_user)) -> list[CustodyOut]:
    async with request.app.state.db.tx("admin", p.user_id) as t:
        return await _list(t, "d.city = :c AND (NOT :o OR dc.status <> 'resolved')", not await sees_costs(t, p.user_id),
                           c=city(request), o=open_only)


@router.get("/disputes/{dispute_id}/custody", response_model=list[CustodyOut], **P("orders"))
async def dispute_custody(dispute_id: int, request: Request, p: Principal = Depends(admin_user)) -> list[CustodyOut]:
    async with request.app.state.db.tx("admin", p.user_id) as t:
        return await _list(t, "dc.order_id = (SELECT order_id FROM disputes WHERE id = :i)",
                           not await sees_costs(t, p.user_id), i=dispute_id)


@router.post("/custody/{custody_id}/decide", response_model=list[CustodyOut], **P("orders"))
async def decide(custody_id: int, body: CustodyDecideIn, request: Request, p: Principal = Depends(admin_user)) -> list[CustodyOut]:
    async with request.app.state.db.tx("admin", p.user_id) as t:
        await t.run("UPDATE driver_custody SET fate = CAST(:f AS custody_fate), target_warehouse_id = :w, target_order_id = :o "
                    "WHERE id = :i", f=body.fate, w=body.target_warehouse_id, o=body.target_order_id, i=custody_id)
        return await _list(t, "dc.id = :i", not await sees_costs(t, p.user_id), i=custody_id)
