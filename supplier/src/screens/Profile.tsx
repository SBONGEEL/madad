/**
 * 07 الملف: المحل والمسؤول والهاتف والحالة ودورية الصرف، وقائمة (المواقع، المستحقات، الإشعارات، خروج).
 * الإشعارات عرض فرعي (?view=notifications). «تواصل مع مَدَد» بلا رقم في القاعدة (NO-DB) فلا يُعرض.
 * رمز الإشعار الفوري يأتي من غلاف Android (window.MadadPush) حين يوجد؛ نسخة الويب بلا FCM.
 */
import { useEffect } from "react";
import { Link, useSearchParams } from "react-router-dom";

import * as fmt from "@ui/fmt";
import { Button, EmptyState, ErrorState, Icon, LoadingState, Note, Num, StatusBadge, cx, useAction, useLoad } from "@ui/kit";
import type { IconName } from "@ui/icons";
import { api } from "@/api/client";
import type { NotificationOut } from "@/api/types";
import { CYCLE, SUPPLIER_STATUS } from "@/lib/acc-ui";
import { HomeHeader, Screen } from "@/lib/shell";
import { useSession } from "@/session";

declare global {
  interface Window {
    /** يضعه غلاف Capacitor لاحقاً: رمز FCM للجهاز وحالة إذن الإشعارات. */
    MadadPush?: { token?: string; platform?: "android" | "web"; permission?: "granted" | "denied" | "prompt"; openSettings?: () => void };
  }
}

/** يسجّل رمز الإشعار الفوري لهذا الجهاز مرة في الجلسة، حين يعطيه الغلاف. */
function usePushToken() {
  useEffect(() => {
    const push = window.MadadPush;
    if (!push?.token) return;
    const key = "madad.supplier.push";
    try {
      if (sessionStorage.getItem(key) === push.token) return;
    } catch { /* تخزين غير متاح */ }
    void api.post<void>(`/api/supplier/devices`, { fcm_token: push.token, platform: push.platform ?? "android" }).then(() => {
      try { sessionStorage.setItem(key, push.token ?? ""); } catch { /* تخزين غير متاح */ }
    }, () => undefined);
  }, []);
}

export function Profile() {
  const [params] = useSearchParams();
  usePushToken();
  if (params.get("view") === "notifications") return <Notifications />;
  return <Account />;
}

function Account() {
  const { me } = useSession();
  const s = me.supplier;
  const st = SUPPLIER_STATUS[s?.status ?? ""];
  const menu: Array<{ icon: IconName; label: string; to: string; count?: number }> = [
    { icon: "map-pin", label: "مواقع الاستلام", to: "/locations" },
    { icon: "wallet", label: "المستحقات والدفعات", to: "/dues" },
    { icon: "bell", label: "الإشعارات", to: "/profile?view=notifications", count: me.unread },
  ];
  return (
    <>
      <HomeHeader />
      <main className="md-mobile-main">
        <div className="flex flex-col gap-2.5">
          {s?.status === "suspended" ? (
            <EmptyState icon="eye-off" title="حسابك موقوف مؤقتاً" body="عروضك مخفية عن مَدَد حتى يُعاد تفعيل الحساب. مستحقاتك السابقة تُصرف في موعدها." />
          ) : null}
          {s ? (
            <section className="bg-surface border border-border rounded-lg p-3.5 flex flex-col gap-1.5">
              <span className="font-bold text-17">{s.name}</span>
              <span className="text-14 text-ink-muted">{s.contact_name} · <Num>{fmt.phoneLocal(s.phone)}</Num></span>
              <div className="flex gap-1.5 flex-wrap">
                {st ? <StatusBadge tone={st[1]} icon={s.status === "approved" ? "shield-check" : undefined}>{st[0]}</StatusBadge> : null}
                {s.payout_cycle ? <StatusBadge tone="info">صرف {CYCLE[s.payout_cycle] ?? s.payout_cycle}</StatusBadge> : null}
              </div>
            </section>
          ) : null}
          {s?.status === "pending" ? <Note tone="warning">نراجع بياناتك. نبلغك حين نعتمد المحل، ونتفق معك على دورية صرف مستحقاتك.</Note> : null}
          {s?.status === "rejected" ? <Note tone="error">لم يُعتمد المحل. راجع فريق مَدَد لمعرفة السبب.</Note> : null}
          {menu.map((m) => (
            <Link key={m.to} to={m.to} className="flex items-center gap-3 py-3.5 px-3 bg-surface border border-border rounded-md text-ink no-underline">
              <Icon name={m.icon} />
              <span className="flex-1">{m.label}</span>
              {m.count ? <StatusBadge tone="primary"><Num>{m.count}</Num></StatusBadge> : null}
              <Icon name="chevron-left" size={18} />
            </Link>
          ))}
          <button type="button" onClick={() => void api.logout()}
            className="flex items-center gap-3 py-3.5 px-3 bg-surface border border-border rounded-md text-ink font-sans text-start cursor-pointer w-full">
            <Icon name="log-out" />
            <span className="flex-1">خروج</span>
            <Icon name="chevron-left" size={18} />
          </button>
          <span className="text-12 text-ink-muted">تغيير دورية الصرف يتم مع مَدَد، لا من التطبيق.</span>
        </div>
      </main>
    </>
  );
}

const KIND_ICON: Record<string, IconName> = {
  pickup_request: "truck",
  supplier_payout: "banknote",
  supplier_approved: "shield-check",
  offer_paused: "package",
  product_approved: "circle-check",
  broadcast: "megaphone",
};

function when(iso: string): string {
  const d = new Date(iso);
  const now = new Date();
  const day = (x: Date) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const diff = Math.round((day(now) - day(d)) / 86400000);
  if (diff === 0) return fmt.time(iso);
  if (diff === 1) return "أمس";
  return fmt.date(iso);
}

function Notifications() {
  const { refresh } = useSession();
  const list = useLoad(() => api.get<NotificationOut[]>(`/api/supplier/notifications`));
  const { busy, run } = useAction();
  const unread = (list.data ?? []).filter((n) => !n.read).length;

  async function markRead(n: NotificationOut) {
    if (n.read) return;
    const next = await run(() => api.post<NotificationOut[]>(`/api/supplier/notifications/read`, { ids: [n.id] }));
    if (next) { list.set(next); refresh(); }
  }
  async function readAll() {
    const next = await run(() => api.post<NotificationOut[]>(`/api/supplier/notifications/read`, { all: true }));
    if (next) { list.set(next); refresh(); }
  }

  const denied = window.MadadPush?.permission === "denied";
  return (
    <Screen title="الإشعارات" back="/profile">
      {denied ? (
        <ErrorState compact title="الإشعارات موقوفة في هاتفك" body="لن يصلك إشعار طلبات الاستلام. فعّلها من إعدادات الهاتف."
          code="push_permission_denied" retryLabel="فتح الإعدادات"
          onRetry={window.MadadPush?.openSettings ? () => window.MadadPush?.openSettings?.() : undefined} />
      ) : null}
      {list.loading && !list.data ? <LoadingState rows={5} />
        : list.error && !list.data ? (
          <div className="flex-1 flex flex-col justify-center"><ErrorState title={list.error.message} code={list.error.code} onRetry={list.reload} /></div>
        ) : !list.data?.length ? (
          <div className="flex-1 flex flex-col justify-center">
            <EmptyState icon="bell" title="لا إشعارات" body="طلبات الاستلام، واعتماد المحل والأصناف، والدفعات تصلك هنا." />
          </div>
        ) : (
          <div className="flex flex-col gap-2">
            {unread ? (
              <div className="flex justify-between items-center gap-2">
                <span className="text-13 text-ink-muted"><Num>{unread}</Num> غير مقروء</span>
                <Button variant="ghost" size="sm" icon="check" disabled={busy} onClick={() => void readAll()}>تعليم الكل مقروءاً</Button>
              </div>
            ) : null}
            {list.data.map((n) => (
              <button key={n.id} type="button" onClick={() => void markRead(n)} disabled={busy}
                className={cx("flex gap-2.5 items-start p-3 rounded-md bg-surface text-ink text-start font-sans cursor-pointer w-full",
                  n.read ? "border border-border" : "border-2 border-secondary")}
                aria-label={n.read ? n.title : `غير مقروء: ${n.title}`}>
                <span className="rounded-full bg-secondary-tint grid place-items-center p-2 shrink-0"><Icon name={KIND_ICON[n.kind] ?? "bell"} size={18} /></span>
                <span className="flex flex-col gap-0.5 flex-1 min-w-0">
                  <span className="font-bold text-14">{n.title}</span>
                  <span className="text-13 text-ink-muted">{n.body}</span>
                </span>
                <span className="text-12 text-ink-muted md-num shrink-0">{when(n.created_at)}</span>
              </button>
            ))}
          </div>
        )}
    </Screen>
  );
}
