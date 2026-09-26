/**
 * 04 انطلاق الدفعة (§4.3): أختار ما يصل الآن مما استلمته، ويظهر ما يصل لاحقاً وموعده، ثم «أرسل الإشعار للعميل»
 * (إنشاء الدفعة ثم الإشعار)، ثم «انطلاق الدفعة» — مقفل حتى يُرسل الإشعار، والقاعدة ترفضه أيضاً.
 */
import { useMemo, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";

import { Button, EmptyState, ErrorState, Icon, LoadingState, Num, QtyStepper, StatusBadge, TextField, useLoad } from "@ui/kit";
import * as fmt from "@ui/fmt";
import { api } from "@/api/client";
import type { BatchOut, Order2Out } from "@/api/types";
import { Screen } from "@/lib/shell";
import { CHANNEL, UNIT, availableFor, batchLines, noticeOf, openBatch, qtyUnit, round3, todayAt, useWork, workError,
  type NoticeLine } from "@/lib/work-http";

export function Batch() {
  const { orderId } = useParams();
  const id = Number(orderId);
  const order = useLoad(() => api.get<Order2Out>(`/api/driver/orders/${id}`), [id]);
  if (order.loading && !order.data) return <Screen title="الدفعة" back={`/route/${id}`}><LoadingState rows={3} /></Screen>;
  if (order.error || !order.data) {
    return (
      <Screen title="الدفعة" back={`/route/${id}`}>
        <ErrorState title="تعذّر تحميل الطلبية" body="تحقق من الاتصال. الطلبية محفوظة لك." code={order.error?.code} onRetry={order.reload} />
      </Screen>
    );
  }
  return <BatchOf o={order.data} set={order.set} />;
}

function BatchOf({ o, set }: { o: Order2Out; set: (o: Order2Out) => void }) {
  const nav = useNavigate();
  const open = openBatch(o);
  const nextSeq = (o.batches.reduce((m, b) => Math.max(m, b.seq), 0)) + 1;
  const seq = open?.seq ?? nextSeq;
  const title = <>الدفعة <Num>{seq}</Num> — {o.customer_name}</>;
  const back = `/route/${o.id}`;

  if (open?.status === "departed") {
    return (
      <Screen title={title} back={back}>
        <EmptyState icon="truck" title="الدفعة في الطريق" body="انطلقت هذه الدفعة. سلّمها للعميل وحصّل المبلغ."
          action={<Button icon="check" onClick={() => nav(`/orders/${o.id}/delivery`)}>التسليم</Button>} />
      </Screen>
    );
  }
  if (open) return <Screen title={title} back={back}><Planned o={o} b={open} set={set} /></Screen>;
  return <Screen title={title} back={back}><Compose o={o} set={set} /></Screen>;
}

/** دفعة جديدة: الكميات من المستلَم، وموعدها وموعد الباقي. */
function Compose({ o, set }: { o: Order2Out; set: (o: Order2Out) => void }) {
  const avail = useMemo(() => new Map(o.items.map((it) => [it.id, availableFor(o, it)])), [o]);
  const [qty, setQty] = useState<Record<number, number>>(() => Object.fromEntries(o.items.map((it) => [it.id, avail.get(it.id) ?? 0])));
  const [eta, setEta] = useState("");
  const [later, setLater] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const { busy, run } = useWork();

  const nowLines = o.items.filter((it) => (qty[it.id] ?? 0) > 0);
  const laterLines = o.items
    .map((it) => ({ it, rest: round3(Number(it.qty) - Number(it.delivered_qty) - (qty[it.id] ?? 0)) }))
    .filter((x) => x.rest > 0);
  const needLater = laterLines.length > 0;
  const laterBad = needLater && !todayAt(later);
  const etaBad = eta !== "" && !todayAt(eta);

  if (!o.items.some((it) => (avail.get(it.id) ?? 0) > 0)) {
    return <EmptyState icon="boxes" title="لا أصناف جاهزة لدفعة" body="استلم من نقاط الاستلام أولاً؛ ما تستلمه يظهر هنا لتسليمه." />;
  }

  async function notify() {
    if (!nowLines.length) { setErr("batch_empty"); return; }
    if (laterBad) { setErr("batch_notice_needs_later_eta"); return; }
    setErr(null);
    const made = await run(() => api.post<Order2Out>(`/api/driver/orders/${o.id}/batches`, {
      lines: nowLines.map((it) => ({ order_item_id: it.id, qty: String(round3(qty[it.id] ?? 0)) })),
      eta_at: eta ? todayAt(eta) : null,
      next_eta_at: needLater ? todayAt(later) : null,
    }), { inline: ["batch_qty_exceeds_collected"] });
    if (made.v === null) { if (made.code === "batch_qty_exceeds_collected") setErr(made.code); return; }
    set(made.v);
    const b = openBatch(made.v);
    if (!b) return;
    const sent = await run(() => api.post<Order2Out>(`/api/driver/batches/${b.id}/notify`), { ok: "أُرسل الإشعار للعميل.", inline: ["batch_notice_needs_later_eta"] });
    if (sent.code === "batch_notice_needs_later_eta") setErr(sent.code);
    if (sent.v) set(sent.v);
  }

  return (
    <>
      <b>يصل الآن</b>
      <div className="md-sec p-3 gap-3">
        {o.items.filter((it) => (avail.get(it.id) ?? 0) > 0).map((it) => {
          const max = avail.get(it.id) ?? 0;
          return (
            <div key={it.id} className="flex items-center justify-between gap-2">
              <span className="flex flex-col">
                <span className="text-15">{it.name_ar}</span>
                <span className="text-12 md-muted">جاهز <Num>{qtyUnit(max, it.unit)}</Num></span>
              </span>
              <QtyStepper size="sm" value={qty[it.id] ?? 0} max={max} unit={it.unit === "kg" || it.unit === "liter" ? UNIT[it.unit] : undefined}
                onChange={(v) => setQty((q) => ({ ...q, [it.id]: Math.min(max, round3(v)) }))} />
            </div>
          );
        })}
      </div>
      {needLater ? (
        <>
          <b>يصل لاحقاً</b>
          <div className="md-sec p-3 text-15">{laterLines.map((x) => `${x.it.name_ar} ×${qtyUnit(x.rest, x.it.unit)}`).join(" · ")}</div>
          <TextField label="موعد ما يصل لاحقاً" value={later} onChange={(v) => { setLater(v); setErr(null); }} type="time" ltr icon="clock"
            placeholder="مثال 16:30" required
            error={err === "batch_notice_needs_later_eta" ? workError(err) : null} />
        </>
      ) : null}
      <TextField label="موعد وصول هذه الدفعة (اختياري)" value={eta} onChange={setEta} type="time" ltr icon="clock"
        error={etaBad ? "اكتب الوقت بصيغة 16:30." : null} />

      {err === "batch_notice_needs_later_eta" ? (
        <ErrorState compact title="لم يُرسل الإشعار" body="بقيت أصناف لم تُحمَّل في هذه الدفعة، ولم تكتب موعدها." code="batch_notice_needs_later_eta" />
      ) : err ? (
        <ErrorState compact title="لم يُرسل الإشعار" body={workError(err)} code={err} />
      ) : null}

      <div className="flex flex-col gap-2 mt-2">
        <Button variant="secondary" block className="md-btn-xl" icon="send" loading={busy} disabled={etaBad} onClick={notify}>
          {busy ? "جاري إرسال الإشعار" : "أرسل الإشعار للعميل"}
        </Button>
        <Button block className="md-btn-xl" icon="truck" disabled>انطلاق الدفعة</Button>
        <span className="text-13 md-muted flex items-center justify-center gap-1.5 text-center">
          <Icon name="circle-alert" size={16} />لا انطلاق قبل إشعار العميل بما يصل الآن ولاحقاً.
        </span>
      </div>
    </>
  );
}

const line = (l: NoticeLine) => `${l.item} ×${qtyUnit(l.qty, l.unit)}`;

/** دفعة مُنشأة: قبل الإشعار (زر الإشعار) أو بعده (ما وصل العميلَ، والانطلاق مفتوح). */
function Planned({ o, b, set }: { o: Order2Out; b: BatchOut; set: (o: Order2Out) => void }) {
  const nav = useNavigate();
  const { busy, run } = useWork();
  const dep = useWork();
  const [err, setErr] = useState<string | null>(null);
  const notice = noticeOf(b);
  const names = new Map(o.items.map((it) => [it.id, it]));
  const notified = b.status === "notified";

  const [later, setLater] = useState("");
  async function notify() {
    // دفعة أُنشئت بلا موعد لما بعدها: يُكتب الموعد أولاً (ما دامت لم تُرسَل)، ثم الإشعار
    if (err === "batch_notice_needs_later_eta") {
      const iso = todayAt(later);
      if (!iso) return;
      const fixed = await run(() => api.patch<Order2Out>(`/api/driver/batches/${b.id}`, { eta_at: b.eta_at, next_eta_at: iso }));
      if (fixed.v === null) return;
      set(fixed.v);
    }
    const r = await run(() => api.post<Order2Out>(`/api/driver/batches/${b.id}/notify`), { ok: "أُرسل الإشعار للعميل.", inline: ["batch_notice_needs_later_eta"] });
    setErr(r.code === "batch_notice_needs_later_eta" ? r.code : null);
    if (r.v) set(r.v);
  }
  async function depart() {
    const r = await dep.run(() => api.post<Order2Out>(`/api/driver/batches/${b.id}/depart`), { ok: "انطلقت الدفعة." });
    if (r.v) { set(r.v); nav(`/orders/${o.id}/delivery`); }
  }

  if (!notified) {
    return (
      <>
        <b>يصل الآن</b>
        <div className="md-sec p-3 text-15 gap-1">
          {batchLines(b).map((l) => {
            const it = names.get(l.order_item_id);
            return <span key={l.order_item_id}>{it?.name_ar ?? "صنف"} · <Num>{qtyUnit(l.qty, it?.unit)}</Num></span>;
          })}
        </div>
        {b.next_eta_at ? <span className="text-14">موعد ما يصل لاحقاً: <Num>{fmt.time(b.next_eta_at)}</Num></span> : null}
        {err ? (
          <>
            <ErrorState compact title="لم يُرسل الإشعار" body="بقيت أصناف لم تُحمَّل في هذه الدفعة، ولم تكتب موعدها." code={err} />
            <TextField label="موعد ما يصل لاحقاً" value={later} onChange={setLater} type="time" ltr icon="clock" placeholder="مثال 16:30" required
              error={later && !todayAt(later) ? "اكتب الوقت بصيغة 16:30." : null} />
          </>
        ) : null}
        <div className="flex flex-col gap-2 mt-2">
          <Button variant="secondary" block className="md-btn-xl" icon="send" loading={busy}
            disabled={err === "batch_notice_needs_later_eta" && !todayAt(later)} onClick={notify}>
            {busy ? "جاري إرسال الإشعار" : "أرسل الإشعار للعميل"}
          </Button>
          <Button block className="md-btn-xl" icon="truck" disabled>انطلاق الدفعة</Button>
          <span className="text-13 md-muted flex items-center justify-center gap-1.5 text-center">
            <Icon name="circle-alert" size={16} />لا انطلاق قبل إشعار العميل بما يصل الآن ولاحقاً.
          </span>
        </div>
      </>
    );
  }

  return (
    <>
      <div className="flex items-center gap-2 flex-wrap">
        <StatusBadge tone="success" icon="circle-check">أُرسل الإشعار <Num>{fmt.time(b.notified_at)}</Num></StatusBadge>
        <span className="text-13 md-muted">{(notice?.channels ?? []).map((c) => CHANNEL[c] ?? c).join(" + ")}</span>
      </div>
      <span className="text-14 md-muted">وصل العميلَ:</span>
      <div data-theme="light" className="md-sheet gap-1.5" style={{ borderRadius: "var(--radius-lg)" }}>
        <b>دفعة في الطريق</b>
        {notice?.eta ? <span className="text-14">تصل حوالي <Num>{fmt.time(notice.eta)}</Num>.</span> : null}
        <span className="text-14">يصل الآن: {(notice?.now ?? []).map(line).join("، ")}.</span>
        {notice?.later.length ? (
          <span className="text-14">الباقي حوالي <Num>{fmt.time(notice.later_eta)}</Num>: {notice.later.map(line).join("، ")}.</span>
        ) : null}
      </div>
      <span className="text-13 md-muted">محتوى الإشعار ثابت بعد إرساله؛ تغيير الأصناف يحتاج دفعة جديدة وإشعاراً جديداً.</span>
      <div className="mt-2">
        <Button block className="md-btn-xl" icon="truck" loading={dep.busy} onClick={depart}>انطلاق الدفعة</Button>
      </div>
    </>
  );
}
