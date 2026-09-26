/** صفحة المنشأة: مشترياتها ورصيدها، وطريقة طلب مسؤولي الفروع (م-8)، والفروع (م-9) ومستخدموها. */
import { useState } from "react";
import { Link, useParams } from "react-router-dom";

import * as fmt from "@ui/fmt";
import {
  Button, ConfirmDialog, DataTable, Loader, Note, Num, OptionGroup, PageHead, Section, StatCard, StatusBadge, useAction, useLoad, type Tone,
} from "@ui/kit";
import { api } from "@/api/client";
import type { BranchOut, CustomerDetailOut, PendingOut, TempPasswordOut } from "@/api/types";
import { KIND_LABEL } from "@/lib/admin-labels";
import { ResetPasswordButton } from "@/lib/admin-reset";
import { useSession } from "@/session";

const EST_STATUS: Record<string, [string, Tone]> = {
  pending: ["بانتظار الاعتماد", "warning"], approved: ["معتمدة", "success"], rejected: ["مرفوضة", "error"], suspended: ["موقوفة", "neutral"],
};
const BRANCH_STATUS: Record<string, [string, Tone]> = {
  pending: ["بانتظار الاعتماد", "warning"], approved: ["معتمد", "success"], rejected: ["مرفوض", "error"], suspended: ["موقوف", "neutral"],
};

export function CustomerDetail() {
  const { customerId } = useParams();
  const { can, isOwner, refreshCounts } = useSession();
  const d = useLoad(() => api.get<CustomerDetailOut>(`/api/admin/customers/${customerId}`), [customerId]);
  const act = useAction();
  const [reject, setReject] = useState<BranchOut | null>(null);

  async function setMode(mode: string) {
    const v = await act.run(() => api.put<CustomerDetailOut>(`/api/admin/customers/${customerId}/purchaser-mode`, { purchaser_mode: mode }),
      "حُفظت طريقة الطلب");
    if (v) d.set(v);
  }

  async function decide(b: BranchOut, decision: "approve" | "reject") {
    const kind = "branch";
    const v = await act.run(() => api.post<PendingOut[]>(`/api/admin/approvals/${kind}/${b.id}`, { decision }),
      decision === "approve" ? "اعتُمد الفرع" : "رُفض الفرع");
    setReject(null);
    if (v) {
      d.reload();
      refreshCounts();
    }
  }

  return (
    <div className="md-page">
      <Loader state={d} rows={6}>{(c) => {
        const owner = c.members.find((m) => m.role === "owner");
        const [stLabel, stTone] = EST_STATUS[c.customer.status] ?? [c.customer.status, "neutral" as Tone];
        const byBranch = c.by_branch as Array<{ branch: string; total: string }>;
        const pending = c.branches.filter((b) => b.status === "pending");
        return (
          <>
            <PageHead title={c.customer.name}
              sub={<>{KIND_LABEL[c.customer.kind] ?? c.customer.kind}{owner ? ` · صاحب المنشأة ${owner.full_name}` : ""} · <Num>{fmt.phoneLocal(c.phone)}</Num></>}
              actions={<StatusBadge tone={stTone} icon={c.customer.status === "approved" ? "shield-check" : undefined}>{stLabel}</StatusBadge>} />

            <div className="grid grid-cols-4 gap-4 items-start">
              <StatCard label="مشتريات الشهر — كل الفروع" value={c.month_total} money icon="banknote" />
              {byBranch.map((b) => <StatCard key={b.branch} label={b.branch} value={b.total} money icon="store" />)}
              <StatCard label="رصيد المنشأة" value={c.credit} money icon="wallet" note="حساب واحد للمنشأة" />
            </div>

            <div className="grid grid-cols-3 gap-4 items-start">
              <Section title="طريقة طلب مسؤولي الفروع" right={<StatusBadge tone="neutral">M-8</StatusBadge>}>
                <OptionGroup value={c.customer.purchaser_mode} disabled={act.busy} onChange={(v) => void setMode(v)} options={[
                  { value: "direct", label: "يطلب مباشرة", sub: "المسؤول يرسل الطلب بلا تأكيد.", initial: true },
                  { value: "owner_confirms", label: "يجهّز السلة وصاحب المنشأة يؤكد", sub: "يصل صاحب المنشأة إشعار بالسلة الجاهزة ليرسلها." }]} />
                <span className="text-12 text-ink-muted">صاحب المنشأة وحده يضيف الفروع والمستخدمين. يسري على الطلبيات الجديدة.</span>
              </Section>
              <Section title="الفروع" className="col-span-2" right={<StatusBadge tone="neutral">M-9</StatusBadge>}>
                <DataTable rows={c.branches} rowKey={(b) => b.id} emptyIcon="store" emptyTitle="لا فروع بعد" emptyBody="الفرع الأول يُعتمد مع تسجيل المنشأة."
                  rowTone={(b) => b.status === "pending" && "warning"}
                  columns={[
                    { key: "n", label: "الفرع", render: (b) => b.name },
                    { key: "z", label: "الحي", render: (b) => b.zone ?? "—" },
                    { key: "a", label: "العنوان", render: (b) => b.address_text },
                    { key: "s", label: "الحالة", render: (b) => {
                      if (!b.active && b.status === "approved") return <StatusBadge tone="neutral">موقوف</StatusBadge>;
                      const [l, t] = BRANCH_STATUS[b.status] ?? [b.status, "neutral" as Tone];
                      return <StatusBadge tone={t}>{l}</StatusBadge>;
                    } },
                  ]} />
              </Section>
            </div>

            <Section title="المستخدمون" right={<span className="text-13 text-ink-muted">يضيفهم صاحب المنشأة من تطبيقه</span>}>
              <DataTable rows={c.members} rowKey={(m) => m.user_id} emptyIcon="users" emptyTitle="لا مستخدمين بعد"
                columns={[
                  { key: "n", label: "الاسم", render: (m) => m.full_name },
                  { key: "p", label: "الهاتف", render: (m) => <Num>{fmt.phoneLocal(m.phone)}</Num> },
                  { key: "r", label: "الدور", render: (m) => m.role === "owner" ? <StatusBadge tone="primary">صاحب المنشأة</StatusBadge>
                    : <StatusBadge tone="info">مسؤول مشتريات</StatusBadge> },
                  { key: "b", label: "الفرع", render: (m) => m.branch ?? "كل الفروع" },
                  ...(isOwner ? [{ key: "x", label: "", render: (m: CustomerDetailOut["members"][number]) => (
                    <ResetPasswordButton name={m.full_name}
                      reset={() => api.post<TempPasswordOut>(`/api/admin/users/${m.user_id}/reset-password`)} />
                  ) }] : []),
                ]} />
            </Section>

            {pending.map((b) => (
              <div key={b.id} className="flex flex-col gap-2">
                <Note tone="warning"><b>فرع بانتظار الاعتماد:</b> «{b.name}» — {b.address_text}{b.zone ? ` · ${b.zone}` : ""}. اعتمده ليطلب منه، أو ارفضه.</Note>
                {can("approvals") ? (
                  <div className="flex gap-2">
                    <Button icon="check" loading={act.busy} onClick={() => void decide(b, "approve")}>اعتماد الفرع</Button>
                    <Button icon="x" variant="secondary" disabled={act.busy} onClick={() => setReject(b)}>رفض</Button>
                  </div>
                ) : <span className="text-13 text-ink-muted">يعتمده من يملك «الاعتمادات» — <Link to="/approvals" className="md-link">الاعتمادات</Link></span>}
              </div>
            ))}

            <ConfirmDialog open={reject != null} tone="error" icon="x" loading={act.busy}
              title={`رفض «${reject?.name ?? ""}»؟`} body="لا يُطلب لفرع مرفوض. يستطيع صاحب المنشأة إضافة فرع جديد من تطبيقه."
              confirmLabel="رفض الفرع" onConfirm={() => reject && void decide(reject, "reject")} onCancel={() => setReject(null)} />
          </>
        );
      }}</Loader>
    </div>
  );
}
