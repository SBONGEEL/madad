/**
 * 12 الإشعارات: أيقونة حسب النوع، وغير المقروء بإطار ملوّن. الضغط يعلّمه مقروءاً ويفتح الطلبية إن كانت له.
 * رمز الإشعار الفوري يأتي من غلاف Android (window.MadadPush) حين يوجد؛ نسخة الويب بلا FCM.
 */
import { useEffect } from "react";
import { useNavigate } from "react-router-dom";

import * as fmt from "@ui/fmt";
import { Button, EmptyState, ErrorState, Icon, LoadingState, cx, useAction, useLoad } from "@ui/kit";
import type { IconName } from "@ui/icons";
import { api } from "@/api/client";
import type { NotificationOut } from "@/api/types";
import { Screen } from "@/lib/shell";
import { useSession } from "@/session";

declare global {
  interface Window {
    /** يضعه غلاف Capacitor لاحقاً: رمز FCM للجهاز وحالة إذن الإشعارات. */
    MadadPush?: { token?: string; platform?: "android" | "web"; permission?: "granted" | "denied" | "prompt"; openSettings?: () => void };
  }
}

const ICON: Record<string, IconName> = {
  order_confirmed: "circle-check",
  order_assigned: "truck",
  batch_departure: "truck",
  order_arrived: "package",
  order_awaiting_owner: "clipboard-list",
  list_reminder: "repeat",
  broadcast: "megaphone",
  branch_pending: "store",
  price_changed: "tags",
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

/** يسجّل رمز الإشعار الفوري لهذا الجهاز مرة في الجلسة، حين يعطيه الغلاف. */
function usePushToken() {
  useEffect(() => {
    const push = window.MadadPush;
    if (!push?.token) return;
    const key = "madad.customer.push";
    try {
      if (sessionStorage.getItem(key) === push.token) return;
    } catch { /* تخزين غير متاح */ }
    void api.post<void>(`/api/customer/devices`, { fcm_token: push.token, platform: push.platform ?? "android" }).then(() => {
      try { sessionStorage.setItem(key, push.token ?? ""); } catch { /* تخزين غير متاح */ }
    }, () => undefined);
  }, []);
}

export function Notifications() {
  const { refresh } = useSession();
  const nav = useNavigate();
  const list = useLoad(() => api.get<NotificationOut[]>(`/api/customer/notifications`));
  const { busy, run } = useAction();
  usePushToken();

  const unread = (list.data ?? []).filter((n) => !n.read).length;

  async function open(n: NotificationOut) {
    if (!n.read) {
      const next = await run(() => api.post<NotificationOut[]>(`/api/customer/notifications/read`, { ids: [n.id] }));
      if (next) {
        list.set(next);
        refresh();
      }
    }
    if (n.order_id) nav(`/orders/${n.order_id}`);
  }
  async function readAll() {
    const next = await run(() => api.post<NotificationOut[]>(`/api/customer/notifications/read`, { all: true }));
    if (next) {
      list.set(next);
      refresh();
    }
  }

  const denied = window.MadadPush?.permission === "denied";

  return (
    <Screen title="الإشعارات">
      {denied ? (
        <ErrorState compact title="الإشعارات موقوفة في هاتفك" body="لن يصلك إشعار انطلاق الدفعة. فعّلها من إعدادات الهاتف؛ الحرِج يصلك برسالة SMS."
          code="push_permission_denied" retryLabel="فتح الإعدادات"
          onRetry={window.MadadPush?.openSettings ? () => window.MadadPush?.openSettings?.() : undefined} />
      ) : null}
      {list.loading && !list.data ? <LoadingState rows={5} />
        : list.error && !list.data ? (
          <div className="flex-1 flex flex-col justify-center"><ErrorState title={list.error.message} code={list.error.code} onRetry={list.reload} /></div>
        ) : !list.data?.length ? (
          <div className="flex-1 flex flex-col justify-center">
            <EmptyState icon="bell" title="لا إشعارات" body="تأكيد الطلبية، وانطلاق كل دفعة، وتذكير القوائم تصلك هنا." />
          </div>
        ) : (
          <div className="flex flex-col gap-2">
            {unread ? (
              <div className="flex justify-between items-center gap-2">
                <span className="text-13 text-ink-muted"><bdi className="md-num">{unread}</bdi> غير مقروء</span>
                <Button variant="ghost" size="sm" icon="check" disabled={busy} onClick={() => void readAll()}>تعليم الكل مقروءاً</Button>
              </div>
            ) : null}
            {list.data.map((n) => (
              <button key={n.id} type="button" onClick={() => void open(n)} disabled={busy}
                className={cx("flex gap-2.5 items-start p-3 rounded-md bg-surface text-ink text-start font-sans cursor-pointer w-full",
                  n.read ? "border border-border" : "border-2 border-secondary")}
                aria-label={n.read ? n.title : `غير مقروء: ${n.title}`}>
                <span className="rounded-full bg-secondary-tint grid place-items-center p-2 shrink-0"><Icon name={ICON[n.kind] ?? "bell"} size={18} /></span>
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
