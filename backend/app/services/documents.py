"""الـPDF الثلاثة، كلٌّ من مخطط خرج جمهوره وحده (§10). ما لا يحمله المخطط لا يصل هنا."""
from __future__ import annotations

from app.core.money import fmt
from app.schemas import customer as C
from app.schemas import driver as D
from app.schemas import supplier as S
from app.services.pdf import esc, fill, render, rows

STATUS_AR = {"draft": "مسودة", "placed": "أُرسلت", "confirmed": "مؤكَّدة", "assigned": "أُسندت لسائق",
             "collecting": "يجري التجميع", "partially_delivered": "سُلِّمت جزئياً", "delivered": "سُلِّمت",
             "closed": "مغلقة", "cancelled": "ملغاة", "pending": "بانتظار الاستلام", "collected": "استُلمت",
             "short": "ناقصة", "refused": "مرفوضة"}


def _q(v) -> str:
    return "" if v is None else format(v.normalize(), "f")


def customer_receipt(o: C.OrderOut, customer_name: str) -> bytes:
    body = fill("customer_receipt.html", order_id=o.id, status=STATUS_AR.get(o.status, o.status),
                placed_at=o.placed_at.strftime("%Y/%m/%d %H:%M") if o.placed_at else "",
                customer_name=customer_name, address=o.dest_address or "",
                rows=rows([[ln.name_ar, ln.unit, _q(ln.qty), fmt(ln.unit_price) if ln.unit_price is not None else "",
                            fmt(ln.line_total) if ln.line_total is not None else ""] for ln in o.lines], numeric_from=2),
                subtotal=fmt(o.subtotal), delivery_fee=fmt(o.delivery_fee), total=fmt(o.total))
    return render(title="إيصال طلبية", body=body)


def supplier_slip(p: S.PickupOut) -> bytes:
    body = fill("supplier_slip.html", stop_id=p.id,
                assigned_at=p.assigned_at.strftime("%Y/%m/%d %H:%M") if p.assigned_at else "",
                supplier_code=p.supplier_code,
                rows=rows([[ln.product_name, ln.unit, _q(ln.planned_qty), _q(ln.collected_qty)] for ln in p.lines],
                          numeric_from=2))
    return render(title="طلب استلام", body=body)


def driver_sheet(o: D.OrderOut) -> bytes:
    stops = []
    for s in o.stops:
        stops.append(
            f'<div class="box"><b>{esc(s.seq)} · {esc(s.label)}</b> — {esc(STATUS_AR.get(s.status, s.status))}'
            f'<br><span class="muted">{esc(s.address_text or "")}</span>'
            '<table><tr><th>الصنف</th><th>الوحدة</th><th>المطلوب</th><th>المستلم</th></tr>'
            + rows([[ln.name_ar, ln.unit, _q(ln.planned_qty), _q(ln.collected_qty)] for ln in s.lines], numeric_from=2)
            + "</table></div>")
    body = fill("driver_sheet.html", order_id=o.id, status=STATUS_AR.get(o.status, o.status),
                customer_name=o.customer_name, customer_phone=o.customer_phone, address=o.dest_address or "",
                stops="\n".join(stops), amount_to_collect=fmt(o.amount_to_collect))
    return render(title="كشف طلبية", body=body)
