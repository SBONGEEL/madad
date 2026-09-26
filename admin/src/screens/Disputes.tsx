/** النزاعات: القائمة بتصفية الحالة؛ كل نزاع يُفتح في صفحته للقرار. */
import { useState } from "react";
import { useNavigate } from "react-router-dom";

import { qs } from "@ui/client";
import * as fmt from "@ui/fmt";
import { DataTable, Num, PageHead, Tabs, useLoad } from "@ui/kit";
import { api } from "@/api/client";
import type { DisputeRowOut } from "@/api/types";
import { DISPUTE_KIND, DisputeStatusBadge, OPENED_BY } from "@/lib/orders-shared";

type Filter = "open" | "resolved" | "all";

export function Disputes() {
  const nav = useNavigate();
  const [filter, setFilter] = useState<Filter>("open");
  const list = useLoad(() => api.get<DisputeRowOut[]>(`/api/admin/disputes${qs({ status: filter === "all" ? undefined : filter })}`), [filter]);

  return (
    <div className="md-page">
      <PageHead title="النزاعات" />
      <Tabs<Filter> value={filter} onChange={setFilter} tabs={[
        { value: "open", label: "مفتوحة" }, { value: "resolved", label: "مُقرَّرة" }, { value: "all", label: "الكل" },
      ]} />
      <DataTable<DisputeRowOut>
        rows={list.data} loading={list.loading} error={list.error} onRetry={list.reload}
        emptyIcon="circle-check"
        emptyTitle={filter === "resolved" ? "لا نزاعات مُقرَّرة" : "لا نزاعات مفتوحة"}
        emptyBody={filter === "resolved" ? undefined : "ما يفتحه عميل أو سائق من تطبيقه يظهر هنا لتقرّره."}
        rowKey={(d) => d.id} onRowClick={(d) => nav(`/disputes/${d.id}`)}
        columns={[
          { key: "order_id", label: "الطلبية", render: (d) => <Num>#{d.order_id}</Num> },
          { key: "kind", label: "النوع", render: (d) => DISPUTE_KIND[d.kind] ?? d.kind },
          { key: "customer_name", label: "المنشأة" },
          { key: "opened_by_role", label: "فتحه", render: (d) => OPENED_BY[d.opened_by_role] ?? d.opened_by_role },
          { key: "description", label: "الوصف", render: (d) => <span className="text-13 text-ink-muted">{d.description}</span> },
          { key: "created_at", label: "التاريخ", render: (d) => <Num>{fmt.dateTime(d.created_at)}</Num> },
          { key: "status", label: "الحالة", render: (d) => <DisputeStatusBadge status={d.status} /> },
        ]} />
    </div>
  );
}
