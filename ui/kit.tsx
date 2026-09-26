/**
 * مكوّنات نظام التصميم المعتمد (Claude Design · Madad.*) منقولة إلى TypeScript بأسمائها وأصنافها،
 * ومعها أنماط اللوحات المتكررة (رأس الصفحة، البطاقة، الخيار، الملاحظة). كل لون وقياس من tokens.css/scale.css.
 */
import { type ReactNode, useCallback, useEffect, useId, useRef, useState } from "react";
import { NavLink } from "react-router-dom";

import { ICONS, type IconName } from "./icons";
import * as fmt from "./fmt";

export function cx(...xs: Array<string | false | null | undefined>): string {
  return xs.filter(Boolean).join(" ");
}

export type Tone = "neutral" | "info" | "success" | "warning" | "error" | "primary";

// ——— الأساس ————————————————————————————————————————————————————————————————
export function Icon({ name, size = 20, strokeWidth = 1.75, label, className }: {
  name: IconName; size?: number; strokeWidth?: number; label?: string; className?: string;
}) {
  return (
    <svg className={cx("md-icon", className)} width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor"
      strokeWidth={strokeWidth} strokeLinecap="round" strokeLinejoin="round" aria-hidden={label ? undefined : true}
      role={label ? "img" : undefined} aria-label={label} dangerouslySetInnerHTML={{ __html: ICONS[name] }} />
  );
}

export function Num({ children, className }: { children: ReactNode; className?: string }) {
  return <bdi className={cx("md-num", className)} dir="ltr">{children}</bdi>;
}

export function Money({ value, size, decimals, className }: {
  value: string | number | null | undefined; size?: "sm" | "lg"; decimals?: number; className?: string;
}) {
  return (
    <span className={cx("md-money", size && `md-money-${size}`, className)}>
      <bdi className="md-num" dir="ltr">{fmt.money(value, decimals)}</bdi>
      <span className="md-money-cur"> د.ل</span>
    </span>
  );
}

export type ButtonVariant = "primary" | "secondary" | "success" | "danger" | "ghost";
export function Button({ variant = "primary", size, block, icon, loading, disabled, type = "button", onClick, title, className, children }: {
  variant?: ButtonVariant; size?: "sm" | "lg"; block?: boolean; icon?: IconName; loading?: boolean; disabled?: boolean;
  type?: "button" | "submit"; onClick?: () => void; title?: string; className?: string; children?: ReactNode;
}) {
  return (
    <button type={type} className={cx("md-btn", `md-btn-${variant}`, size && `md-btn-${size}`, block && "md-btn-block", className)}
      disabled={disabled || loading} onClick={onClick} aria-busy={loading || undefined} title={title}>
      {loading ? <span className="md-spinner" aria-hidden /> : icon ? <Icon name={icon} size={18} /> : null}
      {children}
    </button>
  );
}

export function TextField({ label, value, onChange, placeholder, hint, error, icon, suffix, numeric, ltr, password,
  multiline, disabled, readOnly, required, autoFocus, className, type }: {
  label?: string; value: string; onChange?: (v: string) => void; placeholder?: string; hint?: string; error?: string | null;
  icon?: IconName; suffix?: string; numeric?: boolean; ltr?: boolean; password?: boolean; multiline?: boolean;
  disabled?: boolean; readOnly?: boolean; required?: boolean; autoFocus?: boolean; className?: string; type?: string;
}) {
  const id = useId();
  const [shown, setShown] = useState(false);
  const common = {
    id, className: cx("md-input", (numeric || password) && "md-num"), dir: numeric || ltr || password ? "ltr" : undefined,
    placeholder, value, disabled, readOnly, autoFocus, "aria-invalid": !!error,
    onChange: (e: { target: { value: string } }) => onChange?.(e.target.value),
  } as const;
  return (
    <label className={cx("md-field", error && "md-field-error", disabled && "md-field-disabled", className)} htmlFor={id}>
      {label ? <span className="md-field-label">{label}{required ? <span className="md-req"> *</span> : null}</span> : null}
      <span className="md-field-box">
        {icon ? <Icon name={icon} size={18} className="md-field-icon" /> : null}
        {multiline ? <textarea {...common} rows={3} />
          : <input {...common} type={password && !shown ? "password" : type ?? "text"} inputMode={numeric ? "decimal" : undefined} />}
        {suffix ? <span className="md-field-suffix">{suffix}</span> : null}
        {password ? (
          <button type="button" className="md-field-eye" aria-label={shown ? "إخفاء كلمة المرور" : "إظهار كلمة المرور"} onClick={() => setShown(!shown)}>
            <Icon name={shown ? "eye" : "eye-off"} size={18} />
          </button>
        ) : null}
      </span>
      {error ? <span className="md-field-msg md-field-msg-error" role="alert"><Icon name="circle-alert" size={14} />{error}</span>
        : hint ? <span className="md-field-msg">{hint}</span> : null}
    </label>
  );
}

export function OtpInput({ value, onChange, length = 6, error }: { value: string; onChange: (v: string) => void; length?: number; error?: string | null }) {
  const ref = useRef<HTMLInputElement>(null);
  const cells = Array.from({ length }, (_, i) => (
    <span key={i} className={cx("md-otp-cell", i === value.length && !error && "md-otp-active", error && "md-otp-error")}>{value[i] ?? ""}</span>
  ));
  return (
    <div className="md-otp" onClick={() => ref.current?.focus()}>
      <input ref={ref} className="sr-only" inputMode="numeric" autoComplete="one-time-code" autoFocus aria-label="رمز التحقق"
        value={value} maxLength={length} onChange={(e) => onChange(e.target.value.replace(/\D/g, "").slice(0, length))} />
      <div className="md-otp-row md-num" dir="ltr">{cells}</div>
      {error ? <span className="md-field-msg md-field-msg-error"><Icon name="circle-alert" size={14} />{error}</span> : null}
    </div>
  );
}

export function Switch({ checked, onChange, label, disabled }: { checked: boolean; onChange?: (v: boolean) => void; label: string; disabled?: boolean }) {
  return (
    <button type="button" role="switch" aria-checked={checked} aria-label={label} className={cx("md-switch", checked && "md-switch-on")}
      disabled={disabled} onClick={() => onChange?.(!checked)}>
      <span className="md-switch-knob" />
    </button>
  );
}

export function QtyStepper({ value, onChange, unit, max, step = 1, size }: {
  value: number; onChange?: (v: number) => void; unit?: string; max?: number; step?: number; size?: "sm";
}) {
  return (
    <div className={cx("md-qty", size === "sm" && "md-qty-sm")}>
      <button type="button" className="md-qty-btn" aria-label="زيادة" disabled={max != null && value >= max} onClick={() => onChange?.(value + step)}>
        <Icon name="plus" size={16} />
      </button>
      <span className="md-qty-val"><Num>{fmt.qty(value)}</Num>{unit ? <span className="md-qty-unit"> {unit}</span> : null}</span>
      <button type="button" className="md-qty-btn" aria-label="إنقاص" disabled={!value} onClick={() => onChange?.(Math.max(0, value - step))}>
        <Icon name="minus" size={16} />
      </button>
    </div>
  );
}

export function Card({ tone, flat, className, children }: { tone?: "brand"; flat?: boolean; className?: string; children?: ReactNode }) {
  return <div className={cx("md-card", tone && `md-card-${tone}`, flat && "md-card-flat", className)}>{children}</div>;
}

export function StatCard({ label, value, money, unit, icon, note, noteTone }: {
  label: string; value: ReactNode; money?: boolean; unit?: string; icon?: IconName; note?: ReactNode; noteTone?: "success" | "error";
}) {
  return (
    <Card className="md-stat">
      <div className="md-stat-head"><span className="md-stat-label">{label}</span>{icon ? <span className="md-stat-icon"><Icon name={icon} size={18} /></span> : null}</div>
      <div className="md-stat-value">
        {money ? <Money value={value as string} size="lg" /> : <Num>{value}</Num>}
        {unit ? <span className="md-stat-unit"> {unit}</span> : null}
      </div>
      {note ? <div className={cx("md-stat-note", noteTone && `md-tone-${noteTone}`)}>{note}</div> : null}
    </Card>
  );
}

export function StatusBadge({ tone = "neutral", icon, className, children }: { tone?: Tone; icon?: IconName; className?: string; children?: ReactNode }) {
  return (
    <span className={cx("md-badge", `md-badge-${tone}`, className)}>
      {icon ? <Icon name={icon} size={14} /> : <span className="md-badge-dot" aria-hidden />}
      {children}
    </span>
  );
}

export const ORDER_STATUS: Record<string, [string, Tone]> = {
  draft: ["مسودة", "neutral"], placed: ["بانتظار التأكيد", "warning"], confirmed: ["مؤكَّدة", "info"],
  assigned: ["أُسندت لسائق", "info"], collecting: ["جاري التجميع", "info"],
  partially_delivered: ["وصل جزء", "warning"], delivered: ["مسلَّمة", "success"], closed: ["مغلقة", "neutral"],
  cancelled: ["ملغاة", "error"],
};
export function OrderStatusBadge({ status }: { status: string }) {
  const [label, tone] = ORDER_STATUS[status] ?? [status, "neutral"];
  return <StatusBadge tone={tone}>{label}</StatusBadge>;
}

export const CATEGORY_ICON: Record<string, IconName> = {
  food: "cat-food", beverages: "cat-beverages", kitchen_tools: "cat-kitchen_tools", cleaning: "cat-cleaning",
  packaging: "cat-packaging", general: "cat-general", equipment: "cat-equipment", cooling: "cat-cooling", paper: "cat-paper", more: "cat-more",
};
export function CategoryTile({ category, label, active, onClick }: { category: string; label: string; active?: boolean; onClick?: () => void }) {
  return (
    <button type="button" className={cx("md-cat", active && "md-cat-active")} onClick={onClick} aria-pressed={active}>
      <span className="md-cat-icon"><Icon name={CATEGORY_ICON[category] ?? "cat-more"} size={28} strokeWidth={1.6} /></span>
      <span className="md-cat-label">{label}</span>
    </button>
  );
}

export function ProductCard({ name, unit, price, image, outOfStock, qty, onQty, layout }: {
  name: string; unit: string; price: string | number; image?: string | null; outOfStock?: boolean; qty?: number;
  onQty?: (v: number) => void; layout?: "row";
}) {
  return (
    <div className={cx("md-product", layout === "row" && "md-product-row", outOfStock && "md-product-oos")}>
      <div className="md-product-media">{image ? <img src={image} alt="" /> : <Icon name="package" size={28} strokeWidth={1.5} />}</div>
      <div className="md-product-body">
        <div className="md-product-name">{name}</div>
        <div className="md-product-unit">{unit}</div>
        <div className="md-product-foot">
          {outOfStock ? <StatusBadge tone="warning">نافد</StatusBadge> : <Money value={price} />}
          {outOfStock ? null : qty ? <QtyStepper value={qty} size="sm" onChange={onQty} />
            : <button type="button" className="md-product-add" aria-label="أضف إلى السلة" onClick={() => onQty?.(1)}><Icon name="plus" size={18} /></button>}
        </div>
      </div>
    </div>
  );
}

export function AppHeader({ title, markSrc, wordmarkSrc, subtitle, subtitleIcon, actions, dark }: {
  title?: string; markSrc?: string; wordmarkSrc?: string; subtitle?: ReactNode; subtitleIcon?: IconName; actions?: ReactNode; dark?: boolean;
}) {
  return (
    <header className={cx("md-header", dark && "md-header-dark")}>
      <div className="md-header-brand">
        {markSrc ? <img className="md-header-mark" src={markSrc} alt="" /> : null}
        {wordmarkSrc ? <img className="md-header-word" src={wordmarkSrc} alt="مدد" /> : <span className="md-header-title">{title}</span>}
      </div>
      {subtitle ? <div className="md-header-sub">{subtitleIcon ? <Icon name={subtitleIcon} size={16} /> : null}{subtitle}</div> : null}
      <div className="md-header-actions">{actions}</div>
    </header>
  );
}

export interface NavItem { key: string; label: string; icon: IconName; to: string; count?: number | null }

export function BottomNav({ items, dark }: { items: NavItem[]; dark?: boolean }) {
  return (
    <nav className={cx("md-bnav", dark && "md-bnav-dark")} aria-label="التنقل">
      {items.map((it) => (
        <NavLink key={it.key} to={it.to} end={it.to === "/"} className={({ isActive }) => cx("md-bnav-item", isActive && "md-bnav-on")}>
          <span className="md-bnav-ico"><Icon name={it.icon} size={22} />{it.count ? <span className="md-bnav-badge md-num">{it.count}</span> : null}</span>
          <span>{it.label}</span>
        </NavLink>
      ))}
    </nav>
  );
}

export function Sidebar({ brand, sections, footer }: { brand?: ReactNode; sections: Array<{ title?: string; items: NavItem[] }>; footer?: ReactNode }) {
  return (
    <aside className="md-side">
      {brand ? <div className="md-side-brand">{brand}</div> : null}
      <nav className="md-side-nav">
        {sections.map((sec, i) => (
          <div key={i} className="md-side-sec">
            {sec.title ? <div className="md-side-title">{sec.title}</div> : null}
            {sec.items.map((it) => (
              <NavLink key={it.key} to={it.to} end={it.to === "/"} className={({ isActive }) => cx("md-side-item", isActive && "md-side-on")}>
                <Icon name={it.icon} size={18} /><span>{it.label}</span>
                {it.count ? <span className="md-side-count md-num">{it.count}</span> : null}
              </NavLink>
            ))}
          </div>
        ))}
      </nav>
      {footer ? <div className="md-side-foot">{footer}</div> : null}
    </aside>
  );
}

// ——— الحالات ————————————————————————————————————————————————————————————————
export function EmptyState({ icon = "inbox", title, body, action, compact }: { icon?: IconName; title: string; body?: ReactNode; action?: ReactNode; compact?: boolean }) {
  return (
    <div className={cx("md-state", compact && "md-state-compact")}>
      <span className="md-state-ico"><Icon name={icon} size={28} strokeWidth={1.5} /></span>
      <div className="md-state-title">{title}</div>
      {body ? <div className="md-state-body">{body}</div> : null}
      {action ? <div className="md-state-act">{action}</div> : null}
    </div>
  );
}

export function ErrorState({ title, body, code, onRetry, retryLabel, compact }: {
  title?: string; body?: string; code?: string; onRetry?: () => void; retryLabel?: string; compact?: boolean;
}) {
  return (
    <div className={cx("md-state md-state-error", compact && "md-state-compact")} role="alert">
      <span className="md-state-ico"><Icon name="triangle-alert" size={28} strokeWidth={1.5} /></span>
      <div className="md-state-title">{title ?? "تعذّر التحميل"}</div>
      <div className="md-state-body">{body ?? "تحقق من اتصالك ثم أعد المحاولة."}</div>
      {code ? <div className="md-state-code md-num" dir="ltr">{code}</div> : null}
      {onRetry ? <div className="md-state-act"><Button variant="secondary" icon="refresh-cw" size="sm" onClick={onRetry}>{retryLabel ?? "إعادة المحاولة"}</Button></div> : null}
    </div>
  );
}

export function LoadingState({ rows = 3, label }: { rows?: number; label?: string }) {
  return (
    <div className="md-loading" aria-busy aria-label={label ?? "جاري التحميل"}>
      {Array.from({ length: rows }, (_, i) => (
        <div key={i} className="md-skel-row">
          <span className="md-skel md-skel-box" />
          <span className="md-skel-lines"><span className="md-skel md-skel-line" /><span className="md-skel md-skel-line md-skel-short" /></span>
        </div>
      ))}
    </div>
  );
}

// ——— الجدول ————————————————————————————————————————————————————————————————
export interface Column<R> {
  key: string; label: ReactNode; money?: boolean; numeric?: boolean; width?: string; className?: string;
  render?: (row: R) => ReactNode;
}

export function DataTable<R>({ columns, rows, loading, error, onRetry, emptyIcon, emptyTitle, emptyBody, rowTone, rowKey, onRowClick }: {
  columns: Array<Column<R>>; rows: R[] | null | undefined; loading?: boolean; error?: { code: string; message: string } | null;
  onRetry?: () => void; emptyIcon?: IconName; emptyTitle?: string; emptyBody?: ReactNode;
  rowTone?: (row: R) => "warning" | "error" | null | undefined | false; rowKey?: (row: R, i: number) => string | number;
  onRowClick?: (row: R) => void;
}) {
  let body: ReactNode;
  const span = columns.length;
  if (loading && !rows) body = <tr><td colSpan={span}><LoadingState rows={3} /></td></tr>;
  else if (error) body = <tr><td colSpan={span}><ErrorState compact title={error.message} code={error.code} onRetry={onRetry} /></td></tr>;
  else if (!rows || !rows.length) body = <tr><td colSpan={span}><EmptyState compact icon={emptyIcon} title={emptyTitle ?? "لا بيانات"} body={emptyBody} /></td></tr>;
  else body = rows.map((r, i) => {
    const tone = rowTone?.(r);
    return (
      <tr key={rowKey ? rowKey(r, i) : i} className={cx(tone && `md-row-${tone}`, onRowClick && "cursor-pointer")} onClick={onRowClick ? () => onRowClick(r) : undefined}>
        {columns.map((c) => {
          const v = c.render ? c.render(r) : (r as Record<string, unknown>)[c.key];
          const content = c.render ? (v as ReactNode) : c.money ? <Money value={v as string} /> : c.numeric ? <Num>{v as ReactNode}</Num> : (v as ReactNode);
          return <td key={c.key} className={cx((c.numeric || c.money) && "md-td-num", c.className)}>{content}</td>;
        })}
      </tr>
    );
  });
  return (
    <div className="md-table-wrap">
      <table className="md-table">
        <thead><tr>{columns.map((c) => <th key={c.key} className={c.numeric || c.money ? "md-td-num" : undefined} style={c.width ? { width: c.width } : undefined}>{c.label}</th>)}</tr></thead>
        <tbody>{body}</tbody>
      </table>
    </div>
  );
}

// ——— النوافذ ————————————————————————————————————————————————————————————————
export function Dialog({ open, onClose, wide, children, label }: { open: boolean; onClose: () => void; wide?: boolean; children: ReactNode; label?: string }) {
  useEffect(() => {
    if (!open) return;
    const esc = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", esc);
    return () => window.removeEventListener("keydown", esc);
  }, [open, onClose]);
  if (!open) return null;
  return (
    <div className="md-dialog-scrim z-40" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className={cx("md-dialog", wide && "md-dialog-wide")} role="dialog" aria-modal aria-label={label}>{children}</div>
    </div>
  );
}

export function ConfirmDialog({ open, tone = "primary", icon, title, body, children, confirmLabel, cancelLabel, loading, onConfirm, onCancel, confirmDisabled }: {
  open: boolean; tone?: "primary" | "error" | "warning"; icon?: IconName; title: ReactNode; body?: ReactNode; children?: ReactNode;
  confirmLabel?: string; cancelLabel?: string; loading?: boolean; onConfirm: () => void; onCancel: () => void; confirmDisabled?: boolean;
}) {
  return (
    <Dialog open={open} onClose={onCancel}>
      <div className={cx("md-dialog-ico", `md-tone-bg-${tone}`)}><Icon name={icon ?? (tone === "primary" ? "circle-check" : "triangle-alert")} size={22} /></div>
      <div className="md-dialog-title">{title}</div>
      {body ? <div className="md-dialog-body">{body}</div> : null}
      {children}
      <div className="md-dialog-actions">
        <Button variant={tone === "error" ? "danger" : "primary"} block loading={loading} disabled={confirmDisabled} onClick={onConfirm}>{confirmLabel ?? "تأكيد"}</Button>
        <Button variant="ghost" block onClick={onCancel}>{cancelLabel ?? "إلغاء"}</Button>
      </div>
    </Dialog>
  );
}

// ——— أنماط اللوحات المتكررة ————————————————————————————————————————————————————
export function PageHead({ title, sub, actions }: { title: ReactNode; sub?: ReactNode; actions?: ReactNode }) {
  return (
    <div className="md-page-head">
      <div className="flex flex-col gap-0.5"><h1 className="md-page-title">{title}</h1>{sub ? <span className="md-page-sub">{sub}</span> : null}</div>
      {actions ? <div className="flex gap-2 flex-wrap">{actions}</div> : null}
    </div>
  );
}

export function Section({ title, right, children, className, large }: { title?: ReactNode; right?: ReactNode; children?: ReactNode; className?: string; large?: boolean }) {
  return (
    <section className={cx("md-sec", className)}>
      {title || right ? <div className="md-sec-head">{title ? <h2 className={large ? "md-sec-title-lg" : "md-sec-title"}>{title}</h2> : <span />}{right}</div> : null}
      {children}
    </section>
  );
}

export function SectionTitle({ title, sub }: { title: ReactNode; sub?: ReactNode }) {
  return <div className="md-h2"><h2>{title}</h2>{sub ? <span>{sub}</span> : null}</div>;
}

export function Option({ label, sub, selected, initial, onSelect, disabled }: {
  label: ReactNode; sub?: ReactNode; selected: boolean; initial?: boolean; onSelect?: () => void; disabled?: boolean;
}) {
  return (
    <button type="button" role="radio" aria-checked={selected} className={cx("md-opt", selected && "md-opt-on")} onClick={onSelect} disabled={disabled}>
      <span className="md-opt-mark" />
      <span className="md-opt-body">
        <b className="md-opt-label">{label}</b>
        {sub ? <span className="md-opt-sub">{sub}</span> : null}
        {initial ? <span className="md-opt-ini">الابتدائي</span> : null}
      </span>
    </button>
  );
}

/** مجموعة خيارات لإعداد واحد: تُرسل القيمة عند الاختيار. */
export function OptionGroup<V extends string>({ value, options, onChange, columns = 1, disabled }: {
  value: V; options: Array<{ value: V; label: ReactNode; sub?: ReactNode; initial?: boolean }>; onChange: (v: V) => void; columns?: 1 | 2 | 3; disabled?: boolean;
}) {
  return (
    <div role="radiogroup" className={cx("grid gap-2", columns === 2 && "grid-cols-2", columns === 3 && "grid-cols-3")}>
      {options.map((o) => (
        <Option key={o.value} label={o.label} sub={o.sub} initial={o.initial} selected={o.value === value} disabled={disabled} onSelect={() => o.value !== value && onChange(o.value)} />
      ))}
    </div>
  );
}

export function Note({ tone = "primary", children }: { tone?: "primary" | "warning" | "error" | "info" | "success"; children: ReactNode }) {
  return <div className={cx("md-note", `md-note-${tone}`)}>{children}</div>;
}

export function Select<V extends string>({ label, value, onChange, options, disabled }: {
  label?: string; value: V; onChange: (v: V) => void; options: Array<{ value: V; label: string }>; disabled?: boolean;
}) {
  const id = useId();
  return (
    <label className="md-field" htmlFor={id}>
      {label ? <span className="md-field-label">{label}</span> : null}
      <select id={id} className="md-select" value={value} disabled={disabled} onChange={(e) => onChange(e.target.value as V)}>
        {options.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
      </select>
    </label>
  );
}

export function Tabs<V extends string>({ value, onChange, tabs }: { value: V; onChange: (v: V) => void; tabs: Array<{ value: V; label: ReactNode }> }) {
  return (
    <div className="md-tabs" role="tablist">
      {tabs.map((t) => (
        <button key={t.value} type="button" role="tab" aria-selected={t.value === value} className={cx("md-tab", t.value === value && "md-tab-on")} onClick={() => onChange(t.value)}>{t.label}</button>
      ))}
    </div>
  );
}

export function Kv({ k, v, strong }: { k: ReactNode; v: ReactNode; strong?: boolean }) {
  return <div className="md-kv"><span className={strong ? undefined : "md-muted"}>{k}</span>{strong ? <b>{v}</b> : <span>{v}</span>}</div>;
}

// ——— تنبيه عابر ——————————————————————————————————————————————————————————————
type ToastMsg = { text: string; error?: boolean; id: number };
let pushToast: ((m: Omit<ToastMsg, "id">) => void) | null = null;

export function toast(text: string, error = false) {
  pushToast?.({ text, error });
}

export function ToastHost() {
  const [msg, setMsg] = useState<ToastMsg | null>(null);
  useEffect(() => {
    pushToast = (m) => setMsg({ ...m, id: Date.now() });
    return () => {
      pushToast = null;
    };
  }, []);
  useEffect(() => {
    if (!msg) return;
    const t = setTimeout(() => setMsg(null), 3500);
    return () => clearTimeout(t);
  }, [msg]);
  return msg ? <div className={cx("md-toast", msg.error && "md-toast-error")} role="status" key={msg.id}>{msg.text}</div> : null;
}

// ——— تحميل البيانات ——————————————————————————————————————————————————————————
export interface Loaded<T> {
  data: T | null; loading: boolean; error: { code: string; message: string } | null; reload: () => void; set: (v: T) => void;
}

export function useLoad<T>(fn: () => Promise<T>, deps: unknown[] = []): Loaded<T> {
  const [data, setData] = useState<T | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<{ code: string; message: string } | null>(null);
  const [tick, setTick] = useState(0);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const run = useCallback(fn, deps);
  useEffect(() => {
    let live = true;
    setLoading(true);
    run().then(
      (v) => { if (live) { setData(v); setError(null); setLoading(false); } },
      (e: unknown) => {
        if (!live) return;
        const err = e as { code?: string; message?: string };
        setError({ code: err.code ?? "error", message: err.message ?? "تعذّر التحميل" });
        setLoading(false);
      },
    );
    return () => { live = false; };
  }, [run, tick]);
  return { data, loading, error, reload: () => setTick((t) => t + 1), set: setData };
}

/** تنفيذ عملية كتابة: حالة الانشغال، ورسالة الخطأ بالعربية في تنبيه عابر. */
export function useAction() {
  const [busy, setBusy] = useState(false);
  const run = useCallback(async <T,>(fn: () => Promise<T>, ok?: string): Promise<T | undefined> => {
    setBusy(true);
    try {
      const v = await fn();
      if (ok) toast(ok);
      return v;
    } catch (e) {
      toast((e as Error).message, true);
      return undefined;
    } finally {
      setBusy(false);
    }
  }, []);
  return { busy, run };
}

/** كتلة تحميل/خطأ/محتوى لقسم يعتمد على طلب. */
export function Loader<T>({ state, children, rows, empty }: { state: Loaded<T>; children: (data: T) => ReactNode; rows?: number; empty?: ReactNode }) {
  if (state.loading && state.data === null) return <LoadingState rows={rows ?? 3} />;
  if (state.error && state.data === null) return <ErrorState compact title={state.error.message} code={state.error.code} onRetry={state.reload} />;
  if (state.data === null) return <>{empty}</>;
  return <>{children(state.data)}</>;
}
