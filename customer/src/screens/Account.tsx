/**
 * 11 الحساب ومستخدمو المنشأة (م-8): بطاقة المنشأة والقائمة، ثم «مستخدمو المنشأة» (?view=users) و«مستخدم جديد» (?view=add).
 * الصاحب وحده يضيف مستخدماً؛ المسؤول يرى القائمة للقراءة. طريقة طلب المسؤولين يضبطها فريق مَدَد (context.ordering_mode).
 */
import { useState } from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";

import { phoneE164 } from "@ui/fmt";
import { Button, ErrorState, Icon, LoadingState, Note, Select, StatusBadge, TextField, toast, useLoad } from "@ui/kit";
import type { IconName } from "@ui/icons";
import { api } from "@/api/client";
import type { BranchOut, MemberRowOut } from "@/api/types";
import { acctError } from "@/lib/acct-http";
import { BRANCH_STATUS, CUSTOMER_STATUS, Choice, KIND, PHONE_HINT } from "@/lib/acct-ui";
import { HomeHeader, Screen } from "@/lib/shell";
import { useSession } from "@/session";

export function Account() {
  const [params] = useSearchParams();
  const view = params.get("view");
  if (view === "users") return <Users />;
  if (view === "add") return <AddUser />;
  return <Home />;
}

const MENU: Array<{ icon: IconName; label: string; to: string }> = [
  { icon: "users", label: "مستخدمو المنشأة", to: "/account?view=users" },
  { icon: "store", label: "الفروع", to: "/branches" },
  { icon: "chart-column", label: "التقارير", to: "/reports" },
  { icon: "file-text", label: "الفواتير والإيصالات", to: "/orders" },
  { icon: "bell", label: "الإشعارات", to: "/notifications" },
];

const ROW = "flex items-center gap-3 px-3 py-3.5 bg-surface border border-border rounded-md text-ink no-underline text-15";

function Home() {
  const { me } = useSession();
  const branches = useLoad(() => api.get<BranchOut[]>(`/api/customer/branches`));
  const c = me.customer;
  const [label, tone] = CUSTOMER_STATUS[c?.status ?? ""] ?? [c?.status ?? "", "neutral" as const];
  const first = branches.data?.[0];
  const place = first ? [first.zone_name, first.address_text].filter(Boolean).join("، ") : me.context?.city_name;
  return (
    <>
      <HomeHeader />
      <main className="md-mobile-main">
        <section className="bg-surface border border-border rounded-lg p-3.5 flex flex-col gap-1">
          <span className="font-bold text-17">{c?.name}</span>
          <span className="text-14 text-ink-muted">{[KIND[me.context?.kind ?? ""], place].filter(Boolean).join(" · ")}</span>
          <div className="flex gap-2 items-center flex-wrap">
            <StatusBadge tone={tone} icon={c?.status === "approved" ? "shield-check" : c?.status === "pending" ? "clock" : undefined}>{label}</StatusBadge>
            <span className="text-13 text-ink-muted">{me.full_name} · {me.member?.role === "owner" ? "صاحب المنشأة" : "مسؤول فرع"}</span>
          </div>
        </section>
        <nav className="flex flex-col gap-2.5" aria-label="حسابي">
          {MENU.map((m) => (
            <Link key={m.to} to={m.to} className={ROW}>
              <Icon name={m.icon} /><span className="flex-1">{m.label}</span><Icon name="chevron-left" size={18} />
            </Link>
          ))}
          <button type="button" className={`${ROW} cursor-pointer font-sans text-start`} onClick={() => void api.logout()}>
            <Icon name="log-out" /><span className="flex-1">خروج</span><Icon name="chevron-left" size={18} />
          </button>
        </nav>
      </main>
    </>
  );
}

function modeText(mode: string | undefined): string {
  return mode === "owner_confirms" ? "يجهّزون السلة ويؤكّدها صاحب المنشأة" : "يطلبون مباشرة";
}

function scope(u: MemberRowOut): string {
  if (u.role === "owner") return "كل الفروع · يضيف الفروع والمستخدمين";
  const b = u.branch_name ?? "فرع";
  return u.branch_status && u.branch_status !== "approved" ? `${b} · بانتظار اعتماد الفرع` : `${b} · يطلب له ويرى فواتيره`;
}

function Users() {
  const { me, isOwner } = useSession();
  const nav = useNavigate();
  const list = useLoad(() => api.get<MemberRowOut[]>(`/api/customer/members`));
  return (
    <Screen title="مستخدمو المنشأة" back="/account">
      {list.loading && !list.data ? <LoadingState rows={2} />
        : list.error && !list.data ? <ErrorState compact title={list.error.message} code={list.error.code} onRetry={list.reload} />
        : (
          <div className="flex flex-col gap-2.5">
            {(list.data ?? []).map((u) => (
              <section key={u.user_id} className="bg-surface border border-border rounded-md p-3 flex flex-col gap-1">
                <div className="flex justify-between items-center gap-2">
                  <b>{u.full_name}</b>
                  <StatusBadge tone={u.role === "owner" ? "primary" : "info"}>{u.role === "owner" ? "صاحب المنشأة" : "مسؤول فرع"}</StatusBadge>
                </div>
                <span className="text-13 text-ink-muted">{scope(u)}</span>
                {!u.activated ? (
                  <span className="text-13 text-ink-muted flex items-center gap-1.5 flex-wrap">
                    <StatusBadge tone="warning">لم يفعّل حسابه بعد</StatusBadge>
                    يفعّله من «منشأة جديدة؟ سجّل» برقم <bdi className="md-num" dir="ltr">{u.phone}</bdi>
                  </span>
                ) : null}
              </section>
            ))}
          </div>
        )}
      <Note tone="info">
        {isOwner
          ? <>طريقة طلب المسؤولين: <b>{modeText(me.context?.ordering_mode)}</b>. يضبطها فريق مَدَد لمنشأتكم.</>
          : <>طريقة الطلب: <b>{modeText(me.context?.ordering_mode)}</b>. إضافة المستخدمين لصاحب المنشأة وحده.</>}
      </Note>
      {isOwner ? (
        <div className="mt-auto">
          <Button icon="plus" variant="secondary" block onClick={() => nav("/account?view=add")}>إضافة مستخدم برقم هاتفه</Button>
        </div>
      ) : null}
    </Screen>
  );
}

type Role = "owner" | "purchaser";

function AddUser() {
  const { isOwner } = useSession();
  const nav = useNavigate();
  const branches = useLoad(() => api.get<BranchOut[]>(`/api/customer/branches`));
  const [phone, setPhone] = useState("");
  const [name, setName] = useState("");
  const [role, setRole] = useState<Role>("purchaser");
  const [branch, setBranch] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [phoneErr, setPhoneErr] = useState(false);

  if (!isOwner) {
    return (
      <Screen title="مستخدم جديد" back="/account?view=users">
        <div className="flex-1 flex flex-col justify-center">
          <ErrorState compact title="لصاحب المنشأة وحده" body="إضافة المستخدمين والفروع لصاحب المنشأة." code="forbidden_owner_member" />
        </div>
      </Screen>
    );
  }

  const list = branches.data ?? [];
  const branchId = branch || (list.length === 1 && list[0] ? String(list[0].id) : "");
  async function add() {
    const p = phoneE164(phone);
    setPhoneErr(!p);
    if (!p) return;
    setBusy(true);
    setErr(null);
    try {
      await api.post<MemberRowOut[]>(`/api/customer/members`, {
        phone: p, full_name: name.trim(), role, branch_id: role === "purchaser" ? Number(branchId) : null,
      });
      toast("أُضيف المستخدم. يفعّل حسابه برقمه من «منشأة جديدة؟ سجّل».");
      nav("/account?view=users", { replace: true });
    } catch (e) {
      setErr(acctError(e));
    } finally {
      setBusy(false);
    }
  }
  return (
    <Screen title="مستخدم جديد" back="/account?view=users">
      <TextField label="رقم الهاتف" value={phone} onChange={setPhone} numeric icon="phone" placeholder="092 777 1234" disabled={busy}
        error={phoneErr ? PHONE_HINT : null} />
      <TextField label="الاسم" value={name} onChange={setName} disabled={busy} />
      <Choice label="الدور" value={role} onChange={setRole} columns={2}
        options={[{ value: "owner", label: "صاحب منشأة" }, { value: "purchaser", label: "مسؤول فرع" }]} />
      {role === "purchaser" ? (
        branches.loading && !branches.data ? <LoadingState rows={1} />
          : branches.error && !branches.data ? <ErrorState compact title={branches.error.message} code={branches.error.code} onRetry={branches.reload} />
          : (
            <Select label="الفرع" value={branchId} onChange={setBranch}
              options={[{ value: "", label: "اختر الفرع" }, ...list.map((b) => ({
                value: String(b.id), label: b.status === "approved" ? b.name : `${b.name} — ${BRANCH_STATUS[b.status]?.[0] ?? b.status}`,
              }))]} />
          )
      ) : <Note tone="warning">صاحب المنشأة يرى كل الفروع ويضيف الفروع والمستخدمين.</Note>}
      {err ? <Note tone="error">{err}</Note> : null}
      <div className="mt-auto">
        <Button block loading={busy} disabled={!phone || !name.trim() || (role === "purchaser" && !branchId)} onClick={() => void add()}>إضافة</Button>
      </div>
    </Screen>
  );
}
