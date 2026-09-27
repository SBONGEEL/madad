/** الصرف (§12-ي): دورية أجر السائق (D-1) وموعد الصرف القادم — مشتركة بين الإعدادات وملف السائق وملف المورد. */
import { type ReactNode, useState } from "react";

import * as fmt from "@ui/fmt";
import { Button, DataTable, Loader, Note, Num, Option, Section, Select, StatusBadge, TextField, useAction, useLoad } from "@ui/kit";
import { api } from "@/api/client";
import type { PartyPayoutOut, PayoutRuleEventOut, PayoutRuleIn, PayoutRuleOut, PayoutSettingsOut } from "@/api/types";
import { CYCLE } from "@/lib/money-util";
import { useSession } from "@/session";

/** 0 الأحد … 6 السبت، كما في القاعدة. */
export const WEEKDAYS = ["الأحد", "الاثنين", "الثلاثاء", "الأربعاء", "الخميس", "الجمعة", "السبت"];

export const CYCLES: Array<{ value: string; label: string; sub: string }> = [
  { value: "daily", label: "يومي", sub: "كل يوم" },
  { value: "weekly", label: "أسبوعي", sub: "كل 7 أيام" },
  { value: "semimonthly", label: "نصف شهري", sub: "مرتين في الشهر" },
  { value: "monthly", label: "شهري", sub: "مرة في الشهر" },
];

export const cycleLabel = (c: string | null | undefined) => (c && CYCLE[c]?.[0]) || "—";

/** «2026-10-03» ← «السبت 03/10». */
export function payoutDay(ymd: string): string {
  const [y, m, d] = ymd.slice(0, 10).split("-").map(Number);
  const day = new Date(y ?? 1970, (m ?? 1) - 1, d ?? 1);
  return `${WEEKDAYS[day.getDay()] ?? ""} ${fmt.date(ymd.slice(0, 10)).slice(0, 5)}`;
}

/** وصف الموعد: «آخر صرف + طول الدورة» أو «أيام ثابتة (السبت · 1 · 1 و15)». */
export function scheduleText(r: PayoutRuleOut, short = false): string {
  if (r.mode === "rolling") return short ? "آخر صرف + الدورة" : "آخر صرف + طول الدورة";
  if (r.mode !== "fixed") return "—";
  const wd = WEEKDAYS[r.fixed_weekday ?? -1] ?? "—";
  if (short) return `أيام ثابتة — ${wd}`;
  const sm = r.fixed_semimonth_days ?? [];
  return `أيام ثابتة (${wd} · ${r.fixed_month_day ?? "—"} · ${sm[0] ?? "—"} و${sm[1] ?? "—"})`;
}

/** سطر «التغيير» في السجل: كل حدث لقطة كاملة؛ الفارغ = العام فيه. */
export function eventText(e: PayoutRuleEventOut, withCycle: boolean): string {
  const parts: string[] = [];
  if (withCycle && e.driver_cycle) parts.push(`الدورية: ${cycleLabel(e.driver_cycle)}`);
  if (e.mode) parts.push(`الموعد: ${scheduleText(e)}`);
  return parts.length ? parts.join(" · ") : "الرجوع إلى العام";
}

// ——— تحرير الموعد ————————————————————————————————————————————————————————————
export interface SchedDraft { mode: "rolling" | "fixed"; weekday: string; monthDay: string; semi: string }

export function schedOf(r: PayoutRuleOut | null | undefined): SchedDraft {
  const sm = r?.fixed_semimonth_days;
  return {
    mode: r?.mode === "fixed" ? "fixed" : "rolling",
    weekday: String(r?.fixed_weekday ?? 6),
    monthDay: String(r?.fixed_month_day ?? 1),
    semi: sm ? `${sm[0]} و ${sm[1]}` : "1 و 15",
  };
}

const dayOk = (n: number) => Number.isInteger(n) && n >= 1 && n <= 28;

export function semiDays(s: string): [number, number] | null {
  const n = (s.match(/\d+/g) ?? []).map(Number);
  return n.length === 2 && dayOk(n[0]!) && dayOk(n[1]!) && n[0]! < n[1]! ? [n[0]!, n[1]!] : null;
}

export function schedErrors(d: SchedDraft): { monthDay: string | null; semi: string | null } {
  if (d.mode !== "fixed") return { monthDay: null, semi: null };
  return {
    monthDay: /^\d+$/.test(d.monthDay.trim()) && dayOk(Number(d.monthDay)) ? null : "يوم من 1 إلى 28",
    semi: semiDays(d.semi) ? null : "يومان من 1 إلى 28، الأول أصغر",
  };
}

/** حقول الموعد في جسم PayoutRuleIn (الأيام مع «أيام ثابتة» وحدها). */
export function schedBody(d: SchedDraft): Pick<PayoutRuleIn, "mode" | "fixed_weekday" | "fixed_month_day" | "fixed_semimonth_days"> {
  if (d.mode !== "fixed") return { mode: "rolling", fixed_weekday: null, fixed_month_day: null, fixed_semimonth_days: null };
  return { mode: "fixed", fixed_weekday: Number(d.weekday), fixed_month_day: Number(d.monthDay), fixed_semimonth_days: semiDays(d.semi) };
}

export function CycleOptions({ value, onChange, disabled }: { value: string; onChange: (v: string) => void; disabled?: boolean }) {
  return (
    <div role="radiogroup" className="grid grid-cols-4 gap-2">
      {CYCLES.map((c) => (
        <Option key={c.value} label={c.label} sub={c.sub} selected={value === c.value} disabled={disabled} onSelect={() => onChange(c.value)} />
      ))}
    </div>
  );
}

export function ScheduleEditor({ value, onChange, disabled, rollingSub }: {
  value: SchedDraft; onChange: (v: SchedDraft) => void; disabled?: boolean; rollingSub?: string;
}) {
  const err = schedErrors(value);
  const fixed = value.mode === "fixed";
  return (
    <>
      <div role="radiogroup" className="grid grid-cols-2 gap-2">
        <Option label="آخر صرف + طول الدورة" sub={rollingSub ?? "أو تاريخ الاعتماد + طول الدورة إن لم يُصرف بعد."} initial
          selected={!fixed} disabled={disabled} onSelect={() => onChange({ ...value, mode: "rolling" })} />
        <Option label="أيام ثابتة" sub="يوم الصرف ثابت حسب الدورية." selected={fixed} disabled={disabled}
          onSelect={() => onChange({ ...value, mode: "fixed" })} />
      </div>
      {fixed ? (
        <>
          <div className="grid grid-cols-3 gap-3 items-start">
            <Select label="الأسبوعية: يوم" value={value.weekday} disabled={disabled} onChange={(v) => onChange({ ...value, weekday: v })}
              options={WEEKDAYS.map((w, i) => ({ value: String(i), label: w }))} />
            <TextField label="الشهرية: يوم من الشهر" value={value.monthDay} numeric disabled={disabled} error={err.monthDay}
              onChange={(v) => onChange({ ...value, monthDay: v })} />
            <TextField label="نصف الشهرية: يوما الشهر" value={value.semi} numeric disabled={disabled} error={err.semi} placeholder="1 و 15"
              onChange={(v) => onChange({ ...value, semi: v })} />
          </div>
          <span className="text-13 text-ink-muted">اليومية كل يوم في الحالتين. الأيام من 1 إلى 28 ليقع اليوم في كل شهر.</span>
        </>
      ) : null}
    </>
  );
}

export function RuleHistory({ rows, withCycle }: { rows: PayoutRuleEventOut[]; withCycle: boolean }) {
  return (
    <DataTable rows={rows} rowKey={(e, i) => `${e.at}-${i}`} emptyIcon="history" emptyTitle="لا تغييرات بعد"
      columns={[
        { key: "at", label: "التاريخ", render: (e) => <Num>{fmt.dateTime(e.at)}</Num> },
        { key: "what", label: "التغيير", render: (e) => eventText(e, withCycle) },
        { key: "by", label: "بواسطة", render: (e) => e.by },
      ]} />
  );
}

// ——— ملف المورد أو السائق: استثناؤه من العام ————————————————————————————————————————
/** الصرف في ملف السائق (الدورية والموعد) أو المورد (الموعد وحده — دوريته في ملفه منذ اعتماده). كل الحقول فارغة = العام. */
export function PartyPayout({ kind, id, name, due, method }: {
  kind: "driver" | "supplier"; id: number; name: string; due: string; method?: ReactNode;
}) {
  const { can } = useSession();
  const st = useLoad(() => (kind === "driver" ? api.get<PartyPayoutOut>(`/api/admin/drivers/${id}/payout`)
    : api.get<PartyPayoutOut>(`/api/admin/suppliers/${id}/payout`)), [kind, id]);
  const gen = useLoad(() => (can("settings") ? api.get<PayoutSettingsOut>(`/api/admin/settings/payout`).then((g) => g.general) : Promise.resolve(null)), []);
  return (
    <Section title={`ملف ${kind === "driver" ? "السائق" : "المورد"} — ${name} · الصرف`} right={<StatusBadge tone="neutral">المال</StatusBadge>}>
      <Loader state={st}>{(d) => (
        <PartyForm key={`${id}|${d.history[0]?.at ?? ""}`} kind={kind} id={id} d={d} due={due} method={method}
          general={gen.data ?? (d.override ? null : d.effective)} onSaved={st.set} />
      )}</Loader>
    </Section>
  );
}

function PartyForm({ kind, id, d, due, method, general, onSaved }: {
  kind: "driver" | "supplier"; id: number; d: PartyPayoutOut; due: string; method?: ReactNode; general: PayoutRuleOut | null;
  onSaved: (v: PartyPayoutOut) => void;
}) {
  const act = useAction();
  const o = d.override;
  const driver = kind === "driver";
  const [ownCycle, setOwnCycle] = useState(!!o?.driver_cycle);
  const [cycle, setCycle] = useState(o?.driver_cycle ?? d.effective.driver_cycle ?? "weekly");
  const [ownSched, setOwnSched] = useState(!!o?.mode);
  const [sched, setSched] = useState<SchedDraft>(schedOf(o?.mode ? o : d.effective));
  const err = schedErrors(sched);
  const bad = ownSched && (!!err.monthDay || !!err.semi);

  async function save() {
    const when = ownSched ? schedBody(sched) : { mode: null, fixed_weekday: null, fixed_month_day: null, fixed_semimonth_days: null };
    const body: PayoutRuleIn = driver ? { driver_cycle: ownCycle ? cycle : null, ...when } : when;
    const v = await act.run(() => (driver ? api.put<PartyPayoutOut>(`/api/admin/drivers/${id}/payout`, body)
      : api.put<PartyPayoutOut>(`/api/admin/suppliers/${id}/payout`, body)), "حُفظ الصرف — يسري من الدورة التالية ويُسجَّل");
    if (v) onSaved(v);
  }

  const sub = (t: string) => <span className="text-13 font-bold text-ink-muted">{t}</span>;
  const fromSettings = (t: string | null) => (t ? `${t} — من الإعدادات` : "من الإعدادات");
  return (
    <>
      <div className="flex gap-2 flex-wrap">
        {driver ? method : <StatusBadge tone="neutral">دوريته: {cycleLabel(d.payout_cycle)} (منذ اعتماده)</StatusBadge>}
        <StatusBadge tone="info">{driver ? "المستحق حتى الآن" : "المستحق"} <Num>{fmt.money(due)}</Num> د.ل</StatusBadge>
      </div>
      {driver ? (
        <>
          {sub("الدورية")}
          <div role="radiogroup" className="grid grid-cols-2 gap-2">
            <Option label="العامة" sub={fromSettings(general?.driver_cycle ? cycleLabel(general.driver_cycle) : null)}
              selected={!ownCycle} disabled={act.busy} onSelect={() => setOwnCycle(false)} />
            <Option label="دورية خاصة به" sub="يومي / أسبوعي / نصف شهري / شهري" selected={ownCycle} disabled={act.busy} onSelect={() => setOwnCycle(true)} />
          </div>
          {ownCycle ? <CycleOptions value={cycle} onChange={setCycle} disabled={act.busy} /> : null}
        </>
      ) : null}
      {sub("موعد الصرف")}
      <div role="radiogroup" className="grid grid-cols-2 gap-2">
        <Option label="العام" sub={fromSettings(general?.mode ? scheduleText(general, true) : null)}
          selected={!ownSched} disabled={act.busy} onSelect={() => setOwnSched(false)} />
        <Option label="خاص به" sub={driver ? "آخر صرف + الدورة، أو أيام ثابتة خاصة" : "آخر صرف + الدورة، أو أيام ثابتة"}
          selected={ownSched} disabled={act.busy} onSelect={() => setOwnSched(true)} />
      </div>
      {ownSched ? <ScheduleEditor value={sched} onChange={setSched} disabled={act.busy} rollingSub="آخر صرف + طول الدورة، أو تاريخ الاعتماد إن لم يُصرف بعد." /> : null}
      <Note tone="primary">
        {d.next_payout_on ? <b>الصرف القادم: {payoutDay(d.next_payout_on)}</b> : <b>لا موعد صرف قادم بعد.</b>}
        {" — "}{driver ? "أي تغيير هنا يسري من دورته التالية ويُسجَّل." : "يراه المورد في تطبيقه. أي تغيير هنا يسري من دورته التالية ويُسجَّل."}
      </Note>
      <div><Button icon="check" loading={act.busy} disabled={bad} onClick={() => void save()}>حفظ</Button></div>
    </>
  );
}
