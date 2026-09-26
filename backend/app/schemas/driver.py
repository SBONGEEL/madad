"""مخططات خرج السائق. لا تكلفة ولا هامش. واسم المورد لا حقل له: يصل في «label»
وحدها، وحين يُغلقه المالك (م-2) تحمل «نقطة استلام N»، فلا يخرج الاسم أصلاً."""
from __future__ import annotations

from datetime import datetime
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


# ——— تطبيق السائق كاملاً (الجزء 13) ——————————————————————————————————————————————
class DriverOut(Out):
    id: int
    full_name: str
    status: str
    pay_method: str | None
    vehicle: str
    capacity_kg: Decimal | None
    city_name: str
    documents_complete: bool   # قرار المالك 27/09: حالة الأوراق وحدها، بلا صورها


class Me2Out(Out):
    full_name: str
    driver: DriverOut | None
    unread: int


class MediaOut(Out):
    id: int


class RegistrationIn(BaseModel):
    full_name: str = Field(min_length=1, max_length=120)
    vehicle: str = Field(pattern="^(motorcycle|car|van|pickup|truck)$")
    capacity_kg: Decimal | None = Field(default=None, gt=0, decimal_places=1)
    id_media_id: int
    license_media_id: int
    license_back_media_id: int
    photo_media_id: int


class AvailableOut(Out):
    id: int
    customer_name: str
    branch_name: str
    dest_address: str | None
    dest_lat: Decimal | None
    dest_lng: Decimal | None
    stops: int
    route_km: Decimal | None
    pay_estimate: Money | None
    amount_to_collect: Money
    load_kg: Decimal
    weight_complete: bool
    capacity_kg: Decimal | None
    over_capacity: bool
    my_offer: dict | None


class PayOfferIn(BaseModel):
    amount: Decimal = Field(gt=0, decimal_places=3)


class ItemOut(Out):
    id: int
    name_ar: str
    unit: str
    unit_size: Qty
    qty: Qty
    collected_qty: Qty
    delivered_qty: Qty
    price: Money | None
    line_value: Money | None


class BatchOut(Out):
    id: int
    seq: int
    status: str
    eta_at: datetime | None
    next_eta_at: datetime | None
    notified_at: datetime | None
    departed_at: datetime | None
    delivered_at: datetime | None
    value: Money
    lines: list[dict]
    notice: dict | None


class Order2Out(Out):
    id: int
    status: str
    customer_name: str
    customer_phone: str
    branch_name: str
    dest_address: str | None
    dest_lat: Decimal | None
    dest_lng: Decimal | None
    amount_to_collect: Money
    delivery_fee: Money
    driver_pay: Money | None
    collection_mode: str | None
    route_km: Decimal | None
    load_kg: Decimal
    weight_complete: bool
    capacity_kg: Decimal | None
    over_capacity: bool
    stops: list[StopOut]
    items: list[ItemOut]
    batches: list[BatchOut]


class Order2SummaryOut(Out):
    id: int
    status: str
    customer_name: str
    branch_name: str
    amount_to_collect: Money
    driver_pay: Money | None


class ConfirmLineIn(BaseModel):
    line_id: int
    collected_qty: Decimal = Field(ge=0, decimal_places=3)


class ConfirmStopIn(BaseModel):
    lines: list[ConfirmLineIn] = Field(min_length=1)
    photo_media_id: int | None = None


class BatchLineIn(BaseModel):
    order_item_id: int
    qty: Decimal = Field(gt=0, decimal_places=3)


class BatchIn(BaseModel):
    lines: list[BatchLineIn] = Field(min_length=1)
    eta_at: datetime | None = None
    next_eta_at: datetime | None = None


class DisputeIn(BaseModel):
    order_item_id: int | None = None
    kind: str = Field(pattern="^(damaged|short|refused|other)$")
    description: str = Field(min_length=1, max_length=1000)
    media_ids: list[int] = []


class DisputeOut(Out):
    id: int
    order_item_id: int | None
    kind: str
    description: str
    status: str
    created_at: datetime


class WalletOut(Out):
    cash_held: Money
    cash_cap: Money | None
    over_cap: bool
    wage_due: Money
    pay_method: str | None
    handover_due: Money


class SettlementOut(Out):
    kind: str
    id: int
    amount: Money
    offset_amount: Money
    order_id: int | None
    received_by: str | None
    at: datetime | None


class NotificationOut(Out):
    id: int
    kind: str
    title: str
    body: str
    order_id: int | None
    created_at: datetime
    read: bool


class ReadIn(BaseModel):
    ids: list[int] = []
    all: bool = False


class DeviceIn(BaseModel):
    fcm_token: str = Field(min_length=10, max_length=4096)
    platform: str = Field(pattern="^(android|web)$")
