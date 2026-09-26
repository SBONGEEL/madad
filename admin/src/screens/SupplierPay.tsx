/** صرف الموردين: المستحق لكل مورد بدوريته وموعده، وتسجيل الصرف من الخزينة، وإيصال المورد (بلا بيانات عملاء — بنيوياً). */
import { useState } from "react";

import * as fmt from "@ui/fmt";
import { Button, ConfirmDialog, DataTable, Money, Num, PageHead, Section, StatusBadge, TextField, useAction, useLoad } from "@ui/kit";
import { api } from "@/api/client";
import type { SupplierDueOut, SupplierPayoutIn } from "@/api/types";
import { CYCLE, addDays, cleanMoney, fromMilli, isoDay, milli, validMoney } from "@/lib/money-util";

interface Receipt { supplier: string; amount: string; from: string; to: string; at: string }

function cycleOf(s: SupplierDueOut): [string, number] {
  return (s.payout_cycle && CYCLE[s.payout_cycle]) || ["—", 1];
}

/** موعد الصرف: بعد آخر صرف بطول الدورية، أو اليوم إن لم يُصرف له بعد. */
function dueOn(s: SupplierDueOut, today: string): string {
  return s.last_payout ? addDays(isoDay(new Date(s.last_payout)), cycleOf(s)[1]) : today;
}

/** فترة الصرف: من اليوم التالي لآخر صرف (أو بداية دورية واحدة) إلى اليوم. */
function periodOf(s: SupplierDueOut, today: string): [string, string] {
  const from = s.last_payout ? addDays(isoDay(new Date(s.last_payout)), 1) : addDays(today, 1 - cycleOf(s)[1]);
  return [from > today ? today : from, today];
}

function statusOf(s: SupplierDueOut, today: string): [string, "warning" | "neutral" | "success"] {
  if (milli(s.payable) <= 0) return s.last_payout ? [`صُرف ${fmt.date(s.last_payout).slice(0, 5)}`, "success"] : ["لا مستحق", "neutral"];
  return dueOn(s, today) <= today ? ["حالّ اليوم", "warning"] : ["قادم", "neutral"];
}

export function SupplierPay() {
  const dues = useLoad(() => api.get<SupplierDueOut[]>("/api/admin/supplier-dues"));
  const [sel, setSel] = useState<number | null>(null);
  const [receipt, setReceipt] = useState<Receipt | null>(null);
  const today = fmt.today();
  const rows = dues.data ?? [];
  const s = rows.find((x) => x.id === sel) ?? rows.find((x) => milli(x.payable) > 0) ?? null;

  return (
    <div className="md-page">
      <PageHead title="صرف الموردين" />

      <DataTable<SupplierDueOut>
        rows={dues.data} loading={dues.loading} error={dues.error} onRetry={dues.reload}
        emptyIcon="banknote" emptyTitle="لا مستحقات حالّة" emptyBody="مستحقات كل مورد تظهر هنا في موعد دوريته."
        rowKey={(x) => x.id} onRowClick={(x) => setSel(x.id)}
        rowTone={(x) => statusOf(x, today)[1] === "warning" && "warning"}
        columns={[
          { key: "s", label: "المورد", render: (x) => <b className={x.id === s?.id ? "text-primary-text" : undefined}>{x.name}</b> },
          { key: "c", label: "الدورية", render: (x) => cycleOf(x)[0] },
          { key: "n", label: "موعد الصرف", render: (x) => { const d = dueOn(x, today); return d <= today ? "اليوم" : <Num>{fmt.date(d).slice(0, 5)}</Num>; } },
          { key: "d", label: "المستحق", money: true, render: (x) => <Money value={x.payable} /> },
          { key: "st", label: "الحالة", render: (x) => { const [l, t] = statusOf(x, today); return <StatusBadge tone={t}>{l}</StatusBadge>; } },
        ]} />

      {s ? (
        <div className="grid grid-cols-2 gap-5 items-start">
          <PayCard key={s.id} s={s} today={today} onDone={(list, r) => { dues.set(list); setReceipt(r); }} />
          <ReceiptCard r={receipt && receipt.supplier === s.name ? receipt : null} />
        </div>
      ) : null}
    </div>
  );
}

function PayCard({ s, today, onDone }: { s: SupplierDueOut; today: string; onDone: (l: SupplierDueOut[], r: Receipt) => void }) {
  const [from, to] = periodOf(s, today);
  const [amount, setAmount] = useState(milli(s.payable) > 0 ? fmt.money(s.payable) : "");
  const [confirm, setConfirm] = useState(false);
  const { busy, run } = useAction();
  const over = validMoney(amount) && milli(cleanMoney(amount)) > milli(s.payable);

  async function save() {
    const body: SupplierPayoutIn = { amount: cleanMoney(amount), period_start: from, period_end: to };
    const res = await run(() => api.post<SupplierDueOut[]>(`/api/admin/suppliers/${s.id}/payout`, body), "سُجِّل الصرف");
    if (res) {
      setConfirm(false);
      onDone(res, { supplier: s.name, amount: fromMilli(milli(cleanMoney(amount))), from, to, at: new Date().toISOString() });
      const left = res.find((x) => x.id === s.id);
      setAmount(left && milli(left.payable) > 0 ? fmt.money(left.payable) : "");
    }
  }

  return (
    <Section large title={`صرف لـ«${s.name}» — ${cycleOf(s)[0]}`} className="flex flex-col gap-3">
      <div className="flex justify-between text-14"><span className="text-ink-muted">الفترة</span>
        <Num>{fmt.date(from).slice(0, 5)} – {fmt.date(to)}</Num></div>
      <div className="flex justify-between text-14"><span className="text-ink-muted">المستحق</span><Money value={s.payable} /></div>
      <TextField label="المبلغ المصروف" value={amount} onChange={setAmount} numeric suffix="د.ل"
        error={amount && !validMoney(amount) ? "مبلغ غير صالح" : over ? `المستحق لـ${s.name} ${fmt.money(s.payable)} د.ل. عدّل المبلغ.` : null} />
      <Button icon="check" disabled={!validMoney(amount) || over} onClick={() => setConfirm(true)}>تسجيل الصرف وإصدار الإيصال</Button>
      <ConfirmDialog open={confirm} icon="banknote" title={`صرف مستحقات ${s.name}`}
        body={<>يُصرف <b className="md-num">{fmt.money(cleanMoney(amount))}</b> د.ل من الخزينة لـ{s.name} عن الفترة
          {" "}<Num>{fmt.date(from)} – {fmt.date(to)}</Num>. لا يُعدَّل بعد تسجيله.</>}
        confirmLabel="تأكيد الصرف" loading={busy} onConfirm={save} onCancel={() => setConfirm(false)} />
    </Section>
  );
}

function ReceiptCard({ r }: { r: Receipt | null }) {
  return (
    <Section large title="إيصال المورد (PDF)" right={<StatusBadge tone="primary" icon="shield-check">بلا بيانات عملاء</StatusBadge>}
      className="flex flex-col gap-2.5">
      {r ? (
        <>
          <div className="border border-solid border-border rounded-md p-4 flex flex-col gap-2 text-13">
            <b className="text-18 text-primary-text">مَدَد</b>
            <span className="font-bold">إيصال صرف مستحقات · {r.supplier}</span>
            <span className="text-ink-muted">الفترة <Num>{fmt.date(r.from)} – {fmt.date(r.to)}</Num> · صُرف <Num>{fmt.dateTime(r.at)}</Num></span>
            <span className="text-ink-muted">لا اسم عميل، ولا وجهة، ولا سعر بيع — بنيوياً.</span>
            <div className="flex justify-between font-bold border-0 border-t border-solid border-border pt-1.5">
              <span>المصروف</span><Money value={r.amount} />
            </div>
          </div>
          <Button variant="secondary" icon="file-text" onClick={() => window.print()}>حفظ PDF</Button>
        </>
      ) : (
        <span className="text-14 text-ink-muted">يصدر الإيصال بعد تسجيل الصرف: اسم المورد والفترة والمبلغ وحدها — لا اسم عميل، ولا وجهة، ولا سعر بيع.</span>
      )}
    </Section>
  );
}
