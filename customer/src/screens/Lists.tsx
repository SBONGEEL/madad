/**
 * 09 القوائم المتكررة والتذكير (§3.1): قسم «قوائمي» تحت الطلبات. إعادة الطلب بكبسة تفتح السلة ممتلئة؛
 * الصنف غير المتاح يُعلَّم وتُقترح بدائله من التصنيف نفسه، أو يُطلب الباقي بدونه. التذكير أيام وساعة.
 */
import { useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";

import { ApiError, qs } from "@ui/client";
import { arabicError } from "@ui/errors";
import * as fmt from "@ui/fmt";
import {
  Button, ConfirmDialog, Dialog, type Loaded, EmptyState, ErrorState, Icon, LoadingState, Note, OptionGroup, ProductCard, Section, Select,
  StatusBadge, Switch, TextField, cx, toast, useAction, useLoad,
} from "@ui/kit";
import { api } from "@/api/client";
import type {
  CartOut, Catalog2Out, CategoryOut, ListDetailOut, ListOut, Order2SummaryOut, ReorderOut,
} from "@/api/types";
import { REMINDER_DAYS, daysText, itemsWord, qtyWithUnit, unitLabel } from "@/lib/ord-shared";
import { OrdersTabs } from "@/lib/ord-tabs";
import { HomeHeader, Screen } from "@/lib/shell";
import { useSession } from "@/session";

function badge(l: ListOut) {
  if (l.has_unavailable) return <StatusBadge tone="warning" icon="triangle-alert">فيها صنف غير متاح</StatusBadge>;
  if (l.reminder_days?.length) return <StatusBadge tone="success" icon="bell">التذكير مفعّل</StatusBadge>;
  return <StatusBadge tone="neutral" icon="clock">بلا تذكير</StatusBadge>;
}

function meta(l: ListOut, manyBranches: boolean): string {
  const parts = [itemsWord(l.item_count)];
  parts.push(l.reminder_days?.length && l.reminder_time ? `تذكير ${daysText(l.reminder_days)} ${l.reminder_time}` : "بلا تذكير");
  if (manyBranches) parts.push(l.branch_name);
  return parts.join(" · ");
}

function nameError(e: unknown, name: string): string | null {
  if (e instanceof ApiError && (e.code === "list_name_per_branch" || e.code === "unique_violation")) {
    return `الاسم مستعمل: عندك قائمة باسم «${name.trim()}». اختر اسماً آخر.`;
  }
  return null;
}

/** «أعد الطلب»: تُفتح السلة ممتلئة. غير المتاح يعيد 409 بأسمائه ما لم يُطلب التخطّي. */
function useToCart() {
  const nav = useNavigate();
  const { setCart, refresh } = useSession();
  const [busy, setBusy] = useState<number | null>(null);
  const go = async (l: ListOut, skip: boolean, onUnavailable?: () => void) => {
    setBusy(l.id);
    try {
      const r = await api.post<ReorderOut>(`/api/customer/lists/${l.id}/to-cart`, { skip_unavailable: skip });
      setCart(r.cart);
      refresh();
      toast(r.skipped.length ? `أُضيفت القائمة إلى السلة بدون: ${r.skipped.join("، ")}` : "أُضيفت القائمة إلى السلة.");
      nav("/cart");
    } catch (e) {
      if (e instanceof ApiError && e.code === "list_has_unavailable" && onUnavailable) onUnavailable();
      else toast((e as Error).message, true);
    } finally {
      setBusy(null);
    }
  };
  return { busy, go };
}

export function Lists() {
  const [params, setParams] = useSearchParams();
  const lists = useLoad(() => api.get<ListDetailOut[]>(`/api/customer/lists`));
  const openId = Number(params.get("id") ?? "") || null;
  const open = openId ? lists.data?.find((d) => d.list.id === openId) : undefined;
  const replace = (d: ListDetailOut) => lists.set((lists.data ?? []).map((x) => (x.list.id === d.list.id ? d : x)));
  const remove = (id: number) => lists.set((lists.data ?? []).filter((x) => x.list.id !== id));

  if (openId && open) {
    return <ListDetail key={open.list.id} detail={open} onSaved={replace} onDeleted={(id) => { remove(id); setParams({}); }} />;
  }
  return <ListsHome lists={lists} onOpen={(id) => setParams({ id: String(id) })} onCreated={(d) => lists.set([...(lists.data ?? []), d])} />;
}

// ——— القائمة الرئيسية «قوائمي» ——————————————————————————————————————————————
function ListsHome({ lists, onOpen, onCreated }: {
  lists: Loaded<ListDetailOut[]>; onOpen: (id: number) => void; onCreated: (d: ListDetailOut) => void;
}) {
  const { approved } = useSession();
  const toCart = useToCart();
  const [creating, setCreating] = useState(false);
  const rows = lists.data ?? [];
  const manyBranches = new Set(rows.map((d) => d.list.branch_id)).size > 1;

  let body;
  if (lists.loading && !lists.data) body = <LoadingState rows={3} />;
  else if (lists.error && !lists.data) {
    body = <ErrorState title="تعذّر تحميل قوائمك" body="تحقق من الاتصال ثم أعد المحاولة." code={lists.error.code} onRetry={lists.reload} />;
  } else if (!rows.length) {
    body = (
      <EmptyState icon="repeat" title="لا قوائم متكررة بعد" body="احفظ طلبك المعتاد مرة، وأعد طلبه بكبسة واحدة مع تذكير في موعده."
        action={<Button size="sm" icon="plus" onClick={() => setCreating(true)}>قائمة جديدة</Button>} />
    );
  } else {
    body = (
      <div className="flex flex-col gap-2.5">
        {!approved ? <Note tone="warning">إعادة الطلب من القوائم تعمل بعد اعتماد منشأتك.</Note> : null}
        {rows.map(({ list: l }) => (
          <section key={l.id} className="bg-surface border border-border rounded-lg p-3.5 flex flex-col gap-2">
            <button type="button" onClick={() => onOpen(l.id)}
              className="flex justify-between items-center gap-2 bg-transparent border-0 p-0 text-ink font-sans cursor-pointer text-start">
              <span className="font-bold text-16">{l.name}</span>
              {badge(l)}
            </button>
            <button type="button" onClick={() => onOpen(l.id)}
              className="text-14 text-ink-muted bg-transparent border-0 p-0 font-sans cursor-pointer text-start">{meta(l, manyBranches)}</button>
            <Button size="sm" icon="repeat" loading={toCart.busy === l.id} disabled={toCart.busy !== null || !approved}
              onClick={() => void toCart.go(l, false, () => onOpen(l.id))}>أعد الطلب — تُفتح السلة ممتلئة</Button>
          </section>
        ))}
        <Button variant="secondary" icon="plus" block onClick={() => setCreating(true)}>قائمة جديدة</Button>
      </div>
    );
  }

  return (
    <>
      <HomeHeader />
      <main className="md-mobile-main">
        <OrdersTabs active="lists" />
        {body}
      </main>
      {creating ? <NewListDialog onClose={() => setCreating(false)} onCreated={(d) => { setCreating(false); onCreated(d); onOpen(d.list.id); }} /> : null}
    </>
  );
}

/** قائمة جديدة: من طلبية سابقة أو من السلة الحالية («احفظ طلبك المعتاد مرة»). */
function NewListDialog({ onClose, onCreated }: { onClose: () => void; onCreated: (d: ListDetailOut) => void }) {
  const [name, setName] = useState("");
  const [source, setSource] = useState<"order" | "cart">("order");
  const [orderId, setOrderId] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const [nameErr, setNameErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const orders = useLoad(() => api.get<Order2SummaryOut[]>(`/api/customer/orders`));
  const opts = (orders.data ?? []).filter((o) => o.status !== "cancelled")
    .map((o) => ({ value: String(o.id), label: `#${o.id} · ${fmt.date(o.placed_at)} · ${itemsWord(o.line_count)}` }));
  const chosen = orderId || opts[0]?.value || "";

  const submit = async () => {
    setErr(null);
    setNameErr(null);
    if (!name.trim()) return setNameErr("اكتب اسماً للقائمة.");
    setBusy(true);
    try {
      let d: ListDetailOut;
      if (source === "order") {
        if (!chosen) throw new Error("لا طلبيات سابقة بعد — اختر «من السلة الحالية».");
        d = await api.post<ListDetailOut>(`/api/customer/lists`, { name: name.trim(), from_order_id: Number(chosen) });
      } else {
        const cart = await api.get<CartOut>(`/api/customer/cart`);
        if (!cart.lines.length) throw new Error("السلة فارغة — أضف أصنافاً أولاً أو اختر طلبية سابقة.");
        d = await api.post<ListDetailOut>(`/api/customer/lists`, {
          name: name.trim(), branch_id: cart.branch?.id ?? null,
          items: cart.lines.map((l) => ({ catalog_item_id: l.catalog_item_id, qty: l.qty })),
        });
      }
      toast("حُفظت القائمة.");
      onCreated(d);
    } catch (e) {
      const ne = nameError(e, name);
      if (ne) setNameErr(ne);
      else setErr(e instanceof ApiError ? arabicError(e.code) : (e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open onClose={onClose} wide label="قائمة جديدة">
      <div className="flex flex-col gap-3.5">
        <div className="text-18 font-bold">قائمة جديدة</div>
        <TextField label="اسم القائمة" value={name} onChange={setName} placeholder="طلب السبت" error={nameErr} autoFocus />
        <OptionGroup value={source} onChange={setSource} columns={2} options={[
          { value: "order", label: "من طلبية سابقة" }, { value: "cart", label: "من السلة الحالية" },
        ]} />
        {source === "order" ? (
          orders.loading && !orders.data ? <LoadingState rows={1} />
            : opts.length ? <Select label="الطلبية" value={chosen} onChange={setOrderId} options={opts} />
              : <Note tone="warning">لا طلبيات سابقة بعد.</Note>
        ) : <Note>تُحفظ أصناف سلتك الحالية وكمياتها.</Note>}
        {err ? <Note tone="error">{err}</Note> : null}
        <div className="flex flex-col gap-2">
          <Button block loading={busy} onClick={() => void submit()}>حفظ</Button>
          <Button block variant="ghost" onClick={onClose}>إلغاء</Button>
        </div>
      </div>
    </Dialog>
  );
}

// ——— تفاصيل قائمة: البدائل والتذكير والاسم والحذف ————————————————————————————————
function ListDetail({ detail, onSaved, onDeleted }: {
  detail: ListDetailOut; onSaved: (d: ListDetailOut) => void; onDeleted: (id: number) => void;
}) {
  const { list: l, lines } = detail;
  const { approved } = useSession();
  const toCart = useToCart();
  const act = useAction();
  const missing = lines.filter((x) => !x.orderable);
  const rest = lines.filter((x) => x.orderable);
  const [renaming, setRenaming] = useState(false);
  const [deleting, setDeleting] = useState(false);

  const del = () =>
    void act.run(async () => {
      await api.del<void>(`/api/customer/lists/${l.id}`);
      setDeleting(false);
      onDeleted(l.id);
    }, "حُذفت القائمة.");

  return (
    <Screen title={l.name} back="/lists"
      action={<button type="button" className="md-backbar-btn" aria-label="تغيير الاسم" onClick={() => setRenaming(true)}><Icon name="pencil" size={20} /></button>}>
      {missing.length ? <Alternatives listBranch={l.branch_id} missing={missing} /> : null}

      <Section title={missing.length ? "باقي القائمة" : "الأصناف"} right={<span className="text-13 text-ink-muted">{itemsWord(l.item_count)}</span>}>
        {rest.length ? (
          <div className="text-14 text-ink-muted">{rest.map((x) => `${x.name_ar} ×${qtyWithUnit(x.qty, x.unit)}`).join(" · ")}</div>
        ) : <div className="text-14 text-ink-muted">لا أصناف متاحة في هذه القائمة الآن.</div>}
      </Section>

      {!approved ? <Note tone="warning">إعادة الطلب من القوائم تعمل بعد اعتماد منشأتك.</Note> : null}
      {missing.length ? (
        <Button block loading={toCart.busy === l.id} disabled={!approved || !rest.length} onClick={() => void toCart.go(l, true)}>اطلب بدون الصنف الناقص</Button>
      ) : (
        <Button block icon="repeat" loading={toCart.busy === l.id} disabled={!approved || !lines.length} onClick={() => void toCart.go(l, false)}>أعد الطلب — تُفتح السلة ممتلئة</Button>
      )}

      <Reminder detail={detail} onSaved={onSaved} />

      <Button variant="ghost" icon="x" block onClick={() => setDeleting(true)}>حذف القائمة</Button>

      {renaming ? <RenameDialog list={l} onClose={() => setRenaming(false)} onSaved={(d) => { setRenaming(false); onSaved(d); }} /> : null}
      <ConfirmDialog open={deleting} tone="error" title={`حذف «${l.name}»؟`} body="تُحذف القائمة وتذكيرها. طلبياتك السابقة لا تتأثر."
        confirmLabel="حذف" loading={act.busy} onConfirm={del} onCancel={() => setDeleting(false)} />
    </Screen>
  );
}

/** الصنف غير المتاح وبدائله من تصنيفه نفسه، تُضاف إلى سلة فرع القائمة. */
function Alternatives({ listBranch, missing }: { listBranch: number; missing: ListDetailOut["lines"] }) {
  const { setCart, approved } = useSession();
  const act = useAction();
  const first = missing[0];
  const catId = first?.category_id ?? 0;
  const cats = useLoad(() => api.get<CategoryOut[]>(`/api/customer/categories`));
  const alts = useLoad(
    () => api.get<Catalog2Out[]>(`/api/customer/catalog${qs({ category_id: catId, branch_id: listBranch })}`),
    [catId, listBranch],
  );
  const flat = (cats.data ?? []).flatMap((c) => [c, ...(c.children ?? [])]);
  const catName = flat.find((c) => c.id === catId)?.name_ar;
  const missingIds = new Set(missing.map((m) => m.catalog_item_id));
  const options = (alts.data ?? []).filter((c) => c.orderable && !missingIds.has(c.id)).slice(0, 4);
  const names = missing.map((m) => `«${m.name_ar} ${unitLabel(m.unit, m.unit_size)}»`).join(" و");

  const setQty = (item: Catalog2Out, v: number) =>
    void act.run(async () => {
      const cart = await api.put<CartOut>(`/api/customer/cart/items/${item.id}`, { qty: fmt.qty(v), branch_id: listBranch });
      setCart(cart);
      alts.set((alts.data ?? []).map((c) => (c.id === item.id ? { ...c, cart_qty: v ? fmt.qty(v) : null } : c)));
    });

  return (
    <>
      <Note tone="warning">
        {names} {missing.length > 1 ? "غير متاحة" : "غير متاح"} الآن. اختر بديلاً{catName ? <> من «{catName}»</> : null} أو اطلب القائمة بدونها.
      </Note>
      <div className="font-bold text-15">بدائل</div>
      {alts.loading && !alts.data ? <LoadingState rows={2} />
        : alts.error && !alts.data ? <ErrorState compact title={alts.error.message} code={alts.error.code} onRetry={alts.reload} />
          : options.length ? (
            <div className={cx("flex flex-col gap-2", act.busy && "opacity-60")}>
              {options.map((c) => (
                <ProductCard key={c.id} layout="row" name={c.name_ar} unit={unitLabel(c.unit, c.unit_size)} price={c.sale_price ?? "0"}
                  image={c.image_media_id ? `/api/media/${c.image_media_id}` : null} outOfStock={c.out_of_stock}
                  qty={Number(c.cart_qty ?? 0)} onQty={(v) => (approved ? setQty(c, v) : toast("تُفعَّل السلة بعد اعتماد منشأتك.", true))} />
              ))}
            </div>
          ) : <div className="text-14 text-ink-muted">لا بدائل متاحة في هذا التصنيف الآن.</div>}
    </>
  );
}

/** التذكير: الأيام (السبت…الجمعة → الأحد 0 … السبت 6) والساعة؛ الإطفاء يمسح الاثنين معاً. */
function Reminder({ detail, onSaved }: { detail: ListDetailOut; onSaved: (d: ListDetailOut) => void }) {
  const { list: l } = detail;
  const act = useAction();
  const [on, setOn] = useState(!!l.reminder_days?.length);
  const [days, setDays] = useState<number[]>(l.reminder_days ?? []);
  const [time, setTime] = useState(l.reminder_time ?? "08:00");
  const [err, setErr] = useState<string | null>(null);
  const timeOk = /^([01]\d|2[0-3]):[0-5]\d$/.test(time);
  const toggle = (d: number) => setDays(days.includes(d) ? days.filter((x) => x !== d) : [...days, d]);

  const save = () => {
    setErr(null);
    if (on && !days.length) return setErr("اختر يوماً واحداً على الأقل.");
    if (on && !timeOk) return setErr("اكتب الساعة بصيغة 08:00.");
    void act.run(async () => {
      const d = await api.patch<ListDetailOut>(`/api/customer/lists/${l.id}`,
        on ? { reminder_days: days, reminder_time: time } : { reminder_off: true });
      onSaved(d);
    }, on ? "حُفظ التذكير." : "أُطفئ التذكير.");
  };

  return (
    <Section>
      <div className="flex justify-between items-center">
        <span className="font-bold">ذكّرني</span>
        <Switch checked={on} onChange={setOn} label="التذكير" />
      </div>
      {on ? (
        <>
          <div className="flex flex-col gap-1.5">
            <span className="text-14 font-medium">الأيام</span>
            <div className="grid grid-cols-7 gap-1">
              {REMINDER_DAYS.map((d) => {
                const sel = days.includes(d.dow);
                return (
                  <button key={d.dow} type="button" aria-pressed={sel} onClick={() => toggle(d.dow)}
                    className={cx("min-h-row rounded-sm text-13 font-sans cursor-pointer px-0",
                      sel ? "bg-primary text-on-primary font-bold border border-primary" : "bg-surface text-ink border border-border-strong")}>
                    {d.short}
                  </button>
                );
              })}
            </div>
          </div>
          <TextField label="الساعة" value={time} onChange={setTime} numeric icon="clock" placeholder="08:00"
            error={time && !timeOk ? "بصيغة 08:00" : null} />
          <div className="bg-surface border border-border rounded-md p-3 flex gap-2.5 items-center">
            <span className="w-8 h-8 rounded-md bg-primary text-on-primary grid place-items-center flex-none"><Icon name="bell" size={18} /></span>
            <div className="flex flex-col">
              <span className="font-bold text-14">حان وقت {l.name}</span>
              <span className="text-13 text-ink-muted">{itemsWord(l.item_count)} جاهزة في السلة بكبسة.</span>
            </div>
          </div>
          <span className="text-13 text-ink-muted">هكذا يصلك الإشعار.</span>
        </>
      ) : null}
      {err ? <Note tone="error">{err}</Note> : null}
      <Button block loading={act.busy} onClick={save}>حفظ</Button>
    </Section>
  );
}

function RenameDialog({ list, onClose, onSaved }: { list: ListOut; onClose: () => void; onSaved: (d: ListDetailOut) => void }) {
  const [name, setName] = useState(list.name);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const save = async () => {
    if (!name.trim()) return setErr("اكتب اسماً للقائمة.");
    setBusy(true);
    setErr(null);
    try {
      onSaved(await api.patch<ListDetailOut>(`/api/customer/lists/${list.id}`, { name: name.trim() }));
      toast("تغيّر الاسم.");
    } catch (e) {
      setErr(nameError(e, name) ?? (e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog open onClose={onClose} wide label="اسم القائمة">
      <div className="flex flex-col gap-3.5">
        <div className="text-18 font-bold">اسم القائمة</div>
        <TextField label="الاسم" value={name} onChange={setName} error={err} autoFocus />
        <Button block loading={busy} onClick={() => void save()}>حفظ</Button>
        <Button block variant="ghost" onClick={onClose}>إلغاء</Button>
      </div>
    </Dialog>
  );
}
