/**
 * 08 الملف (M-11، الأمانة): الاسم والمركبة والسعة والمدينة، والحالة، وطريقة صرف الأجر («يحددها مَدَد»)،
 * وأمانة الطلبيات الملغاة بعهدتك، وقائمة (التسويات، الإشعارات، أوراقي، خروج).
 * «أوراقي» حالة الأوراق وحدها بلا صورها (قرار المالك 27/09). الإشعارات عرض فرعي (?view=notifications).
 * «أستقبل طلبيات الآن» و«تواصل مع مَدَد» (§12-ط، 27/09). لا موقع حيّ، فلا حالة إذن الموقع.
 * رمز الإشعار الفوري يأتي من غلاف Android (window.MadadPush) حين يوجد؛ نسخة الويب بلا FCM.
 */
import { useEffect, useState } from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";

import * as fmt from "@ui/fmt";
import { Button, EmptyState, ErrorState, Icon, LoadingState, Note, Num, StatusBadge, cx, useAction, useLoad } from "@ui/kit";
import type { IconName } from "@ui/icons";
import { api } from "@/api/client";
import type { CustodyItemOut, NotificationOut } from "@/api/types";
import { Availability, DRIVER_STATUS, PAY_METHOD, VEHICLE, lineQty, when } from "@/lib/acc-ui";
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
    const key = "madad.driver.push";
    try {
      if (sessionStorage.getItem(key) === push.token) return;
    } catch { /* تخزين غير متاح */ }
    void api.post<void>(`/api/driver/devices`, { fcm_token: push.token, platform: push.platform ?? "android" }).then(() => {
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

const ROW = "flex items-center gap-3 py-3.5 px-3 bg-surface border border-border rounded-md text-ink no-underline font-sans text-start w-full";

function Account() {
  const { me } = useSession();
  const d = me.driver;
  const [docs, setDocs] = useState(false);
  const st = DRIVER_STATUS[d?.status ?? ""];
  const facts = d ? [VEHICLE[d.vehicle] ?? d.vehicle, d.capacity_kg ? `${fmt.qty(d.capacity_kg)} كغ` : null, d.city_name].filter(Boolean).join(" · ") : "";

  return (
    <>
      <HomeHeader />
      <main className="md-mobile-main">
        <div className="flex flex-col gap-2.5">
          {d?.status === "suspended" ? (
            <EmptyState icon="eye-off" title="حسابك موقوف" body="لا تصلك طلبيات جديدة. تواصل مع مَدَد لمعرفة السبب. رصيدك وأجرك محفوظان." />
          ) : null}

          <section className="bg-surface border border-border rounded-lg p-3.5 flex gap-3 items-center">
            <span className="rounded-full bg-secondary-tint grid place-items-center p-3.5 shrink-0"><Icon name="user" size={28} /></span>
            <div className="flex flex-col gap-0.5 min-w-0 flex-1">
              <span className="font-bold text-17">{d?.full_name ?? me.full_name}</span>
              {facts ? <span className="text-14 text-ink-muted">{facts}</span> : null}
            </div>
            {st ? <StatusBadge tone={st[1]} icon={d?.status === "approved" ? "shield-check" : undefined}>{st[0]}</StatusBadge> : null}
          </section>

          {d?.status === "approved" ? <Availability accepting={d.accepting ?? true} /> : null}

          {d?.status === "pending" ? <Note tone="warning">نراجع أوراقك. نبلغك حين تُعتمد، ومعها طريقة صرف أجرك التي يحددها مَدَد.</Note> : null}
          {d?.status === "rejected" ? <Note tone="error">لم يُعتمد حسابك. راجع فريق مَدَد لمعرفة السبب.</Note> : null}

          <div className="flex justify-between items-center gap-2 p-3 bg-surface border border-border rounded-md">
            <div className="flex flex-col">
              <span className="text-13 text-ink-muted">طريقة صرف أجرك</span>
              <span className="font-bold">{d?.pay_method ? PAY_METHOD[d.pay_method] ?? d.pay_method : "لم تُحدَّد بعد"}</span>
            </div>
            <StatusBadge tone="neutral">يحددها مَدَد</StatusBadge>
          </div>

          <Custody />

          <Link to="/settlements" className={ROW}>
            <Icon name="hand-coins" /><span className="flex-1">التسويات</span><Icon name="chevron-left" size={18} />
          </Link>
          <Link to="/profile?view=notifications" className={ROW}>
            <Icon name="bell" /><span className="flex-1">الإشعارات</span>
            {me.unread ? <StatusBadge tone="primary"><Num>{me.unread}</Num></StatusBadge> : null}
            <Icon name="chevron-left" size={18} />
          </Link>
          <button type="button" className={cx(ROW, "cursor-pointer")} aria-expanded={docs} onClick={() => setDocs(!docs)}>
            <Icon name="file-text" /><span className="flex-1">أوراقي (الهوية والرخصة)</span>
            <Icon name={docs ? "chevron-right" : "chevron-left"} size={18} />
          </button>
          {docs && d ? (
            <div className="bg-surface border border-border rounded-md p-3 flex flex-col gap-2">
              <div className="flex justify-between items-center gap-2">
                <span>الهوية والرخصة بوجهيها والصورة</span>
                {d.documents_complete
                  ? <StatusBadge tone="success" icon="circle-check">مكتملة</StatusBadge>
                  : <StatusBadge tone="warning">ناقصة</StatusBadge>}
              </div>
              <div className="flex justify-between items-center gap-2">
                <span>الاعتماد</span>
                {st ? <StatusBadge tone={st[1]}>{st[0]}</StatusBadge> : null}
              </div>
              <span className="text-13 text-ink-muted">أوراقك عند مَدَد وحده. لتحديثها تواصل مع فريق مَدَد.</span>
            </div>
          ) : null}
          {me.contact?.phone || me.contact?.whatsapp ? (
            <div className={ROW}>
              <Icon name="phone" /><span className="flex-1">تواصل مع مَدَد</span>
              {me.contact.phone ? <a className="md-link" href={`tel:${me.contact.phone}`}>اتصال</a> : null}
              {me.contact.whatsapp ? <a className="md-link" href={`https://wa.me/${me.contact.whatsapp.replace("+", "")}`} target="_blank" rel="noreferrer">واتساب</a> : null}
            </div>
          ) : null}
          <button type="button" className={cx(ROW, "cursor-pointer")} onClick={() => void api.logout()}>
            <Icon name="log-out" /><span className="flex-1">خروج</span><Icon name="chevron-left" size={18} />
          </button>
        </div>
      </main>
    </>
  );
}

/** أمانة بعهدتي من طلبيات ملغاة: صنف وكمية، بلا تكلفة ولا مورد. */
function Custody() {
  const list = useLoad(() => api.get<CustodyItemOut[]>(`/api/driver/custody`));
  if (list.loading && !list.data) return <LoadingState rows={1} />;
  if (list.error && !list.data) return <ErrorState compact title="تعذّر تحميل الأمانة" code={list.error.code} onRetry={list.reload} />;
  if (!list.data?.length) return null;
  const waiting = list.data.some((k) => k.status === "open");
  return (
    <section className="bg-warning-tint rounded-lg p-3 flex flex-col gap-2">
      <div className="flex justify-between items-center gap-2">
        <b>أمانة بعهدتك</b>
        <StatusBadge tone="warning">{waiting ? "بانتظار قرار مَدَد" : "قرّر مَدَد مصيرها"}</StatusBadge>
      </div>
      {list.data.map((k) => (
        <div key={k.id} className="flex justify-between gap-2 text-14">
          <span>{k.name_ar} <span className="text-ink-muted">· طلبية <Num>#{k.order_id}</Num></span></span>
          <Num className="font-bold shrink-0">{lineQty(k.qty, k.unit, k.unit_size)}</Num>
        </div>
      ))}
      <span className="text-13">من طلبية ملغاة. احتفظ بها حتى يبلغك مَدَد بمصيرها: المخزن، أو المورد، أو طلبية أخرى. لا تُقفل تسويتك قبلها.</span>
    </section>
  );
}

const KIND_ICON: Record<string, IconName> = {
  order_assigned: "truck",
  driver_settlement: "hand-coins",
  driver_approved: "shield-check",
  broadcast: "megaphone",
};

function Notifications() {
  const { refresh } = useSession();
  const nav = useNavigate();
  const list = useLoad(() => api.get<NotificationOut[]>(`/api/driver/notifications`));
  const { busy, run } = useAction();
  const unread = (list.data ?? []).filter((n) => !n.read).length;

  async function open(n: NotificationOut) {
    if (!n.read) {
      const next = await run(() => api.post<NotificationOut[]>(`/api/driver/notifications/read`, { ids: [n.id] }));
      if (next) { list.set(next); refresh(); }
    }
    if (n.order_id) nav(`/route/${n.order_id}`);
  }
  async function readAll() {
    const next = await run(() => api.post<NotificationOut[]>(`/api/driver/notifications/read`, { all: true }));
    if (next) { list.set(next); refresh(); }
  }

  const denied = window.MadadPush?.permission === "denied";
  return (
    <Screen title="الإشعارات" back="/profile">
      {denied ? (
        <ErrorState compact title="الإشعارات موقوفة في هاتفك" body="لن يصلك إشعار الطلبيات المسندة إليك. فعّلها من إعدادات الهاتف."
          code="push_permission_denied" retryLabel="فتح الإعدادات"
          onRetry={window.MadadPush?.openSettings ? () => window.MadadPush?.openSettings?.() : undefined} />
      ) : null}
      {list.loading && !list.data ? <LoadingState rows={5} />
        : list.error && !list.data ? (
          <div className="flex-1 flex flex-col justify-center"><ErrorState title={list.error.message} code={list.error.code} onRetry={list.reload} /></div>
        ) : !list.data?.length ? (
          <div className="flex-1 flex flex-col justify-center">
            <EmptyState icon="bell" title="لا إشعارات" body="الطلبيات المسندة إليك، وتسليم الكاش وصرف أجرك تصلك هنا." />
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
              <button key={n.id} type="button" onClick={() => void open(n)} disabled={busy}
                className={cx("flex gap-2.5 items-start p-3 rounded-md bg-surface text-ink text-start font-sans cursor-pointer w-full",
                  n.read ? "border border-border" : "border-2 border-secondary")}
                aria-label={n.read ? n.title : `غير مقروء: ${n.title}`}>
                <span className="rounded-full bg-secondary-tint grid place-items-center p-2 shrink-0"><Icon name={KIND_ICON[n.kind] ?? "bell"} size={18} /></span>
                <span className="flex flex-col gap-0.5 flex-1 min-w-0">
                  <span className="font-bold text-14">{n.title}</span>
                  <span className="text-13 text-ink-muted">{n.body}</span>
                </span>
                <span className="text-12 text-ink-muted md-num shrink-0">{when(n.created_at, false)}</span>
              </button>
            ))}
          </div>
        )}
    </Screen>
  );
}
