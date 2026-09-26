/** 00ب استعادة كلمة المرور (م-20): الرقم ← الرمز ← كلمة جديدة، ثم الدخول مباشرة. */
import { useEffect, useState } from "react";
import { Link } from "react-router-dom";

import { ApiError } from "@ui/client";
import { phoneE164 } from "@ui/fmt";
import { Button, ErrorState, OtpInput, TextField } from "@ui/kit";
import { api } from "@/api/client";
import type { StartOut, TicketOut, TokensOut } from "@/api/types";
import { AuthCard, AuthFrame } from "@/screens/AuthFrame";

export function Recovery() {
  const [step, setStep] = useState<1 | 2 | 3>(1);
  const [phone, setPhone] = useState("");
  const [code, setCode] = useState("");
  const [ticket, setTicket] = useState("");
  const [pw, setPw] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<ApiError | null>(null);

  async function run(fn: () => Promise<void>) {
    setBusy(true);
    setErr(null);
    try { await fn(); } catch (e) { setErr(e as ApiError); } finally { setBusy(false); }
  }
  const start = () => run(async () => {
    const p = phoneE164(phone);
    if (!p) throw new ApiError(422, "phone_invalid");
    await api.open<StartOut>("POST", "/api/auth/admin/reset/start", { phone: p });
    setStep(2);
  });
  useEffect(() => {
    if (step !== 2 || code.length !== 6) return;
    void run(async () => {
      const t = await api.open<TicketOut>("POST", "/api/auth/admin/reset/verify", { phone: phoneE164(phone), code });
      setTicket(t.ticket);
      setStep(3);
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [code, step]);
  const complete = () => run(async () => {
    api.setTokens(await api.open<TokensOut>("POST", "/api/auth/admin/reset/complete", { ticket, password: pw }));
  });

  const back = <Link to="/" className="md-link text-13">رجوع إلى الدخول</Link>;
  if (err?.code === "not_registered" || err?.code === "otp_channel_unavailable") {
    return (
      <AuthFrame>
        <section className="md-auth-card">
          {err.code === "not_registered"
            ? <ErrorState compact title="الرقم غير مسجّل في اللوحة" body="تحقق من الرقم، أو اطلب من المالك إضافتك." code={err.code} onRetry={() => setErr(null)} retryLabel="تعديل الرقم" />
            : <ErrorState compact title="تعذّر إرسال الرمز" body="كل قنوات الإرسال غير متاحة الآن. أعد المحاولة بعد قليل." code={err.code} onRetry={() => setErr(null)} />}
        </section>
        {back}
      </AuthFrame>
    );
  }
  const msg = err ? (err.code === "phone_invalid" ? "اكتب رقماً ليبياً صحيحاً، مثل 091 000 0001" : err.message) : null;
  return (
    <AuthFrame>
      {step === 1 ? (
        <AuthCard step="استعادة · 1 من 3" title="نسيت كلمة المرور" sub="نرسل رمزاً إلى رقمك عبر واتساب، وإن تعذّر فرسالة نصية.">
          <TextField label="رقم الهاتف" value={phone} onChange={setPhone} numeric icon="phone" placeholder="091 000 0001" autoFocus error={msg} />
          <Button block icon="send" loading={busy} disabled={!phone} onClick={start}>{busy ? "جاري الإرسال" : "أرسل الرمز"}</Button>
        </AuthCard>
      ) : step === 2 ? (
        <AuthCard step="استعادة · 2 من 3" title="أدخل الرمز">
          <OtpInput value={code} onChange={setCode} error={msg} />
          <span className="text-13 text-ink-muted">لم يصل على واتساب؟ نرسله برسالة نصية تلقائياً.</span>
        </AuthCard>
      ) : (
        <AuthCard step="استعادة · 3 من 3" title="كلمة مرور جديدة">
          <TextField label="كلمة المرور الجديدة" value={pw} onChange={setPw} password hint="8 أحرف على الأقل" error={msg} />
          <Button block loading={busy} disabled={pw.length < 8} onClick={complete}>حفظ والدخول</Button>
          <span className="text-13 text-ink-muted">تُغلق كل جلساتك الأخرى.</span>
        </AuthCard>
      )}
      {back}
    </AuthFrame>
  );
}
