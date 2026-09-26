/**
 * 07 التسويات: حركات الشهر — تسليم كاش للخزينة (المبلغ، الخصم من الأجر، من استلمه، الوقت)، وصرف أجر، وأجر كل طلبية.
 * الكشف PDF متاح لأي شهر (لا إغلاق شهر في القاعدة، فلا حالة «الكشف غير جاهز»).
 */
import { useState } from "react";

import * as fmt from "@ui/fmt";
import { Button, EmptyState, ErrorState, Icon, LoadingState, Num, cx, useAction, useLoad } from "@ui/kit";
import type { IconName } from "@ui/icons";
import { qs } from "@ui/client";
import { api } from "@/api/client";
import type { SettlementOut } from "@/api/types";
import { accError, downloadStatement } from "@/lib/acc-http";
import { recentMonths, when } from "@/lib/acc-ui";
import { Screen } from "@/lib/shell";

export function Settlements() {
  const months = recentMonths(6);
  const [month, setMonth] = useState(months[0]?.value ?? "");
  const list = useLoad(() => api.get<SettlementOut[]>(`/api/driver/settlements${qs({ month })}`), [month]);
  const pdf = useAction();

  const download = () => pdf.run(async () => {
    try {
      await downloadStatement(month);
    } catch (e) {
      throw new Error(accError(e));
    }
  });

  return (
    <Screen title="التسويات" back="/wallet">
      <div className="md-hscroll" role="tablist" aria-label="الشهر">
        {months.map((m) => (
          <button key={m.value} type="button" role="tab" aria-selected={m.value === month}
            className={cx("md-chip", m.value === month && "md-chip-on")} onClick={() => setMonth(m.value)}>
            {m.label}
          </button>
        ))}
      </div>
      {list.loading && !list.data ? <LoadingState rows={5} />
        : list.error && !list.data ? (
          <div className="flex-1 flex flex-col justify-center"><ErrorState title={list.error.message} code={list.error.code} onRetry={list.reload} /></div>
        ) : !list.data?.length ? (
          <>
            <div className="flex-1 flex flex-col justify-center">
              <EmptyState icon="hand-coins" title="لا تسويات بعد" body="كل تسليم كاش للخزينة يُسجَّل هنا بمبلغه ووقته ومن استلمه." />
            </div>
            <PdfButton busy={pdf.busy} onClick={() => void download()} />
          </>
        ) : (
          <div className={cx("flex flex-col gap-2", list.loading && "opacity-70")}>
            {list.data.map((s) => <Row key={`${s.kind}-${s.id}`} s={s} />)}
            <PdfButton busy={pdf.busy} onClick={() => void download()} />
          </div>
        )}
    </Screen>
  );
}

function PdfButton({ busy, onClick }: { busy: boolean; onClick: () => void }) {
  return <Button block variant="secondary" icon="file-text" loading={busy} disabled={busy} onClick={onClick}>كشف الشهر PDF</Button>;
}

function Row({ s }: { s: SettlementOut }) {
  let icon: IconName = "wallet";
  let title: string;
  let sub: string;
  let value: string;
  let tone = "text-ink";
  const at = when(s.at);
  if (s.kind === "handover") {
    icon = "hand-coins";
    title = "سلّمت كاشاً للخزينة";
    sub = s.received_by ? `استلمه ${s.received_by} · ${at}` : at;
    value = `− ${fmt.money(s.amount)}`;
  } else if (s.kind === "payout") {
    icon = "banknote";
    title = "صُرف لك أجر";
    sub = s.received_by ? `صرفه ${s.received_by} · ${at}` : at;
    value = fmt.money(s.amount);
  } else {
    title = s.order_id ? `أجر الطلبية #${s.order_id}` : "أجر طلبية";
    sub = at;
    value = `+ ${fmt.money(s.amount)}`;
    tone = "text-success";
  }
  const offset = s.kind === "handover" && Number(s.offset_amount) > 0;
  return (
    <div className="bg-surface border border-border rounded-md p-3 flex items-center gap-2.5">
      <Icon name={icon} />
      <div className="flex-1 flex flex-col min-w-0">
        <span className="font-bold">{title}</span>
        <span className="text-13 text-ink-muted">{sub}</span>
        {offset ? <span className="text-13 text-ink-muted">خُصم منه أجرك <Num>{fmt.money(s.offset_amount)}</Num></span> : null}
      </div>
      <Num className={cx("font-bold shrink-0", tone)}>{value}</Num>
    </div>
  );
}
