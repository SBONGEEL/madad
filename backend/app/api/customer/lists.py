"""العميل — القوائم المتكررة (§3.1): قائمة لكل فرع، وإعادة الطلب بكبسة، والتذكير، وتعليم غير المتاح.

الفرع وصلاحية العضو في القاعدة (b_list، b_list_item). أيام التذكير على عُرف Postgres: الأحد 0 … السبت 6.
"""
from __future__ import annotations

from datetime import time

from fastapi import APIRouter, Depends, Request, Response

from app.api.customer.common import approved_member, member, order_access
from app.api.customer.core import cart_branch
from app.api.deps import Principal, customer_user
from app.core.db import Tx
from app.core.errors import ApiError
from app.schemas.customer import ListDetailOut, ListIn, ListLineOut, ListOut, ListPatchIn, ReorderOut, ToCartIn

router = APIRouter()

LIST_SQL = """
SELECT l.id, l.name, l.branch_id, b.name AS branch_name,
       (SELECT count(*) FROM recurring_list_items WHERE list_id = l.id) AS item_count, l.has_unavailable,
       l.reminder_days, to_char(l.reminder_time, 'HH24:MI') AS reminder_time,
       coalesce(extract(dow FROM now() AT TIME ZONE 'Africa/Tripoli')::int = ANY(l.reminder_days), false) AS due_today
  FROM v_customer_lists l JOIN v_customer_branches b ON b.id = l.branch_id
"""


def _out(r: dict) -> ListOut:
    return ListOut(**{**r, "reminder_days": list(r["reminder_days"]) if r["reminder_days"] is not None else None})


async def _detail(t: Tx, list_id: int) -> ListDetailOut:
    r = await t.one(LIST_SQL + " WHERE l.id = :l", l=list_id)
    if r is None:
        raise ApiError(404, "list_not_found")
    lines = await t.all("""
SELECT li.catalog_item_id, ci.name_ar, ci.unit::text AS unit, ci.unit_size, li.qty, v.sale_price,
       coalesce(v.orderable, false) AS orderable, ci.category_id,
       EXISTS (SELECT 1 FROM stock_alerts a WHERE a.catalog_item_id = ci.id AND a.user_id = actor_id()) AS alert
  FROM recurring_list_items li JOIN catalog_items ci ON ci.id = li.catalog_item_id
  LEFT JOIN v_customer_catalog v ON v.id = ci.id
 WHERE li.list_id = :l ORDER BY ci.name_ar""", l=list_id)
    return ListDetailOut(list=_out(r), lines=[ListLineOut(**x) for x in lines])


@router.get("/lists", response_model=list[ListDetailOut])
async def lists(request: Request, p: Principal = Depends(customer_user)) -> list[ListDetailOut]:
    """القوائم بأسطرها: الواجهة تعرض التعليم والبدائل دون نداء لكل قائمة."""
    async with request.app.state.db.tx("customer", p.user_id) as t:
        await member(t, p.user_id)
        ids = [r["id"] for r in await t.all(LIST_SQL + " ORDER BY due_today DESC, l.name")]
        return [await _detail(t, i) for i in ids]


async def _set_items(t: Tx, list_id: int, items: list[tuple[int, object]]) -> None:
    await t.run("DELETE FROM recurring_list_items WHERE list_id = :l", l=list_id)
    for item, qty in items:
        await t.run("INSERT INTO recurring_list_items (list_id, catalog_item_id, qty) VALUES (:l, :i, :q)",
                    l=list_id, i=item, q=qty)


@router.post("/lists", response_model=ListDetailOut, status_code=201)
async def new_list(body: ListIn, request: Request, p: Principal = Depends(customer_user)) -> ListDetailOut:
    """قائمة جديدة بأصنافها، أو من طلبية سابقة («احفظها قائمة متكررة»)."""
    async with request.app.state.db.tx("customer", p.user_id) as t:
        m = await member(t, p.user_id)
        if body.from_order_id is not None:
            oid = await order_access(t, body.from_order_id)
            branch = await t.val("SELECT branch_id FROM v_customer_orders WHERE id = :o", o=oid)
            items = [(r["catalog_item_id"], r["qty"]) for r in
                     await t.all("SELECT catalog_item_id, qty FROM order_items WHERE order_id = :o", o=oid)]
        else:
            branch = await cart_branch(t, m, body.branch_id)
            items = [(i.catalog_item_id, i.qty) for i in body.items]
        if branch is None:
            raise ApiError(409, "branch_required")
        lid = await t.val("INSERT INTO recurring_lists (customer_id, branch_id, name, created_by) "
                          "VALUES (:c, :b, :n, :u) RETURNING id", c=m["id"], b=branch, n=body.name.strip(), u=p.user_id)
        await _set_items(t, lid, items)
        return await _detail(t, lid)


@router.patch("/lists/{list_id}", response_model=ListDetailOut)
async def edit_list(list_id: int, body: ListPatchIn, request: Request, p: Principal = Depends(customer_user)) -> ListDetailOut:
    async with request.app.state.db.tx("customer", p.user_id) as t:
        await member(t, p.user_id)
        if not await t.val("SELECT 1 FROM v_customer_lists l JOIN v_customer_branches b ON b.id = l.branch_id "
                           "WHERE l.id = :l", l=list_id):
            raise ApiError(404, "list_not_found")
        if body.name is not None:
            await t.run("UPDATE recurring_lists SET name = :n WHERE id = :l", n=body.name.strip(), l=list_id)
        if body.reminder_off:
            await t.run("UPDATE recurring_lists SET reminder_days = NULL, reminder_time = NULL WHERE id = :l", l=list_id)
        elif body.reminder_days is not None or body.reminder_time is not None:
            if not body.reminder_days or body.reminder_time is None or any(d not in range(7) for d in body.reminder_days):
                raise ApiError(422, "reminder_invalid")
            await t.run("UPDATE recurring_lists SET reminder_days = CAST(:d AS smallint[]), "
                        "reminder_time = :tm WHERE id = :l",
                        d=sorted(set(body.reminder_days)), tm=time.fromisoformat(body.reminder_time), l=list_id)
        if body.items is not None:
            await _set_items(t, list_id, [(i.catalog_item_id, i.qty) for i in body.items])
        return await _detail(t, list_id)


@router.delete("/lists/{list_id}", status_code=204)
async def delete_list(list_id: int, request: Request, p: Principal = Depends(customer_user)) -> Response:
    async with request.app.state.db.tx("customer", p.user_id) as t:
        await member(t, p.user_id)
        if not await t.val("DELETE FROM recurring_lists WHERE id = :l AND id IN (SELECT l.id FROM v_customer_lists l "
                           "JOIN v_customer_branches b ON b.id = l.branch_id) RETURNING id", l=list_id):
            raise ApiError(404, "list_not_found")
    return Response(status_code=204)


@router.post("/lists/{list_id}/to-cart", response_model=ReorderOut)
async def to_cart(list_id: int, body: ToCartIn, request: Request, p: Principal = Depends(customer_user)) -> ReorderOut:
    """إعادة الطلب بكبسة: تُفتح سلة الفرع ممتلئة. غير المتاح يُتخطّى ويُذكر (أو يُرفض إن لم يُطلب التخطّي)."""
    from app.api.customer.cart import cart_out, set_line

    async with request.app.state.db.tx("customer", p.user_id) as t:
        m = await approved_member(t, p.user_id)
        d = await _detail(t, list_id)
        missing = [ln.name_ar for ln in d.lines if not ln.orderable]
        if missing and not body.skip_unavailable:
            raise ApiError(409, "list_has_unavailable", items=missing)
        for ln in d.lines:
            if ln.orderable:
                await set_line(t, m, d.list.branch_id, ln.catalog_item_id, ln.qty)
        return ReorderOut(cart=await cart_out(t, m, d.list.branch_id), skipped=missing)
