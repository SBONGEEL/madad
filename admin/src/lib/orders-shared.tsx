/** مشترك شاشات الطلبيات والمخطط والإسناد والنزاعات والأمانات: تسميات القيم الثابتة وشاراتها. */
import { StatusBadge, type Tone } from "@ui/kit";

/** vehicle_type */
export const VEHICLE: Record<string, string> = {
  motorcycle: "دراجة", car: "سيارة", van: "فان", pickup: "بيك أب", truck: "شاحنة",
};

/** dispute_kind */
export const DISPUTE_KIND: Record<string, string> = {
  damaged: "صنف تالف", short: "كمية ناقصة", refused: "رفض استلام", other: "أخرى",
};

/** actor_role لمن فتح النزاع */
export const OPENED_BY: Record<string, string> = {
  customer: "العميل", driver: "السائق", supplier: "المورد", admin: "اللوحة", system: "تلقائياً",
};

export function DisputeStatusBadge({ status }: { status: string }) {
  return status === "resolved" ? <StatusBadge tone="success">مُقرَّر</StatusBadge> : <StatusBadge tone="error">مفتوح</StatusBadge>;
}

/** dispute_resolution */
export const RESOLUTION: Record<string, string> = {
  partial_discount: "خصم جزئي", return: "إعادة", cancel: "إلغاء الصنف", no_action: "لا إجراء",
};

/** refund_method */
export const REFUND: Record<string, string> = {
  credit_next_order: "رصيد يُخصم من طلبيته القادمة", cash_via_driver: "نقداً عبر سائق (يدفعه من الكاش الذي معه)",
};

/** loss_bearer */
export const LOSS: Record<string, string> = { supplier: "المورد", madad: "مَدَد", driver: "السائق" };

/** custody_fate */
export const FATE: Record<string, string> = {
  to_warehouse: "إلى المخزن", return_supplier: "أُعيدت للمورد", to_order: "إلى طلبية",
};

/** حالة سطر الأمانة ومصيره في شارة واحدة. */
export function CustodyBadge({ status, fate, target }: { status: string; fate: string | null; target: string | null }) {
  if (status === "open" || !fate) return <StatusBadge tone="warning">لم يُقرَّر</StatusBadge>;
  const tone: Tone = status === "assigned" ? "info" : "success";
  const label = fate === "to_order" ? `إلى طلبية ${target ?? ""}`.trim()
    : fate === "to_warehouse" && target ? `إلى المخزن · ${target}` : FATE[fate] ?? fate;
  return <StatusBadge tone={tone}>{label}</StatusBadge>;
}

/** stop_source */
export const STOP_SOURCE: Record<string, string> = { supplier: "مورد", warehouse: "مخزون مَدَد", custody: "من السائق (أمانة)" };

/** stop_status */
export const STOP_STATUS: Record<string, [string, Tone]> = {
  pending: ["بانتظار الجمع", "neutral"], collected: ["جُمعت", "success"], short: ["ناقصة", "warning"], refused: ["رُفضت", "error"],
};

/** «منذ 6 دقائق» */
export function ago(iso: string | null | undefined): string {
  if (!iso) return "—";
  const m = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 60000));
  if (m < 1) return "الآن";
  if (m < 60) return m === 1 ? "منذ دقيقة" : m === 2 ? "منذ دقيقتين" : `منذ ${m} دقيقة`;
  const h = Math.round(m / 60);
  if (h < 24) return h === 1 ? "منذ ساعة" : h === 2 ? "منذ ساعتين" : `منذ ${h} ساعة`;
  const d = Math.round(h / 24);
  return d === 1 ? "منذ يوم" : d === 2 ? "منذ يومين" : `منذ ${d} يوماً`;
}

/** «7 أصناف» */
export function itemsCount(n: number): string {
  return n === 1 ? "صنف واحد" : n === 2 ? "صنفان" : n <= 10 ? `${n} أصناف` : `${n} صنفاً`;
}
