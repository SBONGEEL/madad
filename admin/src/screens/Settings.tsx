/** الإعدادات — طرابلس (م-5، م-6، م-7، م-8، م-12، م-15، م-16، م-19، م-2، م-22، م-24، م-25، ورقم التواصل §12-ط).
 * كل خيار يُحفظ عند اختياره بحقله وحده؛ حقول المبالغ تُحفظ بزر «حفظ» أعلى الصفحة (المتغيّر منها فقط). */
import { useEffect, useMemo, useState, type ReactNode } from "react";
import { Link } from "react-router-dom";

import { qs } from "@ui/client";
import { arabicError } from "@ui/errors";
import * as fmt from "@ui/fmt";
import {
  Button, ConfirmDialog, DataTable, Loader, Money, Note, Num, OptionGroup, PageHead, Section, SectionTitle, Select, StatusBadge,
  Switch, TextField, toast, useAction, useLoad,
} from "@ui/kit";
import { api } from "@/api/client";
import type { AreaOverlapOut, AuditOut, ContactOut, ChannelOut, SettingsIn, SettingsOut, Visibility } from "@/api/types";
import { SETTING_LABEL, VALUE_LABEL, auditActor, showValue } from "@/lib/admin-labels";
import { useSession } from "@/session";

type Draft = Record<DraftKey, string>;
type DraftKey = "min_order_amount" | "min_order_lines" | "delivery_fee_flat" | "free_delivery_threshold" | "driver_pay_base"
  | "driver_pay_per_stop" | "driver_pay_per_km" | "driver_cash_cap" | "auto_confirm_max_amount";
const DRAFT_KEYS: DraftKey[] = ["min_order_amount", "min_order_lines", "delivery_fee_flat", "free_delivery_threshold", "driver_pay_base",
  "driver_pay_per_stop", "driver_pay_per_km", "driver_cash_cap", "auto_confirm_max_amount"];

function draftOf(s: SettingsOut): Draft {
  const d = {} as Draft;
  DRAFT_KEYS.forEach((k) => { d[k] = s[k] == null ? "" : String(s[k]); });
  return d;
}

function same(a: string, b: string | number | null): boolean {
  const x = a.trim(), y = b == null ? "" : String(b);
  if (!x || !y) return !x && !y;
  return Number(x) === Number(y);
}

function invalid(k: DraftKey, v: string): string | null {
  const t = v.trim();
  if (!t) return null;
  if (k === "min_order_lines") return /^\d+$/.test(t) ? null : "عدد صحيح";
  return fmt.isMoney(t) ? null : "مبلغ غير صالح";
}

const CHANNEL: Record<string, { name: string; sub: string; provider: string }> = {
  whatsapp_official: { name: "واتساب الرسمي", sub: "عبر مزوّد مدفوع", provider: "Meta Cloud API" },
  whatsapp_linked: { name: "رقم واتساب عادي", sub: "مربوط بالخادم", provider: "بوابة مَدَد" },
  sms: { name: "رسالة نصية SMS", sub: "الاحتياطي الأخير دائماً", provider: "مزوّد ليبي" },
};

export function Settings() {
  const { can } = useSession();
  const s = useLoad(() => api.get<SettingsOut>(`/api/admin/settings`));
  const act = useAction();
  const [draft, setDraft] = useState<Draft | null>(null);
  const [autoOn, setAutoOn] = useState(false);
  const [cogsTo, setCogsTo] = useState<string | null>(null);
  const audit = useLoad(() => (can("users") ? api.get<AuditOut[]>(`/api/admin/audit${qs({ table: "city_settings" })}`) : Promise.resolve([])), []);

  useEffect(() => {
    if (s.data) {
      setDraft(draftOf(s.data));
      setAutoOn(s.data.auto_confirm_max_amount != null);
    }
  }, [s.data]);

  const data = s.data;
  const dirty = useMemo(() => (data && draft ? DRAFT_KEYS.filter((k) => !same(draft[k], data[k])) : []), [data, draft]);
  const bad = draft ? DRAFT_KEYS.some((k) => invalid(k, draft[k])) : false;

  async function save(patch: SettingsIn, ok = "حُفظ الإعداد") {
    const v = await act.run(() => api.put<SettingsOut>(`/api/admin/settings`, patch), ok);
    if (v) {
      s.set(v);
      audit.reload();
    }
    return v;
  }

  async function saveDrafts() {
    if (!draft || !dirty.length || bad) return;
    const patch: Record<string, string | number | boolean | null> = {};
    dirty.forEach((k) => {
      const t = draft[k].trim();
      patch[k] = !t ? null : k === "min_order_lines" ? Number(t) : t;
    });
    if (dirty.includes("min_order_amount") || dirty.includes("min_order_lines")) {
      const any = draft.min_order_amount.trim() || draft.min_order_lines.trim();
      if (any) patch.min_order_decided = true;
    }
    await save(patch as SettingsIn, "حُفظت الإعدادات");
  }

  async function confirmCogs() {
    if (!cogsTo) return;
    const v = await act.run(() => api.post<SettingsOut>(`/api/admin/settings/cogs`, { method: cogsTo }), "تغيّرت طريقة التكلفة من الآن");
    if (v) {
      s.set(v);
      audit.reload();
    }
    setCogsTo(null);
  }

  const field = (k: DraftKey, label: string, extra: { placeholder?: string; hint?: string; suffix?: string; disabled?: boolean } = {}) =>
    draft ? (
      <TextField label={label} value={draft[k]} numeric suffix={extra.suffix ?? "د.ل"} placeholder={extra.placeholder} hint={extra.hint}
        disabled={extra.disabled || act.busy} error={invalid(k, draft[k])} onChange={(v) => setDraft({ ...draft, [k]: v })} />
    ) : null;

  return (
    <div className="md-page">
      <PageHead title="الإعدادات — طرابلس"
        sub="كل إعداد يُسجَّل تغييره بمن غيّر ومتى، ويسري على الطلبيات الجديدة فقط؛ الطلبية القائمة تبقى على ما أُرسلت به."
        actions={<Button icon="check" loading={act.busy && dirty.length > 0} disabled={!dirty.length || bad} onClick={saveDrafts}>حفظ</Button>} />

      <Loader state={s} rows={6}>{(d) => {
        const undecided = (x: boolean) => x
          ? <StatusBadge tone="warning">لم يُقرَّر — M-5</StatusBadge>
          : <StatusBadge tone="success">مُقرَّر — M-5</StatusBadge>;
        const noMin = d.min_order_decided && d.min_order_amount == null && d.min_order_lines == null;
        const payReady = d.driver_pay_base != null && d.driver_pay_per_stop != null && d.driver_pay_per_km != null;
        const example = payReady ? Number(d.driver_pay_base) + 3 * Number(d.driver_pay_per_stop) + 12 * Number(d.driver_pay_per_km) : null;
        const periods = [...(d.cogs_periods as Array<{ method: string; from: string; by: string }>)].reverse();
        return (
          <>
            <SectionTitle title="المال والرسوم" sub="الحقل الفارغ يوقف العملية التي تحتاجه برسالة واضحة (M-5)." />
            <div className="grid grid-cols-3 gap-4">
              <Section title="الحد الأدنى للطلبية" right={undecided(!d.min_order_decided)}>
                {field("min_order_amount", "مبلغ أدنى", { placeholder: "مثال 150.000", hint: "على مجموع الأصناف قبل رسم التوصيل", disabled: noMin })}
                {field("min_order_lines", "عدد أصناف أدنى", { placeholder: "مثال 3", suffix: "صنف", disabled: noMin })}
                <label className="flex gap-2 items-center text-14">
                  <input type="checkbox" checked={noMin} disabled={act.busy}
                    onChange={(e) => void save(e.target.checked
                      ? { min_order_decided: true, min_order_amount: null, min_order_lines: null }
                      : { min_order_decided: false })} />
                  لا حدّ أدنى (قرار صريح)
                </label>
              </Section>

              <Section title="رسم التوصيل" right={undecided(d.fee_mode == null)}>
                <OptionGroup columns={2} value={d.fee_mode ?? ""} disabled={act.busy}
                  options={[{ value: "flat", label: "ثابت" }, { value: "by_zone", label: "حسب المنطقة" }]}
                  onChange={(v) => {
                    if (v === "flat" && d.delivery_fee_flat == null) {
                      const t = draft?.delivery_fee_flat.trim() ?? "";
                      if (!t || !fmt.isMoney(t)) return toast("اكتب الرسم الثابت أولاً ثم اختر «ثابت».", true);
                      return void save({ fee_mode: v, delivery_fee_flat: t });
                    }
                    void save({ fee_mode: v });
                  }} />
                {field("delivery_fee_flat", "الرسم الثابت", { placeholder: "مثال 10.000" })}
                {field("free_delivery_threshold", "مجاني فوق", { placeholder: "اتركه فارغاً إن لم يوجد" })}
              </Section>

              <Section title="معادلة أجر السائق" right={undecided(!payReady)}>
                {field("driver_pay_base", "ثابت للطلبية", { placeholder: "0.000" })}
                {field("driver_pay_per_stop", "لكل نقطة استلام", { placeholder: "0.000" })}
                {field("driver_pay_per_km", "لكل كيلومتر", { placeholder: "0.000" })}
                <span className="text-13 text-ink-muted">
                  {example == null ? "مثال بعد الحفظ: 3 نقاط و12 كم ← يُحسب هنا."
                    : <>مثال: <Num>3</Num> نقاط و<Num>12</Num> كم ← <Money value={example} /></>}
                </span>
              </Section>

              <Section title="سياسة النفاد" right={undecided(d.oos_policy == null)}>
                <OptionGroup columns={2} value={d.oos_policy ?? ""} disabled={act.busy}
                  options={[{ value: "auto_hide", label: "إخفاء تلقائي", sub: "يختفي ويعود عند التوفر" },
                    { value: "mark_out", label: "«نافد» ظاهر", sub: "يبقى ولا يُضاف للسلة" }]}
                  onChange={(v) => void save({ oos_policy: v })} />
                {d.oos_policy == null
                  ? <Note tone="warning">حتى يُقرَّر: النافد لا يظهر للعميل. يُستثنى صنف بعينه من صفحته في الكتالوج.</Note>
                  : <span className="text-13 text-ink-muted">يُستثنى صنف بعينه من صفحته في الكتالوج.</span>}
              </Section>

              <Section title="سقف الكاش بحوزة السائق" right={undecided(d.driver_cash_cap == null)}>
                {field("driver_cash_cap", "السقف", { placeholder: "مثال 3,000.000", hint: "تجاوزه يوقف إسناد طلبيات جديدة للسائق حتى يسلّم الكاش." })}
              </Section>

              <Section title="الاعتماد الآلي للطلبيات"
                right={d.auto_confirm_max_amount == null ? <StatusBadge tone="neutral">يدوي دائماً</StatusBadge>
                  : <StatusBadge tone="primary">آلي حتى <Num>{fmt.money(d.auto_confirm_max_amount)}</Num></StatusBadge>}>
                <label className="flex gap-2.5 items-center text-14">
                  <Switch checked={autoOn} label="الاعتماد الآلي" disabled={act.busy}
                    onChange={(v) => {
                      setAutoOn(v);
                      if (!v && d.auto_confirm_max_amount != null) void save({ auto_confirm_max_amount: null });
                      if (!v && draft) setDraft({ ...draft, auto_confirm_max_amount: "" });
                    }} />
                  تأكيد آلي للطلبية تحت مبلغ
                </label>
                {field("auto_confirm_max_amount", "حتى مبلغ", { placeholder: "—", disabled: !autoOn })}
                <div className="flex justify-between items-center text-14 border-t border-border pt-2.5">
                  <span>مخزن مَدَد يُقدَّم على الموردين</span>
                  <Switch checked={d.warehouse_first} label="المخزن أولاً" disabled={act.busy} onChange={(v) => void save({ warehouse_first: v })} />
                </div>
                <div className="flex justify-between items-center gap-3 text-14">
                  <span>التحصيل على الدفعات</span>
                  <Select value={d.collection_mode} disabled={act.busy} onChange={(v) => void save({ collection_mode: v })}
                    options={[{ value: "on_completion", label: "عند اكتمال التسليم" }, { value: "per_batch", label: "مع كل دفعة" }]} />
                </div>
              </Section>
            </div>

            <SectionTitle title="قواعد الطلبيات" sub="تسري على الطلبيات الجديدة فقط" />
            <div className="grid grid-cols-3 gap-4 items-start">
              <Section title="إلغاء الطلبية من المطعم" right={<StatusBadge tone="neutral">M-7</StatusBadge>}>
                <OptionGroup value={d.cancel_policy} disabled={act.busy} onChange={(v) => void save({ cancel_policy: v })} options={[
                  { value: "until_collecting", label: "حتى يبدأ السائق الجمع", sub: "بعدها لا إلغاء من التطبيق، والمطعم يفتح نزاعاً.", initial: true },
                  { value: "anytime", label: "في أي وقت", sub: "حتى بعد الجمع. تصلك الطلبية نزاعاً، وتقرر المسترد من شاشة النزاعات." }]} />
              </Section>
              <Section title="طلب أكثر من المتاح" right={<StatusBadge tone="neutral">M-15</StatusBadge>}>
                <OptionGroup value={d.oversell_policy} disabled={act.busy} onChange={(v) => void save({ oversell_policy: v })} options={[
                  { value: "forbid", label: "ممنوع", sub: "يرى المطعم الحد المتاح ولا يتجاوزه.", initial: true },
                  { value: "allow", label: "مسموح", sub: "يُكمَّل الباقي من مورد آخر في مخطط الاستلام، ويصلك إشعار إن لم يوجد مورد يكفي." }]} />
              </Section>
              <Section title="إثبات الاستلام عند المورد" right={<StatusBadge tone="neutral">M-22</StatusBadge>}>
                <OptionGroup value={d.pickup_proof_required ? "yes" : "no"} disabled={act.busy}
                  onChange={(v) => void save({ pickup_proof_required: v === "yes" })} options={[
                    { value: "yes", label: "إلزامي", sub: "لا يؤكد السائق «تم الجمع» قبل مسح الرمز أو كتابة رقم المورد.", initial: true },
                    { value: "no", label: "اختياري", sub: "السائق يؤكد الجمع ولو بلا إثبات." }]} />
              </Section>
            </div>

            <SectionTitle title="الأسعار والتكلفة" />
            <div className="grid grid-cols-2 gap-4 items-start">
              <Section title="سعر البيع حين يغيّر المورد سعره" right={<StatusBadge tone="neutral">M-6</StatusBadge>}>
                <OptionGroup columns={2} value={d.reprice_on_cost_change ? "auto" : "manual"} disabled={act.busy}
                  onChange={(v) => void save({ reprice_on_cost_change: v === "auto" })} options={[
                    { value: "manual", label: "يدوي", sub: "يُعلَّم الصنف «يحتاج مراجعة» ويبقى سعر المطعم كما هو حتى تعتمده.", initial: true },
                    { value: "auto", label: "تلقائي", sub: "يُحسب السعر الجديد فوراً بهامش الصنف." }]} />
                <div className="flex flex-col gap-2 border-t border-border pt-2.5 text-14">
                  <Row label="إشعار لك عند كل تغيّر سعر مورد"><StatusBadge tone="primary" icon="bell">دائماً</StatusBadge></Row>
                  <Row label="لا يُباع صنف بأقل من تكلفته — يوقف ويُعلَّم"><StatusBadge tone="primary" icon="shield-check">دائماً، لا يُطفأ</StatusBadge></Row>
                  {can("catalog") ? <Row label="أصناف مستثناة من هذا الإعداد"><Link to="/catalog" className="md-link">الكتالوج ← تسعير الصنف</Link></Row> : null}
                </div>
              </Section>
              <Section title="تكلفة بضاعة المخازن في تقرير الربح" right={<StatusBadge tone="neutral">M-12</StatusBadge>}>
                <OptionGroup columns={2} value={d.cogs_method} disabled={act.busy} onChange={(v) => setCogsTo(v)} options={[
                  { value: "average", label: "متوسط سعر الشراء", sub: "كل كمية جديدة تدخل المتوسط.", initial: true },
                  { value: "fifo", label: "الأقدم شراءً أولاً", sub: "يُحسب من أقدم دفعة ما زالت في المخزن." }]} />
                <Note tone="primary">التغيير يسري من لحظة حفظه. الفترات الماضية لا يُعاد حسابها، والتقرير يذكر الطريقة المستعملة لكل فترة.</Note>
                <DataTable rows={periods} rowKey={(p) => p.from} emptyTitle="لا فترات بعد"
                  columns={[
                    { key: "m", label: "الطريقة", render: (p) => VALUE_LABEL[p.method] ?? p.method },
                    { key: "f", label: "من", render: (p) => <Num>{fmt.dateTime(p.from)}</Num> },
                    { key: "b", label: "غيّرها", render: (p) => p.by },
                  ]} />
              </Section>
            </div>

            <SectionTitle title="قواعد الرسم والتكلفة" sub="قرارات 26/09 الثالثة" />
            <div className="grid grid-cols-2 gap-4 items-start">
              <Section title="أساس «التكلفة» التي لا يُباع الصنف تحتها" right={<StatusBadge tone="neutral">M-6</StatusBadge>}>
                <OptionGroup columns={2} value={d.cost_guard_basis} disabled={act.busy} onChange={(v) => void save({ cost_guard_basis: v })} options={[
                  { value: "max_source", label: "أعلى سعر بين كل موردي الصنف", sub: "أشدّ حماية: لا يُباع تحت أغلى مورد يمكن أن يُشترى منه.", initial: true },
                  { value: "first_priority", label: "سعر المورد الأول في الأولوية", sub: "يُقارن بسعر المورد الذي يُشترى منه أولاً." }]} />
                {can("catalog") ? (
                  <div className="flex justify-between items-center text-14 border-t border-border pt-2.5">
                    <span>أصناف مستثناة بأساس آخر</span><Link to="/catalog" className="md-link">الكتالوج ← تسعير الصنف</Link>
                  </div>
                ) : null}
              </Section>
              <Section title="حين يختلف رسم الحيّ عن رسم المنطقة المرسومة" right={<StatusBadge tone="neutral">M-25</StatusBadge>}>
                <OptionGroup columns={2} value={d.fee_conflict_rule} disabled={act.busy} onChange={(v) => void save({ fee_conflict_rule: v })} options={[
                  { value: "area_wins", label: "المنطقة المرسومة تغلب", sub: "موقع الفرع على الخريطة أدقّ.", initial: true },
                  { value: "zone_wins", label: "الحيّ يغلب", sub: "الحيّ الذي اختاره المالك للفرع." },
                  { value: "higher", label: "الرسم الأعلى", sub: "يُؤخذ الأكبر من الرسمين." },
                  { value: "lower", label: "الرسم الأقل", sub: "يُؤخذ الأصغر من الرسمين." }]} />
                <span className="text-12 text-ink-muted">يسري على الطلبيات الجديدة. الطلبية تحفظ القاعدة التي أُرسلت بها.</span>
              </Section>
            </div>

            <ConfirmDialog open={cogsTo != null} tone="warning" icon="history" loading={act.busy}
              title={`تغيير طريقة التكلفة إلى «${VALUE_LABEL[cogsTo ?? ""] ?? ""}»؟`}
              body="تسري من لحظة الحفظ. الفترات الماضية لا يُعاد حسابها، وتُسجَّل الفترة الجديدة باسمك."
              confirmLabel="غيّر الطريقة" onConfirm={confirmCogs} onCancel={() => setCogsTo(null)} />
          </>
        );
      }}</Loader>

      <div className="grid grid-cols-2 gap-4 items-start">
        <AreaOverlapCard />
        <ContactCard />
      </div>

      <SectionTitle title="رموز التحقق" />
      <OtpChannels />

      <SectionTitle title="ما يراه كل طرف وما يُضبط لكل منشأة" />
      <VisibilityCard />

      <div className="grid grid-cols-2 gap-4 items-start">
        <Section title="مسؤول مشتريات الفرع" right={<StatusBadge tone="neutral">M-8</StatusBadge>}>
          <span className="text-14">يُضبط لكل منشأة من صفحتها: يطلب مباشرة (الابتدائي)، أو يجهّز السلة وصاحب المنشأة يؤكد.</span>
          {can("customers") ? <Link to="/customers" className="md-link">العملاء ← صفحة المنشأة</Link> : null}
        </Section>
        <Section title="مناطق التوصيل" right={<StatusBadge tone="neutral">M-16</StatusBadge>}>
          <span className="text-14">قائمة الأحياء، والمناطق المرسومة على الخريطة، وتعارضهما.</span>
          <Link to="/zones" className="md-link">مناطق التوصيل ← يُحسم تعارضهما بالقاعدة أعلاه</Link>
        </Section>
      </div>

      {can("users") ? (
        <Section title="آخر التغييرات في الإعدادات" right={<Link to="/audit" className="md-link text-14">سجل التدقيق</Link>}>
          <DataTable rows={audit.data ? flatten(audit.data) : null} loading={audit.loading} error={audit.error} onRetry={audit.reload}
            emptyIcon="settings" emptyTitle="لا تغييرات بعد" emptyBody="القيم الابتدائية سارية حتى تغيّرها." rowKey={(r) => r.key}
            columns={[
              { key: "w", label: "متى", render: (r) => <Num>{fmt.dateTime(r.at)}</Num> },
              { key: "u", label: "من", render: (r) => auditActor(r.actor) },
              { key: "s", label: "الإعداد", render: (r) => r.setting },
              { key: "c", label: "من ← إلى", render: (r) => r.change },
            ]} />
        </Section>
      ) : null}
    </div>
  );
}

function Row({ label, children }: { label: string; children: ReactNode }) {
  return <div className="flex justify-between items-center gap-3"><span>{label}</span>{children}</div>;
}

/** سطر لكل إعداد تغيّر، من آخر تغييرات جدول الإعدادات. */
function flatten(rows: AuditOut[]) {
  const out: Array<{ key: string; at: string; actor: string; setting: string; change: string }> = [];
  for (const r of rows) {
    for (const [k, v] of Object.entries(r.changes)) {
      if (!(k in SETTING_LABEL)) continue;
      const [b, a] = Array.isArray(v) ? v : [undefined, v];
      out.push({ key: `${r.id}-${k}`, at: r.at, actor: r.actor, setting: SETTING_LABEL[k] ?? k,
        change: `${showValue(k, b)} ← ${showValue(k, a)}` });
    }
    if (out.length >= 10) break;
  }
  return out.slice(0, 10);
}

/** قنوات الرمز (م-24): الترتيب والتفعيل. «مضبوطة» تأتي من الخادم بلا أي قيمة سرية. */
function OtpChannels() {
  const ch = useLoad(() => api.get<ChannelOut[]>(`/api/admin/settings/otp-channels`));
  const act = useAction();

  async function put(order: string[], enabled: Record<string, boolean>) {
    const v = await act.run(() => api.put<ChannelOut[]>(`/api/admin/settings/otp-channels`, { order, enabled }), "حُفظ ترتيب القنوات");
    if (v) ch.set(v);
  }

  return (
    <Section title="إرسال رموز التحقق" right={<StatusBadge tone="neutral">M-24</StatusBadge>}>
      <span className="text-13 text-ink-muted">بالترتيب من الأعلى. إن فشلت قناة أو حُظرت ينتقل الإرسال للتالية تلقائياً ويصلك إشعار. الرسائل النصية الاحتياطي الأخير دائماً.</span>
      <Loader state={ch}>{(list) => {
        const order = list.map((c) => c.channel);
        const enabled = Object.fromEntries(list.map((c) => [c.channel, c.enabled]));
        const move = (i: number, by: number) => {
          const next = [...order];
          const [x] = next.splice(i, 1);
          if (x) next.splice(i + by, 0, x);
          void put(next, enabled);
        };
        return (
          <div className="flex flex-col gap-2">
            {list.map((c, i) => {
              const meta = CHANNEL[c.channel] ?? { name: c.channel, sub: "", provider: "" };
              const last = c.channel === "sms";
              const nextIsSms = list[i + 1]?.channel === "sms" || i === list.length - 1;
              return (
                <div key={c.channel} className="grid grid-cols-[auto_minmax(0,1.3fr)_minmax(0,1fr)_minmax(0,1fr)_auto_auto] gap-3 items-center p-3 rounded-md bg-page">
                  <span className="md-num w-8 h-8 rounded-full bg-primary text-on-primary grid place-items-center font-bold">{c.position}</span>
                  <div className="flex flex-col"><b>{meta.name}</b><span className="text-12 text-ink-muted">{meta.sub}</span></div>
                  <span className="text-13">{meta.provider}</span>
                  <span>{c.configured ? <StatusBadge tone="success">مضبوطة</StatusBadge> : <StatusBadge tone="warning">غير مضبوطة</StatusBadge>}</span>
                  <Switch checked={c.enabled} label={meta.name} disabled={act.busy} onChange={(v) => void put(order, { ...enabled, [c.channel]: v })} />
                  <div className="flex gap-1">
                    {last ? <StatusBadge tone="neutral" icon="shield-check">الأخير</StatusBadge> : (
                      <>
                        <Button size="sm" variant="secondary" icon="chevron-right" title="أعلى" disabled={i === 0 || act.busy} onClick={() => move(i, -1)} />
                        <Button size="sm" variant="secondary" icon="chevron-left" title="أسفل" disabled={nextIsSms || act.busy} onClick={() => move(i, 1)} />
                      </>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        );
      }}</Loader>
      <Note tone="warning">«غير مضبوطة» = لم تُفتح حساب المزوّد بعد. تُتخطّى القناة حتى تُضبط مفاتيحها على الخادم — لا تُكتب المفاتيح هنا.</Note>
    </Section>
  );
}

/** ما يراه كل طرف (م-2، م-19): المغلق لا يصل للتطبيق أصلاً. */
function VisibilityCard() {
  const vis = useLoad(() => api.get<Visibility>(`/api/admin/settings/visibility`));
  const act = useAction();
  const items: Array<{ key: keyof Visibility; title: string; sub: string; label: string }> = [
    { key: "driver_sees_supplier_name", title: "السائق يرى اسم المورد", sub: "مغلقاً: «نقطة استلام 1». الموقع والكود يظهران دائماً. (M-2)", label: "السائق يرى اسم المورد" },
    { key: "customer_sees_driver_name", title: "العميل يرى الاسم الأول للسائق", sub: "في تتبّع الطلبية. (M-19)", label: "العميل يرى اسم السائق" },
    { key: "customer_can_call_driver", title: "العميل يتصل بالسائق", sub: "زر اتصال برقم السائق. (M-19)", label: "العميل يتصل بالسائق" },
  ];
  return (
    <Section title="ما يراه كل طرف" right={<span className="text-13 text-ink-muted">المغلق لا يصل إلى التطبيق أصلاً، ولا إلى ملفات PDF.</span>}>
      <Loader state={vis}>{(v) => (
        <div className="grid grid-cols-3 gap-3">
          {items.map((it) => (
            <div key={it.key} className="flex justify-between items-center gap-3 p-3 rounded-md bg-page">
              <div className="flex flex-col gap-0.5"><span className="font-bold text-14">{it.title}</span><span className="text-12 text-ink-muted">{it.sub}</span></div>
              <Switch checked={v[it.key]} label={it.label} disabled={act.busy} onChange={async (on) => {
                const r = await act.run(() => api.put<Visibility>(`/api/admin/settings/visibility`, { ...v, [it.key]: on }), "حُفظ الإعداد");
                if (r) vis.set(r);
              }} />
            </div>
          ))}
        </div>
      )}</Loader>
    </Section>
  );
}

/** م-27: حين يقع فرع داخل منطقتين مرسومتين برسمين مختلفين. في كل الحالات يصل تنبيه بالتداخل (القاعدة). */
function AreaOverlapCard() {
  const st = useLoad(() => api.get<AreaOverlapOut>(`/api/admin/settings/area-overlap`));
  const act = useAction();
  async function set(rule: string) {
    const v = await act.run(() => api.put<AreaOverlapOut>(`/api/admin/settings/area-overlap`, { rule }), "حُفظ الإعداد — يسري على الطلبيات الجديدة");
    if (v) st.set(v);
  }
  return (
    <Section title="حين يقع فرع داخل منطقتين مرسومتين برسمين مختلفين" right={<StatusBadge tone="neutral">M-27</StatusBadge>}>
      <Loader state={st}>{(d) => (
        <>
          <OptionGroup value={d.rule} disabled={act.busy} onChange={(v) => void set(v)} options={[
            { value: "stop", label: "تتوقف طلبيات الفرع حتى تُصحَّح الحدود", sub: "يصلك تنبيه بالمنطقتين والفروع الواقعة فيهما.", initial: true },
            { value: "higher", label: "الرسم الأعلى", sub: "يُؤخذ أعلى رسمَي المنطقتين." },
            { value: "lower", label: "الرسم الأقل", sub: "يُؤخذ أقلّهما." }]} />
          <span className="text-12 text-ink-muted">في كل الحالات يصلك تنبيه بالتداخل، وعند حفظ منطقة ترسم تداخلاً جديداً. يسري على الطلبيات الجديدة.</span>
          {d.overlaps.length ? (
            <div className="flex justify-between items-center text-14 border-t border-border pt-2.5">
              <span>تداخلات قائمة: <Num>{d.overlaps.length}</Num></span><Link to="/zones" className="md-link">مناطق التوصيل</Link>
            </div>
          ) : null}
        </>
      )}</Loader>
    </Section>
  );
}

/** §12-ط: رقما «تواصل مع مَدَد» في تطبيقات العميل والمورد والسائق. يُكتبان كما يكتبهما الناس ويُرسلان +2189XXXXXXXX. */
function ContactCard() {
  const st = useLoad(() => api.get<ContactOut>(`/api/admin/settings/contact`));
  return (
    <Section title="رقم التواصل مع مَدَد" right={<StatusBadge tone="neutral">§12-ط</StatusBadge>}>
      <span className="text-13 text-ink-muted">يظهر في تطبيقات العميل والمورد والسائق («تواصل مع مَدَد»). يُغيَّر في أي وقت ويُسجَّل تغييره.</span>
      <Loader state={st}>{(d) => <ContactForm key={`${d.phone}|${d.whatsapp}`} d={d} onSaved={st.set} />}</Loader>
    </Section>
  );
}

function ContactForm({ d, onSaved }: { d: ContactOut; onSaved: (v: ContactOut) => void }) {
  const act = useAction();
  const [phone, setPhone] = useState(d.phone ? fmt.phoneLocal(d.phone) : "");
  const [wa, setWa] = useState(d.whatsapp ? fmt.phoneLocal(d.whatsapp) : "");
  // فارغ يمسح الرقم؛ غير الفارغ يجب أن يكون رقماً ليبياً
  const norm = (v: string) => (v.trim() ? fmt.phoneE164(v) : null);
  const bad = (v: string) => (v.trim() && !fmt.phoneE164(v) ? arabicError("phone_invalid") : null);
  async function save() {
    const v = await act.run(() => api.put<ContactOut>(`/api/admin/settings/contact`, { phone: norm(phone), whatsapp: norm(wa) }),
      "حُفظ رقم التواصل — يظهر في التطبيقات الآن");
    if (v) onSaved(v);
  }
  return (
    <>
      <div className="grid grid-cols-2 gap-3">
        <TextField label="رقم الاتصال" value={phone} onChange={setPhone} numeric icon="phone" placeholder="092 111 2233" error={bad(phone)} />
        <TextField label="رقم واتساب" value={wa} onChange={setWa} numeric icon="send" placeholder="092 111 2233" error={bad(wa)} />
      </div>
      <div>
        <Button icon="check" loading={act.busy} disabled={!!bad(phone) || !!bad(wa)} onClick={() => void save()}>حفظ</Button>
      </div>
    </>
  );
}
