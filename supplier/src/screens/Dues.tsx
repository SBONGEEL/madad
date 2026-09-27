/**
 * 05 المستحقات والدفعات: رصيدي الآن ودورية الصرف، وما استُلم مني بسعري × الكمية المستلمة فعلاً، ودفعاتي وإيصالاتها.
 * موعد الصرف التالي («التالي اليوم بعد 17:00») بلا مصدر في القاعدة (NO-DB) فلا يُعرض.
 */
import { useState } from "react";

import * as fmt from "@ui/fmt";
import { Button, DataTable, EmptyState, ErrorState, Icon, LoadingState, Money, Note, Num, useAction, useLoad } from "@ui/kit";
import { api } from "@/api/client";
import type { DuesOut, PayoutOut, ReceivedOut } from "@/api/types";
import { accError, downloadDuesPdf } from "@/lib/acc-http";
import { CYCLE, lineQty } from "@/lib/acc-ui";
import { HomeHeader } from "@/lib/shell";

export function Dues() {
  const dues = useLoad(() => api.get<DuesOut>(`/api/supplier/dues`));
  const d = dues.data;
  return (
    <>
      <HomeHeader />
      <main className="md-mobile-main">
        {dues.loading && !d ? (
          <div className="flex flex-col gap-3"><span className="md-skel rounded-lg h-row" /><LoadingState rows={4} /></div>
        ) : dues.error && !d ? (
          <div className="flex-1 flex flex-col justify-center"><ErrorState title={dues.error.message} code={dues.error.code} onRetry={dues.reload} /></div>
        ) : d && !d.received.length && !d.payouts.length && Number(d.due) === 0 ? (
          <div className="flex-1 flex flex-col justify-center">
            <EmptyState icon="wallet" title="لا مستحقات بعد" body="بعد أول استلام تُحسب مستحقاتك بسعرك × الكمية المستلمة فعلاً." />
          </div>
        ) : d ? <Filled d={d} /> : null}
      </main>
    </>
  );
}

function Filled({ d }: { d: DuesOut }) {
  const pdf = useAction();
  const [which, setWhich] = useState<number | "all" | null>(null);
  const download = (payoutId?: number) => {
    setWhich(payoutId ?? "all");
    void pdf.run(() => downloadDuesPdf(payoutId).catch((e: unknown) => { throw new Error(accError(e)); })).finally(() => setWhich(null));
  };
  const cycle = d.payout_cycle ? CYCLE[d.payout_cycle] ?? d.payout_cycle : null;
  const cols = [
    { key: "d", label: "اليوم", render: (r: ReceivedOut) => <Num>{r.received_at ? fmt.date(r.received_at).slice(0, 5) : "—"}</Num> },
    { key: "i", label: "الصنف", render: (r: ReceivedOut) => r.product_name },
    { key: "q", label: "المستلم", numeric: true, render: (r: ReceivedOut) => <Num>{lineQty(r.collected_qty, r.unit, r.unit_size)}</Num> },
    { key: "t", label: "المبلغ", money: true, render: (r: ReceivedOut) => (r.amount != null ? <Money value={r.amount} /> : "—") },
  ];
  return (
    <div className="flex flex-col gap-3">
      <section className="bg-primary text-on-primary rounded-lg p-4 flex flex-col gap-1">
        <span className="text-14 text-on-primary-muted">مستحقاتك الآن</span>
        <span className="text-26 font-bold text-end"><Money value={d.due} /></span>
        <span className="text-13 text-on-primary-muted">
          {cycle ? `الصرف ${cycle}` : "دورية الصرف تُحدَّد مع مَدَد عند الاعتماد"}
          {d.next_payout_on ? <> · التالي <Num>{fmt.weekday(new Date(d.next_payout_on))} {fmt.date(d.next_payout_on)}</Num></> : null}
        </span>
      </section>
      <Button variant="secondary" icon="file-text" loading={which === "all"} disabled={pdf.busy} onClick={() => download()}>كشف المستحقات PDF</Button>

      <span className="font-bold">آخر الاستلامات</span>
      <DataTable columns={cols} rows={d.received} rowKey={(r) => r.id} emptyIcon="truck" emptyTitle="لا استلامات بعد" />

      <span className="font-bold">الدفعات</span>
      {!d.payouts.length ? <EmptyState compact icon="banknote" title="لا دفعات بعد" body="تُصرف مستحقاتك حسب الدورية المتفق عليها مع مَدَد." /> : null}
      {d.payouts.map((p) => <Payout key={p.id} p={p} busy={which === p.id} disabled={pdf.busy} onReceipt={() => download(p.id)} />)}
    </div>
  );
}

function Payout({ p, busy, disabled, onReceipt }: { p: PayoutOut; busy: boolean; disabled: boolean; onReceipt: () => void }) {
  return (
    <div className="bg-surface border border-border rounded-md p-3 flex flex-col gap-2">
      <div className="flex items-center gap-2.5">
        <Icon name="banknote" />
        <div className="flex-1 flex flex-col">
          <span className="font-bold"><Money value={p.amount} /></span>
          <span className="text-13 text-ink-muted">
            <Num>{fmt.dateTime(p.paid_at)}</Num> · الفترة <Num>{fmt.date(p.period_start)}</Num> – <Num>{fmt.date(p.period_end)}</Num>
          </span>
        </div>
        <Button size="sm" variant="secondary" icon="file-text" loading={busy} disabled={disabled} onClick={onReceipt}>الإيصال</Button>
      </div>
      {!p.receipt_ready ? (
        <Note tone="warning">الإيصال غير جاهز: يُصدر خلال دقائق من تسجيل الدفعة. تستطيع الآن تنزيل كشف مولَّد لهذه الدفعة.</Note>
      ) : null}
    </div>
  );
}
