/**
 * 08 تتبّع الطلبية (م-19): الدفعة الحالية وما يصل الآن ولاحقاً، وسجل الحالات، وبطاقة السائق حسب إعدادَي المالك،
 * والمبلغ عند الاستلام. المسلَّمة: جدول الأصناف وإعادة الطلب والإيصال والنزاع. تتحدث كل 20 ثانية حتى تنتهي.
 */
import { type ReactNode, useEffect } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";

import * as fmt from "@ui/fmt";
import {
  Button, type Column, DataTable, ErrorState, Icon, LoadingState, Money, Note, Num, ORDER_STATUS, OrderStatusBadge,
  QtyStepper, Section, cx, toast, useAction, useLoad,
} from "@ui/kit";
import { api } from "@/api/client";
import type { BatchOut, Order2Out, OrderLineOut, ReorderOut } from "@/api/types";
import { get, saveBlob } from "@/lib/ord-http";
import { ENDED, dayTime, qtyWithUnit, unitLabel } from "@/lib/ord-shared";
import { Screen } from "@/lib/shell";
import { useSession } from "@/session";

const POLL_MS = 20000;

const EVENT_LABEL: Record<string, string> = {
  placed: "أُرسلت", confirmed: "أكّدها مَدَد", assigned: "أُسند السائق", collecting: "السائق يجمع الأصناف",
  partially_delivered: "وصل جزء", delivered: "سُلّمت", closed: "أُغلقت", cancelled: "أُلغيت",
};

type Dot = "done" | "now" | "todo";
interface Step { t: string; at: string; dot: Dot }

function itemsText(xs: Record<string, unknown>[]): string {
  return xs.map((x) => `${String(x.item ?? "")} ×${qtyWithUnit(String(x.qty ?? "0"), typeof x.unit === "string" ? x.unit : null)}`).join(" · ");
}

function batchLabel(b: BatchOut): string {
  if (b.status === "delivered") return `الدفعة ${b.seq} وصلت`;
  if (b.status === "notified" || b.status === "departed") return `الدفعة ${b.seq} في الطريق`;
  return `الدفعة ${b.seq}`;
}

function steps(o: Order2Out): Step[] {
  const ended = ENDED.has(o.status);
  const out: Step[] = [];
  const endEvents: Step[] = [];
  let prev = "";
  for (const e of o.events) {
    if (e.status === prev || e.status === "draft") continue;
    prev = e.status;
    const s: Step = { t: EVENT_LABEL[e.status] ?? e.status, at: fmt.time(e.at), dot: "done" };
    if (ENDED.has(e.status)) endEvents.push(s);
    else if (e.status !== "partially_delivered" || !o.batches.length) out.push(s);
  }
  for (const b of o.batches) {
    const moving = b.status === "notified" || b.status === "departed";
    out.push({
      t: batchLabel(b),
      at: b.status === "delivered" ? "" : b.eta_at ? `حوالي ${fmt.time(b.eta_at)}` : "",
      dot: b.status === "delivered" ? "done" : moving ? "now" : "todo",
    });
  }
  out.push(...endEvents);
  if (!ended) {
    if (!out.some((s) => s.dot === "now")) {
      const last = [...out].reverse().find((s) => s.dot === "done");
      if (last) last.dot = "now";
    }
    const later = o.batches.find((b) => b.status !== "delivered")?.next_eta_at;
    if (!o.batches.length || later) out.push({ t: "التسليم", at: later ? `حوالي ${fmt.time(later)}` : "", dot: "todo" });
  }
  return out;
}

function Timeline({ order }: { order: Order2Out }) {
  const dot: Record<Dot, string> = {
    done: "bg-success",
    now: "bg-secondary border-2 border-secondary-tint",
    todo: "border-2 border-border-strong bg-surface",
  };
  return (
    <ol className="flex flex-col m-0 p-0 list-none">
      {steps(order).map((s, i) => (
        <li key={i} className="flex gap-3 items-start min-h-12">
          <span className={cx("w-3.5 h-3.5 rounded-full mt-1 flex-none box-border", dot[s.dot])} aria-hidden />
          <div className="flex flex-col">
            <span className={cx("text-15", s.dot === "now" && "font-bold")}>{s.t}</span>
            {s.at ? <span className="text-13 text-ink-muted"><Num>{s.at}</Num></span> : null}
          </div>
        </li>
      ))}
    </ol>
  );
}

/** البطاقة العليا: الدفعة الحالية وما يصل الآن ولاحقاً، أو الحالة بكلمات العميل قبل الدفعات. */
function Hero({ order }: { order: Order2Out }) {
  const current = [...order.batches].reverse().find((b) => b.status === "notified" || b.status === "departed")
    ?? order.batches.find((b) => b.status === "planned");
  let title: string;
  let sub: ReactNode = null;
  let box: ReactNode = null;
  if (current) {
    const total = order.batches.length;
    title = total > 1 && current.seq <= total ? `الدفعة ${current.seq} من ${total} في الطريق` : `الدفعة ${current.seq} في الطريق`;
    if (current.status === "planned") title = `الدفعة ${current.seq} قيد التجهيز`;
    if (current.eta_at) sub = <>تصل حوالي <Num>{fmt.time(current.eta_at)}</Num></>;
    if (current.now.length || current.later.length) {
      box = (
        <div className="rounded-md p-2.5 flex flex-col gap-1 text-14" style={{ background: "var(--on-primary-line)" }}>
          {current.now.length ? <><span className="font-bold">يصل الآن</span><span>{itemsText(current.now)}</span></> : null}
          {current.later.length ? (
            <>
              <span className="font-bold mt-1.5">يصل لاحقاً{current.next_eta_at ? <> — حوالي <Num>{fmt.time(current.next_eta_at)}</Num></> : null}</span>
              <span>{itemsText(current.later)}</span>
            </>
          ) : null}
        </div>
      );
    }
  } else {
    const words: Record<string, [string, string]> = {
      placed: ["بانتظار تأكيد مَدَد", "تستطيع التعديل حتى يؤكد مَدَد."],
      confirmed: ["أكّدها مَدَد", "نجهّز طلبيتك ونسندها لسائق."],
      assigned: ["أُسند سائق لطلبيتك", "يبدأ جمع الأصناف قريباً."],
      collecting: ["السائق يجمع الأصناف", "نبلغك حين تنطلق الدفعة إليك."],
      partially_delivered: ["وصل جزء من طلبيتك", "الباقي في الطريق لاحقاً."],
    };
    const w = words[order.status] ?? [ORDER_STATUS[order.status]?.[0] ?? order.status, ""];
    title = w[0];
    sub = w[1] || null;
  }
  return (
    <section className="bg-primary text-on-primary rounded-lg p-4 flex flex-col gap-2.5">
      <div className="flex items-center gap-2"><Icon name="truck" /><span className="font-bold text-17">{title}</span></div>
      {sub ? <div className="text-14 text-on-primary-muted">{sub}</div> : null}
      {box}
    </section>
  );
}

/** م-19: الاسم الأول إن فتحه المالك، وزر اتصال لا يُظهر الرقم إن فتح الاتصال. */
function DriverCard({ order }: { order: Order2Out }) {
  const d = order.driver;
  const name = d?.first_name;
  const due = order.amount_due ?? order.total;
  return (
    <section className="bg-surface border border-border rounded-md p-3 flex items-center gap-2.5">
      <Icon name={name ? "user" : "truck"} />
      <div className="flex-1 flex flex-col">
        <span className="font-bold">{d ? (name ? `${name} — السائق` : "سائق مَدَد في الطريق") : "لم يُسند سائق بعد"}</span>
        <span className="text-13 text-ink-muted">المبلغ عند الاستلام <Money value={due} /></span>
      </div>
      {d?.phone ? (
        <a href={`tel:${d.phone}`} className="md-btn md-btn-secondary md-btn-sm no-underline" aria-label="اتصال بالسائق">
          <Icon name="phone" size={18} />اتصال
        </a>
      ) : null}
    </section>
  );
}

/** التعديل حتى يؤكد مَدَد: الكميات تُرسل سطراً سطراً (0 يحذف السطر). */
function EditLines({ order, onChange }: { order: Order2Out; onChange: (o: Order2Out) => void }) {
  const act = useAction();
  const idOf = (l: OrderLineOut) => l.catalog_item_id ?? undefined;

  const setQty = (itemId: number, v: number) =>
    void act.run(async () => {
      const o = await api.put<Order2Out>(`/api/customer/orders/${order.id}/items/${itemId}`, { qty: fmt.qty(v) });
      onChange(o);
    });

  return (
    <Section title="الأصناف" right={<span className="text-13 text-ink-muted">تستطيع التعديل حتى يؤكد مَدَد</span>}>
      <div className="flex flex-col gap-2.5" aria-busy={act.busy || undefined}>
        {order.lines.map((l) => {
          const id = idOf(l);
          return (
            <div key={l.id} className="flex items-center justify-between gap-2">
              <div className="flex flex-col min-w-0">
                <span className="font-bold text-15">{l.name_ar}</span>
                <span className="text-13 text-ink-muted">{unitLabel(l.unit, l.unit_size)} · <Money value={l.line_total} size="sm" /></span>
              </div>
              {id !== undefined && !act.busy
                ? <QtyStepper size="sm" value={Number(l.qty)} onChange={(v) => setQty(id, v)} />
                : <Num className="font-bold">{fmt.qty(l.qty)}</Num>}
            </div>
          );
        })}
      </div>
      <div className="flex justify-between font-bold"><span>المجموع</span><Money value={order.total} /></div>
    </Section>
  );
}

function LinesTable({ order, delivered }: { order: Order2Out; delivered: boolean }) {
  const cols: Array<Column<OrderLineOut>> = [
    { key: "i", label: "الصنف", render: (l) => l.name_ar },
    { key: "q", label: "الكمية", numeric: true, render: (l) => <Num>{qtyWithUnit(delivered ? l.delivered_qty : l.qty, l.unit)}</Num> },
    { key: "t", label: "المبلغ", money: true, render: (l) => <Money value={l.line_total} /> },
  ];
  return <DataTable columns={cols} rows={order.lines} rowKey={(l) => l.id} />;
}

export function Tracking() {
  const { orderId = "" } = useParams();
  const nav = useNavigate();
  const { setCart, refresh } = useSession();
  const act = useAction();
  const order = useLoad(() => api.get<Order2Out>(`/api/customer/orders/${orderId}`), [orderId]);
  const o = order.data;
  const live = o ? !ENDED.has(o.status) : true;

  // تحديث دوري حتى تنتهي الطلبية؛ الخطأ يُبقي آخر حالة معروفة ويعيد المحاولة تلقائياً
  const { reload } = order;
  useEffect(() => {
    if (!live) return;
    const t = setInterval(reload, POLL_MS);
    return () => clearInterval(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [live, orderId]);

  const title = <>الطلبية <Num>#{orderId}</Num></>;

  if (!o) {
    return (
      <Screen title={title} back="/orders">
        {order.error ? (
          <ErrorState title="تعذّر تحميل الطلبية" body={order.error.message} code={order.error.code} onRetry={order.reload} />
        ) : (
          <>
            <span className="md-skel block rounded-lg h-chart" />
            <LoadingState rows={4} />
          </>
        )}
      </Screen>
    );
  }

  const reorder = () =>
    void act.run(async () => {
      const r = await api.post<ReorderOut>(`/api/customer/orders/${o.id}/reorder`);
      setCart(r.cart);
      refresh();
      if (r.skipped.length) toast(`أُضيفت الأصناف إلى السلة، عدا غير المتاح الآن: ${r.skipped.join("، ")}`);
      else toast("أُضيفت أصناف الطلبية إلى السلة.");
      nav("/cart");
    });

  const receipt = () =>
    void act.run(async () => {
      const blob = await get(`/api/customer/orders/${o.id}/receipt.pdf`);
      saveBlob(blob, `madad-receipt-${o.id}.pdf`);
    });

  const lastEvent = o.events[o.events.length - 1];
  const done = o.status === "delivered" || o.status === "closed";
  const canDispute = done || o.status === "partially_delivered";

  return (
    <Screen title={title} back="/orders">
      {order.error ? (
        <ErrorState compact title="تعذّر تحديث حالة الطلبية"
          body={`آخر حالة معروفة: ${lastEvent ? `${EVENT_LABEL[lastEvent.status] ?? lastEvent.status} (${fmt.time(lastEvent.at)})` : ORDER_STATUS[o.status]?.[0] ?? o.status}. نعيد المحاولة تلقائياً.`}
          code={order.error.code} />
      ) : null}

      {done || o.status === "cancelled" ? (
        <>
          <div className="flex justify-between items-center">
            <OrderStatusBadge status={o.status} />
            <span className="text-13 text-ink-muted"><Num>{dayTime(o.delivered_at ?? lastEvent?.at ?? o.placed_at)}</Num></span>
          </div>
          <LinesTable order={o} delivered={done} />
          {done ? (
            <div className="flex justify-between items-center text-18 font-bold"><span>دُفع نقداً</span><Money value={o.total} /></div>
          ) : null}
        </>
      ) : (
        <>
          <Hero order={o} />
          <Timeline order={o} />
          {o.editable ? <EditLines order={o} onChange={order.set} /> : (
            <Section title="الأصناف"><LinesTable order={o} delivered={false} /></Section>
          )}
          {o.status !== "placed" ? <DriverCard order={o} /> : (
            <Note>المبلغ عند الاستلام <Money value={o.amount_due ?? o.total} /> — الدفع نقداً.</Note>
          )}
        </>
      )}

      <div className="flex flex-col gap-2 mt-auto">
        <Button block icon="repeat" loading={act.busy} onClick={reorder}>أعد الطلب نفسه</Button>
        <Button block variant="secondary" icon="file-text" disabled={act.busy} onClick={receipt}>الإيصال PDF</Button>
        {canDispute ? (
          <Link to={`/orders/${o.id}/dispute`} className="text-center text-15 font-bold text-error-text no-underline p-2.5">مشكلة في صنف؟ افتح نزاعاً</Link>
        ) : null}
      </div>
    </Screen>
  );
}
