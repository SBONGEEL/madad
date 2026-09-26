/** مساعدات مجموعة الطلبات (الطلبات، التتبّع، القوائم، النزاع): الوحدات والعدد والأيام بالعربية. */
import * as fmt from "@ui/fmt";

export const UNIT: Record<string, string> = {
  kg: "كغ", liter: "لتر", piece: "حبة", carton: "كرتونة", pack: "علبة", bag: "كيس",
  box: "صندوق", bottle: "قارورة", can: "علبة معدنية", tray: "طبق", roll: "لفة", bundle: "حزمة",
};

/** «كغ»، «2 كغ»، «كرتونة ×12». */
export function unitLabel(unit: string, size?: string | number | null): string {
  const u = UNIT[unit] ?? unit;
  const n = Number(size ?? 1);
  if (!n || n === 1) return u;
  return unit === "kg" || unit === "liter" ? `${fmt.qty(size)} ${u}` : `${u} ×${fmt.qty(size)}`;
}

/** «8 كغ» أو «12» — الكمية ووحدتها إن كانت وزناً أو حجماً. */
export function qtyWithUnit(qty: string | number, unit?: string | null): string {
  const q = fmt.qty(qty);
  return unit === "kg" || unit === "liter" ? `${q} ${UNIT[unit]}` : q;
}

/** العدد مع «صنف» على قواعد العربية: صنف واحد، صنفان، 3 أصناف، 12 صنفاً. */
export function itemsWord(n: number): string {
  if (n === 0) return "لا أصناف";
  if (n === 1) return "صنف واحد";
  if (n === 2) return "صنفان";
  const m = n % 100;
  return m >= 3 && m <= 10 ? `${n} أصناف` : `${n} صنفاً`;
}

const WEEK = ["الأحد", "الاثنين", "الثلاثاء", "الأربعاء", "الخميس", "الجمعة", "السبت"];

/** «اليوم 14:32»، «أمس 09:10»، «السبت 19/09». */
export function whenLabel(iso: string | null | undefined): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const start = (x: Date) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const days = Math.round((start(new Date()) - start(d)) / 86400000);
  if (days === 0) return `اليوم ${fmt.time(iso)}`;
  if (days === 1) return `أمس ${fmt.time(iso)}`;
  return `${WEEK[d.getDay()] ?? ""} ${fmt.date(iso).slice(0, 5)}`;
}

/** «السبت 19/09 11:20» */
export function dayTime(iso: string | null | undefined): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return `${WEEK[d.getDay()] ?? ""} ${fmt.date(iso).slice(0, 5)} ${fmt.time(iso)}`;
}

/** أيام التذكير بترتيب الأسبوع المحلي (السبت أولاً) وقيمتها على عُرف Postgres (الأحد 0 … السبت 6). */
export const REMINDER_DAYS: Array<{ dow: number; short: string; long: string }> = [
  { dow: 6, short: "سبت", long: "السبت" }, { dow: 0, short: "أحد", long: "الأحد" }, { dow: 1, short: "اثنين", long: "الاثنين" },
  { dow: 2, short: "ثلاثاء", long: "الثلاثاء" }, { dow: 3, short: "أربعاء", long: "الأربعاء" },
  { dow: 4, short: "خميس", long: "الخميس" }, { dow: 5, short: "جمعة", long: "الجمعة" },
];

export function daysText(days: number[]): string {
  return REMINDER_DAYS.filter((d) => days.includes(d.dow)).map((d) => d.long).join(" و");
}

export const ENDED = new Set(["delivered", "closed", "cancelled"]);
