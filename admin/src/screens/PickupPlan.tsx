/** مخطط الاستلام: اختيار طلبية مؤكَّدة ثم تعديل مخططها قبل الإسناد (إضافة سطر من مورد أو مخزن، تغيير الكمية، الحذف، تغيير المصدر). */
import { useEffect, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";

import { qs } from "@ui/client";
import * as fmt from "@ui/fmt";
import {
  Button, ConfirmDialog, DataTable, Dialog, EmptyState, ErrorState, LoadingState, Money, Note, Num, Option, OrderStatusBadge,
  PageHead, Select, StatusBadge, TextField, useAction, useLoad,
} from "@ui/kit";
import { api } from "@/api/client";
import type {
  ItemPricingOut, OrderDetailOut, OrderLineAdminOut, OrderRowOut, PlanLineOut, PlanOut, PlanStopOut, StockOut, WarehouseOut,
} from "@/api/types";
import { itemsCount, STOP_SOURCE, STOP_STATUS } from "@/lib/orders-shared";
import { useSession } from "@/session";

export function PickupPlan() {
  const { orderId } = useParams();
  const id = Number(orderId) || null;
  return id ? <PlanEditor key={id} id={id} /> : <PlanChooser />;
}

// ——— اختيار الطلبية ————————————————————————————————————————————————————————————
function PlanChooser() {
  const nav = useNavigate();
  const list = useLoad(() => api.get<OrderRowOut[]>(`/api/admin/orders${qs({ status: "confirmed" })}`));
  const rows = list.data ? [...list.data].sort((a, b) => Number(a.plan_complete) - Number(b.plan_complete)) : list.data;
  return (
    <div className="md-page">
      <PageHead title="مخطط الاستلام" sub="اختر طلبية مؤكَّدة لم تُسند بعد. يُبنى المخطط آلياً عند التأكيد، ويُعدَّل قبل الإسناد فقط." />
      <DataTable<OrderRowOut>
        rows={rows} loading={list.loading} error={list.error} onRetry={list.reload}
        emptyIcon="map-pin" emptyTitle="لا مخطط بعد" emptyBody="يُبنى المخطط آلياً عند تأكيد الطلبية."
        rowKey={(o) => o.id} rowTone={(o) => !o.plan_complete && "error"} onRowClick={(o) => nav(`/plan/${o.id}`)}
        columns={[
          { key: "id", label: "الطلبية", render: (o) => <Num>#{o.id}</Num> },
          { key: "customer_name", label: "المنشأة", render: (o) => <>{o.customer_name} <span className="text-ink-muted text-13">· {o.branch_name}</span></> },
          { key: "lines", label: "الأصناف", render: (o) => itemsCount(o.lines) },
          { key: "status", label: "الحالة", render: (o) => <OrderStatusBadge status={o.status} /> },
          { key: "plan_complete", label: "المخطط", render: (o) => <PlanBadge complete={o.plan_complete} /> },
          { key: "total", label: "الإجمالي", money: true, render: (o) => <Money value={o.total} /> },
        ]} />
    </div>
  );
}

function PlanBadge({ complete }: { complete: boolean }) {
  return complete ? <StatusBadge tone="success" icon="circle-check">المخطط مكتمل</StatusBadge>
    : <StatusBadge tone="error" icon="triangle-alert">المخطط ناقص — الإسناد موقوف</StatusBadge>;
}

// ——— المحرّر ————————————————————————————————————————————————————————————————
interface AddState { itemId: number | null; qty: string; replace?: PlanLineOut[] }

function PlanEditor({ id }: { id: number }) {
  const nav = useNavigate();
  const plan = useLoad(() => api.get<PlanOut>(`/api/admin/orders/${id}/plan`), [id]);
  const order = useLoad(() => api.get<OrderDetailOut>(`/api/admin/orders/${id}`), [id]);
  const act = useAction();
  const [add, setAdd] = useState<AddState | null>(null);
  const [qtyEdit, setQtyEdit] = useState<{ line: PlanLineOut; qty: string } | null>(null);
  const [del, setDel] = useState<PlanLineOut | null>(null);

  const p = plan.data;
  const lines = order.data?.lines ?? [];
  const editable = p?.status === "confirmed";
  const seesCost = !!p?.stops.some((s) => s.lines.some((l) => l.unit_cost !== undefined));

  // المطلوب لكل صنف مقابل المخطّط في كل النقاط
  const planned = new Map<number, number>();
  p?.stops.forEach((s) => s.lines.forEach((l) => planned.set(l.order_item_id, (planned.get(l.order_item_id) ?? 0) + Number(l.planned_qty))));
  const shortages = lines
    .map((l) => ({ line: l, need: Number(l.qty), have: planned.get(l.id) ?? 0 }))
    .filter((x) => x.have + 1e-9 < x.need);
  const shortIds = new Set(shortages.map((s) => s.line.id));

  async function saveQty() {
    if (!qtyEdit) return;
    const v = await act.run(() => api.patch<PlanOut>(`/api/admin/plan/lines/${qtyEdit.line.id}`, { qty: qtyEdit.qty.trim() }), "عُدّلت الكمية");
    if (v) { plan.set(v); setQtyEdit(null); }
  }

  async function remove() {
    if (!del) return;
    const ok = await act.run(() => api.del<void>(`/api/admin/plan/lines/${del.id}`).then(() => true), "حُذف السطر");
    if (ok) { setDel(null); plan.reload(); }
  }

  if ((plan.loading && !p) || (order.loading && !order.data)) return <div className="md-page"><div className="md-sec"><LoadingState rows={3} /></div></div>;
  const err = (!p && plan.error) || (!order.data && order.error);
  if (err) return <div className="md-page"><div className="md-sec"><ErrorState compact title={err.message} code={err.code} onRetry={() => { plan.reload(); order.reload(); }} /></div></div>;
  if (!p || !order.data) return null;

  return (
    <div className="md-page">
      <PageHead title={<>مخطط الاستلام — الطلبية <Num>#{id}</Num></>}
        sub={`${order.data.order.customer_name} · بُني آلياً عند التأكيد: المخزن أولاً، ثم الأولوية، ثم الأكثر كمية. يُعدَّل قبل الإسناد فقط.`}
        actions={<>
          <PlanBadge complete={p.plan_complete} />
          {p.plan_complete && p.status === "confirmed" ? <Button size="sm" icon="truck" onClick={() => nav(`/assign?order=${id}`)}>الإسناد</Button> : null}
        </>} />

      {!editable ? (
        <Note tone="warning">
          <b>المخطط مقفل.</b> {p.status === "assigned" ? "الطلبية أُسندت لسائق. فكّ الإسناد أولاً لتعديل المخطط." : "يُعدَّل المخطط والطلبية مؤكَّدة قبل الإسناد فقط."}
        </Note>
      ) : null}

      <div className="grid grid-cols-[minmax(0,1fr)_var(--w-col-side)] gap-5 items-start">
        <div className="flex flex-col gap-3">
          {p.stops.length ? p.stops.map((s) => (
            <StopCard key={s.id} stop={s} editable={editable} seesCost={seesCost} shortIds={shortIds} required={lines}
              onChangeSource={() => {
                const first = s.lines[0];
                const oi = first ? lines.find((l) => l.id === first.order_item_id) : undefined;
                setAdd({ itemId: oi?.id ?? null, qty: first ? fmt.qty(first.planned_qty) : "", replace: s.lines });
              }}
              onQty={(l) => setQtyEdit({ line: l, qty: fmt.qty(l.planned_qty) })} onDelete={setDel} />
          )) : (
            <div className="md-sec"><EmptyState compact icon="map-pin" title="لا مخطط بعد" body="يُبنى المخطط آلياً عند تأكيد الطلبية." /></div>
          )}
        </div>

        <aside className="flex flex-col gap-3">
          {shortages.length ? (
            <section className="bg-error-tint rounded-lg p-4 flex flex-col gap-2">
              <span className="font-bold">نقص في المخطط</span>
              {shortages.map((s) => (
                <div key={s.line.id} className="flex flex-col gap-2">
                  <span className="text-14">{s.line.name_ar}: مطلوب <Num>{fmt.qty(s.need)}</Num>، مخطّط <Num>{fmt.qty(s.have)}</Num>.</span>
                  {editable ? (
                    <Button size="sm" icon="plus" onClick={() => setAdd({ itemId: s.line.id, qty: fmt.qty(s.need - s.have) })}>إضافة مصدر للباقي</Button>
                  ) : null}
                </div>
              ))}
              <Button size="sm" variant="secondary" onClick={() => nav(`/orders?open=${id}`)}>تعديل كمية الطلبية</Button>
            </section>
          ) : p.stops.length ? <Note tone="success">المخطط يغطي كل الكميات المطلوبة.</Note> : null}
          {editable ? <Button variant="secondary" icon="plus" block onClick={() => setAdd({ itemId: lines[0]?.id ?? null, qty: "" })}>إضافة سطر</Button> : null}
        </aside>
      </div>

      {add ? <AddLineDialog orderId={id} state={add} orderLines={lines} onClose={() => setAdd(null)}
        onDone={(v) => { plan.set(v); setAdd(null); }} onReplaced={() => { plan.reload(); setAdd(null); }} /> : null}

      <Dialog open={!!qtyEdit} onClose={() => setQtyEdit(null)} label="تغيير الكمية">
        <div className="md-dialog-title">تغيير الكمية — {qtyEdit?.line.item}</div>
        <TextField label="الكمية المخطّطة" value={qtyEdit?.qty ?? ""} numeric autoFocus
          onChange={(v) => qtyEdit && setQtyEdit({ ...qtyEdit, qty: v })}
          error={qtyEdit && qtyEdit.qty && (!fmt.isMoney(qtyEdit.qty) || Number(qtyEdit.qty) <= 0) ? "كمية غير صحيحة" : null} />
        <div className="md-dialog-actions">
          <Button block loading={act.busy} disabled={!qtyEdit || !fmt.isMoney(qtyEdit.qty) || Number(qtyEdit.qty) <= 0} onClick={saveQty}>حفظ</Button>
          <Button variant="ghost" block onClick={() => setQtyEdit(null)}>إلغاء</Button>
        </div>
      </Dialog>

      <ConfirmDialog open={!!del} tone="error" icon="trash-2" title="حذف السطر من المخطط؟"
        body={<>{del?.item} — <Num>{fmt.qty(del?.planned_qty)}</Num>. تنقص الكمية المخطّطة ويصبح المخطط ناقصاً حتى تضيف مصدراً آخر.</>}
        confirmLabel="حذف" loading={act.busy} onConfirm={remove} onCancel={() => setDel(null)} />
    </div>
  );
}

function StopCard({ stop, editable, seesCost, shortIds, required, onChangeSource, onQty, onDelete }: {
  stop: PlanStopOut; editable: boolean; seesCost: boolean; shortIds: Set<number>; required: OrderLineAdminOut[];
  onChangeSource: () => void; onQty: (l: PlanLineOut) => void; onDelete: (l: PlanLineOut) => void;
}) {
  const st = STOP_STATUS[stop.status];
  const need = (oi: number) => required.find((r) => r.id === oi)?.qty;
  return (
    <section className="bg-surface border border-border rounded-lg p-4 flex flex-col gap-2.5 shadow-card">
      <div className="flex items-center gap-3">
        <span className="w-8 h-8 rounded-full bg-primary text-on-primary grid place-items-center font-bold md-num">{stop.seq}</span>
        <div className="flex flex-col flex-1">
          <span className="font-bold">{stop.label}</span>
          <span className="text-13 text-ink-muted">{STOP_SOURCE[stop.source] ?? stop.source}</span>
        </div>
        {st && stop.status !== "pending" ? <StatusBadge tone={st[1]}>{st[0]}</StatusBadge> : null}
        {editable && stop.lines.length ? <Button variant="ghost" size="sm" icon="pencil" onClick={onChangeSource}>تغيير المصدر</Button> : null}
      </div>
      <DataTable<PlanLineOut>
        rows={stop.lines} rowKey={(l) => l.id} emptyTitle="لا أسطر في هذه النقطة"
        rowTone={(l) => shortIds.has(l.order_item_id) && "error"}
        columns={[
          { key: "item", label: "الصنف" },
          {
            key: "planned_qty", label: "الكمية", numeric: true,
            render: (l) => <Num>{fmt.qty(l.planned_qty)}{shortIds.has(l.order_item_id) && need(l.order_item_id) ? ` من ${fmt.qty(need(l.order_item_id))}` : ""}</Num>,
          },
          ...(seesCost ? [
            { key: "unit_cost", label: "تكلفة الوحدة", money: true, render: (l: PlanLineOut) => (l.unit_cost != null ? <Money value={l.unit_cost} /> : "—") },
            { key: "cost", label: "التكلفة", money: true, render: (l: PlanLineOut) => (l.unit_cost != null ? <Money value={Number(l.unit_cost) * Number(l.planned_qty)} /> : "—") },
          ] : []),
          ...(editable ? [{
            key: "act", label: "", render: (l: PlanLineOut) => (
              <div className="flex gap-1 justify-end">
                <Button variant="ghost" size="sm" icon="pencil" onClick={() => onQty(l)}>الكمية</Button>
                <Button variant="ghost" size="sm" icon="trash-2" onClick={() => onDelete(l)}>حذف</Button>
              </div>
            ),
          }] : []),
        ]} />
    </section>
  );
}

// ——— إضافة سطر / تغيير المصدر ————————————————————————————————————————————————————
type Src = { kind: "offer"; id: number } | { kind: "warehouse"; id: number };

function AddLineDialog({ orderId, state, orderLines, onClose, onDone, onReplaced }: {
  orderId: number; state: AddState; orderLines: OrderLineAdminOut[]; onClose: () => void; onDone: (p: PlanOut) => void; onReplaced: () => void;
}) {
  const { can } = useSession();
  const act = useAction();
  const replace = state.replace;
  const [replaceId, setReplaceId] = useState<number | null>(replace?.[0]?.id ?? null);
  const replaced = replace?.find((l) => l.id === replaceId);
  const [itemId, setItemId] = useState<number | null>(state.itemId);
  const [qty, setQty] = useState(state.qty);
  const [src, setSrc] = useState<Src | null>(null);
  const item = orderLines.find((l) => l.id === itemId);

  useEffect(() => {
    if (!replaced) return;
    const oi = orderLines.find((l) => l.id === replaced.order_item_id);
    setItemId(oi?.id ?? null);
    setQty(fmt.qty(replaced.planned_qty));
  }, [replaced, orderLines]);
  useEffect(() => setSrc(null), [itemId]);

  const catalogItem = item?.catalog_item_id ?? null;
  const offers = useLoad(async () => {
    if (!catalogItem || !can("catalog")) return null;
    const pr = await api.get<ItemPricingOut>(`/api/admin/catalog/${catalogItem}`);
    return pr.sources_detail.filter((s) => s.status === "active");
  }, [catalogItem]);
  const stores = useLoad(async () => {
    if (!catalogItem || !can("warehouses")) return null;
    const [whs, stock] = await Promise.all([
      api.get<WarehouseOut[]>(`/api/admin/warehouses`),
      api.get<StockOut[]>(`/api/admin/stock`),
    ]);
    return whs.filter((w) => w.active).map((w) => ({ w, avail: stock.find((s) => s.warehouse_id === w.id && s.item_id === catalogItem)?.available ?? "0" }));
  }, [catalogItem]);

  const qtyOk = fmt.isMoney(qty) && Number(qty) > 0;

  async function submit() {
    if (!item || !src) return;
    const body = { order_item_id: item.id, qty: qty.trim(), offer_id: src.kind === "offer" ? src.id : null, warehouse_id: src.kind === "warehouse" ? src.id : null };
    const v = await act.run(() => api.post<PlanOut>(`/api/admin/orders/${orderId}/plan/lines`, body), replace ? undefined : "أُضيف السطر إلى المخطط");
    if (!v) return;
    if (replaced) {
      const ok = await act.run(() => api.del<void>(`/api/admin/plan/lines/${replaced.id}`).then(() => true), "تغيّر المصدر");
      if (ok) onReplaced(); else onDone(v);
    } else onDone(v);
  }

  return (
    <Dialog open wide onClose={onClose} label={replace ? "تغيير المصدر" : "إضافة سطر"}>
      <div className="md-dialog-title">{replace ? "تغيير المصدر" : "إضافة مصدر إلى المخطط"}</div>
      <div className="flex flex-col gap-3">
        {replace ? (
          replace.length > 1 ? (
            <Select label="السطر" value={String(replaceId ?? "")} onChange={(v) => setReplaceId(Number(v))}
              options={replace.map((l) => ({ value: String(l.id), label: `${l.item} — ${fmt.qty(l.planned_qty)}` }))} />
          ) : <span className="text-14">{replaced?.item} — <Num>{fmt.qty(replaced?.planned_qty)}</Num></span>
        ) : (
          <Select label="الصنف" value={String(itemId ?? "")} onChange={(v) => setItemId(Number(v))}
            options={orderLines.map((l) => ({ value: String(l.id), label: `${l.name_ar} — مطلوب ${fmt.qty(l.qty)}` }))} />
        )}
        <TextField label="الكمية" value={qty} onChange={setQty} numeric error={qty && !qtyOk ? "كمية غير صحيحة" : null} />

        <span className="text-14 font-bold">من مورد</span>
        {!can("catalog") ? <span className="text-13 text-ink-muted">اختيار عروض الموردين يحتاج صلاحية الكتالوج.</span>
          : offers.loading && !offers.data ? <LoadingState rows={1} />
          : offers.error ? <ErrorState compact title={offers.error.message} code={offers.error.code} onRetry={offers.reload} />
          : offers.data?.length ? (
            <div role="radiogroup" className="grid grid-cols-2 gap-2">
              {offers.data.map((o) => (
                <Option key={o.offer_id} selected={src?.kind === "offer" && src.id === o.offer_id} onSelect={() => setSrc({ kind: "offer", id: o.offer_id })}
                  label={o.supplier_name}
                  sub={<>الأولوية <Num>{o.priority}</Num> · متاح <Num>{fmt.qty(o.available_qty)}</Num>{o.purchase_price != null ? <> · <Money value={o.purchase_price} /></> : null}</>} />
              ))}
            </div>
          ) : <span className="text-13 text-ink-muted">لا عروض نشطة لهذا الصنف.</span>}

        <span className="text-14 font-bold">من مخزن مَدَد</span>
        {!can("warehouses") ? <span className="text-13 text-ink-muted">اختيار المخازن يحتاج صلاحية المخازن.</span>
          : stores.loading && !stores.data ? <LoadingState rows={1} />
          : stores.error ? <ErrorState compact title={stores.error.message} code={stores.error.code} onRetry={stores.reload} />
          : stores.data?.length ? (
            <div role="radiogroup" className="grid grid-cols-2 gap-2">
              {stores.data.map(({ w, avail }) => (
                <Option key={w.id} selected={src?.kind === "warehouse" && src.id === w.id} onSelect={() => setSrc({ kind: "warehouse", id: w.id })}
                  disabled={Number(avail) <= 0} label={w.name} sub={<>المتاح <Num>{fmt.qty(avail)}</Num> · {w.address_text}</>} />
              ))}
            </div>
          ) : <span className="text-13 text-ink-muted">لا مخازن نشطة.</span>}
      </div>
      <div className="md-dialog-actions">
        <Button block icon="check" loading={act.busy} disabled={!item || !src || !qtyOk} onClick={submit}>{replace ? "نقل إلى المصدر" : "إضافة"}</Button>
        <Button variant="ghost" block onClick={onClose}>إلغاء</Button>
      </div>
    </Dialog>
  );
}
