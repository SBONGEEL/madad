"""المال في السلك نصٌّ بثلاث خانات (م-1): لا float يضيّع الفلس، ولا خانتان."""
from __future__ import annotations

from decimal import ROUND_HALF_UP, Decimal
from typing import Annotated

from pydantic import PlainSerializer

THREE = Decimal("0.001")


def fmt(value: Decimal | int | float | str) -> str:
    return str(Decimal(str(value)).quantize(THREE, rounding=ROUND_HALF_UP))


# حقل مال في أي مخطط خرج: يُكتب "911.313"
Money = Annotated[Decimal, PlainSerializer(fmt, return_type=str, when_used="always")]
Qty = Annotated[Decimal, PlainSerializer(lambda v: format(Decimal(v).normalize(), "f"), return_type=str,
                                         when_used="always")]
