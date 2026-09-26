"""مخططات خرج العميل. لا حقل تكلفة ولا هامش ولا مورد — ولا يُضاف دون أن يُسقطه الحارس."""
from __future__ import annotations

from datetime import datetime

from pydantic import model_serializer

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
