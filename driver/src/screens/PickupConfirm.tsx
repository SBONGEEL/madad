/**
 * 03 تأكيد الاستلام (M-3، M-22): إثبات الاستلام برمزي QR يمسحه المورد أو برقم المورد أكتبه، ثم لكل صنف
 * «استلمت / نقص / رفض» والمستلم فعلاً، وصورة اختيارية، ثم «تأكيد النقطة» — القاعدة تضع حالة النقطة بنفسها.
 * قبل ذلك (§12-ط): موعد الوصول المكتوب قبل مفتاح الخرائط، و«وصلت إلى نقطة الاستلام» يراه المورد «السائق عندك».
 */
import { useEffect, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";

import { Button, EmptyState, ErrorState, Icon, LoadingState, Num, OtpInput, StatusBadge, TextField, cx, useLoad } from "@ui/kit";
import * as fmt from "@ui/fmt";
import { api } from "@/api/client";
import type { HandoverOut, Order2Out, Order2SummaryOut, StopLineOut, StopOut } from "@/api/types";
import { Screen } from "@/lib/shell";
import { ACTIVE_ORDER, STOP_STATUS, qtyUnit, tripoliTime, tripoliToday, uploadPhoto, useWork, workError } from "@/lib/work-http";
import { PhotoPick, PickupQr } from "@/lib/work-ui";
import { useSession } from "@/session";

type Choice = "ok" | "short" | "ref";

/** النقطة داخل طلبيتي الجارية، وإلا أبحث في طلبياتي (الجارية أولاً). */
async function findStop(stopId: number, currentId: number | null): Promise<{ order: Order2Out; stop: StopOut } | null> {
  const tried = new Set<number>();
  const look = async (id: number) => {
    tried.add(id);
    const o = await api.get<Order2Out>(`/api/driver/orders/${id}`);
    const s = o.stops.find((x) => x.id === stopId);
    return s ? { order: o, stop: s } : null;
  };
  if (currentId != null) {
    const hit = await look(currentId);
    if (hit) return hit;
  }
  const mine = await api.get<Order2SummaryOut[]>(`/api/driver/orders`);
  const ordered = [...mine.filter((o) => ACTIVE_ORDER.has(o.status)), ...mine.filter((o) => !ACTIVE_ORDER.has(o.status))];
  for (const o of ordered) {
    if (tried.has(o.id)) continue;
    const hit = await look(o.id);
    if (hit) return hit;
  }
  return null;
}

export function PickupConfirm() {
  const { stopId } = useParams();
  const sid = Number(stopId);
  const { current } = useSession();
  const found = useLoad(() => findStop(sid, current?.id ?? null), [sid]);

  if (found.loading && !found.data) {
    return <Screen title="استلام"><LoadingState rows={3} /></Screen>;
  }
  if (found.error) {
    return <Screen title="استلام"><ErrorState title="تعذّر تحميل النقطة" body="تحقق من الاتصال. الطلبية محفوظة لك." code={found.error.code} onRetry={found.reload} /></Screen>;
  }
  if (!found.data) {
    return <Screen title="استلام"><EmptyState icon="map-pin" title="النقطة غير موجودة" body="لا تخص هذه النقطة طلبية من طلبياتك." /></Screen>;
  }
  return <StopForm key={found.data.stop.id} order={found.data.order} stop={found.data.stop}
    onOrder={(o) => { const s = o.stops.find((x) => x.id === sid); if (s) found.set({ order: o, stop: s }); }} />;
}

function StopForm({ order, stop, onOrder }: { order: Order2Out; stop: StopOut; onOrder: (o: Order2Out) => void }) {
  const nav = useNavigate();
  const { refresh } = useSession();
  const [tab, setTab] = useState<"qr" | "num">("qr");
  const [code, setCode] = useState("");
  const [codeErr, setCodeErr] = useState<string | null>(null);
  const [proven, setProven] = useState(stop.handed_over);
  const [choice, setChoice] = useState<Record<number, Choice | undefined>>({});
  const [shortQty, setShortQty] = useState<Record<number, string>>({});
  const [photo, setPhoto] = useState<number | null>(null);
  const [formErr, setFormErr] = useState<string | null>(null);
  const codeAct = useWork();
  const photoAct = useWork();
  const confirmAct = useWork();
  const checking = useWork();
  const etaAct = useWork();
  const arriveAct = useWork();
  const [eta, setEta] = useState(tripoliTime(stop.eta_at));
  const etaIso = tripoliToday(eta);
  useEffect(() => setProven(stop.handed_over), [stop.handed_over]);

  const title = <>استلام — نقطة <Num>{stop.seq}</Num></>;
  const back = `/route/${order.id}`;
  const pending = stop.status === "pending";

  if (!pending) {
    return (
      <Screen title={title} back={back}>
        <div className="flex items-center justify-between gap-2">
          <b className="text-17">{stop.label}</b>
          <StatusBadge tone={stop.status === "collected" ? "success" : stop.status === "short" ? "warning" : "neutral"}>{STOP_STATUS[stop.status] ?? stop.status}</StatusBadge>
        </div>
        {stop.lines.map((l) => (
          <div key={l.id} className="md-sec p-3 flex-row justify-between text-15">
            <b>{l.name_ar}</b>
            <span>استلمت <Num>{qtyUnit(l.collected_qty ?? 0, l.unit)}</Num> من <Num>{qtyUnit(l.planned_qty, l.unit)}</Num></span>
          </div>
        ))}
        <Button block className="md-btn-xl" icon="navigation" onClick={() => nav(back)}>العودة إلى المسار</Button>
      </Screen>
    );
  }

  async function saveEta() {
    if (!etaIso) return;
    const r = await etaAct.run(() => api.put<Order2Out>(`/api/driver/stops/${stop.id}/eta`, { eta_at: etaIso }), { ok: "حُفظ موعد وصولك." });
    if (r.v) onOrder(r.v);
  }

  async function arrive() {
    const r = await arriveAct.run(() => api.post<Order2Out>(`/api/driver/stops/${stop.id}/arrive`), { ok: "علّمت الوصول. يراه المورد الآن." });
    if (r.v) onOrder(r.v);
  }

  // قبل الوصول: الموعد والوصول وحدهما؛ الرمز والأصناف بعد تعليم الوصول (أو إن ثبت التسليم قبله)
  if (!stop.arrived_at && !proven) {
    return (
      <Screen title={title} back={back}>
        <b className="text-17">{stop.label}{stop.address_text ? <span className="text-14 md-muted font-normal"> · {stop.address_text}</span> : null}</b>
        <TextField label="موعد وصولك إلى المورد" value={eta} onChange={setEta} numeric icon="clock" placeholder="10:30"
          error={eta && !etaIso ? "اكتب الساعة هكذا: 10:30" : null}
          hint={`يراه المورد: «يصل حوالي ${etaIso ? eta.trim() : "…"}». يُحسب آلياً حين يُضبط مفتاح الخرائط`} />
        <Button variant="secondary" block icon="clock" loading={etaAct.busy} disabled={!etaIso} onClick={saveEta}>حفظ الموعد</Button>
        <div className="mt-auto flex flex-col gap-2">
          <Button variant="success" block className="md-btn-xl" icon="map-pin" loading={arriveAct.busy} onClick={arrive}>وصلت إلى نقطة الاستلام</Button>
        </div>
      </Screen>
    );
  }

  async function sendCode() {
    setCodeErr(null);
    const r = await codeAct.run(() => api.post<HandoverOut>(`/api/driver/stops/${stop.id}/code`, { code }),
      { ok: "الرقم مطابق. أكمل الأصناف.", inline: ["pickup_code_mismatch"] });
    if (r.code === "pickup_code_mismatch") setCodeErr(workError(r.code));
    if (r.v) setProven(true);
  }

  async function checkScan() {
    const r = await checking.run(() => api.get<Order2Out>(`/api/driver/orders/${order.id}`));
    if (r.v) {
      onOrder(r.v);
      const s = r.v.stops.find((x) => x.id === stop.id);
      if (!s?.handed_over) setFormErr("لم يمسح المورد رمزك بعد. أرِه الرمز أو اكتب رقمه.");
      else setFormErr(null);
    }
  }

  function qtyFor(l: StopLineOut): string | null {
    const c = choice[l.id];
    if (c === "ok") return l.planned_qty;
    if (c === "ref") return "0";
    if (c === "short") {
      const v = (shortQty[l.id] ?? "").trim();
      const n = Number(v);
      if (!/^\d+(\.\d{1,3})?$/.test(v) || n <= 0 || n >= Number(l.planned_qty)) return null;
      return v;
    }
    return null;
  }

  async function confirm() {
    const lines = stop.lines.map((l) => ({ line_id: l.id, collected_qty: qtyFor(l) }));
    if (lines.some((l) => l.collected_qty == null)) { setFormErr("stop_short_requires_qty"); return; }
    setFormErr(null);
    const r = await confirmAct.run(() => api.post<Order2Out>(`/api/driver/stops/${stop.id}/confirm`,
      { lines, photo_media_id: photo ?? undefined }),
      { ok: "أُكّدت النقطة.", inline: ["pickup_proof_required", "stop_short_requires_qty", "stop_lines_incomplete"] });
    if (r.code) { if (r.code !== "network") setFormErr(r.code); return; }
    refresh();
    nav(back);
  }

  async function pick(f: File) {
    const r = await photoAct.run(() => uploadPhoto(f, "pickup_photo"));
    if (r.v != null) setPhoto(r.v);
  }

  return (
    <Screen title={title} back={back}>
      <b className="text-17">{stop.label}{stop.address_text ? <span className="text-14 md-muted font-normal"> · {stop.address_text}</span> : null}</b>
      {stop.arrived_at ? (
        <div className="bg-success-tint rounded-md p-3 text-14 flex flex-col gap-1.5">
          <b>علّمت الوصول <Num>{tripoliTime(stop.arrived_at)}</Num></b>
          <span>يرى المورد الآن «السائق عندك».</span>
        </div>
      ) : null}
      {proven ? (
        <StatusBadge tone="success" icon="circle-check">ثبت الاستلام مع المورد</StatusBadge>
      ) : (
        <>
          <div className="grid grid-cols-2 gap-1.5" role="tablist">
            <Button variant={tab === "qr" ? "secondary" : "ghost"} icon="qr-code" onClick={() => setTab("qr")}>رمزي QR</Button>
            <Button variant={tab === "num" ? "secondary" : "ghost"} icon="hand-coins" onClick={() => setTab("num")}>رقم المورد</Button>
          </div>
          {tab === "qr" ? (
            <div data-theme="light" className="md-sheet items-center" style={{ borderRadius: "var(--radius-lg)" }}>
              <PickupQr value={stop.pickup_code} />
              <span className="text-14 md-muted">أرِ هذا الرمز للمورد ليمسحه</span>
              <Button variant="ghost" size="sm" icon="refresh-cw" loading={checking.busy} onClick={checkScan}>مسحه المورد؟ تحقّق</Button>
            </div>
          ) : (
            <div className="flex flex-col gap-2">
              <span className="text-14 font-bold">اكتب الرقم الذي يعطيك إياه المورد</span>
              <OtpInput value={code} onChange={(v) => { setCode(v); setCodeErr(null); }} error={codeErr} />
              {codeErr ? (
                <>
                  <span className="text-14 md-muted">تأكد من الرقم مع المورد، أو أرِه رمزك QR ليمسحه.</span>
                  <Button variant="secondary" block icon="qr-code" onClick={() => { setTab("qr"); setCodeErr(null); }}>أرِه رمزي QR</Button>
                </>
              ) : (
                <Button block icon="check" loading={codeAct.busy} disabled={code.length !== 6} onClick={sendCode}>تحقّق من الرقم</Button>
              )}
            </div>
          )}
        </>
      )}

      {stop.lines.map((l) => {
        const c = choice[l.id];
        const set = (v: Choice) => setChoice((x) => ({ ...x, [l.id]: v }));
        const sq = shortQty[l.id] ?? "";
        const bad = c === "short" && sq !== "" && qtyFor(l) == null;
        return (
          <div key={l.id} className={cx("md-sec p-3 gap-2", c === "short" && "border-warning")}>
            <div className="flex justify-between gap-2">
              <b className="text-16">{l.name_ar}</b>
              <span className="text-14">مطلوب <b><Num>{qtyUnit(l.planned_qty, l.unit)}</Num></b></span>
            </div>
            <div className="grid grid-cols-3 gap-1.5">
              <Choose on={c === "ok"} tone="bg-success" onClick={() => set("ok")}>استلمت</Choose>
              <Choose on={c === "short"} tone="bg-warning" onClick={() => set("short")}>نقص</Choose>
              <Choose on={c === "ref"} tone="bg-error" onClick={() => set("ref")}>رفض</Choose>
            </div>
            {c === "short" ? (
              <TextField label="المستلم فعلاً" value={sq} numeric suffix={`من ${fmt.qty(l.planned_qty)}`}
                onChange={(v) => setShortQty((x) => ({ ...x, [l.id]: v }))}
                error={bad ? `اكتب كمية أكبر من صفر وأقل من ${fmt.qty(l.planned_qty)}.` : null}
                hint="يُبلَّغ مَدَد عند التأكيد ليكمل الباقي أو يعدّل الطلبية." />
            ) : null}
          </div>
        );
      })}

      <PhotoPick attached={photo != null} busy={photoAct.busy} onPick={pick} onClear={() => setPhoto(null)} />

      {formErr === "stop_short_requires_qty" || formErr === "stop_lines_incomplete" ? (
        <ErrorState compact title="كمّل كل الأصناف" body="اختر لكل صنف: استلمت أو نقص أو رفض، قبل تأكيد النقطة." code="stop_short_requires_qty" />
      ) : formErr === "pickup_proof_required" ? (
        <ErrorState compact title="إثبات الاستلام مطلوب" body={workError("pickup_proof_required")} code="pickup_proof_required" />
      ) : formErr ? (
        <ErrorState compact title="تعذّر تأكيد النقطة" body={formErr.includes(" ") ? formErr : workError(formErr)} code={formErr.includes(" ") ? undefined : formErr} />
      ) : null}

      <Button block className="md-btn-xl" icon="check" loading={confirmAct.busy} disabled={photoAct.busy} onClick={confirm}>تأكيد النقطة</Button>
    </Screen>
  );
}

function Choose({ on, tone, onClick, children }: { on: boolean; tone: string; onClick: () => void; children: string }) {
  return (
    <button type="button" aria-pressed={on} onClick={onClick}
      className={cx("md-btn", on ? `${tone} text-primary font-bold border-0` : "md-btn-ghost border border-border-strong")}>
      {on ? <Icon name="check" size={16} /> : null}{children}
    </button>
  );
}
