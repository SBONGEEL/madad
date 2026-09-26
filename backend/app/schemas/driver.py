"""مخططات خرج السائق. لا تكلفة ولا هامش. واسم المورد لا حقل له: يصل في «label»
وحدها، وحين يُغلقه المالك (م-2) تحمل «نقطة استلام N»، فلا يخرج الاسم أصلاً."""
from __future__ import annotations

from decimal import Decimal

from pydantic import BaseModel, Field

from app.core.money import Money, Qty
from app.schemas.common import Out


class MeOut(Out):
    full_name: str
    status: str
    pay_method: str | None


class StopLineOut(Out):
    id: int
    name_ar: str
    unit: str
    unit_size: Qty
    planned_qty: Qty
    collected_qty: Qty | None


class StopOut(Out):
    id: int
    seq: int
    label: str
    status: str
    lat: Decimal | None
    lng: Decimal | None
    address_text: str | None
    pickup_code: str          # يُعرض رمز QR ليمسحه المورد (م-3)
    handed_over: bool
    lines: list[StopLineOut]


class OrderSummaryOut(Out):
    id: int
    status: str
    customer_name: str
    amount_to_collect: Money


class OrderOut(Out):
    id: int
    status: str
    customer_name: str
    customer_phone: str
    dest_address: str | None
    dest_lat: Decimal | None
    dest_lng: Decimal | None
    amount_to_collect: Money
    driver_pay: Money | None
    stops: list[StopOut]


class CustodyItemOut(Out):
    id: int
    order_id: int
    name_ar: str
    unit: str
    unit_size: Qty
    qty: Qty
    status: str


class CodeIn(BaseModel):
    code: str = Field(pattern=r"^[0-9]{6}$")
