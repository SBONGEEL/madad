/**
 * مولَّد من OpenAPI الخلفية (ui/scripts/gen-types.mjs driver) — لا يُحرَّر يدوياً.
 * المال والكميات نصوص عشرية بثلاث خانات كما يرسلها الخادم؛ الحقل الاختياري «?» قد لا يصل
 * (تكلفةٌ محجوبة عمّن لا يملك «التكاليف»، أو قيمة بإعداد).
 */

export interface AvailabilityIn {
  accepting: boolean;
}

export interface AvailableOut {
  id: number;
  customer_name: string;
  branch_name: string;
  dest_address: string | null;
  dest_lat: string | null;
  dest_lng: string | null;
  stops: number;
  route_km: string | null;
  pay_estimate: string | null;
  amount_to_collect: string;
  load_kg: string;
  weight_complete: boolean;
  capacity_kg: string | null;
  over_capacity: boolean;
  my_offer: Record<string, unknown> | null;
}

export interface BatchIn {
  lines: BatchLineIn[];
  eta_at?: string | null;
  next_eta_at?: string | null;
}

export interface BatchLineIn {
  order_item_id: number;
  qty: number | string;
}

export interface BatchOut {
  id: number;
  seq: number;
  status: string;
  eta_at: string | null;
  next_eta_at: string | null;
  notified_at: string | null;
  departed_at: string | null;
  delivered_at: string | null;
  value: string;
  lines: Record<string, unknown>[];
  notice: Record<string, unknown> | null;
}

export interface BatchTimesIn {
  eta_at?: string | null;
  next_eta_at?: string | null;
}

export interface Body_upload_api_driver_media_post {
  purpose: string;
  file: string;
}

export interface ChangePasswordIn {
  current_password: string;
  new_password: string;
}

export interface CodeIn {
  code: string;
}

export interface CompleteIn {
  ticket: string;
  password: string;
  full_name: string;
}

export interface ConfirmLineIn {
  line_id: number;
  collected_qty: number | string;
}

export interface ConfirmStopIn {
  lines: ConfirmLineIn[];
  photo_media_id?: number | null;
}

export interface ContactOut {
  phone: string | null;
  whatsapp: string | null;
}

export interface CustodyItemOut {
  id: number;
  order_id: number;
  name_ar: string;
  unit: string;
  unit_size: string;
  qty: string;
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
  kind: string;
  description: string;
  status: string;
  created_at: string;
}

export interface DriverOut {
  id: number;
  full_name: string;
  status: string;
  pay_method: string | null;
  vehicle: string;
  capacity_kg: string | null;
  phone: string;
  city_name: string;
  documents_complete: boolean;
  accepting?: boolean;
}

export interface EtaIn {
  eta_at: string;
}

export interface HandoverOut {
  handed_over: boolean;
  method: string;
}

export interface ItemOut {
  id: number;
  name_ar: string;
  unit: string;
  unit_size: string;
  qty: string;
  collected_qty: string;
  delivered_qty: string;
  price: string | null;
  line_value: string | null;
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
  driver: DriverOut | null;
  unread: number;
  contact?: ContactOut | null;
}

export interface MediaOut {
  id: number;
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
  customer_name: string;
  customer_phone: string;
  branch_name: string;
  dest_address: string | null;
  dest_lat: string | null;
  dest_lng: string | null;
  amount_to_collect: string;
  delivery_fee: string;
  driver_pay: string | null;
  collection_mode: string | null;
  route_km: string | null;
  load_kg: string;
  weight_complete: boolean;
  capacity_kg: string | null;
  over_capacity: boolean;
  stops: StopOut[];
  items: ItemOut[];
  batches: BatchOut[];
  recipient_name?: string | null;
}

export interface Order2SummaryOut {
  id: number;
  status: string;
  customer_name: string;
  branch_name: string;
  amount_to_collect: string;
  driver_pay: string | null;
}

export interface PayOfferIn {
  amount: number | string;
}

export interface ReadIn {
  ids?: number[];
  all?: boolean;
}

export interface RefreshIn {
  refresh_token: string;
}

export interface RegistrationIn {
  full_name: string;
  vehicle: string;
  capacity_kg?: number | string | null;
  id_media_id: number;
  license_media_id: number;
  license_back_media_id: number;
  photo_media_id: number;
}

export interface ResetCompleteIn {
  ticket: string;
  password: string;
}

export interface SettlementOut {
  kind: string;
  id: number;
  amount: string;
  offset_amount: string;
  order_id: number | null;
  received_by: string | null;
  at: string | null;
}

export interface StartIn {
  phone: string;
}

export interface StartOut {
  channel: string;
  expires_in: number;
}

export interface StopLineOut {
  id: number;
  name_ar: string;
  unit: string;
  unit_size: string;
  planned_qty: string;
  collected_qty: string | null;
}

export interface StopOut {
  id: number;
  seq: number;
  label: string;
  status: string;
  lat: string | null;
  lng: string | null;
  address_text: string | null;
  pickup_code: string;
  handed_over: boolean;
  lines: StopLineOut[];
  eta_at?: string | null;
  arrived_at?: string | null;
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

export interface WalletOut {
  cash_held: string;
  cash_cap: string | null;
  over_cap: boolean;
  wage_due: string;
  pay_method: string | null;
  handover_due: string;
  next_payout_on?: string | null;
  next_payout_rule?: string | null;
}
