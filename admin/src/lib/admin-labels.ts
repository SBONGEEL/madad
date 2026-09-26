/** أسماء الإدارة بالعربية: الإعدادات وقيمها، وجداول سجل التدقيق، وتلخيص التغيير (قبل ← بعد). */
import * as fmt from "@ui/fmt";
import { ORDER_STATUS, type Tone } from "@ui/kit";

/** الصلاحيات بترتيب لوحة «المشرفون والصلاحيات». */
export const PERMS: Array<{ key: string; label: string }> = [
  { key: "approvals", label: "الاعتمادات" }, { key: "catalog", label: "الكتالوج" }, { key: "costs_view", label: "التكاليف" },
  { key: "orders", label: "الطلبيات" }, { key: "warehouses", label: "المخازن" }, { key: "money", label: "المال" },
  { key: "customers", label: "العملاء" }, { key: "notifications", label: "الإشعارات" }, { key: "settings", label: "الإعدادات" },
  { key: "users", label: "المستخدمون" },
];

export const SETTING_LABEL: Record<string, string> = {
  min_order_amount: "الحد الأدنى — المبلغ", min_order_lines: "الحد الأدنى — عدد الأصناف", min_order_decided: "الحد الأدنى — القرار",
  fee_mode: "طريقة رسم التوصيل", delivery_fee_flat: "رسم التوصيل الثابت", free_delivery_threshold: "توصيل مجاني فوق",
  oos_policy: "سياسة النفاد", warehouse_first: "مخزن مَدَد يُقدَّم على الموردين", auto_confirm_max_amount: "الاعتماد الآلي حتى مبلغ",
  driver_pay_base: "أجر السائق — ثابت للطلبية", driver_pay_per_stop: "أجر السائق — لكل نقطة استلام",
  driver_pay_per_km: "أجر السائق — لكل كيلومتر", driver_cash_cap: "سقف الكاش بحوزة السائق",
  collection_mode: "التحصيل على الدفعات", reprice_on_cost_change: "سعر البيع حين يغيّر المورد سعره",
  cancel_policy: "إلغاء الطلبية من المطعم", oversell_policy: "طلب أكثر من المتاح", pickup_proof_required: "إثبات الاستلام عند المورد",
  fee_conflict_rule: "رسم الحيّ ورسم المنطقة المرسومة", cost_guard_basis: "أساس «التكلفة» التي لا يُباع الصنف تحتها",
  driver_sees_supplier_name: "السائق يرى اسم المورد", customer_sees_driver_name: "العميل يرى اسم السائق",
  customer_can_call_driver: "العميل يتصل بالسائق",
};

/** إعدادات مالية: تُعرض بثلاث خانات. */
export const MONEY_SETTINGS = new Set(["min_order_amount", "delivery_fee_flat", "free_delivery_threshold", "auto_confirm_max_amount",
  "driver_pay_base", "driver_pay_per_stop", "driver_pay_per_km", "driver_cash_cap", "fee", "amount", "sale_price", "purchase_price",
  "unit_cost", "total", "subtotal", "delivery_fee"]);

export const VALUE_LABEL: Record<string, string> = {
  until_collecting: "حتى بدء الجمع", anytime: "في أي وقت", forbid: "ممنوع", allow: "مسموح",
  average: "متوسط سعر الشراء", fifo: "الأقدم شراءً أولاً", flat: "ثابت", by_zone: "حسب المنطقة",
  auto_hide: "إخفاء تلقائي", mark_out: "«نافد» ظاهر", on_completion: "عند اكتمال التسليم", per_batch: "مع كل دفعة",
  area_wins: "المنطقة المرسومة تغلب", zone_wins: "الحيّ يغلب", higher: "الرسم الأعلى", lower: "الرسم الأقل",
  max_source: "أعلى سعر بين الموردين", first_priority: "المورد الأول في الأولوية",
  direct: "يطلب مباشرة", owner_confirms: "صاحب المنشأة يؤكد",
  pending: "بانتظار الاعتماد", approved: "معتمد", rejected: "مرفوض", suspended: "موقوف",
  whatsapp_official: "واتساب الرسمي", whatsapp_linked: "رقم واتساب عادي", sms: "رسالة نصية SMS",
  customer: "العملاء", supplier: "الموردون", driver: "السائقون", admin: "المشرفون",
  owner: "المالك", supervisor: "مشرف", purchaser: "مسؤول مشتريات", system: "النظام",
  otp: "رمز جديد", self: "المستخدم نفسه",
};

export const KIND_LABEL: Record<string, string> = { restaurant: "مطعم", cafe: "مقهى", other: "آخر" };

export const PARTY_STATUS: Record<string, [string, Tone]> = {
  pending: ["بانتظار الاعتماد", "warning"], approved: ["معتمد", "success"], rejected: ["مرفوض", "error"], suspended: ["موقوف", "neutral"],
};

const FIELD_LABEL: Record<string, string> = {
  ...SETTING_LABEL, status: "الحالة", sale_price: "سعر البيع", purchase_price: "سعر الشراء", name: "الاسم", name_ar: "الاسم",
  fee: "الرسم", active: "مفعّل", amount: "المبلغ", permission: "الصلاحية", position: "الترتيب", enabled: "مفعّلة", polygon: "الحدود",
  purchaser_mode: "طريقة الطلب", method: "الطريقة", title: "العنوان", role: "الدور", qty: "الكمية", note: "ملاحظة",
};

export const TABLE_LABEL: Record<string, string> = {
  city_settings: "الإعدادات", cogs_method_periods: "طريقة تكلفة المخازن", otp_channels: "قنوات الرمز", delivery_zones: "الأحياء",
  delivery_areas: "المناطق المرسومة", customers: "العملاء", customer_locations: "فروع العملاء", customer_members: "مستخدمو العملاء",
  suppliers: "الموردون", drivers: "السائقون", supplier_offers: "عروض الموردين", catalog_items: "أصناف الكتالوج",
  catalog_item_pricing: "تسعير الأصناف", catalog_item_sources: "مصادر الأصناف", orders: "الطلبيات", order_items: "أسطر الطلبيات",
  pickup_stops: "نقاط الاستلام", pickup_stop_lines: "أسطر الاستلام", pickup_handovers: "إثبات الاستلام",
  driver_pay_offers: "عروض أجر السائق", disputes: "النزاعات", driver_custody: "بضاعة بعهدة السائقين",
  owner_capital_entries: "رأس المال", owner_withdrawals: "سحوبات المالك", admin_members: "المشرفون",
  admin_permissions: "الصلاحيات", password_reset_events: "إعادة تعيين كلمة المرور", broadcasts: "الإشعارات الجماعية",
};

const TABLE_KIND: Record<string, [string, Tone]> = {
  supplier_offers: ["سعر شراء", "info"], catalog_items: ["صنف", "info"], catalog_item_pricing: ["سعر بيع", "info"],
  catalog_item_sources: ["مصادر صنف", "info"], owner_capital_entries: ["مال", "success"], owner_withdrawals: ["مال", "success"],
  driver_custody: ["عهدة", "warning"], city_settings: ["إعداد", "warning"], cogs_method_periods: ["إعداد", "warning"],
  otp_channels: ["إعداد", "warning"], delivery_zones: ["إعداد", "warning"], delivery_areas: ["إعداد", "warning"],
  admin_members: ["صلاحيات", "primary"], admin_permissions: ["صلاحيات", "primary"], customer_members: ["مستخدمون", "primary"],
  password_reset_events: ["كلمة مرور", "primary"], disputes: ["نزاع", "warning"], broadcasts: ["إشعار", "neutral"],
};

type Changes = Record<string, unknown>;

function pair(changes: Changes, k: string): [unknown, unknown] {
  const v = changes[k];
  return Array.isArray(v) ? [v[0], v[1]] : [undefined, v];
}

/** نوع السطر في السجل (الشارة): الإلغاء خطأ، والحالة محايدة، والمال أخضر… */
export function auditKind(table: string, changes: Changes): [string, Tone] {
  if (table === "orders" || table === "customers" || table === "suppliers" || table === "drivers" || table === "customer_locations") {
    const [, after] = pair(changes, "status");
    if (after === "cancelled") return ["إلغاء", "error"];
    if ("status" in changes) return ["حالة", "neutral"];
    return [table === "orders" ? "طلبية" : "حساب", "neutral"];
  }
  if (table.startsWith("pickup_") || table === "order_items" || table === "driver_pay_offers") return ["طلبية", "neutral"];
  return TABLE_KIND[table] ?? ["تغيير", "neutral"];
}

/** «على»: «الطلبية #رقمها»، أو الإعدادات، أو اسم الجدول ورقم السطر. */
export function auditTarget(table: string, pk: string, changes: Changes): string {
  if (table === "orders") return `الطلبية #${pk}`;
  if (table === "city_settings") {
    const keys = Object.keys(changes).filter((k) => k in SETTING_LABEL);
    return keys.length === 1 && keys[0] ? SETTING_LABEL[keys[0]] ?? "الإعدادات" : "الإعدادات";
  }
  if (table === "otp_channels") return `قناة ${VALUE_LABEL[pk] ?? pk}`;
  const [, name] = pair(changes, "name_ar");
  const [, name2] = pair(changes, "name");
  const nm = typeof name === "string" ? name : typeof name2 === "string" ? name2 : null;
  return nm ? `${TABLE_LABEL[table] ?? table} — ${nm}` : `${TABLE_LABEL[table] ?? table} #${pk}`;
}

/** قيمة مفردة للعرض: المال بثلاث خانات، والتعدادات بالعربية، والفارغ «لم يُحدَّد». */
export function showValue(key: string, v: unknown, table?: string): string {
  if (v === null || v === undefined || v === "") return "لم يُحدَّد";
  if (typeof v === "boolean") return v ? "مفعّل" : "مغلق";
  if (MONEY_SETTINGS.has(key) && (typeof v === "number" || (typeof v === "string" && /^-?\d+(\.\d+)?$/.test(v)))) return `${fmt.money(v)} د.ل`;
  if (typeof v === "string") {
    if (key === "status" && table === "orders") return ORDER_STATUS[v]?.[0] ?? v;
    return VALUE_LABEL[v] ?? v;
  }
  if (typeof v === "number") return String(v);
  if (Array.isArray(v)) return `${v.length} نقاط`;
  return "…";
}

/** «قبل ← بعد» لكل حقل تغيّر (حتى ثلاثة)؛ الإضافة والحذف بكلمة. */
export function auditChange(table: string, op: string, changes: Changes): string {
  if (op === "DELETE") return "حذف";
  const keys = Object.keys(changes).filter((k) => !["id", "city", "created_at", "updated_at", "created_by", "set_by"].includes(k));
  if (op === "INSERT") {
    if (table === "password_reset_events") return VALUE_LABEL[String(pair(changes, "method")[1])] ?? "إعادة تعيين";
    if (table === "admin_permissions") return `إضافة: ${PERMS.find((p) => p.key === pair(changes, "permission")[1])?.label ?? ""}`;
    if (table === "cogs_method_periods") return VALUE_LABEL[String(pair(changes, "method")[1])] ?? "إضافة";
    return "إضافة";
  }
  if (!keys.length) return "—";
  const one = keys.length === 1;
  const parts = keys.slice(0, 3).map((k) => {
    const [b, a] = pair(changes, k);
    const txt = `${showValue(k, b, table)} ← ${showValue(k, a, table)}`;
    return one ? txt : `${FIELD_LABEL[k] ?? k}: ${txt}`;
  });
  return parts.join(" · ") + (keys.length > 3 ? ` · +${keys.length - 3}` : "");
}

/** الفاعل: الاسم كما يرسله الخادم، أو دور النظام بالعربية. */
const ACTOR_ROLE: Record<string, string> = { system: "النظام", customer: "عميل", supplier: "مورد", driver: "سائق", admin: "مشرف" };
export function auditActor(actor: string): string {
  return ACTOR_ROLE[actor] ?? actor;
}
