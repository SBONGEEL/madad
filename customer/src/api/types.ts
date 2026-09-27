/**
 * مولَّد من OpenAPI الخلفية (ui/scripts/gen-types.mjs customer) — لا يُحرَّر يدوياً.
 * المال والكميات نصوص عشرية بثلاث خانات كما يرسلها الخادم؛ الحقل الاختياري «?» قد لا يصل
 * (تكلفةٌ محجوبة عمّن لا يملك «التكاليف»، أو قيمة بإعداد).
 */

export interface BatchOut {
  seq: number;
  status: string;
  eta_at: string | null;
  next_eta_at: string | null;
  now: Record<string, unknown>[];
  later: Record<string, unknown>[];
}

export interface Body_upload_api_customer_media_post {
  purpose: string;
  file: string;
}

export interface BranchIn {
  name: string;
  lat: number | string;
  lng: number | string;
  zone_id?: number | null;
  address_text: string;
  default_recipient?: string | null;
}

export interface BranchOut {
  id: number;
  name: string;
  address_text: string;
  lat: string;
  lng: string;
  zone_id: number | null;
  zone_name: string | null;
  status: string;
  active: boolean;
  default_recipient?: string | null;
}

export interface BranchReportOut {
  id: number;
  name: string;
  status: string;
  amount: string;
  orders: number;
}

export interface CancelIn {
  reason?: string | null;
}

export interface CartLineOut {
  catalog_item_id: number;
  name_ar: string;
  unit: string;
  unit_size: string;
  qty: string;
  unit_price: string | null;
  line_total: string | null;
  orderable: boolean;
  category_id: number;
  available_qty?: string | null;
}

export interface CartOut {
  order_id: number | null;
  branch: BranchOut | null;
  lines: CartLineOut[];
  subtotal: string;
  delivery_fee: string | null;
  fee_error: string | null;
  min_order_amount: string | null;
  min_order_lines: number | null;
  below_min_by: string;
  credit: string;
  ready_for_owner_at: string | null;
  prepared_by: string | null;
}

export interface CartQtyIn {
  qty: number | string;
  branch_id?: number | null;
}

export interface Catalog2Out {
  id: number;
  category_id: number;
  name_ar: string;
  name_en: string | null;
  unit: string;
  unit_size: string;
  sale_price: string | null;
  orderable: boolean;
  out_of_stock: boolean;
  image_media_id: number | null;
  cart_qty: string | null;
  alert?: boolean;
  available_qty?: string | null;
}

export interface CategoryOut {
  id: number;
  name_ar: string;
  name_en: string;
  icon_key: string | null;
  children?: CategoryOut[];
}

export interface ChangePasswordIn {
  current_password: string;
  new_password: string;
}

export interface CompleteIn {
  ticket: string;
  password: string;
  full_name: string;
}

export interface ContextOut {
  kind: string;
  city_name: string;
  ordering_mode: string;
  oversell_policy: string | null;
  min_order_amount: string | null;
  min_order_lines: number | null;
  credit: string;
  contact_phone: string | null;
  contact_whatsapp: string | null;
}

export interface CustomerOut {
  id: number;
  name: string;
  status: string;
}

export interface DeviceIn {
  fcm_token: string;
  platform: string;
}

export interface DisputeIn {
  order_item_id?: number | null;
  kind: string;
  description: string;
  media_ids?: number[];
}

export interface DisputeOut {
  id: number;
  order_item_id: number | null;
  item: string | null;
  kind: string;
  description: string;
  status: string;
  resolution: string | null;
  resolution_amount: string | null;
  refund_method: string | null;
  resolution_note: string | null;
  created_at: string;
}

export interface DriverCardOut {
  assigned: boolean;
  first_name?: string | null;
  phone?: string | null;
}

export interface EventOut {
  status: string;
  at: string;
}

export interface ItemDetailOut {
  item: Catalog2Out;
  category_name: string;
}

export interface ListDetailOut {
  list: ListOut;
  lines: ListLineOut[];
}

export interface ListIn {
  name: string;
  branch_id?: number | null;
  from_order_id?: number | null;
  items?: ListItemIn[];
}

export interface ListItemIn {
  catalog_item_id: number;
  qty: number | string;
}

export interface ListLineOut {
  catalog_item_id: number;
  name_ar: string;
  unit: string;
  unit_size: string;
  qty: string;
  sale_price: string | null;
  orderable: boolean;
  category_id: number;
  alert?: boolean;
}

export interface ListOut {
  id: number;
  name: string;
  branch_id: number;
  branch_name: string;
  item_count: number;
  has_unavailable: boolean;
  reminder_days: number[] | null;
  reminder_time: string | null;
  due_today: boolean;
}

export interface ListPatchIn {
  name?: string | null;
  items?: ListItemIn[] | null;
  reminder_days?: number[] | null;
  reminder_time?: string | null;
  reminder_off?: boolean;
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

export interface Me2Out {
  full_name: string;
  customer: CustomerOut | null;
  member: MemberOut | null;
  context: ContextOut | null;
  unread: number;
}

export interface MediaOut {
  id: number;
}

export interface MemberIn {
  phone: string;
  full_name: string;
  role: string;
  branch_id?: number | null;
}

export interface MemberOut {
  role: string;
  branch_id: number | null;
}

export interface MemberRowOut {
  user_id: number;
  full_name: string;
  phone: string;
  role: string;
  branch_id: number | null;
  branch_name: string | null;
  branch_status: string | null;
  activated: boolean;
}

export interface NotificationOut {
  id: number;
  kind: string;
  title: string;
  body: string;
  order_id: number | null;
  created_at: string;
  read: boolean;
}

export interface Order2Out {
  id: number;
  status: string;
  placed_at: string | null;
  delivered_at: string | null;
  branch_id: number;
  branch_name: string;
  dest_address: string | null;
  notes: string | null;
  subtotal: string;
  delivery_fee: string;
  total: string;
  amount_due: string | null;
  lines: OrderLineOut[];
  driver: DriverCardOut | null;
  events: EventOut[];
  batches: BatchOut[];
  editable: boolean;
  recipient_name?: string | null;
  cancellable?: boolean;
}

export interface Order2SummaryOut {
  id: number;
  status: string;
  total: string;
  placed_at: string | null;
  delivered_at: string | null;
  line_count: number;
  branch_id: number;
  branch_name: string;
}

export interface OrderLineOut {
  id: number;
  catalog_item_id?: number | null;
  name_ar: string;
  unit: string;
  unit_size: string;
  qty: string;
  unit_price: string | null;
  line_total: string | null;
  delivered_qty: string;
}

export interface PlaceIn {
  branch_id?: number | null;
  notes?: string | null;
  recipient_name?: string | null;
}

export interface ReadIn {
  ids?: number[];
  all?: boolean;
}

export interface ReadyCartOut {
  order_id: number;
  branch_id: number;
  branch_name: string;
  prepared_by: string | null;
  ready_for_owner_at: string;
  lines: number;
  amount: string;
}

export interface RefreshIn {
  refresh_token: string;
}

export interface RegistrationIn {
  name: string;
  kind: string;
  contact_name: string;
  lat: number | string;
  lng: number | string;
  address_text: string;
  zone_id?: number | null;
  facade_media_id: number;
  cr_media_id?: number | null;
}

export interface ReorderOut {
  cart: CartOut;
  skipped: string[];
}

export interface ReportOut {
  month: string;
  amount: string;
  orders: number;
  branches: BranchReportOut[];
}

export interface ResetCompleteIn {
  ticket: string;
  password: string;
}

export interface StartIn {
  phone: string;
}

export interface StartOut {
  channel: string;
  expires_in: number;
}

export interface TicketOut {
  ticket: string;
}

export interface ToCartIn {
  skip_unavailable?: boolean;
}

export interface TokensOut {
  access_token: string;
  refresh_token: string;
  token_type?: string;
}

export interface VerifyIn {
  phone: string;
  code: string;
}

export interface ZoneOut {
  id: number;
  name_ar: string;
}
