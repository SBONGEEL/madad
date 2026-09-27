"""السائق — الطلبيات المتاحة والقبول وعرض الأجرة (م-18)، والمسار والاستلام (م-2، م-3، م-22)، والدفعات
والتسليم والتحصيل (§4.3)، والنزاع، والأمانة.

يقرأ من v_driver_* وحدها. تسمية نقطة الاستلام من v_driver_stop_labels (م-2): الاسم لا يخرج إلا والإعداد مفتوح.
كل قاعدة في القاعدة: الإسناد والسقف والصيغة، والجمع بعد التجميع، وإثبات الاستلام، ولا انطلاق قبل الإشعار،
ولا دفعة فوق المجموع، والتحصيل والدفتر عند التسليم.
"""
from __future__ import annotations

from decimal import Decimal

from fastapi import APIRouter, Depends, Request, Response

from app.api.deps import Principal, driver_user
from app.api.driver.core import driver
from app.core.db import Tx
from app.core.errors import ApiError
from app.schemas.common import HandoverOut
from app.schemas.driver import (EtaIn, AvailableOut, BatchIn, BatchTimesIn, BatchOut, CodeIn, ConfirmStopIn, CustodyItemOut, DisputeIn,
                                DisputeOut, ItemOut, Order2Out, Order2SummaryOut, OrderOut, PayOfferIn, StopLineOut,
                                StopOut)
from app.services import documents

router = APIRouter()


# ——— المتاح والقبول (م-18) ——————————————————————————————————————————————————————————
@router.get("/available", response_model=list[AvailableOut])
async def available(request: Request, p: Principal = Depends(driver_user)) -> list[AvailableOut]:
    async with request.app.state.db.tx("driver", p.user_id) as t:
        await driver(t, p.user_id)
        got = await t.all("SELECT id, customer_name, branch_name, dest_address, dest_lat, dest_lng, stops, route_km, "
                          "pay_estimate, amount_to_collect, load_kg, weight_complete, capacity_kg, over_capacity, my_offer "
                          "FROM v_driver_available ORDER BY confirmed_at, id")
    return [AvailableOut(**r) for r in got]


async def _mine(t: Tx, d: dict, order_id: int) -> None:
    if not await t.val("SELECT 1 FROM v_driver_orders WHERE id = :o AND driver_id = :d", o=order_id, d=d["id"]):
        raise ApiError(404, "order_not_found")


@router.post("/orders/{order_id}/accept", response_model=Order2Out)
async def accept(order_id: int, request: Request, p: Principal = Depends(driver_user)) -> Order2Out:
    """يقبل الطلبية بصيغة الأجر: السقف والمخطط والمسافة والصيغة تفحصها القاعدة (forbidden_self_assign_only…)."""
    async with request.app.state.db.tx("driver", p.user_id) as t:
        d = await driver(t, p.user_id)
        if not await t.val("SELECT 1 FROM v_driver_available WHERE id = :o", o=order_id):
            raise ApiError(409, "order_not_open_for_offers")
        await t.run("UPDATE orders SET driver_id = :d, status = 'assigned' WHERE id = :o", d=d["id"], o=order_id)
        return await load_order2(t, d, order_id)


@router.post("/orders/{order_id}/pay-offers", response_model=list[AvailableOut], status_code=201)
async def pay_offer(order_id: int, body: PayOfferIn, request: Request, p: Principal = Depends(driver_user)) -> list[AvailableOut]:
    """«اعرض أجرة مختلفة» (§4.2): يقررها المالك؛ قبولها يُسند الطلبية (trg_driver_offer_after)."""
    async with request.app.state.db.tx("driver", p.user_id) as t:
        d = await driver(t, p.user_id)
        await t.run("INSERT INTO driver_pay_offers (order_id, driver_id, amount) VALUES (:o, :d, :a)",
                    o=order_id, d=d["id"], a=body.amount)
        got = await t.all("SELECT id, customer_name, branch_name, dest_address, dest_lat, dest_lng, stops, route_km, "
                          "pay_estimate, amount_to_collect, load_kg, weight_complete, capacity_kg, over_capacity, my_offer "
                          "FROM v_driver_available ORDER BY confirmed_at, id")
    return [AvailableOut(**r) for r in got]


# ——— طلبياتي ————————————————————————————————————————————————————————————————————————
@router.get("/orders", response_model=list[Order2SummaryOut])
async def orders(request: Request, p: Principal = Depends(driver_user)) -> list[Order2SummaryOut]:
    async with request.app.state.db.tx("driver", p.user_id) as t:
        d = await driver(t, p.user_id)
        got = await t.all("SELECT id, status::text AS status, customer_name, branch_name, amount_to_collect, driver_pay "
                          "FROM v_driver_orders WHERE driver_id = :d ORDER BY id DESC", d=d["id"])
    return [Order2SummaryOut(**r) for r in got]


async def _stops(t: Tx, order_id: int) -> list[StopOut]:
    stops = await t.all(
        "SELECT s.id, s.seq, l.pickup_label AS label, s.status::text AS status, s.lat, s.lng, s.address_text, "
        "s.pickup_code, EXISTS (SELECT 1 FROM pickup_handovers h WHERE h.stop_id = s.id) AS handed_over, "
        "ps.eta_at, ps.arrived_at FROM v_driver_stops s JOIN v_driver_stop_labels l ON l.stop_id = s.id "
        "JOIN pickup_stops ps ON ps.id = s.id WHERE s.order_id = :o ORDER BY s.seq", o=order_id)
    lines = await t.all("SELECT id, stop_id, name_ar, unit::text AS unit, unit_size, planned_qty, collected_qty "
                        "FROM v_driver_stop_lines WHERE stop_id IN (SELECT id FROM pickup_stops WHERE order_id = :o) "
                        "ORDER BY id", o=order_id)
    return [StopOut(**s, lines=[StopLineOut(**{k: v for k, v in ln.items() if k != "stop_id"})
                                for ln in lines if ln["stop_id"] == s["id"]]) for s in stops]


async def load_order2(t: Tx, d: dict, order_id: int) -> Order2Out:
    o = await t.one(
        "SELECT v.id, v.status::text AS status, v.customer_name, v.customer_phone, v.branch_name, v.dest_address, v.dest_lat, "
        "v.dest_lng, v.amount_to_collect, o.delivery_fee, v.driver_pay, v.collection_mode::text AS collection_mode, o.route_km, "
        "v.load_kg, v.weight_complete, v.capacity_kg, v.over_capacity, v.recipient_name FROM v_driver_orders v JOIN orders o ON o.id = v.id "
        "WHERE v.id = :o AND v.driver_id = :d", o=order_id, d=d["id"])
    if o is None:
        raise ApiError(404, "order_not_found")
    items = await t.all("SELECT id, name_ar, unit::text AS unit, unit_size, qty, collected_qty, delivered_qty, price, line_value "
                        "FROM v_driver_order_items WHERE order_id = :o ORDER BY id", o=order_id)
    bs = await t.all("""
SELECT b.id, b.seq, b.status::text AS status, b.eta_at, b.next_eta_at, b.notified_at, b.departed_at, b.delivered_at,
       coalesce((SELECT sum(round(bl.qty * oi.unit_price, 3)) FROM order_batch_lines bl
                   JOIN order_items oi ON oi.id = bl.order_item_id WHERE bl.batch_id = b.id), 0) AS value,
       coalesce((SELECT jsonb_agg(jsonb_build_object('order_item_id', bl.order_item_id, 'qty', bl.qty) ORDER BY bl.order_item_id)
                   FROM order_batch_lines bl WHERE bl.batch_id = b.id), '[]'::jsonb) AS lines,
       (SELECT n.payload || jsonb_build_object('channels', n.channels) FROM notifications n WHERE n.id = b.notification_id) AS notice
  FROM order_batches b WHERE b.order_id = :o ORDER BY b.seq""", o=order_id)
    return Order2Out(**o, stops=await _stops(t, order_id), items=[ItemOut(**i) for i in items],
                     batches=[BatchOut(**{**b, "lines": list(b["lines"])}) for b in bs])


@router.get("/orders/{order_id}", response_model=Order2Out)
async def order(order_id: int, request: Request, p: Principal = Depends(driver_user)) -> Order2Out:
    async with request.app.state.db.tx("driver", p.user_id) as t:
        d = await driver(t, p.user_id)
        return await load_order2(t, d, order_id)


async def _start(t: Tx, order_id: int) -> None:
    """أُسندت ← يجري التجميع: قبل تأكيد أول نقطة (القاعدة ترفض الجمع قبله: order_not_collecting)."""
    await t.run("UPDATE orders SET status = 'collecting' WHERE id = :o AND status = 'assigned'", o=order_id)


@router.post("/orders/{order_id}/start", response_model=Order2Out)
async def start(order_id: int, request: Request, p: Principal = Depends(driver_user)) -> Order2Out:
    async with request.app.state.db.tx("driver", p.user_id) as t:
        d = await driver(t, p.user_id)
        await _mine(t, d, order_id)
        await _start(t, order_id)
        return await load_order2(t, d, order_id)


# ——— الاستلام (م-3، م-22) —————————————————————————————————————————————————————————————
async def _stop_order(t: Tx, d: dict, stop_id: int) -> int:
    oid = await t.val("SELECT s.order_id FROM pickup_stops s JOIN orders o ON o.id = s.order_id "
                      "WHERE s.id = :i AND o.driver_id = :d", i=stop_id, d=d["id"])
    if oid is None:
        raise ApiError(404, "stop_not_found")
    return oid


@router.post("/stops/{stop_id}/code", response_model=HandoverOut)
async def code(stop_id: int, body: CodeIn, request: Request, p: Principal = Depends(driver_user)) -> HandoverOut:
    """م-3 (ب): السائق يكتب الرقم الذي يعطيه المورد. المطابقة والصلاحية في القاعدة."""
    async with request.app.state.db.tx("driver", p.user_id) as t:
        d = await driver(t, p.user_id)
        oid = await _stop_order(t, d, stop_id)
        await _start(t, oid)
        await t.run("INSERT INTO pickup_handovers (stop_id, method, code_given) VALUES (:i, 'code_entry', :c)",
                    i=stop_id, c=body.code)
    return HandoverOut(handed_over=True, method="code_entry")


@router.post("/stops/{stop_id}/confirm", response_model=Order2Out)
async def confirm_stop(stop_id: int, body: ConfirmStopIn, request: Request, p: Principal = Depends(driver_user)) -> Order2Out:
    """المستلم فعلاً لكل صنف، ثم حالة النقطة: كاملة ← استُلمت، بعضها ← ناقصة، لا شيء ← مرفوضة."""
    async with request.app.state.db.tx("driver", p.user_id) as t:
        d = await driver(t, p.user_id)
        oid = await _stop_order(t, d, stop_id)
        await _start(t, oid)
        planned = {r["id"]: r["planned_qty"] for r in
                   await t.all("SELECT id, planned_qty FROM pickup_stop_lines WHERE stop_id = :s", s=stop_id)}
        given = {ln.line_id: ln.collected_qty for ln in body.lines}
        if set(given) != set(planned):
            raise ApiError(422, "stop_lines_incomplete")
        for line_id, q in given.items():
            await t.run("UPDATE pickup_stop_lines SET collected_qty = :q WHERE id = :l", q=q, l=line_id)
        if body.photo_media_id is not None:
            await t.run("UPDATE pickup_stops SET photo_media_id = :m WHERE id = :s", m=body.photo_media_id, s=stop_id)
        total = sum(given.values(), Decimal(0))
        status = ("refused" if total == 0 else
                  "collected" if all(given[k] == planned[k] for k in planned) else "short")
        await t.run("UPDATE pickup_stops SET status = CAST(:st AS stop_status) WHERE id = :s", st=status, s=stop_id)
        return await load_order2(t, d, oid)


# ——— الدفعات والتسليم (§4.3) ———————————————————————————————————————————————————————————
async def _batch_order(t: Tx, d: dict, batch_id: int) -> int:
    oid = await t.val("SELECT b.order_id FROM order_batches b JOIN orders o ON o.id = b.order_id "
                      "WHERE b.id = :b AND o.driver_id = :d", b=batch_id, d=d["id"])
    if oid is None:
        raise ApiError(404, "batch_not_found")
    return oid


@router.post("/orders/{order_id}/batches", response_model=Order2Out, status_code=201)
async def new_batch(order_id: int, body: BatchIn, request: Request, p: Principal = Depends(driver_user)) -> Order2Out:
    """دفعة جديدة بأصنافها وكمياتها وموعدها وموعد ما يصل لاحقاً. لا إرسال ولا انطلاق هنا."""
    async with request.app.state.db.tx("driver", p.user_id) as t:
        d = await driver(t, p.user_id)
        await _mine(t, d, order_id)
        bid = await t.val("INSERT INTO order_batches (order_id, seq, eta_at, next_eta_at) VALUES (:o, "
                          "(SELECT coalesce(max(seq), 0) + 1 FROM order_batches WHERE order_id = :o), :e, :n) RETURNING id",
                          o=order_id, e=body.eta_at, n=body.next_eta_at)
        for ln in body.lines:
            await t.run("INSERT INTO order_batch_lines (batch_id, order_item_id, qty) VALUES (:b, :i, :q)",
                        b=bid, i=ln.order_item_id, q=ln.qty)
        return await load_order2(t, d, order_id)


@router.patch("/batches/{batch_id}", response_model=Order2Out)
async def batch_times(batch_id: int, body: BatchTimesIn, request: Request, p: Principal = Depends(driver_user)) -> Order2Out:
    """موعد الدفعة وموعد ما يصل لاحقاً ما دامت لم تُرسَل (القاعدة تثبّتهما بعد الإشعار: batch_notice_sent_is_immutable)."""
    async with request.app.state.db.tx("driver", p.user_id) as t:
        d = await driver(t, p.user_id)
        oid = await _batch_order(t, d, batch_id)
        await t.run("UPDATE order_batches SET eta_at = :e, next_eta_at = :n WHERE id = :b",
                    e=body.eta_at, n=body.next_eta_at, b=batch_id)
        return await load_order2(t, d, oid)


async def _batch_step(request: Request, p: Principal, batch_id: int, status: str) -> Order2Out:
    async with request.app.state.db.tx("driver", p.user_id) as t:
        d = await driver(t, p.user_id)
        oid = await _batch_order(t, d, batch_id)
        await t.run("UPDATE order_batches SET status = CAST(:st AS batch_status) WHERE id = :b", st=status, b=batch_id)
        return await load_order2(t, d, oid)


@router.post("/batches/{batch_id}/notify", response_model=Order2Out)
async def notify(batch_id: int, request: Request, p: Principal = Depends(driver_user)) -> Order2Out:
    """«أرسل الإشعار للعميل»: القاعدة تكتبه لكل أعضاء المنشأة (إشعار + SMS) بما يصل الآن ولاحقاً."""
    return await _batch_step(request, p, batch_id, "notified")


@router.post("/batches/{batch_id}/depart", response_model=Order2Out)
async def depart(batch_id: int, request: Request, p: Principal = Depends(driver_user)) -> Order2Out:
    """«انطلاق الدفعة»: لا يعمل قبل الإشعار (batch_departure_requires_notice)."""
    return await _batch_step(request, p, batch_id, "departed")


@router.post("/batches/{batch_id}/deliver", response_model=Order2Out)
async def deliver(batch_id: int, request: Request, p: Principal = Depends(driver_user)) -> Order2Out:
    """«سلّمت وحصّلت»: المسلَّم والتحصيل والأجر والتكلفة في الدفتر، والطلبية تُسلَّم حين تكتمل."""
    return await _batch_step(request, p, batch_id, "delivered")


# ——— النزاع والأمانة والورقة ——————————————————————————————————————————————————————————
@router.post("/orders/{order_id}/disputes", response_model=list[DisputeOut], status_code=201)
async def dispute(order_id: int, body: DisputeIn, request: Request, p: Principal = Depends(driver_user)) -> list[DisputeOut]:
    """صنف رفضه العميل أو ناقص: يفتحه سائق الطلبية وحده (b_dispute_insert)، ويقرره المالك."""
    async with request.app.state.db.tx("driver", p.user_id) as t:
        d = await driver(t, p.user_id)
        await _mine(t, d, order_id)
        did = await t.val("INSERT INTO disputes (order_id, order_item_id, opened_by_role, opened_by, kind, description) "
                          "VALUES (:o, :i, 'driver', 0, CAST(:k AS dispute_kind), :ds) RETURNING id",
                          o=order_id, i=body.order_item_id, k=body.kind, ds=body.description.strip())
        for mid in body.media_ids:
            await t.run("INSERT INTO dispute_media (dispute_id, media_id) VALUES (:d, :m)", d=did, m=mid)
        got = await t.all("SELECT id, order_item_id, kind::text AS kind, description, status::text AS status, created_at "
                          "FROM disputes WHERE order_id = :o AND opened_by = :u ORDER BY id DESC", o=order_id, u=p.user_id)
    return [DisputeOut(**r) for r in got]


async def load_order(t: Tx, user_id: int, order_id: int) -> OrderOut:
    d = await driver(t, user_id)
    o = await t.one("SELECT id, status::text AS status, customer_name, customer_phone, dest_address, dest_lat, "
                    "dest_lng, amount_to_collect, driver_pay FROM v_driver_orders WHERE id = :o AND driver_id = :d",
                    o=order_id, d=d["id"])
    if o is None:
        raise ApiError(404, "order_not_found")
    return OrderOut(**o, stops=await _stops(t, order_id))


@router.get("/orders/{order_id}/sheet.pdf", response_class=Response,
            responses={200: {"content": {"application/pdf": {}}}})
async def sheet(order_id: int, request: Request, p: Principal = Depends(driver_user)) -> Response:
    async with request.app.state.db.tx("driver", p.user_id) as t:
        o = await load_order(t, p.user_id, order_id)
    return Response(documents.driver_sheet(o), media_type="application/pdf")


@router.get("/custody", response_model=list[CustodyItemOut])
async def custody(request: Request, p: Principal = Depends(driver_user)) -> list[CustodyItemOut]:
    """ما بعهدتي من طلبيات ملغاة: صنف وكمية، بلا تكلفة ولا مورد (v_driver_custody)."""
    async with request.app.state.db.tx("driver", p.user_id) as t:
        d = await driver(t, p.user_id)
        got = await t.all("SELECT id, order_id, name_ar, unit::text AS unit, unit_size, qty, status::text AS status "
                          "FROM v_driver_custody WHERE driver_id = :d ORDER BY id", d=d["id"])
    return [CustodyItemOut(**r) for r in got]



# ——— §12-ط: موعد الوصول للمورد و«وصلت» (يراهما المورد بلا شيء عن العميل) ——————————————————————
@router.put("/stops/{stop_id}/eta", response_model=Order2Out)
async def stop_eta(stop_id: int, body: EtaIn, request: Request, p: Principal = Depends(driver_user)) -> Order2Out:
    """يكتبه السائق قبل مفتاح الخرائط (يُحسب آلياً حين يُضبط). يبدأ التجميع إن لم يبدأ."""
    async with request.app.state.db.tx("driver", p.user_id) as t:
        d = await driver(t, p.user_id)
        oid = await _stop_order(t, d, stop_id)
        await _start(t, oid)
        await t.run("UPDATE pickup_stops SET eta_at = :e WHERE id = :s", e=body.eta_at, s=stop_id)
        return await load_order2(t, d, oid)


@router.post("/stops/{stop_id}/arrive", response_model=Order2Out)
async def arrive(stop_id: int, request: Request, p: Principal = Depends(driver_user)) -> Order2Out:
    """«وصلت إلى نقطة الاستلام»: وقته من القاعدة، ومرة واحدة (stop_already_arrived)."""
    async with request.app.state.db.tx("driver", p.user_id) as t:
        d = await driver(t, p.user_id)
        oid = await _stop_order(t, d, stop_id)
        await _start(t, oid)
        await t.run("UPDATE pickup_stops SET arrived_at = now() WHERE id = :s", s=stop_id)
        return await load_order2(t, d, oid)
