"""موجّه السائق. يقرأ من v_driver_* وحدها، ولا يرى إلا طلبياته.
تسمية نقطة الاستلام من v_driver_stop_labels (م-2): الاسم لا يخرج إلا والإعداد مفتوح."""
from __future__ import annotations

from fastapi import APIRouter, Depends, Request, Response

from app.api.deps import Principal, driver_user
from app.core.db import Tx
from app.core.errors import ApiError
from app.schemas.common import HandoverOut
from app.schemas.driver import CodeIn, CustodyItemOut, MeOut, OrderOut, OrderSummaryOut, StopLineOut, StopOut
from app.services import documents

router = APIRouter(prefix="/api/driver", tags=["driver"])


async def _driver(t: Tx, user_id: int) -> dict:
    row = await t.one("SELECT id, full_name, status::text AS status, pay_method::text AS pay_method "
                      "FROM drivers WHERE user_id = :u", u=user_id)
    if row is None:
        raise ApiError(404, "no_driver")
    return row


@router.get("/me", response_model=MeOut)
async def me(request: Request, p: Principal = Depends(driver_user)) -> MeOut:
    async with request.app.state.db.tx("driver", p.user_id) as t:
        d = await _driver(t, p.user_id)
    return MeOut(full_name=d["full_name"], status=d["status"], pay_method=d["pay_method"])


@router.get("/orders", response_model=list[OrderSummaryOut])
async def orders(request: Request, p: Principal = Depends(driver_user)) -> list[OrderSummaryOut]:
    async with request.app.state.db.tx("driver", p.user_id) as t:
        d = await _driver(t, p.user_id)
        rows = await t.all("SELECT id, status::text AS status, customer_name, amount_to_collect FROM v_driver_orders "
                           "WHERE driver_id = :d ORDER BY id DESC", d=d["id"])
    return [OrderSummaryOut(**r) for r in rows]


async def load_order(t: Tx, user_id: int, order_id: int) -> OrderOut:
    d = await _driver(t, user_id)
    o = await t.one("SELECT id, status::text AS status, customer_name, customer_phone, dest_address, dest_lat, "
                    "dest_lng, amount_to_collect, driver_pay FROM v_driver_orders WHERE id = :o AND driver_id = :d",
                    o=order_id, d=d["id"])
    if o is None:
        raise ApiError(404, "order_not_found")
    stops = await t.all(
        "SELECT s.id, s.seq, l.pickup_label AS label, s.status::text AS status, s.lat, s.lng, s.address_text, "
        "s.pickup_code, EXISTS (SELECT 1 FROM pickup_handovers h WHERE h.stop_id = s.id) AS handed_over "
        "FROM v_driver_stops s JOIN v_driver_stop_labels l ON l.stop_id = s.id WHERE s.order_id = :o "
        "ORDER BY s.seq", o=order_id)
    lines = await t.all("SELECT id, stop_id, name_ar, unit::text AS unit, unit_size, planned_qty, collected_qty "
                        "FROM v_driver_stop_lines WHERE stop_id IN (SELECT id FROM pickup_stops WHERE order_id = :o) "
                        "ORDER BY id", o=order_id)
    return OrderOut(**o, stops=[
        StopOut(**s, lines=[StopLineOut(**{k: v for k, v in ln.items() if k != "stop_id"})
                            for ln in lines if ln["stop_id"] == s["id"]]) for s in stops])


@router.get("/orders/{order_id}", response_model=OrderOut)
async def order(order_id: int, request: Request, p: Principal = Depends(driver_user)) -> OrderOut:
    async with request.app.state.db.tx("driver", p.user_id) as t:
        return await load_order(t, p.user_id, order_id)


@router.post("/stops/{stop_id}/code", response_model=HandoverOut)
async def code(stop_id: int, body: CodeIn, request: Request, p: Principal = Depends(driver_user)) -> HandoverOut:
    """م-3 (ب): السائق يكتب الرقم الذي يعطيه المورد. المطابقة والصلاحية في القاعدة."""
    async with request.app.state.db.tx("driver", p.user_id) as t:
        d = await _driver(t, p.user_id)
        if not await t.val("SELECT 1 FROM pickup_stops s JOIN orders o ON o.id = s.order_id "
                           "WHERE s.id = :i AND o.driver_id = :d", i=stop_id, d=d["id"]):
            raise ApiError(404, "stop_not_found")
        await t.run("INSERT INTO pickup_handovers (stop_id, method, code_given) VALUES (:i, 'code_entry', :c)",
                    i=stop_id, c=body.code)
    return HandoverOut(handed_over=True, method="code_entry")


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
        d = await _driver(t, p.user_id)
        rows = await t.all("SELECT id, order_id, name_ar, unit::text AS unit, unit_size, qty, status::text AS status "
                           "FROM v_driver_custody WHERE driver_id = :d ORDER BY id", d=d["id"])
    return [CustodyItemOut(**r) for r in rows]
