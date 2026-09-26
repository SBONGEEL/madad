/**
 * 00ب التسجيل (M-14): الرقم ← رمز مرة واحدة ← كلمة مرور ← بيانات السائق والمستندات ← «نراجع أوراقك».
 * بعد الخطوة 3 تُحفظ الجلسة فيعرض App هذه الشاشة نفسها بـ establishmentOnly (الخطوة 4 وحدها) حتى يُسجَّل السائق.
 * المستندات الأربع إلزامية (الهوية، الرخصة بوجهيها، الصورة الشخصية) وتبقى عند مَدَد وحده.
 */
import { useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";

import { ApiError } from "@ui/client";
import { phoneE164 } from "@ui/fmt";
import { Button, ErrorState, Icon, LoadingState, Note, OtpInput, StatusBadge, TextField, cx } from "@ui/kit";
import type { IconName } from "@ui/icons";
import { api } from "@/api/client";
import type { DriverOut, StartOut, TicketOut, TokensOut } from "@/api/types";
import { type RegPurpose, accError, uploadMedia } from "@/lib/acc-http";
import { CHANNEL, PHONE_HINT, RESEND, StepHead, VEHICLES, attemptsLeft, countdown } from "@/lib/acc-ui";
import { Screen } from "@/lib/shell";

const TITLE = "تسجيل سائق";

export function Register({ establishmentOnly, onDone }: { establishmentOnly?: boolean; onDone?: () => void }) {
  if (establishmentOnly) return <DriverData onDone={onDone} />;
  return <Signup />;
}

/** الخطوات 1–3: رقم الهاتف، الرمز، كلمة المرور. حفظ الرمز ينقل App إلى الخطوة 4. */
function Signup() {
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
    setSent(await api.open<StartOut>("POST", "/api/auth/driver/register/start", { phone: p }));
    setCode("");
    setWait(RESEND);
    setStep(2);
  });
  const verify = () => run(async () => {
    const t = await api.open<TicketOut>("POST", "/api/auth/driver/register/verify", { phone: phoneE164(phone), code });
    setTicket(t.ticket);
    setStep(3);
  });
  useEffect(() => {
    if (step === 2 && code.length === 6 && !busy) void verify();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [code, step]);
  // الاسم الحقيقي يأتي في الخطوة 4 ويُحدَّث به الحساب في الخادم
  const complete = () => run(async () => {
    api.setTokens(await api.open<TokensOut>("POST", "/api/auth/driver/register/complete", { ticket, password: pw, full_name: "—" }));
  });

  const msg = !err ? null
    : err.code === "phone_invalid" ? PHONE_HINT
    : err.code === "otp_invalid" ? `الرمز غير صحيح${attemptsLeft(err.extra.attempts_left)}`
    : err.code === "otp_already_used" || err.code === "ticket_invalid" ? "انتهت صلاحية التأكيد. ابدأ من رقم الهاتف من جديد."
    : err.message;

  if (step === 1) {
    return (
      <Screen title={TITLE} back="/">
        <StepHead step="الخطوة 1 من 4 · رقم الهاتف" title="رقم هاتف السائق" sub="نرسل رمز تأكيد مرة واحدة فقط، عبر واتساب." />
        <TextField label="رقم الهاتف" value={phone} onChange={setPhone} numeric icon="phone" placeholder="091 555 0142" autoFocus disabled={busy}
          error={err?.code === "already_registered" ? "هذا الرقم مسجَّل من قبل." : err?.code === "otp_channel_unavailable" ? null : msg} />
        {err?.code === "already_registered" ? (
          <Note tone="info">رقم مسجّل من قبل؟ لا رمز جديد: <Link to="/" className="md-link">ادخل برقمك وكلمة المرور</Link>.</Note>
        ) : null}
        {err?.code === "otp_channel_unavailable" ? <Note tone="error">قنوات الإرسال غير متاحة الآن. أعد المحاولة بعد قليل.</Note> : null}
        <div className="mt-auto flex flex-col gap-3">
          <Button block icon="send" loading={busy} disabled={!phone} onClick={() => void start()}>{busy ? "جاري الإرسال" : "أرسل الرمز عبر واتساب"}</Button>
          <Link to="/" className="md-link text-center text-14">لديك حساب؟ ادخل</Link>
        </div>
      </Screen>
    );
  }
  if (step === 2) {
    return (
      <Screen title={TITLE} back="/">
        <StepHead step="الخطوة 2 من 4 · رمز التأكيد" title="أدخل الرمز"
          sub={<>أرسلناه عبر <b>{CHANNEL[sent?.channel ?? ""] ?? "واتساب"}</b> إلى <bdi className="md-num" dir="ltr">{phoneE164(phone)}</bdi> — صالح <bdi className="md-num">{Math.round((sent?.expires_in ?? 300) / 60)}</bdi> دقائق.</>} />
        <OtpInput value={code} onChange={setCode} error={msg} />
        <div className="rounded-md border border-border bg-surface p-3 text-14 flex items-start gap-2">
          <Icon name="phone" />
          {wait > 0
            ? <span>لم يصل على واتساب؟ نرسله برسالة نصية SMS بعد <bdi className="md-num" dir="ltr">{countdown(wait)}</bdi>.</span>
            : <span className="flex-1 flex justify-between gap-2">لم يصل؟<button type="button" className="md-link" disabled={busy} onClick={() => void start()}>أعد الإرسال</button></span>}
        </div>
        <div className="mt-auto flex flex-col gap-2">
          <Button block loading={busy} disabled={code.length !== 6} onClick={() => void verify()}>تأكيد</Button>
          <Button variant="ghost" block disabled={busy} onClick={() => { setStep(1); setCode(""); setErr(null); }}>تغيير الرقم</Button>
        </div>
      </Screen>
    );
  }
  return (
    <Screen title={TITLE} back="/">
      <StepHead step="الخطوة 3 من 4 · كلمة المرور" />
      <div><StatusBadge tone="success" icon="check">تأكّد رقمك</StatusBadge></div>
      <StepHead title="ضع كلمة مرور" sub="من الآن تدخل دائماً برقمك وكلمة المرور — لا رموز بعد اليوم." />
      <TextField label="كلمة المرور" value={pw} onChange={setPw} password hint="8 أحرف على الأقل" disabled={busy} error={msg} />
      <TextField label="تأكيد كلمة المرور" value={pw2} onChange={setPw2} password disabled={busy} error={pw2 && pw !== pw2 ? "الكلمتان غير متطابقتين" : null} />
      <div className="mt-auto flex flex-col gap-2">
        <Button block loading={busy} disabled={pw.length < 8 || pw !== pw2} onClick={() => void complete()}>متابعة</Button>
        {err?.code === "otp_already_used" || err?.code === "ticket_invalid"
          ? <Button variant="ghost" block onClick={() => { setStep(1); setErr(null); }}>من البداية</Button> : null}
      </div>
    </Screen>
  );
}

interface Doc { purpose: RegPurpose; label: string; icon: IconName; accept: string; capture: "environment" | "user"; missing: [string, string, string]; uploading: string }

const IMG = "image/jpeg,image/png,image/webp";
const DOCS: Doc[] = [
  { purpose: "driver_id", label: "الهوية", icon: "camera", accept: `${IMG},application/pdf`, capture: "environment", uploading: "جاري رفع الهوية",
    missing: ["الهوية مطلوبة", "صوّر بطاقة هويتك. الهوية والرخصة والصورة الشخصية إلزامية.", "تصوير الهوية"] },
  { purpose: "driver_license", label: "الرخصة (الوجه)", icon: "camera", accept: `${IMG},application/pdf`, capture: "environment", uploading: "جاري رفع الرخصة",
    missing: ["الرخصة مطلوبة", "صوّر رخصة القيادة من الوجهين. الهوية والرخصة والصورة الشخصية إلزامية.", "تصوير الرخصة"] },
  { purpose: "driver_license_back", label: "الرخصة (الظهر)", icon: "camera", accept: `${IMG},application/pdf`, capture: "environment", uploading: "جاري رفع ظهر الرخصة",
    missing: ["الرخصة مطلوبة", "صوّر رخصة القيادة من الوجهين. الهوية والرخصة والصورة الشخصية إلزامية.", "تصوير ظهر الرخصة"] },
  { purpose: "driver_photo", label: "صورتك", icon: "camera", accept: IMG, capture: "user", uploading: "جاري رفع صورتك",
    missing: ["الصورة الشخصية مطلوبة", "التقط صورة واضحة لوجهك. الهوية والرخصة والصورة الشخصية إلزامية.", "التقاط صورتك"] },
];

/** السعة التقريبية: رقم موجب بمنزلة عشرية واحدة على الأكثر. */
const capValid = (s: string) => s.trim() === "" || (/^\d+(\.\d)?$/.test(s.trim()) && Number(s) > 0);

/** الخطوة 4: الاسم والمركبة وسعتها والمستندات الأربع، ثم «نراجع أوراقك». */
function DriverData({ onDone }: { onDone?: () => void }) {
  const [name, setName] = useState("");
  const [vehicle, setVehicle] = useState("");
  const [capacity, setCapacity] = useState("");
  const [files, setFiles] = useState<Partial<Record<RegPurpose, File>>>({});
  const [phase, setPhase] = useState<string | null>(null);
  const [tried, setTried] = useState(false);
  const [missingDoc, setMissingDoc] = useState<Doc | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [done, setDone] = useState<DriverOut | null>(null);
  const refs = useRef<Partial<Record<RegPurpose, HTMLInputElement | null>>>({});

  const pick = (p: RegPurpose) => refs.current[p]?.click();

  async function submit() {
    setTried(true);
    setErr(null);
    if (!name.trim() || !vehicle || !capValid(capacity)) return;
    const lacking = DOCS.find((d) => !files[d.purpose]);
    if (lacking) return setMissingDoc(lacking);
    try {
      const ids: Partial<Record<RegPurpose, number>> = {};
      for (const d of DOCS) {
        const f = files[d.purpose];
        if (!f) continue;
        setPhase(d.uploading);
        ids[d.purpose] = await uploadMedia(f, d.purpose);
      }
      setPhase("جاري الإرسال");
      const out = await api.post<DriverOut>(`/api/driver/registration`, {
        full_name: name.trim(), vehicle, capacity_kg: capacity.trim() ? capacity.trim() : null,
        id_media_id: ids.driver_id, license_media_id: ids.driver_license,
        license_back_media_id: ids.driver_license_back, photo_media_id: ids.driver_photo,
      });
      setDone(out);
    } catch (e) {
      setErr(accError(e));
      if ((e as ApiError).code === "driver_exists") onDone?.();
    } finally {
      setPhase(null);
    }
  }

  const inputs = DOCS.map((d) => (
    <input key={d.purpose} ref={(el) => { refs.current[d.purpose] = el; }} type="file" accept={d.accept} capture={d.capture} className="sr-only"
      onChange={(e) => {
        const f = e.target.files?.[0];
        e.target.value = "";
        if (!f) return;
        setFiles((xs) => ({ ...xs, [d.purpose]: f }));
        setMissingDoc(null);
      }} />
  ));

  if (done) {
    return (
      <main className="flex-1 flex flex-col items-center text-center gap-3.5 px-6 pt-12 pb-8">
        <span className="rounded-full bg-secondary-tint text-primary-text grid place-items-center p-5"><Icon name="clock" size={36} /></span>
        <h1 className="m-0 text-22 font-bold">نراجع أوراقك</h1>
        <span className="text-16 text-ink-muted">الهوية والرخصة والصورة وصلت. نبلغك حين تُعتمد، ومعها طريقة صرف أجرك التي يحددها مَدَد.</span>
        <div className="mt-auto w-full"><Button block size="lg" onClick={() => onDone?.()}>متابعة</Button></div>
      </main>
    );
  }

  const logout = <button type="button" className="md-link text-14" onClick={() => void api.logout()}>خروج</button>;

  if (phase) {
    return (
      <Screen title={TITLE} back="/" action={logout}>
        <LoadingState rows={4} />
        <div className="mt-auto"><Button block size="lg" loading>{phase}</Button></div>
      </Screen>
    );
  }

  if (missingDoc) {
    const [title, body, retry] = missingDoc.missing;
    return (
      <Screen title={TITLE} back="/" action={logout}>
        <div className="flex-1 flex flex-col justify-center gap-3">
          <ErrorState title={title} body={body} code="document_missing" retryLabel={retry} onRetry={() => pick(missingDoc.purpose)} />
          <Button variant="ghost" block onClick={() => setMissingDoc(null)}>رجوع إلى البيانات</Button>
        </div>
        {inputs}
      </Screen>
    );
  }

  return (
    <Screen title={TITLE} back="/" action={logout}>
      <div className="flex flex-col gap-3">
        <StepHead step="الخطوة 4 من 4 · بيانات السائق والمستندات" />
        {err ? <Note tone="error">{err}</Note> : null}
        <TextField label="الاسم" value={name} onChange={setName} required error={tried && !name.trim() ? "حقل مطلوب" : null} />
        <div className="flex flex-col gap-1.5" role="radiogroup" aria-label="نوع المركبة">
          <span className="text-14 font-medium">نوع المركبة <span className="text-error-text">*</span></span>
          <div className="grid grid-cols-3 gap-1.5">
            {VEHICLES.map((v) => (
              <button key={v.value} type="button" role="radio" aria-checked={vehicle === v.value} onClick={() => setVehicle(v.value)}
                className={cx("rounded-md py-3 px-1 font-sans text-14 text-ink cursor-pointer",
                  vehicle === v.value ? "border-2 border-secondary bg-secondary-tint font-bold" : "border border-border-strong bg-transparent font-medium")}>
                {v.label}
              </button>
            ))}
          </div>
          {tried && !vehicle ? <span className="text-13 text-error-text" role="alert">اختر نوع المركبة</span> : null}
        </div>
        <TextField label="السعة التقريبية" value={capacity} onChange={setCapacity} numeric suffix="كغ" hint="لتقدير ما تحمله في الطلبية الواحدة"
          error={!capValid(capacity) ? "اكتب رقماً موجباً، مثل 800" : null} />
        <div className="grid grid-cols-2 gap-2">
          {DOCS.map((d) => {
            const f = files[d.purpose];
            return (
              <button key={d.purpose} type="button" onClick={() => pick(d.purpose)}
                className={cx("rounded-md text-ink font-sans text-13 py-4 px-2 flex flex-col items-center justify-center gap-1.5 cursor-pointer",
                  f ? "border border-success bg-success-tint" : tried ? "border-2 border-dashed border-error bg-transparent" : "border border-dashed border-border-strong bg-transparent")}>
                <Icon name={f ? "circle-check" : d.icon} />
                <span>{d.label}</span>
                {f ? <span className="text-12 text-ink-muted max-w-full truncate">{f.name} · تغيير</span> : null}
              </button>
            );
          })}
        </div>
        {inputs}
        <span className="text-13 text-ink-muted">تبقى الهوية والرخصة وصورتك عند مَدَد وحده، ولا يراها أي طرف آخر.</span>
      </div>
      <div className="mt-auto">
        <Button block size="lg" onClick={() => void submit()}>إرسال للاعتماد</Button>
      </div>
    </Screen>
  );
}
