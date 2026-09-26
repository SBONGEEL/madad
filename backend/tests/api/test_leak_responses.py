"""حارس العزل على السلك (§11.1): كل عملية تحت /api/customer و/api/supplier و/api/driver
تُستدعى برمز جمهورها على عالمٍ حيّ فيه الشواهد، ويُفحص جسم الاستجابة — نصّ JSON أو
نصّ بايتات الـPDF — فلا يحمل سعر شراء ولا هامشاً ولا ربحاً ولا اسم مورد (العميل
والسائق)، ولا اسم عميل ولا عنوانه ولا سعر البيع (المورد).

الشاهد الإيجابي أولاً: الفاحص نفسه يمسك الشواهد في مصدر يحملها (لوحة المالك،
وPDF مولَّد بالمحرّك نفسه)، وإلا فنظافة الباقي بلا معنى.

التغطية مغلقة: عملية لا يعرف الحارس كيف يستدعيها تُسقط الاختبار باسمها، فلا يمرّ
مسار جديد بلا فحص.
"""
from __future__ import annotations

import io

from pypdf import PdfReader

from app.services import pdf
from tests.api.audience_cases import WRITE_CASES, _path  # استثناء 7: الحالات هناك
from tests.api.routing import AUDIENCE_PREFIXES, operations
from tests.api.world_api import live_world
from tests.db.test_isolation import COST_CANARIES, SUPPLIER_FORBIDDEN, leaks

FORBIDDEN = {"customer": COST_CANARIES, "driver": COST_CANARIES, "supplier": SUPPLIER_FORBIDDEN}



def pdf_text(data: bytes) -> str:
    """نصّ بايتات الـPDF. المستخرج يقطع الأرقام في الفقرة العربية («777 .77» — قِيس بالشاهد
    الإيجابي)، فيُضاف إليه النصّ نفسه بلا مسافات: الشواهد لا مسافة فيها، فلا يعمى الفحص."""
    text = "\n".join(p.extract_text() or "" for p in PdfReader(io.BytesIO(data)).pages)
    return text + "\n" + "".join(text.split())


def body_text(response) -> str:
    if response.headers.get("content-type", "").startswith("application/pdf"):
        return pdf_text(response.content)
    return response.text


async def test_positive_witness_json_scanner_sees_costs_in_admin(db, client):
    live = await live_world(db, client)
    r = await client.get(f"/api/admin/orders/{live.order}/costs", headers=live.auth("admin"))
    assert r.status_code == 200, r.text
    found = leaks(body_text(r), COST_CANARIES)
    assert "SUPPLIER_LEAK_CANARY" in found and "777.77" in found, found


def test_positive_witness_pdf_scanner_sees_canaries_in_pdf_bytes():
    canaries = COST_CANARIES + SUPPLIER_FORBIDDEN
    data = pdf.render(title="شاهد", body="".join(f"<p>{c}</p>" for c in canaries))
    assert sorted(leaks(pdf_text(data), canaries)) == sorted(canaries)


async def test_every_audience_operation_is_clean_on_the_wire(db, client, app):
    live = await live_world(db, client)
    checked: dict[str, int] = {}
    uncovered, offences = [], []
    for audience in ("customer", "supplier", "driver"):
        ops = operations(app, AUDIENCE_PREFIXES[audience])
        assert ops, f"لا مسارات لـ{audience} — حارس بلا موضوع لا يثبت شيئاً"
        for method, path in ops:
            if method == "GET":
                r = await client.get(_path(path, live), headers=live.auth(audience))
            elif (method, path) in WRITE_CASES:
                r = await client.request(method, _path(path, live), headers=live.auth(audience),
                                         json=WRITE_CASES[(method, path)](live))
            else:
                uncovered.append(f"{method} {path}")
                continue
            assert r.status_code < 500, f"{method} {path}: {r.status_code} {r.text[:300]}"
            if method == "GET":
                assert r.status_code == 200, f"{method} {path}: {r.status_code} {r.text[:300]}"
                assert r.content, f"{method} {path}: استجابة فارغة — فحص بلا موضوع"
            bad = leaks(body_text(r), FORBIDDEN[audience])
            if bad:
                offences.append(f"{audience} {method} {path}: {bad}")
            checked[audience] = checked.get(audience, 0) + 1
    assert not uncovered, "عمليات لا يغطيها حارس العزل:\n" + "\n".join(uncovered)
    assert not offences, "تسريب على السلك:\n" + "\n".join(offences)
    assert all(checked.get(a) for a in ("customer", "supplier", "driver")), checked


async def test_pdfs_are_really_pdfs_with_content(db, client):
    """فحص نصّ الـPDF لا يُصدَّق إن كان المستخرج فارغاً."""
    live = await live_world(db, client)
    for audience, path in (("customer", f"/api/customer/orders/{live.order}/receipt.pdf"),
                           ("driver", f"/api/driver/orders/{live.order}/sheet.pdf"),
                           ("supplier", f"/api/supplier/pickups/{live.stop}/slip.pdf")):
        r = await client.get(path, headers=live.auth(audience))
        assert r.status_code == 200, (path, r.text[:300])
        assert r.content.startswith(b"%PDF"), path
        assert str(live.order) in body_text(r) or str(live.stop) in body_text(r), path


async def test_audience_token_cannot_cross_into_another_audience(db, client, app):
    live = await live_world(db, client)
    for audience, prefix in AUDIENCE_PREFIXES.items():
        other = "customer" if audience != "customer" else "driver"
        method, path = next(op for op in operations(app, prefix) if op[0] == "GET")
        r = await client.get(_path(path, live), headers=live.auth(other))
        assert r.status_code in (401, 403), (audience, path, r.status_code)
