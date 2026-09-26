"""مخططات خرج المورد. لا عميل ولا وجهة ولا سعر بيع — ولا كود السائق (م-3)."""
from __future__ import annotations

from datetime import datetime

from pydantic import BaseModel, Field

from app.core.money import Qty
from app.schemas.common import Out


class MeOut(Out):
    full_name: str
    name: str
    status: str


class PickupLineOut(Out):
    product_name: str
    unit: str
    unit_size: Qty
    planned_qty: Qty
    collected_qty: Qty | None


class PickupOut(Out):
    id: int
    status: str
    supplier_code: str
    handed_over: bool
    assigned_at: datetime | None
    lines: list[PickupLineOut]


class ScanIn(BaseModel):
    code: str = Field(pattern=r"^[0-9]{6}$")
