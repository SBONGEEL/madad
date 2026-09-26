/** أجزاء مشتركة بين شاشات الحساب والاستلام والمستحقات: صفحة الدخول بلا شريط، ورأس الخطوة، وتسميات الحالات والدورية. */
import type { ReactNode } from "react";

import { qty as fmtQty } from "@ui/fmt";
import type { Tone } from "@ui/kit";

/** صفحة الدخول قبل الجلسة: عمود واحد، والأزرار في الأسفل (margin-top: auto). */
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

export const PHONE_HINT = "اكتب رقماً ليبياً صحيحاً، مثل 092 455 1180";

/** دورية صرف المستحقات (suppliers.payout_cycle). */
export const CYCLE: Record<string, string> = { daily: "يومي", weekly: "أسبوعي", semimonthly: "نصف شهري", monthly: "شهري" };

/** حالة المورد (party_status). */
export const SUPPLIER_STATUS: Record<string, [string, Tone]> = {
  approved: ["معتمد", "primary"], pending: ["بانتظار الاعتماد", "warning"], suspended: ["موقوف", "error"], rejected: ["مرفوض", "error"],
};

/** مهلة إعادة إرسال الرمز في الخادم (RESEND_SECONDS). */
export const RESEND = 60;

export function countdown(s: number): string {
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

export const UNIT: Record<string, string> = {
  kg: "كغ", liter: "لتر", piece: "حبة", carton: "كرتونة", pack: "علبة", bag: "كيس",
  box: "صندوق", bottle: "قارورة", can: "علبة معدنية", tray: "طبق", roll: "لفة", bundle: "حزمة",
};

/** «15 كغ»، «3 كرتونة ×12»، «2 × 5 كغ». */
export function lineQty(qty: string | number, unit: string, size?: string | number | null): string {
  const q = fmtQty(qty);
  const u = UNIT[unit] ?? unit;
  const n = Number(size ?? 1);
  if (!n || n === 1) return `${q} ${u}`;
  return unit === "kg" || unit === "liter" ? `${q} × ${fmtQty(size)} ${u}` : `${q} ${u} ×${fmtQty(size)}`;
}
