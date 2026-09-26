/** المشرفون والصلاحيات (ت-40)، وإعادة تعيين كلمة المرور للمالك وحده (م-20). */
import { useMemo, useState } from "react";
import { Link } from "react-router-dom";

import { qs } from "@ui/client";
import * as fmt from "@ui/fmt";
import {
  Button, DataTable, Dialog, EmptyState, Icon, Loader, Num, PageHead, Section, SectionTitle, StatusBadge, Switch, TextField,
  useAction, useLoad,
} from "@ui/kit";
import { api } from "@/api/client";
import type { AdminUserOut, AuditOut, TempPasswordOut } from "@/api/types";
import { PERMS, VALUE_LABEL, auditActor } from "@/lib/admin-labels";
import { ResetPasswordButton } from "@/lib/admin-reset";
import { useSession } from "@/session";

export function Users() {
  const { isOwner } = useSession();
  const list = useLoad(() => api.get<AdminUserOut[]>(`/api/admin/admins`));
  const act = useAction();
  const [invite, setInvite] = useState(false);

  async function toggle(u: AdminUserOut, perm: string, on: boolean) {
    const next = on ? [...new Set([...u.permissions, perm])] : u.permissions.filter((p) => p !== perm);
    const v = await act.run(() => api.put<AdminUserOut[]>(`/api/admin/admins/${u.user_id}/permissions`, { permissions: next }), "حُفظت الصلاحيات");
    if (v) list.set(v);
  }

  return (
    <div className="md-page">
      <PageHead title="المشرفون والصلاحيات" actions={<Button icon="plus" onClick={() => setInvite(true)}>مشرف جديد</Button>} />

      <Loader state={list}>{(rows) => rows.length ? (
        <div className="md-table-wrap">
          <table className="md-table">
            <thead>
              <tr><th>المستخدم</th>{PERMS.map((p) => <th key={p.key} className="text-center">{p.label}</th>)}</tr>
            </thead>
            <tbody>
              {rows.map((u) => {
                const owner = u.role === "owner";
                return (
                  <tr key={u.user_id}>
                    <td>
                      <div className="font-bold">{u.full_name}{u.active ? null : <> <StatusBadge tone="neutral">موقوف</StatusBadge></>}</div>
                      <div className="text-12 text-ink-muted">
                        {owner ? "مالك · كل الصلاحيات" : <>مشرف · <Num>{fmt.phoneLocal(u.phone)}</Num></>}
                      </div>
                    </td>
                    {PERMS.map((p) => (
                      <td key={p.key} className="text-center">
                        <Switch checked={owner || u.permissions.includes(p.key)} disabled={owner || act.busy} label={`${u.full_name} — ${p.label}`}
                          onChange={(on) => void toggle(u, p.key, on)} />
                      </td>
                    ))}
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      ) : <Section><EmptyState compact icon="users" title="لا مشرفين بعد" body="أضف مشرفاً بصلاحيات جزئية ليتولى الطلبيات أو الاعتمادات." /></Section>}</Loader>

      <section className="bg-warning-tint rounded-lg px-4 py-3.5 text-14 flex gap-2.5 items-center">
        <Icon name="eye-off" />
        <span>مشرف بلا «التكاليف» لا يرى سعر الشراء ولا الهامش ولا الربح في أي شاشة؛ تختفي الأعمدة ولا تظهر فارغة. المالك له كل الصلاحيات دائماً.</span>
      </section>

      {isOwner ? <ResetSection admins={list.data ?? []} /> : null}

      <InviteDialog open={invite} onClose={() => setInvite(false)} onDone={(v) => { list.set(v); setInvite(false); }} />
    </div>
  );
}

function InviteDialog({ open, onClose, onDone }: { open: boolean; onClose: () => void; onDone: (v: AdminUserOut[]) => void }) {
  const act = useAction();
  const [name, setName] = useState("");
  const [phone, setPhone] = useState("");
  const [perms, setPerms] = useState<string[]>([]);
  const e164 = fmt.phoneE164(phone);
  const phoneBad = phone.trim() !== "" && !e164;

  async function submit() {
    if (!e164 || !name.trim()) return;
    const v = await act.run(() => api.post<AdminUserOut[]>(`/api/admin/admins`, { phone: e164, full_name: name.trim(), permissions: perms }),
      "أُضيف المشرف — يفعّل حسابه برمز من صفحة الدخول");
    if (v) {
      setName("");
      setPhone("");
      setPerms([]);
      onDone(v);
    }
  }

  return (
    <Dialog open={open} onClose={onClose} wide label="مشرف جديد">
      <div className="md-dialog-title">مشرف جديد</div>
      <div className="md-dialog-body">يصله رمز مرة واحدة على هاتفه ليفعّل حسابه ويضع كلمة مروره. يرى ما تفتحه له الصلاحيات فقط.</div>
      <div className="grid grid-cols-2 gap-3">
        <TextField label="الاسم" value={name} onChange={setName} required />
        <TextField label="الهاتف" value={phone} onChange={setPhone} ltr placeholder="091 000 0000" icon="phone" required
          error={phoneBad ? "رقم ليبي غير صالح" : null} />
      </div>
      <div className="grid grid-cols-2 gap-2">
        {PERMS.map((p) => {
          const on = perms.includes(p.key);
          return (
            <label key={p.key} className="flex justify-between items-center gap-2 p-2.5 rounded-md bg-page text-14">
              <span>{p.label}</span>
              <Switch checked={on} label={p.label} onChange={(v) => setPerms(v ? [...perms, p.key] : perms.filter((x) => x !== p.key))} />
            </label>
          );
        })}
      </div>
      <div className="md-dialog-actions">
        <Button block icon="plus" loading={act.busy} disabled={!e164 || !name.trim()} onClick={submit}>إضافة المشرف</Button>
        <Button block variant="ghost" onClick={onClose}>إلغاء</Button>
      </div>
    </Dialog>
  );
}

/** إعادة تعيين كلمة مرور (UserReset): بحث في مستخدمي اللوحة، وآخر إعادات التعيين من سجل التدقيق. */
function ResetSection({ admins }: { admins: AdminUserOut[] }) {
  const [q, setQ] = useState("");
  const events = useLoad(() => api.get<AuditOut[]>(`/api/admin/audit${qs({ table: "password_reset_events" })}`));

  const found = useMemo(() => {
    const t = q.trim();
    if (!t) return admins;
    const digits = t.replace(/\D/g, "");
    return admins.filter((u) => u.full_name.includes(t) || (digits.length >= 3 && (u.phone.includes(digits) || fmt.phoneLocal(u.phone).replace(/\s/g, "").includes(digits))));
  }, [q, admins]);

  const nameOf = (id: unknown) => admins.find((u) => u.user_id === Number(id))?.full_name ?? `مستخدم #${String(id)}`;
  const rows = (events.data ?? []).map((e) => {
    const get = (k: string) => { const v = e.changes[k]; return Array.isArray(v) ? v[1] : v; };
    return { id: e.id, at: e.at, user: nameOf(get("user_id")), method: String(get("method") ?? ""), by: e.actor };
  });

  return (
    <>
      <div className="flex justify-between items-end gap-4">
        <SectionTitle title="إعادة تعيين كلمة مرور" sub="للمالك وحده. تُسجَّل في سجل التدقيق بمن ومتى، والمستخدم ملزم بتغييرها عند أول دخول." />
        <StatusBadge tone="primary" icon="shield-check">المالك فقط</StatusBadge>
      </div>
      <div className="grid grid-cols-2 gap-4 items-start">
        <Section title="ابحث عن المستخدم">
          <TextField label="رقم الهاتف أو الاسم" value={q} onChange={setQ} icon="search" />
          <DataTable rows={found} rowKey={(u) => u.user_id} emptyIcon="users" emptyTitle="لا نتيجة" emptyBody="تحقق من الرقم أو الاسم."
            columns={[
              { key: "n", label: "المستخدم", render: (u) => <>{u.full_name} <span className="text-13 text-ink-muted"><Num>{fmt.phoneLocal(u.phone)}</Num></span></> },
              { key: "k", label: "الحساب", render: (u) => <StatusBadge tone={u.role === "owner" ? "primary" : "info"}>{u.role === "owner" ? "المالك" : "مشرف لوحة"}</StatusBadge> },
              { key: "a", label: "", render: (u) => (
                <ResetPasswordButton name={u.full_name} onDone={events.reload}
                  reset={() => api.post<TempPasswordOut>(`/api/admin/users/${u.user_id}/reset-password`)} />
              ) },
            ]} />
          <span className="text-13 text-ink-muted">مستخدمو المطاعم يُعاد تعيينهم من صفحة المنشأة في «العملاء».</span>
        </Section>
        <Section title="آخر إعادات التعيين" right={<Link to="/audit" className="md-link text-14">سجل التدقيق</Link>}>
          <DataTable rows={rows} loading={events.loading} error={events.error} onRetry={events.reload} rowKey={(r) => r.id}
            emptyIcon="history" emptyTitle="لا إعادات تعيين بعد"
            columns={[
              { key: "w", label: "متى", render: (r) => <Num>{fmt.dateTime(r.at)}</Num> },
              { key: "u", label: "المستخدم", render: (r) => r.user },
              { key: "m", label: "الطريقة", render: (r) => r.method === "admin" ? <StatusBadge tone="primary">من اللوحة</StatusBadge>
                : <StatusBadge tone="info">{VALUE_LABEL[r.method] ?? r.method}</StatusBadge> },
              { key: "b", label: "بيد", render: (r) => r.by === "system" ? "المستخدم نفسه" : auditActor(r.by) },
            ]} />
        </Section>
      </div>
    </>
  );
}
