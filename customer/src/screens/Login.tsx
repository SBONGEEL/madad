/** 00 الدخول (م-14، م-20): رقم الهاتف وكلمة المرور، ثم تغيير الكلمة المؤقتة إن أعطاها فريق مَدَد. الخطأ لا يكشف وجود الحساب. */
import { useState } from "react";
import { Link } from "react-router-dom";

import { ApiError } from "@ui/client";
import { phoneE164 } from "@ui/fmt";
import { Button, ErrorState, StatusBadge, TextField } from "@ui/kit";
import { api } from "@/api/client";
import type { LoginOut } from "@/api/types";
import { AuthPage, PHONE_HINT, StepHead, attemptsLeft } from "@/lib/acct-ui";

export function Login() {
  const [phone, setPhone] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<ApiError | null>(null);
  const [temp, setTemp] = useState<LoginOut | null>(null);   // دخل بكلمة مؤقتة (م-20)

  async function submit() {
    const p = phoneE164(phone);
    if (!p) return setErr(new ApiError(422, "phone_invalid"));
    setBusy(true);
    setErr(null);
    try {
      const t = await api.open<LoginOut>("POST", "/api/auth/customer/login", { phone: p, password });
      if (t.must_change_password) setTemp(t);
      else api.setTokens(t);
    } catch (e) {
      setErr(e as ApiError);
    } finally {
      setBusy(false);
    }
  }

  if (temp) return <ChangeTemp phone={phoneE164(phone) ?? ""} tokens={temp} onBack={() => { setTemp(null); setPassword(""); }} />;

  if (err?.code === "login_locked") {
    const mins = Math.ceil(Number(err.extra.retry_after_seconds ?? 900) / 60);
    return (
      <AuthPage>
        <div className="flex-1 flex flex-col justify-center">
          <ErrorState title="الدخول موقوف مؤقتاً"
            body={`محاولات خاطئة كثيرة لهذا الرقم على تطبيق العميل. حاول بعد ${mins} دقيقة. الحدّ لكل رقم في كل تطبيق على حدة.`}
            code="login_locked" onRetry={() => setErr(null)} retryLabel="رجوع" />
        </div>
      </AuthPage>
    );
  }

  const pwError = err?.code === "login_failed"
    ? `الرقم أو كلمة المرور غير صحيحة${err.extra.attempts_left != null ? attemptsLeft(err.extra.attempts_left) : ""}`
    : err && err.code !== "phone_invalid" ? err.message : null;
  return (
    <AuthPage>
      <form className="contents" onSubmit={(e) => { e.preventDefault(); void submit(); }}>
        <img src="/madad-logo-light.svg" alt="مدد MADAD" className="h-12 self-center" />
        <div className="flex flex-col gap-1.5">
          <h1 className="m-0 text-26 font-bold">إمداد أعمالك ببساطة</h1>
          <span className="text-15 text-ink-muted">ادخل برقم هاتفك وكلمة المرور.</span>
        </div>
        <TextField label="رقم الهاتف" value={phone} onChange={setPhone} numeric icon="phone" placeholder="091 234 5678" autoFocus
          disabled={busy} error={err?.code === "phone_invalid" ? PHONE_HINT : null} />
        <TextField label="كلمة المرور" value={password} onChange={setPassword} password disabled={busy} error={pwError} />
        <div className="mt-auto flex flex-col gap-3.5">
          <Button type="submit" block loading={busy} disabled={!phone || !password}>{busy ? "جاري الدخول" : "دخول"}</Button>
          <div className="flex justify-center text-14"><Link to="/recover" className="md-link">نسيت كلمة المرور؟</Link></div>
          <Link to="/register" className="md-link text-center text-15">منشأة جديدة؟ سجّل</Link>
        </div>
      </form>
    </AuthPage>
  );
}

/** بعد إعادة تعيين من فريق مَدَد (م-20): لا يُفتح التطبيق قبل تغيير الكلمة المؤقتة، ثم ندخل بالكلمة الجديدة. */
function ChangeTemp({ phone, tokens, onBack }: { phone: string; tokens: LoginOut; onBack: () => void }) {
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function save() {
    setBusy(true);
    setErr(null);
    try {
      await api.postAs<void>("/api/auth/password", { current_password: current, new_password: next }, tokens.access_token);
    } catch (e) {
      setBusy(false);
      return setErr((e as ApiError).code === "login_failed" ? "الكلمة المؤقتة غير صحيحة." : (e as Error).message);
    }
    try {
      // الكلمة تغيّرت: ندخل بها مباشرة
      const t = await api.open<LoginOut>("POST", "/api/auth/customer/login", { phone, password: next });
      api.setTokens(t);
    } catch {
      setBusy(false);
      onBack();
    }
  }

  return (
    <>
      <header className="md-backbar"><span className="md-backbar-title">تغيير كلمة المرور</span></header>
      <main className="flex-1 flex flex-col gap-5 p-4">
        <div><StatusBadge tone="warning" icon="shield-check">كلمة مؤقتة</StatusBadge></div>
        <StepHead title="ضع كلمتك قبل المتابعة" sub="دخلت بكلمة مؤقتة من فريق مَدَد. لا يُفتح التطبيق قبل تغييرها." />
        <TextField label="الكلمة المؤقتة" value={current} onChange={setCurrent} password disabled={busy} />
        <TextField label="كلمتك الجديدة" value={next} onChange={setNext} password hint="8 أحرف على الأقل" disabled={busy} error={err} />
        <div className="mt-auto flex flex-col gap-2">
          <Button block loading={busy} disabled={!current || next.length < 8 || next === current} onClick={() => void save()}>حفظ ومتابعة</Button>
          <Button variant="ghost" block disabled={busy} onClick={onBack}>رجوع إلى الدخول</Button>
        </div>
      </main>
    </>
  );
}
