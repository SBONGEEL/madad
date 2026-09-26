/** أجزاء مشتركة بين شاشات الحساب: صفحة الدخول بلا شريط، ورأس الخطوة، واختيار الأزرار المتجاورة، وتسميات الحالات. */
import type { ReactNode } from "react";

import { cx, type Tone } from "@ui/kit";

/** صفحة الدخول والتسجيل قبل الجلسة: عمود واحد، والأزرار في الأسفل (margin-top: auto). */
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

/** أزرار اختيار متجاورة (النوع، الدور) كما في اللوحات. */
export function Choice<V extends string>({ label, value, options, onChange, columns = 3 }: {
  label: string; value: V; options: Array<{ value: V; label: string }>; onChange: (v: V) => void; columns?: 2 | 3;
}) {
  return (
    <div className="flex flex-col gap-1.5">
      <span className="text-14 font-bold">{label}</span>
      <div role="radiogroup" aria-label={label} className={cx("grid gap-2", columns === 2 ? "grid-cols-2" : "grid-cols-3")}>
        {options.map((o) => {
          const on = o.value === value;
          return (
            <button key={o.value} type="button" role="radio" aria-checked={on} onClick={() => onChange(o.value)}
              className={cx("rounded-md py-3 px-2 text-14 text-ink cursor-pointer font-sans",
                on ? "border-2 border-primary bg-primary-tint font-bold" : "border border-border-strong bg-surface")}>
              {o.label}
            </button>
          );
        })}
      </div>
    </div>
  );
}

/** «بقيت 3 محاولات» بصيغة العدد العربية. */
export function attemptsLeft(n: unknown): string {
  const k = Number(n);
  if (!Number.isFinite(k)) return "";
  if (k <= 0) return " — كانت هذه المحاولة الأخيرة";
  if (k === 1) return " — بقيت محاولة واحدة";
  if (k === 2) return " — بقيت محاولتان";
  if (k <= 10) return ` — بقيت ${k} محاولات`;
  return ` — بقيت ${k} محاولة`;
}

export const CHANNEL: Record<string, string> = { whatsapp_official: "واتساب", whatsapp_linked: "واتساب", sms: "رسالة نصية", console: "وحدة التطوير" };

export const KIND: Record<string, string> = { restaurant: "مطعم", cafe: "مقهى", other: "منشأة" };

/** حالة المنشأة (party_status). */
export const CUSTOMER_STATUS: Record<string, [string, Tone]> = {
  approved: ["معتمدة", "success"], pending: ["بانتظار الاعتماد", "warning"], rejected: ["مرفوضة", "error"], suspended: ["موقوفة", "error"],
};

/** حالة الفرع. */
export const BRANCH_STATUS: Record<string, [string, Tone]> = {
  approved: ["معتمد", "success"], pending: ["بانتظار الاعتماد", "warning"], rejected: ["مرفوض", "error"], suspended: ["موقوف", "error"],
};

export const PHONE_HINT = "اكتب رقماً ليبياً صحيحاً، مثل 091 000 0001";
