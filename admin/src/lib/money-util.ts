/** مساعدات مجموعة المال: تنظيف المبلغ المكتوب، وتسميات الدفتر، وطرق صرف الأجر، ودوريات الموردين. */
import { useEffect, useState } from "react";

import * as fmt from "@ui/fmt";
import type { Tone } from "@ui/kit";

/** «1,500.250 » ← "1500.250" — ما يُرسل على السلك نصاً كما كتبه المستخدم بلا فواصل. */
export function cleanMoney(s: string): string {
  return s.replace(/[,\s٬]/g, "").replace(/[٠-٩]/g, (d) => String("٠١٢٣٤٥٦٧٨٩".indexOf(d)));
}

/** مبلغ صالح وموجب (بعد التنظيف). */
export function validMoney(s: string): boolean {
  const c = cleanMoney(s);
  return fmt.isMoney(c) && Number(c) > 0;
}

/** قيمة مؤجَّلة: تتغيّر بعد سكون الكتابة. */
export function useDebounced<T>(value: T, ms = 400): T {
  const [v, setV] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setV(value), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
  return v;
}

/** YYYY-MM-DD محلياً. */
export function isoDay(d: Date): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

export function addDays(iso: string, n: number): string {
  const [y, m, d] = iso.slice(0, 10).split("-").map(Number);
  return isoDay(new Date(y ?? 1970, (m ?? 1) - 1, (d ?? 1) + n));
}

// ——— الدفتر ————————————————————————————————————————————————————————————————
/** اسم الحساب مجمَّعاً بنوعه، بترتيب العرض. */
export const ACCOUNT_KIND: Array<[string, string]> = [
  ["treasury", "الخزينة"], ["sales_revenue", "إيراد المبيعات"], ["delivery_fee_revenue", "إيراد التوصيل"],
  ["cost_of_goods", "تكلفة المبيعات"], ["driver_pay_expense", "مصروف التوصيل"], ["operating_expense", "المصروفات"],
  ["sales_adjustment", "خصومات النزاعات"], ["customer_receivable", "ذمم العملاء"], ["driver_cash", "كاش السائقين"],
  ["driver_wallet", "محافظ السائقين"], ["supplier_payable", "مستحقات الموردين"], ["warehouse_inventory", "مخزون المخازن"],
  ["goods_in_custody", "بضاعة بعهدة السائقين"], ["owner_equity", "رأس مال المالك"], ["owner_drawings", "سحوبات المالك"],
];
const KIND_NAME = Object.fromEntries(ACCOUNT_KIND);

/** اسم حساب طرف واحد: «كاش السائق أحمد»، «ذمة مقهى…». */
const PARTY_PREFIX: Record<string, string> = {
  customer_receivable: "ذمة", driver_cash: "كاش السائق", driver_wallet: "محفظة", supplier_payable: "مستحقات",
  warehouse_inventory: "مخزون", goods_in_custody: "عهدة",
};

export function accountName(kind: string, party: string | null | undefined): string {
  if (party) return `${PARTY_PREFIX[kind] ?? KIND_NAME[kind] ?? kind} ${party}`;
  return KIND_NAME[kind] ?? kind;
}

/** الخادم يرسل حساب القيد «kind — الطرف». */
export function entryAccountName(raw: string): string {
  const i = raw.indexOf(" — ");
  return i < 0 ? accountName(raw, null) : accountName(raw.slice(0, i), raw.slice(i + 3));
}

export const TXN_KIND: Record<string, string> = {
  sale: "بيع", collection: "تحصيل", driver_pay: "أجر", supplier_cost: "تكلفة", cash_handover: "تسليم كاش",
  supplier_payout: "صرف مورد", expense: "مصروف", dispute_adjustment: "تسوية نزاع", stock_intake: "إدخال مخزون",
  stock_adjustment: "تسوية جرد", reversal: "حركة عكسية", driver_payout: "صرف أجر", capital: "رأس مال",
  owner_withdrawal: "سحب المالك", cancellation: "إلغاء", custody: "أمانة",
};

// ——— السائقون ———————————————————————————————————————————————————————————————
export const PAY_METHOD: Record<string, [string, Tone]> = {
  offset_on_settlement: ["خصم من الكاش", "info"],
  periodic: ["صرف دوري", "primary"],
};

// ——— الموردون ———————————————————————————————————————————————————————————————
export const CYCLE: Record<string, [string, number]> = {
  daily: ["يومي", 1], weekly: ["أسبوعي", 7], semimonthly: ["نصف شهري", 15], monthly: ["شهري", 30],
};

/** مبلغ بالألف (مليم) عدداً صحيحاً من النص العشري — لحساب مبالغ تُرسل بلا كسور عائمة. */
export function milli(s: string | null | undefined): number {
  const m = String(s ?? "0").trim().match(/^(-?)(\d*)(?:\.(\d{0,3}))?/);
  if (!m) return 0;
  const n = Number(m[2] || "0") * 1000 + Number((m[3] ?? "").padEnd(3, "0"));
  return m[1] ? -n : n;
}

/** 1500250 ← "1500.250" */
export function fromMilli(n: number): string {
  const a = Math.abs(n);
  return `${n < 0 ? "-" : ""}${Math.floor(a / 1000)}.${String(a % 1000).padStart(3, "0")}`;
}
