/** تقارير الربح (م-12): فترة وتجميع (طلبية/يوم/شهر/صنف/عميل)، والمجاميع، وطريقة تكلفة بضاعة المخازن لكل فترة. */
import { useMemo, useState } from "react";

import * as fmt from "@ui/fmt";
import { qs } from "@ui/client";
import { Button, DataTable, ErrorState, Money, Num, PageHead, StatCard, StatusBadge, TextField, useLoad, type Column } from "@ui/kit";
import { api } from "@/api/client";
import type { ProfitLineOut, ProfitOut } from "@/api/types";
import { addDays } from "@/lib/money-util";

type View = "order" | "day" | "month" | "item" | "customer";
const VIEWS: Array<{ v: View; label: string; head: string; col: string }> = [
  { v: "order", label: "طلبية", head: "حسب الطلبية", col: "الطلبية" },
  { v: "day", label: "يوم", head: "حسب اليوم", col: "اليوم" },
  { v: "month", label: "شهر", head: "حسب الشهر", col: "الشهر" },
  { v: "item", label: "صنف", head: "حسب الصنف", col: "الصنف" },
  { v: "customer", label: "عميل", head: "حسب العميل", col: "العميل" },
];
const MONTHS = ["يناير", "فبراير", "مارس", "أبريل", "مايو", "يونيو", "يوليو", "أغسطس", "سبتمبر", "أكتوبر", "نوفمبر", "ديسمبر"];
const METHOD: Record<string, string> = { average: "متوسط سعر الشراء", fifo: "الأقدم شراءً أولاً" };

const monthStart = (iso: string) => `${iso.slice(0, 7)}-01`;
const monthEnd = (iso: string) => {
  const [y, m] = iso.split("-").map(Number);
  return addDays(`${m === 12 ? (y ?? 0) + 1 : y}-${String(m === 12 ? 1 : (m ?? 0) + 1).padStart(2, "0")}-01`, -1);
};
const pct = (num: number, den: number) => (den ? `${((num / den) * 100).toFixed(1)}%` : "—");

/** «01/09» أو «20/09 14:00» */
function shortAt(iso: string): string {
  const d = new Date(iso);
  const t = fmt.time(iso);
  return `${fmt.date(iso).slice(0, 5)}${t !== "00:00" && !Number.isNaN(d.getTime()) ? ` ${t}` : ""}`;
}

export function Profit() {
  const today = fmt.today();
  const [from, setFrom] = useState(monthStart(today));
  const [to, setTo] = useState(today);
  const [view, setView] = useState<View>("item");
  const by = view === "month" ? "day" : view;
  const valid = /^\d{4}-\d{2}-\d{2}$/.test(from) && /^\d{4}-\d{2}-\d{2}$/.test(to) && from <= to;
  const rep = useLoad(
    () => (valid ? api.get<ProfitOut>(`/api/admin/reports/profit${qs({ date_from: from, date_to: to, by })}`) : Promise.reject({ code: "range", message: "الفترة غير صالحة" })),
    [from, to, by, valid],
  );
  const r = rep.data;
  const meta = VIEWS.find((x) => x.v === view) ?? VIEWS[3]!;

  // «شهر»: تجميع أيام الخادم شهراً شهراً
  const lines = useMemo<ProfitLineOut[] | null>(() => {
    if (!r) return null;
    if (view !== "month") return r.lines;
    const m = new Map<string, ProfitLineOut>();
    for (const l of r.lines) {
      const k = l.key.slice(0, 7);
      const cur = m.get(k) ?? { key: k, qty: null, sales: "0", cost: "0", gross: "0" };
      m.set(k, { ...cur, sales: String(Number(cur.sales) + Number(l.sales)), cost: String(Number(cur.cost) + Number(l.cost)),
        gross: String(Number(cur.gross) + Number(l.gross)) });
    }
    return [...m.values()].sort((a, b) => a.key.localeCompare(b.key));
  }, [r, view]);

  const title = from === monthStart(from) && to === monthEnd(from) || (from === monthStart(today) && to === today)
    ? `${MONTHS[Number(from.slice(5, 7)) - 1] ?? ""} ${from.slice(0, 4)}`
    : `${fmt.date(from)} – ${fmt.date(to)}`;

  const sales = Number(r?.sales ?? 0);
  const profit = Number(r?.profit ?? 0);

  const keyLabel = (l: ProfitLineOut) => view === "day" ? <Num>{fmt.date(l.key)}</Num>
    : view === "month" ? <>{MONTHS[Number(l.key.slice(5, 7)) - 1]} <Num>{l.key.slice(0, 4)}</Num></>
      : view === "order" ? <Num>{l.key}</Num> : l.key;

  const columns: Array<Column<ProfitLineOut>> = [
    { key: "i", label: meta.col, render: keyLabel },
    ...(view === "item" ? [{ key: "q", label: "الكمية", numeric: true, render: (l: ProfitLineOut) => <Num>{fmt.qty(l.qty)}</Num> }] : []),
    { key: "s", label: "البيع", money: true, render: (l) => <Money value={l.sales} /> },
    { key: "c", label: "الشراء", money: true, render: (l) => <Money value={l.cost} /> },
    { key: "p", label: "الربح الإجمالي", money: true, render: (l) => <Money value={l.gross} /> },
    { key: "m", label: "الهامش", numeric: true, render: (l) => <Num>{pct(Number(l.gross), Number(l.sales))}</Num> },
  ];

  // فترات طريقة التكلفة داخل الفترة المعروضة: كل طريقة من بدايتها (أو بداية الفترة) إلى بداية التي تليها
  const periods = (r?.cogs_periods ?? []).map((p) => ({ method: String(p.method ?? ""), from: String(p.from ?? "") }));

  return (
    <div className="md-page">
      <PageHead title={`تقارير الربح — ${title}`}
        actions={<div role="tablist" className="flex gap-1.5">
          {VIEWS.map((x) => (
            <Button key={x.v} size="sm" variant={x.v === view ? "primary" : "secondary"} onClick={() => setView(x.v)}>{x.label}</Button>
          ))}
        </div>} />

      <div className="flex gap-3 items-end flex-wrap">
        <TextField label="من" value={from} onChange={setFrom} type="date" ltr icon="clock" error={valid ? null : "الفترة غير صالحة"} />
        <TextField label="إلى" value={to} onChange={setTo} type="date" ltr icon="clock" />
        <Button variant="ghost" size="sm" onClick={() => { setFrom(monthStart(today)); setTo(today); }}>هذا الشهر</Button>
      </div>

      {rep.error && !r ? (
        <div className="md-card">
          {rep.error.code === "forbidden_permission"
            ? <ErrorState compact title="التقرير يحتاج صلاحية التكاليف" body="حسابك لا يرى أسعار الشراء. اطلب صلاحية «التكاليف» من المالك." code={rep.error.code} />
            : <ErrorState compact title={rep.error.message} code={rep.error.code} onRetry={rep.reload} />}
        </div>
      ) : (
        <>
          <div className="grid grid-cols-5 gap-4">
            <StatCard label="المبيعات" value={r?.sales ?? "0"} money />
            <StatCard label="تكلفة الشراء" value={r?.cost ?? "0"} money />
            <StatCard label="أجور السائقين" value={r?.driver_pay ?? "0"} money />
            <StatCard label="المصروفات المسجّلة" value={r?.expenses ?? "0"} money />
            <StatCard label="الربح" value={r?.profit ?? "0"} money note={sales ? `هامش صافٍ ${pct(profit, sales)}` : undefined}
              noteTone={profit < 0 ? "error" : "success"} />
          </div>

          <section className="flex flex-col gap-2.5">
            <h2 className="md-sec-title-lg">{meta.head}</h2>
            <DataTable<ProfitLineOut>
              rows={lines} loading={rep.loading} error={rep.error} onRetry={rep.reload}
              emptyIcon="chart-column" emptyTitle="لا مبيعات في الفترة" emptyBody="الربح يُحسب من الطلبيات المسلَّمة فقط."
              rowKey={(l) => l.key} columns={columns} />
          </section>

          {periods.length ? (
            <div className="md-card md-card-flat flex justify-between items-center gap-3 py-3 px-3.5">
              <span className="text-14"><b>تكلفة بضاعة المخازن في هذه الفترة:</b>{" "}
                {periods.map((p, i) => {
                  const start = p.from.slice(0, 10) < from ? `${from}T00:00:00` : p.from;
                  const next = periods[i + 1];
                  return (
                    <span key={i}>
                      {i ? " · " : null}{METHOD[p.method] ?? p.method} من <Num>{shortAt(start)}</Num>
                      {next ? <> إلى <Num>{shortAt(next.from)}</Num></> : null}
                    </span>
                  );
                })}
              </span>
              <StatusBadge tone="info">{periods.length === 1 ? "طريقة واحدة في الفترة — M-12" : periods.length === 2 ? "طريقتان في الفترة — M-12" : "عدة طرق في الفترة — M-12"}</StatusBadge>
            </div>
          ) : null}
          <span className="text-13 text-ink-muted">
            الربح = البيع − الشراء − أجر السائق − المصاريف المسجلة. تكلفة كل سحب من المخزن سُجِّلت بالطريقة السارية وقتها ولا يُعاد حسابها.
          </span>
        </>
      )}
    </div>
  );
}

