/** الإسناد: طلبية مؤكَّدة مخططها مكتمل ← سائق متاح (مع طول المسار لأجر المعادلة)، وفكّ الإسناد قبل بدء الجمع. */
import { useEffect, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";

import { qs } from "@ui/client";
import * as fmt from "@ui/fmt";
import {
  Button, ConfirmDialog, DataTable, EmptyState, Icon, Money, Note, Num, OrderStatusBadge, PageHead, Section, StatusBadge, TextField,
  useAction, useLoad,
} from "@ui/kit";
import { api } from "@/api/client";
import type { DriverChoiceOut, OrderDetailOut, OrderRowOut, PayOfferOut, PlanOut } from "@/api/types";
import { itemsCount, VEHICLE } from "@/lib/orders-shared";

const KM = /^\d+(\.\d{1,2})?$/;

export function Assign() {
  const [params, setParams] = useSearchParams();
  const waiting = useLoad(() => api.get<OrderRowOut[]>(`/api/admin/orders${qs({ status: "confirmed" })}`));
  const assigned = useLoad(() => api.get<OrderRowOut[]>(`/api/admin/orders${qs({ status: "assigned" })}`));
  const drivers = useLoad(() => api.get<DriverChoiceOut[]>(`/api/admin/drivers/available`));
  const fallback = waiting.data?.find((o) => o.plan_complete)?.id ?? waiting.data?.[0]?.id ?? null;
  const id = Number(params.get("order")) || fallback;

  const detail = useLoad(() => (id ? api.get<OrderDetailOut>(`/api/admin/orders/${id}`) : Promise.resolve(null)), [id]);
  const plan = useLoad(() => (id ? api.get<PlanOut>(`/api/admin/orders/${id}/plan`) : Promise.resolve(null)), [id]);
  const act = useAction();
  const [pick, setPick] = useState<DriverChoiceOut | null>(null);
  const [km, setKm] = useState("");
  const [unassign, setUnassign] = useState(false);

  const o = detail.data?.order;
  const canAssign = o?.status === "confirmed" && o.plan_complete;
  const stops = plan.data?.stops.length ?? 0;

  function choose(orderId: number) {
    setParams({ order: String(orderId) }, { replace: true });
  }

  function refresh(v: OrderDetailOut) {
    detail.set(v);
    waiting.reload();
    assigned.reload();
    drivers.reload();
  }

  async function doAssign() {
    if (!pick || !id) return;
    const v = await act.run(() => api.post<OrderDetailOut>(`/api/admin/orders/${id}/assign`, { driver_id: pick.id, route_km: km.trim() }),
      `أُسندت الطلبية إلى ${pick.full_name}`);
    if (v) { refresh(v); setPick(null); setKm(""); }
  }

  async function doUnassign() {
    if (!id) return;
    const v = await act.run(() => api.post<OrderDetailOut>(`/api/admin/orders/${id}/unassign`), "فُكّ الإسناد وعادت الطلبية مؤكَّدة");
    if (v) { refresh(v); setUnassign(false); }
  }

  function driverState(d: DriverChoiceOut) {
    if (d.over_cap) return <StatusBadge tone="error">فوق السقف</StatusBadge>;
    if (d.active_orders > 0) return <StatusBadge tone="neutral">في طلبية</StatusBadge>;
    return <StatusBadge tone="success">متاح</StatusBadge>;
  }

  return (
    <div className="md-page">
      <PageHead title={id ? <>الإسناد — الطلبية <Num>#{id}</Num></> : "الإسناد"}
        actions={o ? (
          <span className="text-14 text-ink-muted">
            {o.customer_name} · <Num>{stops}</Num> {stops === 1 ? "نقطة استلام" : "نقاط استلام"}
            {detail.data?.route_km ? <> · <Num>{fmt.qty(detail.data.route_km)} كم</Num></> : null} · الإجمالي <Money value={o.total} size="sm" />
          </span>
        ) : undefined} />

      <div className="grid grid-cols-[minmax(0,1fr)_var(--w-col-side)] gap-5 items-start">
        <section className="flex flex-col gap-2.5">
          <h2 className="md-sec-title-lg m-0">السائقون المتاحون في طرابلس</h2>
          {o && o.status === "confirmed" && !o.plan_complete ? (
            <Note tone="error"><b>المخطط ناقص — الإسناد موقوف.</b> <Link className="md-link" to={`/plan/${o.id}`}>أكمل مخطط الاستلام</Link> ثم أسند.</Note>
          ) : null}
          <DataTable<DriverChoiceOut>
            rows={drivers.data} loading={drivers.loading} error={drivers.error} onRetry={drivers.reload}
            emptyIcon="truck" emptyTitle="لا سائق متاح الآن" emptyBody="الطلبية ظاهرة للسائقين في طرابلس؛ يقبلها أول متاح أو تُسند يدوياً لاحقاً."
            rowKey={(d) => d.id} rowTone={(d) => d.over_cap && "error"}
            columns={[
              { key: "full_name", label: "السائق" },
              { key: "vehicle", label: "المركبة", render: (d) => <>{VEHICLE[d.vehicle] ?? d.vehicle}{d.capacity_kg ? <> · <Num>{fmt.qty(d.capacity_kg)} كغ</Num></> : null}</> },
              { key: "active_orders", label: "طلبيات جارية", numeric: true },
              { key: "cash_held", label: "الكاش بحوزته", money: true },
              { key: "s", label: "الحالة", render: driverState },
              {
                key: "a", label: "", render: (d) => (
                  <Button size="sm" disabled={!canAssign || d.over_cap || d.active_orders > 0}
                    title={d.over_cap ? "السائق تجاوز سقف الكاش. سجّل تسليم الكاش أولاً." : undefined}
                    onClick={() => { setPick(d); setKm(detail.data?.route_km ? fmt.qty(detail.data.route_km) : ""); }}>إسناد</Button>
                ),
              },
            ]} />
        </section>

        <section className="flex flex-col gap-3">
          {o && o.status === "assigned" ? (
            <div className="bg-surface border border-border rounded-lg p-4 flex flex-col gap-2.5 shadow-card">
              <div className="flex justify-between items-center"><span className="font-bold">{o.driver_name}</span><OrderStatusBadge status={o.status} /></div>
              {detail.data?.driver_pay != null ? <div className="flex justify-between text-14"><span className="text-ink-muted">أجر السائق</span><Money value={detail.data.driver_pay} /></div> : null}
              <span className="text-13 text-ink-muted">فكّ الإسناد يعيد الطلبية مؤكَّدة ويفتح مخططها للتعديل، ما دام السائق لم يبدأ الجمع.</span>
              <Button variant="secondary" icon="x" onClick={() => setUnassign(true)}>فكّ الإسناد</Button>
            </div>
          ) : null}

          {id && o?.status === "confirmed" ? <RouteKm orderId={id} km={detail.data?.route_km ?? null} onSaved={(v) => detail.set(v)} /> : null}
          {id && o?.status === "confirmed" ? <FareOffers orderId={id} onAssigned={() => { detail.reload(); waiting.reload(); assigned.reload(); drivers.reload(); }} /> : null}

          <Section title="تنتظر الإسناد">
            {waiting.data?.length ? waiting.data.map((w) => (
              <OrderLink key={w.id} o={w} active={w.id === id} onClick={() => choose(w.id)} />
            )) : waiting.loading ? null : <EmptyState compact icon="clipboard-list" title="لا طلبيات مؤكَّدة تنتظر سائقاً" />}
          </Section>
          {assigned.data?.length ? (
            <Section title="مُسندة ولم يبدأ الجمع">
              {assigned.data.map((w) => <OrderLink key={w.id} o={w} active={w.id === id} onClick={() => choose(w.id)} />)}
            </Section>
          ) : null}
        </section>
      </div>

      <ConfirmDialog open={!!pick} title={<>إسناد الطلبية <Num>#{id}</Num> إلى {pick?.full_name}</>}
        body={<>الإجمالي <Money value={o?.total} /> · الكاش بحوزته <Money value={pick?.cash_held} />. أجر السائق يُحسب بالمعادلة من طول المسار.</>}
        confirmLabel="إسناد" loading={act.busy} confirmDisabled={!KM.test(km.trim())} onConfirm={doAssign} onCancel={() => setPick(null)}>
        <TextField label="طول المسار" value={km} onChange={setKm} numeric suffix="كم" required autoFocus
          error={km && !KM.test(km.trim()) ? "رقم بخانتين عشريتين على الأكثر" : null} />
      </ConfirmDialog>

      <ConfirmDialog open={unassign} tone="warning" title={<>فكّ إسناد الطلبية <Num>#{id}</Num>؟</>}
        body={<>تعود الطلبية مؤكَّدة بلا سائق ({o?.driver_name}).</>} confirmLabel="فكّ الإسناد" loading={act.busy}
        onConfirm={doUnassign} onCancel={() => setUnassign(false)} />
    </div>
  );
}

function OrderLink({ o, active, onClick }: { o: OrderRowOut; active: boolean; onClick: () => void }) {
  return (
    <button type="button" onClick={onClick} className={`md-row-link w-full text-start border-0 cursor-pointer text-ink ${active ? "bg-primary-tint" : "bg-surface"}`}>
      <Icon name={o.plan_complete ? "clipboard-list" : "triangle-alert"} size={18} />
      <span className="flex-1 flex flex-col">
        <span className="text-14"><Num>#{o.id}</Num> — {o.customer_name}</span>
        <span className="text-12 text-ink-muted">{itemsCount(o.lines)}{o.plan_complete ? "" : " · المخطط ناقص"}{o.driver_name ? ` · ${o.driver_name}` : ""}</span>
      </span>
      <Money value={o.total} size="sm" />
    </button>
  );
}

/** عروض أجرة من السائقين (§4.2): السائق يطلب أجرة غير المعادلة؛ القبول يُسنده بأجرته، والرفض يبقي الطلبية مفتوحة. */
function FareOffers({ orderId, onAssigned }: { orderId: number; onAssigned: () => void }) {
  const offers = useLoad(() => api.get<PayOfferOut[]>(`/api/admin/orders/${orderId}/pay-offers`), [orderId]);
  const act = useAction();
  const [accepting, setAccepting] = useState<PayOfferOut | null>(null);
  const pending = (offers.data ?? []).filter((f) => f.status === "pending");
  if (!pending.length) return null;

  async function decide(f: PayOfferOut, decision: "accept" | "reject") {
    const v = await act.run(() => api.post<PayOfferOut[]>(`/api/admin/pay-offers/${f.id}/decide`, { decision }),
      decision === "accept" ? `أُسندت الطلبية إلى ${f.driver_name} بأجرته` : "رُفض العرض");
    if (!v) return;
    offers.set(v);
    setAccepting(null);
    if (decision === "accept") onAssigned();
  }

  return (
    <Section title="عروض أجرة من السائقين">
      {pending.map((f) => (
        <div key={f.id} className="md-note md-note-warning flex flex-col gap-2">
          <div className="flex justify-between items-center"><b>{f.driver_name}</b><StatusBadge tone="warning">عرض مختلف</StatusBadge></div>
          {f.formula_pay != null ? <div className="md-kv"><span className="md-muted">أجر المعادلة</span><Money value={f.formula_pay} /></div> : null}
          <div className="md-kv"><span className="md-muted">يطلب</span><Money value={f.amount} /></div>
          <div className="flex gap-2">
            <Button icon="check" size="sm" loading={act.busy} onClick={() => setAccepting(f)}>قبول وإسناد</Button>
            <Button variant="secondary" size="sm" disabled={act.busy} onClick={() => void decide(f, "reject")}>رفض</Button>
          </div>
        </div>
      ))}
      <ConfirmDialog open={!!accepting} title={<>إسناد الطلبية <Num>#{orderId}</Num> إلى {accepting?.driver_name}</>}
        body={<>بأجرته المطلوبة <Money value={accepting?.amount} /> بدل أجر المعادلة. تُسحب عروض السائقين الآخرين.</>}
        confirmLabel="قبول وإسناد" loading={act.busy} onConfirm={() => accepting && void decide(accepting, "accept")} onCancel={() => setAccepting(null)} />
    </Section>
  );
}

/** طول المسار قبل الإسناد (م-18): به يظهر أجر المعادلة للسائقين فيقبلون الطلبية بأنفسهم. */
function RouteKm({ orderId, km, onSaved }: { orderId: number; km: string | null; onSaved: (v: OrderDetailOut) => void }) {
  const act = useAction();
  const [value, setValue] = useState(km ?? "");
  useEffect(() => setValue(km ?? ""), [km, orderId]);
  const ok = KM.test(value.trim());
  async function save() {
    const v = await act.run(() => api.put<OrderDetailOut>(`/api/admin/orders/${orderId}/route-km`, { route_km: value.trim() }),
      "حُفظ طول المسار؛ الطلبية ظاهرة للسائقين بأجرها");
    if (v) onSaved(v);
  }
  return (
    <Section title="طول المسار">
      <span className="text-13 text-ink-muted">
        {km == null ? "بلا طول مسار لا يظهر أجر المعادلة للسائقين ولا يقبلون الطلبية بأنفسهم." : "يُحسب به أجر المعادلة، ويظهر للسائقين المتاحين."}
      </span>
      <div className="flex gap-2 items-end">
        <TextField className="flex-1" label="الكيلومترات" value={value} onChange={setValue} numeric suffix="كم"
          error={value && !ok ? "رقم بخانتين عشريتين على الأكثر" : null} />
        <Button size="sm" loading={act.busy} disabled={!ok || value.trim() === (km ?? "")} onClick={save}>حفظ</Button>
      </div>
    </Section>
  );
}
