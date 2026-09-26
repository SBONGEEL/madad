/**
 * 15 التقارير لكل فرع (م-9): من الطلبيات المسلَّمة في الشهر. الصاحب يرى المنشأة كلها وكل فرع، والمسؤول فرعه وحده
 * (القاعدة تحصر الصفوف). «تنزيل التقرير PDF» بالرمز نفسه.
 */
import { useState } from "react";

import { qs } from "@ui/client";
import { Button, EmptyState, ErrorState, LoadingState, Money, Note, cx, useAction, useLoad } from "@ui/kit";
import { api } from "@/api/client";
import type { ReportOut } from "@/api/types";
import { downloadReportPdf } from "@/lib/acct-http";
import { Screen } from "@/lib/shell";
import { useSession } from "@/session";

const MONTHS = ["يناير", "فبراير", "مارس", "أبريل", "مايو", "يونيو", "يوليو", "أغسطس", "سبتمبر", "أكتوبر", "نوفمبر", "ديسمبر"];

/** الشهر الحالي وخمسة قبله: YYYY-MM واسمه. */
function lastMonths(n = 6): Array<{ value: string; label: string }> {
  const now = new Date();
  return Array.from({ length: n }, (_, i) => {
    const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
    const name = MONTHS[d.getMonth()] ?? "";
    return {
      value: `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`,
      label: d.getFullYear() === now.getFullYear() ? name : `${name} ${d.getFullYear()}`,
    };
  });
}

const orders = (n: number) => (n === 1 ? "طلبية واحدة" : n === 2 ? "طلبيتان" : `${n} طلبية`);

export function Reports() {
  const { isOwner } = useSession();
  const months = lastMonths();
  const [month, setMonth] = useState(months[0]?.value ?? "");
  const rep = useLoad(() => api.get<ReportOut>(`/api/customer/reports${qs({ month })}`), [month]);
  const pdf = useAction();
  const label = months.find((m) => m.value === month)?.label ?? month;
  const r = rep.data && rep.data.month === month ? rep.data : null;

  return (
    <Screen title="التقارير">
      <div role="tablist" aria-label="الشهر" className="md-hscroll">
        {months.map((m) => (
          <button key={m.value} type="button" role="tab" aria-selected={m.value === month}
            className={cx("md-chip", m.value === month && "md-chip-on")} onClick={() => setMonth(m.value)}>{m.label}</button>
        ))}
      </div>
      {rep.loading && !r ? <LoadingState rows={2} />
        : rep.error && !r ? (
          <div className="flex-1 flex flex-col justify-center">
            <ErrorState compact title={rep.error.code === "forbidden_branch" ? "هذا الفرع ليس فرعك" : rep.error.message}
              body={rep.error.code === "forbidden_branch" ? "تقارير الفروع الأخرى لصاحب المنشأة." : undefined} code={rep.error.code} onRetry={rep.reload} />
          </div>
        ) : !r ? null
        : r.orders === 0 ? (
          <div className="flex-1 flex flex-col justify-center">
            <EmptyState icon="chart-column" title="لا طلبيات في الفترة" body="التقرير يُحسب من الطلبيات المسلَّمة." />
          </div>
        ) : isOwner ? (
          <>
            <section className="bg-primary text-on-primary rounded-lg p-4 flex flex-col gap-1">
              <span className="text-14 text-on-primary-muted">المنشأة كلها — {label}</span>
              <Money value={r.amount} size="lg" />
              <span className="text-13 text-on-primary-muted">{orders(r.orders)}</span>
            </section>
            <div className="flex flex-col gap-2.5">
              {r.branches.map((b) => (
                <div key={b.id} className="bg-surface border border-border rounded-md p-3 flex justify-between items-center gap-2">
                  <span className="flex flex-col">
                    <b>{b.name}</b>
                    <span className="text-13 text-ink-muted">{b.status === "approved" ? orders(b.orders) : "بانتظار الاعتماد"}</span>
                  </span>
                  <Money value={b.amount} />
                </div>
              ))}
            </div>
          </>
        ) : (
          <>
            {r.branches.map((b) => (
              <section key={b.id} className="bg-primary text-on-primary rounded-lg p-4 flex flex-col gap-1">
                <span className="text-14 text-on-primary-muted">{b.name} — {label}</span>
                <Money value={b.amount} size="lg" />
                <span className="text-13 text-on-primary-muted">{orders(b.orders)}</span>
              </section>
            ))}
            <Note tone="info">ترى طلبيات فرعك وفواتيره فقط.</Note>
          </>
        )}
      {r && r.orders > 0 ? (
        <div className="mt-auto">
          <Button icon="file-text" variant="secondary" block loading={pdf.busy} onClick={() => void pdf.run(() => downloadReportPdf(month))}>
            {pdf.busy ? "جاري التنزيل" : "تنزيل التقرير PDF"}
          </Button>
        </div>
      ) : null}
    </Screen>
  );
}
