/** تسوية السائقين (م-11): الكاش بحوزة كل سائق وأجره المستحق، والتسليم للخزينة (مع مقاصّة الأجر لطريقة «خصم من الكاش»)،
 * وصرف الأجر من الخزينة لطريقة «صرف دوري»، وتعديل الطريقة. */
import { useState } from "react";
import { useNavigate } from "react-router-dom";

import * as fmt from "@ui/fmt";
import {
  Button, ConfirmDialog, DataTable, Money, Num, PageHead, Section, Select, StatusBadge, TextField, useAction, useLoad,
} from "@ui/kit";
import { api } from "@/api/client";
import type { DriverSettleOut, HandoverIn, PayMethodIn, PayoutIn } from "@/api/types";
import { PAY_METHOD, cleanMoney, fromMilli, milli, validMoney } from "@/lib/money-util";
import { useSession } from "@/session";

function status(d: DriverSettleOut): [string, "error" | "warning" | "success" | "neutral"] {
  const cash = Number(d.cash_held);
  if (d.over_cap) return ["فوق السقف", "error"];
  if (d.cash_cap != null && Number(d.cash_cap) > 0 && cash >= Number(d.cash_cap) * 0.8) return ["قارب السقف", "warning"];
  if (cash === 0 && Number(d.wallet_owed) === 0) return ["لا رصيد", "neutral"];
  return ["نشط", "success"];
}

function MethodBadge({ m }: { m: string | null }) {
  const [label, tone] = (m && PAY_METHOD[m]) || ["غير محددة", "neutral"];
  return <StatusBadge tone={tone}>{label}</StatusBadge>;
}

export function DriverSettle() {
  const list = useLoad(() => api.get<DriverSettleOut[]>("/api/admin/drivers/settlement"));
  const [sel, setSel] = useState<number | null>(null);
  const { can } = useSession();
  const nav = useNavigate();
  const rows = list.data ?? [];
  const driver = rows.find((d) => d.id === sel) ?? rows.find((d) => Number(d.cash_held) > 0) ?? rows[0] ?? null;

  return (
    <div className="md-page">
      <PageHead title="تسوية السائقين" sub="طريقة صرف الأجر تُختار لكل سائق عند اعتماده، وتُعدَّل من ملفه هنا."
        actions={can("orders") ? <Button variant="secondary" icon="package" onClick={() => nav("/drivers/custody")}>الأمانات</Button> : undefined} />

      <DataTable<DriverSettleOut>
        rows={list.data} loading={list.loading} error={list.error} onRetry={list.reload}
        emptyIcon="hand-coins" emptyTitle="لا كاش عند السائقين" emptyBody="كل التحصيلات سُلِّمت للخزينة."
        rowKey={(d) => d.id} onRowClick={(d) => setSel(d.id)}
        rowTone={(d) => { const t = status(d)[1]; return t === "error" || t === "warning" ? t : null; }}
        columns={[
          { key: "d", label: "السائق", render: (d) => <b className={d.id === driver?.id ? "text-primary-text" : undefined}>{d.full_name}</b> },
          { key: "m", label: "طريقة صرف الأجر", render: (d) => <MethodBadge m={d.pay_method} /> },
          { key: "c", label: "الكاش بحوزته", money: true, render: (d) => <Money value={d.cash_held} /> },
          { key: "w", label: "أجره المستحق", money: true, render: (d) => <Money value={d.wallet_owed} /> },
          { key: "s", label: "الحالة", render: (d) => { const [l, t] = status(d); return <StatusBadge tone={t}>{l}</StatusBadge>; } },
        ]} />

      {driver ? (
        <div className="grid grid-cols-2 gap-5 items-start">
          <Handover key={`h${driver.id}`} d={driver} onDone={list.set} />
          {driver.pay_method === "periodic" ? <Payout key={`p${driver.id}`} d={driver} onDone={list.set} /> : null}
        </div>
      ) : null}
    </div>
  );
}

function Handover({ d, onDone }: { d: DriverSettleOut; onDone: (l: DriverSettleOut[]) => void }) {
  const [confirm, setConfirm] = useState(false);
  const { busy, run } = useAction();
  const m = useAction();
  const offsetMode = d.pay_method === "offset_on_settlement";
  const cashM = milli(d.cash_held);
  const offsetM = offsetMode ? Math.max(0, Math.min(cashM, milli(d.wallet_owed))) : 0;
  const offset = fromMilli(offsetM), hand = fromMilli(Math.max(0, cashM - offsetM));
  const handPositive = cashM - offsetM > 0;

  async function save() {
    const body: HandoverIn = { amount: hand, wallet_offset: offset };
    const res = await run(() => api.post<DriverSettleOut[]>(`/api/admin/drivers/${d.id}/handover`, body), "سُجِّل التسليم");
    if (res) { onDone(res); setConfirm(false); }
  }

  async function setMethod(pay_method: string) {
    const body: PayMethodIn = { pay_method };
    const res = await m.run(() => api.put<DriverSettleOut[]>(`/api/admin/drivers/${d.id}/pay-method`, body), "عُدِّلت طريقة صرف الأجر");
    if (res) onDone(res);
  }

  return (
    <Section title={`تسوية ${d.full_name}`} right={<MethodBadge m={d.pay_method} />} className="flex flex-col gap-2.5">
      <div className="flex justify-between text-14"><span>الكاش بحوزته</span><Money value={d.cash_held} /></div>
      {offsetMode ? <div className="flex justify-between text-14"><span>ناقص أجره المستحق</span><Money value={-offsetM / 1000} /></div> : null}
      <div className="flex justify-between text-16 font-bold border-0 border-t border-solid border-border pt-2">
        <span>يسلّم للخزينة</span><Money value={hand} />
      </div>
      <Button icon="check" disabled={!handPositive} onClick={() => setConfirm(true)}>
        {offsetM > 0 ? "تسجيل التسليم والمقاصّة" : "تسجيل التسليم"}
      </Button>
      <Select label="طريقة صرف الأجر" value={d.pay_method ?? ""} disabled={m.busy} onChange={(v) => v && v !== d.pay_method && setMethod(v)}
        options={[...(d.pay_method ? [] : [{ value: "", label: "غير محددة" }]),
          { value: "offset_on_settlement", label: "خصم من الكاش" }, { value: "periodic", label: "صرف دوري" }]} />
      <ConfirmDialog open={confirm} icon="hand-coins" title={`تسليم كاش ${d.full_name}`}
        body={<>تستلم الخزينة <b className="md-num">{fmt.money(hand)}</b> د.ل من {d.full_name}
          {offsetM > 0 ? <>، ويُقتطع أجره المستحق <b className="md-num">{fmt.money(offset)}</b> د.ل من الكاش مقاصّةً</> : null}. لا يُعدَّل بعد تسجيله.</>}
        confirmLabel="تأكيد التسليم" loading={busy} onConfirm={save} onCancel={() => setConfirm(false)} />
    </Section>
  );
}

function Payout({ d, onDone }: { d: DriverSettleOut; onDone: (l: DriverSettleOut[]) => void }) {
  const [amount, setAmount] = useState(fmt.money(d.wallet_owed));
  const [confirm, setConfirm] = useState(false);
  const { busy, run } = useAction();
  const over = validMoney(amount) && milli(cleanMoney(amount)) > milli(d.wallet_owed);

  async function save() {
    const body: PayoutIn = { amount: cleanMoney(amount) };
    const res = await run(() => api.post<DriverSettleOut[]>(`/api/admin/drivers/${d.id}/payout`, body), "سُجِّل الصرف");
    if (res) {
      onDone(res);
      setConfirm(false);
      const left = res.find((x) => x.id === d.id);
      setAmount(fmt.money(left?.wallet_owed ?? 0));
    }
  }

  return (
    <Section title={`صرف أجر ${d.full_name}`} right={<MethodBadge m={d.pay_method} />} className="flex flex-col gap-2.5">
      <div className="flex justify-between text-14"><span>أجره المستحق</span><Money value={d.wallet_owed} /></div>
      <TextField label="المبلغ المصروف" value={amount} onChange={setAmount} numeric suffix="د.ل"
        error={amount && !validMoney(amount) ? "مبلغ غير صالح" : over ? "أكبر من أجره المستحق" : null} />
      <Button icon="banknote" disabled={!validMoney(amount) || over} onClick={() => setConfirm(true)}>تسجيل الصرف من الخزينة</Button>
      <span className="text-12 text-ink-muted">كاشه يُسلَّم كاملاً في التسوية، والأجر يُصرف منفصلاً.</span>
      <ConfirmDialog open={confirm} icon="banknote" title={`صرف أجر ${d.full_name}`}
        body={<>يُصرف <b className="md-num">{fmt.money(cleanMoney(amount))}</b> د.ل من الخزينة لـ{d.full_name}
          {" "}من أجره المستحق (<Num>{fmt.money(d.wallet_owed)}</Num>). لا يُعدَّل بعد تسجيله.</>}
        confirmLabel="تأكيد الصرف" loading={busy} onConfirm={save} onCancel={() => setConfirm(false)} />
    </Section>
  );
}
