/**
 * 01 الطلبيات المتاحة وطلب جديد (M-18) + تنبيه الحمولة (05ب، M-9/M-13).
 * الطلبية الجارية أولاً إن وُجدت، ثم «طلب جديد» لكل طلبية متاحة: الأجر التقديري والمبلغ الذي تحصّله والحمولة،
 * وقبول بزر أخضر الأفعال، أو عرض أجرة مختلفة يقررها المالك. فوق سقف الكاش: الإسناد موقوف حتى التسوية.
 */
import { useState } from "react";
import { useNavigate } from "react-router-dom";

import { Button, Dialog, EmptyState, ErrorState, Icon, LoadingState, Money, Note, Num, StatusBadge, TextField, useLoad } from "@ui/kit";
import * as fmt from "@ui/fmt";
import { api } from "@/api/client";
import type { AvailableOut, Order2Out, WalletOut } from "@/api/types";
import { HomeHeader } from "@/lib/shell";
import { useWork } from "@/lib/work-http";
import { NotApproved, RouteMap } from "@/lib/work-ui";
import { useSession } from "@/session";

const CURRENT_STATUS: Record<string, string> = { assigned: "أُسندت إليك", collecting: "يجري الجمع", partially_delivered: "وصل جزء" };

export function Main() {
  const { approved, current } = useSession();
  return (
    <>
      <HomeHeader />
      <main className="md-mobile-main">
        {!approved ? <NotApproved /> : (
          <>
            {current ? <CurrentCard id={current.id} name={current.customer_name} branch={current.branch_name}
              status={current.status} amount={current.amount_to_collect} /> : null}
            <Available />
          </>
        )}
      </main>
    </>
  );
}

function CurrentCard({ id, name, branch, status, amount }: { id: number; name: string; branch: string; status: string; amount: string }) {
  const nav = useNavigate();
  return (
    <button type="button" className="md-sec text-start cursor-pointer" onClick={() => nav(`/route/${id}`)}>
      <div className="flex justify-between items-center gap-2">
        <b className="text-17">طلبيتك الجارية <Num>#{id}</Num></b>
        <StatusBadge tone="info">{CURRENT_STATUS[status] ?? status}</StatusBadge>
      </div>
      <span className="text-15">التوصيل إلى <b>{name} — {branch}</b></span>
      <div className="flex justify-between items-center text-14">
        <span className="md-muted">تحصّله من العميل</span><Money value={amount} />
      </div>
      <span className="flex items-center gap-1 text-14 font-bold text-secondary">افتح المسار<Icon name="chevron-left" size={16} /></span>
    </button>
  );
}

function Available() {
  const nav = useNavigate();
  const { refresh, me } = useSession();
  const list = useLoad(() => api.get<AvailableOut[]>(`/api/driver/available`));
  const wallet = useLoad(() => api.get<WalletOut>(`/api/driver/wallet`));
  const [capHit, setCapHit] = useState(false);
  const [offerFor, setOfferFor] = useState<AvailableOut | null>(null);
  const { busy, run } = useWork();
  const [accepting, setAccepting] = useState<number | null>(null);

  async function accept(o: AvailableOut) {
    setAccepting(o.id);
    const r = await run(() => api.post<Order2Out>(`/api/driver/orders/${o.id}/accept`), { ok: "قبلت الطلب. ابدأ بالنقطة الأولى.", inline: ["driver_cash_cap_exceeded"] });
    setAccepting(null);
    if (r.code === "driver_cash_cap_exceeded") { setCapHit(true); wallet.reload(); return; }
    if (r.code) { list.reload(); return; }
    refresh();
    nav(`/route/${o.id}`);
  }

  const w = wallet.data;
  if ((capHit || w?.over_cap) && w) {
    return (
      <ErrorState compact title="الإسناد موقوف حتى التسوية"
        body={`بحوزتك ${fmt.money(w.cash_held)} د.ل والسقف ${w.cash_cap ? fmt.money(w.cash_cap) : "—"}. سلّم الكاش للخزينة لتستقبل طلبيات.`}
        code="driver_cash_cap_exceeded" retryLabel="المحفظة" onRetry={() => nav("/wallet")} />
    );
  }
  if (list.loading && !list.data) return <LoadingState rows={2} />;
  if (list.error && !list.data) {
    return <ErrorState compact title="تعذّر تحميل الطلبيات" body="تحقق من الاتصال ثم أعد المحاولة." code={list.error.code} onRetry={list.reload} />;
  }
  const rows = list.data ?? [];
  if (!rows.length) {
    return <EmptyState icon="truck" title="لا طلبيات متاحة الآن" body={`ابقَ متصلاً. تصلك الطلبية الجديدة في ${me.driver?.city_name ?? "مدينتك"} بإشعار وصوت.`} />;
  }
  return (
    <>
      {rows.map((o, i) => (
        <div key={o.id} className="flex flex-col">
          {i === 0 ? (
            <RouteMap label={`خريطة المسار: ${o.stops} نقاط استلام مرقّمة ثم وجهة التسليم`}
              pins={Array.from({ length: o.stops }, (_, k) => ({ key: k, n: String(k + 1), lat: null, lng: null, tone: "todo" as const }))}
              dest={null} />
          ) : null}
          <OrderCard o={o} busy={busy && accepting === o.id} disabled={busy} onAccept={() => accept(o)} onOffer={() => setOfferFor(o)} />
        </div>
      ))}
      <OfferDialog o={offerFor} onClose={() => setOfferFor(null)} onDone={(next) => { list.set(next); setOfferFor(null); }} />
    </>
  );
}

const OFFER: Record<string, { label: string; tone: "info" | "error" | "neutral" | "success" }> = {
  pending: { label: "بانتظار قرار مَدَد", tone: "info" },
  rejected: { label: "رُفض عرضك", tone: "error" },
  withdrawn: { label: "سُحب العرض", tone: "neutral" },
  accepted: { label: "قُبل عرضك", tone: "success" },
};

function OrderCard({ o, busy, disabled, onAccept, onOffer }: {
  o: AvailableOut; busy: boolean; disabled: boolean; onAccept: () => void; onOffer: () => void;
}) {
  const offer = o.my_offer as { id?: number; amount?: string; status?: string } | null;
  const pendingOffer = offer?.status === "pending";
  return (
    <div data-theme="light" className="md-sheet shadow-sheet" style={{ borderRadius: "var(--radius-lg)" }}>
      <div className="flex justify-between items-center gap-2">
        <b className="text-19">طلب جديد</b>
        <StatusBadge tone="info"><Num>{o.stops}</Num> نقاط استلام</StatusBadge>
      </div>
      <span className="text-15">توصيل إلى <b>{o.customer_name} — {o.branch_name}</b></span>
      {o.dest_address ? (
        <span className="flex items-center gap-1 text-14 md-muted"><Icon name="map-pin" size={16} />{o.dest_address}</span>
      ) : null}
      <div className="flex gap-3 text-14 md-muted">
        {o.route_km ? <span><Num>{fmt.qty(o.route_km)}</Num> كم</span> : <span>المسافة لم تُحدَّد بعد</span>}
      </div>
      <Load o={o} />
      <div className="grid grid-cols-2 gap-2 text-14">
        <div className="bg-page rounded-md p-2 flex flex-col">
          <span className="text-12 md-muted">أجرك</span>
          {o.pay_estimate ? <Money value={o.pay_estimate} /> : <span className="font-bold">—</span>}
        </div>
        <div className="bg-page rounded-md p-2 flex flex-col">
          <span className="text-12 md-muted">تحصّله من العميل</span>
          <Money value={o.amount_to_collect} />
        </div>
      </div>
      {!o.pay_estimate ? <Note tone="info">لم يحدد مَدَد مسافة هذه الطلبية بعد، فلا أجر محسوباً لها. يُفتح القبول حين تُحدَّد.</Note> : null}
      {offer?.status && OFFER[offer.status] ? (
        <div className="flex items-center gap-2 text-14">
          <StatusBadge tone={OFFER[offer.status]?.tone}>{OFFER[offer.status]?.label}</StatusBadge>
          <span>عرضك <Money value={offer.amount ?? 0} size="sm" /></span>
        </div>
      ) : null}
      <Button variant="success" block className="md-btn-xl" icon="check" loading={busy} disabled={disabled || !o.pay_estimate}
        onClick={onAccept}>قبول الطلب</Button>
      <button type="button" className="md-link text-center text-14" disabled={disabled || pendingOffer} onClick={onOffer}>
        {pendingOffer ? "عرضك قيد القرار" : "اعرض أجرة مختلفة"}
      </button>
    </div>
  );
}

/** تنبيه الحمولة (M-13): فوق السعة، أو ضمنها، وأصناف بلا وزن مسجّل. */
function Load({ o }: { o: AvailableOut }) {
  return (
    <>
      {o.over_capacity ? (
        <Note tone="warning">
          <b className="flex items-center gap-1"><Icon name="triangle-alert" size={16} />الحمولة أكبر من سعة مركبتك</b>
          الطلبية <Num>{fmt.qty(o.load_kg)}</Num> كغ، وسعة مركبتك <Num>{fmt.qty(o.capacity_kg)}</Num> كغ. قسّمها دفعتين.
        </Note>
      ) : o.capacity_kg ? (
        <Note tone="success">
          <b className="flex items-center gap-1"><Icon name="circle-check" size={16} />الحمولة <Num>{fmt.qty(o.load_kg)}</Num> كغ من <Num>{fmt.qty(o.capacity_kg)}</Num></b>
        </Note>
      ) : null}
      {!o.weight_complete ? <Note tone="info">أصناف بلا وزن مسجّل — الحمولة قد تكون أكثر.</Note> : null}
    </>
  );
}

function OfferDialog({ o, onClose, onDone }: { o: AvailableOut | null; onClose: () => void; onDone: (l: AvailableOut[]) => void }) {
  const [amount, setAmount] = useState("");
  const { busy, run } = useWork();
  const valid = fmt.isMoney(amount) && Number(amount) > 0;
  async function send() {
    if (!o || !valid) return;
    const r = await run(() => api.post<AvailableOut[]>(`/api/driver/orders/${o.id}/pay-offers`, { amount: amount.trim() }),
      { ok: "أُرسل عرضك. يقرره مَدَد، وقبوله يُسند الطلبية إليك." });
    if (r.v) { setAmount(""); onDone(r.v); }
  }
  return (
    <Dialog open={o != null} onClose={onClose} label="اعرض أجرة مختلفة">
      <div className="md-dialog-title">اعرض أجرة مختلفة</div>
      <div className="md-dialog-body">
        {o?.pay_estimate ? <>الأجر المحسوب <Money value={o.pay_estimate} size="sm" />. </> : null}
        يقرر مَدَد عرضك؛ وقبوله يُسند الطلبية إليك.
      </div>
      <TextField label="الأجرة التي تطلبها" value={amount} onChange={setAmount} numeric suffix="د.ل" placeholder="0.000"
        error={amount && !valid ? "اكتب مبلغاً صحيحاً بثلاث خانات على الأكثر." : null} />
      <div className="md-dialog-actions">
        <Button block loading={busy} disabled={!valid} onClick={send}>أرسل العرض</Button>
        <Button variant="ghost" block onClick={onClose}>إلغاء</Button>
      </div>
    </Dialog>
  );
}
