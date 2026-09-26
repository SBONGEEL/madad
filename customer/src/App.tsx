import { useEffect, useSyncExternalStore } from "react";
import { Navigate, Route, Routes } from "react-router-dom";

import { BottomNav, Button, ErrorState, LoadingState, ToastHost, useLoad } from "@ui/kit";
import { api } from "@/api/client";
import type { Me2Out } from "@/api/types";
import { localCart } from "@/lib/local-cart";
import { NAV, ROUTES } from "@/routes";
import { Login } from "@/screens/Login";
import { Recovery } from "@/screens/Recovery";
import { Register } from "@/screens/Register";
import { SessionProvider, useSession } from "@/session";

export function App() {
  const signedIn = useSyncExternalStore(api.subscribe, api.signedIn);
  return (
    <div className="md-mobile" dir="rtl">
      {signedIn ? <Signed /> : (
        <Routes>
          <Route path="/register" element={<Register />} />
          <Route path="/recover" element={<Recovery />} />
          <Route path="*" element={<Login />} />
        </Routes>
      )}
      <ToastHost />
    </div>
  );
}

function Signed() {
  const me = useLoad(() => api.get<Me2Out>("/api/customer/me"));
  if (me.loading && !me.data) return <main className="md-mobile-main"><LoadingState rows={4} /></main>;
  if (me.error || !me.data) {
    return (
      <main className="md-mobile-main">
        <ErrorState title={me.error?.message} code={me.error?.code} onRetry={me.reload} />
        <Button variant="ghost" icon="log-out" onClick={() => api.logout()}>تسجيل الخروج</Button>
      </main>
    );
  }
  // سجّل رقمه وكلمته ولم يكمل بيانات المنشأة: الخطوة 4 من التسجيل
  if (!me.data.customer) return <Register establishmentOnly onDone={me.reload} />;
  return (
    <SessionProvider me={me.data} reload={me.reload}>
      <Shell />
    </SessionProvider>
  );
}

function Shell() {
  const { cartCount, approved, refresh } = useSession();
  useEffect(() => {
    if (approved) void localCart.syncToServer().then((c) => c && refresh());
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [approved]);
  return (
    <>
      <Routes>
        {ROUTES.map(({ path, screen: S }) => <Route key={path} path={path} element={<S />} />)}
        <Route path="/login" element={<Navigate to="/" replace />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
      <BottomNav items={NAV.map((n) => ({ ...n, count: n.countKey === "cart" ? cartCount : null }))} />
    </>
  );
}
