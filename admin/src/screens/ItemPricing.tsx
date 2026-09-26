/** تسعير الصنف: طريقة التسعير، واستثناء الصنف من إعداد «حين يغيّر المورد سعره» (م-6)، وأساس التكلفة (م-6 تتمة)،
 *  والمصادر بأولويتها، وسجل الأسعار شراءً وبيعاً. التكاليف تظهر وتُكتب لمن يملك «التكاليف» فقط. */
import { useEffect, useState } from "react";
import { Link, useParams } from "react-router-dom";

import * as fmt from "@ui/fmt";
import { qs } from "@ui/client";
import { Button, ConfirmDialog, DataTable, Dialog, ErrorState, Icon, LoadingState, Money, Note, Num, OptionGroup, PageHead,
  Section, Select, StatusBadge, TextField, useAction, useLoad } from "@ui/kit";
import { api } from "@/api/client";
import type { CatalogRowOut, ItemPricingOut, PriceChangeOut, PricingIn, SettingsOut, SourceOut, SupplierDetailOut, SupplierRowOut } from "@/api/types";
import { CatalogStatus, OfferBadge, priceByMargin, UNIT, unitLabel } from "@/lib/commerce-shared";
import { useSession } from "@/session";

const BASIS: Record<string, string> = { max_source: "أعلى سعر بين كل الموردين", first_priority: "المورد الأول في الأولوية" };
type Tri = "project" | "on" | "off";

export function ItemPricing() {
  const { itemId } = useParams<{ itemId: string }>();
  const id = Number(itemId);
  const { can, refreshCounts } = useSession();
  const d = useLoad(() => api.get<ItemPricingOut>(`/api/admin/catalog/${id}`), [id]);
  const settings = useLoad(() => (can("settings") ? api.get<SettingsOut>(`/api/admin/settings`) : Promise.resolve(null)), []);
  const act = useAction();

  const [mode, setMode] = useState("margin_pct");
  const [margin, setMargin] = useState("");
  const [manual, setManual] = useState("");
  const [reprice, setReprice] = useState<Tri>("project");
  const [basis, setBasis] = useState("project");
  const [keeping, setKeeping] = useState(false);
  const [removing, setRemoving] = useState<SourceOut | null>(null);
  const [adding, setAdding] = useState(false);

  useEffect(() => {
    const p = d.data;
    if (!p) return;
    setMode(p.mode ?? "margin_pct");
    setMargin(p.margin_value != null ? fmt.qty(p.margin_value) : "");
    setManual(p.manual_price ?? p.item.sale_price ?? "");
    setReprice(p.reprice_override == null ? "project" : p.reprice_override ? "on" : "off");
    setBasis(p.cost_basis_override ?? "project");
  }, [d.data]);

  if (d.loading && !d.data) return <div className="md-page"><LoadingState rows={5} /></div>;
  if (!d.data) {
    return (
      <div className="md-page">
        <ErrorState title={d.error?.code === "item_not_found" ? "الصنف غير موجود" : d.error?.message} code={d.error?.code} onRetry={d.reload} />
      </div>
    );
  }

  const p = d.data;
  const item = p.item;
  const seesCosts = can("costs_view") && p.mode !== undefined;
  const unitWord = UNIT[item.unit] ?? item.unit;
  const first = p.sources_detail[0];
  const prices = p.sources_detail.map((s) => s.purchase_price).filter((x): x is string => x != null);
  const maxBuy = prices.length ? prices.reduce((m, x) => (Number(x) > Number(m) ? x : m)) : null;
  const marginOk = /^\d+(\.\d{1,2})?$/.test(margin.trim());
  const next = mode !== "manual" && marginOk ? priceByMargin(mode, first?.purchase_price, margin) : null;
  const lastBuy = p.history.find((h) => h.kind === "purchase");
  const valid = mode === "manual" ? fmt.isMoney(manual) : marginOk && !!first;

  const pricing = (): PricingIn => ({
    mode, margin_value: mode === "manual" ? null : margin.trim(), manual_price: mode === "manual" ? manual.trim() : null,
    reprice_override: reprice === "project" ? null : reprice === "on", cost_basis_override: basis === "project" ? null : basis,
  });

  async function save(body: PricingIn) {
    const out = await act.run(() => api.put<ItemPricingOut>(`/api/admin/catalog/${id}/pricing`, body), "حُفظ التسعير");
    if (out) {
      d.set(out);
      setKeeping(false);
      refreshCounts();
    }
  }

  async function toggleVisible() {
    const v = item.visibility === "visible" ? "hidden" : "visible";
    const out = await act.run(() => api.patch<CatalogRowOut>(`/api/admin/catalog/${id}`, { visibility: v }),
      v === "visible" ? "الصنف ظاهر للعملاء" : "أُخفي الصنف");
    if (out) d.set({ ...p, item: { ...item, ...out } });
  }

  async function removeSource() {
    if (!removing) return;
    const ok = await act.run(() => api.del<void>(`/api/admin/catalog/${id}/sources/${removing.offer_id}`).then(() => true), "أُزيل المصدر");
    if (ok) {
      setRemoving(null);
      d.reload();
    }
  }

  const projReprice = settings.data ? (settings.data.reprice_on_cost_change ? "تلقائي — يُعاد حسابه بالهامش." : "يدوي — يُعلَّم للمراجعة.") : null;
  const projBasis = settings.data ? BASIS[settings.data.cost_guard_basis] ?? settings.data.cost_guard_basis : null;

  return (
    <div className="md-page">
      <PageHead title={<>تسعير الصنف — {item.name_ar} · {unitLabel(item.unit, item.unit_size)}</>}
        sub={<><Link to="/catalog" className="md-link">الكتالوج</Link> ← {item.category}</>}
        actions={<>
          <CatalogStatus row={item} />
          <Button variant="secondary" size="sm" icon={item.visibility === "visible" ? "eye-off" : "eye"} disabled={act.busy} onClick={toggleVisible}>
            {item.visibility === "visible" ? "إخفاء عن العملاء" : "إظهار للعملاء"}
          </Button>
          {seesCosts ? <Button icon="check" loading={act.busy} disabled={!valid} onClick={() => save(pricing())}>حفظ</Button> : null}
        </>} />

      {item.needs_review && lastBuy && lastBuy.purchase_new != null ? (
        <Note tone="warning">
          <b>سعر المورد تغيّر:</b> {lastBuy.label.replace(/^شراء — /, "")} {Number(lastBuy.purchase_new) > Number(lastBuy.purchase_old ?? 0) ? "رفع" : "غيّر"} سعر
          الشراء من <Num>{fmt.money(lastBuy.purchase_old)}</Num> إلى <Num>{fmt.money(lastBuy.purchase_new)}</Num> (<Num>{fmt.dateTime(lastBuy.at)}</Num>).
          سعر المطعم باقٍ <Num>{fmt.money(item.sale_price)}</Num> حتى تعتمد.
        </Note>
      ) : item.needs_review ? <Note tone="warning"><b>سعر المورد تغيّر:</b> سعر المطعم باقٍ <Num>{fmt.money(item.sale_price)}</Num> حتى تعتمد.</Note> : null}

      {item.below_cost ? (
        <Note tone="error">
          <b>أُوقف الصنف:</b> سعر البيع <Num>{fmt.money(item.sale_price)}</Num>{p.mode === "manual" ? " (يدوي)" : ""} صار تحت
          التكلفة{p.cost_ref != null ? <> <Num>{fmt.money(p.cost_ref)}</Num></> : null}. لا يراه المطعم ولا يُطلب حتى ترفع السعر أو تغيّر المصدر.
        </Note>
      ) : null}

      {seesCosts ? (
        <div className="grid grid-cols-3 gap-4 items-start">
          <Section title="طريقة التسعير">
            <OptionGroup columns={3} value={mode} onChange={setMode}
              options={[{ value: "margin_pct", label: "هامش %" }, { value: "margin_amount", label: "هامش مبلغ" }, { value: "manual", label: "سعر يدوي" }]} />
            {mode === "manual" ? (
              <TextField label="سعر البيع" value={manual} onChange={setManual} numeric suffix="د.ل"
                error={manual && !fmt.isMoney(manual) ? "مبلغ بثلاث خانات على الأكثر" : null} />
            ) : (
              <>
                <TextField label="الهامش" value={margin} onChange={setMargin} numeric suffix={mode === "margin_pct" ? "%" : "د.ل"}
                  error={margin && !marginOk ? "رقم بخانتين عشريتين على الأكثر" : null} />
                {first ? (
                  <div className="flex justify-between text-15"><span>السعر بالهامش على السعر الجديد</span><b className="md-num">{next != null ? fmt.money(next) : "—"}</b></div>
                ) : <Note tone="error">لا يُسعَّر بهامش بلا مصدر: اربط عرض مورد واحداً على الأقل، أو اختر السعر اليدوي.</Note>}
              </>
            )}
            <div className="flex gap-2 flex-wrap">
              <Button icon="check" loading={act.busy && !keeping} disabled={!valid} onClick={() => save(pricing())}>اعتماد السعر الجديد</Button>
              {item.needs_review && item.sale_price != null
                ? <Button variant="secondary" disabled={act.busy} onClick={() => setKeeping(true)}>إبقاء السعر الحالي</Button> : null}
            </div>
          </Section>

          <Section title="حين يغيّر المورد سعره — لهذا الصنف" right={<StatusBadge tone="neutral">M-6</StatusBadge>}>
            <OptionGroup<Tri> value={reprice} onChange={setReprice} options={[
              { value: "project", label: "يتبع إعداد المشروع", sub: projReprice ? `الآن: ${projReprice}` : undefined },
              { value: "on", label: "تلقائي لهذا الصنف", sub: "يُعاد حسابه بهامشه فوراً مهما كان إعداد المشروع." },
              { value: "off", label: "يدوي لهذا الصنف", sub: "يُعلَّم للمراجعة مهما كان إعداد المشروع." },
            ]} />
            <span className="text-12 text-ink-muted">يُحفظ بزر «حفظ».</span>
          </Section>

          <Section title="التكلفة">
            <div className="flex justify-between text-14"><span>أعلى سعر شراء بين المصادر</span><b className="md-num">{maxBuy != null ? fmt.money(maxBuy) : "—"}</b></div>
            <div className="flex justify-between text-15 border-t border-border pt-2"><span>التكلفة المرجعية</span><b className="md-num">{p.cost_ref != null ? fmt.money(p.cost_ref) : "—"}</b></div>
            <span className="text-13 font-bold mt-1.5">أساس التكلفة لهذا الصنف</span>
            <OptionGroup value={basis} onChange={setBasis} options={[
              { value: "project", label: "يتبع إعداد المشروع", sub: projBasis ? `الآن: ${projBasis}` : undefined },
              { value: "first_priority", label: "المورد الأول في الأولوية",
                sub: first?.purchase_price != null ? `${first.supplier_name} = ${fmt.money(first.purchase_price)}` : undefined },
              { value: "max_source", label: "أعلى سعر بين كل الموردين", sub: maxBuy != null ? `= ${fmt.money(maxBuy)}` : undefined },
            ]} />
            <span className="text-12 text-ink-muted">سعر بيع تحت التكلفة يوقف الصنف فوراً مهما كان الإعداد.</span>
          </Section>
        </div>
      ) : (
        <Section title="السعر">
          <div className="md-kv"><span className="md-muted">السعر المعروض الآن للعميل</span>{item.sale_price != null ? <Money value={item.sale_price} /> : "—"}</div>
        </Section>
      )}

      <Section title="المصادر" right={can("catalog") ? <Button size="sm" variant="secondary" icon="plus" onClick={() => setAdding(true)}>إضافة مصدر</Button> : null}>
        <DataTable<SourceOut> rows={p.sources_detail} rowKey={(s) => s.offer_id}
          emptyIcon="tags" emptyTitle="لا مصدر لهذا الصنف" emptyBody="أضف عرض مورد مصدراً ليُحسب السعر بالهامش."
          columns={[
            { key: "priority", label: "الأولوية", numeric: true },
            { key: "supplier_name", label: "المورد" },
            ...(seesCosts ? [{ key: "purchase_price", label: "سعر الشراء", money: true,
              render: (s: SourceOut) => (s.purchase_price != null ? <Money value={s.purchase_price} /> : "—") }] : []),
            { key: "available_qty", label: "المتاح", numeric: true, render: (s) => <Num>{fmt.qty(s.available_qty)} {unitWord}</Num> },
            { key: "status", label: "الحالة", render: (s) => <OfferBadge status={s.status} /> },
            { key: "x", label: "", render: (s) => (
              <button type="button" className="md-btn md-btn-ghost md-btn-sm" aria-label="إزالة المصدر" onClick={() => setRemoving(s)}>
                <Icon name="trash-2" size={16} />
              </button>
            ) },
          ]} />
      </Section>

      <Section title="سجل الأسعار — شراءً وبيعاً">
        <DataTable<PriceChangeOut> rows={p.history} rowKey={(h, i) => `${h.at}-${i}`}
          emptyIcon="history" emptyTitle="لا تغييرات بعد" emptyBody="كل تغيير في سعر البيع أو سعر شراء مصادره يُسجَّل هنا."
          columns={[
            { key: "at", label: "متى", render: (h) => <Num>{fmt.dateTime(h.at)}</Num> },
            { key: "kind", label: "النوع", render: (h) => <StatusBadge tone={h.kind === "sale" ? "info" : "warning"}>{h.label}</StatusBadge> },
            { key: "old", label: "من", money: true, render: (h) => { const v = h.kind === "sale" ? h.sale_old : h.purchase_old; return v != null ? <Money value={v} /> : "—"; } },
            { key: "new", label: "إلى", money: true, render: (h) => { const v = h.kind === "sale" ? h.sale_new : h.purchase_new; return v != null ? <Money value={v} /> : "—"; } },
            { key: "by", label: "بيد" },
          ]} />
      </Section>

      <ConfirmDialog open={keeping} title={<>إبقاء السعر <Money value={item.sale_price} />؟</>}
        body="يُثبَّت هذا السعر يدوياً لهذا الصنف، فلا يتبع الهامش بعد الآن حتى تغيّر طريقة التسعير."
        confirmLabel="إبقاء السعر" loading={act.busy} onCancel={() => setKeeping(false)}
        onConfirm={() => save({ ...pricing(), mode: "manual", manual_price: item.sale_price, margin_value: null })} />

      <ConfirmDialog open={!!removing} tone="error" title={`إزالة «${removing?.supplier_name ?? ""}» من مصادر الصنف؟`}
        body="يُعاد حساب السعر والتوفر من المصادر الباقية. صنف بهامش بلا أي مصدر لا يُسعَّر."
        confirmLabel="إزالة" loading={act.busy} onCancel={() => setRemoving(null)} onConfirm={removeSource} />

      <AddSourceDialog open={adding} itemId={id} nextPriority={(p.sources_detail.at(-1)?.priority ?? 0) + 1}
        onClose={() => setAdding(false)} onAdded={(out) => { d.set(out); setAdding(false); }} />
    </div>
  );
}

/** ربط عرض مورد مصدراً: المورد ← عرضه (يجب أن يطابق منتج الصنف ووحدته، تفرضه القاعدة) ← الأولوية. */
function AddSourceDialog({ open, itemId, nextPriority, onClose, onAdded }: {
  open: boolean; itemId: number; nextPriority: number; onClose: () => void; onAdded: (p: ItemPricingOut) => void;
}) {
  const act = useAction();
  const sups = useLoad(() => (open ? api.get<SupplierRowOut[]>(`/api/admin/suppliers${qs({ status: "approved" })}`) : Promise.resolve(null)), [open]);
  const [sup, setSup] = useState("");
  const detail = useLoad(() => (sup ? api.get<SupplierDetailOut>(`/api/admin/suppliers/${sup}`) : Promise.resolve(null)), [sup]);
  const [offer, setOffer] = useState("");
  const [prio, setPrio] = useState(String(nextPriority));

  useEffect(() => { setPrio(String(nextPriority)); }, [nextPriority, open]);
  useEffect(() => { setOffer(""); }, [sup]);

  async function submit() {
    const out = await act.run(() => api.post<ItemPricingOut>(`/api/admin/catalog/${itemId}/sources`, { offer_id: Number(offer), priority: Number(prio) }),
      "أُضيف المصدر");
    if (out) {
      setSup("");
      onAdded(out);
    }
  }

  return (
    <Dialog open={open} onClose={onClose} label="إضافة مصدر">
      <div className="md-dialog-title">إضافة مصدر للصنف</div>
      <div className="md-dialog-body">العرض يجب أن يبيع الصنف نفسه بالوحدة وحجمها نفسيهما.</div>
      <div className="flex flex-col gap-3">
        <Select label="المورد" value={sup} onChange={setSup}
          options={[{ value: "", label: sups.loading ? "جاري التحميل…" : "اختر المورد" }, ...(sups.data ?? []).map((s) => ({ value: String(s.id), label: s.name }))]} />
        <Select label="العرض" value={offer} onChange={setOffer} disabled={!detail.data}
          options={[{ value: "", label: detail.loading && sup ? "جاري التحميل…" : "اختر العرض" },
            ...(detail.data?.offers ?? []).map((o) => ({
              value: String(o.id),
              label: `${o.product} — ${unitLabel(o.unit, o.unit_size)} · ${o.location}${o.purchase_price != null ? ` · ${fmt.money(o.purchase_price)} د.ل` : ""}`,
            }))]} />
        <TextField label="الأولوية" value={prio} onChange={setPrio} numeric hint="1 يُشترى منه أولاً." />
      </div>
      <div className="md-dialog-actions">
        <Button block icon="check" loading={act.busy} disabled={!offer || !/^[1-9]\d*$/.test(prio.trim())} onClick={submit}>إضافة</Button>
        <Button variant="ghost" block onClick={onClose}>إلغاء</Button>
      </div>
    </Dialog>
  );
}
