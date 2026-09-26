/** 00ج استعادة كلمة المرور (م-20): الرقم ← الرمز ← كلمة جديدة، ثم الدخول مباشرة. */
import { useEffect, useState } from "react";
import { Link } from "react-router-dom";

import { ApiError } from "@ui/client";
import { phoneE164 } from "@ui/fmt";
import { Button, ErrorState, OtpInput, TextField } from "@ui/kit";
import { api } from "@/api/client";
import type { StartOut, TicketOut, TokensOut } from "@/api/types";
import { CHANNEL, PHONE_HINT, StepHead, attemptsLeft } from "@/lib/acct-ui";
import { Screen } from "@/lib/shell";

/** مهلة إعادة الإرسال في الخادم (RESEND_SECONDS). */
const RESEND = 60;

export function Recovery() {
  const [step, setStep] = useState<1 | 2 | 3>(1);
  const [phone, setPhone] = useState("");
  const [sent, setSent] = useState<StartOut | null>(null);
  const [code, setCode] = useState("");
  const [ticket, setTicket] = useState("");
  const [pw, setPw] = useState("");
  const [pw2, setPw2] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<ApiError | null>(null);
  const [wait, setWait] = useState(0);

  useEffect(() => {
    if (wait <= 0) return;
    const t = setTimeout(() => setWait((w) => w - 1), 1000);
    return () => clearTimeout(t);
  }, [wait]);

  async function run(fn: () => Promise<void>) {
    setBusy(true);
    setErr(null);
    try { await fn(); } catch (e) { setErr(e as ApiError); } finally { setBusy(false); }
  }
  const start = () => run(async () => {
    const p = phoneE164(phone);
    if (!p) throw new ApiError(422, "phone_invalid");
    setSent(await api.open<StartOut>("POST", "/api/auth/customer/reset/start", { phone: p }));
    setCode("");
    setWait(RESEND);
    setStep(2);
  });
  const verify = () => run(async () => {
    const t = await api.open<TicketOut>("POST", "/api/auth/customer/reset/verify", { phone: phoneE164(phone), code });
    setTicket(t.ticket);
    setStep(3);
  });
  useEffect(() => {
    if (step === 2 && code.length === 6 && !busy) void verify();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [code, step]);
  const complete = () => run(async () => {
    api.setTokens(await api.open<TokensOut>("POST", "/api/auth/customer/reset/complete", { ticket, password: pw }));
  });

  if (err?.code === "not_registered" || err?.code === "otp_channel_unavailable" || err?.code === "login_locked") {
    return (
      <Screen title="استعادة كلمة المرور" back="/">
        <div className="flex-1 flex flex-col justify-center gap-4">
          {err.code === "not_registered"
            ? <ErrorState title="الرقم غير مسجّل" body="لا حساب بهذا الرقم. سجّل حساباً جديداً." code={err.code} onRetry={() => setErr(null)} retryLabel="تعديل الرقم" />
            : err.code === "login_locked"
              ? <ErrorState title="موقوف مؤقتاً" body={`محاولات خاطئة كثيرة لهذا الرقم. حاول بعد ${Math.ceil(Number(err.extra.retry_after_seconds ?? 900) / 60)} دقيقة.`} code={err.code} onRetry={() => { setErr(null); setStep(1); }} retryLabel="رجوع" />
              : <ErrorState title="تعذّر إرسال الرمز" body="قنوات الإرسال غير متاحة الآن. أعد المحاولة بعد قليل." code={err.code} onRetry={() => setErr(null)} />}
          {err.code === "not_registered" ? <Link to="/register" className="md-link text-center">منشأة جديدة؟ سجّل</Link> : null}
        </div>
      </Screen>
    );
  }

  const msg = !err ? null
    : err.code === "phone_invalid" ? PHONE_HINT
    : err.code === "otp_invalid" ? `الرمز غير صحيح${attemptsLeft(err.extra.attempts_left)}`
    : err.message;
  return (
    <Screen title="استعادة كلمة المرور" back="/">
      {step === 1 ? (
        <>
          <StepHead title="نسيت كلمة المرور" sub="نرسل رمزاً إلى رقمك عبر واتساب، وإن تعذّر فرسالة نصية." />
          <TextField label="رقم الهاتف" value={phone} onChange={setPhone} numeric icon="phone" placeholder="091 234 5678" autoFocus disabled={busy} error={msg} />
          <div className="mt-auto"><Button block icon="send" loading={busy} disabled={!phone} onClick={() => void start()}>{busy ? "جاري الإرسال" : "أرسل الرمز"}</Button></div>
        </>
      ) : step === 2 ? (
        <>
          <StepHead title="أدخل الرمز" sub={<>أرسلناه عبر <b>{CHANNEL[sent?.channel ?? ""] ?? "واتساب"}</b> إلى <bdi className="md-num" dir="ltr">{phoneE164(phone)}</bdi> — صالح <bdi className="md-num">{Math.round((sent?.expires_in ?? 300) / 60)}</bdi> دقائق.</>} />
          <OtpInput value={code} onChange={setCode} error={msg} />
          <div className="rounded-md border border-border bg-surface p-3 text-14 flex items-center justify-between gap-2">
            {wait > 0
              ? <span>لم يصل؟ تستطيع طلب رمز جديد بعد <bdi className="md-num" dir="ltr">0:{String(wait).padStart(2, "0")}</bdi>.</span>
              : <><span>لم يصل؟</span><button type="button" className="md-link" disabled={busy} onClick={() => void start()}>أعد الإرسال</button></>}
          </div>
          <div className="mt-auto flex flex-col gap-2">
            <Button block loading={busy} disabled={code.length !== 6} onClick={() => void verify()}>تأكيد</Button>
            <Button variant="ghost" block disabled={busy} onClick={() => { setStep(1); setCode(""); setErr(null); }}>تغيير الرقم</Button>
          </div>
        </>
      ) : (
        <>
          <StepHead title="ضع كلمة مرور جديدة" />
          <TextField label="كلمة المرور الجديدة" value={pw} onChange={setPw} password hint="8 أحرف على الأقل" disabled={busy} error={msg} />
          <TextField label="تأكيدها" value={pw2} onChange={setPw2} password disabled={busy} error={pw2 && pw !== pw2 ? "الكلمتان غير متطابقتين" : null} />
          <span className="text-13 text-ink-muted">تُغلق جلساتك على الأجهزة الأخرى.</span>
          <div className="mt-auto"><Button block loading={busy} disabled={pw.length < 8 || pw !== pw2} onClick={() => void complete()}>حفظ والدخول</Button></div>
        </>
      )}
    </Screen>
  );
}
