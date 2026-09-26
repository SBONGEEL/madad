/**
 * مولَّد من OpenAPI الخلفية (ui/scripts/gen-types.mjs supplier) — لا يُحرَّر يدوياً.
 * المال والكميات نصوص عشرية بثلاث خانات كما يرسلها الخادم؛ الحقل الاختياري «?» قد لا يصل
 * (تكلفةٌ محجوبة عمّن لا يملك «التكاليف»، أو قيمة بإعداد).
 */

export interface Body_upload_api_supplier_media_post {
  purpose: string;
  file: string;
}

export interface CategoryOut {
  id: number;
  name_ar: string;
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

export interface DashboardOut {
  month_sales: string;
  active_offers: number;
  pickups_today: number;
  due: string;
}

export interface DeviceIn {
  fcm_token: string;
  platform: string;
}

export interface DuesOut {
  due: string;
  payout_cycle: string | null;
  received: ReceivedOut[];
  payouts: PayoutOut[];
}

export interface HandoverOut {
  handed_over: boolean;
  method: string;
}

export interface LocationIn {
  label: string;
  lat: number | string;
  lng: number | string;
  address_text: string;
}

export interface LocationOut {
  id: number;
  label: string;
  lat: string;
  lng: string;
  address_text: string;
  active: boolean;
  active_offers: number;
}

export interface LocationPatchIn {
  label?: string | null;
  lat?: number | string | null;
  lng?: number | string | null;
  address_text?: string | null;
  active?: boolean | null;
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
  supplier: SupplierOut | null;
  unread: number;
}

export interface MediaOut {
  id: number;
}

export interface NotificationOut {
  id: number;
  kind: string;
  title: string;
  body: string;
  created_at: string;
  read: boolean;
}

export interface OfferIn {
  product_id: number;
  unit: string;
  unit_size: number | string;
  purchase_price: number | string;
  reported_qty: number | string;
  min_order_qty?: number | string | null;
  pickup_location_id: number;
  active?: boolean;
}

export interface OfferMediaIn {
  media_ids: number[];
}

export interface OfferOut {
  id: number;
  product_id: number;
  product_name: string;
  product_status: string;
  unit: string;
  unit_size: string;
  purchase_price: string;
  previous_price: string | null;
  reported_qty: string;
  reserved_qty: string;
  available_qty: string;
  min_order_qty: string | null;
  pickup_location_id: number;
  location_label: string;
  status: string;
  qty_reported_at: string;
  updated_at: string;
  image_media_id: number | null;
}

export interface OfferPatchIn {
  purchase_price?: number | string | null;
  reported_qty?: number | string | null;
  min_order_qty?: number | string | null;
  clear_min_order?: boolean;
  active?: boolean | null;
}

export interface PayoutOut {
  id: number;
  amount: string;
  period_start: string;
  period_end: string;
  paid_at: string;
  receipt_ready: boolean;
}

export interface Pickup2Out {
  id: number;
  seq: number;
  status: string;
  supplier_code: string;
  location_label: string;
  assigned_at: string | null;
  handed_over: boolean;
  handover_method: string | null;
  handed_over_at: string | null;
  lines: PickupLineOut[];
}

export interface PickupLineOut {
  product_name: string;
  unit: string;
  unit_size: string;
  planned_qty: string;
  collected_qty: string | null;
}

export interface ProductOut {
  id: number;
  name_ar: string;
  category_id: number;
  category_name: string;
  status: string;
  mine: boolean;
}

export interface ProposalIn {
  name_ar: string;
  category_id: number;
}

export interface ProposalOut {
  product: ProductOut;
  similar: string[];
}

export interface ReadIn {
  ids?: number[];
  all?: boolean;
}

export interface ReceivedOut {
  id: number;
  received_at: string | null;
  product_name: string;
  unit: string;
  unit_size: string;
  collected_qty: string;
  unit_price: string | null;
  amount: string | null;
}

export interface RefreshIn {
  refresh_token: string;
}

export interface RegistrationIn {
  name: string;
  contact_name: string;
  locations: LocationIn[];
  owner_id_media_id: number;
  cr_media_id?: number | null;
}

export interface ResetCompleteIn {
  ticket: string;
  password: string;
}

export interface ScanIn {
  code: string;
}

export interface StartIn {
  phone: string;
}

export interface StartOut {
  channel: string;
  expires_in: number;
}

export interface SupplierOut {
  id: number;
  name: string;
  status: string;
  contact_name: string;
  phone: string;
  payout_cycle: string | null;
}

export interface TicketOut {
  ticket: string;
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
