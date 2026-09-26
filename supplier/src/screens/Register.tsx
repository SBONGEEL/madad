/**
 * 00ب التسجيل (م-14): الرقم ← رمز مرة واحدة ← كلمة مرور ← بيانات المورد ← بانتظار الاعتماد.
 * بعد الخطوة 3 تُحفظ الجلسة فيعرض App هذه الشاشة نفسها بـ establishmentOnly (الخطوة 4 وحدها) حتى يُسجَّل المحل.
 */
import { useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";

import { ApiError } from "@ui/client";
import { phoneE164 } from "@ui/fmt";
import { Button, Icon, LoadingState, Note, OtpInput, StatusBadge, TextField, cx } from "@ui/kit";
import { api } from "@/api/client";
import type { StartOut, SupplierOut, TicketOut, TokensOut } from "@/api/types";
import { accError, uploadMedia } from "@/lib/acc-http";
import { LocationPicker, type Pin, pinValid } from "@/lib/acc-map";
import { CHANNEL, PHONE_HINT, RESEND, StepHead, attemptsLeft, countdown } from "@/lib/acc-ui";
import { Screen } from "@/lib/shell";

const TITLE = "تسجيل مورد";

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
    setSent(await api.open<StartOut>("POST", "/api/auth/supplier/register/start", { phone: p }));
    setCode("");
    setWait(RESEND);
    setStep(2);
  });
  const verify = () => run(async () => {
    const t = await api.open<TicketOut>("POST", "/api/auth/supplier/register/verify", { phone: phoneE164(phone), code });
    setTicket(t.ticket);
    setStep(3);
  });
  useEffect(() => {
    if (step === 2 && code.length === 6 && !busy) void verify();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [code, step]);
  // الاسم الحقيقي يأتي في الخطوة 4 (المسؤول) ويُحدَّث به الحساب في الخادم
  const complete = () => run(async () => {
    api.setTokens(await api.open<TokensOut>("POST", "/api/auth/supplier/register/complete", { ticket, password: pw, full_name: "—" }));
  });

  const msg = !err ? null
    : err.code === "phone_invalid" ? PHONE_HINT
    : err.code === "otp_invalid" ? `الرمز غير صحيح${attemptsLeft(err.extra.attempts_left)}`
    : err.code === "otp_already_used" || err.code === "ticket_invalid" ? "انتهت صلاحية التأكيد. ابدأ من رقم الهاتف من جديد."
    : err.message;

  if (step === 1) {
    return (
      <Screen title={TITLE} back="/">
        <StepHead step="الخطوة 1 من 4 · رقم الهاتف" title="رقم هاتف المورد" sub="نرسل رمز تأكيد مرة واحدة فقط، عبر واتساب." />
        <TextField label="رقم الهاتف" value={phone} onChange={setPhone} numeric icon="phone" placeholder="092 455 1180" autoFocus disabled={busy}
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

interface Loc { label: string; pin: Pin; address: string }
const EMPTY: Loc = { label: "", pin: { lat: "", lng: "" }, address: "" };
const locValid = (l: Loc) => l.label.trim() !== "" && l.address.trim() !== "" && pinValid(l.pin);

/** الخطوة 4: المحل والمسؤول ومواقع الاستلام وهوية المالك، ثم «نراجع بياناتك». */
function Establishment({ onDone }: { onDone?: () => void }) {
  const [name, setName] = useState("");
  const [contact, setContact] = useState("");
  const [locs, setLocs] = useState<Loc[]>([]);
  const [editing, setEditing] = useState<{ index: number | null; loc: Loc } | null>({ index: null, loc: EMPTY });
  const [ownerId, setOwnerId] = useState<File | null>(null);
  const [cr, setCr] = useState<File | null>(null);
  const [phase, setPhase] = useState<"form" | "owner" | "cr" | "send">("form");
  const [tried, setTried] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [done, setDone] = useState<SupplierOut | null>(null);
  const ownerRef = useRef<HTMLInputElement>(null);
  const crRef = useRef<HTMLInputElement>(null);

  const missing = !name.trim() || !contact.trim() || !locs.length || !ownerId;

  async function submit() {
    setTried(true);
    setErr(null);
    if (missing || !ownerId) return;
    try {
      setPhase("owner");
      const ownerMedia = await uploadMedia(ownerId, "owner_id");
      let crMedia: number | null = null;
      if (cr) {
        setPhase("cr");
        crMedia = await uploadMedia(cr, "commercial_register");
      }
      setPhase("send");
      const out = await api.post<SupplierOut>(`/api/supplier/registration`, {
        name: name.trim(), contact_name: contact.trim(), owner_id_media_id: ownerMedia, cr_media_id: crMedia,
        locations: locs.map((l) => ({ label: l.label.trim(), lat: l.pin.lat.trim(), lng: l.pin.lng.trim(), address_text: l.address.trim() })),
      });
      setDone(out);
    } catch (e) {
      setErr(accError(e));
      if ((e as ApiError).code === "supplier_exists") onDone?.();
    } finally {
      setPhase("form");
    }
  }

  function saveLoc() {
    if (!editing || !locValid(editing.loc)) return;
    const { index, loc } = editing;
    setLocs((xs) => (index === null ? [...xs, loc] : xs.map((x, i) => (i === index ? loc : x))));
    setEditing(null);
  }

  if (done) {
    return (
      <main className="flex-1 flex flex-col items-center text-center gap-3.5 px-6 pt-12 pb-8">
        <span className="rounded-full bg-secondary-tint text-primary-text grid place-items-center p-5"><Icon name="clock" size={36} /></span>
        <h1 className="m-0 text-22 font-bold">نراجع بياناتك</h1>
        <span className="text-16 text-ink-muted">نبلغك حين نعتمد «{done.name}»، ونتفق معك على دورية صرف مستحقاتك. بعدها تضيف عروضك.</span>
        <div className="mt-auto w-full"><Button block onClick={() => onDone?.()}>متابعة</Button></div>
      </main>
    );
  }

  if (phase !== "form") {
    return (
      <Screen title={TITLE} back="/">
        <LoadingState rows={4} />
        <div className="mt-auto">
          <Button block loading>{phase === "owner" ? "جاري رفع الهوية" : phase === "cr" ? "جاري رفع السجل التجاري" : "جاري الإرسال"}</Button>
        </div>
      </Screen>
    );
  }

  const need = (v: string) => (tried && !v.trim() ? "حقل مطلوب" : null);
  const logout = <button type="button" className="md-link text-14" onClick={() => void api.logout()}>خروج</button>;
  return (
    <Screen title={TITLE} back="/" action={logout}>
      <div className="flex flex-col gap-3">
        <StepHead step="الخطوة 4 من 4 · بيانات المورد" />
        {tried && (!ownerId || !locs.length) ? (
          <div className="rounded-md bg-error-tint p-3 text-14" role="alert">هوية المالك إلزامية، وموقع استلام واحد على الأقل.</div>
        ) : null}
        {err ? <Note tone="error">{err}</Note> : null}
        <TextField label="اسم المحل أو الشركة" value={name} onChange={setName} required error={need(name)} />
        <TextField label="المسؤول" value={contact} onChange={setContact} required error={need(contact)} />

        <div className="flex flex-col gap-1.5">
          <span className="text-14 font-bold">مواقع الاستلام <span className="text-error-text">*</span></span>
          {locs.map((l, i) => (
            <div key={i} className="bg-surface border border-border rounded-md p-2.5 flex gap-2 items-center">
              <Icon name="map-pin" />
              <span className="flex-1 flex flex-col min-w-0">
                <span className="text-14 truncate">{l.label}</span>
                <span className="text-12 text-ink-muted truncate">{l.address}</span>
              </span>
              <button type="button" className="md-backbar-btn" aria-label={`تعديل ${l.label}`} onClick={() => setEditing({ index: i, loc: l })}>
                <Icon name="pencil" size={18} />
              </button>
              <button type="button" className="md-backbar-btn" aria-label={`حذف ${l.label}`}
                onClick={() => { setLocs((xs) => xs.filter((_, k) => k !== i)); setEditing(null); }}>
                <Icon name="x" size={18} />
              </button>
            </div>
          ))}
          {editing ? (
            <LocEditor value={editing.loc} onChange={(loc) => setEditing({ ...editing, loc })} onSave={saveLoc}
              onCancel={locs.length ? () => setEditing(null) : undefined} />
          ) : (
            <div><Button size="sm" variant="secondary" icon="plus" onClick={() => setEditing({ index: null, loc: EMPTY })}>موقع آخر على الخريطة</Button></div>
          )}
        </div>

        <div className="grid grid-cols-2 gap-2">
          <FilePick icon="camera" label={ownerId ? "هوية المالك ✓" : "صوّر هوية المالك *"} file={ownerId} error={tried && !ownerId} onPick={() => ownerRef.current?.click()} />
          <FilePick icon="file-text" label="السجل التجاري (اختياري)" file={cr} onPick={() => crRef.current?.click()} />
        </div>
        <input ref={ownerRef} type="file" accept="image/jpeg,image/png,image/webp,application/pdf" capture="environment" className="sr-only"
          onChange={(e) => { setOwnerId(e.target.files?.[0] ?? null); e.target.value = ""; }} />
        <input ref={crRef} type="file" accept="image/jpeg,image/png,image/webp,application/pdf" className="sr-only"
          onChange={(e) => { setCr(e.target.files?.[0] ?? null); e.target.value = ""; }} />
        <span className="text-13 text-ink-muted">تبقى الهوية والسجل عند مَدَد وحده، ولا يراهما أي طرف آخر.</span>
      </div>
      <div className="mt-auto">
        <Button block disabled={tried && missing} onClick={() => void submit()}>إرسال للاعتماد</Button>
      </div>
    </Screen>
  );
}

/** موقع استلام واحد: اسمه، والدبوس، ووصف للسائق. */
function LocEditor({ value, onChange, onSave, onCancel }: { value: Loc; onChange: (l: Loc) => void; onSave: () => void; onCancel?: () => void }) {
  return (
    <div className="bg-surface border border-border rounded-md p-3 flex flex-col gap-2.5">
      <TextField label="اسم الموقع" value={value.label} onChange={(label) => onChange({ ...value, label })} placeholder="سوق الثلاثاء — محل 14" />
      <LocationPicker value={value.pin} onChange={(pin) => onChange({ ...value, pin })} hint="حرّك الخريطة لتضع الدبوس على المحل" />
      <TextField label="وصف للسائق" value={value.address} onChange={(address) => onChange({ ...value, address })} placeholder="السوق، الصف، علامة قريبة" />
      <div className="flex gap-2">
        <Button size="sm" icon="check" disabled={!locValid(value)} onClick={onSave}>حفظ الموقع</Button>
        {onCancel ? <Button size="sm" variant="ghost" onClick={onCancel}>إلغاء</Button> : null}
      </div>
    </div>
  );
}

function FilePick({ icon, label, file, error, onPick }: { icon: "camera" | "file-text"; label: string; file: File | null; error?: boolean; onPick: () => void }) {
  return (
    <button type="button" onClick={onPick}
      className={cx("rounded-md text-ink font-sans text-13 py-3 px-2 flex flex-col items-center justify-center gap-1 cursor-pointer",
        error ? "border-2 border-dashed border-error bg-surface" : file ? "border border-success bg-success-tint" : "border border-dashed border-border-strong bg-surface")}>
      <Icon name={file ? "circle-check" : icon} />
      <span>{label}</span>
      {file ? <span className="text-12 text-ink-muted max-w-full truncate">{file.name} · تغيير</span> : null}
    </button>
  );
}
