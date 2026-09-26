/** إشعاراتي: ما يحتاج انتباهك، وكل إشعار يفتح الشاشة التي تحلّه (ويُعلَّم مقروءاً). */
import { useState } from "react";
import { useNavigate } from "react-router-dom";

import * as fmt from "@ui/fmt";
import { Button, EmptyState, ErrorState, Icon, LoadingState, Num, PageHead, cx, useAction, useLoad } from "@ui/kit";
import type { IconName } from "@ui/icons";
import { api } from "@/api/client";
import type { InboxOut } from "@/api/types";
import { useSession, type Perm } from "@/session";

type Dot = "error" | "warning" | "info";
const KIND: Record<string, { icon: IconName; dot: Dot; cta: string; to: (n: InboxOut) => string; perm: Perm }> = {
  below_cost: { icon: "triangle-alert", dot: "error", cta: "تسعير الصنف", to: () => "/catalog", perm: "catalog" },
  cost_missing: { icon: "triangle-alert", dot: "error", cta: "تسعير الصنف", to: () => "/catalog", perm: "catalog" },
  price_changed: { icon: "tags", dot: "warning", cta: "راجِع السعر", to: () => "/catalog", perm: "catalog" },
  plan_short: { icon: "map-pin", dot: "warning", cta: "مخطط الاستلام", to: () => "/plan", perm: "orders" },
  otp_channel_failed: { icon: "send", dot: "error", cta: "الإعدادات", to: () => "/settings", perm: "settings" },
  branch_pending: { icon: "store", dot: "info", cta: "الاعتمادات", to: () => "/approvals", perm: "approvals" },
  area_overlap: { icon: "map-pin", dot: "error", cta: "مناطق التوصيل", to: () => "/zones", perm: "settings" },
};
const DOT: Record<Dot, string> = {
  error: "bg-error text-on-error", warning: "bg-warning text-on-warning", info: "bg-secondary-tint text-primary-text",
};

const TABS: Array<{ key: string; label: string; kinds: string[] | null }> = [
  { key: "all", label: "الكل", kinds: null },
  { key: "price", label: "تغيّر الأسعار", kinds: ["price_changed"] },
  { key: "cost", label: "تحت التكلفة", kinds: ["below_cost", "cost_missing"] },
  { key: "plan", label: "مخطط ناقص", kinds: ["plan_short"] },
  { key: "otp", label: "قنوات الرمز", kinds: ["otp_channel_failed"] },
  { key: "branch", label: "فروع", kinds: ["branch_pending"] },
];

function when(iso: string): string {
  const d = new Date(iso), now = new Date();
  const day = (x: Date) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const diff = Math.round((day(now) - day(d)) / 86400000);
  if (diff === 0) return fmt.time(iso);
  if (diff === 1) return "أمس";
  return fmt.date(iso).slice(0, 5);
}

export function OwnerInbox() {
  const { can, refreshCounts } = useSession();
  const nav = useNavigate();
  const inbox = useLoad(() => api.get<InboxOut[]>(`/api/admin/inbox`));
  const act = useAction();
  const [tab, setTab] = useState("all");

  const items = inbox.data ?? [];
  const tabs = TABS.map((t) => ({ ...t, count: t.kinds ? items.filter((n) => t.kinds?.includes(n.kind)).length : items.length }))
    .filter((t) => t.key === "all" || t.count > 0);
  const kinds = TABS.find((t) => t.key === tab)?.kinds ?? null;
  const shown = kinds ? items.filter((n) => kinds.includes(n.kind)) : items;
  const unread = items.filter((n) => !n.read);

  async function markRead(n: InboxOut) {
    const v = await act.run(() => api.post<InboxOut[]>(`/api/admin/inbox/${n.id}/read`));
    if (v) {
      inbox.set(v);
      refreshCounts();
    }
  }

  async function markAll() {
    const v = await act.run(async () => {
      let last: InboxOut[] | undefined;
      for (const n of unread) last = await api.post<InboxOut[]>(`/api/admin/inbox/${n.id}/read`);
      return last;
    }, "عُلِّم الكل مقروءاً");
    if (v) inbox.set(v);
    refreshCounts();
  }

  function open(n: InboxOut) {
    const k = KIND[n.kind];
    if (!n.read) void markRead(n);
    if (k && can(k.perm)) nav(k.to(n));
  }

  let body;
  if (inbox.loading && !inbox.data) body = <LoadingState rows={4} />;
  else if (inbox.error && !inbox.data) body = <ErrorState compact title="تعذّر تحميل الإشعارات" body={inbox.error.message} code={inbox.error.code} onRetry={inbox.reload} />;
  else if (!shown.length) body = <div className="md-sec"><EmptyState compact icon="bell" title="لا جديد" body="كل ما يحتاج قرارك يظهر هنا." /></div>;
  else body = (
    <div className="flex flex-col gap-2">
      {shown.map((n) => {
        const k = KIND[n.kind];
        const link = k && can(k.perm);
        return (
          <button key={n.id} type="button" onClick={() => open(n)}
            className={cx("grid grid-cols-[auto_minmax(0,1fr)_auto] gap-3.5 items-center px-4 py-3.5 bg-surface border border-border rounded-lg text-ink text-start font-sans cursor-pointer",
              n.read && "opacity-70")}>
            <span className={cx("w-10 h-10 rounded-full grid place-items-center", DOT[k?.dot ?? "info"])}><Icon name={k?.icon ?? "bell"} /></span>
            <span className="flex flex-col gap-0.5">
              <span className={cx("text-15", n.read ? "font-medium" : "font-bold")}>{n.title}</span>
              <span className="text-14 text-ink-muted">{n.body}</span>
            </span>
            <span className="flex flex-col items-end gap-1.5">
              <Num className="text-13 text-ink-muted">{when(n.created_at)}</Num>
              {link ? <span className="text-13 font-bold text-primary-text">{k.cta}</span>
                : !n.read ? <span className="text-13 font-bold text-primary-text">تعليم مقروءاً</span> : null}
            </span>
          </button>
        );
      })}
    </div>
  );

  return (
    <div className="md-page">
      <PageHead title="إشعاراتي" sub="ما يحتاج انتباهك. كل إشعار يفتح الشاشة التي تحلّه."
        actions={<Button icon="check" variant="secondary" size="sm" loading={act.busy} disabled={!unread.length} onClick={markAll}>تعليم الكل مقروءاً</Button>} />
      <div role="tablist" className="flex gap-1.5 flex-wrap">
        {tabs.map((t) => (
          <button key={t.key} type="button" role="tab" aria-selected={tab === t.key} onClick={() => setTab(t.key)}
            className={cx("min-h-10 px-3.5 rounded-full text-14 font-sans cursor-pointer border",
              tab === t.key ? "font-bold border-primary bg-primary text-on-primary" : "font-medium border-border-strong bg-surface text-ink")}>
            {t.label} <Num>{t.count}</Num>
          </button>
        ))}
      </div>
      {body}
    </div>
  );
}
