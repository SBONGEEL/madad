/**
 * 00ب التسجيل (م-14): الرقم ← رمز مرة واحدة ← كلمة مرور ← بيانات المنشأة ← بانتظار الاعتماد.
 * بعد الخطوة 3 تُحفظ الجلسة فيعرض App هذه الشاشة نفسها بـ establishmentOnly (الخطوة 4 وحدها) حتى تُسجَّل المنشأة.
 */
import { useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";

import { ApiError } from "@ui/client";
import { phoneE164 } from "@ui/fmt";
import { Button, Icon, LoadingState, Note, OtpInput, Select, StatusBadge, TextField, cx, useLoad } from "@ui/kit";
import { api } from "@/api/client";
import type { CustomerOut, StartOut, TicketOut, TokensOut, ZoneOut } from "@/api/types";
import { acctError, uploadMedia } from "@/lib/acct-http";
import { LocationPicker, type Pin, pinValid } from "@/lib/acct-map";
import { CHANNEL, Choice, PHONE_HINT, StepHead, attemptsLeft } from "@/lib/acct-ui";
import { Screen } from "@/lib/shell";

const RESEND = 60;

export function Register({ establishmentOnly, onDone }: { establishmentOnly?: boolean; onDone?: () => void }) {
  if (establishmentOnly) return <Establishment onDone={onDone} />;
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
    setSent(await api.open<StartOut>("POST", "/api/auth/customer/register/start", { phone: p }));
    setCode("");
    setWait(RESEND);
    setStep(2);
  });
  const verify = () => run(async () => {
    const t = await api.open<TicketOut>("POST", "/api/auth/customer/register/verify", { phone: phoneE164(phone), code });
    setTicket(t.ticket);
    setStep(3);
  });
  useEffect(() => {
    if (step === 2 && code.length === 6 && !busy) void verify();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [code, step]);
  // الاسم الحقيقي يأتي في الخطوة 4 (اسم المسؤول) ويُحدَّث به الحساب
  const complete = () => run(async () => {
    api.setTokens(await api.open<TokensOut>("POST", "/api/auth/customer/register/complete", { ticket, password: pw, full_name: "—" }));
  });

  const msg = !err ? null
    : err.code === "phone_invalid" ? PHONE_HINT
    : err.code === "otp_invalid" ? `الرمز غير صحيح${attemptsLeft(err.extra.attempts_left)}`
    : err.code === "otp_already_used" || err.code === "ticket_invalid" ? "انتهت صلاحية التأكيد. ابدأ من رقم الهاتف من جديد."
    : err.message;

  if (step === 1) {
    return (
      <Screen title="تسجيل منشأة" back="/">
        <StepHead step="الخطوة 1 من 4 · رقم الهاتف" title="رقم هاتف المنشأة" sub="نرسل رمز تأكيد مرة واحدة فقط، عبر واتساب." />
        <TextField label="رقم الهاتف" value={phone} onChange={setPhone} numeric icon="phone" placeholder="091 234 5678" autoFocus disabled={busy}
          error={err?.code === "already_registered" ? "هذا الرقم مسجَّل من قبل." : msg} />
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
      <Screen title="تسجيل منشأة" back="/">
        <StepHead step="الخطوة 2 من 4 · رمز التأكيد" title="أدخل الرمز"
          sub={<>أرسلناه عبر <b>{CHANNEL[sent?.channel ?? ""] ?? "واتساب"}</b> إلى <bdi className="md-num" dir="ltr">{phoneE164(phone)}</bdi> — صالح <bdi className="md-num">{Math.round((sent?.expires_in ?? 300) / 60)}</bdi> دقائق.</>} />
        <OtpInput value={code} onChange={setCode} error={msg} />
        <div className="rounded-md border border-border bg-surface p-3 text-14 flex items-start gap-2">
          <Icon name="phone" />
          {wait > 0
            ? <span>لم يصل على واتساب؟ تستطيع طلبه من جديد بعد <bdi className="md-num" dir="ltr">0:{String(wait).padStart(2, "0")}</bdi>.</span>
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
    <Screen title="تسجيل منشأة" back="/">
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

type Kind = "restaurant" | "cafe" | "other";

/** الخطوة 4: بيانات المنشأة وفرعها الأول، ثم «وصلنا طلبك». */
function Establishment({ onDone }: { onDone?: () => void }) {
  const zones = useLoad(() => api.get<ZoneOut[]>(`/api/customer/zones`));
  const [name, setName] = useState("");
  const [kind, setKind] = useState<Kind>("restaurant");
  const [contact, setContact] = useState("");
  const [pin, setPin] = useState<Pin>({ lat: "", lng: "" });
  const [address, setAddress] = useState("");
  const [zone, setZone] = useState("");
  const [facade, setFacade] = useState<File | null>(null);
  const [cr, setCr] = useState<File | null>(null);
  const [phase, setPhase] = useState<"form" | "facade" | "cr" | "send">("form");
  const [tried, setTried] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [done, setDone] = useState<CustomerOut | null>(null);
  const facadeRef = useRef<HTMLInputElement>(null);
  const crRef = useRef<HTMLInputElement>(null);

  const missing = !name.trim() || !contact.trim() || !address.trim() || !pinValid(pin) || !facade;

  async function submit() {
    setTried(true);
    setErr(null);
    if (missing) return;
    try {
      setPhase("facade");
      const facadeId = await uploadMedia(facade as File, "facade");
      let crId: number | null = null;
      if (cr) {
        setPhase("cr");
        crId = await uploadMedia(cr, "commercial_register");
      }
      setPhase("send");
      const out = await api.post<CustomerOut>(`/api/customer/registration`, {
        name: name.trim(), kind, contact_name: contact.trim(), lat: pin.lat.trim(), lng: pin.lng.trim(),
        address_text: address.trim(), zone_id: zone ? Number(zone) : null, facade_media_id: facadeId, cr_media_id: crId,
      });
      setDone(out);
    } catch (e) {
      setErr(acctError(e));
      if ((e as ApiError).code === "establishment_exists") onDone?.();
    } finally {
      setPhase("form");
    }
  }

  const logout = <button type="button" className="md-link text-14" onClick={() => void api.logout()}>خروج</button>;

  if (done) {
    return (
      <main className="flex-1 flex flex-col items-center text-center gap-4 px-6 pt-12 pb-8">
        <span className="rounded-full bg-secondary-tint text-primary-text grid place-items-center p-5"><Icon name="clock" size={36} /></span>
        <h1 className="m-0 text-22 font-bold">وصلنا طلبك</h1>
        <span className="text-16 text-ink-muted">نراجع بيانات «{done.name}» الآن. تصلك رسالة حين نعتمد المنشأة، وتستطيع بعدها الطلب.</span>
        <div className="w-full bg-surface border border-border rounded-lg p-3.5 flex flex-col gap-2.5 text-start">
          <div className="flex gap-2.5 items-center"><StatusBadge tone="success" icon="check">أُرسل</StatusBadge><span className="text-14">البيانات والصور</span></div>
          <div className="flex gap-2.5 items-center"><StatusBadge tone="warning">قيد المراجعة</StatusBadge><span className="text-14">اعتماد مَدَد</span></div>
        </div>
        <span className="text-14 text-ink-muted mt-auto">تستطيع تصفّح الكتالوج بالأسعار الآن، والطلب يُفتح بعد الاعتماد.</span>
        <Button variant="secondary" block icon="search" onClick={() => onDone?.()}>تصفّح الكتالوج</Button>
      </main>
    );
  }

  if (phase !== "form") {
    return (
      <Screen title="تسجيل منشأة" back="/">
        <LoadingState rows={4} />
        <div className="mt-auto">
          <Button block loading>{phase === "facade" ? "جاري رفع صورة الواجهة" : phase === "cr" ? "جاري رفع السجل التجاري" : "جاري الإرسال"}</Button>
        </div>
      </Screen>
    );
  }

  const need = (v: string) => (tried && !v.trim() ? "حقل مطلوب" : null);
  return (
    <Screen title="تسجيل منشأة" back="/" action={logout}>
      <div className="flex flex-col gap-3">
        <StepHead step="الخطوة 4 من 4 · بيانات المنشأة" />
        {tried && !facade ? (
          <div className="rounded-md bg-error-tint p-3 text-14 flex gap-2 items-start" role="alert">
            <span className="text-error-text"><Icon name="circle-alert" /></span>
            <span>صورة الواجهة إلزامية: نتحقق بها من المنشأة قبل الاعتماد.</span>
          </div>
        ) : null}
        {err ? <Note tone="error">{err}</Note> : null}
        <TextField label="اسم المنشأة" value={name} onChange={setName} required error={need(name)} />
        <Choice label="النوع" value={kind} onChange={setKind}
          options={[{ value: "restaurant", label: "مطعم" }, { value: "cafe", label: "مقهى" }, { value: "other", label: "آخر" }]} />
        <TextField label="اسم المسؤول" value={contact} onChange={setContact} required error={need(contact)} />
        <LocationPicker value={pin} onChange={setPin} hint="حرّك الخريطة لتضع الدبوس على المدخل" />
        {tried && !pinValid(pin) ? <Note tone="error">حدّد موقع المدخل على الخريطة.</Note> : null}
        {zones.data && zones.data.length ? (
          <Select label="الحي (اختياري)" value={zone} onChange={setZone}
            options={[{ value: "", label: "اختر الحي" }, ...zones.data.map((z) => ({ value: String(z.id), label: z.name_ar }))]} />
        ) : null}
        <TextField label="وصف العنوان" value={address} onChange={setAddress} placeholder="ميدان، شارع، علامة قريبة" required error={need(address)} />
        <div className="grid grid-cols-2 gap-2">
          <FilePick icon="camera" label="صورة الواجهة *" file={facade} error={tried && !facade} onPick={() => facadeRef.current?.click()} />
          <FilePick icon="file-text" label="السجل التجاري (اختياري)" file={cr} onPick={() => crRef.current?.click()} />
        </div>
        <input ref={facadeRef} type="file" accept="image/jpeg,image/png,image/webp" capture="environment" className="sr-only"
          onChange={(e) => { setFacade(e.target.files?.[0] ?? null); e.target.value = ""; }} />
        <input ref={crRef} type="file" accept="image/jpeg,image/png,image/webp,application/pdf" className="sr-only"
          onChange={(e) => { setCr(e.target.files?.[0] ?? null); e.target.value = ""; }} />
      </div>
      <div className="mt-auto">
        <Button block disabled={tried && missing} onClick={() => void submit()}>إرسال للاعتماد</Button>
      </div>
    </Screen>
  );
}

function FilePick({ icon, label, file, error, onPick }: { icon: "camera" | "file-text"; label: string; file: File | null; error?: boolean; onPick: () => void }) {
  return (
    <button type="button" onClick={onPick}
      className={cx("rounded-md border-dashed bg-surface text-ink font-sans text-13 py-3 px-2 flex flex-col items-center justify-center gap-1 cursor-pointer",
        error ? "border-2 border-error" : file ? "border border-success" : "border border-border-strong")}>
      <Icon name={file ? "circle-check" : icon} />
      <span>{label}</span>
      {file ? <span className="text-12 text-ink-muted max-w-full truncate">{file.name} · تغيير</span> : null}
    </button>
  );
}
