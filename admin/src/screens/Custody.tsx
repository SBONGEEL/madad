/** الأمانات بعهدة السائقين: بضاعة جُمعت لطلبيات أُلغيت ولم تُسلَّم، وقرار مصيرها. */
import { useState } from "react";
import { useNavigate } from "react-router-dom";

import { qs } from "@ui/client";
import * as fmt from "@ui/fmt";
import { Button, DataTable, Dialog, Num, PageHead, Section, StatCard, Tabs, useLoad } from "@ui/kit";
import { api } from "@/api/client";
import type { CustodyOut } from "@/api/types";
import { CustodyBadge } from "@/lib/orders-shared";
import { FateCard } from "./DisputeDetail";

type View = "open" | "all";

export function Custody() {
  const nav = useNavigate();
  const [view, setView] = useState<View>("open");
  const list = useLoad(() => api.get<CustodyOut[]>(`/api/admin/custody${qs({ open_only: view === "open" })}`), [view]);
  const [decide, setDecide] = useState<CustodyOut | null>(null);

  const rows = list.data ?? [];
  const pending = rows.filter((r) => r.status !== "resolved");
  const seesCost = rows.some((r) => r.value !== undefined);
  const openValue = pending.reduce((s, r) => s + Number(r.value ?? 0), 0);
  const blocked = [...new Map(pending.map((r) => [r.driver_id, r.driver_name])).entries()];

  return (
    <div className="md-page">
      <PageHead title="الأمانات بعهدة السائقين"
        sub="بضاعة جُمعت لطلبيات أُلغيت ولم تُسلَّم. قيمتها في الدفتر (أمانة سائق)، وتسوية السائق لا تُقفل قبل حسمها." />

      <div className="grid grid-cols-3 gap-4 items-start">
        {seesCost ? <StatCard label="قيمة الأمانات المفتوحة" value={openValue} money icon="package" /> : null}
        <StatCard label="سائقون عليهم أمانة" value={fmt.int(blocked.length)} icon="truck" />
        <StatCard label="تسويات موقوفة بسببها" value={fmt.int(blocked.length)} icon="hand-coins"
          note={blocked.length ? blocked.map(([, n]) => n).join("، ") : undefined} />
      </div>

      <Section title={view === "open" ? "المفتوحة" : "كل الأمانات"}
        right={<Tabs<View> value={view} onChange={setView} tabs={[{ value: "open", label: "المفتوحة" }, { value: "all", label: "الكل" }]} />}>
        <DataTable<CustodyOut>
          rows={list.data} loading={list.loading} error={list.error} onRetry={list.reload}
          emptyIcon="circle-check" emptyTitle="لا أمانات مفتوحة" emptyBody="كل ما جُمع لطلبيات ملغاة حُسم مصيره."
          rowKey={(r) => r.id} rowTone={(r) => r.status === "open" && "warning"}
          columns={[
            { key: "driver_name", label: "السائق" },
            { key: "item", label: "الصنف" },
            { key: "qty", label: "الكمية", numeric: true, render: (r) => <Num>{fmt.qty(r.qty)}</Num> },
            ...(seesCost ? [{ key: "value", label: "التكلفة", money: true }] : []),
            { key: "order_id", label: "من الطلبية", render: (r) => <Num>#{r.order_id}</Num> },
            { key: "status", label: "الحالة", render: (r) => <CustodyBadge status={r.status} fate={r.fate} target={r.target} /> },
            {
              key: "x", label: "", render: (r) => r.status === "open"
                ? (r.dispute_id
                  ? <Button size="sm" variant="secondary" onClick={() => nav(`/disputes/${r.dispute_id}`)}>قرّر من النزاع</Button>
                  : <Button size="sm" variant="secondary" onClick={() => setDecide(r)}>قرّر</Button>)
                : r.dispute_id ? <Button size="sm" variant="secondary" onClick={() => nav(`/disputes/${r.dispute_id}`)}>عرض</Button> : null,
            },
          ]} />
      </Section>

      {blocked.map(([id, name]) => (
        <div key={id} className="bg-warning-tint rounded-md py-2.5 px-3 text-13 leading-20">
          <b>تسوية {name} موقوفة:</b> عليه أمانة غير محسومة ({pending.filter((r) => r.driver_id === id).map((r) => `${r.item} ${fmt.qty(r.qty)}`).join("، ")}).
          {" "}قرّر مصيرها من النزاع ثم أكمل التسوية.
        </div>
      ))}

      <Dialog open={!!decide} wide onClose={() => setDecide(null)} label="مصير البضاعة">
        {decide ? <FateCard rows={[decide]} onDone={() => { setDecide(null); list.reload(); }} /> : null}
      </Dialog>
    </div>
  );
}
