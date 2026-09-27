"""المورد — طلبات الاستلام (م-3) ومستحقاته. يقرأ من v_supplier_pickups وv_supplier_received وv_supplier_payouts
ورصيده وحده (supplier_own_due): لا عميل ولا وجهة ولا سعر بيع ولا كود السائق.
"""
from __future__ import annotations

from fastapi import APIRouter, Depends, Request, Response

from app.api.deps import Principal, supplier_user
from app.api.supplier.core import supplier
from app.core.db import Tx
from app.core.errors import ApiError
from app.core.money import fmt
from app.schemas.common import HandoverOut
from app.schemas.supplier import DuesOut, PayoutOut, Pickup2Out, PickupLineOut, PickupOut, ReceivedOut, ScanIn
from app.services import documents
from app.services.pdf import esc, render, rows

router = APIRouter()

CYCLE_AR = {"daily": "يومي", "weekly": "أسبوعي", "semimonthly": "نصف شهري", "monthly": "شهري"}


async def load_pickups(t: Tx, user_id: int, stop_id: int | None = None) -> list[PickupOut]:
    s = await supplier(t, user_id)
    rows_ = await t.all(
        "SELECT id, status::text AS status, supplier_code, handed_over, assigned_at, product_name, "
        "unit::text AS unit, unit_size, planned_qty, collected_qty FROM v_supplier_pickups "
        "WHERE supplier_id = :s AND (CAST(:stop AS bigint) IS NULL OR id = :stop) ORDER BY id, line_id",
        s=s["id"], stop=stop_id)
    out: dict[int, PickupOut] = {}
    for r in rows_:
        p = out.get(r["id"]) or out.setdefault(r["id"], PickupOut(
            id=r["id"], status=r["status"], supplier_code=r["supplier_code"], handed_over=r["handed_over"],
            assigned_at=r["assigned_at"], lines=[]))
        p.lines.append(PickupLineOut(product_name=r["product_name"], unit=r["unit"], unit_size=r["unit_size"],
                                     planned_qty=r["planned_qty"], collected_qty=r["collected_qty"]))
    return list(out.values())


@router.get("/pickups", response_model=list[Pickup2Out])
async def pickups(request: Request, p: Principal = Depends(supplier_user)) -> list[Pickup2Out]:
    async with request.app.state.db.tx("supplier", p.user_id) as t:
        s = await supplier(t, p.user_id)
        rows_ = await t.all("""
SELECT v.id, st.seq, v.status::text AS status, v.supplier_code, l.label AS location_label, v.assigned_at, v.handed_over,
       h.method::text AS handover_method, h.created_at AS handed_over_at,
       v.product_name, v.unit::text AS unit, v.unit_size, v.planned_qty, v.collected_qty, v.eta_at, v.arrived_at
  FROM v_supplier_pickups v JOIN pickup_stops st ON st.id = v.id
  JOIN supplier_pickup_locations l ON l.id = v.pickup_location_id
  LEFT JOIN pickup_handovers h ON h.stop_id = v.id
 WHERE v.supplier_id = :s ORDER BY (v.status = 'pending') DESC, v.assigned_at DESC NULLS LAST, v.id, v.line_id""", s=s["id"])
    out: dict[int, Pickup2Out] = {}
    for r in rows_:
        pk = out.get(r["id"]) or out.setdefault(r["id"], Pickup2Out(
            id=r["id"], seq=r["seq"], status=r["status"], supplier_code=r["supplier_code"], location_label=r["location_label"],
            assigned_at=r["assigned_at"], handed_over=r["handed_over"], handover_method=r["handover_method"],
            handed_over_at=r["handed_over_at"], lines=[], eta_at=r["eta_at"], arrived_at=r["arrived_at"]))
        pk.lines.append(PickupLineOut(product_name=r["product_name"], unit=r["unit"], unit_size=r["unit_size"],
                                      planned_qty=r["planned_qty"], collected_qty=r["collected_qty"]))
    return list(out.values())


@router.post("/pickups/{stop_id}/scan", response_model=HandoverOut)
async def scan(stop_id: int, body: ScanIn, request: Request, p: Principal = Depends(supplier_user)) -> HandoverOut:
    """م-3 (أ): المورد يمسح رمز QR في هاتف السائق. المطابقة والصلاحية في القاعدة (trg_handover_before)."""
    async with request.app.state.db.tx("supplier", p.user_id) as t:
        s = await supplier(t, p.user_id)
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


# ——— المستحقات والدفعات ——————————————————————————————————————————————————————————————
async def _dues(t: Tx, cycle: str | None) -> DuesOut:
    got = await t.all("SELECT id, received_at, product_name, unit::text AS unit, unit_size, collected_qty, unit_price, amount "
                      "FROM v_supplier_received ORDER BY received_at DESC NULLS LAST, id DESC LIMIT 60")
    pays = await t.all("SELECT id, amount, period_start, period_end, paid_at, receipt_ready FROM v_supplier_payouts "
                       "ORDER BY paid_at DESC LIMIT 24")
    return DuesOut(due=await t.val("SELECT supplier_own_due()"), payout_cycle=cycle,
                   next_payout_on=await t.val("SELECT supplier_next_payout(actor_supplier())"),
                   received=[ReceivedOut(**r) for r in got], payouts=[PayoutOut(**r) for r in pays])


@router.get("/dues", response_model=DuesOut)
async def dues(request: Request, p: Principal = Depends(supplier_user)) -> DuesOut:
    async with request.app.state.db.tx("supplier", p.user_id) as t:
        s = await supplier(t, p.user_id)
        return await _dues(t, s["payout_cycle"])


@router.get("/dues.pdf", response_class=Response, responses={200: {"content": {"application/pdf": {}}}})
async def dues_pdf(request: Request, payout_id: int | None = None, p: Principal = Depends(supplier_user)) -> Response:
    """كشف المستحق الآن، أو إيصال دفعة بعينها (payout_id): المبلغ والفترة وما استُلم فيها. لا شيء عن العملاء (§5)."""
    async with request.app.state.db.tx("supplier", p.user_id) as t:
        s = await supplier(t, p.user_id)
        d = await _dues(t, s["payout_cycle"])
    head = f"<h1>{esc(s['name'])}</h1>"
    if payout_id is not None:
        pay = next((x for x in d.payouts if x.id == payout_id), None)
        if pay is None:
            raise ApiError(404, "payout_not_found")
        lines = [r for r in d.received if r.received_at and pay.period_start <= r.received_at.date() <= pay.period_end]
        head += (f"<p>إيصال صرف رقم <span class='num'>{pay.id}</span> · المبلغ <span class='num'>{fmt(pay.amount)}</span> د.ل"
                 f" · الفترة <span class='num'>{pay.period_start:%d/%m/%Y}</span> – <span class='num'>{pay.period_end:%d/%m/%Y}</span></p>")
        title = "إيصال صرف"
    else:
        lines = d.received
        head += (f"<p>المستحق الآن <span class='num'>{fmt(d.due)}</span> د.ل"
                 + (f" · الصرف {esc(CYCLE_AR.get(d.payout_cycle or '', d.payout_cycle or ''))}" if d.payout_cycle else "") + "</p>")
        title = "كشف المستحقات"
    body = head + ("<table><thead><tr><th>اليوم</th><th>الصنف</th><th>الكمية</th><th>المبلغ</th></tr></thead><tbody>"
                   + rows([[r.received_at.strftime("%d/%m") if r.received_at else "", r.product_name,
                            format(r.collected_qty.normalize(), "f"), fmt(r.amount) if r.amount is not None else ""]
                           for r in lines], numeric_from=2) + "</tbody></table>")
    return Response(render(title=title, body=body), media_type="application/pdf")
