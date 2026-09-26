"""مخططات لوحة المالك — الموضع الوحيد الذي تُكشف فيه التكاليف وأسماء الموردين."""
from __future__ import annotations

from datetime import date, datetime
from decimal import Decimal
from enum import Enum

from pydantic import BaseModel, Field

from app.core.money import Money, Qty
from app.schemas.common import Out


class MeOut(Out):
    full_name: str
    role: str
    permissions: list[str]


class Visibility(BaseModel):
    """م-2 وم-19: ما يراه كل طرف. يبدأ مغلقاً، والمالك يفتحه."""
    driver_sees_supplier_name: bool
    customer_sees_driver_name: bool
    customer_can_call_driver: bool


class CapitalKind(str, Enum):
    opening_cash = "opening_cash"
    injection = "injection"


class CapitalIn(BaseModel):
    kind: CapitalKind
    amount: Decimal = Field(gt=0, max_digits=15, decimal_places=3)
    occurred_on: date
    note: str = Field(min_length=1, max_length=500)


class CapitalEntryOut(Out):
    id: int
    kind: str
    amount: Money
    occurred_on: date
    note: str
    created_by_name: str
    created_at: datetime


class CapitalOut(Out):
    equity_balance: Money
    entries: list[CapitalEntryOut]


class CostLineOut(Out):
    stop_id: int
    name_ar: str
    supplier_name: str | None
    purchase_price: Money | None
    unit_cost: Money
    planned_qty: Qty
    line_cost: Money
