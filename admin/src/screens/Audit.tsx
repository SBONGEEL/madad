/** سجل التدقيق: كل تغيير في سعر أو حالة أو مال، بفاعله. السجل لا يُعدَّل ولا يُحذف. جداول التكلفة لمن يملك «التكاليف». */
import { useState } from "react";

import { qs } from "@ui/client";
import * as fmt from "@ui/fmt";
import { Button, DataTable, Num, PageHead, Select, StatusBadge, useLoad } from "@ui/kit";
import { api } from "@/api/client";
import type { AuditOut } from "@/api/types";
import { TABLE_LABEL, auditActor, auditChange, auditKind, auditTarget } from "@/lib/admin-labels";
import { downloadCsv } from "@/lib/csv";

const TABLES = [{ value: "", label: "كل الجداول" }, ...Object.entries(TABLE_LABEL).map(([value, label]) => ({ value, label }))];

export function Audit() {
  const [table, setTable] = useState("");
  const [filtering, setFiltering] = useState(false);
  const log = useLoad(() => api.get<AuditOut[]>(`/api/admin/audit${qs({ table: table || undefined })}`), [table]);

  function exportCsv() {
    downloadCsv(`madad-audit-${fmt.today()}.csv`, ["الوقت", "الفاعل", "النوع", "على", "التغيير"],
      (log.data ?? []).map((r) => [fmt.dateTime(r.at), auditActor(r.actor), auditKind(r.table_name, r.changes)[0],
        auditTarget(r.table_name, r.row_pk, r.changes), auditChange(r.table_name, r.op, r.changes)]));
  }

  return (
    <div className="md-page">
      <PageHead title="سجل التدقيق" sub="كل تغيير في سعر أو حالة أو مال، بفاعله. السجل لا يُعدَّل ولا يُحذف."
        actions={<>
          <Button variant="secondary" icon="filter" onClick={() => setFiltering(!filtering)}>تصفية{table ? " · 1" : ""}</Button>
          <Button variant="secondary" icon="file-text" disabled={!log.data?.length} onClick={exportCsv}>CSV</Button>
        </>} />

      {filtering || table ? (
        <div className="flex gap-3 items-end">
          <div className="w-field-md"><Select label="الجدول" value={table} onChange={setTable} options={TABLES} /></div>
          {table ? <Button variant="ghost" icon="x" onClick={() => setTable("")}>إزالة التصفية</Button> : null}
          <span className="text-13 text-ink-muted">آخر <Num>200</Num> تغيير.</span>
        </div>
      ) : null}

      <DataTable rows={log.data} loading={log.loading} error={log.error} onRetry={log.reload} rowKey={(r) => r.id}
        emptyIcon="history" emptyTitle="لا تغييرات بهذه التصفية" emptyBody={table ? "أزل تصفية الجدول لترى كل التغييرات." : undefined}
        columns={[
          { key: "t", label: "الوقت", render: (r) => <Num>{fmt.dateTime(r.at)}</Num> },
          { key: "a", label: "الفاعل", render: (r) => auditActor(r.actor) },
          { key: "k", label: "النوع", render: (r) => { const [l, tone] = auditKind(r.table_name, r.changes); return <StatusBadge tone={tone}>{l}</StatusBadge>; } },
          { key: "o", label: "على", render: (r) => auditTarget(r.table_name, r.row_pk, r.changes) },
          { key: "c", label: "التغيير", render: (r) => <bdi>{auditChange(r.table_name, r.op, r.changes)}</bdi> },
        ]} />
    </div>
  );
}
