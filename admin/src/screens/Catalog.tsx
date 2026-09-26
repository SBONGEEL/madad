/** الكتالوج العام والتسعير: الأصناف المعروضة وأسعارها، ولوحة مراجعة الصنف الذي تغيّر سعر شرائه (م-6).
 *  الشراء والهامش تكاليف: لا تظهر بلا «التكاليف». التسعير نفسه يكتبه من يملكها. */
import { useEffect, useState } from "react";
import { Link, useNavigate } from "react-router-dom";

import * as fmt from "@ui/fmt";
import { qs } from "@ui/client";
import { Button, ConfirmDialog, DataTable, Dialog, Kv, Loader, Money, Num, PageHead, Section, Select, StatusBadge, Switch,
  TextField, useAction, useLoad, type Column } from "@ui/kit";
import { api } from "@/api/client";
import type { CatalogNewIn, CatalogRowOut, CategoryNodeOut, ItemPricingOut, PricingIn, ProductOut, SettingsOut } from "@/api/types";
import { ProductPicker } from "@/lib/commerce-product";
import { flatCategories } from "@/lib/commerce-data";
import { CatalogStatus, marginText, modeSentence, priceByMargin, UNIT_OPTIONS, unitLabel, VisibilityBadge } from "@/lib/commerce-shared";
import { useSession } from "@/session";

export function Catalog() {
  const { can, refreshCounts } = useSession();
  const nav = useNavigate();
  const [typed, setTyped] = useState("");
  const [q, setQ] = useState("");
  const [cat, setCat] = useState("");
  const [review, setReview] = useState(false);
  const [sel, setSel] = useState<number | null>(null);
  const [adding, setAdding] = useState(false);

  useEffect(() => {
    const t = setTimeout(() => setQ(typed.trim()), 350);
    return () => clearTimeout(t);
  }, [typed]);

  const list = useLoad(() => api.get<CatalogRowOut[]>(`/api/admin/catalog${qs({ q, category_id: cat, needs_review: review ? true : undefined })}`),
    [q, cat, review]);
  const cats = useLoad(() => api.get<CategoryNodeOut[]>(`/api/admin/categories`));
  const settings = useLoad(() => (can("settings") ? api.get<SettingsOut>(`/api/admin/settings`) : Promise.resolve(null)), []);

  const rows = list.data ?? [];
  const seesCosts = rows.some((r) => r.cost_ref !== undefined) || can("costs_view");
  const current = rows.find((r) => r.id === sel) ?? rows.find((r) => r.needs_review) ?? rows[0] ?? null;
  const filtered = !!(q || cat || review);

  const columns: Array<Column<CatalogRowOut>> = [
    { key: "name_ar", label: "الصنف", render: (r) => (
      <Link to={`/catalog/${r.id}`} className="md-link" onClick={(e) => e.stopPropagation()}>
        {r.name_ar} <span className="text-13 text-ink-muted">— {unitLabel(r.unit, r.unit_size)}</span>
      </Link>
    ) },
    ...(seesCosts ? [
      { key: "cost_ref", label: "الشراء", money: true, render: (r: CatalogRowOut) => (r.cost_ref != null ? <Money value={r.cost_ref} /> : "—") },
      { key: "margin", label: "الهامش", render: (r: CatalogRowOut) => marginText(r.mode, r.margin_value) },
    ] : []),
    { key: "sale_price", label: "البيع", money: true, render: (r) => (r.sale_price != null ? <Money value={r.sale_price} /> : "—") },
    { key: "sources", label: "المصادر", numeric: true },
    { key: "visibility", label: "الظهور", render: (r) => <VisibilityBadge visibility={r.visibility} /> },
    { key: "status", label: "الحالة", render: (r) => <CatalogStatus row={r} /> },
  ];

  const reprice = settings.data?.reprice_on_cost_change;

  return (
    <div className="md-page">
      <PageHead title="الكتالوج العام والتسعير" actions={<Button icon="plus" onClick={() => setAdding(true)}>صنف كتالوج جديد</Button>} />

      <div className="flex gap-3 items-end flex-wrap">
        <TextField className="flex-1" value={typed} onChange={setTyped} placeholder="ابحث باسم الصنف" icon="search" />
        <div className="w-field-md">
          <Select value={cat} onChange={setCat} options={[{ value: "", label: "كل التصنيفات" }, ...flatCategories(cats.data)]} />
        </div>
        <label className="flex items-center gap-2 text-14">
          <Switch checked={review} onChange={setReview} label="يحتاج مراجعة فقط" />يحتاج مراجعة فقط
        </label>
      </div>

      <div className="grid grid-cols-3 gap-5 items-start">
        <div className="col-span-2 min-w-0">
          <DataTable<CatalogRowOut> rows={list.data} loading={list.loading} error={list.error} onRetry={list.reload}
            columns={columns} rowKey={(r) => r.id} onRowClick={(r) => setSel(r.id)}
            rowTone={(r) => (r.below_cost ? "error" : r.needs_review ? "warning" : null)}
            emptyIcon="tags" emptyTitle={filtered ? "لا أصناف تطابق البحث" : "الكتالوج فارغ"}
            emptyBody={filtered ? "جرّب اسماً آخر، أو أزل التصفية." : (
              <div className="flex flex-col gap-3 items-center">
                <span>اربط عرض مورد بصنف وحدّد سعر البيع ليظهر للعملاء.</span>
                <Button size="sm" icon="plus" onClick={() => setAdding(true)}>صنف جديد</Button>
              </div>
            )} />
        </div>
        {current ? (
          <ReviewPanel key={current.id} row={current} seesCosts={seesCosts}
            onChanged={() => { list.reload(); refreshCounts(); }} />
        ) : null}
      </div>

      <div className="flex justify-between items-center gap-3 bg-surface border border-border rounded-md py-3 px-3.5">
        <span className="text-14">
          <b>حين يغيّر المورد سعره:</b>{" "}
          {reprice === undefined ? "" : reprice ? "تلقائي — يُعاد حساب السعر بالهامش فوراً. " : "يدوي — يُعلَّم الصنف للمراجعة ويصلك إشعار. "}
          لا يُباع صنف تحت تكلفته أبداً.
        </span>
        {can("settings") ? <Link to="/settings" className="md-link text-14 font-bold">الإعدادات</Link> : null}
      </div>

      <NewItemDialog open={adding} cats={cats.data} onClose={() => setAdding(false)}
        onCreated={(r) => { setAdding(false); list.reload(); nav(`/catalog/${r.id}`); }} />
    </div>
  );
}

/** لوحة الصنف المختار: السعر الجديد بالهامش مقابل الحالي، واعتماد أو إبقاء. */
function ReviewPanel({ row, seesCosts, onChanged }: { row: CatalogRowOut; seesCosts: boolean; onChanged: () => void }) {
  const d = useLoad(() => api.get<ItemPricingOut>(`/api/admin/catalog/${row.id}`), [row.id]);
  const act = useAction();
  const [mode, setMode] = useState("margin_pct");
  const [margin, setMargin] = useState("");
  const [manual, setManual] = useState("");
  const [keeping, setKeeping] = useState(false);

  useEffect(() => {
    if (!d.data) return;
    setMode(d.data.mode ?? "margin_pct");
    setMargin(d.data.margin_value != null ? fmt.qty(d.data.margin_value) : "");
    setManual(d.data.manual_price ?? d.data.item.sale_price ?? "");
  }, [d.data]);

  async function save(body: PricingIn) {
    const out = await act.run(() => api.put<ItemPricingOut>(`/api/admin/catalog/${row.id}/pricing`, body), "حُفظ السعر");
    if (out) {
      d.set(out);
      setKeeping(false);
      onChanged();
    }
  }

  async function toggleVisible(v: boolean) {
    const out = await act.run(() => api.patch<CatalogRowOut>(`/api/admin/catalog/${row.id}`, { visibility: v ? "visible" : "hidden" }),
      v ? "الصنف ظاهر للعملاء" : "أُخفي الصنف");
    if (out) {
      d.reload();
      onChanged();
    }
  }

  return (
    <Section className="gap-3.5" title={<>{row.name_ar} — {unitLabel(row.unit, row.unit_size)}</>} right={<CatalogStatus row={row} />}>
      <Loader state={d}>
        {(p) => {
          const first = p.sources_detail[0];
          const was = first ? p.history.find((h) => h.kind === "purchase" && h.label.endsWith(first.supplier_name))?.purchase_old : null;
          const marginOk = /^\d+(\.\d{1,2})?$/.test(margin.trim());
          const next = mode !== "manual" && marginOk ? priceByMargin(mode, first?.purchase_price, margin) : null;
          const sale = p.item.sale_price;
          const editable = seesCosts && p.mode !== undefined;
          return (
            <>
              <div className="flex flex-col gap-2">
                {editable && first?.purchase_price != null ? (
                  <Kv k={<>سعر شراء الأولوية 1{was ? <> (كان <Num>{fmt.money(was)}</Num>)</> : null}</>} v={<Money value={first.purchase_price} />} />
                ) : null}
                {editable ? <Kv k="طريقة التسعير" v={modeSentence(p.mode, p.margin_value)} strong /> : null}
                <Kv k="السعر المعروض الآن للعميل" v={sale != null ? <Money value={sale} /> : "—"} />
                {next != null ? <Kv k="بالهامش على السعر الجديد" v={<Money value={next} />} /> : null}
                <div className="md-kv items-center">
                  <span className="md-muted">الظهور للعملاء</span>
                  <Switch checked={p.item.visibility === "visible"} disabled={act.busy} label="الظهور للعملاء" onChange={toggleVisible} />
                </div>
              </div>

              {editable ? (
                <>
                  <div role="radiogroup" className="grid grid-cols-3 gap-2">
                    {[["manual", "يدوي"], ["margin_pct", "هامش %"], ["margin_amount", "هامش مبلغ"]].map(([v, l]) => (
                      <button key={v} type="button" role="radio" aria-checked={mode === v} onClick={() => setMode(v!)}
                        className={mode === v ? "md-btn md-btn-secondary border-2 border-primary bg-primary-tint font-bold" : "md-btn md-btn-secondary"}>{l}</button>
                    ))}
                  </div>
                  {mode === "manual" ? (
                    <TextField label="سعر البيع" value={manual} onChange={setManual} numeric suffix="د.ل"
                      error={manual && !fmt.isMoney(manual) ? "مبلغ بثلاث خانات على الأكثر" : null} />
                  ) : (
                    <TextField label="الهامش" value={margin} onChange={setMargin} numeric suffix={mode === "margin_pct" ? "%" : "د.ل"}
                      error={margin && !marginOk ? "رقم بخانتين عشريتين على الأكثر" : null} />
                  )}
                  <div className="grid grid-cols-2 gap-2">
                    <Button icon="check" loading={act.busy && !keeping}
                      disabled={mode === "manual" ? !fmt.isMoney(manual) : !marginOk || !first}
                      onClick={() => save({ mode, margin_value: mode === "manual" ? null : margin.trim(), manual_price: mode === "manual" ? manual.trim() : null,
                        reprice_override: p.reprice_override, cost_basis_override: p.cost_basis_override })}>
                      اعتماد {mode === "manual" ? (fmt.isMoney(manual) ? fmt.money(manual) : "") : next != null ? fmt.money(next) : ""}
                    </Button>
                    {p.item.needs_review && sale != null
                      ? <Button variant="secondary" disabled={act.busy} onClick={() => setKeeping(true)}>إبقاء {fmt.money(sale)}</Button> : null}
                  </div>
                  {mode !== "manual" && !first ? <StatusBadge tone="error">لا يُسعَّر بهامش بلا مصدر</StatusBadge> : null}
                </>
              ) : null}
              <div className="flex justify-between items-center gap-2">
                <span className="text-12 text-ink-muted">كل تغيير يُسجَّل: من غيّر، ومتى، ومن كم إلى كم.</span>
                <Link to={`/catalog/${row.id}`} className="md-link text-13">صفحة التسعير</Link>
              </div>

              <ConfirmDialog open={keeping} title={<>إبقاء السعر <Money value={sale} />؟</>}
                body="يُثبَّت هذا السعر يدوياً لهذا الصنف، فلا يتبع الهامش بعد الآن حتى تغيّر طريقة التسعير."
                confirmLabel="إبقاء السعر" loading={act.busy} onCancel={() => setKeeping(false)}
                onConfirm={() => save({ mode: "manual", manual_price: sale, margin_value: null,
                  reprice_override: p.reprice_override, cost_basis_override: p.cost_basis_override })} />
            </>
          );
        }}
      </Loader>
    </Section>
  );
}

function NewItemDialog({ open, cats, onClose, onCreated }: {
  open: boolean; cats: CategoryNodeOut[] | null; onClose: () => void; onCreated: (r: CatalogRowOut) => void;
}) {
  const act = useAction();
  const [product, setProduct] = useState<ProductOut | null>(null);
  const [name, setName] = useState("");
  const [cat, setCat] = useState("");
  const [unit, setUnit] = useState("kg");
  const [size, setSize] = useState("1");
  const options = flatCategories(cats);
  const valid = product && name.trim() && cat && /^\d+(\.\d{1,3})?$/.test(size.trim()) && Number(size) > 0;

  async function submit() {
    if (!valid || !product) return;
    const body: CatalogNewIn = { product_id: product.id, category_id: Number(cat), unit, unit_size: size.trim(), name_ar: name.trim() };
    const r = await act.run(() => api.post<CatalogRowOut>(`/api/admin/catalog`, body), "أُضيف الصنف إلى الكتالوج");
    if (r) {
      setProduct(null); setName(""); setSize("1");
      onCreated(r);
    }
  }

  return (
    <Dialog open={open} onClose={onClose} label="صنف كتالوج جديد">
      <div className="md-dialog-title">صنف كتالوج جديد</div>
      <div className="md-dialog-body">يُنشأ الصنف مخفياً؛ اربط به عرض مورد وحدّد سعره ثم أظهره للعملاء.</div>
      <div className="flex flex-col gap-3">
        <ProductPicker label="الصنف في القاموس" value={product} onPick={(p) => { setProduct(p); if (p && !name.trim()) setName(p.name_ar); }} />
        <TextField label="اسم الصنف كما يراه العميل" value={name} onChange={setName} required />
        <Select label="التصنيف" value={cat} onChange={setCat} options={[{ value: "", label: "اختر التصنيف" }, ...options]} />
        <div className="grid grid-cols-2 gap-3">
          <Select label="وحدة البيع" value={unit} onChange={setUnit} options={UNIT_OPTIONS} />
          <TextField label="الكمية في الوحدة" value={size} onChange={setSize} numeric required />
        </div>
      </div>
      <div className="md-dialog-actions">
        <Button block icon="check" loading={act.busy} disabled={!valid} onClick={submit}>إضافة</Button>
        <Button variant="ghost" block onClick={onClose}>إلغاء</Button>
      </div>
    </Dialog>
  );
}
