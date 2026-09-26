/** العملاء: المنشآت وحالاتها، والبحث بالاسم؛ السطر يفتح صفحة المنشأة. */
import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";

import { qs } from "@ui/client";
import * as fmt from "@ui/fmt";
import { DataTable, Num, PageHead, StatusBadge, TextField, useLoad } from "@ui/kit";
import { api } from "@/api/client";
import type { CustomerRowOut } from "@/api/types";
import { KIND_LABEL, PARTY_STATUS } from "@/lib/admin-labels";

export function Customers() {
  const nav = useNavigate();
  const [q, setQ] = useState("");
  const [term, setTerm] = useState("");
  useEffect(() => {
    const t = setTimeout(() => setTerm(q.trim()), 300);
    return () => clearTimeout(t);
  }, [q]);
  const list = useLoad(() => api.get<CustomerRowOut[]>(`/api/admin/customers${qs({ q: term || undefined })}`), [term]);

  return (
    <div className="md-page">
      <PageHead title="العملاء"
        actions={<div className="w-col-side"><TextField value={q} onChange={setQ} placeholder="ابحث باسم المنشأة" icon="search" /></div>} />
      <DataTable rows={list.data} loading={list.loading} error={list.error} onRetry={list.reload} rowKey={(r) => r.id}
        emptyIcon="users" emptyTitle={term ? "لا منشأة بهذا الاسم" : "لا عملاء بعد"} emptyBody={term ? "تأكد من الإملاء." : undefined}
        rowTone={(r) => r.status === "pending" && "warning"} onRowClick={(r) => nav(`/customers/${r.id}`)}
        columns={[
          { key: "c", label: "المنشأة", render: (r) => <b>{r.name}</b> },
          { key: "k", label: "النوع", render: (r) => KIND_LABEL[r.kind] ?? r.kind },
          { key: "b", label: "فروع", numeric: true, render: (r) => <Num>{fmt.int(r.branches)}</Num> },
          { key: "o", label: "طلبيات", numeric: true, render: (r) => <Num>{fmt.int(r.orders)}</Num> },
          { key: "s", label: "الحالة", render: (r) => { const [l, t] = PARTY_STATUS[r.status] ?? [r.status, "neutral" as const]; return <StatusBadge tone={t}>{l}</StatusBadge>; } },
        ]} />
    </div>
  );
}
