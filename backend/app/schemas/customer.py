"""مخططات خرج العميل. لا حقل تكلفة ولا هامش ولا مورد — ولا يُضاف دون أن يُسقطه الحارس."""
from __future__ import annotations

from datetime import datetime
from decimal import Decimal

from pydantic import BaseModel, Field, model_serializer

from app.core.money import Money, Qty
from app.schemas.common import Out


class CustomerOut(Out):
    id: int
    name: str
    status: str


class MeOut(Out):
    full_name: str
    customer: CustomerOut | None


class CategoryOut(Out):
    id: int
    name_ar: str
    name_en: str
    icon_key: str | None
    children: list["CategoryOut"] = []


class CatalogItemOut(Out):
    id: int
    category_id: int
    name_ar: str
    name_en: str | None
    unit: str
    unit_size: Qty
    sale_price: Money | None
    orderable: bool
    out_of_stock: bool


class OrderSummaryOut(Out):
    id: int
    status: str
    total: Money
    placed_at: datetime | None


class OrderLineOut(Out):
    id: int
    catalog_item_id: int | None = None
    name_ar: str
    unit: str
    unit_size: Qty
    qty: Qty
    unit_price: Money | None
    line_total: Money | None
    delivered_qty: Qty


class DriverCardOut(Out):
    """م-19: الاسم الأول والهاتف إعدادان للمالك. المغلق غائب عن الاستجابة أصلاً — لا null."""
    assigned: bool
    first_name: str | None = None
    phone: str | None = None

    @model_serializer(mode="wrap")
    def _drop_closed(self, handler):
        data = handler(self)
        for key in ("first_name", "phone"):
            if data.get(key) is None:
                data.pop(key, None)
        return data


class OrderOut(Out):
    id: int
    status: str
    placed_at: datetime | None
    dest_address: str | None
    subtotal: Money
    delivery_fee: Money
    total: Money
    lines: list[OrderLineOut]
    driver: DriverCardOut | None


# ——— تطبيق العميل كاملاً (الجزء 11) ——————————————————————————————————————————————
class MemberOut(Out):
    """دور المستخدم في منشأته (م-8، م-9): الصاحب كل الفروع، والمسؤول فرعه."""
    role: str
    branch_id: int | None


class ContextOut(Out):
    """ما تحتاجه الواجهة لتعرض قواعد اليوم دون أن تخمّنها."""
    kind: str
    city_name: str
    ordering_mode: str   # م-8: direct | owner_confirms (اسم الحقل بلا «purchase» — حارس الحقول)
    oversell_policy: str | None
    min_order_amount: Money | None
    min_order_lines: int | None
    credit: Money


class Me2Out(Out):
    full_name: str
    customer: CustomerOut | None
    member: MemberOut | None
    context: ContextOut | None
    unread: int


class RegistrationIn(BaseModel):
    name: str = Field(min_length=1, max_length=120)
    kind: str = Field(pattern="^(restaurant|cafe|other)$")
    contact_name: str = Field(min_length=1, max_length=120)
    lat: Decimal = Field(ge=-90, le=90)
    lng: Decimal = Field(ge=-180, le=180)
    address_text: str = Field(min_length=1, max_length=300)
    zone_id: int | None = None
    facade_media_id: int
    cr_media_id: int | None = None


class MediaOut(Out):
    id: int


class Catalog2Out(Out):
    id: int
    category_id: int
    name_ar: str
    name_en: str | None
    unit: str
    unit_size: Qty
    sale_price: Money | None
    orderable: bool
    out_of_stock: bool
    image_media_id: int | None
    cart_qty: Qty | None
    available_qty: Qty | None = None   # م-15: يصل حين تمنع السياسة البيع فوق المتاح وحدها

    @model_serializer(mode="wrap")
    def _drop_absent(self, handler):
        data = handler(self)
        if data.get("available_qty") is None:
            data.pop("available_qty", None)
        return data


class ItemDetailOut(Out):
    item: Catalog2Out
    category_name: str


class ZoneOut(Out):
    id: int
    name_ar: str


class BranchOut(Out):
    id: int
    name: str
    address_text: str
    lat: Decimal
    lng: Decimal
    zone_id: int | None
    zone_name: str | None
    status: str
    active: bool


class BranchIn(BaseModel):
    name: str = Field(min_length=1, max_length=120)
    lat: Decimal = Field(ge=-90, le=90)
    lng: Decimal = Field(ge=-180, le=180)
    zone_id: int | None = None
    address_text: str = Field(min_length=1, max_length=300)


class MemberRowOut(Out):
    user_id: int
    full_name: str
    phone: str
    role: str
    branch_id: int | None
    branch_name: str | None
    branch_status: str | None
    activated: bool


class MemberIn(BaseModel):
    phone: str = Field(pattern=r"^\+2189[0-9]{8}$")
    full_name: str = Field(min_length=1, max_length=120)
    role: str = Field(pattern="^(owner|purchaser)$")
    branch_id: int | None = None


class CartLineOut(Out):
    catalog_item_id: int
    name_ar: str
    unit: str
    unit_size: Qty
    qty: Qty
    unit_price: Money | None
    line_total: Money | None
    orderable: bool
    category_id: int
    available_qty: Qty | None = None   # م-15: حين تمنع السياسة البيع فوق المتاح وحدها

    @model_serializer(mode="wrap")
    def _drop_absent(self, handler):
        data = handler(self)
        if data.get("available_qty") is None:
            data.pop("available_qty", None)
        return data


class CartOut(Out):
    order_id: int | None
    branch: BranchOut | None
    lines: list[CartLineOut]
    subtotal: Money
    delivery_fee: Money | None
    fee_error: str | None
    min_order_amount: Money | None
    min_order_lines: int | None
    below_min_by: Money
    credit: Money
    ready_for_owner_at: datetime | None
    prepared_by: str | None


class CartQtyIn(BaseModel):
    qty: Decimal = Field(ge=0, decimal_places=3)
    branch_id: int | None = None


class PlaceIn(BaseModel):
    branch_id: int | None = None
    notes: str | None = Field(default=None, max_length=500)


class ReadyCartOut(Out):
    order_id: int
    branch_id: int
    branch_name: str
    prepared_by: str | None
    ready_for_owner_at: datetime
    lines: int
    amount: Money


class Order2SummaryOut(Out):
    id: int
    status: str
    total: Money
    placed_at: datetime | None
    delivered_at: datetime | None
    line_count: int
    branch_id: int
    branch_name: str


class EventOut(Out):
    status: str
    at: datetime


class BatchOut(Out):
    seq: int
    status: str
    eta_at: datetime | None
    next_eta_at: datetime | None
    now: list[dict]
    later: list[dict]


class Order2Out(Out):
    id: int
    status: str
    placed_at: datetime | None
    delivered_at: datetime | None
    branch_id: int
    branch_name: str
    dest_address: str | None
    notes: str | None
    subtotal: Money
    delivery_fee: Money
    total: Money
    amount_due: Money | None
    lines: list[OrderLineOut]
    driver: DriverCardOut | None
    events: list[EventOut]
    batches: list[BatchOut]
    editable: bool


class ReorderOut(Out):
    cart: CartOut
    skipped: list[str]


class DisputeIn(BaseModel):
    order_item_id: int | None = None
    kind: str = Field(pattern="^(damaged|short|refused|other)$")
    description: str = Field(min_length=1, max_length=1000)
    media_ids: list[int] = []


class DisputeOut(Out):
    """م-10: ما يخصّ العميل من القرار — لا من يتحمّل الخسارة."""
    id: int
    order_item_id: int | None
    item: str | None
    kind: str
    description: str
    status: str
    resolution: str | None
    resolution_amount: Money | None
    refund_method: str | None
    resolution_note: str | None
    created_at: datetime


class ListOut(Out):
    id: int
    name: str
    branch_id: int
    branch_name: str
    item_count: int
    has_unavailable: bool
    reminder_days: list[int] | None
    reminder_time: str | None
    due_today: bool


class ListLineOut(Out):
    catalog_item_id: int
    name_ar: str
    unit: str
    unit_size: Qty
    qty: Qty
    sale_price: Money | None
    orderable: bool
    category_id: int


class ListDetailOut(Out):
    list: ListOut
    lines: list[ListLineOut]


class ListIn(BaseModel):
    name: str = Field(min_length=1, max_length=80)
    branch_id: int | None = None
    from_order_id: int | None = None
    items: list["ListItemIn"] = []


class ListItemIn(BaseModel):
    catalog_item_id: int
    qty: Decimal = Field(gt=0, decimal_places=3)


class ListPatchIn(BaseModel):
    name: str | None = Field(default=None, min_length=1, max_length=80)
    items: list[ListItemIn] | None = None
    # أيام التذكير 0..6 على عُرف Postgres: الأحد 0 … السبت 6
    reminder_days: list[int] | None = None
    reminder_time: str | None = Field(default=None, pattern=r"^([01][0-9]|2[0-3]):[0-5][0-9]$")
    reminder_off: bool = False


class ToCartIn(BaseModel):
    skip_unavailable: bool = False


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


class BranchReportOut(Out):
    id: int
    name: str
    status: str
    amount: Money
    orders: int


class ReportOut(Out):
    month: str
    amount: Money
    orders: int
    branches: list[BranchReportOut]
