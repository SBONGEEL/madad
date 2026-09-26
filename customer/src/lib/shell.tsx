/** رأس التطبيق (CHeader) بنسختيه: الرئيسية بالشعار والجرس واسم المنشأة، والداخلية بزر رجوع وعنوان. */
import type { ReactNode } from "react";
import { Link, useNavigate } from "react-router-dom";

import { Icon } from "@ui/kit";
import { useSession } from "@/session";

export function HomeHeader() {
  const { me } = useSession();
  return (
    <header className="md-header">
      <div className="md-header-brand"><img src="/madad-logo-light.svg" alt="مدد MADAD" className="md-home-logo" /></div>
      <div className="md-header-actions">
        <Link to="/notifications" aria-label="الإشعارات" className="md-bell">
          <Icon name="bell" size={22} />
          {me.unread ? <span className="md-bell-dot" /> : null}
        </Link>
      </div>
      <div className="md-header-sub"><Icon name="store" size={16} />{me.customer?.name}</div>
    </header>
  );
}

export function BackHeader({ title, to, action }: { title: ReactNode; to?: string; action?: ReactNode }) {
  const nav = useNavigate();
  return (
    <header className="md-backbar">
      <button type="button" className="md-backbar-btn" aria-label="رجوع" onClick={() => (to ? nav(to) : nav(-1))}>
        <Icon name="chevron-right" size={22} />
      </button>
      <span className="md-backbar-title">{title}</span>
      {action}
    </header>
  );
}

/** صفحة داخلية: رأس رجوع ثم محتوى بعمود واحد. */
export function Screen({ title, back, action, children, flush }: {
  title: ReactNode; back?: string; action?: ReactNode; children: ReactNode; flush?: boolean;
}) {
  return (
    <>
      <BackHeader title={title} to={back} action={action} />
      <main className={flush ? "md-mobile-main md-mobile-main-flush" : "md-mobile-main"}>{children}</main>
    </>
  );
}
