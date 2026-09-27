/**
 * مولَّد من OpenAPI الخلفية (ui/scripts/gen-types.mjs admin) — لا يُحرَّر يدوياً.
 * المال والكميات نصوص عشرية بثلاث خانات كما يرسلها الخادم؛ الحقل الاختياري «?» قد لا يصل
 * (تكلفةٌ محجوبة عمّن لا يملك «التكاليف»، أو قيمة بإعداد).
 */

export interface AccountOut {
  id: number;
  kind: string;
  party: string | null;
  balance: string;
}

export interface AdminInviteIn {
  phone: string;
  full_name: string;
  permissions?: string[];
}

export interface AdminUserOut {
  user_id: number;
  full_name: string;
  phone: string;
  role: string;
  active: boolean;
  permissions: string[];
}

export interface ApprovalIn {
  decision: string;
  payout_cycle?: string | null;
  pay_method?: string | null;
}

export interface AreaIn {
  name_ar: string;
  fee: number | string;
  polygon: number[][];
  active?: boolean;
}

export interface AreaOut {
  id: number;
  name_ar: string;
  fee: string;
  active: boolean;
  polygon: number[][];
}

export interface AreaOverlapIn {
  rule: string;
}

export interface AreaOverlapOut {
  rule: string;
  overlaps: OverlapOut[];
}

export interface AssignIn {
  driver_id: number;
  route_km: number | string;
}

export interface AuditOut {
  id: number;
  table_name: string;
  row_pk: string;
  op: string;
  actor: string;
  at: string;
  changes: Record<string, unknown>;
}

export interface BackupPolicyIn {
  plan: string;
  location: string;
}

export interface BackupPolicyOut {
  plan: string;
  location: string;
  at: string;
  by: string;
}

export interface BackupRunOut {
  id: number;
  started_at: string;
  finished_at: string | null;
  status: string;
  kind: string;
  location: string;
  file_name: string | null;
  byte_size: number | null;
  local_ok: boolean;
  offsite_ok: boolean;
  error: string | null;
  downloadable: boolean;
}

export interface BackupsOut {
  policy: BackupPolicyOut;
  alert: string | null;
  alert_since: string | null;
  offsite_configured: boolean;
  runs: BackupRunOut[];
}

export interface BranchOut {
  id: number;
  name: string;
  address_text: string;
  zone: string | null;
  status: string;
  active: boolean;
}

export interface BroadcastIn {
  audience: string;
  title: string;
  body: string;
}

export interface BroadcastOut {
  id: number;
  audience: string;
  title: string;
  body: string;
  recipients: number;
  created_at: string;
}

export interface CancelIn {
  reason: string;
}

export interface CapitalEntryOut {
  id: number;
  kind: string;
  amount: string;
  occurred_on: string;
  note: string;
  created_by_name: string;
  created_at: string;
}

export interface CapitalIn {
  kind: CapitalKind;
  amount: number | string;
  occurred_on: string;
  note: string;
}

export type CapitalKind = "opening_cash" | "injection";

export interface CapitalOut {
  equity_balance: string;
  entries: CapitalEntryOut[];
}

export interface CatalogNewIn {
  product_id: number;
  category_id: number;
  unit: string;
  unit_size: number | string;
  name_ar: string;
}

export interface CatalogPatchIn {
  visibility?: string | null;
  oos_policy?: string | null;
  weight_kg?: number | string | null;
  name_ar?: string | null;
}

export interface CatalogRowOut {
  id: number;
  product_id: number;
  name_ar: string;
  unit: string;
  unit_size: string;
  category: string;
  sale_price: string | null;
  visibility: string;
  is_available: boolean;
  below_cost: boolean;
  needs_review: boolean;
  sources: number;
  reprice_override: boolean | null;
  cost_basis_override: string | null;
  mode?: string | null;
  margin_value?: string | null;
  cost_ref?: string | null;
}

export interface CategoryIn {
  parent_id: number;
  name_ar: string;
  name_en: string;
}

export interface CategoryNodeOut {
  id: number;
  name_ar: string;
  name_en: string;
  icon_key: string | null;
  active: boolean;
  items: number;
  children?: CategoryNodeOut[];
}

export interface CategoryPatchIn {
  name_ar?: string | null;
  name_en?: string | null;
  active?: boolean | null;
}

export interface ChangePasswordIn {
  current_password: string;
  new_password: string;
}

export interface ChannelOut {
  channel: string;
  position: number;
  enabled: boolean;
  configured: boolean;
}

export interface ChannelsIn {
  order: string[];
  enabled: Record<string, boolean>;
}

export interface CogsIn {
  method: string;
}

export interface CompareOut {
  offer_id: number;
  supplier_name: string;
  unit: string;
  unit_size: string;
  available_qty: string;
  in_catalog: boolean;
  purchase_price?: string | null;
}

export interface CompleteIn {
  ticket: string;
  password: string;
  full_name: string;
}

export interface ContactIn {
  phone?: string | null;
  whatsapp?: string | null;
}

export interface ContactOut {
  phone: string | null;
  whatsapp: string | null;
}

export interface CostLineOut {
  stop_id: number;
  name_ar: string;
  supplier_name: string | null;
  purchase_price: string | null;
  unit_cost: string;
  planned_qty: string;
  line_cost: string;
}

export interface CustodyDecideIn {
  fate: string;
  target_warehouse_id?: number | null;
  target_order_id?: number | null;
}

export interface CustodyOut {
  id: number;
  order_id: number;
  dispute_id: number | null;
  driver_id: number;
  driver_name: string;
  item: string;
  qty: string;
  source: string;
  source_kind: string;
  status: string;
  fate: string | null;
  target: string | null;
  created_at: string;
  unit_cost?: string | null;
  value?: string | null;
}

export interface CustomerDetailOut {
  customer: CustomerRowOut;
  contact_name: string;
  phone: string;
  month_total: string;
  by_branch: Record<string, unknown>[];
  credit: string;
  branches: BranchOut[];
  members: MemberOut[];
}

export interface CustomerRowOut {
  id: number;
  name: string;
  kind: string;
  status: string;
  branches: number;
  orders: number;
  purchaser_mode: string;
}

export interface DashboardOut {
  customers: number;
  suppliers_approved: number;
  pending_approvals: number;
  orders_today: number;
  sales_today: string;
  sales_7d: Record<string, unknown>[];
  attention: Record<string, unknown>;
  latest: OrderRowOut[];
  profit_today?: string | null;
}

export interface DisputeDetailOut {
  dispute: DisputeRowOut;
  order_item_id: number | null;
  supplier_id: number | null;
  driver_id: number | null;
  item: string | null;
  item_total: string | null;
  source: string | null;
  resolution: string | null;
  resolution_amount: string | null;
  refund_method: string | null;
  loss_bearer: string | null;
}

export interface DisputeRowOut {
  id: number;
  order_id: number;
  customer_name: string;
  kind: string;
  status: string;
  opened_by_role: string;
  created_at: string;
  description: string;
}

export interface DocumentOut {
  purpose: string;
  media_id: number;
  mime_type: string;
  views: number;
}

export interface DriverChoiceOut {
  id: number;
  full_name: string;
  vehicle: string;
  capacity_kg: string | null;
  cash_held: string;
  active_orders: number;
  over_cap: boolean;
  accepting: boolean;
}

export interface DriverSettleOut {
  id: number;
  full_name: string;
  pay_method: string | null;
  cash_held: string;
  wallet_owed: string;
  cash_cap: string | null;
  over_cap: boolean;
  next_payout_on?: string | null;
}

export interface EntryOut {
  account: string;
  amount: string;
}

export interface ExpenseIn {
  category: string;
  amount: number | string;
  spent_on: string;
  note?: string | null;
}

export interface HandoverIn {
  amount: number | string;
  wallet_offset?: number | string;
  note?: string | null;
}

export interface InboxOut {
  id: number;
  kind: string;
  title: string;
  body: string;
  order_id: number | null;
  created_at: string;
  read: boolean;
}

export interface ItemPricingOut {
  item: CatalogRowOut;
  reprice_override: boolean | null;
  cost_basis_override: string | null;
  sources_detail: SourceOut[];
  history: PriceChangeOut[];
  mode?: string | null;
  margin_value?: string | null;
  manual_price?: string | null;
  cost_ref?: string | null;
  warehouse_cost_mode?: string | null;
  warehouse_manual_cost?: string | null;
  warehouse_cost?: string | null;
  warehouse_cost_missing?: boolean | null;
}

export interface LoginIn {
  phone: string;
  password: string;
}

export interface LoginOut {
  access_token: string;
  refresh_token: string;
  token_type?: string;
  must_change_password?: boolean;
}

export interface MemberOut {
  user_id: number;
  full_name: string;
  phone: string;
  role: string;
  branch: string | null;
}

export interface MeOut {
  full_name: string;
  role: string;
  permissions: string[];
}

export interface MovementIn {
  kind: string;
  item_id: number;
  qty: number | string;
  unit_cost?: number | string | null;
  supplier_id?: number | null;
  to_warehouse_id?: number | null;
  note?: string | null;
}

export interface OfferOut {
  id: number;
  product_id: number;
  product: string;
  unit: string;
  unit_size: string;
  available_qty: string;
  status: string;
  location: string;
  purchase_price?: string | null;
}

export interface OrderDetailOut {
  order: OrderRowOut;
  driver_id: number | null;
  dest_address: string | null;
  subtotal: string;
  delivery_fee: string;
  driver_pay: string | null;
  route_km: string | null;
  lines: OrderLineAdminOut[];
  route_km_source?: string | null;
  events: StatusEventOut[];
}

export interface OrderLineAdminOut {
  id: number;
  catalog_item_id: number;
  name_ar: string;
  unit: string;
  qty: string;
  unit_price: string | null;
  line_total: string | null;
  delivered_qty: string;
}

export interface OrderRowOut {
  id: number;
  status: string;
  customer_name: string;
  branch_name: string;
  total: string;
  lines: number;
  driver_name: string | null;
  placed_at: string | null;
  plan_complete: boolean;
}

export interface OverlapCheckIn {
  polygon: Array<Array<number | string>>;
  fee: number | string;
  area_id?: number | null;
}

export interface OverlapHitOut {
  area_id: number;
  name_ar: string;
  fee: string;
  branches: Record<string, unknown>[];
}

export interface OverlapOut {
  area_a: number;
  name_a: string;
  fee_a: string;
  area_b: number;
  name_b: string;
  fee_b: string;
  branches: Record<string, unknown>[];
}

export interface PartyPayoutOut {
  override: PayoutRuleOut | null;
  effective: PayoutRuleOut;
  payout_cycle: string | null;
  pay_method?: string | null;
  next_payout_on: string | null;
  history: PayoutRuleEventOut[];
}

export interface PayMethodIn {
  pay_method: string;
}

export interface PayOfferDecisionIn {
  decision: string;
}

export interface PayOfferOut {
  id: number;
  driver_id: number;
  driver_name: string;
  amount: string;
  status: string;
  created_at: string;
  formula_pay: string | null;
}

export interface PayoutIn {
  amount: number | string;
  note?: string | null;
}

export interface PayoutRuleEventOut {
  driver_cycle: string | null;
  mode: string | null;
  fixed_weekday: number | null;
  fixed_month_day: number | null;
  fixed_semimonth_days: number[] | null;
  at: string;
  by: string;
}

export interface PayoutRuleIn {
  driver_cycle?: string | null;
  mode?: string | null;
  fixed_weekday?: number | null;
  fixed_month_day?: number | null;
  fixed_semimonth_days?: number[] | null;
}

export interface PayoutRuleOut {
  driver_cycle: string | null;
  mode: string | null;
  fixed_weekday: number | null;
  fixed_month_day: number | null;
  fixed_semimonth_days: number[] | null;
}

export interface PayoutSettingsOut {
  general: PayoutRuleOut;
  history: PayoutRuleEventOut[];
}

export interface PendingOut {
  kind: string;
  id: number;
  name: string;
  phone: string | null;
  detail: string;
  created_at: string;
}

export interface PermissionsIn {
  permissions: string[];
}

export interface PlanLineIn {
  order_item_id: number;
  offer_id?: number | null;
  warehouse_id?: number | null;
  qty: number | string;
}

export interface PlanLineOut {
  id: number;
  order_item_id: number;
  offer_id: number | null;
  warehouse_id: number | null;
  item: string;
  planned_qty: string;
  collected_qty: string | null;
  unit_cost?: string | null;
}

export interface PlanOut {
  order_id: number;
  status: string;
  plan_complete: boolean;
  stops: PlanStopOut[];
}

export interface PlanStopOut {
  id: number;
  seq: number;
  source: string;
  label: string;
  status: string;
  lines: PlanLineOut[];
}

export interface PriceChangeOut {
  at: string;
  kind: string;
  label: string;
  sale_old?: string | null;
  sale_new?: string | null;
  purchase_old?: string | null;
  purchase_new?: string | null;
  by: string;
}

export interface PricingIn {
  mode: string;
  margin_value?: number | string | null;
  manual_price?: number | string | null;
  reprice_override?: boolean | null;
  cost_basis_override?: string | null;
}

export interface ProductOut {
  id: number;
  name_ar: string;
  category: string;
  status: string;
  offers: number;
  in_catalog: boolean;
}

export interface ProfitLineOut {
  key: string;
  qty: string | null;
  sales: string;
  cost: string;
  gross: string;
}

export interface ProfitOut {
  date_from: string;
  date_to: string;
  sales: string;
  cost: string;
  driver_pay: string;
  expenses: string;
  profit: string;
  cogs_periods: Record<string, unknown>[];
  by: string;
  lines: ProfitLineOut[];
}

export interface ProposalDecisionIn {
  decision: string;
  category_id?: number | null;
}

export interface ProposalOut {
  id: number;
  name_ar: string;
  category: string;
  supplier_name: string;
  similar: string[];
  created_at: string;
}

export interface PurchaserModeIn {
  purchaser_mode: string;
}

export interface PushTextIn {
  mode: string;
}

export interface PushTextOut {
  mode: string;
}

export interface QtyIn {
  qty: number | string;
}

export interface RefreshIn {
  refresh_token: string;
}

export interface ResetCompleteIn {
  ticket: string;
  password: string;
}

export interface ResolveIn {
  resolution: string;
  resolution_amount?: number | string | null;
  refund_method?: string | null;
  refund_driver_id?: number | null;
  loss_bearer?: string | null;
  loss_supplier_id?: number | null;
  loss_driver_id?: number | null;
  note?: string | null;
}

export interface RouteComputeOut {
  routing: RoutingOut;
  detail: OrderDetailOut;
}

export interface RouteKmIn {
  route_km: number | string;
}

export interface RoutingOut {
  status: string;
  reason?: string | null;
  route_km?: string | null;
}

export interface SettingsIn {
  min_order_amount?: number | string | null;
  min_order_lines?: number | null;
  min_order_decided?: boolean | null;
  fee_mode?: string | null;
  delivery_fee_flat?: number | string | null;
  free_delivery_threshold?: number | string | null;
  oos_policy?: string | null;
  warehouse_first?: boolean | null;
  auto_confirm_max_amount?: number | string | null;
  driver_pay_base?: number | string | null;
  driver_pay_per_stop?: number | string | null;
  driver_pay_per_km?: number | string | null;
  driver_cash_cap?: number | string | null;
  collection_mode?: string | null;
  reprice_on_cost_change?: boolean | null;
  cancel_policy?: string | null;
  oversell_policy?: string | null;
  pickup_proof_required?: boolean | null;
  fee_conflict_rule?: string | null;
  cost_guard_basis?: string | null;
}

export interface SettingsOut {
  min_order_amount: string | null;
  min_order_lines: number | null;
  min_order_decided: boolean;
  fee_mode: string | null;
  delivery_fee_flat: string | null;
  free_delivery_threshold: string | null;
  oos_policy: string | null;
  warehouse_first: boolean;
  auto_confirm_max_amount: string | null;
  driver_pay_base: string | null;
  driver_pay_per_stop: string | null;
  driver_pay_per_km: string | null;
  driver_cash_cap: string | null;
  collection_mode: string;
  reprice_on_cost_change: boolean;
  cancel_policy: string;
  oversell_policy: string;
  pickup_proof_required: boolean;
  fee_conflict_rule: string;
  cost_guard_basis: string;
  cogs_method: string;
  cogs_periods: Record<string, unknown>[];
}

export interface SourceIn {
  offer_id: number;
  priority: number;
}

export interface SourceOut {
  offer_id: number;
  priority: number;
  supplier_name: string;
  status: string;
  available_qty: string;
  purchase_price?: string | null;
}

export interface StartIn {
  phone: string;
}

export interface StartOut {
  channel: string;
  expires_in: number;
}

export interface StatusEventOut {
  to_status: string;
  actor_role: string;
  at: string;
  reason: string | null;
}

export interface StockOut {
  warehouse_id: number;
  warehouse: string;
  item_id: number;
  item: string;
  on_hand: string;
  reserved: string;
  available: string;
  avg_cost?: string | null;
  value?: string | null;
}

export interface SupplierDetailOut {
  supplier: SupplierRowOut;
  offers: OfferOut[];
}

export interface SupplierDueOut {
  id: number;
  name: string;
  payout_cycle: string | null;
  payable: string;
  last_payout: string | null;
  next_payout_on?: string | null;
}

export interface SupplierPayoutIn {
  amount: number | string;
  period_start: string;
  period_end: string;
}

export interface SupplierRowOut {
  id: number;
  name: string;
  contact_name: string;
  phone: string;
  status: string;
  payout_cycle: string | null;
  offers: number;
}

export interface TempPasswordOut {
  temporary_password: string;
}

export interface TicketOut {
  ticket: string;
}

export interface TokensOut {
  access_token: string;
  refresh_token: string;
  token_type?: string;
}

export interface TxnOut {
  id: number;
  kind: string;
  memo: string;
  order_id: number | null;
  branch: string | null;
  occurred_at: string;
  actor: string;
  entries: EntryOut[];
}

export interface VerifyIn {
  phone: string;
  code: string;
}

export interface Visibility {
  driver_sees_supplier_name: boolean;
  customer_sees_driver_name: boolean;
  customer_can_call_driver: boolean;
}

export interface WarehouseCostIn {
  mode: string;
  manual_cost?: number | string | null;
}

export interface WarehouseIn {
  name: string;
  lat: number | string;
  lng: number | string;
  address_text: string;
}

export interface WarehouseOut {
  id: number;
  name: string;
  address_text: string;
  active: boolean;
  items: number;
}

export interface WithdrawalIn {
  amount: number | string;
  occurred_on: string;
  note: string;
}

export interface WithdrawalOut {
  id: number;
  amount: string;
  occurred_on: string;
  note: string;
  created_by_name: string;
  created_at: string;
  exceeds_profit: boolean;
  profit_at_time: string | null;
}

export interface WithdrawalPreviewOut {
  amount: string;
  treasury: string;
  profit_available: string;
  blocked: boolean;
  exceeds: boolean;
  over_by: string;
}

export interface WithdrawalsOut {
  treasury: string;
  drawings_total: string;
  entries: WithdrawalOut[];
}

export interface ZoneIn {
  name_ar: string;
  fee: number | string;
  active?: boolean;
}

export interface ZoneOut {
  id: number;
  name_ar: string;
  fee: string;
  active: boolean;
  branches: number;
}
