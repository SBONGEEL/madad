"""العميل — الطلبيات وتتبّعها (م-19) وإيصالها والنزاع فيها (م-10).

القراءة من v_customer_orders وحدها (م-9: المسؤول فرعه)، والتفاصيل من v_customer_order_lines
وv_customer_order_driver. لا حقل تكلفة ولا مورد، ولا من يتحمّل خسارة النزاع.
"""
from __future__ import annotations

from fastapi import APIRouter, Depends, Request, Response

from app.api.customer.common import member, order_access
from app.api.deps import Principal, customer_user
from app.core.db import Tx
from app.schemas.customer import (BatchOut, CancelIn, CartQtyIn, DisputeIn, DisputeOut, DriverCardOut, EventOut, Order2Out,
                                  Order2SummaryOut, OrderLineOut, OrderOut, ReorderOut)
from app.services import documents

router = APIRouter()


@router.get("/orders", response_model=list[Order2SummaryOut])
async def orders(request: Request, p: Principal = Depends(customer_user)) -> list[Order2SummaryOut]:
    async with request.app.state.db.tx("customer", p.user_id) as t:
        await member(t, p.user_id)
        rows = await t.all("SELECT id, status::text AS status, total, placed_at, delivered_at, line_count, branch_id, "
                           "branch_name FROM v_customer_orders WHERE status <> 'draft' ORDER BY id DESC")
    return [Order2SummaryOut(**r) for r in rows]


async def _lines(t: Tx, order_id: int) -> list[OrderLineOut]:
    rows = await t.all("SELECT id, catalog_item_id, name_ar, unit::text AS unit, unit_size, qty, unit_price, line_total, delivered_qty "
                       "FROM v_customer_order_lines WHERE order_id = :o ORDER BY id", o=order_id)
    return [OrderLineOut(**r) for r in rows]


async def _driver(t: Tx, order_id: int) -> DriverCardOut | None:
    d = await t.one("SELECT driver_first_name, driver_phone FROM v_customer_order_driver WHERE order_id = :o", o=order_id)
    return DriverCardOut(assigned=True, first_name=d["driver_first_name"], phone=d["driver_phone"]) if d else None


async def load_order2(t: Tx, order_id: int) -> Order2Out:
    oid = await order_access(t, order_id)
    o = await t.one("SELECT id, status::text AS status, placed_at, delivered_at, branch_id, branch_name, dest_address, "
                    "notes, subtotal, delivery_fee, total, amount_due, recipient_name, customer_can_cancel(id) AS cancellable "
                    "FROM v_customer_orders WHERE id = :o", o=oid)
    # السجل بحالاته وأوقاته وحدها — لا من غيّرها
    ev = await t.all("SELECT to_status::text AS status, at FROM order_status_events WHERE order_id = :o ORDER BY id", o=oid)
    # الدفعات (§4.3) بما أُبلغ العميل به في إشعارها: الأصناف والكميات والموعد
    bs = await t.all("""
SELECT b.seq, b.status::text AS status, b.eta_at, b.next_eta_at, coalesce(n.payload, '{}'::jsonb) AS payload
  FROM order_batches b LEFT JOIN notifications n ON n.id = b.notification_id
 WHERE b.order_id = :o ORDER BY b.seq""", o=oid)
    batches = [BatchOut(seq=b["seq"], status=b["status"], eta_at=b["eta_at"], next_eta_at=b["next_eta_at"],
                        now=list((b["payload"] or {}).get("now", [])), later=list((b["payload"] or {}).get("later", [])))
               for b in bs]
    return Order2Out(**o, lines=await _lines(t, oid), driver=await _driver(t, oid),
                     events=[EventOut(**e) for e in ev], batches=batches, editable=o["status"] == "placed")


@router.get("/orders/{order_id}", response_model=Order2Out)
async def order(order_id: int, request: Request, p: Principal = Depends(customer_user)) -> Order2Out:
    async with request.app.state.db.tx("customer", p.user_id) as t:
        await member(t, p.user_id)
        return await load_order2(t, order_id)


@router.get("/orders/{order_id}/receipt.pdf", response_class=Response,
            responses={200: {"content": {"application/pdf": {}}}})
async def receipt(order_id: int, request: Request, p: Principal = Depends(customer_user)) -> Response:
    """م-9: الإيصال باسم الفرع."""
    async with request.app.state.db.tx("customer", p.user_id) as t:
        m = await member(t, p.user_id)
        o = await load_order2(t, order_id)
    legacy = OrderOut(id=o.id, status=o.status, placed_at=o.placed_at, dest_address=o.dest_address, subtotal=o.subtotal,
                      delivery_fee=o.delivery_fee, total=o.total, lines=o.lines, driver=None)
    return Response(documents.customer_receipt(legacy, f"{m['name']} — {o.branch_name}"), media_type="application/pdf")


@router.put("/orders/{order_id}/items/{catalog_item_id}", response_model=Order2Out)
async def edit_line(order_id: int, catalog_item_id: int, body: CartQtyIn, request: Request,
                    p: Principal = Depends(customer_user)) -> Order2Out:
    """التعديل حتى يؤكد مَدَد (§3.2): القاعدة ترفض بعد placed (order_locked_for_customer)."""
    async with request.app.state.db.tx("customer", p.user_id) as t:
        await member(t, p.user_id)
        oid = await order_access(t, order_id)
        if body.qty == 0:
            await t.run("DELETE FROM order_items WHERE order_id = :o AND catalog_item_id = :i", o=oid, i=catalog_item_id)
        elif not await t.val("UPDATE order_items SET qty = :q WHERE order_id = :o AND catalog_item_id = :i RETURNING id",
                             q=body.qty, o=oid, i=catalog_item_id):
            await t.run("INSERT INTO order_items (order_id, catalog_item_id, qty) VALUES (:o, :i, :q)",
                        o=oid, i=catalog_item_id, q=body.qty)
        return await load_order2(t, oid)


@router.post("/orders/{order_id}/reorder", response_model=ReorderOut)
async def reorder(order_id: int, request: Request, p: Principal = Depends(customer_user)) -> ReorderOut:
    """«أعد الطلب نفسه»: أصناف الطلبية إلى سلة فرعها؛ غير المتاح يُتخطّى ويُذكر."""
    from app.api.customer.cart import cart_out, set_line
    from app.api.customer.common import approved_member

    async with request.app.state.db.tx("customer", p.user_id) as t:
        m = await approved_member(t, p.user_id)
        oid = await order_access(t, order_id)
        branch = await t.val("SELECT branch_id FROM v_customer_orders WHERE id = :o", o=oid)
        items = await t.all("""
SELECT oi.catalog_item_id, ci.name_ar, oi.qty,
       EXISTS (SELECT 1 FROM v_customer_catalog v WHERE v.id = oi.catalog_item_id AND v.orderable) AS orderable
  FROM order_items oi JOIN catalog_items ci ON ci.id = oi.catalog_item_id WHERE oi.order_id = :o ORDER BY oi.id""", o=oid)
        skipped = []
        for it in items:
            if it["orderable"]:
                await set_line(t, m, branch, it["catalog_item_id"], it["qty"])
            else:
                skipped.append(it["name_ar"])
        return ReorderOut(cart=await cart_out(t, m, branch), skipped=skipped)


# ——— النزاع (م-10) ——————————————————————————————————————————————————————————————
async def _disputes(t: Tx, order_id: int) -> list[DisputeOut]:
    rows = await t.all("""
SELECT d.id, d.order_item_id, ci.name_ar AS item, d.kind::text AS kind, d.description, d.status::text AS status,
       d.resolution::text AS resolution, d.resolution_amount, d.refund_method::text AS refund_method, d.resolution_note,
       d.created_at
  FROM disputes d LEFT JOIN order_items oi ON oi.id = d.order_item_id LEFT JOIN catalog_items ci ON ci.id = oi.catalog_item_id
 WHERE d.order_id = :o ORDER BY d.id DESC""", o=order_id)
    return [DisputeOut(**r) for r in rows]


@router.get("/orders/{order_id}/disputes", response_model=list[DisputeOut])
async def disputes(order_id: int, request: Request, p: Principal = Depends(customer_user)) -> list[DisputeOut]:
    async with request.app.state.db.tx("customer", p.user_id) as t:
        await member(t, p.user_id)
        return await _disputes(t, await order_access(t, order_id))


@router.post("/orders/{order_id}/disputes", response_model=list[DisputeOut], status_code=201)
async def open_dispute(order_id: int, body: DisputeIn, request: Request, p: Principal = Depends(customer_user)) -> list[DisputeOut]:
    """الفاتح من الجلسة، والصنف من الطلبية، ونزاع مفتوح واحد لكل صنف — كلها في القاعدة (b_dispute_insert)."""
    async with request.app.state.db.tx("customer", p.user_id) as t:
        await member(t, p.user_id)
        oid = await order_access(t, order_id)
        did = await t.val("INSERT INTO disputes (order_id, order_item_id, opened_by_role, opened_by, kind, description) "
                          "VALUES (:o, :i, 'customer', 0, CAST(:k AS dispute_kind), :d) RETURNING id",
                          o=oid, i=body.order_item_id, k=body.kind, d=body.description.strip())
        for mid in body.media_ids:
            await t.run("INSERT INTO dispute_media (dispute_id, media_id) VALUES (:d, :m)", d=did, m=mid)
        return await _disputes(t, oid)




@router.post("/orders/{order_id}/cancel", response_model=Order2Out)
async def cancel(order_id: int, body: CancelIn, request: Request, p: Principal = Depends(customer_user)) -> Order2Out:
    """§12-ط وم-7: حسب الإعداد المُلتقط في الطلبية وحالتها؛ القاعدة ترفض ما عداه (invalid_transition)."""
    async with request.app.state.db.tx("customer", p.user_id) as t:
        await member(t, p.user_id)
        oid = await order_access(t, order_id)
        await t.run("UPDATE orders SET status = 'cancelled', cancel_reason = :r WHERE id = :o",
                    r=(body.reason or "").strip() or "أُلغيت من تطبيق العميل", o=oid)
        return await load_order2(t, oid)
