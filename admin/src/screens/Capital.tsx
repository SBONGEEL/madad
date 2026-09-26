/** رأس المال: ما يضعه المالك في مَدَد (نقد افتتاحي مرة واحدة، وضخّ لاحق)، والسجل. العرض لصلاحية المال، والتسجيل للمالك وحده. */
import { useState } from "react";
import { Link } from "react-router-dom";

import * as fmt from "@ui/fmt";
import {
  Button, ConfirmDialog, DataTable, Money, Num, PageHead, Section, StatCard, StatusBadge, TextField, useAction, useLoad, type Tone,
} from "@ui/kit";
import { api } from "@/api/client";
import type { CapitalEntryOut, CapitalIn, CapitalKind, CapitalOut } from "@/api/types";
import { cleanMoney, validMoney } from "@/lib/money-util";
import { useSession } from "@/session";

const KIND: Record<string, [string, Tone]> = { opening_cash: ["نقد افتتاحي", "success"], injection: ["ضخّ نقدي", "info"] };

export function Capital() {
  const cap = useLoad(() => api.get<CapitalOut>("/api/admin/capital"));
  const { isOwner } = useSession();
  const entries = cap.data?.entries ?? [];
  const equity = Number(cap.data?.equity_balance ?? 0);
  const cashIn = entries.reduce((s, e) => s + Number(e.amount), 0);
  const opening = entries.find((e) => e.kind === "opening_cash") ?? null;

  return (
    <div className="md-page">
      <PageHead title="رأس المال"
        sub="ما يضعه المالك في مَدَد. كل عملية قيد مزدوج بتاريخ وملاحظة، ولا تُعدَّل بعد تسجيلها. المالك وحده يسجّل هنا."
        actions={<StatusBadge tone="primary" icon="shield-check">المالك فقط</StatusBadge>} />

      <div className="grid grid-cols-3 gap-4">
        <StatCard label="رأس مال المالك" value={cap.data?.equity_balance ?? "0"} money icon="banknote" />
        <StatCard label="منه نقد في الخزينة" value={String(cashIn)} money icon="wallet" />
        <StatCard label="منه بضاعة في المخازن" value={String(Math.max(0, equity - cashIn))} money icon="warehouse" />
      </div>

      {isOwner && cap.data ? (
        <div className="grid grid-cols-2 gap-4 items-start">
          <OpeningCash opening={opening} onDone={cap.set} />
          <EntryForm kind="injection" title="ضخّ نقدي لاحق" button="تسجيل الضخّ" onDone={cap.set} />
        </div>
      ) : null}

      <section className="flex flex-col gap-2.5">
        <div className="flex justify-between items-center">
          <h2 className="md-sec-title-lg">السجل</h2>
          {isOwner ? <Link to="/withdrawals" className="md-link text-14">سحوبات المالك من الأرباح ←</Link> : null}
        </div>
        <DataTable<CapitalEntryOut>
          rows={cap.data?.entries} loading={cap.loading} error={cap.error} onRetry={cap.reload}
          emptyIcon="banknote" emptyTitle="لم يُسجَّل رأس مال بعد" emptyBody="ابدأ بالنقد الافتتاحي للخزينة، ثم بضاعة المخازن إن وُجدت."
          rowKey={(e) => e.id}
          columns={[
            { key: "d", label: "التاريخ", render: (e) => <Num>{fmt.date(e.occurred_on)}</Num> },
            { key: "k", label: "النوع", render: (e) => { const [l, t] = KIND[e.kind] ?? [e.kind, "neutral"]; return <StatusBadge tone={t}>{l}</StatusBadge>; } },
            { key: "note", label: "الملاحظة", render: (e) => e.note },
            { key: "a", label: "المبلغ", money: true, render: (e) => <Money value={e.amount} /> },
            { key: "by", label: "سجّله", render: (e) => e.created_by_name },
          ]} />
      </section>
    </div>
  );
}

/** النقد الافتتاحي: مرة واحدة لكل مدينة. */
function OpeningCash({ opening, onDone }: { opening: CapitalEntryOut | null; onDone: (c: CapitalOut) => void }) {
  if (!opening) {
    return <EntryForm kind="opening_cash" title="النقد الافتتاحي للخزينة" button="تسجيل النقد الافتتاحي" defaultNote="رصيد البداية للخزينة"
      sub="مرة واحدة لكل مدينة." onDone={onDone} />;
  }
  return (
    <Section title="النقد الافتتاحي للخزينة" right={<StatusBadge tone="success" icon="check">سُجِّل</StatusBadge>} className="flex flex-col gap-2.5">
      <span className="text-13 text-ink-muted">
        مرة واحدة لكل مدينة. سُجِّل <Num>{fmt.date(opening.occurred_on)}</Num>: <Num>{fmt.money(opening.amount)}</Num> د.ل.
      </span>
      <TextField label="المبلغ" value={fmt.money(opening.amount)} numeric suffix="د.ل" disabled />
    </Section>
  );
}

function EntryForm({ kind, title, button, sub, defaultNote = "", onDone }: {
  kind: CapitalKind; title: string; button: string; sub?: string; defaultNote?: string; onDone: (c: CapitalOut) => void;
}) {
  const [amount, setAmount] = useState("");
  const [day, setDay] = useState(fmt.today());
  const [note, setNote] = useState(defaultNote);
  const [confirm, setConfirm] = useState(false);
  const { busy, run } = useAction();
  const ok = validMoney(amount) && day && note.trim();

  async function save() {
    const body: CapitalIn = { kind, amount: cleanMoney(amount), occurred_on: day, note: note.trim() };
    const res = await run(() => api.post<CapitalOut>("/api/admin/capital", body), "سُجِّل في رأس المال");
    if (res) {
      onDone(res);
      setConfirm(false);
      setAmount("");
      setNote(defaultNote);
    }
  }

  return (
    <Section title={title} className="flex flex-col gap-2.5">
      {sub ? <span className="text-13 text-ink-muted">{sub}</span> : null}
      <TextField label="المبلغ" value={amount} onChange={setAmount} numeric suffix="د.ل" required
        error={amount && !validMoney(amount) ? "مبلغ غير صالح" : null} />
      <TextField label="التاريخ" value={day} onChange={setDay} type="date" ltr icon="clock" required />
      <TextField label="ملاحظة" value={note} onChange={setNote} required />
      <Button icon="check" disabled={!ok} onClick={() => setConfirm(true)}>{button}</Button>
      <ConfirmDialog open={confirm} icon="banknote" title={title}
        body={<>يُقيَّد <b className="md-num">{fmt.money(cleanMoney(amount))}</b> د.ل في الخزينة رأسَ مالٍ للمالك بتاريخ <Num>{fmt.date(day)}</Num>. لا يُعدَّل بعد تسجيله.</>}
        confirmLabel={button} loading={busy} onConfirm={save} onCancel={() => setConfirm(false)} />
    </Section>
  );
}
