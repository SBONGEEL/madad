/** 06 تأكيد الطلبية: مراجعة السلة، وملاحظة التوصيل، والدفع نقداً عند الاستلام، ثم التأكيد وحفظها قائمة متكررة. */
import { type ReactNode, useState } from "react";
import { useNavigate } from "react-router-dom";

import { qs } from "@ui/client";
import { arabicError } from "@ui/errors";
import * as fmt from "@ui/fmt";
import { Button, Dialog, EmptyState, ErrorState, Icon, LoadingState, Money, Note, Num, TextField, useAction, useLoad } from "@ui/kit";
import { api } from "@/api/client";
import type { CartOut, ListDetailOut, Order2Out } from "@/api/types";
import { cartBranchId, SumRow, useBranchVersion } from "@/lib/cat-cart";
import { Screen } from "@/lib/shell";
import { useSession } from "@/session";

export function Checkout() {
  const { approved, me } = useSession();
  const [placed, setPlaced] = useState<Order2Out | null>(null);
  if (placed) return <Placed order={placed} />;
  if (!approved) {
    return (
      <Screen title="تأكيد الطلبية">
        <div className="flex-1 flex flex-col justify-center">
          <ErrorState title="لا طلب قبل اعتماد المنشأة" code="party_not_approved"
            body={`نراجع بيانات «${me.customer?.name ?? ""}». سلتك محفوظة، وتستطيع الطلب فور الاعتماد.`} />
        </div>
      </Screen>
    );
  }
  return <Review onPlaced={setPlaced} />;
}

function Section({ children }: { children: ReactNode }) {
  return <section className="bg-surface border border-border rounded-lg p-3.5 flex gap-2.5 items-start">{children}</section>;
}

function Review({ onPlaced }: { onPlaced: (o: Order2Out) => void }) {
  const nav = useNavigate();
  const { me, isOwner, refresh } = useSession();
  const bv = useBranchVersion();
  const cart = useLoad(async () => {
    const br = await cartBranchId(isOwner);
    return api.get<CartOut>(`/api/customer/cart${qs({ branch_id: br })}`);
  }, [bv, isOwner]);
  const [notes, setNotes] = useState("");
  const [recipient, setRecipient] = useState<string | null>(null);
  const { busy, run } = useAction();
  const purchaserConfirms = !isOwner && me.context?.ordering_mode === "owner_confirms";

  if (cart.loading && !cart.data) return <Screen title="تأكيد الطلبية"><LoadingState rows={3} /></Screen>;
  if (cart.error || !cart.data) {
    return (
      <Screen title="تأكيد الطلبية">
        <div className="flex-1 flex flex-col justify-center">
          <ErrorState title={cart.error?.message} code={cart.error?.code} onRetry={cart.reload} />
        </div>
      </Screen>
    );
  }
  const c = cart.data;
  if (!c.lines.length) {
    return (
      <Screen title="تأكيد الطلبية">
        <div className="flex-1 flex flex-col justify-center">
          <EmptyState icon="shopping-cart" title="سلتك فارغة" body="أضف أصنافاً ثم عد لتأكيد الطلبية."
            action={<Button size="sm" onClick={() => nav("/cart")}>السلة</Button>} />
        </div>
      </Screen>
    );
  }

  const bad = c.lines.some((l) => !l.orderable);
  const short = Number(c.below_min_by) > 0 || (c.min_order_lines != null && c.lines.length < c.min_order_lines);
  const total = Number(c.subtotal) + Number(c.delivery_fee ?? 0);
  const blocked = bad || short || !!c.fee_error || c.delivery_fee == null;
  const branchId = c.branch?.id ?? null;
  const note = notes.trim() || null;
  // المستلم الافتراضي للفرع حتى يغيّره المستخدم لهذه الطلبية
  const who = recipient ?? c.branch?.default_recipient ?? "";

  async function place() {
    const o = await run(() => api.post<Order2Out>(`/api/customer/cart/place`, { branch_id: branchId, notes: note, recipient_name: who.trim() || null }));
    if (o) {
      refresh();
      onPlaced(o);
    } else {
      cart.reload();
    }
  }

  async function sendToOwner() {
    const r = await run(() => api.post<CartOut>(`/api/customer/cart/ready`, { branch_id: branchId, notes: note }),
      "أُرسلت السلة لصاحب المنشأة ليؤكدها");
    if (r) nav("/cart");
  }

  return (
    <Screen title="تأكيد الطلبية">
      <Section>
        <Icon name="map-pin" />
        <div className="flex flex-col gap-0.5 flex-1">
          <span className="font-bold">التوصيل إلى {c.branch?.name ?? me.customer?.name}</span>
          {c.branch?.address_text ? <span className="text-14 text-ink-muted">{c.branch.address_text}</span> : null}
        </div>
      </Section>
      <section className="bg-surface border border-border rounded-lg p-3.5 flex flex-col gap-2">
        <span className="font-bold"><Num>{c.lines.length}</Num> {c.lines.length === 1 ? "صنف" : "أصناف"}</span>
        <span className="text-14 text-ink-muted">
          {c.lines.map((l, i) => (
            <span key={l.catalog_item_id}>{i ? " · " : ""}{l.name_ar} ×<Num>{fmt.qty(l.qty)}</Num></span>
          ))}
        </span>
      </section>
      <Section>
        <Icon name="banknote" />
        <span className="flex-1 font-bold">الدفع نقداً عند الاستلام</span>
      </Section>
      <TextField label="مستلم الطلبية في الفرع (اختياري)" icon="user" value={who} onChange={setRecipient}
        hint="المستلم الافتراضي للفرع — غيّره لهذه الطلبية فقط إن شئت" />
      <TextField label="ملاحظة للتوصيل (اختياري)" placeholder="مثال: الباب الخلفي بعد 10 صباحاً" value={notes} onChange={setNotes} multiline />

      <div className="flex flex-col gap-1.5">
        <SumRow label="الأصناف"><Money value={c.subtotal} /></SumRow>
        {c.fee_error ? <Note tone="warning">{arabicError(c.fee_error)}</Note>
          : <SumRow label="رسم التوصيل">{c.delivery_fee != null ? <Money value={c.delivery_fee} /> : <span className="text-ink-muted">—</span>}</SumRow>}
        <SumRow label="الإجمالي" big><Money value={total} size="lg" /></SumRow>
        {Number(c.credit) > 0 ? <span className="text-13 text-ink-muted">لك رصيد لدى مَدَد: <Money value={c.credit} size="sm" /></span> : null}
        <span className="text-13 text-ink-muted">الأسعار محجوزة لحظة التأكيد. تستطيع التعديل حتى يؤكد مَدَد الطلبية.</span>
      </div>
      {bad ? <Note tone="error">في السلة صنف لم يعد متاحاً. أزله من السلة لتكمل.</Note> : null}
      {short ? <Note tone="warning">السلة أقل من الحد الأدنى للطلبية. أكمل من السلة.</Note> : null}

      {purchaserConfirms ? (
        <>
          <Note tone="info">سلتك يؤكدها صاحب المنشأة قبل أن تُرسل (إعداد منشأتكم).</Note>
          <Button block icon="send" loading={busy} disabled={blocked} onClick={() => void sendToOwner()}>أرسل لصاحب المنشأة ليؤكد</Button>
        </>
      ) : (
        <Button block loading={busy} disabled={blocked} onClick={() => void place()}>{busy ? "جاري إرسال الطلبية" : "تأكيد الطلبية"}</Button>
      )}
      {blocked ? <Button block variant="ghost" onClick={() => nav("/cart")}>العودة للسلة</Button> : null}
    </Screen>
  );
}

function Placed({ order }: { order: Order2Out }) {
  const nav = useNavigate();
  const [asking, setAsking] = useState(false);
  const [name, setName] = useState("");
  const [saved, setSaved] = useState(false);
  const { busy, run } = useAction();
  const waiting = order.status === "placed";

  async function save() {
    const r = await run(() => api.post<ListDetailOut>(`/api/customer/lists`, { name: name.trim(), from_order_id: order.id }),
      "حُفظت في «قوائمي»");
    if (r) {
      setSaved(true);
      setAsking(false);
    }
  }

  return (
    <main className="md-mobile-main items-center text-center pt-12">
      <span className="rounded-full bg-success text-white p-5 grid place-items-center"><Icon name="check" size={36} /></span>
      <h1 className="m-0 text-26 font-bold">أُرسلت الطلبية <Num>#{order.id}</Num></h1>
      <span className="text-16 text-ink-muted">
        {waiting ? "نؤكدها خلال دقائق ونبلغك. تستطيع تعديلها حتى ذلك الحين." : "أكّدنا طلبيتك، ونبلغك بكل خطوة حتى تصلك."}
      </span>
      <div className="w-full bg-surface border border-border rounded-lg p-3.5 flex justify-between items-center">
        <span>المبلغ عند الاستلام</span><Money value={order.amount_due ?? order.total} />
      </div>
      <div className="w-full mt-auto flex flex-col gap-2">
        <Button block onClick={() => nav(`/orders/${order.id}`)}>تتبّع الطلبية</Button>
        <Button block variant="secondary" icon="repeat" disabled={saved} onClick={() => { setName(`طلبية ${order.id}`); setAsking(true); }}>
          {saved ? "حُفظت قائمة متكررة" : "احفظها قائمة متكررة"}
        </Button>
      </div>
      <Dialog open={asking} onClose={() => setAsking(false)} label="احفظها قائمة متكررة">
        <div className="flex flex-col gap-3 text-start">
          <b className="text-17">احفظها قائمة متكررة</b>
          <TextField label="اسم القائمة" value={name} onChange={setName} placeholder="مثال: طلب السبت" autoFocus />
          <span className="text-13 text-ink-muted">تجدها في «الطلبات» ← «قوائمي»، وتضبط لها تذكيراً من هناك.</span>
          <Button block loading={busy} disabled={!name.trim()} onClick={() => void save()}>احفظ</Button>
          <Button block variant="ghost" onClick={() => setAsking(false)}>إلغاء</Button>
        </div>
      </Dialog>
    </main>
  );
}
