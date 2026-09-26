/**
 * 02 المسار (M-2): الخريطة ونقاط الاستلام بترتيبها (الاسم حسب إعداد المالك يصل في label وحدها)، والوجهة والمبلغ،
 * والملاحة إلى النقطة التالية (أول ضغطة تبدأ الجمع: POST /start)، ثم الدفعة والتسليم بعد اكتمال النقاط.
 */
import { useNavigate, useParams } from "react-router-dom";

import { Button, EmptyState, ErrorState, Icon, LoadingState, Money, Note, Num, StatusBadge, type Tone, useLoad } from "@ui/kit";
import * as fmt from "@ui/fmt";
import { api } from "@/api/client";
import type { Order2Out } from "@/api/types";
import { Screen } from "@/lib/shell";
import { availableFor, downloadSheet, navUrl, openBatch, stopStates, type StopState, useWork } from "@/lib/work-http";
import { RouteMap } from "@/lib/work-ui";
import { useSession } from "@/session";

const STATE: Record<StopState, [string, Tone]> = {
  done: ["استُلمت", "success"], next: ["التالية", "info"], todo: ["بعدها", "neutral"], cancelled: ["أُلغيت", "neutral"],
};
const DONE_LABEL: Record<string, string> = { collected: "استُلمت", short: "ناقصة", refused: "مرفوضة" };

export function Route() {
  const { orderId } = useParams();
  const { current } = useSession();
  const nav = useNavigate();
  const id = orderId ? Number(orderId) : current?.id ?? null;
  if (id == null) {
    return (
      <Screen title="المسار" back="/">
        <EmptyState icon="navigation" title="لا طلبية جارية" body="اقبل طلباً من الرئيسية ليظهر مساره ونقاط استلامه هنا."
          action={<Button variant="secondary" icon="house" onClick={() => nav("/")}>الطلبيات المتاحة</Button>} />
      </Screen>
    );
  }
  return <RouteOf id={id} />;
}

function RouteOf({ id }: { id: number }) {
  const nav = useNavigate();
  const { refresh } = useSession();
  const order = useLoad(() => api.get<Order2Out>(`/api/driver/orders/${id}`), [id]);
  const { busy, run } = useWork();
  const pdf = useWork();
  const title = <>الطلبية <Num>#{id}</Num></>;

  if (order.loading && !order.data) {
    return (
      <Screen title={title} back="/" flush>
        <span className="md-skel h-chart w-full block" />
        <div className="px-4"><LoadingState rows={4} /></div>
      </Screen>
    );
  }
  if (order.error || !order.data) {
    return (
      <Screen title={title} back="/">
        <ErrorState title="تعذّر تحميل الطلبية" body="تحقق من الاتصال. الطلبية محفوظة لك." code={order.error?.code} onRetry={order.reload} />
      </Screen>
    );
  }
  const o = order.data;
  const states = stopStates(o.stops);
  const stops = [...o.stops].sort((a, b) => a.seq - b.seq).filter((s) => s.status !== "cancelled");
  const next = stops.find((s) => states.get(s.id) === "next") ?? null;
  const allDone = next == null;
  const batch = openBatch(o);
  const canCompose = o.items.some((it) => availableFor(o, it) > 0);
  const finished = o.status === "delivered";

  async function go() {
    if (!next) return;
    const url = navUrl(next.lat, next.lng, next.address_text);
    if (url) window.open(url, "_blank", "noopener");
    if (o.status === "assigned") {
      const r = await run(() => api.post<Order2Out>(`/api/driver/orders/${o.id}/start`));
      if (r.v) { order.set(r.v); refresh(); }
    }
  }
  const destUrl = navUrl(o.dest_lat, o.dest_lng, o.dest_address);

  return (
    <Screen title={title} back="/" flush>
      <RouteMap label={`خريطة المسار: ${stops.length} نقاط استلام مرقّمة ثم وجهة التسليم`} dest={{ lat: o.dest_lat, lng: o.dest_lng }}
        pins={stops.map((s) => ({ key: s.id, n: String(s.seq), lat: s.lat, lng: s.lng, tone: states.get(s.id) ?? "todo" }))} />
      <div className="px-4 flex flex-col gap-2">
        {stops.map((s) => {
          const st = states.get(s.id) ?? "todo";
          const [label, tone] = STATE[st];
          return (
            <button key={s.id} type="button" className="md-sec p-3 text-start cursor-pointer" onClick={() => nav(`/stops/${s.id}`)}>
              <span className="flex items-center gap-3">
                <StopDot n={String(s.seq)} state={st} />
                <span className="flex flex-col flex-1 min-w-0">
                  <b className="text-15">{s.label}</b>
                  <span className="text-13 md-muted">{s.address_text ?? "بلا عنوان مكتوب"} · <Num>{s.lines.length}</Num> صنف</span>
                </span>
                <StatusBadge tone={tone}>{st === "done" ? DONE_LABEL[s.status] ?? label : label}</StatusBadge>
              </span>
            </button>
          );
        })}
        <div className="md-sec p-3 flex-row items-center gap-3">
          <span className="w-8 h-8 rounded-full bg-white text-primary grid place-items-center flex-none"><Icon name="map-pin" size={18} /></span>
          <span className="flex flex-col flex-1 min-w-0">
            <b className="text-15">{o.customer_name} — {o.branch_name}</b>
            <span className="text-13 md-muted">التسليم{o.dest_address ? ` · ${o.dest_address}` : ""} · تحصّل <Money value={o.amount_to_collect} size="sm" /></span>
          </span>
          <StatusBadge tone="primary">الوجهة</StatusBadge>
        </div>

        {finished ? <Note tone="success">سُلِّمت هذه الطلبية كاملة. أجرك <Money value={o.driver_pay} size="sm" />.</Note> : null}

        {!finished && next ? (
          <Button block className="md-btn-xl" icon="navigation" loading={busy} onClick={go}>
            ابدأ الملاحة إلى النقطة <Num>{next.seq}</Num>
          </Button>
        ) : null}
        {!finished && next ? (
          <Button variant="secondary" block icon="qr-code" onClick={() => nav(`/stops/${next.id}`)}>وصلت؟ تأكيد الاستلام</Button>
        ) : null}

        {!finished && batch ? (
          batch.status === "departed"
            ? <Button block className="md-btn-xl" icon="check" onClick={() => nav(`/orders/${o.id}/delivery`)}>التسليم — الدفعة <Num>{batch.seq}</Num></Button>
            : <Button block className="md-btn-xl" icon="truck" onClick={() => nav(`/orders/${o.id}/batch`)}>متابعة الدفعة <Num>{batch.seq}</Num></Button>
        ) : !finished && canCompose ? (
          <Button block variant={allDone ? "primary" : "secondary"} className={allDone ? "md-btn-xl" : undefined} icon="truck"
            onClick={() => nav(`/orders/${o.id}/batch`)}>
            {allDone ? "جهّز الدفعة للتسليم" : "دفعة الآن بما استلمته"}
          </Button>
        ) : null}

        {!finished && allDone && destUrl ? (
          <a className="md-btn md-btn-secondary md-btn-block" href={destUrl} target="_blank" rel="noopener noreferrer">
            <Icon name="navigation" size={18} />الملاحة إلى العميل
          </a>
        ) : null}

        <div className="grid grid-cols-2 gap-2">
          <a className="md-btn md-btn-ghost" href={`tel:${o.customer_phone}`}>
            <Icon name="phone" size={18} />اتصال بالعميل
          </a>
          <Button variant="ghost" icon="file-text" loading={pdf.busy}
            onClick={() => pdf.run(() => downloadSheet(o.id))}>ورقة الطلبية PDF</Button>
        </div>
        <span className="text-13 md-muted text-center"><Num>{fmt.phoneLocal(o.customer_phone)}</Num></span>
      </div>
    </Screen>
  );
}

function StopDot({ n, state }: { n: string; state: StopState }) {
  const c = state === "done" ? "bg-success text-primary" : state === "next" ? "bg-secondary text-primary" : "border-2 border-border-strong text-ink";
  return <span className={`md-num w-8 h-8 rounded-full grid place-items-center font-bold flex-none ${c}`}>{n}</span>;
}
