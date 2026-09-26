/** سحوبات المالك من الأرباح (م-21). قبل التأكيد: معاينة حيّة (م-26) — تجاوز الربح تنبيهٌ بلا منع ويُعلَّم في السجل،
 * وتجاوز نقد الخزينة ممنوع. */
import { useState } from "react";

import * as fmt from "@ui/fmt";
import { qs } from "@ui/client";
import {
  Button, ConfirmDialog, DataTable, Money, Note, Num, PageHead, Section, StatCard, StatusBadge, TextField, useAction, useLoad,
} from "@ui/kit";
import { api } from "@/api/client";
import type { WithdrawalIn, WithdrawalOut, WithdrawalPreviewOut, WithdrawalsOut } from "@/api/types";
import { cleanMoney, useDebounced, validMoney } from "@/lib/money-util";

export function Withdrawals() {
  const list = useLoad(() => api.get<WithdrawalsOut>("/api/admin/withdrawals"));
  const [amount, setAmount] = useState("");
  const [day, setDay] = useState(fmt.today());
  const [note, setNote] = useState("");
  const [confirm, setConfirm] = useState<WithdrawalPreviewOut | null>(null);
  const { busy, run } = useAction();

  const typed = validMoney(amount) ? cleanMoney(amount) : "0";
  const debounced = useDebounced(typed, 350);
  // المعاينة تُطلب مع كل مبلغ مكتوب (مؤجَّلة)، وبالمبلغ صفر تعطي الربح المتاح للبطاقة؛ وتُعاد بعد كل سحب
  const preview = useLoad(
    () => api.get<WithdrawalPreviewOut>(`/api/admin/withdrawals/preview${qs({ amount: debounced })}`),
    [debounced, list.data],
  );
  const pv = preview.data && preview.data.amount !== undefined && Number(preview.data.amount) === Number(typed) && typed !== "0"
    ? preview.data : null;

  const year = new Date().getFullYear();
  const entries = list.data?.entries ?? [];
  const yearTotal = entries.filter((e) => e.occurred_on.startsWith(String(year))).reduce((s, e) => s + Number(e.amount), 0);
  const ok = validMoney(amount) && day && note.trim() && pv && !pv.blocked && !preview.loading;

  async function openConfirm() {
    // معاينة نهائية للمبلغ نفسه لحظة الضغط، لا ما عُرض قبل ثوانٍ
    const fresh = await run(() => api.get<WithdrawalPreviewOut>(`/api/admin/withdrawals/preview${qs({ amount: cleanMoney(amount) })}`));
    if (fresh && !fresh.blocked) setConfirm(fresh);
    else if (fresh) preview.set(fresh);
  }

  async function save() {
    const body: WithdrawalIn = { amount: cleanMoney(amount), occurred_on: day, note: note.trim() };
    const res = await run(() => api.post<WithdrawalsOut>("/api/admin/withdrawals", body), "سُجِّل السحب");
    if (res) {
      list.set(res);
      setConfirm(null);
      setAmount("");
      setNote("");
    }
  }

  return (
    <div className="md-page">
      <PageHead title="سحوبات المالك"
        sub="ما يأخذه المالك من الأرباح. كل سحب قيد في الدفتر: من الخزينة إلى حساب السحوبات، ولا يُعدَّل بعد تسجيله."
        actions={<StatusBadge tone="primary" icon="shield-check">المالك فقط</StatusBadge>} />

      <div className="grid grid-cols-3 gap-4 items-start">
        <StatCard label={`سحوبات ${year}`} value={String(yearTotal)} money icon="wallet" />
        <StatCard label="نقد الخزينة الآن" value={list.data?.treasury ?? preview.data?.treasury ?? "0"} money icon="banknote" note="السحب لا يتجاوزه" />
        <StatCard label="الربح المتاح للسحب" value={preview.data?.profit_available ?? "0"} money icon="chart-column" note="الربح المتراكم ناقص السحوبات" />
      </div>

      <div className="grid grid-cols-3 gap-4 items-start">
        <Section title="سحب جديد" className="flex flex-col gap-3">
          <TextField label="المبلغ" value={amount} onChange={setAmount} numeric suffix="د.ل" required
            error={amount && !validMoney(amount) ? "مبلغ غير صالح" : null} />
          {pv?.blocked ? (
            <Note tone="error"><b>المبلغ أكبر من نقد الخزينة.</b> في الخزينة <Num>{fmt.money(pv.treasury)}</Num> د.ل. لا يُسحب ما ليس فيها.</Note>
          ) : pv?.exceeds ? (
            <Note tone="warning"><b>السحب أكبر من الربح المتاح.</b> الفرق <Num>{fmt.money(pv.over_by)}</Num> د.ل يُؤخذ من رأس المال. مسموح، ويُعلَّم في السجل.</Note>
          ) : null}
          <TextField label="التاريخ" value={day} onChange={setDay} type="date" ltr icon="clock" required />
          <TextField label="ملاحظة" value={note} onChange={setNote} required />
          <Button icon="check" disabled={!ok} loading={busy && !confirm} onClick={openConfirm}>تسجيل السحب</Button>
        </Section>
        <Section title="السجل" className="col-span-2 flex flex-col gap-3">
          <DataTable<WithdrawalOut>
            rows={list.data?.entries} loading={list.loading} error={list.error} onRetry={list.reload}
            emptyIcon="wallet" emptyTitle="لا سحوبات بعد" emptyBody="كل سحب يظهر هنا بتاريخه وملاحظته."
            rowKey={(e) => e.id} rowTone={(e) => e.exceeds_profit && "warning"}
            columns={[
              { key: "d", label: "التاريخ", render: (e) => <Num>{fmt.date(e.occurred_on)}</Num> },
              { key: "a", label: "المبلغ", money: true, render: (e) => <Money value={e.amount} /> },
              { key: "n", label: "الملاحظة", render: (e) => e.note },
              { key: "b", label: "مقابل الربح", render: (e) => e.exceeds_profit ? (
                <StatusBadge tone="warning">
                  {e.profit_at_time != null
                    ? <>تجاوز الربح بـ <Num>{fmt.money(Math.max(0, Number(e.amount) - Number(e.profit_at_time)))}</Num></>
                    : "تجاوز الربح"}
                </StatusBadge>
              ) : "ضمن الربح" },
            ]} />
        </Section>
      </div>

      {confirm ? (
        confirm.exceeds ? (
          <ConfirmDialog open tone="warning" title="السحب أكبر من الربح المتاح"
            body={<>تسحب <b className="md-num">{fmt.money(confirm.amount)}</b> والربح المتاح <b className="md-num">{fmt.money(confirm.profit_available)}</b>.
              الفرق <b className="md-num">{fmt.money(confirm.over_by)}</b> يُؤخذ من رأس المال لا من الربح. السحب مسموح، ويُعلَّم في السجل.</>}
            confirmLabel="تأكيد السحب رغم ذلك" cancelLabel="تعديل المبلغ" loading={busy} onConfirm={save} onCancel={() => setConfirm(null)} />
        ) : (
          <ConfirmDialog open icon="wallet" title="تأكيد السحب"
            body={<>تسحب <b className="md-num">{fmt.money(confirm.amount)}</b> د.ل من الخزينة بتاريخ <Num>{fmt.date(day)}</Num>، ضمن الربح المتاح
              (<Num>{fmt.money(confirm.profit_available)}</Num>). لا يُعدَّل بعد تسجيله.</>}
            confirmLabel="تأكيد السحب" cancelLabel="تعديل المبلغ" loading={busy} onConfirm={save} onCancel={() => setConfirm(null)} />
        )
      ) : null}
    </div>
  );
}
