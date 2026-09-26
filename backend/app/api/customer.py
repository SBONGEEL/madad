"""موجّه العميل. يقرأ من عروض العميل (v_customer_*) وحدها، ولا يرى إلا منشأته."""
from __future__ import annotations

from fastapi import APIRouter, Depends, Request, Response

from app.api.deps import Principal, customer_user
from app.core.db import Tx
from app.core.errors import ApiError
from app.schemas.customer import (CatalogItemOut, CategoryOut, CustomerOut, DriverCardOut, MeOut, OrderLineOut,
                                  OrderOut, OrderSummaryOut)
from app.services import documents

router = APIRouter(prefix="/api/customer", tags=["customer"])


async def _customer(t: Tx, user_id: int) -> dict:
    row = await t.one("SELECT c.id, c.name, c.city, c.status::text AS status FROM customer_members m "
                      "JOIN customers c ON c.id = m.customer_id WHERE m.user_id = :u ORDER BY c.id LIMIT 1", u=user_id)
    if row is None:
        raise ApiError(404, "no_establishment")
    return row


@router.get("/me", response_model=MeOut)
async def me(request: Request, p: Principal = Depends(customer_user)) -> MeOut:
    async with request.app.state.db.tx("customer", p.user_id) as t:
        name = await t.val("SELECT full_name FROM app_users WHERE id = :u", u=p.user_id)
        c = await t.one("SELECT c.id, c.name, c.status::text AS status FROM customer_members m "
                        "JOIN customers c ON c.id = m.customer_id WHERE m.user_id = :u ORDER BY c.id LIMIT 1",
                        u=p.user_id)
    return MeOut(full_name=name, customer=CustomerOut(**c) if c else None)


@router.get("/categories", response_model=list[CategoryOut])
async def categories(request: Request, p: Principal = Depends(customer_user)) -> list[CategoryOut]:
    async with request.app.state.db.tx("customer", p.user_id) as t:
        rows = await t.all("SELECT id, parent_id, name_ar, name_en, icon_key FROM categories WHERE active "
                           "ORDER BY sort, id")
    top = [r for r in rows if r["parent_id"] is None]
    return [CategoryOut(id=c["id"], name_ar=c["name_ar"], name_en=c["name_en"], icon_key=c["icon_key"],
                        children=[CategoryOut(id=k["id"], name_ar=k["name_ar"], name_en=k["name_en"],
                                              icon_key=k["icon_key"])
                                  for k in rows if k["parent_id"] == c["id"]])
            for c in top]


@router.get("/catalog", response_model=list[CatalogItemOut])
async def catalog(request: Request, category_id: int | None = None,
                  p: Principal = Depends(customer_user)) -> list[CatalogItemOut]:
    async with request.app.state.db.tx("customer", p.user_id) as t:
        c = await _customer(t, p.user_id)
        rows = await t.all(
            "SELECT id, category_id, name_ar, name_en, unit::text AS unit, unit_size, sale_price, orderable, "
            "out_of_stock FROM v_customer_catalog WHERE city = :city AND (CAST(:cat AS bigint) IS NULL OR "
            "category_id IN (SELECT id FROM categories WHERE id = :cat OR parent_id = :cat)) ORDER BY name_ar",
            city=c["city"], cat=category_id)
    return [CatalogItemOut(**r) for r in rows]


@router.get("/orders", response_model=list[OrderSummaryOut])
async def orders(request: Request, p: Principal = Depends(customer_user)) -> list[OrderSummaryOut]:
    async with request.app.state.db.tx("customer", p.user_id) as t:
        c = await _customer(t, p.user_id)
        rows = await t.all("SELECT id, status::text AS status, total, placed_at FROM orders "
                           "WHERE customer_id = :c AND status <> 'draft' ORDER BY id DESC", c=c["id"])
    return [OrderSummaryOut(**r) for r in rows]


async def load_order(t: Tx, user_id: int, order_id: int) -> OrderOut:
    c = await _customer(t, user_id)
    o = await t.one("SELECT id, status::text AS status, placed_at, dest_address, subtotal, delivery_fee, total "
                    "FROM orders WHERE id = :o AND customer_id = :c", o=order_id, c=c["id"])
    if o is None:
        raise ApiError(404, "order_not_found")
    lines = await t.all("SELECT id, name_ar, unit::text AS unit, unit_size, qty, unit_price, line_total, "
                        "delivered_qty FROM v_customer_order_lines WHERE order_id = :o ORDER BY id", o=order_id)
    d = await t.one("SELECT driver_first_name, driver_phone FROM v_customer_order_driver WHERE order_id = :o",
                    o=order_id)
    card = DriverCardOut(assigned=True, first_name=d["driver_first_name"], phone=d["driver_phone"]) if d else None
    return OrderOut(**o, lines=[OrderLineOut(**r) for r in lines], driver=card)


@router.get("/orders/{order_id}", response_model=OrderOut)
async def order(order_id: int, request: Request, p: Principal = Depends(customer_user)) -> OrderOut:
    async with request.app.state.db.tx("customer", p.user_id) as t:
        return await load_order(t, p.user_id, order_id)


@router.get("/orders/{order_id}/receipt.pdf", response_class=Response,
            responses={200: {"content": {"application/pdf": {}}}})
async def receipt(order_id: int, request: Request, p: Principal = Depends(customer_user)) -> Response:
    async with request.app.state.db.tx("customer", p.user_id) as t:
        o = await load_order(t, p.user_id, order_id)
        c = await _customer(t, p.user_id)
    return Response(documents.customer_receipt(o, c["name"]), media_type="application/pdf")
