"""اللوحة — اللوحة الحية للطلبيات، ومخطط الاستلام، والإسناد، والنزاعات (م-10).

الانتقالات والصلاحيات والقيود في القاعدة (trg_order_before وأخواته)؛ هنا القراءة وتمرير الطلب.
مصير بضاعة الإلغاء (الأمانة) من شاشة النزاع إضافةٌ بانتظار اعتماد تصميمها: لا نقطة لها هنا بعد.
"""
from __future__ import annotations

from fastapi import APIRouter, Depends, Request, Response

from app.api.admin.common import P, city, sees_costs
from app.api.deps import Principal, admin_user
from app.core.db import Tx
from app.core.errors import ApiError
from app.schemas.admin import (AssignIn, PayOfferDecisionIn, PayOfferOut, CancelIn, DisputeDetailOut, DisputeRowOut, DriverChoiceOut, OrderDetailOut,
                               OrderLineAdminOut, OrderRowOut, PlanLineIn, PlanLineOut, PlanOut, PlanStopOut, QtyIn,
                               ResolveIn, StatusEventOut)

router = APIRouter()

ORDER_SQL = """
SELECT o.id, o.status::text AS status, c.name AS customer_name, br.name AS branch_name, o.total,
       o.line_count AS lines, d.full_name AS driver_name, o.placed_at, o.plan_complete
  FROM orders o JOIN customers c ON c.id = o.customer_id JOIN customer_locations br ON br.id = o.branch_id
  LEFT JOIN drivers d ON d.id = o.driver_id
"""


@router.get("/orders", response_model=list[OrderRowOut], **P("orders"))
async def orders(request: Request, status: str | None = None, p: Principal = Depends(admin_user)) -> list[OrderRowOut]:
    async with request.app.state.db.tx("admin", p.user_id) as t:
        rows = await t.all(ORDER_SQL + " WHERE o.city = :c AND o.status <> 'draft' AND "
                           "(CAST(:s AS text) IS NULL OR o.status::text = :s) ORDER BY o.id DESC LIMIT 200",
                           c=city(request), s=status)
    return [OrderRowOut(**r) for r in rows]


async def _detail(t: Tx, order_id: int) -> OrderDetailOut:
    o = await t.one(ORDER_SQL + " WHERE o.id = :o", o=order_id)
    if o is None:
        raise ApiError(404, "order_not_found")
    x = await t.one("SELECT driver_id, dest_address, subtotal, delivery_fee, driver_pay, route_km FROM orders WHERE id = :o", o=order_id)
    lines = await t.all("SELECT oi.id, oi.catalog_item_id, ci.name_ar, oi.unit::text AS unit, oi.qty, oi.unit_price, oi.line_total, "
                        "oi.delivered_qty FROM order_items oi JOIN catalog_items ci ON ci.id = oi.catalog_item_id "
                        "WHERE oi.order_id = :o ORDER BY oi.id", o=order_id)
    ev = await t.all("SELECT to_status::text AS to_status, actor_role, at, reason FROM order_status_events "
                     "WHERE order_id = :o ORDER BY id", o=order_id)
    return OrderDetailOut(order=OrderRowOut(**o), **x, lines=[OrderLineAdminOut(**r) for r in lines],
                          events=[StatusEventOut(**e) for e in ev])


@router.get("/orders/{order_id}", response_model=OrderDetailOut, **P("orders"))
async def order(order_id: int, request: Request, p: Principal = Depends(admin_user)) -> OrderDetailOut:
    async with request.app.state.db.tx("admin", p.user_id) as t:
        return await _detail(t, order_id)


@router.post("/orders/{order_id}/confirm", response_model=OrderDetailOut, **P("orders"))
async def confirm(order_id: int, request: Request, p: Principal = Depends(admin_user)) -> OrderDetailOut:
    async with request.app.state.db.tx("admin", p.user_id) as t:
        await t.run("UPDATE orders SET status = 'confirmed' WHERE id = :o", o=order_id)
        return await _detail(t, order_id)


@router.post("/orders/{order_id}/cancel", response_model=OrderDetailOut, **P("orders"))
async def cancel(order_id: int, body: CancelIn, request: Request, p: Principal = Depends(admin_user)) -> OrderDetailOut:
    async with request.app.state.db.tx("admin", p.user_id) as t:
        await t.run("UPDATE orders SET status = 'cancelled', cancel_reason = :r WHERE id = :o",
                    r=body.reason.strip(), o=order_id)
        return await _detail(t, order_id)


@router.patch("/orders/{order_id}/items/{order_item_id}", response_model=OrderDetailOut, **P("orders"))
async def edit_line(order_id: int, order_item_id: int, body: QtyIn, request: Request,
                    p: Principal = Depends(admin_user)) -> OrderDetailOut:
    async with request.app.state.db.tx("admin", p.user_id) as t:
        await t.run("UPDATE order_items SET qty = :q WHERE id = :i AND order_id = :o", q=body.qty, i=order_item_id, o=order_id)
        return await _detail(t, order_id)


# ——— مخطط الاستلام (§4.1) ————————————————————————————————————————————————————
async def _plan(t: Tx, order_id: int, hide: bool) -> PlanOut:
    o = await t.one("SELECT status::text AS status, plan_complete FROM orders WHERE id = :o", o=order_id)
    if o is None:
        raise ApiError(404, "order_not_found")
    stops = await t.all(
        "SELECT s.id, s.seq, s.source::text AS source, s.status::text AS status, "
        "coalesce(sp.name || ' — ' || pl.label, w.name, 'من السائق (أمانة)') AS label FROM pickup_stops s "
        "LEFT JOIN suppliers sp ON sp.id = s.supplier_id LEFT JOIN supplier_pickup_locations pl ON pl.id = s.pickup_location_id "
        "LEFT JOIN warehouses w ON w.id = s.warehouse_id WHERE s.order_id = :o AND s.status <> 'cancelled' ORDER BY s.seq",
        o=order_id)
    lines = await t.all("SELECT l.id, l.stop_id, l.order_item_id, l.offer_id, s.warehouse_id, ci.name_ar AS item, l.planned_qty, l.collected_qty, c.unit_cost "
                        "FROM pickup_stop_lines l JOIN order_items oi ON oi.id = l.order_item_id "
                        "JOIN pickup_stops s ON s.id = l.stop_id JOIN catalog_items ci ON ci.id = oi.catalog_item_id LEFT JOIN pickup_line_costs c ON c.stop_line_id = l.id "
                        "WHERE l.stop_id IN (SELECT id FROM pickup_stops WHERE order_id = :o) ORDER BY l.id", o=order_id)
    out = PlanOut(order_id=order_id, **o, stops=[
        PlanStopOut(**s, lines=[PlanLineOut(**{k: v for k, v in ln.items() if k != "stop_id"}).hide_costs(hide)
                                for ln in lines if ln["stop_id"] == s["id"]]) for s in stops])
    return out


@router.get("/orders/{order_id}/plan", response_model=PlanOut, **P("orders"))
async def plan(order_id: int, request: Request, p: Principal = Depends(admin_user)) -> PlanOut:
    async with request.app.state.db.tx("admin", p.user_id) as t:
        return await _plan(t, order_id, not await sees_costs(t, p.user_id))


@router.post("/orders/{order_id}/plan/lines", response_model=PlanOut, **P("orders"))
async def add_plan_line(order_id: int, body: PlanLineIn, request: Request, p: Principal = Depends(admin_user)) -> PlanOut:
    """يضيف الكمية إلى نقطة المصدر نفسه إن وُجدت، وإلا نقطة جديدة. التكلفة تُكتب بمشغّل (ت-39)."""
    if (body.offer_id is None) == (body.warehouse_id is None):
        raise ApiError(422, "source_required: offer_id xor warehouse_id")
    async with request.app.state.db.tx("admin", p.user_id) as t:
        if body.offer_id is not None:
            src = await t.one("SELECT supplier_id, pickup_location_id FROM supplier_offers WHERE id = :i", i=body.offer_id)
            if src is None:
                raise ApiError(404, "offer_not_found")
            stop = await t.val("SELECT id FROM pickup_stops WHERE order_id = :o AND status = 'pending' "
                               "AND pickup_location_id = :l", o=order_id, l=src["pickup_location_id"])
            if stop is None:
                stop = await t.val("INSERT INTO pickup_stops (order_id, seq, source, supplier_id, pickup_location_id) "
                                   "VALUES (:o, (SELECT coalesce(max(seq), 0) + 1 FROM pickup_stops WHERE order_id = :o), "
                                   "'supplier', :s, :l) RETURNING id", o=order_id, s=src["supplier_id"], l=src["pickup_location_id"])
        else:
            stop = await t.val("SELECT id FROM pickup_stops WHERE order_id = :o AND status = 'pending' AND warehouse_id = :w",
                               o=order_id, w=body.warehouse_id)
            if stop is None:
                stop = await t.val("INSERT INTO pickup_stops (order_id, seq, source, warehouse_id) VALUES (:o, "
                                   "(SELECT coalesce(max(seq), 0) + 1 FROM pickup_stops WHERE order_id = :o), 'warehouse', :w) "
                                   "RETURNING id", o=order_id, w=body.warehouse_id)
        # الصنف في النقطة نفسها سطر واحد: تُزاد كميته
        if not await t.val("UPDATE pickup_stop_lines SET planned_qty = planned_qty + :q WHERE stop_id = :s "
                           "AND order_item_id = :i RETURNING id", q=body.qty, s=stop, i=body.order_item_id):
            await t.run("INSERT INTO pickup_stop_lines (stop_id, order_item_id, offer_id, planned_qty) "
                        "VALUES (:s, :i, :f, :q)", s=stop, i=body.order_item_id, f=body.offer_id, q=body.qty)
        return await _plan(t, order_id, not await sees_costs(t, p.user_id))


@router.patch("/plan/lines/{line_id}", response_model=PlanOut, **P("orders"))
async def set_plan_qty(line_id: int, body: QtyIn, request: Request, p: Principal = Depends(admin_user)) -> PlanOut:
    async with request.app.state.db.tx("admin", p.user_id) as t:
        oid = await t.val("UPDATE pickup_stop_lines l SET planned_qty = :q FROM pickup_stops s "
                          "WHERE l.id = :i AND s.id = l.stop_id RETURNING s.order_id", q=body.qty, i=line_id)
        if oid is None:
            raise ApiError(404, "line_not_found")
        return await _plan(t, oid, not await sees_costs(t, p.user_id))


@router.delete("/plan/lines/{line_id}", status_code=204, **P("orders"))
async def delete_plan_line(line_id: int, request: Request, p: Principal = Depends(admin_user)) -> Response:
    async with request.app.state.db.tx("admin", p.user_id) as t:
        await t.run("DELETE FROM pickup_stop_lines WHERE id = :i", i=line_id)
    return Response(status_code=204)


# ——— الإسناد (§4.2) ——————————————————————————————————————————————————————————
@router.get("/drivers/available", response_model=list[DriverChoiceOut], **P("orders"))
async def available_drivers(request: Request, p: Principal = Depends(admin_user)) -> list[DriverChoiceOut]:
    async with request.app.state.db.tx("admin", p.user_id) as t:
        rows = await t.all(
            "SELECT d.id, d.full_name, d.vehicle::text AS vehicle, d.capacity_kg, "
            "coalesce((SELECT balance FROM ledger_accounts WHERE kind = 'driver_cash' AND driver_id = d.id), 0) AS cash_held, "
            "(SELECT count(*) FROM orders o WHERE o.driver_id = d.id AND o.status IN ('assigned', 'collecting', "
            "'partially_delivered')) AS active_orders FROM drivers d WHERE d.city = :c AND d.status = 'approved' "
            "ORDER BY d.full_name", c=city(request))
        cap = await t.val("SELECT driver_cash_cap FROM city_settings WHERE city = :c", c=city(request))
    return [DriverChoiceOut(**r, over_cap=cap is not None and r["cash_held"] > cap) for r in rows]


@router.post("/orders/{order_id}/assign", response_model=OrderDetailOut, **P("orders"))
async def assign(order_id: int, body: AssignIn, request: Request, p: Principal = Depends(admin_user)) -> OrderDetailOut:
    async with request.app.state.db.tx("admin", p.user_id) as t:
        await t.run("UPDATE orders SET route_km = :k WHERE id = :o", k=body.route_km, o=order_id)
        await t.run("UPDATE orders SET status = 'assigned', driver_id = :d WHERE id = :o", d=body.driver_id, o=order_id)
        return await _detail(t, order_id)


@router.post("/orders/{order_id}/unassign", response_model=OrderDetailOut, **P("orders"))
async def unassign(order_id: int, request: Request, p: Principal = Depends(admin_user)) -> OrderDetailOut:
    async with request.app.state.db.tx("admin", p.user_id) as t:
        await t.run("UPDATE orders SET status = 'confirmed' WHERE id = :o", o=order_id)
        return await _detail(t, order_id)


# ——— النزاعات (م-10) ————————————————————————————————————————————————————————
DISPUTE_SQL = """
SELECT d.id, d.order_id, c.name AS customer_name, d.kind::text AS kind, d.status::text AS status,
       d.opened_by_role::text AS opened_by_role, d.created_at, d.description
  FROM disputes d JOIN orders o ON o.id = d.order_id JOIN customers c ON c.id = o.customer_id
"""


@router.get("/disputes", response_model=list[DisputeRowOut], **P("orders"))
async def disputes(request: Request, status: str | None = None, p: Principal = Depends(admin_user)) -> list[DisputeRowOut]:
    async with request.app.state.db.tx("admin", p.user_id) as t:
        rows = await t.all(DISPUTE_SQL + " WHERE o.city = :c AND (CAST(:s AS text) IS NULL OR d.status::text = :s) "
                           "ORDER BY d.status, d.id DESC", c=city(request), s=status)
    return [DisputeRowOut(**r) for r in rows]


async def _dispute(t: Tx, dispute_id: int) -> DisputeDetailOut:
    d = await t.one(DISPUTE_SQL + " WHERE d.id = :i", i=dispute_id)
    if d is None:
        raise ApiError(404, "dispute_not_found")
    x = await t.one(
        "SELECT d.order_item_id, (SELECT s.supplier_id FROM pickup_stop_lines l JOIN pickup_stops s ON s.id = l.stop_id "
        "  WHERE l.order_item_id = oi.id AND s.supplier_id IS NOT NULL LIMIT 1) AS supplier_id, "
        "(SELECT driver_id FROM orders WHERE id = d.order_id) AS driver_id, ci.name_ar AS item, oi.line_total AS item_total, "
        "(SELECT coalesce(sp.name, w.name) FROM pickup_stop_lines l JOIN pickup_stops s ON s.id = l.stop_id "
        "  LEFT JOIN suppliers sp ON sp.id = s.supplier_id LEFT JOIN warehouses w ON w.id = s.warehouse_id "
        "  WHERE l.order_item_id = oi.id LIMIT 1) AS source, "
        "d.resolution::text AS resolution, d.resolution_amount, d.refund_method::text AS refund_method, "
        "d.loss_bearer::text AS loss_bearer FROM disputes d LEFT JOIN order_items oi ON oi.id = d.order_item_id "
        "LEFT JOIN catalog_items ci ON ci.id = oi.catalog_item_id WHERE d.id = :i", i=dispute_id)
    return DisputeDetailOut(dispute=DisputeRowOut(**d), **x)


@router.get("/disputes/{dispute_id}", response_model=DisputeDetailOut, **P("orders"))
async def dispute(dispute_id: int, request: Request, p: Principal = Depends(admin_user)) -> DisputeDetailOut:
    async with request.app.state.db.tx("admin", p.user_id) as t:
        return await _dispute(t, dispute_id)


@router.post("/disputes/{dispute_id}/resolve", response_model=DisputeDetailOut, **P("orders"))
async def resolve(dispute_id: int, body: ResolveIn, request: Request, p: Principal = Depends(admin_user)) -> DisputeDetailOut:
    """القيود تكتبها القاعدة (trg_dispute_post)، والقيود على اكتمال القرار فيها أيضاً."""
    async with request.app.state.db.tx("admin", p.user_id) as t:
        await t.run(
            "UPDATE disputes SET status = 'resolved', resolution = CAST(:r AS dispute_resolution), resolution_amount = :a, "
            "refund_method = CAST(:rm AS refund_method), refund_driver_id = :rd, loss_bearer = CAST(:lb AS loss_bearer), "
            "loss_supplier_id = :ls, loss_driver_id = :ld, resolution_note = :n, resolved_by = :u, resolved_at = now() "
            "WHERE id = :i", r=body.resolution, a=body.resolution_amount, rm=body.refund_method, rd=body.refund_driver_id,
            lb=body.loss_bearer, ls=body.loss_supplier_id, ld=body.loss_driver_id, n=body.note, u=p.user_id, i=dispute_id)
        return await _dispute(t, dispute_id)


# ——— عروض أجرة السائقين (§4.2): السائق يعرض، والمالك يقبل (فتُسند الطلبية) أو يرفض ——————————
async def _pay_offers(t: Tx, order_id: int) -> list[PayOfferOut]:
    rows = await t.all("""
SELECT f.id, f.driver_id, d.full_name AS driver_name, f.amount, f.status::text AS status, f.created_at,
       CASE WHEN o.route_km IS NOT NULL THEN round(cs.driver_pay_base + cs.driver_pay_per_stop *
            (SELECT count(*) FROM pickup_stops WHERE order_id = o.id AND status <> 'cancelled')
            + cs.driver_pay_per_km * o.route_km, 3) END AS formula_pay
  FROM driver_pay_offers f JOIN drivers d ON d.id = f.driver_id JOIN orders o ON o.id = f.order_id
  JOIN city_settings cs ON cs.city = o.city
 WHERE f.order_id = :o ORDER BY (f.status = 'pending') DESC, f.amount, f.id""", o=order_id)
    return [PayOfferOut(**r) for r in rows]


@router.get("/orders/{order_id}/pay-offers", response_model=list[PayOfferOut], **P("orders"))
async def pay_offers(order_id: int, request: Request, p: Principal = Depends(admin_user)) -> list[PayOfferOut]:
    async with request.app.state.db.tx("admin", p.user_id) as t:
        return await _pay_offers(t, order_id)


@router.post("/pay-offers/{pay_offer_id}/decide", response_model=list[PayOfferOut], **P("orders"))
async def decide_pay_offer(pay_offer_id: int, body: PayOfferDecisionIn, request: Request,
                           p: Principal = Depends(admin_user)) -> list[PayOfferOut]:
    """القبول يُسند الطلبية للسائق بأجرته ويسحب العروض الأخرى (trg_driver_offer_after)."""
    async with request.app.state.db.tx("admin", p.user_id) as t:
        oid = await t.val("SELECT order_id FROM driver_pay_offers WHERE id = :f", f=pay_offer_id)
        if oid is None:
            raise ApiError(404, "offer_not_found")
        await t.run("UPDATE driver_pay_offers SET status = CAST(:s AS driver_offer_status) WHERE id = :f",
                    s="accepted" if body.decision == "accept" else "rejected", f=pay_offer_id)
        return await _pay_offers(t, oid)
