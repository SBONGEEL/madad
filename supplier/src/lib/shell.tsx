/** رأس تطبيق المورد (SHeader): الرئيسية بالشعار وشارة الاعتماد و«المورد · اسم المحل»، والداخلية برجوع وعنوان. */
import type { ReactNode } from "react";
import { useNavigate } from "react-router-dom";

import { Icon, StatusBadge } from "@ui/kit";
import { useSession } from "@/session";

const STATUS: Record<string, [string, "primary" | "warning" | "error"]> = {
  approved: ["معتمد", "primary"], pending: ["بانتظار الاعتماد", "warning"], suspended: ["موقوف", "error"], rejected: ["مرفوض", "error"],
};

export function HomeHeader() {
  const { me } = useSession();
  const st = STATUS[me.supplier?.status ?? ""] ?? ["", "primary"];
  return (
    <header className="md-header">
      <div className="md-header-brand"><img src="/madad-logo-light.svg" alt="مدد MADAD" className="md-home-logo" /></div>
      <div className="md-header-actions">
        {st[0] ? <StatusBadge tone={st[1]} icon={st[1] === "primary" ? "shield-check" : undefined}>{st[0]}</StatusBadge> : null}
      </div>
      <div className="md-header-sub"><Icon name="store" size={16} />المورد · {me.supplier?.name}</div>
    </header>
  );
}

export function Screen({ title, back, action, children }: { title: ReactNode; back?: string; action?: ReactNode; children: ReactNode }) {
  const nav = useNavigate();
  return (
    <>
      <header className="md-backbar">
        <button type="button" className="md-backbar-btn" aria-label="رجوع" onClick={() => (back ? nav(back) : nav(-1))}>
          <Icon name="chevron-right" size={22} />
        </button>
        <span className="md-backbar-title">{title}</span>
        {action}
      </header>
      <main className="md-mobile-main">{children}</main>
    </>
  );
}
