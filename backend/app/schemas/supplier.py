"""مخططات خرج المورد. لا عميل ولا وجهة ولا سعر بيع — ولا كود السائق (م-3)."""
from __future__ import annotations

from datetime import date, datetime
from decimal import Decimal

from pydantic import BaseModel, Field

from app.core.money import Money, Qty
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


# ——— تطبيق المورد كاملاً (الجزء 12) ——————————————————————————————————————————————
class SupplierOut(Out):
    id: int
    name: str
    status: str
    contact_name: str
    phone: str
    payout_cycle: str | None


class ContactOut(Out):
    phone: str | None
    whatsapp: str | None


class Me2Out(Out):
    full_name: str
    supplier: SupplierOut | None
    unread: int
    contact: ContactOut | None = None     # §12-ط: «تواصل مع مَدَد»


class MediaOut(Out):
    id: int


class LocationIn(BaseModel):
    label: str = Field(min_length=1, max_length=80)
    lat: Decimal = Field(ge=-90, le=90)
    lng: Decimal = Field(ge=-180, le=180)
    address_text: str = Field(min_length=1, max_length=300)


class LocationPatchIn(BaseModel):
    label: str | None = Field(default=None, min_length=1, max_length=80)
    lat: Decimal | None = Field(default=None, ge=-90, le=90)
    lng: Decimal | None = Field(default=None, ge=-180, le=180)
    address_text: str | None = Field(default=None, min_length=1, max_length=300)
    active: bool | None = None


class LocationOut(Out):
    id: int
    label: str
    lat: Decimal
    lng: Decimal
    address_text: str
    active: bool
    active_offers: int


class RegistrationIn(BaseModel):
    name: str = Field(min_length=1, max_length=120)
    contact_name: str = Field(min_length=1, max_length=120)
    locations: list[LocationIn] = Field(min_length=1)
    owner_id_media_id: int
    cr_media_id: int | None = None


class DashboardOut(Out):
    month_sales: Money
    active_offers: int
    pickups_today: int
    due: Money
    next_payout_on: date | None = None     # §12-ط: من دوريته وآخر صرف له
    first_eta: datetime | None = None      # §12-ط: أقرب موعد وصول سائق لنقطة معلّقة


class CategoryOut(Out):
    id: int
    name_ar: str
    children: list["CategoryOut"] = []


class ProductOut(Out):
    id: int
    name_ar: str
    category_id: int
    category_name: str
    status: str
    mine: bool


class ProposalIn(BaseModel):
    name_ar: str = Field(min_length=1, max_length=120)
    category_id: int


class ProposalOut(Out):
    product: ProductOut
    similar: list[str]


class OfferOut(Out):
    id: int
    product_id: int
    product_name: str
    product_status: str
    unit: str
    unit_size: Qty
    purchase_price: Money
    previous_price: Money | None
    reported_qty: Qty
    reserved_qty: Qty
    available_qty: Decimal
    min_order_qty: Qty | None
    pickup_location_id: int
    location_label: str
    status: str
    qty_reported_at: datetime
    updated_at: datetime
    image_media_id: int | None


class OfferIn(BaseModel):
    product_id: int
    unit: str = Field(pattern="^(kg|liter|piece|carton|pack|bag|box|bottle|can|tray|roll|bundle)$")
    unit_size: Decimal = Field(gt=0, decimal_places=3)
    purchase_price: Decimal = Field(gt=0, decimal_places=3)
    reported_qty: Decimal = Field(ge=0, decimal_places=3)
    min_order_qty: Decimal | None = Field(default=None, gt=0, decimal_places=3)
    pickup_location_id: int
    active: bool = True


class OfferPatchIn(BaseModel):
    purchase_price: Decimal | None = Field(default=None, gt=0, decimal_places=3)
    reported_qty: Decimal | None = Field(default=None, ge=0, decimal_places=3)
    min_order_qty: Decimal | None = Field(default=None, gt=0, decimal_places=3)
    clear_min_order: bool = False
    active: bool | None = None


class OfferMediaIn(BaseModel):
    media_ids: list[int] = Field(max_length=6)


class Pickup2Out(Out):
    id: int
    seq: int
    status: str
    supplier_code: str
    location_label: str
    assigned_at: datetime | None
    handed_over: bool
    handover_method: str | None
    handed_over_at: datetime | None
    lines: list[PickupLineOut]
    eta_at: datetime | None = None         # §12-ط: موعد وصول السائق (يكتبه قبل مفتاح الخرائط)
    arrived_at: datetime | None = None     # «السائق عندك»
    eta_source: str | None = None          # §12-ي ن-5: mapbox (محسوب) أو manual (يكتبه السائق)


class ReceivedOut(Out):
    id: int
    received_at: datetime | None
    product_name: str
    unit: str
    unit_size: Qty
    collected_qty: Qty
    unit_price: Money | None
    amount: Money | None


class PayoutOut(Out):
    id: int
    amount: Money
    period_start: date
    period_end: date
    paid_at: datetime
    receipt_ready: bool


class DuesOut(Out):
    due: Money
    payout_cycle: str | None
    next_payout_on: date | None = None
    received: list[ReceivedOut]
    payouts: list[PayoutOut]


class NotificationOut(Out):
    id: int
    kind: str
    title: str
    body: str
    created_at: datetime
    read: bool


class ReadIn(BaseModel):
    ids: list[int] = []
    all: bool = False


class DeviceIn(BaseModel):
    fcm_token: str = Field(min_length=10, max_length=4096)
    platform: str = Field(pattern="^(android|web)$")
