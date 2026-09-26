/** الدفتر: الحسابات بأرصدتها، والحركات بقيودها (مدين/دائن) مع التصفية، وتسجيل مصروف. */
import { useMemo, useState } from "react";

import * as fmt from "@ui/fmt";
import { qs } from "@ui/client";
import {
  Button, ConfirmDialog, DataTable, Dialog, Loader, Money, Num, PageHead, Select, StatCard, TextField, cx, useAction, useLoad,
} from "@ui/kit";
import { api } from "@/api/client";
import type { AccountOut, ExpenseIn, TxnOut } from "@/api/types";
import { downloadCsv } from "@/lib/csv";
import { ACCOUNT_KIND, TXN_KIND, accountName, cleanMoney, entryAccountName, validMoney } from "@/lib/money-util";

const ROW = "flex justify-between items-center gap-2 w-full rounded-md border-0 text-ink font-sans text-start cursor-pointer";

interface EntryRow { key: string; first: boolean; txn: TxnOut; account: string; dr: string | null; cr: string | null }

export function Ledger() {
  const accounts = useLoad(() => api.get<AccountOut[]>("/api/admin/ledger/accounts"));
  const [kind, setKind] = useState("");
  const [orderId, setOrderId] = useState("");
  const [accountId, setAccountId] = useState<number | null>(null);
  const [openKind, setOpenKind] = useState<string | null>(null);
  const orderQ = /^\d+$/.test(orderId.trim()) ? Number(orderId.trim()) : null;
  const txns = useLoad(
    () => api.get<TxnOut[]>(`/api/admin/ledger/transactions${qs({ kind, order_id: orderQ, account_id: accountId })}`),
    [kind, orderQ, accountId],
  );

  const accs = accounts.data ?? [];
  const sum = (k: string) => accs.filter((a) => a.kind === k).reduce((s, a) => s + Number(a.balance), 0);
  const nonZero = (k: string) => accs.filter((a) => a.kind === k && Number(a.balance) !== 0).length;
  const groups = ACCOUNT_KIND.map(([k, name]) => ({ k, name, list: accs.filter((a) => a.kind === k), bal: sum(k) }))
    .filter((g) => g.list.length);
  const selected = accs.find((a) => a.id === accountId) ?? null;

  const rows = useMemo<EntryRow[]>(() => (txns.data ?? []).flatMap((t) => t.entries.map((e, i) => {
    const n = Number(e.amount);
    return { key: `${t.id}-${i}`, first: i === 0, txn: t, account: entryAccountName(e.account),
      dr: n > 0 ? e.amount : null, cr: n < 0 ? String(-n) : null };
  })), [txns.data]);

  const heading = orderQ != null ? <>حركات الطلبية <Num>#{orderQ}</Num></>
    : selected ? <>حركات: {accountName(selected.kind, selected.party)}</> : "الحركات";

  function pickKind(k: string, list: AccountOut[]) {
    if (list.length === 1) {
      const id = list[0]?.id ?? null;
      setAccountId(accountId === id ? null : id);
      setOpenKind(null);
    } else setOpenKind(openKind === k ? null : k);
  }

  function exportCsv() {
    downloadCsv(`madad-ledger-${fmt.today()}.csv`, ["الحركة", "التاريخ", "الطلبية", "البيان", "الحساب", "مدين", "دائن"],
      rows.map((r) => [`${TXN_KIND[r.txn.kind] ?? r.txn.kind} #${r.txn.id}`, fmt.dateTime(r.txn.occurred_at),
        r.txn.order_id ? `#${r.txn.order_id}` : "", r.txn.memo, r.account, r.dr ? fmt.money(r.dr) : "", r.cr ? fmt.money(r.cr) : ""]));
  }

  return (
    <div className="md-page">
      <PageHead title="الدفتر" sub="دفتر واحد بقيد مزدوج: كل حركة مجموع قيودها صفر. لا تُعدَّل حركة؛ التصحيح بحركة عكسية."
        actions={<>
          <Button variant="secondary" icon="file-text" onClick={exportCsv} disabled={!rows.length}>CSV</Button>
          <Button variant="secondary" icon="file-text" onClick={() => window.print()} disabled={!rows.length}>PDF</Button>
          <ExpenseButton onDone={(list) => { accounts.set(list); txns.reload(); }} />
        </>} />

      <div className="grid grid-cols-4 gap-4">
        <StatCard label="الخزينة (كاش بيد المالك)" value={String(sum("treasury"))} money icon="wallet" />
        <StatCard label="كاش بحوزة السائقين" value={String(sum("driver_cash"))} money icon="truck"
          note={nonZero("driver_cash") ? `${nonZero("driver_cash")} سائقين` : undefined} />
        <StatCard label="مستحقات الموردين" value={String(-sum("supplier_payable"))} money icon="store"
          note={nonZero("supplier_payable") ? `${nonZero("supplier_payable")} مورداً` : undefined} />
        <StatCard label="أجور السائقين المستحقة" value={String(-sum("driver_wallet"))} money icon="hand-coins" />
      </div>

      <div className="flex gap-5 items-start">
        <section className="md-card p-3 flex flex-col gap-1 w-col-side shrink-0">
          <span className="text-12 font-bold text-ink-muted px-2 py-1">الحسابات</span>
          <Loader state={accounts} rows={6}>
            {() => groups.map((g) => {
              const on = g.list.some((a) => a.id === accountId);
              return (
                <div key={g.k} className="flex flex-col">
                  <button type="button" onClick={() => pickKind(g.k, g.list)}
                    className={cx(ROW, "p-2 text-14", on ? "bg-primary-tint font-bold" : "bg-transparent")}>
                    <span>{g.name}</span><Money value={g.bal} size="sm" />
                  </button>
                  {openKind === g.k && g.list.length > 1 ? g.list.map((a) => (
                    <button key={a.id} type="button" onClick={() => setAccountId(accountId === a.id ? null : a.id)}
                      className={cx(ROW, "py-1.5 pe-2 ps-5 text-13", a.id === accountId ? "bg-primary-tint font-bold" : "bg-transparent")}>
                      <span>{a.party ?? g.name}</span><Money value={a.balance} size="sm" />
                    </button>
                  )) : null}
                </div>
              );
            })}
          </Loader>
        </section>

        <div className="flex-1 min-w-0 flex flex-col gap-2.5">
          <div className="flex justify-between items-end gap-3 flex-wrap">
            <h2 className="md-sec-title-lg">{heading}</h2>
            <div className="flex gap-2 items-end">
              <Select label="نوع الحركة" value={kind} onChange={setKind}
                options={[{ value: "", label: "كل الحركات" }, ...Object.entries(TXN_KIND).map(([value, label]) => ({ value, label }))]} />
              <TextField label="رقم الطلبية" value={orderId} onChange={setOrderId} numeric placeholder="#" />
              {kind || orderId || accountId ? (
                <Button variant="ghost" icon="x" onClick={() => { setKind(""); setOrderId(""); setAccountId(null); setOpenKind(null); }}>مسح</Button>
              ) : null}
            </div>
          </div>
          <DataTable<EntryRow>
            rows={txns.data ? rows : null} loading={txns.loading} error={txns.error} onRetry={txns.reload}
            emptyIcon="book-open" emptyTitle="لا حركات في هذه الفترة" emptyBody="اختر فترة أخرى، أو انتظر أول طلبية تُسلَّم."
            rowKey={(r) => r.key}
            columns={[
              { key: "k", label: "الحركة", render: (r) => r.first ? (
                <span className="flex flex-col">
                  <b>{TXN_KIND[r.txn.kind] ?? r.txn.kind}{r.txn.order_id ? <> · <Num>#{r.txn.order_id}</Num></> : null}</b>
                  <span className="text-12 text-ink-muted"><Num>{fmt.dateTime(r.txn.occurred_at)}</Num> · {r.txn.memo}</span>
                </span>
              ) : null },
              { key: "a", label: "الحساب", render: (r) => r.account },
              { key: "dr", label: "مدين", money: true, render: (r) => r.dr ? <Money value={r.dr} /> : null },
              { key: "cr", label: "دائن", money: true, render: (r) => r.cr ? <Money value={r.cr} /> : null },
            ]} />
        </div>
      </div>
    </div>
  );
}

/** «مصروف»: نموذج ثم تأكيد يذكر المبلغ. يعيد الخادم الحسابات محدَّثة. */
function ExpenseButton({ onDone }: { onDone: (list: AccountOut[]) => void }) {
  const [step, setStep] = useState<"form" | "confirm" | null>(null);
  const [category, setCategory] = useState("");
  const [amount, setAmount] = useState("");
  const [day, setDay] = useState(fmt.today());
  const [note, setNote] = useState("");
  const { busy, run } = useAction();
  const ok = category.trim() && validMoney(amount) && day;

  async function save() {
    const body: ExpenseIn = { category: category.trim(), amount: cleanMoney(amount), spent_on: day, note: note.trim() || null };
    const list = await run(() => api.post<AccountOut[]>("/api/admin/expenses", body), "سُجِّل المصروف");
    if (list) {
      onDone(list);
      setStep(null);
      setCategory(""); setAmount(""); setNote("");
    }
  }

  return (
    <>
      <Button icon="plus" onClick={() => setStep("form")}>مصروف</Button>
      <Dialog open={step === "form"} onClose={() => setStep(null)} label="مصروف">
        <div className="md-dialog-title">مصروف</div>
        <div className="flex flex-col gap-3">
          <TextField label="البند" value={category} onChange={setCategory} required placeholder="إيجار، وقود، صيانة…" autoFocus />
          <TextField label="المبلغ" value={amount} onChange={setAmount} numeric suffix="د.ل" required
            error={amount && !validMoney(amount) ? "مبلغ غير صالح" : null} />
          <TextField label="التاريخ" value={day} onChange={setDay} type="date" ltr icon="clock" required />
          <TextField label="ملاحظة" value={note} onChange={setNote} />
        </div>
        <div className="md-dialog-actions">
          <Button block icon="check" disabled={!ok} onClick={() => setStep("confirm")}>تسجيل المصروف</Button>
          <Button variant="ghost" block onClick={() => setStep(null)}>إلغاء</Button>
        </div>
      </Dialog>
      <ConfirmDialog open={step === "confirm"} tone="warning" icon="banknote" title="تسجيل مصروف"
        body={<>يُقيَّد <b className="md-num">{fmt.money(cleanMoney(amount))}</b> د.ل مصروفاً «{category.trim()}» من الخزينة بتاريخ <Num>{fmt.date(day)}</Num>. لا يُعدَّل بعد تسجيله.</>}
        confirmLabel="تأكيد المصروف" loading={busy} onConfirm={save} onCancel={() => setStep("form")} />
    </>
  );
}
