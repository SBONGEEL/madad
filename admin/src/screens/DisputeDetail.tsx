/** نزاع واحد: ما حدث، والبضاعة بعهدة السائق ومصيرها، وقرار المالك (الإجراء والمبلغ والرد وعلى من الخسارة — م-10). */
import { useEffect, useState } from "react";
import { Link, useParams } from "react-router-dom";

import { qs } from "@ui/client";
import * as fmt from "@ui/fmt";
import {
  Button, ConfirmDialog, DataTable, ErrorState, Kv, LoadingState, Money, Note, Num, Option, PageHead, Section, Select,
  StatusBadge, TextField, useAction, useLoad,
} from "@ui/kit";
import { api } from "@/api/client";
import type {
  CustodyOut, DisputeDetailOut, DriverChoiceOut, OrderDetailOut, OrderRowOut, SupplierRowOut, TxnOut, WarehouseOut,
} from "@/api/types";
import { CustodyBadge, DISPUTE_KIND, DisputeStatusBadge, LOSS, OPENED_BY, REFUND, RESOLUTION } from "@/lib/orders-shared";
import { useSession } from "@/session";

export function DisputeDetail() {
  const { disputeId } = useParams();
  const id = Number(disputeId);
  const { can } = useSession();
  const d = useLoad(() => api.get<DisputeDetailOut>(`/api/admin/disputes/${id}`), [id]);
  const custody = useLoad(() => api.get<CustodyOut[]>(`/api/admin/disputes/${id}/custody`), [id]);
  const orderId = d.data?.dispute.order_id ?? null;
  const order = useLoad(() => (orderId ? api.get<OrderDetailOut>(`/api/admin/orders/${orderId}`) : Promise.resolve(null)), [orderId]);
  const seesMoney = can("money");
  const ledger = useLoad(
    () => (orderId && seesMoney ? api.get<TxnOut[]>(`/api/admin/ledger/transactions${qs({ order_id: orderId, kind: "cancellation" })}`) : Promise.resolve(null)),
    [orderId, seesMoney]);
  const drivers = useLoad(() => api.get<DriverChoiceOut[]>(`/api/admin/drivers/available`));

  if (d.loading && !d.data) return <div className="md-page"><div className="md-sec"><LoadingState rows={4} /></div></div>;
  if (d.error && !d.data) return <div className="md-page"><div className="md-sec"><ErrorState compact title={d.error.message} code={d.error.code} onRetry={d.reload} /></div></div>;
  if (!d.data) return null;
  const x = d.data;
  const disp = x.dispute;
  const rows = custody.data ?? [];
  const openRows = rows.filter((r) => r.status === "open");
  const txns = ledger.data ?? [];
  const cancelled = txns.length > 0 || rows.length > 0;

  return (
    <div className="md-page">
      <PageHead
        title={<>نزاع: {DISPUTE_KIND[disp.kind] ?? disp.kind}{x.item ? ` — ${x.item}` : ""} — الطلبية <Num>#{disp.order_id}</Num></>}
        sub={<>فتحه {OPENED_BY[disp.opened_by_role] ?? disp.opened_by_role} ({disp.customer_name}) <Num>{fmt.dateTime(disp.created_at)}</Num>: «{disp.description}»{x.source ? ` المصدر: ${x.source}.` : ""}</>}
        actions={<>
          <Link to={`/orders?open=${disp.order_id}`} className="md-link text-14">الطلبية</Link>
          <DisputeStatusBadge status={disp.status} />
        </>} />

      {cancelled ? (
        <div className="grid grid-cols-3 gap-4 items-start">
          {seesMoney ? (
            <Section title="ما حدث في الدفتر عند الإلغاء">
              <DataTable<{ k: string; account: string; amount: string }>
                rows={txns.flatMap((t) => t.entries.map((e, i) => ({ k: `${t.id}-${i}`, account: e.account, amount: e.amount })))}
                loading={ledger.loading} error={ledger.error} onRetry={ledger.reload} rowKey={(r) => r.k}
                emptyIcon="scroll-text" emptyTitle="لا قيود إلغاء لهذه الطلبية"
                columns={[{ key: "account", label: "الحساب" }, { key: "amount", label: "المبلغ", money: true }]} />
            </Section>
          ) : null}
          <Section className={seesMoney ? "col-span-2" : "col-span-3"} title="بضاعة بعهدة السائق — قرّر مصيرها" right={<StatusBadge tone="warning">أمانة</StatusBadge>}>
            <DataTable<CustodyOut>
              rows={custody.data} loading={custody.loading} error={custody.error} onRetry={custody.reload}
              emptyIcon="package" emptyTitle="لا بضاعة بعهدة السائق" emptyBody="كل ما جُمع سُلِّم للمطعم قبل الإلغاء."
              rowKey={(r) => r.id} rowTone={(r) => r.status === "open" && "warning"}
              columns={[
                { key: "item", label: "الصنف" },
                { key: "qty", label: "الكمية", numeric: true, render: (r) => <Num>{fmt.qty(r.qty)}</Num> },
                ...(rows.some((r) => r.value !== undefined) ? [{ key: "value", label: "التكلفة", money: true, render: (r: CustodyOut) => (r.value != null ? <Money value={r.value} /> : "—") }] : []),
                { key: "source", label: "المصدر" },
                { key: "fate", label: "المصير", render: (r) => <CustodyBadge status={r.status} fate={r.fate} target={r.target} /> },
              ]} />
            {openRows.length ? (
              <div className="bg-warning-tint rounded-md py-2.5 px-3 text-13 leading-20">
                حتى تقرر: البضاعة أمانة بعهدة {openRows.map((r) => r.driver_name).filter((n, i, a) => a.indexOf(n) === i).join("، ")}، ولا تُقفل تسويته.
              </div>
            ) : null}
          </Section>
        </div>
      ) : null}

      <div className={openRows.length ? "grid grid-cols-2 gap-4 items-start" : "flex flex-col gap-4"}>
        {openRows.length ? <FateCard rows={openRows} onDone={custody.reload} /> : null}
        {disp.status === "resolved"
          ? <ResolvedCard x={x} />
          : <DecisionForm x={x} wide={!openRows.length} order={order.data} drivers={drivers.data ?? []} onDone={(v) => { d.set(v); custody.reload(); ledger.reload(); }} />}
      </div>
    </div>
  );
}

// ——— مصير الأمانة ————————————————————————————————————————————————————————————
export function FateCard({ rows, onDone }: { rows: CustodyOut[]; onDone: () => void }) {
  const { can } = useSession();
  const act = useAction();
  const [rowId, setRowId] = useState(rows[0]?.id ?? 0);
  const row = rows.find((r) => r.id === rowId) ?? rows[0];
  const [fate, setFate] = useState<"to_warehouse" | "return_supplier" | "to_order">("to_warehouse");
  const [wh, setWh] = useState("");
  const [target, setTarget] = useState("");
  const [confirm, setConfirm] = useState(false);
  const seesWh = can("warehouses");
  const whs = useLoad(() => (seesWh ? api.get<WarehouseOut[]>(`/api/admin/warehouses`) : Promise.resolve(null)), [seesWh]);
  const orders = useLoad(() => api.get<OrderRowOut[]>(`/api/admin/orders${qs({ status: "confirmed" })}`));
  const activeWh = (whs.data ?? []).filter((w) => w.active);

  useEffect(() => { if (!rows.some((r) => r.id === rowId) && rows[0]) setRowId(rows[0].id); }, [rows, rowId]);
  useEffect(() => { if (!wh && activeWh[0]) setWh(String(activeWh[0].id)); }, [activeWh, wh]);
  if (!row) return null;

  const ready = (fate === "return_supplier" && row?.source_kind === "supplier") || (fate === "to_warehouse" && !!wh) || (fate === "to_order" && !!target);

  async function decide() {
    if (!row) return;
    const body = {
      fate, target_warehouse_id: fate === "to_warehouse" ? Number(wh) : null, target_order_id: fate === "to_order" ? Number(target) : null,
    };
    const v = await act.run(() => api.post<CustodyOut[]>(`/api/admin/custody/${row.id}/decide`, body), "اعتُمد مصير البضاعة");
    if (v) { setConfirm(false); setTarget(""); onDone(); }
  }

  return (
    <Section title={`مصير «${row.item} — ${fmt.qty(row.qty)}»`}>
      {rows.length > 1 ? (
        <Select label="السطر" value={String(row.id)} onChange={(v) => setRowId(Number(v))}
          options={rows.map((r) => ({ value: String(r.id), label: `${r.item} — ${fmt.qty(r.qty)} · ${r.driver_name}` }))} />
      ) : null}
      <div role="radiogroup" className="flex flex-col gap-2">
        <Option selected={fate === "to_warehouse"} onSelect={() => setFate("to_warehouse")} label="تدخل مخزن مَدَد بتكلفتها"
          sub={<>تُقيَّد في المخزن المختار بتكلفتها{row.unit_cost != null ? <> <Num>{fmt.money(row.unit_cost)}</Num> للوحدة</> : null}، وتُرفع عن عهدة السائق.</>} />
        {fate === "to_warehouse" ? (
          <div className="ps-7">
            {!seesWh ? <span className="text-13 text-ink-muted">اختيار المخزن يحتاج صلاحية المخازن.</span>
              : whs.loading && !whs.data ? <LoadingState rows={1} />
              : activeWh.length ? <Select label="المخزن" value={wh} onChange={setWh} options={activeWh.map((w) => ({ value: String(w.id), label: w.name }))} />
              : <span className="text-13 text-ink-muted">لا مخازن نشطة.</span>}
          </div>
        ) : null}
        {row.source_kind === "supplier" ? (
          <Option selected={fate === "return_supplier"} onSelect={() => setFate("return_supplier")} label="تُعاد للمورد"
            sub={`يُعكس مستحق ${row.source} عن هذه الكمية بقيد في الدفتر.`} />
        ) : null}
        <Option selected={fate === "to_order"} onSelect={() => setFate("to_order")} label="تُسلَّم لطلبية أخرى قائمة"
          sub={`تحلّ محل الكمية نفسها في مخطط طلبية مؤكَّدة تحتاج الصنف. يستلمها سائقها من ${row.driver_name}.`} />
        {fate === "to_order" ? (
          <div className="ps-7">
            {orders.loading && !orders.data ? <LoadingState rows={1} />
              : (orders.data ?? []).filter((o) => o.id !== row.order_id).length ? (
                <Select label="الطلبية" value={target} onChange={setTarget}
                  options={[{ value: "", label: "اختر طلبية مؤكَّدة" }, ...(orders.data ?? []).filter((o) => o.id !== row.order_id)
                    .map((o) => ({ value: String(o.id), label: `#${o.id} — ${o.customer_name}` }))]} />
              ) : <span className="text-13 text-ink-muted">لا طلبيات مؤكَّدة لم تُسند بعد.</span>}
          </div>
        ) : null}
      </div>
      <div className="flex gap-2"><Button icon="check" disabled={!ready} onClick={() => setConfirm(true)}>اعتماد المصير</Button></div>

      <ConfirmDialog open={confirm} title="اعتماد مصير البضاعة؟"
        body={<>{row.item} — <Num>{fmt.qty(row.qty)}</Num>{row.value != null ? <> بقيمة <Money value={row.value} /></> : null}. المصير يُكتب مرة واحدة وتُسجَّل قيوده في الدفتر.</>}
        confirmLabel="اعتماد" loading={act.busy} onConfirm={decide} onCancel={() => setConfirm(false)} />
    </Section>
  );
}

// ——— القرار ————————————————————————————————————————————————————————————————
function ResolvedCard({ x }: { x: DisputeDetailOut }) {
  return (
    <Section title="القرار" right={<StatusBadge tone="success">مُقرَّر</StatusBadge>}>
      <Kv k="الإجراء" v={x.resolution ? RESOLUTION[x.resolution] ?? x.resolution : "—"} />
      <Kv k="المبلغ للعميل" v={x.resolution_amount != null ? <Money value={x.resolution_amount} /> : "—"} />
      <Kv k="كيف يُرد للعميل" v={x.refund_method ? REFUND[x.refund_method] ?? x.refund_method : "—"} />
      <Kv k="على من الخسارة" v={x.loss_bearer ? LOSS[x.loss_bearer] ?? x.loss_bearer : "—"} />
    </Section>
  );
}

type Resolution = "partial_discount" | "return" | "cancel" | "no_action";
type Refund = "credit_next_order" | "cash_via_driver";
type Bearer = "supplier" | "madad" | "driver";

function DecisionForm({ x, wide, order, drivers, onDone }: {
  x: DisputeDetailOut; wide: boolean; order: OrderDetailOut | null; drivers: DriverChoiceOut[]; onDone: (v: DisputeDetailOut) => void;
}) {
  const { can, refreshCounts } = useSession();
  const act = useAction();
  const seesSuppliers = can("catalog");
  const suppliers = useLoad(() => (seesSuppliers ? api.get<SupplierRowOut[]>(`/api/admin/suppliers${qs({ status: "approved" })}`) : Promise.resolve(null)), [seesSuppliers]);
  const [res, setRes] = useState<Resolution | null>(null);
  const [amount, setAmount] = useState("");
  const [refund, setRefund] = useState<Refund>("credit_next_order");
  const [refundDriver, setRefundDriver] = useState("");
  const [bearer, setBearer] = useState<Bearer>("supplier");
  const [lossSupplier, setLossSupplier] = useState("");
  const [lossDriver, setLossDriver] = useState("");
  const [note, setNote] = useState("");
  const [confirm, setConfirm] = useState(false);

  const orderDriver = drivers.find((d) => d.id === (x.driver_id ?? order?.driver_id));
  useEffect(() => {
    if (orderDriver) { setRefundDriver((v) => v || String(orderDriver.id)); setLossDriver((v) => v || String(orderDriver.id)); }
  }, [orderDriver]);
  useEffect(() => {
    if (x.supplier_id != null) setLossSupplier((v) => v || String(x.supplier_id));
  }, [x.supplier_id]);

  const money = res !== null && res !== "no_action";
  const a = money && fmt.isMoney(amount) ? Number(amount) : 0;
  const refundD = drivers.find((d) => String(d.id) === refundDriver);
  const lossS = suppliers.data?.find((s) => String(s.id) === lossSupplier);
  const lossD = drivers.find((d) => String(d.id) === lossDriver);
  const cashShort = money && refund === "cash_via_driver" && refundD && a > Number(refundD.cash_held);
  const amountErr = money && amount && !fmt.isMoney(amount) ? "مبلغ غير صحيح" : null;
  const partyMissing = a > 0 && ((refund === "cash_via_driver" && !refundD) || (bearer === "supplier" && !lossS) || (bearer === "driver" && !lossD));
  const ready = res !== null && (!money || (fmt.isMoney(amount) && !partyMissing && !cashShort));

  const cust = `ذمة ${x.dispute.customer_name}`;
  const led: Array<{ a: string; dr: number; cr: number }> = a > 0 ? [
    { a: "خصومات النزاعات", dr: a, cr: 0 }, { a: `${cust} (رصيد له)`, dr: 0, cr: a },
    ...(refund === "cash_via_driver" ? [{ a: cust, dr: a, cr: 0 }, { a: `كاش ${refundD?.full_name ?? "السائق"}`, dr: 0, cr: a }] : []),
    ...(bearer === "supplier" ? [{ a: `مستحقات ${lossS?.name ?? "المورد"}`, dr: a, cr: 0 }, { a: "خصومات النزاعات", dr: 0, cr: a }] : []),
    ...(bearer === "driver" ? [{ a: `محفظة ${lossD?.full_name ?? "السائق"}`, dr: a, cr: 0 }, { a: "خصومات النزاعات", dr: 0, cr: a }] : []),
  ] : [];

  async function resolve() {
    if (!res) return;
    const body = {
      resolution: res,
      resolution_amount: money ? amount.trim() : null,
      refund_method: a > 0 ? refund : null,
      refund_driver_id: a > 0 && refund === "cash_via_driver" ? Number(refundDriver) : null,
      loss_bearer: a > 0 ? bearer : null,
      loss_supplier_id: a > 0 && bearer === "supplier" ? Number(lossSupplier) : null,
      loss_driver_id: a > 0 && bearer === "driver" ? Number(lossDriver) : null,
      note: note.trim() || null,
    };
    const v = await act.run(() => api.post<DisputeDetailOut>(`/api/admin/disputes/${x.dispute.id}/resolve`, body), "اعتُمد القرار");
    if (v) { setConfirm(false); refreshCounts(); onDone(v); }
  }

  const kinds = (
    <div className="flex flex-col gap-2">
      <span className="text-14 font-bold">القرار</span>
      <div role="radiogroup" className="grid grid-cols-2 gap-2">
        {(Object.keys(RESOLUTION) as Resolution[]).map((k) => <Option key={k} label={RESOLUTION[k]} selected={res === k} onSelect={() => setRes(k)} />)}
      </div>
      {money ? (
        <TextField label="المبلغ للعميل" value={amount} onChange={setAmount} numeric suffix="د.ل" error={amountErr}
          hint={x.item_total != null ? `قيمة الصنف في الطلبية ${fmt.money(x.item_total)} د.ل` : undefined} />
      ) : null}
      <TextField label="ملاحظة" value={note} onChange={setNote} multiline />
    </div>
  );

  const parties = a > 0 ? (
    <div className="flex flex-col gap-2">
      <span className="text-14 font-bold">كيف يُرد للعميل</span>
      <div role="radiogroup" className="flex flex-col gap-2">
        {(Object.keys(REFUND) as Refund[]).map((k) => <Option key={k} label={REFUND[k]} selected={refund === k} onSelect={() => setRefund(k)} />)}
      </div>
      {refund === "cash_via_driver" ? (
        <Select label="السائق" value={refundDriver} onChange={setRefundDriver}
          options={[{ value: "", label: "اختر السائق" }, ...drivers.map((d) => ({ value: String(d.id), label: `${d.full_name} — بحوزته ${fmt.money(d.cash_held)} د.ل` }))]} />
      ) : null}
      <span className="text-14 font-bold mt-1.5">على من الخسارة</span>
      <div role="radiogroup" className="flex flex-col gap-2">
        <Option selected={bearer === "supplier"} onSelect={() => setBearer("supplier")} label={`المورد${lossS ? ` — ${lossS.name}` : x.source ? ` — ${x.source}` : ""} (يُخصم من مستحقاته)`} />
        <Option selected={bearer === "madad"} onSelect={() => setBearer("madad")} label="مَدَد" />
        <Option selected={bearer === "driver"} onSelect={() => setBearer("driver")} label="السائق (يُخصم من محفظته)" />
      </div>
      {bearer === "supplier" ? (
        seesSuppliers ? (
          <Select label="المورد" value={lossSupplier} onChange={setLossSupplier}
            options={[{ value: "", label: "اختر المورد" }, ...(suppliers.data ?? []).map((s) => ({ value: String(s.id), label: s.name }))]} />
        ) : <span className="text-13 text-ink-muted">تحميل الخسارة على المورد يحتاج صلاحية الكتالوج لاختياره.</span>
      ) : null}
      {bearer === "driver" ? (
        <Select label="السائق" value={lossDriver} onChange={setLossDriver}
          options={[{ value: "", label: "اختر السائق" }, ...drivers.map((d) => ({ value: String(d.id), label: d.full_name }))]} />
      ) : null}
    </div>
  ) : null;

  return (
    <Section title={wide ? "القرار في النزاع" : "المسترد للمطعم (M-10)"} right={<StatusBadge tone="error">مفتوح</StatusBadge>}>
      <div className={wide ? "grid grid-cols-2 gap-4 items-start" : "flex flex-col gap-4"}>
        {kinds}
        {parties}
      </div>
      {cashShort && refundD ? (
        <ErrorState compact title="الكاش مع السائق لا يكفي للرد"
          body={`بحوزة ${refundD.full_name} ${fmt.money(refundD.cash_held)} د.ل والرد ${fmt.money(a)}. اختر سائقاً آخر أو رصيداً للطلبية القادمة.`}
          code="refund_exceeds_driver_cash" />
      ) : null}
      {led.length ? (
        <div className="bg-page rounded-md p-3 flex flex-col gap-1.5">
          <span className="text-13 font-bold">القيود التي ستُسجَّل في الدفتر</span>
          <DataTable<{ a: string; dr: number; cr: number }>
            rows={led}
            columns={[
              { key: "a", label: "الحساب" },
              { key: "dr", label: "مدين", money: true, render: (r) => (r.dr ? <Money value={r.dr} /> : "—") },
              { key: "cr", label: "دائن", money: true, render: (r) => (r.cr ? <Money value={r.cr} /> : "—") },
            ]} />
        </div>
      ) : res === "no_action" ? <Note tone="info">لا إجراء: يُغلق النزاع دون أي قيد في الدفتر.</Note> : null}
      <div className="flex gap-2"><Button icon="check" disabled={!ready} onClick={() => setConfirm(true)}>اعتماد القرار</Button></div>

      <ConfirmDialog open={confirm} title="اعتماد القرار؟"
        body={<>{res ? RESOLUTION[res] : ""}{a > 0 ? <> — <Money value={a} /> للعميل، {REFUND[refund]}، والخسارة على {LOSS[bearer]}</> : null}. القرار نهائي وتُكتب قيوده في الدفتر.</>}
        confirmLabel="اعتماد القرار" loading={act.busy} onConfirm={resolve} onCancel={() => setConfirm(false)} />
    </Section>
  );
}

