import { useEffect, useState, useSyncExternalStore } from "react";
import { Navigate, Route, Routes } from "react-router-dom";

import { Button, EmptyState, Icon, ErrorState, LoadingState, Sidebar, ToastHost, useLoad } from "@ui/kit";
import { api } from "@/api/client";
import type { DashboardOut, InboxOut, MeOut } from "@/api/types";
import { type CountKey, NAV, ROUTES } from "@/routes";
import { Login } from "@/screens/Login";
import { Recovery } from "@/screens/Recovery";
import { SessionProvider, type Perm } from "@/session";

export function App() {
  const signedIn = useSyncExternalStore(api.subscribe, api.signedIn);
  return (
    <>
      {signedIn ? <Panel /> : (
        <Routes>
          <Route path="/recover" element={<Recovery />} />
          <Route path="*" element={<Login />} />
        </Routes>
      )}
      <ToastHost />
    </>
  );
}

function Panel() {
  const me = useLoad(() => api.get<MeOut>("/api/admin/me"));
  const [counts, setCounts] = useState<Partial<Record<CountKey, number>>>({});
  const [tick, setTick] = useState(0);

  useEffect(() => {
    if (!me.data) return;
    let live = true;
    Promise.all([
      api.get<DashboardOut>("/api/admin/dashboard").catch(() => null),
      api.get<InboxOut[]>("/api/admin/inbox").catch(() => null),
    ]).then(([d, inbox]) => {
      if (!live) return;
      const att = (d?.attention ?? {}) as Record<string, number>;
      setCounts({
        inbox: inbox?.filter((n) => !n.read).length ?? 0,
        approvals: d?.pending_approvals ?? 0,
        needs_review: (att.needs_review ?? 0) + (att.below_cost ?? 0),
        to_confirm: att.to_confirm ?? 0,
        disputes: att.disputes ?? 0,
      });
    });
    return () => { live = false; };
  }, [me.data, tick]);

  if (me.loading && !me.data) return <div className="p-8"><LoadingState rows={4} /></div>;
  if (me.error || !me.data) {
    return (
      <div className="p-8">
        <ErrorState title={me.error?.message} code={me.error?.code} onRetry={me.reload} />
        <div className="flex justify-center"><Button variant="ghost" icon="log-out" onClick={() => api.logout()}>تسجيل الخروج</Button></div>
      </div>
    );
  }

  const m = me.data;
  const isOwner = m.role === "owner";
  const can = (p: Perm) => p === "any" || isOwner || (p !== "owner" && m.permissions.includes(p));
  const sections = NAV.map((s) => ({
    title: s.title,
    items: s.items.filter((i) => can(i.perm)).map((i) => ({ ...i, count: i.count ? counts[i.count] : null })),
  })).filter((s) => s.items.length);

  return (
    <SessionProvider me={m} refreshCounts={() => setTick((t) => t + 1)}>
      <div className="md-app" dir="rtl">
        <Sidebar
          brand={<img src="/madad-logo-dark.svg" alt="مدد MADAD" className="md-side-logo" />}
          sections={sections}
          footer={
            <div className="flex items-center justify-between gap-2">
              <span>{m.full_name} · {isOwner ? "المالك" : "مشرف"} · طرابلس</span>
              <button type="button" className="md-side-out" onClick={() => api.logout()} aria-label="تسجيل الخروج" title="تسجيل الخروج">
                <Icon name="log-out" size={18} />
              </button>
            </div>
          }
        />
        <main className="flex flex-1 min-w-0">
          <Routes>
            {ROUTES.map(({ path, perm, screen: Screen }) => (
              <Route key={path} path={path} element={can(perm) ? <Screen /> : <Forbidden />} />
            ))}
            <Route path="/login" element={<Navigate to="/" replace />} />
            <Route path="*" element={<NotFound />} />
          </Routes>
        </main>
      </div>
    </SessionProvider>
  );
}

function Forbidden() {
  return <div className="md-page"><EmptyState icon="shield-check" title="لا تملك صلاحية هذا القسم" body="اطلب من المالك منحك الصلاحية من «المشرفون والصلاحيات»." /></div>;
}

function NotFound() {
  return <div className="md-page"><EmptyState icon="search" title="الصفحة غير موجودة" /></div>;
}
