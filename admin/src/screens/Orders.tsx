/** الطلبيات — لوحة حية: أعمدة الحالات المفتوحة، وتفصيل الطلبية (تأكيد، تعديل الكميات، إلغاء بسبب، التكاليف). */
import { useEffect, useState } from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";

import { qs } from "@ui/client";
import * as fmt from "@ui/fmt";
import {
  Button, ConfirmDialog, DataTable, EmptyState, ErrorState, LoadingState, Money, Num, OrderStatusBadge, PageHead, Section,
  Tabs, TextField, useAction, useLoad,
} from "@ui/kit";
import { api } from "@/api/client";
import type { CostLineOut, OrderDetailOut, OrderLineAdminOut, OrderRowOut } from "@/api/types";
import { ago, itemsCount } from "@/lib/orders-shared";
import { useSession } from "@/session";

const BOARD = ["placed", "confirmed", "assigned", "collecting", "partially_delivered"] as const;
type View = "open" | "delivered" | "closed" | "cancelled";

export function Orders() {
  const [params, setParams] = useSearchParams();
  const [view, setView] = useState<View>("open");
  const openId = Number(params.get("open")) || null;

  const list = useLoad(() => api.get<OrderRowOut[]>(`/api/admin/orders${qs({ status: view === "open" ? undefined : view })}`), [view]);
  useEffect(() => {
    const t = setInterval(list.reload, 15000);
    return () => clearInterval(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [view]);

  function select(id: number | null) {
    const p = new URLSearchParams(params);
    if (id) p.set("open", String(id)); else p.delete("open");
    setParams(p, { replace: true });
  }

  const rows = list.data ?? [];
  const cols = BOARD.map((s) => ({ status: s, cards: rows.filter((o) => o.status === s) }));
  const anyOpen = cols.some((c) => c.cards.length);

  return (
    <div className="md-page">
      <PageHead title="الطلبيات — لوحة حية" actions={<span className="text-13 text-ink-muted">تتحدّث كل 15 ثانية</span>} />
      <Tabs<View> value={view} onChange={setView} tabs={[
        { value: "open", label: "المفتوحة" }, { value: "delivered", label: "مسلَّمة" },
        { value: "closed", label: "مغلقة" }, { value: "cancelled", label: "ملغاة" },
      ]} />

      {view === "open" ? (
        list.loading && !list.data ? <div className="md-sec"><LoadingState rows={3} /></div>
          : list.error && !list.data ? <div className="md-sec"><ErrorState compact title={list.error.message} code={list.error.code} onRetry={list.reload} /></div>
          : !anyOpen ? <div className="md-sec"><EmptyState compact icon="clipboard-list" title="لا طلبيات مفتوحة" body="كل طلبية يؤكدها عميل تظهر هنا في عمودها." /></div>
          : (
            <div className="grid grid-cols-5 gap-3 items-start">
              {cols.map((c) => (
                <section key={c.status} className="bg-primary-tint rounded-lg p-2.5 flex flex-col gap-2">
                  <div className="flex justify-between items-center py-1 px-1.5">
                    <OrderStatusBadge status={c.status} />
                    <Num className="font-bold">{c.cards.length}</Num>
                  </div>
                  {c.cards.map((o) => (
                    <button key={o.id} type="button" onClick={() => select(o.id)}
                      className={`bg-surface border rounded-md p-3 flex flex-col gap-1.5 text-start cursor-pointer text-ink ${o.id === openId ? "border-2 border-primary" : "border-border"}`}>
                      <div className="flex justify-between font-bold text-14 w-full"><Num>#{o.id}</Num><Money value={o.total} size="sm" /></div>
                      <span className="text-14">{o.customer_name}</span>
                      <span className="text-12 text-ink-muted">{cardMeta(o)}</span>
                    </button>
                  ))}
                </section>
              ))}
            </div>
          )
      ) : (
        <DataTable<OrderRowOut>
          rows={list.data} loading={list.loading} error={list.error} onRetry={list.reload}
          emptyIcon="clipboard-list" emptyTitle="لا طلبيات في هذه الحالة" rowKey={(o) => o.id} onRowClick={(o) => select(o.id)}
          columns={[
            { key: "id", label: "الطلبية", render: (o) => <Num>#{o.id}</Num> },
            { key: "customer_name", label: "المنشأة", render: (o) => <>{o.customer_name} <span className="text-ink-muted text-13">· {o.branch_name}</span></> },
            { key: "driver_name", label: "السائق", render: (o) => o.driver_name ?? "—" },
            { key: "placed_at", label: "التاريخ", render: (o) => <Num>{fmt.dateTime(o.placed_at)}</Num> },
            { key: "status", label: "الحالة", render: (o) => <OrderStatusBadge status={o.status} /> },
            { key: "total", label: "الإجمالي", money: true, render: (o) => <Money value={o.total} /> },
          ]} />
      )}

      {openId ? <OrderDetail key={openId} id={openId} onChanged={list.reload} onClose={() => select(null)} /> : null}

      <div className="flex justify-between items-center gap-3 bg-surface border border-border rounded-md py-3 px-3.5">
        <span className="text-14"><b>الإلغاء:</b> المطعم يلغي حتى يبدأ السائق الجمع (الإعداد). أنت تلغي في أي مرحلة قبل التسليم مع سبب؛ ما جُمع يُقيَّد مستحقاً لمورده.</span>
        <Link to="/settings" className="md-link text-14">الإعدادات</Link>
      </div>
    </div>
  );
}

function cardMeta(o: OrderRowOut): string {
  switch (o.status) {
    case "placed": return `${ago(o.placed_at)} · ${itemsCount(o.lines)}`;
    case "confirmed": return o.plan_complete ? `${itemsCount(o.lines)} · بانتظار سائق` : `${itemsCount(o.lines)} · المخطط ناقص`;
    default: return `${o.driver_name ?? "بلا سائق"} · ${itemsCount(o.lines)}`;
  }
}

const CANCELLABLE = new Set(["placed", "confirmed", "assigned", "collecting", "partially_delivered"]);
const EDITABLE = new Set(["placed", "confirmed"]);

function OrderDetail({ id, onChanged, onClose }: { id: number; onChanged: () => void; onClose: () => void }) {
  const { can, refreshCounts } = useSession();
  const nav = useNavigate();
  const seesCosts = can("costs_view");
  const d = useLoad(() => api.get<OrderDetailOut>(`/api/admin/orders/${id}`), [id]);
  const costs = useLoad(() => (seesCosts ? api.get<CostLineOut[]>(`/api/admin/orders/${id}/costs`) : Promise.resolve(null)), [id, seesCosts]);
  const act = useAction();
  const [dialog, setDialog] = useState<"confirm" | "cancel" | null>(null);
  const [reason, setReason] = useState("");
  const [edit, setEdit] = useState<Record<number, string> | null>(null);

  async function done(v: OrderDetailOut | undefined) {
    if (!v) return;
    d.set(v);
    setDialog(null);
    onChanged();
    refreshCounts();
    costs.reload();
  }

  async function confirm() {
    await done(await act.run(() => api.post<OrderDetailOut>(`/api/admin/orders/${id}/confirm`), "تأكّدت الطلبية وبُني مخطط الاستلام"));
  }

  async function cancel() {
    const v = await act.run(() => api.post<OrderDetailOut>(`/api/admin/orders/${id}/cancel`, { reason: reason.trim() }), "أُلغيت الطلبية");
    if (v) setReason("");
    await done(v);
  }

  const lines = d.data?.lines ?? [];
  const changed = edit ? lines.filter((l) => edit[l.id] !== undefined && Number(edit[l.id]) !== Number(l.qty)) : [];
  const badQty = edit ? Object.values(edit).some((q) => !fmt.isMoney(q) || Number(q) <= 0) : false;

  async function saveEdit() {
    let last: OrderDetailOut | undefined;
    for (const l of changed) {
      const v = await act.run(() => api.patch<OrderDetailOut>(`/api/admin/orders/${id}/items/${l.id}`, { qty: (edit?.[l.id] ?? l.qty).trim() }));
      if (!v) break;
      last = v;
    }
    if (last) {
      await done(last);
      setEdit(null);
    }
  }

  if (d.loading && !d.data) return <div className="md-sec"><LoadingState rows={3} /></div>;
  if (d.error && !d.data) return <div className="md-sec"><ErrorState compact title={d.error.message} code={d.error.code} onRetry={d.reload} /></div>;
  if (!d.data) return null;
  const o = d.data.order;
  const x = d.data;

  return (
    <>
      <section className="bg-surface border border-border rounded-lg p-5 shadow-card grid grid-cols-[minmax(0,1fr)_var(--w-col-side)] gap-5">
        <div className="flex flex-col gap-2.5">
          <div className="flex gap-2.5 items-center">
            <h2 className="md-sec-title-lg m-0">الطلبية <Num>#{o.id}</Num> — {o.customer_name}</h2>
            <OrderStatusBadge status={o.status} />
            <span className="flex-1" />
            <Button variant="ghost" size="sm" icon="x" onClick={onClose}>إغلاق</Button>
          </div>
          <span className="text-13 text-ink-muted">{o.branch_name}{x.dest_address ? ` · ${x.dest_address}` : ""} · <Num>{fmt.dateTime(o.placed_at)}</Num>{o.driver_name ? ` · السائق ${o.driver_name}` : ""}</span>
          <DataTable<OrderLineAdminOut>
            rows={lines} rowKey={(l) => l.id} emptyTitle="لا أصناف"
            columns={[
              { key: "name_ar", label: "الصنف" },
              {
                key: "qty", label: "الكمية", numeric: true,
                render: (l) => edit ? (
                  <TextField value={edit[l.id] ?? fmt.qty(l.qty)} numeric className="w-field-sm"
                    onChange={(v) => setEdit({ ...edit, [l.id]: v })} error={edit[l.id] !== undefined && (!fmt.isMoney(edit[l.id] ?? "") || Number(edit[l.id]) <= 0) ? "كمية غير صحيحة" : null} />
                ) : <Num>{fmt.qty(l.qty)}{Number(l.delivered_qty) > 0 ? ` (سُلِّم ${fmt.qty(l.delivered_qty)})` : ""}</Num>,
              },
              { key: "unit_price", label: "السعر المحجوز", money: true, render: (l) => (l.unit_price != null ? <Money value={l.unit_price} /> : "—") },
              { key: "line_total", label: "المجموع", money: true, render: (l) => (l.line_total != null ? <Money value={l.line_total} /> : "—") },
            ]} />
          {edit ? (
            <div className="flex gap-2">
              <Button icon="check" loading={act.busy} disabled={!changed.length || badQty} onClick={saveEdit}>حفظ التعديل</Button>
              <Button variant="ghost" onClick={() => setEdit(null)}>تراجع</Button>
            </div>
          ) : null}
          {d.data.events.find((e) => e.to_status === "cancelled" && e.reason)
            ? <span className="text-13 text-error-text">سبب الإلغاء: {d.data.events.find((e) => e.to_status === "cancelled")?.reason}</span> : null}
        </div>
        <div className="flex flex-col gap-2.5">
          <div className="flex justify-between text-14"><span className="text-ink-muted">الأصناف</span><Money value={x.subtotal} /></div>
          <div className="flex justify-between text-14"><span className="text-ink-muted">رسم التوصيل</span><Money value={x.delivery_fee} /></div>
          <div className="flex justify-between text-16 font-bold border-0 border-t border-solid border-border pt-2"><span>الإجمالي</span><Money value={o.total} /></div>
          {x.driver_pay != null ? <div className="flex justify-between text-14"><span className="text-ink-muted">أجر السائق</span><Money value={x.driver_pay} /></div> : null}
          {o.status === "placed" ? <Button icon="check" block onClick={() => setDialog("confirm")}>تأكيد وبناء مخطط الاستلام</Button> : null}
          {o.status === "confirmed" ? <>
            <Button icon="map-pin" block onClick={() => nav(`/plan/${o.id}`)}>مخطط الاستلام</Button>
            <Button variant="secondary" icon="truck" block onClick={() => nav(`/assign?order=${o.id}`)}>الإسناد</Button>
          </> : null}
          {EDITABLE.has(o.status) && !edit
            ? <Button variant="secondary" icon="pencil" block onClick={() => setEdit({})}>تعديل الطلبية</Button> : null}
          {CANCELLABLE.has(o.status) ? <Button variant="danger" block onClick={() => setDialog("cancel")}>إلغاء مع سبب</Button> : null}
        </div>
      </section>

      {costs.data ? (
        <Section title="تكاليف الطلبية" right={<span className="text-13 text-ink-muted">المجموع <Money value={costs.data.reduce((s, c) => s + Number(c.line_cost), 0)} /></span>}>
          <DataTable<CostLineOut>
            rows={costs.data} emptyIcon="map-pin" emptyTitle="لا مخطط بعد" emptyBody="يُبنى المخطط آلياً عند تأكيد الطلبية."
            columns={[
              { key: "name_ar", label: "الصنف" },
              { key: "supplier_name", label: "المصدر", render: (c) => c.supplier_name ?? "مخزن مَدَد" },
              { key: "planned_qty", label: "الكمية", numeric: true, render: (c) => <Num>{fmt.qty(c.planned_qty)}</Num> },
              { key: "purchase_price", label: "سعر الشراء", money: true, render: (c) => (c.purchase_price != null ? <Money value={c.purchase_price} /> : "—") },
              { key: "unit_cost", label: "تكلفة الوحدة", money: true },
              { key: "line_cost", label: "التكلفة", money: true },
            ]} />
        </Section>
      ) : costs.error ? <ErrorState compact title={costs.error.message} code={costs.error.code} onRetry={costs.reload} /> : null}

      <ConfirmDialog open={dialog === "confirm"} title={<>تأكيد الطلبية <Num>#{o.id}</Num>؟</>}
        body={<>يُبنى مخطط الاستلام آلياً: المخزن أولاً، ثم الأولوية، ثم الأكثر كمية. الإجمالي <Money value={o.total} />.</>}
        confirmLabel="تأكيد وبناء المخطط" loading={act.busy} onConfirm={confirm} onCancel={() => setDialog(null)} />

      <ConfirmDialog open={dialog === "cancel"} tone="error" title={<>إلغاء الطلبية <Num>#{o.id}</Num></>}
        body={<>الإجمالي <Money value={o.total} />. ما جُمع يُقيَّد مستحقاً لمورده، والسبب يصل إلى العميل ويُحفظ في سجل التدقيق.</>}
        confirmLabel="إلغاء الطلبية" cancelLabel="تراجع" loading={act.busy} confirmDisabled={!reason.trim()}
        onConfirm={cancel} onCancel={() => setDialog(null)}>
        <TextField label="سبب الإلغاء" value={reason} onChange={setReason} multiline required autoFocus
          hint="اكتب سبب الإلغاء؛ يصل إلى العميل ويُحفظ في سجل التدقيق." />
      </ConfirmDialog>
    </>
  );
}
