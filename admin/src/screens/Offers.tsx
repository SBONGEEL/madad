/** الموردون والعروض: قائمة الموردين وتفصيل كل مورد، وكل العروض، ومقارنة موردي صنف القاموس وربط العرض بصنف كتالوج،
 *  واقتراحات الموردين. سعر الشراء تكلفة: لا يظهر بلا «التكاليف». */
import { useEffect, useState } from "react";

import * as fmt from "@ui/fmt";
import { qs } from "@ui/client";
import { Button, ConfirmDialog, DataTable, Dialog, EmptyState, Kv, Loader, Money, Num, PageHead, Section, Select, StatCard,
  StatusBadge, TextField, useAction, useLoad, type Column } from "@ui/kit";
import { api } from "@/api/client";
import type { CatalogRowOut, CompareOut, ItemPricingOut, OfferOut, ProposalOut, SupplierDetailOut, SupplierRowOut } from "@/api/types";
import { CYCLE, OfferBadge, PartyBadge, unitLabel } from "@/lib/commerce-shared";
import { ProductPicker } from "@/lib/commerce-product";
import { useSession } from "@/session";

type OfferRow = OfferOut & { supplier: string; supplier_id: number };

const STATUS_OPTIONS = [
  { value: "", label: "كل الموردين" }, { value: "approved", label: "معتمدون" }, { value: "pending", label: "بانتظار الاعتماد" },
  { value: "suspended", label: "موقوفون" }, { value: "rejected", label: "مرفوضون" },
];

export function Offers() {
  const { refreshCounts } = useSession();
  const [search, setSearch] = useState("");
  const [status, setStatus] = useState("");
  const [open, setOpen] = useState<number | null>(null);
  const [product, setProduct] = useState<{ id: number; name: string } | null>(null);
  const [linking, setLinking] = useState<CompareOut | null>(null);
  const [rejecting, setRejecting] = useState<ProposalOut | null>(null);

  const sups = useLoad(() => api.get<SupplierRowOut[]>(`/api/admin/suppliers${qs({ status })}`), [status]);
  const ids = (sups.data ?? []).map((s) => s.id).join(",");
  const details = useLoad(() => Promise.all((sups.data ?? []).map((s) => api.get<SupplierDetailOut>(`/api/admin/suppliers/${s.id}`))), [ids]);
  const cmp = useLoad(() => (product ? api.get<CompareOut[]>(`/api/admin/products/${product.id}/offers`) : Promise.resolve(null)), [product?.id]);
  const props = useLoad(() => api.get<ProposalOut[]>(`/api/admin/proposals`));
  const act = useAction();

  const term = search.trim();
  const has = (s: string) => !term || s.includes(term);
  const offers: OfferRow[] = (details.data ?? []).flatMap((d) => d.offers.map((o) => ({ ...o, supplier: d.supplier.name, supplier_id: d.supplier.id })));
  const shownOffers = offers.filter((o) => has(o.product) || has(o.supplier));
  const shownSups = (sups.data ?? []).filter((s) => has(s.name) || has(s.contact_name) || offers.some((o) => o.supplier_id === s.id && has(o.product)));
  const seesCosts = offers.some((o) => o.purchase_price !== undefined);

  const multi = new Map<string, Set<number>>();
  offers.forEach((o) => {
    const k = `${o.product}|${o.unit}|${o.unit_size}`;
    multi.set(k, (multi.get(k) ?? new Set()).add(o.supplier_id));
  });
  const multiCount = [...multi.values()].filter((s) => s.size > 1).length;
  const active = offers.filter((o) => o.status === "active").length;

  async function decide(pr: ProposalOut, decision: "approve" | "reject") {
    const list = await act.run(() => api.post<ProposalOut[]>(`/api/admin/proposals/${pr.id}`, { decision }),
      decision === "approve" ? "اعتُمد الصنف في القاموس" : "رُفض الاقتراح");
    if (list) {
      props.set(list);
      setRejecting(null);
      refreshCounts();
    }
  }

  const offerCols: Array<Column<OfferRow>> = [
    { key: "product", label: "الصنف" },
    { key: "unit", label: "الوحدة", render: (o) => unitLabel(o.unit, o.unit_size) },
    { key: "supplier", label: "المورد" },
    { key: "location", label: "موقع الاستلام" },
    ...(seesCosts ? [{ key: "purchase_price", label: "سعر الشراء", money: true, render: (o: OfferRow) => (o.purchase_price != null ? <Money value={o.purchase_price} /> : "—") }] : []),
    { key: "available_qty", label: "المتاح", numeric: true, render: (o) => <Num>{fmt.qty(o.available_qty)}</Num> },
    { key: "status", label: "الحالة", render: (o) => <OfferBadge status={o.status} /> },
  ];

  return (
    <div className="md-page">
      <PageHead title="الموردون والعروض" actions={<>
        <TextField className="w-field-md" value={search} onChange={setSearch} placeholder="ابحث باسم الصنف أو المورد" icon="search" />
        <div className="w-field-sm"><Select value={status} onChange={setStatus} options={STATUS_OPTIONS} /></div>
      </>} />

      <div className="grid grid-cols-4 gap-4">
        <StatCard label="عروض نشطة" value={fmt.int(active)} icon="package" />
        <StatCard label="أصناف لها أكثر من مورد" value={fmt.int(multiCount)} icon="scale" />
        <StatCard label="الموردون" value={fmt.int(sups.data?.length)} icon="store" />
        <StatCard label="عروض موقوفة" value={fmt.int(offers.length - active)} icon="inbox" />
      </div>

      <section className="flex flex-col gap-2.5">
        <h2 className="md-sec-title-lg">الموردون</h2>
        <DataTable<SupplierRowOut> rows={sups.data ? shownSups : null} loading={sups.loading} error={sups.error} onRetry={sups.reload}
          rowKey={(s) => s.id} onRowClick={(s) => setOpen(s.id)}
          emptyIcon="store" emptyTitle={term || status ? "لا موردين يطابقون البحث" : "لا موردين بعد"}
          emptyBody={term || status ? "جرّب اسماً آخر، أو أزل التصفية." : "المورد الذي يسجّل ويُعتمد يظهر هنا مع عروضه."}
          columns={[
            { key: "name", label: "المورد", render: (s) => <b>{s.name}</b> },
            { key: "contact_name", label: "المسؤول" },
            { key: "phone", label: "الهاتف", render: (s) => <Num>{fmt.phoneLocal(s.phone)}</Num> },
            { key: "payout_cycle", label: "دورية الصرف", render: (s) => (s.payout_cycle ? CYCLE[s.payout_cycle] ?? s.payout_cycle : "—") },
            { key: "offers", label: "العروض", numeric: true },
            { key: "status", label: "الحالة", render: (s) => <PartyBadge status={s.status} /> },
          ]} />
      </section>

      <Section large title={product ? `مقارنة موردي الصنف: ${product.name}` : "مقارنة موردي الصنف"}
        right={
          <div className="flex gap-2 items-end">
            <div className="w-field-md"><ProductPicker value={null} placeholder="ابحث باسم الصنف للمقارنة" onPick={(p) => p && setProduct({ id: p.id, name: p.name_ar })} /></div>
          </div>
        }>
        <span className="text-13 text-ink-muted">مجمّعة على الصنف في القاموس. الأولوية تحدد من أين يُشترى أولاً.</span>
        {product ? (
          <DataTable<CompareOut> rows={cmp.data} loading={cmp.loading} error={cmp.error} onRetry={cmp.reload} rowKey={(c) => c.offer_id}
            emptyIcon="package" emptyTitle="لا عروض لهذا الصنف" emptyBody="لا مورد معتمداً يعرضه الآن."
            columns={[
              { key: "supplier_name", label: "المورد" },
              { key: "unit", label: "الوحدة", render: (c) => unitLabel(c.unit, c.unit_size) },
              ...(seesCosts || cmp.data?.some((c) => c.purchase_price !== undefined)
                ? [{ key: "purchase_price", label: "سعر الشراء", money: true, render: (c: CompareOut) => (c.purchase_price != null ? <Money value={c.purchase_price} /> : "—") }] : []),
              { key: "available_qty", label: "المتاح", numeric: true, render: (c) => <Num>{fmt.qty(c.available_qty)}</Num> },
              { key: "in_catalog", label: "في الكتالوج", render: (c) => (c.in_catalog ? <StatusBadge tone="success">مربوط</StatusBadge> : <StatusBadge tone="warning">غير مربوط</StatusBadge>) },
              { key: "x", label: "", render: (c) => <Button size="sm" variant="ghost" icon="pencil" onClick={() => setLinking(c)}>ربط وترتيب</Button> },
            ]} />
        ) : <EmptyState compact icon="scale" title="اختر صنفاً للمقارنة" body="ابحث باسم الصنف، أو افتح المقارنة من اقتراح مورد." />}
      </Section>

      <section className="flex flex-col gap-2.5">
        <h2 className="md-sec-title-lg">كل العروض</h2>
        <DataTable<OfferRow> rows={details.data ? shownOffers : null} loading={details.loading || sups.loading} rowKey={(o) => o.id}
          error={details.error ? { code: details.error.code, message: "تعذّر تحميل العروض" } : null} onRetry={details.reload}
          columns={offerCols} rowTone={(o) => o.status !== "active" && "warning"}
          emptyIcon="package" emptyTitle={term ? "لا عروض تطابق البحث" : "لا عروض بعد"}
          emptyBody={term ? "جرّب اسماً آخر للصنف، أو أزل التصفية." : undefined} />
      </section>

      <Section title="اقتراحات الموردين" right={props.data?.length ? <StatusBadge tone="warning">{props.data.length} بانتظارك</StatusBadge> : null}>
        <span className="text-13 text-ink-muted">لا يظهر صنف مقترح في القاموس ولا يُعرض قبل اعتمادك (§2.1).</span>
        <Loader state={props}>
          {(list) => list.length ? (
            <DataTable<ProposalOut> rows={list} rowKey={(p) => p.id}
              columns={[
                { key: "name_ar", label: "الصنف المقترح", render: (p) => <b>{p.name_ar}</b> },
                { key: "supplier_name", label: "المورد" },
                { key: "category", label: "التصنيف" },
                { key: "similar", label: "يشبه في القاموس", render: (p) => (p.similar.length ? p.similar.slice(0, 3).join("، ") : "—") },
                { key: "x", label: "", render: (p) => (
                  <div className="flex gap-1.5">
                    <Button size="sm" icon="check" disabled={act.busy} onClick={() => decide(p, "approve")}>اعتماد</Button>
                    <Button size="sm" variant="ghost" disabled={act.busy} onClick={() => setRejecting(p)}>رفض</Button>
                    <Button size="sm" variant="secondary" icon="scale" onClick={() => { setProduct({ id: p.id, name: p.name_ar }); }}>مقارنة</Button>
                  </div>
                ) },
              ]} />
          ) : <EmptyState compact icon="inbox" title="لا اقتراحات تنتظرك" body="ما يقترحه المورد من أصناف جديدة يظهر هنا لتعتمده." />}
        </Loader>
      </Section>

      <SupplierDialog id={open} onClose={() => setOpen(null)} />
      <LinkDialog offer={linking} onClose={() => setLinking(null)} onLinked={() => { setLinking(null); cmp.reload(); }} />
      <ConfirmDialog open={!!rejecting} tone="error" title={`رفض «${rejecting?.name_ar ?? ""}»؟`}
        body="لا يظهر الصنف في القاموس ولا يُعرض، ولا يبيعه المورد." confirmLabel="رفض" loading={act.busy}
        onCancel={() => setRejecting(null)} onConfirm={() => rejecting && decide(rejecting, "reject")} />
    </div>
  );
}

function SupplierDialog({ id, onClose }: { id: number | null; onClose: () => void }) {
  const d = useLoad(() => (id ? api.get<SupplierDetailOut>(`/api/admin/suppliers/${id}`) : Promise.resolve(null)), [id]);
  return (
    <Dialog open={id != null} onClose={onClose} wide label="تفاصيل المورد">
      <Loader state={d} rows={4}>
        {(x) => x && (
          <div className="flex flex-col gap-4">
            <div className="flex justify-between items-start gap-3">
              <div className="flex flex-col gap-1">
                <div className="md-dialog-title">{x.supplier.name}</div>
                <span className="text-14 text-ink-muted">{x.supplier.contact_name} · <Num>{fmt.phoneLocal(x.supplier.phone)}</Num></span>
              </div>
              <PartyBadge status={x.supplier.status} />
            </div>
            <div className="grid grid-cols-2 gap-x-6 gap-y-2">
              <Kv k="دورية صرف المستحقات" v={x.supplier.payout_cycle ? CYCLE[x.supplier.payout_cycle] ?? x.supplier.payout_cycle : "—"} />
              <Kv k="العروض" v={<Num>{x.supplier.offers}</Num>} />
            </div>
            <DataTable<OfferOut> rows={x.offers} rowKey={(o) => o.id} emptyIcon="package" emptyTitle="لا عروض لهذا المورد"
              columns={[
                { key: "product", label: "الصنف" },
                { key: "unit", label: "الوحدة", render: (o) => unitLabel(o.unit, o.unit_size) },
                { key: "location", label: "موقع الاستلام" },
                ...(x.offers.some((o) => o.purchase_price !== undefined)
                  ? [{ key: "purchase_price", label: "سعر الشراء", money: true, render: (o: OfferOut) => (o.purchase_price != null ? <Money value={o.purchase_price} /> : "—") }] : []),
                { key: "available_qty", label: "المتاح", numeric: true, render: (o) => <Num>{fmt.qty(o.available_qty)}</Num> },
                { key: "status", label: "الحالة", render: (o) => <OfferBadge status={o.status} /> },
              ]} />
            <div className="md-dialog-actions"><Button variant="ghost" block onClick={onClose}>إغلاق</Button></div>
          </div>
        )}
      </Loader>
    </Dialog>
  );
}

/** ربط عرض بصنف كتالوج بأولوية: العرض يجب أن يطابق منتج الصنف ووحدته (تفرضه القاعدة). */
function LinkDialog({ offer, onClose, onLinked }: { offer: CompareOut | null; onClose: () => void; onLinked: () => void }) {
  const act = useAction();
  const [typed, setTyped] = useState("");
  const [q, setQ] = useState("");
  const [item, setItem] = useState("");
  const [prio, setPrio] = useState("1");
  useEffect(() => {
    const t = setTimeout(() => setQ(typed.trim()), 350);
    return () => clearTimeout(t);
  }, [typed]);
  const items = useLoad(() => (offer ? api.get<CatalogRowOut[]>(`/api/admin/catalog${qs({ q })}`) : Promise.resolve(null)), [offer?.offer_id, q]);
  const sameUnit = (items.data ?? []).filter((c) => !offer || (c.unit === offer.unit && Number(c.unit_size) === Number(offer.unit_size)));

  async function submit() {
    if (!offer) return;
    const r = await act.run(() => api.post<ItemPricingOut>(`/api/admin/catalog/${item}/sources`, { offer_id: offer.offer_id, priority: Number(prio) }),
      "رُبط العرض بصنف الكتالوج");
    if (r) {
      setItem(""); setTyped("");
      onLinked();
    }
  }

  return (
    <Dialog open={!!offer} onClose={onClose} label="ربط وترتيب">
      <div className="md-dialog-title">ربط عرض {offer?.supplier_name ?? ""} بصنف كتالوج</div>
      <div className="md-dialog-body">{offer ? unitLabel(offer.unit, offer.unit_size) : ""} — لا يُربط العرض إلا بصنف من المنتج نفسه وبالوحدة نفسها.</div>
      <div className="flex flex-col gap-3">
        <TextField value={typed} onChange={setTyped} placeholder="ابحث في الكتالوج" icon="search" />
        <Select label="صنف الكتالوج" value={item} onChange={setItem}
          options={[{ value: "", label: items.loading ? "جاري التحميل…" : sameUnit.length ? "اختر الصنف" : "لا أصناف بهذه الوحدة" },
            ...sameUnit.map((c) => ({ value: String(c.id), label: `${c.name_ar} — ${unitLabel(c.unit, c.unit_size)}` }))]} />
        <TextField label="الأولوية" value={prio} onChange={setPrio} numeric hint="1 يُشترى منه أولاً." />
      </div>
      <div className="md-dialog-actions">
        <Button block icon="check" loading={act.busy} disabled={!item || !/^[1-9]\d*$/.test(prio.trim())} onClick={submit}>ربط</Button>
        <Button variant="ghost" block onClick={onClose}>إلغاء</Button>
      </div>
    </Dialog>
  );
}
