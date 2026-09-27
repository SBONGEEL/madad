/** 01 الرئيسية: أرقام اليوم، ومبيعات 7 أيام (رسم SVG مكتوب — ت-24)، وما يحتاج الانتباه، وآخر الطلبيات. */
import { Link, useNavigate } from "react-router-dom";

import * as fmt from "@ui/fmt";
import { Button, DataTable, Icon, Money, Note, Num, OrderStatusBadge, PageHead, Section, StatCard, StatusBadge, useLoad, type Tone } from "@ui/kit";
import type { IconName } from "@ui/icons";
import { api } from "@/api/client";
import type { BackupsOut, DashboardOut, OrderRowOut } from "@/api/types";
import { downloadCsv } from "@/lib/csv";
import { useSession } from "@/session";

export function Main() {
  const d = useLoad(() => api.get<DashboardOut>("/api/admin/dashboard"));
  const { can, isOwner } = useSession();
  // تنبيه النسخ (§12-ي ن-3): للمالك وحده، يبقى حتى تنجح نسخة
  const backups = useLoad(() => (isOwner ? api.get<BackupsOut>("/api/admin/backups").catch(() => null) : Promise.resolve(null)), [isOwner]);
  const nav = useNavigate();
  const now = new Date();
  const data = d.data;
  const att = (data?.attention ?? {}) as Record<string, number>;
  const week = (data?.sales_7d ?? []) as Array<{ day: string; sales: string }>;
  const weekTotal = week.reduce((s, w) => s + Number(w.sales), 0);

  const all: Array<{ icon: IconName; label: string; count: number; tone: Tone; to: string; show: boolean }> = [
    { icon: "shield-check", label: "طلبات اعتماد جديدة", count: data?.pending_approvals ?? 0, tone: "warning", to: "/approvals", show: can("approvals") },
    { icon: "clipboard-list", label: "طلبيات بانتظار التأكيد", count: att.to_confirm ?? 0, tone: "warning", to: "/orders", show: can("orders") },
    { icon: "triangle-alert", label: "نزاعات مفتوحة", count: att.disputes ?? 0, tone: "error", to: "/disputes", show: can("orders") },
    { icon: "tags", label: "أسعار شراء تغيّرت — راجِع البيع", count: att.needs_review ?? 0, tone: "warning", to: "/catalog", show: can("catalog") },
    { icon: "tags", label: "أصناف تحت التكلفة", count: att.below_cost ?? 0, tone: "error", to: "/catalog", show: can("catalog") },
  ];
  const attention = all.filter((a) => a.show && a.count > 0);

  function exportCsv() {
    downloadCsv(`madad-orders-${fmt.today()}.csv`, ["الطلبية", "المنشأة", "الفرع", "السائق", "الحالة", "الإجمالي"],
      (data?.latest ?? []).map((o) => [`#${o.id}`, o.customer_name, o.branch_name, o.driver_name ?? "—", o.status, fmt.money(o.total)]));
  }

  return (
    <div className="md-page">
      <PageHead title="لوحة التحكم"
        sub={<>طرابلس · {fmt.weekday(now)} <Num>{fmt.date(now.toISOString())}</Num> · آخر تحديث <Num>{fmt.time(now.toISOString())}</Num></>}
        actions={<>
          <Button variant="secondary" icon="refresh-cw" size="sm" loading={d.loading && !!data} onClick={d.reload}>تحديث</Button>
          <Button icon="file-text" size="sm" onClick={exportCsv} disabled={!data?.latest.length}>تصدير CSV</Button>
        </>} />

      {backups.data?.alert ? (
        <Note tone={backups.data.alert === "failed" ? "error" : "warning"}>
          <b>{backups.data.alert === "failed" ? "فشلت النسخة الاحتياطية الأخيرة." : "مرّ يوم بلا نسخة احتياطية ناجحة."}</b>
          {" "}افتح <Link to="/settings/backups" className="md-link">«النسخ الاحتياطية»</Link>.
        </Note>
      ) : null}

      <div className="grid grid-cols-5 gap-4">
        <StatCard label="المطاعم والمقاهي" value={fmt.int(data?.customers)} icon="store" />
        <StatCard label="الموردون المعتمدون" value={fmt.int(data?.suppliers_approved)} icon="package"
          note={data?.pending_approvals ? `${data.pending_approvals} بانتظار الاعتماد` : undefined} />
        <StatCard label="الطلبيات اليوم" value={fmt.int(data?.orders_today)} icon="clipboard-list" />
        <StatCard label="المبيعات اليوم" value={data?.sales_today ?? "0"} money icon="banknote" />
        {data?.profit_today != null
          ? <StatCard label="الربح التقديري اليوم" value={data.profit_today} money icon="chart-column" note="بعد أجر السائقين" />
          : null}
      </div>

      <div className="grid grid-cols-3 gap-4">
        <Section large title="المبيعات خلال 7 أيام" className="col-span-2"
          right={<span className="text-13 text-ink-muted">المجموع <Money value={weekTotal} /></span>}>
          <WeekChart week={week} />
        </Section>
        <Section large title="تحتاج انتباهك">
          {attention.length ? attention.map((a) => (
            <Link key={a.label} to={a.to} className="md-row-link">
              <Icon name={a.icon} size={18} />
              <span className="flex-1 text-14">{a.label}</span>
              <StatusBadge tone={a.tone}>{a.count}</StatusBadge>
            </Link>
          )) : <span className="text-14 text-ink-muted">لا شيء ينتظرك الآن.</span>}
        </Section>
      </div>

      <section className="flex flex-col gap-2.5">
        <div className="flex justify-between items-center">
          <h2 className="md-sec-title-lg">آخر الطلبيات</h2>
          {can("orders") ? <Link to="/orders" className="md-link text-14">اللوحة الحية</Link> : null}
        </div>
        <DataTable<OrderRowOut>
          rows={data?.latest} loading={d.loading} error={d.error} onRetry={d.reload}
          emptyIcon="clipboard-list" emptyTitle="لا طلبيات اليوم بعد" emptyBody="أول طلبية تصل تظهر هنا، مع أرقام اليوم."
          rowKey={(o) => o.id} rowTone={(o) => o.status === "placed" && "warning"}
          onRowClick={can("orders") ? (o) => nav(`/orders?open=${o.id}`) : undefined}
          columns={[
            { key: "id", label: "الطلبية", render: (o) => <Num>#{o.id}</Num> },
            { key: "customer_name", label: "المنشأة", render: (o) => <>{o.customer_name} <span className="text-ink-muted text-13">· {o.branch_name}</span></> },
            { key: "driver_name", label: "السائق", render: (o) => o.driver_name ?? "—" },
            { key: "status", label: "الحالة", render: (o) => <OrderStatusBadge status={o.status} /> },
            { key: "total", label: "الإجمالي", money: true, render: (o) => <Money value={o.total} /> },
          ]} />
      </section>
    </div>
  );
}

/** أعمدة المبيعات اليومية: اليوم بلون الهوية، وما قبله بالأخضر (كما في التصميم). */
function WeekChart({ week }: { week: Array<{ day: string; sales: string }> }) {
  const W = 740, H = 230, X0 = 60, TOP = 20, BASE = 200;
  const max = Math.max(1, ...week.map((w) => Number(w.sales)));
  const step = niceStep(max / 3);
  const top = step * 3;
  const y = (v: number) => BASE - (v / top) * (BASE - TOP);
  const slot = (W - X0) / Math.max(week.length, 1);
  const peak = week.reduce((m, w, i) => (Number(w.sales) > Number(week[m]?.sales ?? 0) ? i : m), 0);
  const label = week.map((w) => `${fmt.date(w.day)}: ${fmt.money(w.sales)} د.ل`).join("، ");
  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="w-full h-auto md-chart" role="img" aria-label={`المبيعات اليومية — ${label}`}>
      <g className="md-chart-grid">
        {[0, 1, 2, 3].map((i) => <line key={i} x1={X0} x2={W} y1={y(step * i)} y2={y(step * i)} />)}
      </g>
      <g className="md-chart-axis" textAnchor="end">
        {[0, 1, 2, 3].map((i) => <text key={i} x={X0 - 8} y={y(step * i) + 4}>{fmt.int(step * i)}</text>)}
      </g>
      {week.map((w, i) => {
        const v = Number(w.sales), cx = X0 + slot * i + slot / 2, today = i === week.length - 1;
        return (
          <g key={w.day}>
            <rect x={cx - 28} y={y(v)} width={56} height={BASE - y(v)} rx={6} className={today ? "md-chart-today" : "md-chart-bar"} />
            <text x={cx} y={220} textAnchor="middle" className={today ? "md-chart-strong" : "md-chart-axis"}>{today ? "اليوم" : fmt.date(w.day).slice(0, 5)}</text>
            {(today || i === peak) && v > 0 ? <text x={cx} y={y(v) - 6} textAnchor="middle" className="md-chart-strong">{fmt.int(Math.round(v))}</text> : null}
          </g>
        );
      })}
    </svg>
  );
}

function niceStep(raw: number): number {
  const p = 10 ** Math.floor(Math.log10(Math.max(raw, 1)));
  const n = raw / p;
  return (n <= 1 ? 1 : n <= 2 ? 2 : n <= 5 ? 5 : 10) * p;
}
