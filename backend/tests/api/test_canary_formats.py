"""الاستثناء 8 (§12-ل ٤): الشاهد الجديد يُمسك بكل صيغة تُعرض بها المبالغ في الـAPI وفي PDF — والحارس بمنطقه نفسه.

الصيغ: المبلغ بثلاث خانات (fmt، ومنه Money في كل مخطط خرج)، ومعه «د.ل»، وداخل JSON، وداخل بايتات PDF.
فواصل الآلاف: لا يكتبها الـAPI ولا الـPDF (fmt بلا فواصل — مثبت هنا)، فلا صيغة لها يعمى عنها الحارس.
وهامش الشاهد بسبع خانات: لا يقع في وقت (ست خانات على الأكثر) ولا سعر (ثلاث) — مثبت هنا أيضاً.
"""
from __future__ import annotations

import json
from datetime import datetime, timezone
from decimal import Decimal

import pytest

from app.core.money import fmt
from app.services.pdf import esc, render
from tests.api.test_leak_responses import pdf_text
from tests.db.test_isolation import COST_CANARIES, leaks
from tests.db.world import MARGIN_CANARY, PURCHASE_CANARY, act, build

MONEY = [str(PURCHASE_CANARY), "1555.54"]      # مبالغ: تُعرض بثلاث خانات (Money)


@pytest.mark.parametrize("canary", MONEY)
def test_guard_catches_the_canary_in_every_amount_format(canary):
    v = Decimal(canary)
    forms = {
        "three_places": fmt(v),
        "with_currency": f"{fmt(v)} د.ل",
        "json": json.dumps({"amount": fmt(v), "raw": str(v)}),
        "pdf": pdf_text(render(title="شاهد", body=f"<p>المبلغ <span class='num'>{esc(fmt(v))} د.ل</span> — {esc(str(v))}</p>")),
    }
    for name, text in forms.items():
        assert canary in leaks(text, COST_CANARIES), f"{name}: {text[:120]}"


def test_guard_catches_the_margin_canary_as_the_api_and_pdf_carry_it():
    """الهامش نسبة لا مبلغ: يخرج من القاعدة كما هو (Decimal)، في JSON وفي سجل التدقيق وفي PDF."""
    m = str(MARGIN_CANARY)
    for text in (m, json.dumps({"margin_value": m}), json.dumps({"changes": {"margin_value": [None, m]}}),
                 pdf_text(render(title="شاهد", body=f"<p>الهامش <span class='num'>{esc(m)}</span>%</p>"))):
        assert m in leaks(text, COST_CANARIES), text[:120]


def test_api_and_pdf_amounts_carry_no_thousands_separator():
    assert fmt(Decimal("1555.54")) == "1555.540" and fmt(Decimal("1234567.5")) == "1234567.500"


def test_new_margin_canary_cannot_occur_in_a_time_or_a_price():
    s = str(MARGIN_CANARY)
    assert len(s.split(".")[1]) > 6                       # أطول من كسر أي وقت (ميكروثانية = 6)
    t = datetime(2026, 9, 27, 10, 17, 17, 170000, tzinfo=timezone.utc)
    assert s not in t.isoformat() and s not in fmt(MARGIN_CANARY) and s not in fmt(Decimal("1717.17"))
    assert "17.17" in t.isoformat()                        # الإنذار الكاذب القديم كان هذا بعينه


async def test_the_real_world_margin_reaches_the_owner_exactly_as_the_canary(db):
    await build(db)
    await act(db, "system")
    assert await db.fetchval("SELECT margin_value::text FROM catalog_item_pricing LIMIT 1") == str(MARGIN_CANARY)
    assert await db.fetchval("SELECT sale_price FROM catalog_items LIMIT 1") == Decimal("911.313")   # الأسعار كما كانت
