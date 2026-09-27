"""مخططات لوحة المالك — الموضع الوحيد الذي تُكشف فيه التكاليف وأسماء الموردين."""
from __future__ import annotations

from datetime import date, datetime
from decimal import Decimal
from enum import Enum
from typing import ClassVar

from pydantic import BaseModel, Field, PrivateAttr, model_serializer

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


class TempPasswordOut(Out):
    temporary_password: str


# ——— التكاليف: تُحجب عمّن لا يملك «التكاليف» (المالك أو costs_view) ————————————————
class CostAware(Out):
    """حقول COST_FIELDS تسقط من الاستجابة (لا null) إن حُجبت؛ والحجب يسري على الأبناء."""
    COST_FIELDS: ClassVar[tuple[str, ...]] = ()
    _hide: bool = PrivateAttr(default=False)

    @model_serializer(mode="wrap")
    def _drop_costs(self, handler):
        data = handler(self)
        if self._hide:
            for k in self.COST_FIELDS:
                data.pop(k, None)
        return data

    def hide_costs(self, hide: bool = True):
        self._hide = hide
        for name in type(self).model_fields:
            v = getattr(self, name)
            for child in (v if isinstance(v, list) else [v]):
                if isinstance(child, CostAware):
                    child.hide_costs(hide)
        return self


class SourceOut(CostAware):
    COST_FIELDS = ("purchase_price",)
    offer_id: int
    priority: int
    supplier_name: str
    status: str
    available_qty: Qty
    purchase_price: Money | None = None


class CatalogRowOut(CostAware):
    COST_FIELDS = ("margin_value", "cost_ref", "mode")
    id: int
    product_id: int
    name_ar: str
    unit: str
    unit_size: Qty
    category: str
    sale_price: Money | None
    visibility: str
    is_available: bool
    below_cost: bool
    needs_review: bool
    sources: int
    reprice_override: bool | None
    cost_basis_override: str | None
    mode: str | None = None
    margin_value: Decimal | None = None
    cost_ref: Money | None = None


class PriceChangeOut(CostAware):
    COST_FIELDS = ("purchase_old", "purchase_new")
    at: datetime
    kind: str
    label: str
    sale_old: Money | None = None
    sale_new: Money | None = None
    purchase_old: Money | None = None
    purchase_new: Money | None = None
    by: str


class ItemPricingOut(CostAware):
    COST_FIELDS = ("mode", "margin_value", "manual_price", "cost_ref", "warehouse_cost_mode", "warehouse_manual_cost",
                   "warehouse_cost", "warehouse_cost_missing")
    item: CatalogRowOut
    reprice_override: bool | None
    cost_basis_override: str | None
    sources_detail: list[SourceOut]
    history: list[PriceChangeOut]
    mode: str | None = None
    margin_value: Decimal | None = None
    manual_price: Money | None = None
    cost_ref: Money | None = None
    # م-28: تكلفة الصنف في مخزن مَدَد — تلقائي (بطريقة م-12) أو يدوي؛ اليدوي بلا تكلفة لا يُعرض للبيع
    warehouse_cost_mode: str | None = None
    warehouse_manual_cost: Money | None = None
    warehouse_cost: Money | None = None
    warehouse_cost_missing: bool | None = None


class PricingIn(BaseModel):
    mode: str = Field(pattern="^(manual|margin_pct|margin_amount)$")
    margin_value: Decimal | None = Field(default=None, ge=0, decimal_places=2)
    manual_price: Decimal | None = Field(default=None, gt=0, decimal_places=3)
    reprice_override: bool | None = None
    cost_basis_override: str | None = Field(default=None, pattern="^(max_source|first_priority)$")   # م-6: null = المشروع


class CatalogPatchIn(BaseModel):
    visibility: str | None = Field(default=None, pattern="^(visible|hidden)$")
    oos_policy: str | None = Field(default=None, pattern="^(auto_hide|mark_out|project)$")
    weight_kg: Decimal | None = Field(default=None, gt=0, decimal_places=3)
    name_ar: str | None = Field(default=None, min_length=1, max_length=120)


class CatalogNewIn(BaseModel):
    product_id: int
    category_id: int
    unit: str
    unit_size: Decimal = Field(gt=0)
    name_ar: str = Field(min_length=1, max_length=120)


class SourceIn(BaseModel):
    offer_id: int
    priority: int = Field(ge=1)


class SupplierRowOut(Out):
    id: int
    name: str
    contact_name: str
    phone: str
    status: str
    payout_cycle: str | None
    offers: int


class OfferOut(CostAware):
    COST_FIELDS = ("purchase_price",)
    id: int
    product_id: int
    product: str
    unit: str
    unit_size: Qty
    available_qty: Qty
    status: str
    location: str
    purchase_price: Money | None = None


class SupplierDetailOut(Out):
    supplier: SupplierRowOut
    offers: list[OfferOut]


class CompareOut(CostAware):
    COST_FIELDS = ("purchase_price",)
    offer_id: int
    supplier_name: str
    unit: str
    unit_size: Qty
    available_qty: Qty
    in_catalog: bool
    purchase_price: Money | None = None


class CategoryNodeOut(Out):
    id: int
    name_ar: str
    name_en: str
    icon_key: str | None
    active: bool
    items: int
    children: list["CategoryNodeOut"] = []


class CategoryIn(BaseModel):
    parent_id: int
    name_ar: str = Field(min_length=1, max_length=80)
    name_en: str = Field(min_length=1, max_length=80)


class CategoryPatchIn(BaseModel):
    name_ar: str | None = Field(default=None, min_length=1, max_length=80)
    name_en: str | None = Field(default=None, min_length=1, max_length=80)
    active: bool | None = None


class ProductOut(Out):
    """صنف في القاموس (§4) للبحث عند إنشاء صنف كتالوج أو مقارنة عروضه."""
    id: int
    name_ar: str
    category: str
    status: str
    offers: int
    in_catalog: bool


class ProposalOut(Out):
    id: int
    name_ar: str
    category: str
    supplier_name: str
    similar: list[str]
    created_at: datetime


class ProposalDecisionIn(BaseModel):
    decision: str = Field(pattern="^(approve|reject)$")
    category_id: int | None = None


# ——— الطلبيات والمخطط والإسناد والنزاعات ————————————————————————————————————————————
class OrderRowOut(Out):
    id: int
    status: str
    customer_name: str
    branch_name: str
    total: Money
    lines: int
    driver_name: str | None
    placed_at: datetime | None
    plan_complete: bool


class OrderLineAdminOut(Out):
    id: int
    catalog_item_id: int
    name_ar: str
    unit: str
    qty: Qty
    unit_price: Money | None
    line_total: Money | None
    delivered_qty: Qty


class StatusEventOut(Out):
    to_status: str
    actor_role: str
    at: datetime
    reason: str | None


class OrderDetailOut(Out):
    order: OrderRowOut
    driver_id: int | None
    dest_address: str | None
    subtotal: Money
    delivery_fee: Money
    driver_pay: Money | None
    route_km: Decimal | None
    lines: list[OrderLineAdminOut]
    events: list[StatusEventOut]


class CancelIn(BaseModel):
    reason: str = Field(min_length=1, max_length=300)


class QtyIn(BaseModel):
    qty: Decimal = Field(gt=0, decimal_places=3)


class PlanLineOut(CostAware):
    COST_FIELDS = ("unit_cost",)
    id: int
    order_item_id: int
    offer_id: int | None
    warehouse_id: int | None
    item: str
    planned_qty: Qty
    collected_qty: Qty | None
    unit_cost: Money | None = None


class PlanStopOut(Out):
    id: int
    seq: int
    source: str
    label: str
    status: str
    lines: list[PlanLineOut]


class PlanOut(Out):
    order_id: int
    status: str
    plan_complete: bool
    stops: list[PlanStopOut]


class PlanLineIn(BaseModel):
    order_item_id: int
    offer_id: int | None = None
    warehouse_id: int | None = None
    qty: Decimal = Field(gt=0, decimal_places=3)


class DriverChoiceOut(Out):
    id: int
    full_name: str
    vehicle: str
    capacity_kg: Decimal | None
    cash_held: Money
    active_orders: int
    over_cap: bool
    accepting: bool          # §12-ط: «أستقبل طلبيات الآن» — غير المتاح يُسند يدوياً مع تنبيه


class AssignIn(BaseModel):
    driver_id: int
    route_km: Decimal = Field(ge=0, decimal_places=2)


class RouteKmIn(BaseModel):
    route_km: Decimal = Field(ge=0, decimal_places=2)


class DisputeRowOut(Out):
    id: int
    order_id: int
    customer_name: str
    kind: str
    status: str
    opened_by_role: str
    created_at: datetime
    description: str


class DisputeDetailOut(Out):
    dispute: DisputeRowOut
    order_item_id: int | None
    supplier_id: int | None
    driver_id: int | None
    item: str | None
    item_total: Money | None
    source: str | None
    resolution: str | None
    resolution_amount: Money | None
    refund_method: str | None
    loss_bearer: str | None


class ResolveIn(BaseModel):
    resolution: str = Field(pattern="^(partial_discount|return|cancel|no_action)$")
    resolution_amount: Decimal | None = Field(default=None, ge=0, decimal_places=3)
    refund_method: str | None = Field(default=None, pattern="^(credit_next_order|cash_via_driver)$")
    refund_driver_id: int | None = None
    loss_bearer: str | None = Field(default=None, pattern="^(supplier|madad|driver)$")
    loss_supplier_id: int | None = None
    loss_driver_id: int | None = None
    note: str | None = Field(default=None, max_length=500)


# ——— المال: الدفتر والتسويات والصرف والربح والسحوبات ————————————————————————————
class AccountOut(Out):
    id: int
    kind: str
    party: str | None
    balance: Money


class EntryOut(Out):
    account: str
    amount: Money


class TxnOut(Out):
    id: int
    kind: str
    memo: str
    order_id: int | None
    branch: str | None
    occurred_at: datetime
    actor: str
    entries: list[EntryOut]


class DriverSettleOut(Out):
    id: int
    full_name: str
    pay_method: str | None
    cash_held: Money
    wallet_owed: Money
    cash_cap: Money | None
    over_cap: bool


class HandoverIn(BaseModel):
    amount: Decimal = Field(gt=0, decimal_places=3)
    wallet_offset: Decimal = Field(default=Decimal(0), ge=0, decimal_places=3)
    note: str | None = Field(default=None, max_length=300)


class PayoutIn(BaseModel):
    amount: Decimal = Field(gt=0, decimal_places=3)
    note: str | None = Field(default=None, max_length=300)


class PayMethodIn(BaseModel):
    pay_method: str = Field(pattern="^(offset_on_settlement|periodic)$")


class SupplierDueOut(Out):
    id: int
    name: str
    payout_cycle: str | None
    payable: Money
    last_payout: datetime | None


class SupplierPayoutIn(BaseModel):
    amount: Decimal = Field(gt=0, decimal_places=3)
    period_start: date
    period_end: date


class ProfitLineOut(Out):
    key: str
    qty: Qty | None
    sales: Money
    cost: Money
    gross: Money


class ProfitOut(Out):
    date_from: date
    date_to: date
    sales: Money
    cost: Money
    driver_pay: Money
    expenses: Money
    profit: Money
    cogs_periods: list[dict]
    by: str
    lines: list[ProfitLineOut]


class WithdrawalOut(Out):
    id: int
    amount: Money
    occurred_on: date
    note: str
    created_by_name: str
    created_at: datetime
    exceeds_profit: bool                 # م-26: تجاوز الربح المتاح لحظة السحب
    profit_at_time: Money | None


class WithdrawalPreviewOut(Out):
    """م-26: ما يُعرض قبل التأكيد. blocked = يتجاوز نقد الخزينة (يُمنع)؛ exceeds = يتجاوز الربح (تنبيه)."""
    amount: Money
    treasury: Money
    profit_available: Money
    blocked: bool
    exceeds: bool
    over_by: Money


class WithdrawalsOut(Out):
    treasury: Money
    drawings_total: Money
    entries: list[WithdrawalOut]


class WithdrawalIn(BaseModel):
    amount: Decimal = Field(gt=0, decimal_places=3)
    occurred_on: date
    note: str = Field(min_length=1, max_length=300)


class ExpenseIn(BaseModel):
    category: str = Field(min_length=1, max_length=80)
    amount: Decimal = Field(gt=0, decimal_places=3)
    spent_on: date
    note: str | None = Field(default=None, max_length=300)


# ——— المخازن ——————————————————————————————————————————————————————————————
class StockOut(CostAware):
    COST_FIELDS = ("avg_cost", "value")
    warehouse_id: int
    warehouse: str
    item_id: int
    item: str
    on_hand: Qty
    reserved: Qty
    available: Qty
    avg_cost: Money | None = None
    value: Money | None = None


class WarehouseOut(Out):
    id: int
    name: str
    address_text: str
    active: bool
    items: int


class WarehouseIn(BaseModel):
    name: str = Field(min_length=1, max_length=80)
    lat: Decimal
    lng: Decimal
    address_text: str = Field(min_length=1, max_length=200)


class MovementIn(BaseModel):
    kind: str = Field(pattern="^(intake|count_adjust|transfer)$")
    item_id: int
    qty: Decimal = Field(decimal_places=3)
    unit_cost: Decimal | None = Field(default=None, gt=0, decimal_places=3)
    supplier_id: int | None = None
    to_warehouse_id: int | None = None
    note: str | None = Field(default=None, max_length=300)


# ——— الرئيسية والاعتمادات والعملاء والمستخدمون والإشعارات والتدقيق ————————————————————————
class DashboardOut(CostAware):
    COST_FIELDS = ("profit_today",)
    customers: int
    suppliers_approved: int
    pending_approvals: int
    orders_today: int
    sales_today: Money
    sales_7d: list[dict]
    attention: dict
    latest: list[OrderRowOut]
    profit_today: Money | None = None


class PendingOut(Out):
    kind: str
    id: int
    name: str
    phone: str | None
    detail: str
    created_at: datetime


class ApprovalIn(BaseModel):
    decision: str = Field(pattern="^(approve|reject)$")
    payout_cycle: str | None = Field(default=None, pattern="^(daily|weekly|semimonthly|monthly)$")
    pay_method: str | None = Field(default=None, pattern="^(offset_on_settlement|periodic)$")


class CustomerRowOut(Out):
    id: int
    name: str
    kind: str
    status: str
    branches: int
    orders: int
    purchaser_mode: str


class BranchOut(Out):
    id: int
    name: str
    address_text: str
    zone: str | None
    status: str
    active: bool


class MemberOut(Out):
    user_id: int
    full_name: str
    phone: str
    role: str
    branch: str | None


class CustomerDetailOut(Out):
    customer: CustomerRowOut
    contact_name: str
    phone: str
    month_total: Money
    by_branch: list[dict]
    credit: Money
    branches: list[BranchOut]
    members: list[MemberOut]


class PurchaserModeIn(BaseModel):
    purchaser_mode: str = Field(pattern="^(direct|owner_confirms)$")


class AdminUserOut(Out):
    user_id: int
    full_name: str
    phone: str
    role: str
    active: bool
    permissions: list[str]


class AdminInviteIn(BaseModel):
    phone: str = Field(pattern=r"^\+2189[0-9]{8}$")
    full_name: str = Field(min_length=1, max_length=120)
    permissions: list[str] = []


class PermissionsIn(BaseModel):
    permissions: list[str]


class BroadcastIn(BaseModel):
    audience: str = Field(pattern="^(customer|driver)$")
    title: str = Field(min_length=1, max_length=80)
    body: str = Field(min_length=1, max_length=500)


class BroadcastOut(Out):
    id: int
    audience: str
    title: str
    body: str
    recipients: int
    created_at: datetime


class AuditOut(Out):
    id: int
    table_name: str
    row_pk: str
    op: str
    actor: str
    at: datetime
    changes: dict


class InboxOut(Out):
    id: int
    kind: str
    title: str
    body: str
    order_id: int | None
    created_at: datetime
    read: bool


# ——— الإعدادات والمناطق ————————————————————————————————————————————————————————
class SettingsOut(Out):
    min_order_amount: Money | None
    min_order_lines: int | None
    min_order_decided: bool
    fee_mode: str | None
    delivery_fee_flat: Money | None
    free_delivery_threshold: Money | None
    oos_policy: str | None
    warehouse_first: bool
    auto_confirm_max_amount: Money | None
    driver_pay_base: Money | None
    driver_pay_per_stop: Money | None
    driver_pay_per_km: Money | None
    driver_cash_cap: Money | None
    collection_mode: str
    reprice_on_cost_change: bool
    cancel_policy: str
    oversell_policy: str
    pickup_proof_required: bool
    fee_conflict_rule: str
    cost_guard_basis: str
    cogs_method: str
    cogs_periods: list[dict]


class SettingsIn(BaseModel):
    """الحقول الغائبة لا تتغيّر. القيمة الفارغة (null) في المال = «لم يُقرَّر» (م-5)."""
    model_config = {"extra": "forbid"}
    min_order_amount: Decimal | None = None
    min_order_lines: int | None = None
    min_order_decided: bool | None = None
    fee_mode: str | None = Field(default=None, pattern="^(flat|by_zone)$")
    delivery_fee_flat: Decimal | None = None
    free_delivery_threshold: Decimal | None = None
    oos_policy: str | None = Field(default=None, pattern="^(auto_hide|mark_out)$")
    warehouse_first: bool | None = None
    auto_confirm_max_amount: Decimal | None = None
    driver_pay_base: Decimal | None = None
    driver_pay_per_stop: Decimal | None = None
    driver_pay_per_km: Decimal | None = None
    driver_cash_cap: Decimal | None = None
    collection_mode: str | None = Field(default=None, pattern="^(on_completion|per_batch)$")
    reprice_on_cost_change: bool | None = None
    cancel_policy: str | None = Field(default=None, pattern="^(until_collecting|anytime)$")
    oversell_policy: str | None = Field(default=None, pattern="^(forbid|allow)$")
    pickup_proof_required: bool | None = None
    fee_conflict_rule: str | None = Field(default=None, pattern="^(area_wins|zone_wins|higher|lower)$")   # م-25
    cost_guard_basis: str | None = Field(default=None, pattern="^(max_source|first_priority)$")        # م-6


class CogsIn(BaseModel):
    method: str = Field(pattern="^(average|fifo)$")


class ChannelOut(Out):
    channel: str
    position: int
    enabled: bool
    configured: bool


class ChannelsIn(BaseModel):
    order: list[str]                    # القنوات بالترتيب؛ sms أخيراً
    enabled: dict[str, bool]


class ZoneOut(Out):
    id: int
    name_ar: str
    fee: Money
    active: bool
    branches: int


class ZoneIn(BaseModel):
    name_ar: str = Field(min_length=1, max_length=80)
    fee: Decimal = Field(ge=0, decimal_places=3)
    active: bool = True


class AreaOut(Out):
    id: int
    name_ar: str
    fee: Money
    active: bool
    polygon: list[list[float]]


class AreaIn(BaseModel):
    name_ar: str = Field(min_length=1, max_length=80)
    fee: Decimal = Field(ge=0, decimal_places=3)
    polygon: list[list[float]] = Field(min_length=3)
    active: bool = True


# ——— الأمانة بعهدة السائقين ومصيرها (معتمد في §12-ز) ————————————————————————————————
class CustodyOut(CostAware):
    COST_FIELDS = ("unit_cost", "value")
    id: int
    order_id: int
    dispute_id: int | None
    driver_id: int
    driver_name: str
    item: str
    qty: Qty
    source: str
    source_kind: str
    status: str
    fate: str | None
    target: str | None
    created_at: datetime
    unit_cost: Money | None = None
    value: Money | None = None


class CustodyDecideIn(BaseModel):
    fate: str = Field(pattern="^(to_warehouse|return_supplier|to_order)$")
    target_warehouse_id: int | None = None
    target_order_id: int | None = None


# ——— عروض أجرة السائقين (§4.2) ——————————————————————————————————————————————————————
class PayOfferOut(Out):
    id: int
    driver_id: int
    driver_name: str
    amount: Money
    status: str
    created_at: datetime
    formula_pay: Money | None


class PayOfferDecisionIn(BaseModel):
    decision: str = Field(pattern="^(accept|reject)$")


# ——— وثائق الاعتماد (الوثيقة الخاصة تُفتح بسجل) ————————————————————————————————————————
class DocumentOut(Out):
    purpose: str
    media_id: int
    mime_type: str
    views: int


# ——— م-27: تداخل منطقتين مرسومتين برسمين مختلفين ————————————————————————————————————
class OverlapOut(Out):
    area_a: int
    name_a: str
    fee_a: Money
    area_b: int
    name_b: str
    fee_b: Money
    branches: list[dict]


class AreaOverlapOut(Out):
    rule: str
    overlaps: list[OverlapOut]


class AreaOverlapIn(BaseModel):
    rule: str = Field(pattern="^(stop|higher|lower)$")


class OverlapCheckIn(BaseModel):
    """فحص قبل الحفظ: هل ترسم هذه الحدود تداخلاً مع منطقة برسم آخر؟"""
    polygon: list[list[Decimal]] = Field(min_length=3)
    fee: Decimal = Field(ge=0, decimal_places=3)
    area_id: int | None = None


class OverlapHitOut(Out):
    area_id: int
    name_ar: str
    fee: Money
    branches: list[dict]


# ——— م-28 ———
class WarehouseCostIn(BaseModel):
    mode: str = Field(pattern="^(auto|manual)$")
    manual_cost: Decimal | None = Field(default=None, gt=0, decimal_places=3)


# ——— §12-ط: رقم التواصل مع مَدَد ———
class ContactOut(Out):
    phone: str | None
    whatsapp: str | None


class ContactIn(BaseModel):
    phone: str | None = Field(default=None, pattern=r"^\+2189[0-9]{8}$")
    whatsapp: str | None = Field(default=None, pattern=r"^\+2189[0-9]{8}$")
