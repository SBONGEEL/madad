/**
 * 10 النزاع وقراره (م-10): نوع المشكلة والصنف والتفاصيل وصورة تسرّع القرار، ثم «قيد المراجعة» حتى يقرر مَدَد:
 * رصيد يُخصم من الطلبية القادمة أو إعادة نقدية مع السائق. لا يظهر للعميل من يتحمّل الخسارة.
 */
import { useRef, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";

import { ApiError } from "@ui/client";
import {
  Button, ErrorState, Icon, LoadingState, Money, Note, Num, Select, StatusBadge, TextField, cx, toast, useLoad,
} from "@ui/kit";
import { api } from "@/api/client";
import type { DisputeOut, Order2Out } from "@/api/types";
import { post } from "@/lib/ord-http";
import { unitLabel, whenLabel } from "@/lib/ord-shared";
import { Screen } from "@/lib/shell";

type Kind = "damaged" | "short" | "refused" | "other";
const KINDS: Array<{ value: Kind; label: string }> = [
  { value: "damaged", label: "صنف تالف" }, { value: "short", label: "كمية ناقصة" },
  { value: "refused", label: "رفضت الاستلام" }, { value: "other", label: "أخرى" },
];
const RESOLUTION: Record<string, string> = {
  partial_discount: "خصم جزئي", return: "إرجاع الصنف", cancel: "إلغاء الصنف", no_action: "لا إجراء",
};
const MAX_PHOTOS = 3;

export function Dispute() {
  const { orderId = "" } = useParams();
  const order = useLoad(() => api.get<Order2Out>(`/api/customer/orders/${orderId}`), [orderId]);
  const disputes = useLoad(() => api.get<DisputeOut[]>(`/api/customer/orders/${orderId}/disputes`), [orderId]);
  const [mode, setMode] = useState<"auto" | "form" | "view">("auto");
  const [shownId, setShownId] = useState<number | null>(null);
  const title = <>مشكلة في الطلبية <Num>#{orderId}</Num></>;

  if ((order.loading && !order.data) || (disputes.loading && !disputes.data)) {
    return <Screen title={title} back={`/orders/${orderId}`}><LoadingState rows={3} /></Screen>;
  }
  const failed = order.error ?? disputes.error;
  if (!order.data || !disputes.data) {
    return (
      <Screen title={title} back={`/orders/${orderId}`}>
        <ErrorState title="تعذّر التحميل" body={failed?.message} code={failed?.code}
          onRetry={() => { order.reload(); disputes.reload(); }} />
      </Screen>
    );
  }

  const list = disputes.data;
  const view = mode === "view" || (mode === "auto" && list.length > 0);
  const shown = list.find((d) => d.id === shownId) ?? list[0];

  return (
    <Screen title={title} back={`/orders/${orderId}`}>
      {view && shown ? (
        <DisputeState order={order.data} d={shown} others={list.filter((d) => d.id !== shown.id)}
          onShow={setShownId} onNew={() => setMode("form")} />
      ) : (
        <DisputeForm order={order.data} existing={list}
          onSent={(rows) => { disputes.set(rows); setShownId(rows[0]?.id ?? null); setMode("view"); }}
          onShow={(id) => { setShownId(id); setMode("view"); }} />
      )}
    </Screen>
  );
}

// ——— النموذج ————————————————————————————————————————————————————————————————
function DisputeForm({ order, existing, onSent, onShow }: {
  order: Order2Out; existing: DisputeOut[]; onSent: (rows: DisputeOut[]) => void; onShow: (id: number) => void;
}) {
  const fileRef = useRef<HTMLInputElement>(null);
  const [kind, setKind] = useState<Kind>("damaged");
  const [itemId, setItemId] = useState(String(order.lines[0]?.id ?? ""));
  const [details, setDetails] = useState("");
  const [photos, setPhotos] = useState<Array<{ id: number; name: string }>>([]);
  const [uploading, setUploading] = useState(false);
  const [sending, setSending] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [conflict, setConflict] = useState<DisputeOut | { item: string | null; id: null } | null>(null);

  const options = [
    ...order.lines.map((l) => ({ value: String(l.id), label: `${l.name_ar} — ${unitLabel(l.unit, l.unit_size)}` })),
    { value: "", label: "الطلبية كلها (بلا صنف محدد)" },
  ];

  const upload = async (file: File | undefined) => {
    if (!file) return;
    setUploading(true);
    setErr(null);
    try {
      const form = new FormData();
      form.append("purpose", "dispute_photo");
      form.append("file", file);
      const m = await post("/api/customer/media", form);
      setPhotos((p) => [...p, { id: m.id, name: file.name }]);
    } catch (e) {
      toast((e as Error).message, true);
    } finally {
      setUploading(false);
      if (fileRef.current) fileRef.current.value = "";
    }
  };

  const send = async () => {
    setErr(null);
    if (!details.trim()) return setErr("اكتب ما حدث باختصار.");
    setSending(true);
    try {
      const rows = await api.post<DisputeOut[]>(`/api/customer/orders/${order.id}/disputes`, {
        order_item_id: itemId ? Number(itemId) : null, kind, description: details.trim(), media_ids: photos.map((p) => p.id),
      });
      toast("وصلنا بلاغك.");
      onSent(rows);
    } catch (e) {
      if (e instanceof ApiError && (e.code === "dispute_open_per_item" || e.code === "dispute_already_open")) {
        const open = existing.find((d) => d.status === "open" && String(d.order_item_id ?? "") === itemId);
        const line = order.lines.find((l) => String(l.id) === itemId);
        setConflict(open ?? { item: line?.name_ar ?? null, id: null });
      } else setErr((e as Error).message);
    } finally {
      setSending(false);
    }
  };

  if (conflict) {
    return (
      <div className="flex-1 flex flex-col justify-center gap-3">
        <ErrorState title="بلاغ مفتوح لهذا الصنف" code="dispute_already_open"
          body={`أرسلت بلاغاً عن «${conflict.item ?? "هذا الصنف"}»${"created_at" in conflict ? ` (${whenLabel(conflict.created_at)})` : ""}، وهو قيد المراجعة.`} />
        {conflict.id !== null ? <Button block variant="secondary" onClick={() => onShow(conflict.id)}>عرض البلاغ</Button> : null}
        <Button block variant="ghost" onClick={() => setConflict(null)}>اختر صنفاً آخر</Button>
      </div>
    );
  }

  return (
    <>
      <div className="flex flex-col gap-1.5">
        <span className="text-14 font-medium">ما المشكلة؟</span>
        <div role="radiogroup" className="grid grid-cols-2 gap-2">
          {KINDS.map((k) => (
            <button key={k.value} type="button" role="radio" aria-checked={kind === k.value} onClick={() => setKind(k.value)}
              className={cx("min-h-12 rounded-md text-14 text-ink font-sans cursor-pointer",
                kind === k.value ? "border-2 border-primary bg-primary-tint font-bold" : "border border-border-strong bg-surface font-medium")}>
              {k.label}
            </button>
          ))}
        </div>
      </div>
      <Select label="الصنف" value={itemId} onChange={setItemId} options={options} />
      <TextField label="التفاصيل" value={details} onChange={setDetails} multiline placeholder="مثلاً: 6 بيضات مكسورة عند فتح الطبق." />

      <input ref={fileRef} type="file" accept="image/*" className="sr-only" aria-hidden tabIndex={-1}
        onChange={(e) => void upload(e.target.files?.[0])} />
      {photos.length ? (
        <div className="flex flex-col gap-1.5">
          {photos.map((p) => (
            <div key={p.id} className="flex items-center gap-2 text-14 bg-surface border border-border rounded-md p-2.5">
              <Icon name="circle-check" size={18} className="text-success-text" />
              <span className="flex-1 truncate">{p.name}</span>
              <button type="button" className="md-backbar-btn" aria-label="إزالة الصورة" onClick={() => setPhotos(photos.filter((x) => x.id !== p.id))}>
                <Icon name="x" size={18} />
              </button>
            </div>
          ))}
        </div>
      ) : null}
      {photos.length < MAX_PHOTOS ? (
        uploading ? <Button block variant="secondary" loading>جاري رفع الصورة</Button> : (
          <button type="button" onClick={() => fileRef.current?.click()}
            className="min-h-12 py-5 rounded-md border border-dashed border-border-strong bg-surface text-ink text-14 font-medium font-sans cursor-pointer flex items-center justify-center gap-2">
            <Icon name="camera" />{photos.length ? "أضف صورة أخرى" : "أضف صورة (تسرّع القرار)"}
          </button>
        )
      ) : null}

      <span className="text-13 text-ink-muted">يراجعه فريق مَدَد ويقرر كل حالة بنفسها: رصيد يُخصم من طلبيتك القادمة، أو إعادة المبلغ نقداً مع السائق.</span>
      {err ? <Note tone="error">{err}</Note> : null}
      <div className="mt-auto">
        <Button block icon="send" loading={sending} disabled={uploading} onClick={() => void send()}>إرسال</Button>
      </div>
    </>
  );
}

// ——— الحالة: قيد المراجعة أو القرار ————————————————————————————————————————————
function DisputeState({ order, d, others, onShow, onNew }: {
  order: Order2Out; d: DisputeOut; others: DisputeOut[]; onShow: (id: number) => void; onNew: () => void;
}) {
  const nav = useNavigate();
  const item = d.item ?? "الطلبية";
  const amount = Number(d.resolution_amount ?? 0);
  const favour = d.status === "resolved" && d.resolution !== "no_action" && amount > 0;
  const back = <Button variant="secondary" block onClick={() => nav(`/orders/${order.id}`)}>العودة للطلبية</Button>;

  let head;
  if (d.status === "open") {
    head = (
      <>
        <span className="p-5 rounded-full bg-secondary-tint text-primary-text grid place-items-center"><Icon name="clock" size={36} /></span>
        <h1 className="m-0 text-22 font-bold">وصلنا بلاغك</h1>
        <span className="text-16 text-ink-muted">نراجع «{item}» في الطلبية <Num>#{order.id}</Num> ونبلغك بالقرار.</span>
        <StatusBadge tone="warning">قيد المراجعة</StatusBadge>
      </>
    );
  } else {
    head = (
      <>
        <span className={cx("p-5 rounded-full grid place-items-center", favour ? "bg-success-tint text-success-text" : "bg-secondary-tint text-primary-text")}>
          <Icon name={favour ? "circle-check" : "circle-alert"} size={36} />
        </span>
        <h1 className="m-0 text-22 font-bold">{favour ? "قررنا لصالحك" : "قررنا في بلاغك"}</h1>
        <span className="text-16 text-ink-muted">«{item}» في الطلبية <Num>#{order.id}</Num>: {d.resolution_note || d.description}</span>
        {d.resolution ? <StatusBadge tone={favour ? "success" : "neutral"}>{RESOLUTION[d.resolution] ?? d.resolution}</StatusBadge> : null}
        {favour ? (
          <div className="w-full bg-surface border border-border rounded-lg p-3.5 flex flex-col gap-2 text-start">
            <div className="flex justify-between items-center">
              <span>{d.refund_method === "cash_via_driver" ? "يُعاد لك نقداً" : "رصيد لك"}</span>
              <Money value={d.resolution_amount} />
            </div>
            <span className="text-13 text-ink-muted">
              {d.refund_method === "cash_via_driver"
                ? "يسلّمك السائق المبلغ في زيارته القادمة وتوقّع على الاستلام."
                : "يُخصم تلقائياً من طلبيتك القادمة، ويظهر في السلة وفي الإيصال."}
            </span>
          </div>
        ) : null}
      </>
    );
  }

  return (
    <>
      <div className="flex flex-col items-center text-center gap-3.5 pt-6">{head}</div>
      {others.length ? (
        <div className="flex flex-col gap-1.5">
          <span className="text-14 font-bold">بلاغات أخرى في هذه الطلبية</span>
          {others.map((o) => (
            <button key={o.id} type="button" onClick={() => onShow(o.id)}
              className="md-row-link border-0 font-sans cursor-pointer text-start text-14 justify-between min-h-row">
              <span>{o.item ?? "الطلبية"} · {whenLabel(o.created_at)}</span>
              <StatusBadge tone={o.status === "open" ? "warning" : "success"}>{o.status === "open" ? "قيد المراجعة" : "قُرِّر"}</StatusBadge>
            </button>
          ))}
        </div>
      ) : null}
      <div className="flex flex-col gap-2 mt-auto">
        {favour ? <Button block icon="shopping-cart" onClick={() => nav("/")}>اطلب الآن</Button> : null}
        {back}
        <Button variant="ghost" block onClick={onNew}>بلاغ عن مشكلة أخرى</Button>
      </div>
    </>
  );
}
