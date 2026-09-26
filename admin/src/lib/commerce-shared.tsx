/** مشترك شاشات التجارة (الاعتمادات، الموردون، الكتالوج، التسعير، التصنيفات، المخازن): تسميات القيم وحساب العرض. */
import type { ReactNode } from "react";

import * as fmt from "@ui/fmt";
import { Num, StatusBadge, type Tone } from "@ui/kit";
import type { CatalogRowOut } from "@/api/types";

/** وحدات البيع (sale_unit). */
export const UNIT: Record<string, string> = {
  kg: "كغ", liter: "لتر", piece: "حبة", carton: "كرتونة", pack: "علبة", bag: "كيس",
  box: "صندوق", bottle: "قارورة", can: "علبة معدنية", tray: "صينية", roll: "لفة", bundle: "حزمة",
};
export const UNIT_OPTIONS = Object.entries(UNIT).map(([value, label]) => ({ value, label }));

/** «كغ»، «2 كغ»، «كرتونة ×1000». */
export function unitLabel(unit: string, size: string | number): string {
  const u = UNIT[unit] ?? unit;
  const n = Number(size);
  if (!n || n === 1) return u;
  return unit === "kg" || unit === "liter" ? `${fmt.qty(size)} ${u}` : `${u} ×${fmt.qty(size)}`;
}

export const CYCLE: Record<string, string> = { daily: "يومي", weekly: "أسبوعي", semimonthly: "نصف شهري", monthly: "شهري" };
export const PAY_METHOD: Record<string, string> = { offset_on_settlement: "خصم من الكاش عند التسوية", periodic: "صرف دوري" };

export const PARTY_STATUS: Record<string, [string, Tone]> = {
  pending: ["بانتظار الاعتماد", "warning"], approved: ["معتمد", "success"], rejected: ["مرفوض", "error"], suspended: ["موقوف", "neutral"],
};
export function PartyBadge({ status }: { status: string }) {
  const [l, t] = PARTY_STATUS[status] ?? [status, "neutral"];
  return <StatusBadge tone={t}>{l}</StatusBadge>;
}

export function OfferBadge({ status }: { status: string }) {
  return status === "active" ? <StatusBadge tone="success">نشط</StatusBadge> : <StatusBadge tone="neutral">موقوف</StatusBadge>;
}

export const MODE: Record<string, string> = { margin_pct: "هامش %", margin_amount: "هامش مبلغ", manual: "سعر يدوي" };

/** عمود «الهامش»: 18% أو +9.750 أو يدوي. */
export function marginText(mode: string | null | undefined, margin: string | null | undefined): ReactNode {
  if (!mode) return "—";
  if (mode === "manual") return "يدوي";
  if (margin == null) return "—";
  return <Num>{mode === "margin_pct" ? `${fmt.qty(margin)}%` : `+${fmt.money(margin)}`}</Num>;
}

/** وصف طريقة التسعير: «هامش 18% فوق الشراء». */
export function modeSentence(mode: string | null | undefined, margin: string | null | undefined): string {
  if (!mode) return "لم يُسعَّر بعد";
  if (mode === "manual") return "سعر يدوي";
  if (mode === "margin_pct") return `هامش ${fmt.qty(margin)}% فوق الشراء`;
  return `هامش ${fmt.money(margin)} د.ل فوق الشراء`;
}

/** السعر بالهامش على سعر شراء (للعرض فقط؛ القاعدة تحسب الحقيقي بثلاث خانات). */
export function priceByMargin(mode: string, base: string | null | undefined, margin: string): number | null {
  if (base == null || margin.trim() === "" || Number.isNaN(Number(margin))) return null;
  const b = Number(base), m = Number(margin);
  const v = mode === "margin_pct" ? b * (1 + m / 100) : b + m;
  return Math.round(v * 1000) / 1000;
}

/** حالة صنف الكتالوج: مراجعة ← تحت التكلفة ← نافد ← متوفر. */
export function CatalogStatus({ row }: { row: CatalogRowOut }) {
  if (row.needs_review) return <StatusBadge tone="warning">يحتاج مراجعة</StatusBadge>;
  if (row.below_cost) return <StatusBadge tone="error">موقوف تحت التكلفة</StatusBadge>;
  if (!row.is_available) return <StatusBadge tone="neutral">نافد</StatusBadge>;
  return <StatusBadge tone="success">متوفر</StatusBadge>;
}

export function VisibilityBadge({ visibility }: { visibility: string }) {
  return visibility === "visible" ? <StatusBadge tone="success">ظاهر</StatusBadge> : <StatusBadge tone="neutral">مخفي</StatusBadge>;
}

/** هامش على سعر البيع: (البيع − الشراء) / البيع. */
export function marginOnSale(sale: string | null | undefined, cost: string | null | undefined): string | null {
  const s = Number(sale), c = Number(cost);
  if (!sale || cost == null || !s) return null;
  return `${(((s - c) / s) * 100).toFixed(1)}%`;
}

/** كمية نصية صالحة للسلك: رقم بثلاث خانات على الأكثر، وقد تكون سالبة إن سُمح. */
export function isQty(s: string, allowNegative = false): boolean {
  return (allowNegative ? /^-?\d+(\.\d{1,3})?$/ : /^\d+(\.\d{1,3})?$/).test(s.trim());
}

/** فرق كميتين نصيتين بالآلاف دون كسور عائمة: "12" − "20.5" ← "-8.500". */
export function qtyDiff(a: string, b: string): string {
  const milli = (s: string) => {
    const neg = s.trim().startsWith("-");
    const [i = "0", f = ""] = s.trim().replace("-", "").split(".");
    const v = Number(i) * 1000 + Number((f + "000").slice(0, 3));
    return neg ? -v : v;
  };
  const d = milli(a) - milli(b);
  const abs = Math.abs(d);
  return `${d < 0 ? "-" : ""}${Math.floor(abs / 1000)}.${String(abs % 1000).padStart(3, "0")}`;
}
