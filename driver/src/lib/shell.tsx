/** رأس تطبيق السائق الداكن (DHeader): الرئيسية بالشعار و«مندوب التوصيل» وحالة الاتصال، والداخلية برجوع وعنوان. */
import { type ReactNode, useSyncExternalStore } from "react";
import { useNavigate } from "react-router-dom";

import { Icon, StatusBadge } from "@ui/kit";

function subscribeOnline(f: () => void) {
  window.addEventListener("online", f);
  window.addEventListener("offline", f);
  return () => { window.removeEventListener("online", f); window.removeEventListener("offline", f); };
}

/** «متصل» = اتصال الجهاز بالشبكة. «أستقبل طلبيات الآن» لا عمود له في القاعدة (يُبلَّغ المالك). */
export function useOnline(): boolean {
  return useSyncExternalStore(subscribeOnline, () => navigator.onLine);
}

export function HomeHeader() {
  const online = useOnline();
  return (
    <header className="md-dheader">
      <img src="/madad-logo-dark.svg" alt="مدد MADAD" className="md-dheader-logo" />
      <span className="md-dheader-role">مندوب التوصيل</span>
      <StatusBadge tone={online ? "success" : "error"}>{online ? "متصل" : "غير متصل"}</StatusBadge>
    </header>
  );
}

export function Screen({ title, back, action, children, flush }: {
  title: ReactNode; back?: string; action?: ReactNode; children: ReactNode; flush?: boolean;
}) {
  const nav = useNavigate();
  return (
    <>
      <header className="md-dheader">
        <button type="button" className="md-backbar-btn md-dheader-back" aria-label="رجوع" onClick={() => (back ? nav(back) : nav(-1))}>
          <Icon name="chevron-right" size={24} />
        </button>
        <span className="md-dheader-title">{title}</span>
        {action}
      </header>
      <main className={flush ? "md-mobile-main md-mobile-main-flush" : "md-mobile-main"}>{children}</main>
    </>
  );
}
