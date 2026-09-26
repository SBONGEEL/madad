"""اللوحة — المخازن: المخزون ومتوسط التكلفة (تكلفة: تُحجب بلا «التكاليف»)، والإدخال والجرد والتحويل.

الحركات تكتبها القاعدة وقيودها (trg_stock_movement_*)؛ طريقة التكلفة للخارج بحسب م-12.
"""
from __future__ import annotations

import uuid

from fastapi import APIRouter, Depends, Request

from app.api.admin.common import P, city, sees_costs
from app.api.deps import Principal, admin_user
from app.core.db import Tx
from app.core.errors import ApiError
from app.schemas.admin import MovementIn, StockOut, WarehouseIn, WarehouseOut

router = APIRouter()


async def _stock(t: Tx, c: str, hide: bool, warehouse_id: int | None = None) -> list[StockOut]:
    rows = await t.all(
        "SELECT ws.warehouse_id, w.name AS warehouse, ws.catalog_item_id AS item_id, ci.name_ar AS item, ws.on_hand, "
        "ws.reserved_qty AS reserved, ws.available_qty AS available, ws.avg_cost, round(ws.on_hand * ws.avg_cost, 3) AS value "
        "FROM warehouse_stock ws JOIN warehouses w ON w.id = ws.warehouse_id JOIN catalog_items ci ON ci.id = ws.catalog_item_id "
        "WHERE w.city = :c AND (CAST(:w AS bigint) IS NULL OR w.id = :w) ORDER BY w.name, ci.name_ar", c=c, w=warehouse_id)
    return [StockOut(**r).hide_costs(hide) for r in rows]


@router.get("/warehouses", response_model=list[WarehouseOut], **P("warehouses"))
async def warehouses(request: Request, p: Principal = Depends(admin_user)) -> list[WarehouseOut]:
    async with request.app.state.db.tx("admin", p.user_id) as t:
        rows = await t.all("SELECT w.id, w.name, w.address_text, w.active, "
                           "(SELECT count(*) FROM warehouse_stock s WHERE s.warehouse_id = w.id AND s.on_hand > 0) AS items "
                           "FROM warehouses w WHERE w.city = :c ORDER BY w.name", c=city(request))
    return [WarehouseOut(**r) for r in rows]


@router.post("/warehouses", response_model=WarehouseOut, status_code=201, **P("warehouses"))
async def add_warehouse(body: WarehouseIn, request: Request, p: Principal = Depends(admin_user)) -> WarehouseOut:
    async with request.app.state.db.tx("admin", p.user_id) as t:
        r = await t.one("INSERT INTO warehouses (city, name, lat, lng, address_text) VALUES (:c, :n, :la, :lo, :a) "
                        "RETURNING id, name, address_text, active, 0 AS items", c=city(request), n=body.name.strip(),
                        la=body.lat, lo=body.lng, a=body.address_text.strip())
    return WarehouseOut(**r)


@router.get("/stock", response_model=list[StockOut], **P("warehouses"))
async def stock(request: Request, warehouse_id: int | None = None, p: Principal = Depends(admin_user)) -> list[StockOut]:
    async with request.app.state.db.tx("admin", p.user_id) as t:
        return await _stock(t, city(request), not await sees_costs(t, p.user_id), warehouse_id)


@router.post("/warehouses/{warehouse_id}/movements", response_model=list[StockOut], **P("warehouses"))
async def move(warehouse_id: int, body: MovementIn, request: Request, p: Principal = Depends(admin_user)) -> list[StockOut]:
    async with request.app.state.db.tx("admin", p.user_id) as t:
        if body.kind == "intake":
            if body.qty <= 0 or body.unit_cost is None:
                raise ApiError(422, "intake_needs_qty_and_cost")
            await t.run("INSERT INTO stock_movements (warehouse_id, catalog_item_id, kind, qty_delta, unit_cost, supplier_id, note) "
                        "VALUES (:w, :i, 'intake', :q, :c, :s, :n)", w=warehouse_id, i=body.item_id, q=body.qty,
                        c=body.unit_cost, s=body.supplier_id, n=body.note)
        elif body.kind == "count_adjust":
            await t.run("INSERT INTO stock_movements (warehouse_id, catalog_item_id, kind, qty_delta, note) "
                        "VALUES (:w, :i, 'count_adjust', :q, :n)", w=warehouse_id, i=body.item_id, q=body.qty, n=body.note)
        else:
            if body.qty <= 0 or body.to_warehouse_id is None:
                raise ApiError(422, "transfer_needs_qty_and_target")
            tid = str(uuid.uuid4())
            await t.run("INSERT INTO stock_movements (warehouse_id, catalog_item_id, kind, qty_delta, transfer_id, note) "
                        "VALUES (:w, :i, 'transfer_out', :q, CAST(:t AS uuid), :n)", w=warehouse_id, i=body.item_id,
                        q=-body.qty, t=tid, n=body.note)
            await t.run("INSERT INTO stock_movements (warehouse_id, catalog_item_id, kind, qty_delta, transfer_id, note) "
                        "VALUES (:w, :i, 'transfer_in', :q, CAST(:t AS uuid), :n)", w=body.to_warehouse_id, i=body.item_id,
                        q=body.qty, t=tid, n=body.note)
        return await _stock(t, city(request), not await sees_costs(t, p.user_id))
