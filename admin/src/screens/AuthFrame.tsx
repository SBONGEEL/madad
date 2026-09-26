/** إطار الدخول والاستعادة (Login · AdminRecovery): لوح الهوية في البداية، والبطاقة في الوسط. */
import type { ReactNode } from "react";

export function AuthFrame({ children }: { children: ReactNode }) {
  return (
    <div className="md-auth" dir="rtl">
      <div className="md-auth-brand">
        <img src="/madad-logo-dark.svg" alt="مدد MADAD" className="md-auth-logo" />
        <div className="flex flex-col gap-3">
          <div className="md-auth-slogan">إمداد أعمالك<br />ببساطة.</div>
          <div className="text-16 text-on-primary-muted">لوحة المالك والمشرفين — طرابلس</div>
        </div>
        <div className="text-13 text-on-primary-muted">الدخول برقم الهاتف وكلمة المرور. رمز التحقق مرة واحدة فقط عند تفعيل الحساب.</div>
      </div>
      <div className="md-auth-main">{children}</div>
    </div>
  );
}

export function AuthCard({ step, title, sub, children }: { step: string; title: string; sub?: ReactNode; children: ReactNode }) {
  return (
    <section className="md-auth-card">
      <span className="text-12 text-ink-muted font-bold">{step}</span>
      <h1 className="md-page-title">{title}</h1>
      {sub ? <span className="text-14 text-ink-muted">{sub}</span> : null}
      {children}
    </section>
  );
}
