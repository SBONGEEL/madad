/** 00 الدخول (م-14، م-20): الدخول، وتفعيل حساب المشرف المدعو (رمز مرة واحدة ثم كلمة مرور)، وتغيير الكلمة المؤقتة. */
import { useEffect, useState } from "react";
import { Link } from "react-router-dom";

import { ApiError } from "@ui/client";
import { phoneE164 } from "@ui/fmt";
import { Button, ErrorState, OtpInput, Tabs, TextField } from "@ui/kit";
import { api } from "@/api/client";
import type { LoginOut, StartOut, TicketOut, TokensOut } from "@/api/types";
import { AuthCard, AuthFrame } from "@/screens/AuthFrame";

const CHANNEL: Record<string, string> = { whatsapp_official: "واتساب", whatsapp_linked: "واتساب", sms: "رسالة نصية", console: "وحدة التطوير" };

export function Login() {
  const [mode, setMode] = useState<"login" | "activate">("login");
  const [pending, setPending] = useState<LoginOut | null>(null);   // دخل بكلمة مؤقتة (م-20)
  return (
    <AuthFrame>
      {pending ? <ChangeTemp tokens={pending} onDone={() => setPending(null)} /> : (
        <>
          <div className="w-full max-w-login"><Tabs value={mode} onChange={setMode} tabs={[{ value: "login", label: "الدخول" }, { value: "activate", label: "تفعيل حساب مشرف" }]} /></div>
          {mode === "login" ? <SignIn onTemp={setPending} /> : <Activate />}
        </>
      )}
    </AuthFrame>
  );
}

function SignIn({ onTemp }: { onTemp: (t: LoginOut) => void }) {
  const [phone, setPhone] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<ApiError | null>(null);

  async function submit() {
    const p = phoneE164(phone);
    if (!p) return setErr(new ApiError(422, "phone_invalid"));
    setBusy(true);
    setErr(null);
    try {
      const t = await api.open<LoginOut>("POST", "/api/auth/admin/login", { phone: p, password });
      if (t.must_change_password) onTemp(t);
      else api.setTokens(t);
    } catch (e) {
      setErr(e as ApiError);
    } finally {
      setBusy(false);
    }
  }

  if (err?.code === "login_locked") {
    const mins = Math.ceil(Number(err.extra.retry_after_seconds ?? 900) / 60);
    return (
      <section className="md-auth-card">
        <ErrorState compact title="الدخول موقوف مؤقتاً" body={`محاولات خاطئة كثيرة لهذا الرقم على اللوحة. حاول بعد ${mins} دقيقة.`} code="login_locked" onRetry={() => setErr(null)} retryLabel="رجوع" />
      </section>
    );
  }
  const pwError = err?.code === "login_failed"
    ? `الرقم أو كلمة المرور غير صحيحة${err.extra.attempts_left != null ? ` — بقيت ${err.extra.attempts_left} محاولات` : ""}`
    : err && err.code !== "phone_invalid" ? err.message : null;
  return (
    <form className="contents" onSubmit={(e) => { e.preventDefault(); void submit(); }}>
      <AuthCard step="الدخول" title="دخول اللوحة">
        <TextField label="رقم الهاتف" value={phone} onChange={setPhone} numeric icon="phone" placeholder="091 000 0001" autoFocus
          error={err?.code === "phone_invalid" ? "اكتب رقماً ليبياً صحيحاً، مثل 091 000 0001" : null} />
        <TextField label="كلمة المرور" value={password} onChange={setPassword} password error={pwError} />
        <Button type="submit" block loading={busy} disabled={!phone || !password}>{busy ? "جاري الدخول" : "دخول"}</Button>
        <div className="flex justify-between items-center text-13">
          <Link to="/recover" className="md-link">نسيت كلمة المرور؟</Link>
          <span className="text-ink-muted">رمز جديد عبر واتساب</span>
        </div>
      </AuthCard>
    </form>
  );
}

/** المشرف يضيفه المالك برقمه؛ ثم يفعّل حسابه هنا: رمز مرة واحدة، ثم كلمة مرور. */
function Activate() {
  const [step, setStep] = useState<1 | 2 | 3>(1);
  const [phone, setPhone] = useState("");
  const [sent, setSent] = useState<StartOut | null>(null);
  const [code, setCode] = useState("");
  const [ticket, setTicket] = useState("");
  const [pw, setPw] = useState("");
  const [pw2, setPw2] = useState("");
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
    setSent(await api.open<StartOut>("POST", "/api/auth/admin/register/start", { phone: p }));
    setStep(2);
  });
  useEffect(() => {
    if (step !== 2 || code.length !== 6) return;
    void run(async () => {
      const t = await api.open<TicketOut>("POST", "/api/auth/admin/register/verify", { phone: phoneE164(phone), code });
      setTicket(t.ticket);
      setStep(3);
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [code, step]);
  const complete = () => run(async () => {
    // الاسم مسجَّل عند الدعوة؛ الخادم لا يغيّره لحساب قائم
    api.setTokens(await api.open<TokensOut>("POST", "/api/auth/admin/register/complete", { ticket, password: pw, full_name: "—" }));
  });

  const msg = err ? (err.code === "phone_invalid" ? "اكتب رقماً ليبياً صحيحاً، مثل 091 000 0001" : err.message) : null;
  if (step === 1) {
    return (
      <AuthCard step="تفعيل الحساب · 1 من 2 (مرة واحدة)" title="تأكيد رقمك" sub="أضافك المالك مشرفاً؟ اكتب رقمك ونرسل لك رمزاً.">
        <TextField label="رقم الهاتف" value={phone} onChange={setPhone} numeric icon="phone" placeholder="091 000 0001" error={msg} />
        <Button block icon="send" loading={busy} disabled={!phone} onClick={start}>{busy ? "جاري الإرسال" : "أرسل الرمز"}</Button>
      </AuthCard>
    );
  }
  if (step === 2) {
    return (
      <AuthCard step="تفعيل الحساب · 1 من 2 (مرة واحدة)" title="تأكيد رقمك"
        sub={<>أرسلنا رمزاً عبر <b>{CHANNEL[sent?.channel ?? ""] ?? "واتساب"}</b> إلى <bdi className="md-num" dir="ltr">{phoneE164(phone)}</bdi>.</>}>
        <OtpInput value={code} onChange={setCode} error={msg} />
        <span className="text-13 text-ink-muted">لم يصل خلال دقيقة؟ نرسله برسالة نصية تلقائياً.</span>
        <Button variant="ghost" block onClick={() => { setStep(1); setCode(""); }}>تغيير الرقم</Button>
      </AuthCard>
    );
  }
  const mismatch = pw2 && pw !== pw2 ? "الكلمتان غير متطابقتين" : null;
  return (
    <AuthCard step="تفعيل الحساب · 2 من 2" title="ضع كلمة مرور">
      <TextField label="كلمة المرور" value={pw} onChange={setPw} password hint="8 أحرف على الأقل" error={msg} />
      <TextField label="تأكيد كلمة المرور" value={pw2} onChange={setPw2} password error={mismatch} />
      <Button block loading={busy} disabled={pw.length < 8 || pw !== pw2} onClick={complete}>حفظ والدخول</Button>
    </AuthCard>
  );
}

/** بعد إعادة تعيين من المالك (م-20): لا تُفتح اللوحة قبل تغيير الكلمة المؤقتة. */
export function ChangeTemp({ tokens, onDone }: { tokens: LoginOut; onDone: () => void }) {
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  async function save() {
    setBusy(true);
    setErr(null);
    try {
      await api.postAs<void>("/api/auth/password", { current_password: current, new_password: next }, tokens.access_token);
      onDone();   // الجلسات كلها أُغلقت بالتغيير: يدخل بكلمته الجديدة
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <AuthCard step="بعد إعادة تعيين من المالك" title="ضع كلمتك قبل المتابعة" sub="دخلت بكلمة مؤقتة أعطاك إياها المالك. لا تُفتح اللوحة قبل تغييرها.">
      <TextField label="الكلمة المؤقتة" value={current} onChange={setCurrent} password />
      <TextField label="كلمتك الجديدة" value={next} onChange={setNext} password hint="8 أحرف على الأقل" error={err} />
      <Button block loading={busy} disabled={!current || next.length < 8} onClick={save}>حفظ ومتابعة</Button>
    </AuthCard>
  );
}
