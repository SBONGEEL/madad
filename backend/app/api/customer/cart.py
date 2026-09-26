"""العميل — السلة (مسودة واحدة لكل فرع)، و«جاهزة لتأكيد الصاحب» (م-8)، والتأكيد.

كل قاعدة في القاعدة: المنشأة معتمدة، والفرع بصلاحية العضو (resolve_branch)، والمتاح (م-15)، والحد الأدنى،
والرسم، ووضع المسؤول. هنا ترتيب النداءات وحده. المنشأة غير المعتمدة لا سلة لها في القاعدة: تبقى في الجهاز.
"""
from __future__ import annotations

from decimal import Decimal

from fastapi import APIRouter, Depends, Request
from sqlalchemy.exc import DBAPIError

from app.api.customer.common import approved_member, member
from app.api.customer.core import cart_branch
from app.api.customer.orders import load_order2
from app.api.deps import Principal, customer_user
from app.core.db import Tx
from app.core.errors import ApiError, db_code
from app.schemas.customer import BranchOut, CartLineOut, CartOut, CartQtyIn, Order2Out, PlaceIn, ReadyCartOut

router = APIRouter()


async def _draft(t: Tx, branch: int | None) -> dict | None:
    if branch is None:
        return None
    return await t.one("SELECT o.id, o.ready_for_owner_at, u.full_name AS prepared_by FROM v_customer_orders o "
                       "LEFT JOIN app_users u ON u.id = o.created_by WHERE o.status = 'draft' AND o.branch_id = :b", b=branch)


async def _fee(t: Tx, branch: int, subtotal: Decimal) -> tuple[Decimal | None, str | None]:
    try:
        async with t.conn.begin_nested():
            return await t.val("SELECT fee_preview(:b, :s)", b=branch, s=subtotal), None
    except DBAPIError as e:
        return None, db_code(e)


async def cart_out(t: Tx, m: dict, branch: int | None) -> CartOut:
    ctx = await t.one("SELECT min_order_amount, min_order_lines, customer_credit_available(:c) AS credit "
                      "FROM city_settings WHERE city = :city", c=m["id"], city=m["city"])
    b = await t.one("SELECT id, name, address_text, lat, lng, zone_id, zone_name, status::text AS status, active "
                    "FROM v_customer_branches WHERE id = :b", b=branch) if branch else None
    d = await _draft(t, branch)
    lines = await t.all("""
SELECT l.catalog_item_id, l.name_ar, l.unit::text AS unit, l.unit_size, l.qty, l.unit_price, l.line_total,
       EXISTS (SELECT 1 FROM v_customer_catalog v WHERE v.id = l.catalog_item_id AND v.orderable) AS orderable,
       ci.category_id
  FROM v_customer_order_lines l JOIN catalog_items ci ON ci.id = l.catalog_item_id
 WHERE l.order_id = :o ORDER BY l.id""", o=d["id"]) if d else []
    subtotal = sum((Decimal(r["line_total"] or 0) for r in lines), Decimal("0"))
    fee, fee_error = (await _fee(t, branch, subtotal)) if (branch and lines) else (None, None)
    minimum = ctx["min_order_amount"]
    return CartOut(order_id=d["id"] if d else None, branch=BranchOut(**b) if b else None,
                   lines=[CartLineOut(**r) for r in lines], subtotal=subtotal, delivery_fee=fee, fee_error=fee_error,
                   min_order_amount=minimum, min_order_lines=ctx["min_order_lines"],
                   below_min_by=max(Decimal("0"), (minimum or Decimal("0")) - subtotal), credit=ctx["credit"],
                   ready_for_owner_at=d["ready_for_owner_at"] if d else None,
                   prepared_by=d["prepared_by"] if d and d["ready_for_owner_at"] else None)


def _branch_or_fail(branch: int | None) -> int:
    if branch is None:
        raise ApiError(409, "branch_required")
    return branch


@router.get("/cart", response_model=CartOut)
async def cart(request: Request, branch_id: int | None = None, p: Principal = Depends(customer_user)) -> CartOut:
    async with request.app.state.db.tx("customer", p.user_id) as t:
        m = await member(t, p.user_id)
        return await cart_out(t, m, await cart_branch(t, m, branch_id))


async def set_line(t: Tx, m: dict, branch: int, item: int, qty: Decimal) -> None:
    d = await _draft(t, branch)
    if d is None:
        if qty == 0:
            return
        oid = await t.val("INSERT INTO orders (customer_id, branch_id) VALUES (:c, :b) RETURNING id", c=m["id"], b=branch)
    else:
        oid = d["id"]
    if qty == 0:
        await t.run("DELETE FROM order_items WHERE order_id = :o AND catalog_item_id = :i", o=oid, i=item)
    elif not await t.val("UPDATE order_items SET qty = :q WHERE order_id = :o AND catalog_item_id = :i RETURNING id",
                         q=qty, o=oid, i=item):
        await t.run("INSERT INTO order_items (order_id, catalog_item_id, qty) VALUES (:o, :i, :q)", o=oid, i=item, q=qty)


@router.put("/cart/items/{catalog_item_id}", response_model=CartOut)
async def put_item(catalog_item_id: int, body: CartQtyIn, request: Request, p: Principal = Depends(customer_user)) -> CartOut:
    """الكمية كما هي (0 = حذف). المتاح والظهور والتكلفة تفحصها القاعدة (b_order_item)."""
    async with request.app.state.db.tx("customer", p.user_id) as t:
        m = await approved_member(t, p.user_id)
        branch = _branch_or_fail(await cart_branch(t, m, body.branch_id))
        await set_line(t, m, branch, catalog_item_id, body.qty)
        return await cart_out(t, m, branch)


@router.post("/cart/ready", response_model=CartOut)
async def ready(body: PlaceIn, request: Request, p: Principal = Depends(customer_user)) -> CartOut:
    """م-8: المسؤول يرسل السلة لصاحب المنشأة ليؤكدها؛ يصل الصاحب إشعار من القاعدة."""
    async with request.app.state.db.tx("customer", p.user_id) as t:
        m = await approved_member(t, p.user_id)
        branch = _branch_or_fail(await cart_branch(t, m, body.branch_id))
        d = await _draft(t, branch)
        if d is None:
            raise ApiError(409, "order_empty")
        await t.run("UPDATE orders SET ready_for_owner_at = now(), notes = coalesce(:n, notes) WHERE id = :o",
                    n=body.notes, o=d["id"])
        return await cart_out(t, m, branch)


@router.get("/carts/ready", response_model=list[ReadyCartOut])
async def ready_carts(request: Request, p: Principal = Depends(customer_user)) -> list[ReadyCartOut]:
    """ما جهّزه المسؤولون بانتظار تأكيد الصاحب."""
    async with request.app.state.db.tx("customer", p.user_id) as t:
        await member(t, p.user_id)
        rows = await t.all("""
SELECT o.id AS order_id, o.branch_id, o.branch_name, u.full_name AS prepared_by, o.ready_for_owner_at,
       (SELECT count(*) FROM order_items WHERE order_id = o.id) AS lines,
       coalesce((SELECT sum(line_total) FROM v_customer_order_lines WHERE order_id = o.id), 0) AS amount
  FROM v_customer_orders o LEFT JOIN app_users u ON u.id = o.created_by
 WHERE o.status = 'draft' AND o.ready_for_owner_at IS NOT NULL ORDER BY o.ready_for_owner_at""")
    return [ReadyCartOut(**r) for r in rows]


@router.post("/cart/place", response_model=Order2Out)
async def place(body: PlaceIn, request: Request, p: Principal = Depends(customer_user)) -> Order2Out:
    """تأكيد الطلبية: يُحجز السعر، ويُفرض الحد الأدنى والرسم والمتاح ووضع المسؤول في القاعدة."""
    async with request.app.state.db.tx("customer", p.user_id) as t:
        m = await approved_member(t, p.user_id)
        branch = _branch_or_fail(await cart_branch(t, m, body.branch_id))
        d = await _draft(t, branch)
        if d is None:
            raise ApiError(409, "order_empty")
        if body.notes is not None:
            await t.run("UPDATE orders SET notes = :n WHERE id = :o", n=body.notes.strip() or None, o=d["id"])
        await t.run("UPDATE orders SET status = 'placed' WHERE id = :o", o=d["id"])
        return await load_order2(t, d["id"])
