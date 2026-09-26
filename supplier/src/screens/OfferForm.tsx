/**
 * 03 إضافة عرض — من القاموس أو اقتراح صنف (م-4)، وتعديل عرض قائم.
 * جديد (/offers/new): 1) اختر الصنف من قاموس مَدَد أو اقترح صنفاً (يبقى العرض عليه موقوفاً حتى الاعتماد)، 2) تفاصيل العرض.
 * تعديل (/offers/:offerId): الصنف والوحدة والموقع ثابتة (offer_identity_immutable)؛ يتغيّر السعر (يُسجَّل) والمتاح والحد الأدنى والحالة والصورة.
 * المال والكميات نصوص بثلاث منازل عشرية على الأكثر (م-1).
 */
import { useEffect, useRef, useState } from "react";
import { useNavigate, useParams, useSearchParams } from "react-router-dom";

import { Button, EmptyState, ErrorState, Icon, LoadingState, Note, Select, StatusBadge, Switch, TextField, toast, useLoad } from "@ui/kit";
import { qs } from "@ui/client";
import * as fmt from "@ui/fmt";
import { api } from "@/api/client";
import type { CategoryOut, LocationOut, OfferOut, ProductOut, ProposalOut } from "@/api/types";
import { MAX_UPLOAD, UNITS, mediaUrl, numError, offError, unitLabel, unitWord, uploadOfferPhoto } from "@/lib/off-http";
import { Screen } from "@/lib/shell";
import { useSession } from "@/session";

export function OfferForm() {
  const { offerId } = useParams();
  const { approved } = useSession();
  if (!approved) {
    return (
      <Screen title={offerId ? "تعديل العرض" : "عرض جديد"} back="/offers">
        <div className="flex-1 flex flex-col justify-center">
          <EmptyState icon="clock" title="حسابك بانتظار اعتماد مَدَد" body="تضيف عروضك وتعدّلها بعد اعتماد حسابك، ويصلك إشعار حين يتم." />
        </div>
      </Screen>
    );
  }
  return offerId ? <EditOffer key={offerId} offerId={Number(offerId)} /> : <NewOffer />;
}

// ——— الصورة الاختيارية ———————————————————————————————————————————————————————————
function PhotoPick({ file, currentId, onFile, onRemove, disabled }: {
  file: File | null; currentId: number | null; onFile: (f: File) => void; onRemove: () => void; disabled?: boolean;
}) {
  const input = useRef<HTMLInputElement>(null);
  const [preview, setPreview] = useState<string | null>(null);
  useEffect(() => {
    if (!file) return setPreview(null);
    const u = URL.createObjectURL(file);
    setPreview(u);
    return () => URL.revokeObjectURL(u);
  }, [file]);
  const src = preview ?? (currentId != null ? mediaUrl(currentId) : null);
  return (
    <div className="flex gap-2 items-center">
      <button type="button" disabled={disabled} onClick={() => input.current?.click()} aria-label="اختر صورة للصنف"
        className="w-12 h-12 rounded-md bg-primary-tint text-primary-text grid place-items-center border-0 p-0 overflow-hidden cursor-pointer">
        {src ? <img src={src} alt="صورة العرض" className="w-12 h-12 object-cover" /> : <Icon name="camera" />}
      </button>
      <span className="flex-1 text-13 text-ink-muted">{src ? "صورة الصنف — اضغطها لتغييرها" : "صورة اختيارية للصنف"}</span>
      {src ? <Button size="sm" variant="ghost" icon="trash-2" disabled={disabled} onClick={onRemove}>إزالة</Button> : null}
      <input ref={input} type="file" accept="image/jpeg,image/png,image/webp" className="sr-only"
        onChange={(e) => {
          const f = e.target.files?.[0];
          e.target.value = "";
          if (!f) return;
          if (f.size > MAX_UPLOAD) return toast("الصورة أكبر من 10 ميغابايت.", true);
          onFile(f);
        }} />
    </div>
  );
}

// ——— عرض جديد ————————————————————————————————————————————————————————————————————
/** الخطوة في الرابط (?s=propose|details) ليعمل زر الرجوع بين الخطوات؛ الصنف المختار في الحالة. */
function NewOffer() {
  const nav = useNavigate();
  const [params] = useSearchParams();
  const [product, setProduct] = useState<ProductOut | null>(null);
  const [name, setName] = useState("");
  const s = params.get("s");
  const back = () => nav(-1);
  if (s === "propose") {
    return <ProposeProduct initial={name} onBack={back} onDone={(p) => { setProduct(p); nav("/offers/new?s=details", { replace: true }); }} />;
  }
  if (s === "details" && product) return <NewDetails product={product} onBack={back} />;
  return (
    <PickProduct onPick={(p) => { setProduct(p); nav("/offers/new?s=details"); }}
      onPropose={(n) => { setName(n); nav("/offers/new?s=propose"); }} />
  );
}

function useDebounced(v: string, ms = 300) {
  const [d, setD] = useState(v);
  useEffect(() => {
    const t = setTimeout(() => setD(v), ms);
    return () => clearTimeout(t);
  }, [v, ms]);
  return d;
}

function PickProduct({ onPick, onPropose }: { onPick: (p: ProductOut) => void; onPropose: (name: string) => void }) {
  const [q, setQ] = useState("");
  const dq = useDebounced(q.trim());
  const found = useLoad(() => api.get<ProductOut[]>(`/api/supplier/products${qs({ q: dq })}`), [dq]);
  return (
    <Screen title="عرض جديد" back="/offers">
      <TextField value={q} onChange={setQ} icon="search" placeholder="ابحث عن الصنف" autoFocus
        hint="قاموس مَدَد الموحّد: اختر الاسم الموجود بدل كتابة اسم جديد" />
      {found.loading && !found.data ? <LoadingState rows={4} />
        : found.error && !found.data ? <ErrorState compact title={found.error.message} code={found.error.code} onRetry={found.reload} />
        : (
          <div className="flex flex-col gap-2">
            {(found.data ?? []).map((p) => (
              <button key={p.id} type="button" onClick={() => onPick(p)}
                className="min-h-12 flex items-center gap-2.5 px-3 py-2 rounded-md border border-border bg-surface text-ink font-sans text-15 text-start cursor-pointer w-full">
                <Icon name="leaf" size={18} />
                <span className="flex-1">{p.name_ar}</span>
                {p.status === "proposed" ? <StatusBadge tone="warning">مقترح</StatusBadge> : null}
                <span className="text-12 text-ink-muted">{p.category_name}</span>
              </button>
            ))}
            {found.data && !found.data.length ? <EmptyState compact icon="search" title="لا صنف بهذا الاسم في القاموس" body="اقترحه، ويعتمده مَدَد." /> : null}
          </div>
        )}
      <div className="mt-auto bg-secondary-tint rounded-md p-3 flex flex-col gap-2">
        <span className="text-14">لم تجد صنفك؟</span>
        <Button size="sm" variant="secondary" icon="plus" onClick={() => onPropose(q.trim())}>اقترح صنفاً جديداً</Button>
        <span className="text-12 text-ink-muted">أنت تقترح فقط: الصنف لا يظهر لأي عميل قبل أن يعتمده مَدَد.</span>
      </div>
    </Screen>
  );
}

function ProposeProduct({ initial, onBack, onDone }: { initial: string; onBack: () => void; onDone: (p: ProductOut) => void }) {
  const cats = useLoad(() => api.get<CategoryOut[]>(`/api/supplier/categories`), []);
  const [name, setName] = useState(initial);
  const [main, setMain] = useState("");
  const [sub, setSub] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [sent, setSent] = useState<ProposalOut | null>(null);
  const [picking, setPicking] = useState<string | null>(null);

  const mainCat = cats.data?.find((c) => String(c.id) === main);
  const children = mainCat?.children ?? [];
  const categoryId = children.length ? sub : main;
  const ok = name.trim() && categoryId;

  async function send() {
    setBusy(true);
    setErr(null);
    try {
      const r = await api.post<ProposalOut>(`/api/supplier/products`, { name_ar: name.trim(), category_id: Number(categoryId) });
      if (r.similar.length) setSent(r);
      else onDone(r.product);
    } catch (e) {
      setErr(offError(e));
    } finally {
      setBusy(false);
    }
  }

  /** اختيار صنف معتمد يشبه المقترح: يُبحث عنه في القاموس باسمه. */
  async function chooseSimilar(n: string) {
    setPicking(n);
    try {
      const list = await api.get<ProductOut[]>(`/api/supplier/products${qs({ q: n })}`);
      const p = list.find((x) => x.name_ar === n && x.status === "approved") ?? list.find((x) => x.status === "approved");
      if (p) onDone(p);
      else toast("لم نجد الصنف في القاموس الآن. تابع بالصنف المقترح.", true);
    } catch (e) {
      toast(offError(e), true);
    } finally {
      setPicking(null);
    }
  }

  return (
    <Screen title="اقتراح صنف">
      <TextField label="اسم الصنف" value={name} onChange={setName} required disabled={busy || !!sent} autoFocus />
      {cats.loading && !cats.data ? <LoadingState rows={2} />
        : cats.error && !cats.data ? <ErrorState compact title={cats.error.message} code={cats.error.code} onRetry={cats.reload} />
        : (
          <>
            <Select label="التصنيف الرئيسي" value={main} disabled={busy || !!sent} onChange={(v) => { setMain(v); setSub(""); }}
              options={[{ value: "", label: "اختر التصنيف" }, ...(cats.data ?? []).map((c) => ({ value: String(c.id), label: c.name_ar }))]} />
            {children.length ? (
              <>
                <Select label="الفرع" value={sub} disabled={busy || !!sent} onChange={setSub}
                  options={[{ value: "", label: "اختر الفرع" }, ...children.map((c) => ({ value: String(c.id), label: c.name_ar }))]} />
                <span className="text-12 text-ink-muted">الفروع يضيفها مَدَد وحده. لا فرع مناسب؟ اختر الأقرب، ويصحّحه مَدَد عند الاعتماد.</span>
              </>
            ) : null}
          </>
        )}
      {sent ? (
        <div className="bg-warning-tint rounded-md p-3 text-14">
          يشبه {sent.similar.map((s) => `«${s}»`).join(" و")} الموجود في القاموس. إن كان هو نفسه، اختره بدل اقتراح جديد.
        </div>
      ) : null}
      <div className="bg-surface border border-border rounded-md p-3 flex gap-2 items-center text-14">
        <StatusBadge tone="warning">مقترح</StatusBadge><span>عرضك عليه يبقى موقوفاً حتى الاعتماد.</span>
      </div>
      {err ? <Note tone="error">{err}</Note> : null}
      <div className="mt-auto flex flex-col gap-2">
        {sent ? (
          <>
            <Button block onClick={() => onDone(sent.product)} disabled={!!picking}>متابعة العرض بالصنف المقترح</Button>
            {sent.similar.map((s) => (
              <Button key={s} block variant="secondary" loading={picking === s} disabled={!!picking} onClick={() => void chooseSimilar(s)}>اختيار «{s}»</Button>
            ))}
          </>
        ) : (
          <>
            <Button block loading={busy} disabled={!ok} onClick={() => void send()}>إرسال الاقتراح ومتابعة العرض</Button>
            <Button block variant="ghost" disabled={busy} onClick={onBack}>رجوع إلى القاموس</Button>
          </>
        )}
      </div>
    </Screen>
  );
}

function NewDetails({ product, onBack }: { product: ProductOut; onBack: () => void }) {
  const nav = useNavigate();
  const locs = useLoad(() => api.get<LocationOut[]>(`/api/supplier/locations`), []);
  const proposed = product.status !== "approved";
  const [unit, setUnit] = useState<string>("kg");
  const [size, setSize] = useState("1");
  const [price, setPrice] = useState("");
  const [qty, setQty] = useState("");
  const [minQ, setMinQ] = useState("");
  const [loc, setLoc] = useState("");
  const [active, setActive] = useState(!proposed);
  const [file, setFile] = useState<File | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const actives = (locs.data ?? []).filter((l) => l.active);
  useEffect(() => {
    const first = actives[0];
    if (!loc && first) setLoc(String(first.id));
  }, [actives, loc]);

  const u = unitWord(unit);
  const eSize = numError(size, { what: "الكمية" });
  const ePrice = numError(price, { what: "السعر" });
  const eQty = numError(qty, { positive: false, what: "الكمية" });
  const eMin = numError(minQ, { what: "الكمية" });
  const ok = size.trim() && price.trim() && qty.trim() && loc && !eSize && !ePrice && !eQty && !eMin;

  async function save() {
    setBusy(true);
    setErr(null);
    try {
      const photo = file ? await uploadOfferPhoto(file) : null;
      const body = {
        product_id: product.id, unit, unit_size: size.trim(), purchase_price: price.trim(), reported_qty: qty.trim(),
        min_order_qty: minQ.trim() || null, pickup_location_id: Number(loc), active: proposed ? false : active,
      };
      const rows = await api.post<OfferOut[]>(`/api/supplier/offers`, body);
      const made = rows.find((o) => o.product_id === product.id && o.unit === unit && Number(o.unit_size) === Number(body.unit_size)
        && o.pickup_location_id === body.pickup_location_id);
      if (photo != null && made) {
        try {
          await api.put<OfferOut[]>(`/api/supplier/offers/${made.id}/media`, { media_ids: [photo] });
        } catch (e) {
          toast(`أُضيف العرض، ولم تُحفظ الصورة: ${offError(e)}`, true);
        }
      }
      toast(proposed ? "أُضيف العرض موقوفاً حتى يعتمد مَدَد الصنف." : "أُضيف العرض.");
      nav("/offers", { replace: true });
    } catch (e) {
      setErr(offError(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Screen title={product.name_ar}>
      <div className="flex items-center gap-2 text-14">
        <Icon name="leaf" size={18} /><b className="flex-1">{product.name_ar}</b>
        {proposed ? <StatusBadge tone="warning">مقترح</StatusBadge> : null}
        <Button size="sm" variant="ghost" disabled={busy} onClick={onBack}>تغيير الصنف</Button>
      </div>
      <div className="grid grid-cols-2 gap-2">
        <Select label="وحدة البيع" value={unit} onChange={setUnit} disabled={busy} options={UNITS.map((x) => ({ value: x, label: unitWord(x) }))} />
        <TextField label="الكمية في الوحدة" value={size} onChange={setSize} numeric disabled={busy} error={eSize} />
      </div>
      <TextField label="سعرك للوحدة" value={price} onChange={setPrice} numeric suffix="د.ل" disabled={busy} error={ePrice}
        hint={`هذا سعر بيعك لمَدَد عن ${unitLabel(unit, size)}.`} />
      <TextField label="المتاح الآن" value={qty} onChange={setQty} numeric suffix={u} disabled={busy} error={eQty} />
      <TextField label="حد أدنى للطلب (اختياري)" value={minQ} onChange={setMinQ} numeric suffix={u} disabled={busy} error={eMin} />
      {locs.loading && !locs.data ? <LoadingState rows={1} />
        : locs.error && !locs.data ? <ErrorState compact title={locs.error.message} code={locs.error.code} onRetry={locs.reload} />
        : actives.length ? (
          <Select label="موقع الاستلام" value={loc} onChange={setLoc} disabled={busy} options={actives.map((l) => ({ value: String(l.id), label: l.label }))} />
        ) : (
          <Note tone="warning">لا موقع استلام نشط. <button type="button" className="md-link" onClick={() => nav("/locations")}>أضف موقعاً</button> ثم عد إلى العرض.</Note>
        )}
      <PhotoPick file={file} currentId={null} onFile={setFile} onRemove={() => setFile(null)} disabled={busy} />
      <div className="flex justify-between items-center">
        <span>العرض نشط</span>
        <Switch checked={proposed ? false : active} onChange={setActive} label="العرض نشط" disabled={busy || proposed} />
      </div>
      {proposed ? <Note tone="warning">الصنف مقترح: عرضك عليه يبقى موقوفاً حتى الاعتماد.</Note> : null}
      {err ? <Note tone="error">{err}</Note> : null}
      <div className="mt-auto"><Button block icon="check" loading={busy} disabled={!ok} onClick={() => void save()}>حفظ</Button></div>
    </Screen>
  );
}

// ——— تعديل عرض ——————————————————————————————————————————————————————————————————
function EditOffer({ offerId }: { offerId: number }) {
  const state = useLoad(() => api.get<OfferOut[]>(`/api/supplier/offers`), []);
  const offer = state.data?.find((o) => o.id === offerId);
  if (state.loading && !state.data) {
    return <Screen title="العرض" back="/offers"><LoadingState rows={3} /></Screen>;
  }
  if (!offer) {
    return (
      <Screen title="العرض" back="/offers">
        <div className="flex-1 flex flex-col justify-center">
          {state.error ? <ErrorState title="تعذّر تحميل العرض" body="تحقق من الاتصال. عرضك يبقى كما هو في مَدَد." code={state.error.code} onRetry={state.reload} />
            : <ErrorState title="العرض غير موجود" body="ربما حُذف أو لا يخصّك." code="offer_not_found" />}
        </div>
      </Screen>
    );
  }
  return <EditForm offer={offer} />;
}

function EditForm({ offer }: { offer: OfferOut }) {
  const nav = useNavigate();
  const u = unitWord(offer.unit);
  const [price, setPrice] = useState(offer.purchase_price);
  const [qty, setQty] = useState(fmt.qty(offer.reported_qty));
  const [minQ, setMinQ] = useState(offer.min_order_qty ? fmt.qty(offer.min_order_qty) : "");
  const [active, setActive] = useState(offer.status === "active");
  const [file, setFile] = useState<File | null>(null);
  const [removed, setRemoved] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<{ title?: string; body: string } | null>(null);

  const proposed = offer.product_status !== "approved";
  const ePrice = numError(price, { what: "السعر" });
  const eQty = numError(qty, { positive: false, what: "الكمية" });
  const eMin = numError(minQ, { what: "الكمية" });

  const priceChanged = price.trim() !== "" && Number(price) !== Number(offer.purchase_price);
  const qtyChanged = qty.trim() !== "" && Number(qty) !== Number(offer.reported_qty);
  const minChanged = minQ.trim() ? Number(minQ) !== Number(offer.min_order_qty ?? NaN) : offer.min_order_qty != null;
  const activeChanged = active !== (offer.status === "active");
  const photoChanged = !!file || removed;
  const dirty = priceChanged || qtyChanged || minChanged || activeChanged || photoChanged;
  const ok = price.trim() && qty.trim() && !ePrice && !eQty && !eMin && dirty;

  const reserved = Number(offer.reserved_qty);
  const below = reserved > 0 && qty.trim() !== "" && !eQty && Number(qty) < reserved;
  const was = priceChanged ? offer.purchase_price : offer.previous_price;
  const priceHint = was ? `هذا سعر بيعك لمَدَد. كان ${fmt.money(was)} — التغيير يُسجَّل.` : "هذا سعر بيعك لمَدَد. أي تغيير يُسجَّل.";

  async function save() {
    setBusy(true);
    setErr(null);
    const body: Record<string, unknown> = {};
    if (priceChanged) body.purchase_price = price.trim();
    if (qtyChanged) body.reported_qty = qty.trim();
    if (minChanged) {
      if (minQ.trim()) body.min_order_qty = minQ.trim();
      else body.clear_min_order = true;
    }
    if (activeChanged) body.active = active;
    try {
      if (Object.keys(body).length) await api.patch<OfferOut[]>(`/api/supplier/offers/${offer.id}`, body);
    } catch (e) {
      setBusy(false);
      setErr(qtyChanged
        ? { title: "تعذّر حفظ الكمية", body: `لم يُحفظ تعديل «${offer.product_name}». الكمية عند مَدَد ما زالت ${fmt.qty(offer.reported_qty)}. ${offError(e)}` }
        : { body: offError(e) });
      return;
    }
    if (photoChanged) {
      try {
        const ids = file ? [await uploadOfferPhoto(file)] : [];
        await api.put<OfferOut[]>(`/api/supplier/offers/${offer.id}/media`, { media_ids: ids });
      } catch (e) {
        setBusy(false);
        setErr({ title: "حُفظ العرض، ولم تُحفظ الصورة", body: offError(e) });
        return;
      }
    }
    setBusy(false);
    toast("حُفظ العرض.");
    nav("/offers", { replace: true });
  }

  return (
    <Screen title={offer.product_name} back="/offers">
      {proposed ? (
        <div className="bg-surface border border-border rounded-md p-3 flex gap-2 items-center text-14">
          <StatusBadge tone="warning">صنف مقترح</StatusBadge><span>عرضك عليه يبقى موقوفاً حتى الاعتماد.</span>
        </div>
      ) : null}
      <div className="grid grid-cols-2 gap-2">
        <TextField label="وحدة البيع" value={u} readOnly />
        <TextField label="الكمية في الوحدة" value={fmt.qty(offer.unit_size)} numeric readOnly />
      </div>
      <TextField label="سعرك للوحدة" value={price} onChange={setPrice} numeric suffix="د.ل" disabled={busy} error={ePrice} hint={priceHint} />
      <TextField label="المتاح الآن" value={qty} onChange={setQty} numeric suffix={u} disabled={busy} error={eQty}
        hint={reserved > 0 && !below ? `منها ${fmt.qty(reserved)} ${u} محجوزة للاستلام` : undefined} />
      {below ? (
        <Note tone="warning">تنبيه: لديك {fmt.qty(reserved)} {u} محجوزة للاستلام. إن لم تتوفر كلها سيبلَّغ مَدَد ليعدّل المخطط.</Note>
      ) : null}
      <TextField label="حد أدنى للطلب (اختياري)" value={minQ} onChange={setMinQ} numeric suffix={u} disabled={busy} error={eMin}
        hint={offer.min_order_qty && !minQ.trim() ? "يُلغى الحد الأدنى عند الحفظ." : undefined} />
      <TextField label="موقع الاستلام" value={offer.location_label} icon="map-pin" readOnly />
      <span className="text-12 text-ink-muted">الصنف والوحدة والموقع لا تتغير بعد إضافة العرض. لغيرها أضف عرضاً جديداً.</span>
      <PhotoPick file={file} currentId={removed ? null : offer.image_media_id} disabled={busy}
        onFile={(f) => { setFile(f); setRemoved(false); }} onRemove={() => { setFile(null); setRemoved(offer.image_media_id != null); }} />
      <div className="flex justify-between items-center">
        <span>العرض نشط</span>
        <Switch checked={active} onChange={setActive} label="العرض نشط" disabled={busy || (proposed && !active)} />
      </div>
      {err ? <Note tone="error">{err.title ? <><b>{err.title}</b><br /></> : null}{err.body}</Note> : null}
      <div className="mt-auto"><Button block icon="check" loading={busy} disabled={!ok} onClick={() => void save()}>حفظ</Button></div>
    </Screen>
  );
}
