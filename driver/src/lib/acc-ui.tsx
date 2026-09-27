/** أجزاء مشتركة بين شاشات الحساب والمال في تطبيق السائق: صفحة الدخول، رأس الخطوة، مفتاح التوفر، والتسميات. */
import type { ReactNode } from "react";

import * as fmt from "@ui/fmt";
import { Switch, type Tone, useAction } from "@ui/kit";
import { api } from "@/api/client";
import type { Me2Out } from "@/api/types";
import { useSession } from "@/session";

/** صفحة الدخول قبل الجلسة: عمود واحد، والأزرار في الأسفل. */
export function AuthPage({ children }: { children: ReactNode }) {
  return <main className="flex-1 flex flex-col gap-5 px-6 pt-12 pb-8">{children}</main>;
}

export function StepHead({ step, title, sub }: { step?: string; title?: ReactNode; sub?: ReactNode }) {
  return (
    <>
      {step ? <span className="text-13 font-bold text-ink-muted">{step}</span> : null}
      {title ? <h1 className="m-0 text-22 font-bold">{title}</h1> : null}
      {sub ? <span className="text-15 text-ink-muted">{sub}</span> : null}
    </>
  );
}

/** «أستقبل طلبيات الآن» (§12-ط): غير المتاح لا تُعرض عليه طلبيات ولا يقبل؛ قد يُسند إليه مَدَد يدوياً مع تنبيه. */
export function Availability({ accepting, children }: { accepting: boolean; children?: ReactNode }) {
  const { refresh } = useSession();
  const act = useAction();
  async function set(v: boolean) {
    const r = await act.run(() => api.put<Me2Out>(`/api/driver/availability`, { accepting: v }),
      v ? "أنت متاح: تصلك الطلبيات الجديدة" : "أنت غير متاح: لا تُعرض عليك طلبيات");
    if (r) refresh();
  }
  return (
    <div className="flex flex-col gap-1.5 p-3 bg-surface border border-border rounded-md text-14">
      <div className="flex justify-between items-center gap-2">
        <span className="font-bold">أستقبل طلبيات الآن</span>
        <Switch checked={accepting} label="أستقبل طلبيات الآن" disabled={act.busy} onChange={(v) => void set(v)} />
      </div>
      {children ? <span className="text-ink-muted">{children}</span> : null}
    </div>
  );
}

/** «بقيت 3 محاولات» بصيغة العدد العربية. */
export function attemptsLeft(n: unknown): string {
  const k = Number(n);
  if (n == null || !Number.isFinite(k)) return "";
  if (k <= 0) return " — كانت هذه المحاولة الأخيرة";
  if (k === 1) return " — بقيت محاولة واحدة";
  if (k === 2) return " — بقيت محاولتان";
  if (k <= 10) return ` — بقيت ${k} محاولات`;
  return ` — بقيت ${k} محاولة`;
}

export const CHANNEL: Record<string, string> = { whatsapp_official: "واتساب", whatsapp_linked: "واتساب", sms: "رسالة نصية", console: "وحدة التطوير" };

export const PHONE_HINT = "اكتب رقماً ليبياً صحيحاً، مثل 091 555 0142";

/** مهلة إعادة إرسال الرمز في الخادم (RESEND_SECONDS). */
export const RESEND = 60;

export function countdown(s: number): string {
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

/** نوع المركبة (vehicle_type): القيم الخمس بتسمياتها. */
export const VEHICLES: Array<{ value: string; label: string }> = [
  { value: "motorcycle", label: "دراجة نارية" },
  { value: "car", label: "سيارة" },
  { value: "van", label: "فان" },
  { value: "pickup", label: "بيك أب" },
  { value: "truck", label: "شاحنة" },
];
export const VEHICLE: Record<string, string> = Object.fromEntries(VEHICLES.map((v) => [v.value, v.label]));

/** حالة السائق (party_status). */
export const DRIVER_STATUS: Record<string, [string, Tone]> = {
  approved: ["معتمد", "success"], pending: ["بانتظار الاعتماد", "warning"], suspended: ["موقوف", "error"], rejected: ["مرفوض", "error"],
};

/** طريقة صرف الأجر (م-11): يحددها مَدَد لكل سائق. */
export const PAY_METHOD: Record<string, string> = {
  offset_on_settlement: "خصم من الكاش عند التسوية",
  periodic: "صرف دوري",
};

export const UNIT: Record<string, string> = {
  kg: "كغ", liter: "لتر", piece: "حبة", carton: "كرتونة", pack: "علبة", bag: "كيس",
  box: "صندوق", bottle: "قارورة", can: "علبة معدنية", tray: "طبق", roll: "لفة", bundle: "حزمة",
};

/** «8 كغ»، «3 كرتونة ×12». */
export function lineQty(qty: string | number, unit: string, size?: string | number | null): string {
  const q = fmt.qty(qty);
  const u = UNIT[unit] ?? unit;
  const n = Number(size ?? 1);
  if (!n || n === 1) return `${q} ${u}`;
  return unit === "kg" || unit === "liter" ? `${q} × ${fmt.qty(size)} ${u}` : `${q} ${u} ×${fmt.qty(size)}`;
}

/** اليوم ← الوقت، أمس ← «أمس 21:10»، وإلا التاريخ والوقت. */
export function when(iso: string | null | undefined, withTime = true): string {
  if (!iso) return "";
  const d = new Date(iso);
  const day = (x: Date) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const diff = Math.round((day(new Date()) - day(d)) / 86400000);
  if (diff === 0) return fmt.time(iso);
  if (diff === 1) return withTime ? `أمس ${fmt.time(iso)}` : "أمس";
  return withTime ? `${fmt.date(iso)} ${fmt.time(iso)}` : fmt.date(iso);
}

export const MONTHS = ["يناير", "فبراير", "مارس", "أبريل", "مايو", "يونيو", "يوليو", "أغسطس", "سبتمبر", "أكتوبر", "نوفمبر", "ديسمبر"];

/** الشهر الحالي وخمسة قبله: {value: "2026-09", label: "سبتمبر"}. */
export function recentMonths(count = 6): Array<{ value: string; label: string }> {
  const now = new Date();
  return Array.from({ length: count }, (_, i) => {
    const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
    const value = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
    const name = MONTHS[d.getMonth()] ?? value;
    return { value, label: d.getFullYear() === now.getFullYear() ? name : `${name} ${d.getFullYear()}` };
  });
}
