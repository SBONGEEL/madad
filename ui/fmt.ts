/** العرض: المال بثلاث خانات (م-1) `1,250.000`، والأرقام لاتينية دائماً، والتاريخ يوم/شهر/سنة. */

export function money(v: string | number | null | undefined, decimals = 3): string {
  const n = Number(v ?? 0);
  const [i, f] = Math.abs(n).toFixed(decimals).split(".");
  const grouped = (i ?? "0").replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return (n < 0 ? "−" : "") + grouped + (f ? `.${f}` : "");
}

/** كمية بلا أصفار زائدة: 2.500 ← 2.5 */
export function qty(v: string | number | null | undefined): string {
  const n = Number(v ?? 0);
  return String(Number(n.toFixed(3)));
}

export function int(v: number | string | null | undefined): string {
  return Number(v ?? 0).toLocaleString("en-US");
}

const pad = (n: number) => String(n).padStart(2, "0");

export function date(iso: string | null | undefined): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return `${pad(d.getDate())}/${pad(d.getMonth() + 1)}/${d.getFullYear()}`;
}

export function time(iso: string | null | undefined): string {
  if (!iso) return "—";
  const d = new Date(iso);
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export function dateTime(iso: string | null | undefined): string {
  if (!iso) return "—";
  return `${date(iso)} ${time(iso)}`;
}

export function today(): string {
  const d = new Date();
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

const DAYS = ["الأحد", "الاثنين", "الثلاثاء", "الأربعاء", "الخميس", "الجمعة", "السبت"];
export function weekday(d = new Date()): string {
  return DAYS[d.getDay()] ?? "";
}

/** مبلغ صالح للسلك: رقم موجب بثلاث خانات على الأكثر. */
export function isMoney(s: string): boolean {
  return /^\d+(\.\d{1,3})?$/.test(s.trim());
}

/** رقم ليبي كما يكتبه الناس (091 000 0001 أو 0910000001 أو +218…) ← +2189XXXXXXXX، أو null. */
export function phoneE164(input: string): string | null {
  const d = input.replace(/[^\d+]/g, "").replace(/^00/, "+");
  const m = d.match(/^(?:\+?218|0)?(9\d{8})$/);
  return m ? `+218${m[1]}` : null;
}

/** +218910000001 ← 091 000 0001 */
export function phoneLocal(e164: string | null | undefined): string {
  const m = (e164 ?? "").match(/^\+218(9\d)(\d{3})(\d{4})$/);
  return m ? `0${m[1]} ${m[2]} ${m[3]}` : e164 ?? "—";
}
