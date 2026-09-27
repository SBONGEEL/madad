/**
 * 05 التسليم والتحصيل + 05ب فرع التسليم: العنوان والاتصال والملاحة، وأصناف الدفعة المنطلقة، والمبلغ الذي أحصّله
 * (عند اكتمال التسليم، أو قيمة الدفعة إن فعّل المالك التحصيل على الدفعات)، ثم «سلّمت وحصّلت» بتأكيد يذكر المبلغ.
 * «مشكلة؟» يفتح نزاعاً على صنف يقرره مَدَد. بعد التسليم: أجري المضاف والكاش بحوزتي.
 */
import { useState } from "react";
import { useNavigate, useParams } from "react-router-dom";

import { Button, ConfirmDialog, Dialog, EmptyState, ErrorState, Icon, LoadingState, Money, Note, Num, Select, TextField, useLoad } from "@ui/kit";
import * as fmt from "@ui/fmt";
import { api } from "@/api/client";
import type { BatchOut, DisputeOut, Order2Out, WalletOut } from "@/api/types";
import { Screen } from "@/lib/shell";
import { batchLines, navUrl, qtyUnit, round3, uploadPhoto, useWork } from "@/lib/work-http";
import { PhotoPick } from "@/lib/work-ui";
import { useSession } from "@/session";

export function Delivery() {
  const { orderId } = useParams();
  const id = Number(orderId);
  const order = useLoad(() => api.get<Order2Out>(`/api/driver/orders/${id}`), [id]);
  const [done, setDone] = useState<{ o: Order2Out; b: BatchOut } | null>(null);
  if (done) return <Done o={done.o} b={done.b} />;
  if (order.loading && !order.data) return <Screen title="التسليم" back={`/route/${id}`}><LoadingState rows={2} /></Screen>;
  if (order.error || !order.data) {
    return (
      <Screen title="التسليم" back={`/route/${id}`}>
        <ErrorState compact title="تعذّر تحميل الطلبية" body="تحقق من الاتصال. الطلبية محفوظة لك." code={order.error?.code} onRetry={order.reload} />
      </Screen>
    );
  }
  return <DeliveryOf o={order.data} onDone={(o, b) => setDone({ o, b })} />;
}

function DeliveryOf({ o, onDone }: { o: Order2Out; onDone: (o: Order2Out, b: BatchOut) => void }) {
  const nav = useNavigate();
  const { refresh } = useSession();
  const [ask, setAsk] = useState(false);
  const [dispute, setDispute] = useState(false);
  const { busy, run } = useWork();
  const b = o.batches.find((x) => x.status === "departed") ?? null;
  const perBatch = o.collection_mode === "per_batch";
  const title = perBatch && b ? <>الدفعة <Num>{b.seq}</Num> — {o.customer_name}</> : <>التسليم — {o.customer_name}</>;
  const back = `/route/${o.id}`;
  const items = new Map(o.items.map((it) => [it.id, it]));
  const destUrl = navUrl(o.dest_lat, o.dest_lng, o.dest_address);

  const header = (
    <>
      <div className="flex flex-col gap-1">
        <span className="text-13 md-muted">فرع التسليم</span>
        <b className="text-19">{o.customer_name} — {o.branch_name}</b>
        {o.recipient_name ? <span className="text-14">المستلم: <b>{o.recipient_name}</b></span> : null}
      </div>
      <div className="flex items-center gap-2">
        <Icon name="map-pin" size={20} />
        <span className="flex-1 text-14">{o.dest_address ?? "بلا عنوان مكتوب"}</span>
        <a className="md-btn md-btn-secondary md-btn-sm" href={`tel:${o.customer_phone}`}><Icon name="phone" size={18} />اتصال</a>
        {destUrl ? <a className="md-btn md-btn-secondary md-btn-sm" href={destUrl} target="_blank" rel="noopener noreferrer"><Icon name="navigation" size={18} />ملاحة</a> : null}
      </div>
    </>
  );

  if (!b) {
    return (
      <Screen title={title} back={back}>
        {header}
        {o.status === "delivered"
          ? <Note tone="success">سُلِّمت هذه الطلبية كاملة. أجرك <Money value={o.driver_pay} size="sm" />.</Note>
          : <EmptyState icon="truck" title="لا دفعة في الطريق" body="جهّز دفعة وأرسل إشعارها للعميل ثم انطلق، لتسلّمها هنا."
              action={<Button icon="truck" onClick={() => nav(`/orders/${o.id}/batch`)}>الدفعة</Button>} />}
      </Screen>
    );
  }

  const lines = batchLines(b);
  const inBatch = (id: number) => lines.filter((l) => l.order_item_id === id).reduce((s, l) => s + Number(l.qty), 0);
  const last = o.items.every((it) => round3(Number(it.qty) - Number(it.delivered_qty) - inBatch(it.id)) <= 0);
  // ما أحصّله الآن: الباقي كله مع آخر دفعة؛ قيمة الدفعة على الدفعات؛ ولا شيء قبل الاكتمال على «عند اكتمال التسليم»
  const collectNow = last ? Number(o.amount_to_collect) : perBatch ? Number(b.value) : 0;
  const rest = round3(Number(o.amount_to_collect) - collectNow);
  const label = last ? "سلّمت كل الأصناف وحصّلت المبلغ" : perBatch ? "سلّمت الدفعة وحصّلت قيمتها" : "سلّمت الدفعة";

  async function deliver() {
    const r = await run(() => api.post<Order2Out>(`/api/driver/batches/${b!.id}/deliver`), { ok: "سُجّل التسليم." });
    setAsk(false);
    if (r.v) { refresh(); onDone(r.v, b!); }
  }

  return (
    <Screen title={title} back={back}>
      {header}
      <div className="md-sec p-3 text-15 gap-1">
        {lines.map((l) => {
          const it = items.get(l.order_item_id);
          return <span key={l.order_item_id}>{it?.name_ar ?? "صنف"} ×<Num>{qtyUnit(l.qty, it?.unit)}</Num></span>;
        })}
      </div>

      {perBatch && !last ? (
        <section className="md-sec border-secondary gap-1.5">
          <div className="flex justify-between"><span>قيمة هذه الدفعة</span><Money value={b.value} /></div>
          <div className="flex justify-between text-14 md-muted"><span>الباقي مع الدفعة التالية (والرسم)</span><Money value={rest} size="sm" /></div>
        </section>
      ) : collectNow > 0 ? (
        <section className="bg-success text-primary rounded-lg p-4 flex flex-col items-center gap-0.5">
          <b className="text-15">حصّل من العميل</b>
          <Money value={collectNow} size="lg" />
          <span className="text-13">نقداً · شامل رسم التوصيل <Num>{fmt.money(o.delivery_fee)}</Num></span>
        </section>
      ) : (
        <Note tone="info">لا تحصيل مع هذه الدفعة. تحصّل <Money value={o.amount_to_collect} size="sm" /> مع آخر دفعة عند اكتمال التسليم.</Note>
      )}

      <div className="flex flex-col gap-2 mt-2">
        <Button block className="md-btn-xl" icon="check" loading={busy} onClick={() => setAsk(true)}>{label}</Button>
        <button type="button" className="md-link text-center text-15" onClick={() => setDispute(true)}>مشكلة؟ صنف مرفوض أو ناقص</button>
      </div>

      <ConfirmDialog open={ask} title={label} loading={busy} confirmLabel="نعم، سلّمت" onConfirm={deliver} onCancel={() => setAsk(false)}
        body={collectNow > 0
          ? <>حصّلت <Money value={collectNow} /> نقداً من العميل؟ يُسجّل المبلغ في عهدتك.</>
          : <>سلّمت أصناف الدفعة <Num>{b.seq}</Num> للعميل؟</>} />
      <DisputeDialog open={dispute} o={o} onClose={() => setDispute(false)} />
    </Screen>
  );
}

const KINDS = [
  { value: "refused", label: "رفضه العميل" },
  { value: "short", label: "ناقص" },
  { value: "damaged", label: "تالف" },
  { value: "other", label: "أخرى" },
] as const;
type Kind = (typeof KINDS)[number]["value"];

function DisputeDialog({ open, o, onClose }: { open: boolean; o: Order2Out; onClose: () => void }) {
  const [item, setItem] = useState<string>(String(o.items[0]?.id ?? ""));
  const [kind, setKind] = useState<Kind>("refused");
  const [text, setText] = useState("");
  const [photo, setPhoto] = useState<number | null>(null);
  const { busy, run } = useWork();
  const up = useWork();
  const it = o.items.find((x) => String(x.id) === item);

  async function send() {
    const r = await run(() => api.post<DisputeOut[]>(`/api/driver/orders/${o.id}/disputes`, {
      order_item_id: it ? it.id : null, kind, description: text.trim(), media_ids: photo != null ? [photo] : [],
    }), { ok: "فُتح النزاع. يقرره مَدَد ويعدّل المبلغ، ثم أكمل التسليم." });
    if (r.v) { setText(""); setPhoto(null); onClose(); }
  }

  return (
    <Dialog open={open} onClose={onClose} wide label="فتح نزاع">
      <div className="md-dialog-title">مشكلة في صنف</div>
      {kind === "refused" && it ? (
        <ErrorState compact title="لا يكتمل التسليم بصنف مرفوض"
          body={`العميل رفض «${it.name_ar} ×${qtyUnit(it.qty, it.unit)}». افتح نزاعاً؛ يقرره مَدَد ويعدّل المبلغ، ثم أكمل التسليم.`} />
      ) : null}
      <Select label="الصنف" value={item} onChange={setItem}
        options={o.items.map((x) => ({ value: String(x.id), label: `${x.name_ar} ×${qtyUnit(x.qty, x.unit)}` }))} />
      <Select label="المشكلة" value={kind} onChange={setKind} options={KINDS.map((k) => ({ value: k.value, label: k.label }))} />
      <TextField label="السبب كما قاله العميل" value={text} onChange={setText} multiline />
      <PhotoPick attached={photo != null} busy={up.busy} onClear={() => setPhoto(null)}
        onPick={async (f) => { const r = await up.run(() => uploadPhoto(f, "dispute_photo")); if (r.v != null) setPhoto(r.v); }} />
      <div className="md-dialog-actions">
        <Button variant="danger" block icon="triangle-alert" loading={busy} disabled={!text.trim() || up.busy} onClick={send}>فتح نزاع</Button>
        <Button variant="ghost" block onClick={onClose}>إلغاء</Button>
      </div>
    </Dialog>
  );
}

/** تمّ: الطلبية كاملة (أجري والكاش بحوزتي) أو دفعة منها. */
function Done({ o, b }: { o: Order2Out; b: BatchOut }) {
  const nav = useNavigate();
  const wallet = useLoad(() => api.get<WalletOut>(`/api/driver/wallet`));
  const full = o.status === "delivered";
  return (
    <main className="md-mobile-main items-center text-center justify-center">
      <span className="w-12 h-12 rounded-full bg-success text-primary grid place-items-center"><Icon name="check" size={36} /></span>
      <h1 className="text-22 font-bold m-0">{full ? <>سُلِّمت الطلبية <Num>#{o.id}</Num></> : <>سُلِّمت الدفعة <Num>{b.seq}</Num></>}</h1>
      {full && o.driver_pay ? (
        <span className="text-16 md-muted">أُضيف أجرك <Num>{fmt.money(o.driver_pay)}</Num> د.ل إلى محفظتك.</span>
      ) : !full ? (
        <span className="text-16 md-muted">الباقي للعميل مع الدفعة التالية.</span>
      ) : null}
      <div className="md-sec w-full flex-row justify-between items-center">
        <span>الكاش بحوزتك الآن</span>
        {wallet.data ? <Money value={wallet.data.cash_held} /> : wallet.error ? <span className="md-muted">—</span> : <span className="md-spinner" aria-hidden />}
      </div>
      <div className="w-full mt-2">
        {full
          ? <Button block className="md-btn-xl" onClick={() => nav("/")}>الطلبيات المتاحة</Button>
          : <Button block className="md-btn-xl" icon="navigation" onClick={() => nav(`/route/${o.id}`)}>العودة إلى المسار</Button>}
      </div>
    </main>
  );
}
