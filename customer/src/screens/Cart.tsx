/**
 * 05 السلة و05ب الفرع والمسؤول: أسطر المسودة بكمياتها، والحد الأدنى ورسم التوصيل، ورصيد العميل، والأسطر التي لم تعد متاحة.
 * صاحب المنشأة بعدة فروع يختار الفرع المستلم ويرى السلال الجاهزة من المسؤولين؛ المسؤول في وضع «يؤكد الصاحب» يرسلها له.
 * المنشأة غير المعتمدة: سلة الجهاز (lib/local-cart) بالأسعار الحالية.
 */
import { type ReactNode, useEffect, useRef, useState } from "react";
import { Link, useNavigate } from "react-router-dom";

import { ApiError, qs } from "@ui/client";
import { arabicError } from "@ui/errors";
import * as fmt from "@ui/fmt";
import {
  Button, Dialog, EmptyState, ErrorState, Icon, LoadingState, Money, Note, Num, Option, QtyStepper, StatusBadge,
  toast, useLoad,
} from "@ui/kit";
import { api } from "@/api/client";
import type { BranchOut, CartLineOut, CartOut, ItemDetailOut, Order2Out, ReadyCartOut } from "@/api/types";
import { approvedBranches, cartBranchId, chooseBranch, SumRow, unitLabel, useBranchVersion } from "@/lib/cat-cart";
import { localCart } from "@/lib/local-cart";
import { Screen } from "@/lib/shell";
import { useSession } from "@/session";

export function Cart() {
  const { approved } = useSession();
  return approved ? <ServerCart /> : <DeviceCart />;
}

function EmptyCart() {
  const nav = useNavigate();
  return (
    <div className="flex-1 flex flex-col justify-center">
      <EmptyState icon="shopping-cart" title="سلتك فارغة" body="أضف أصنافاً من الكتالوج، أو افتح قائمة متكررة لتملأ السلة بكبسة."
        action={<Button size="sm" icon="repeat" onClick={() => nav("/lists")}>قوائمي</Button>} />
    </div>
  );
}

function LineCard({ name, unit, total, qty, onQty, bad, children }: {
  name: string; unit: string; total: string | number | null; qty: number; onQty: (v: number) => void; bad?: boolean; children?: ReactNode;
}) {
  return (
    <div className={bad ? "bg-surface border border-error rounded-md px-3 py-2.5 flex items-center gap-2.5"
      : "bg-surface border border-border rounded-md px-3 py-2.5 flex items-center gap-2.5"}>
      <div className="flex-1 flex flex-col min-w-0">
        <span className="font-bold text-15">{name}</span>
        {bad ? <div><StatusBadge tone="warning">نافد</StatusBadge></div> : (
          <>
            <span className="text-13 text-ink-muted">{unit}</span>
            {total != null ? <Money value={total} size="sm" /> : null}
          </>
        )}
      </div>
      {children ?? <QtyStepper value={qty} size="sm" onChange={onQty} />}
    </div>
  );
}

function MinProgress({ subtotal, min, short }: { subtotal: number; min: number; short: number }) {
  const pct = Math.min(100, Math.round((subtotal / min) * 100));
  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex justify-between text-14"><span>الحد الأدنى للطلبية</span><Money value={min} /></div>
      <div className="h-2 rounded-full bg-primary-tint overflow-hidden" role="progressbar" aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100}>
        <div className="h-full bg-warning" style={{ width: `${pct}%` }} />
      </div>
      <span className="text-14">أضف أصنافاً بقيمة <b><Num>{fmt.money(short)}</Num> د.ل</b> لتستطيع الطلب.</span>
    </div>
  );
}

// ——— سلة الجهاز (قبل الاعتماد) ——————————————————————————————————————————————————
function DeviceCart() {
  const nav = useNavigate();
  const { me } = useSession();
  const [, tick] = useState(0);
  useEffect(() => localCart.subscribe(() => tick((n) => n + 1)), []);
  const lines = localCart.lines();
  const key = lines.map((l) => l.id).sort((a, b) => a - b).join(",");
  const items = useLoad(async () => {
    const ids = key ? key.split(",").map(Number) : [];
    const got = await Promise.all(ids.map((id) =>
      api.get<ItemDetailOut>(`/api/customer/catalog/${id}`).then((d) => d.item, () => null)));
    return new Map(got.filter((x) => x !== null).map((x) => [x.id, x]));
  }, [key]);

  if (!lines.length) return <Screen title="السلة"><EmptyCart /></Screen>;
  if (items.loading && !items.data) return <Screen title="السلة"><LoadingState rows={4} /></Screen>;
  if (items.error && !items.data) {
    return <Screen title="السلة"><ErrorState title={items.error.message} code={items.error.code} onRetry={items.reload} /></Screen>;
  }
  const map = items.data ?? new Map();
  let subtotal = 0;
  const min = me.context?.min_order_amount != null ? Number(me.context.min_order_amount) : null;
  return (
    <Screen title="السلة">
      <Note tone="info">نراجع بيانات «{me.customer?.name}» الآن. سلتك محفوظة على هذا الجهاز، وتستطيع الطلب فور الاعتماد.</Note>
      <div className="flex flex-col gap-2">
        {lines.map((l) => {
          const it = map.get(l.id);
          const q = Number(l.qty);
          if (!it) {
            return (
              <LineCard key={l.id} name="صنف لم يعد متاحاً" unit="" total={null} qty={q} bad onQty={() => undefined}>
                <Button size="sm" variant="secondary" icon="trash-2" onClick={() => localCart.set(l.id, "0")}>إزالة</Button>
              </LineCard>
            );
          }
          const bad = !it.orderable || it.out_of_stock;
          const total = Number(it.sale_price ?? 0) * q;
          if (!bad) subtotal += total;
          return (
            <LineCard key={l.id} name={it.name_ar} unit={unitLabel(it.unit, it.unit_size)} total={total} qty={q} bad={bad}
              onQty={(v) => localCart.set(l.id, String(v))}>
              {bad ? <Button size="sm" variant="secondary" icon="trash-2" onClick={() => localCart.set(l.id, "0")}>إزالة</Button> : undefined}
            </LineCard>
          );
        })}
      </div>
      <div className="md-sec flex flex-col gap-2">
        {min != null && subtotal < min ? <MinProgress subtotal={subtotal} min={min} short={min - subtotal} /> : null}
        <SumRow label="الأصناف" big><Money value={subtotal} /></SumRow>
        <span className="text-13 text-ink-muted">رسم التوصيل يُحسب عند التأكيد بعد اعتماد المنشأة.</span>
        <Button block onClick={() => nav("/checkout")}>متابعة للتأكيد</Button>
      </div>
    </Screen>
  );
}

// ——— سلة الخادم ————————————————————————————————————————————————————————————————
function ServerCart() {
  const nav = useNavigate();
  const { me, isOwner, setCart, refresh } = useSession();
  const bv = useBranchVersion();
  const branches = useLoad(() => (isOwner ? approvedBranches(true) : Promise.resolve([] as BranchOut[])), [isOwner]);
  const cart = useLoad(async () => {
    const br = await cartBranchId(isOwner);
    return api.get<CartOut>(`/api/customer/cart${qs({ branch_id: br })}`);
  }, [bv, isOwner, branches.data]);
  const ready = useLoad(
    () => (isOwner ? api.get<ReadyCartOut[]>(`/api/customer/carts/ready`) : Promise.resolve([] as ReadyCartOut[])),
    [isOwner],
  );
  const [picking, setPicking] = useState(false);
  const [over, setOver] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const pending = useRef(new Set<number>());

  useEffect(() => { if (cart.data) setCart(cart.data); }, [cart.data]); // eslint-disable-line react-hooks/exhaustive-deps

  const purchaserConfirms = !isOwner && me.context?.ordering_mode === "owner_confirms";
  const many = (branches.data?.length ?? 0) > 1;

  async function setLine(c: CartOut, l: CartLineOut, v: number) {
    if (pending.current.has(l.catalog_item_id)) return;
    pending.current.add(l.catalog_item_id);
    try {
      const next = await api.put<CartOut>(`/api/customer/cart/items/${l.catalog_item_id}`, { qty: String(v), branch_id: c.branch?.id ?? null });
      cart.set(next);
      setCart(next);
      setOver(null);
    } catch (e) {
      if (e instanceof ApiError && e.code === "qty_exceeds_available") setOver(l.name_ar);
      else toast((e as Error).message, true);
    } finally {
      pending.current.delete(l.catalog_item_id);
    }
  }

  async function sendToOwner(c: CartOut) {
    setBusy("ready");
    try {
      const next = await api.post<CartOut>(`/api/customer/cart/ready`, { branch_id: c.branch?.id ?? null });
      cart.set(next);
      toast("أُرسلت السلة لصاحب المنشأة ليؤكدها");
    } catch (e) {
      toast((e as Error).message, true);
    } finally {
      setBusy(null);
    }
  }

  async function placeReady(rc: ReadyCartOut) {
    setBusy(`place-${rc.order_id}`);
    try {
      const o = await api.post<Order2Out>(`/api/customer/cart/place`, { branch_id: rc.branch_id });
      toast(`أُرسلت الطلبية #${o.id}`);
      refresh();
      nav(`/orders/${o.id}`);
    } catch (e) {
      toast((e as Error).message, true);
      ready.reload();
      cart.reload();
    } finally {
      setBusy(null);
    }
  }

  const readyList = ready.data ?? [];
  const readyPanel = readyList.length ? (
    <div className="flex flex-col gap-2">
      {readyList.map((rc) => {
        const current = cart.data?.branch?.id === rc.branch_id;
        return (
          <div key={rc.order_id} className="bg-warning-tint rounded-md p-3 text-14 leading-22 flex flex-col gap-1.5">
            <b>سلة جاهزة من {rc.branch_name}</b>
            <span className="text-13">
              {rc.prepared_by ? <>جهّزها {rc.prepared_by} </> : "جُهّزت "}
              <Num>{fmt.date(rc.ready_for_owner_at)}</Num> <Num>{fmt.time(rc.ready_for_owner_at)}</Num>
              {" · "}<Num>{rc.lines}</Num> أصناف · <Money value={rc.amount} size="sm" />
            </span>
            <div className="flex flex-col gap-2 pt-1">
              <Button icon="check" block loading={busy === `place-${rc.order_id}`} disabled={busy !== null}
                onClick={() => void placeReady(rc)}>تأكيد وإرسال الطلب</Button>
              {current ? <span className="text-13 text-ink-muted">تستطيع تعديل أسطرها أدناه قبل الإرسال.</span> : (
                <Button icon="pencil" variant="secondary" block onClick={() => chooseBranch(rc.branch_id)}>تعديل قبل الإرسال</Button>
              )}
            </div>
          </div>
        );
      })}
    </div>
  ) : null;

  const picker = many && cart.data?.branch ? (
    <button type="button" className="md-row-link bg-surface border border-border-strong text-start text-15 w-full cursor-pointer"
      onClick={() => setPicking(true)}>
      <Icon name="store" />
      <span className="flex-1">التوصيل إلى <b>{cart.data.branch.name}</b></span>
      <Icon name="chevron-left" size={18} />
    </button>
  ) : null;

  const dialog = (
    <Dialog open={picking} onClose={() => setPicking(false)} label="الفرع المستلم">
      <div className="flex flex-col gap-3">
        <b className="text-17">الفرع المستلم</b>
        {(branches.data ?? []).map((b) => (
          <Option key={b.id} label={b.name} sub={b.address_text} selected={b.id === cart.data?.branch?.id}
            onSelect={() => { chooseBranch(b.id); setPicking(false); }} />
        ))}
        <span className="text-13 text-ink-muted">الحد الأدنى ورسم التوصيل يُحسبان على الفرع المستلم.</span>
      </div>
    </Dialog>
  );

  if (cart.loading && !cart.data) return <Screen title="السلة"><LoadingState rows={4} /></Screen>;
  if (cart.error && !cart.data) {
    return (
      <Screen title="السلة">
        <div className="flex-1 flex flex-col justify-center">
          <ErrorState title={cart.error.message} code={cart.error.code} onRetry={cart.reload} />
        </div>
      </Screen>
    );
  }
  const c = cart.data as CartOut;

  if (!c.lines.length) {
    return (
      <Screen title={readyList.length ? "سلة بانتظارك" : "السلة"}>
        {readyPanel}
        {picker}
        <EmptyCart />
        {dialog}
      </Screen>
    );
  }

  const sub = Number(c.subtotal);
  const min = c.min_order_amount != null ? Number(c.min_order_amount) : null;
  const short = Number(c.below_min_by);
  const linesShort = c.min_order_lines != null && c.lines.length < c.min_order_lines;
  const bad = c.lines.filter((l) => !l.orderable);
  const total = sub + Number(c.delivery_fee ?? 0);
  const canGo = short <= 0 && !linesShort && !c.fee_error && c.delivery_fee != null && bad.length === 0 && !over;

  return (
    <Screen title={readyList.length ? "سلة بانتظارك" : "السلة"}>
      {readyPanel}
      {picker}
      {purchaserConfirms ? (
        <div className="bg-secondary-tint rounded-md p-3 text-14 leading-22 flex flex-col gap-1.5">
          {c.branch ? <b>{c.branch.name}</b> : null}
          <span className="text-13 text-ink-muted">سلتك يؤكدها صاحب المنشأة قبل أن تُرسل (إعداد منشأتكم).</span>
          {c.ready_for_owner_at ? (
            <span className="text-13">أرسلتها لصاحب المنشأة <Num>{fmt.dateTime(c.ready_for_owner_at)}</Num>. ما تعدّله الآن يصله كما هو.</span>
          ) : null}
        </div>
      ) : null}
      {bad.map((l) => (
        <Note key={`n-${l.catalog_item_id}`} tone="error">«{l.name_ar}» نفدت بعد إضافتها. أزلها أو اختر بديلاً لتكمل.</Note>
      ))}

      <div className="flex flex-col gap-2">
        {c.lines.map((l) => {
          const q = Number(l.qty);
          if (!l.orderable) {
            return (
              <div key={l.catalog_item_id} className="flex flex-col gap-1">
                <LineCard name={l.name_ar} unit={unitLabel(l.unit, l.unit_size)} total={null} qty={q} bad onQty={() => undefined}>
                  <Button size="sm" variant="secondary" icon="trash-2" onClick={() => void setLine(c, l, 0)}>إزالة</Button>
                </LineCard>
                <Link to={`/category/${l.category_id}`} className="md-link text-14">اختر بديلاً من التصنيف نفسه</Link>
              </div>
            );
          }
          return (
            <LineCard key={l.catalog_item_id} name={l.name_ar} unit={unitLabel(l.unit, l.unit_size)} total={l.line_total} qty={q}
              onQty={(v) => void setLine(c, l, v)} />
          );
        })}
      </div>

      {over ? <Note tone="error"><b>{over}:</b> الكمية أكبر من المتاح الآن. خفّض الكمية لتتابع.</Note> : null}
      {many ? <span className="text-13 text-ink-muted">الحد الأدنى ورسم التوصيل يُحسبان على الفرع المستلم.</span> : null}
      {Number(c.credit) > 0 ? <Note tone="success">لك رصيد لدى مَدَد: <Money value={c.credit} /></Note> : null}

      <div className="md-sec flex flex-col gap-2">
        {min != null && short > 0 ? <MinProgress subtotal={sub} min={min} short={short} /> : <SumRow label="الأصناف"><Money value={c.subtotal} /></SumRow>}
        {linesShort ? <Note tone="warning">الحد الأدنى <Num>{c.min_order_lines}</Num> أصناف في الطلبية.</Note> : null}
        {c.fee_error ? <Note tone="warning">{arabicError(c.fee_error)}</Note>
          : <SumRow label="رسم التوصيل">{c.delivery_fee != null ? <Money value={c.delivery_fee} /> : <span className="text-ink-muted">—</span>}</SumRow>}
        <SumRow label="الإجمالي" big><Money value={total} /></SumRow>
        {min != null && short <= 0 ? (
          <span className="text-13 text-success-text flex gap-1.5 items-center">
            <Icon name="circle-check" size={16} />تجاوزت الحد الأدنى للطلبية (<Num>{fmt.money(min)}</Num> د.ل)
          </span>
        ) : null}
        {purchaserConfirms ? (
          <Button block icon="send" loading={busy === "ready"} disabled={!canGo || busy !== null} onClick={() => void sendToOwner(c)}>
            أرسل لصاحب المنشأة ليؤكد
          </Button>
        ) : (
          <Button block disabled={!canGo} onClick={() => nav("/checkout")}>متابعة للتأكيد</Button>
        )}
        {short > 0 ? <Link to="/" className="md-link text-15 text-center">أكمل التسوق</Link> : null}
      </div>
      {dialog}
    </Screen>
  );
}
