/**
 * 04 الاستلام (م-3 محسوم): طلبات الاستلام لمحلّي، وكل نقطة بطريقتين للتسليم —
 * أمسح رمز QR في هاتف السائق (BarcodeDetector من المتصفح، بلا مكتبة)، أو أعطيه رقمي الثابت ليكتبه.
 * لا عميل ولا وجهة ولا سعر بيع ولا كود السائق: الخادم لا يرسلها أصلاً.
 * موعد الوصول «اليوم حوالي 10:30» و«السائق عندك» بلا مصدر في القاعدة (NO-DB) فلا يُعرضان.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";

import * as fmt from "@ui/fmt";
import { Button, DataTable, EmptyState, ErrorState, Icon, LoadingState, Note, Num, OtpInput, StatusBadge, type Tone, toast, useAction, useLoad } from "@ui/kit";
import { api } from "@/api/client";
import type { HandoverOut, Pickup2Out, PickupLineOut } from "@/api/types";
import { accError, downloadSlip } from "@/lib/acc-http";
import { lineQty } from "@/lib/acc-ui";
import { HomeHeader, Screen } from "@/lib/shell";
import { useSession } from "@/session";

const STATUS: Record<string, [string, Tone]> = {
  collected: ["استُلم", "success"], short: ["استُلم ناقصاً", "warning"], refused: ["رُفض", "error"], cancelled: ["أُلغي", "neutral"],
};

function badge(p: Pickup2Out): [string, Tone] {
  if (p.status === "pending") {
    if (p.handed_over) return ["سُلِّم", "success"];
    if (p.arrived_at) return ["السائق عندك", "info"];                  // §12-ط: السائق علّم الوصول
    return ["بانتظار التسليم", "warning"];
  }
  return STATUS[p.status] ?? [p.status, "neutral"];
}

const METHOD: Record<string, string> = { qr_scan: "بمسح الرمز", code_entry: "بالرقم" };

/** «482 719» */
const spaced = (code: string) => code.replace(/^(\d{3})(\d{3})$/, "$1 $2");

export function Pickups() {
  const [params] = useSearchParams();
  const list = useLoad(() => api.get<Pickup2Out[]>(`/api/supplier/pickups`));
  const stopId = Number(params.get("stop"));
  if (stopId) return <Stop id={stopId} list={list.data} loading={list.loading} error={list.error} reload={list.reload} />;
  return (
    <>
      <HomeHeader />
      <main className="md-mobile-main">
        {list.loading && !list.data ? <LoadingState rows={3} />
          : list.error && !list.data ? (
            <div className="flex-1 flex flex-col justify-center"><ErrorState title={list.error.message} code={list.error.code} onRetry={list.reload} /></div>
          ) : !list.data?.length ? (
            <div className="flex-1 flex flex-col justify-center">
              <EmptyState icon="truck" title="لا استلام اليوم" body="حين يحتاج مَدَد أصنافاً منك يصلك إشعار بالصنف والكمية والموعد." />
            </div>
          ) : <StopList stops={list.data} />}
      </main>
    </>
  );
}

function StopList({ stops }: { stops: Pickup2Out[] }) {
  const nav = useNavigate();
  return (
    <div className="flex flex-col gap-2.5">
      <span className="font-bold">طلبات الاستلام</span>
      {stops.map((p) => {
        const [label, tone] = badge(p);
        return (
          <button key={p.id} type="button" onClick={() => nav(`/pickups?stop=${p.id}`)}
            className="bg-surface border border-border rounded-md p-3 flex flex-col gap-1.5 text-start text-ink font-sans cursor-pointer w-full">
            <span className="flex items-center gap-2">
              <Icon name="truck" size={18} />
              <span className="font-bold flex-1">نقطة <Num>{p.seq}</Num> · {p.location_label}</span>
              <StatusBadge tone={tone}>{label}</StatusBadge>
            </span>
            <span className="text-13 text-ink-muted">
              {p.lines.map((l) => `${l.product_name} ${lineQty(l.collected_qty ?? l.planned_qty, l.unit, l.unit_size)}`).join(" · ")}
            </span>
            {p.status === "pending" && !p.handed_over && !p.arrived_at && p.eta_at
              ? <span className="text-13 font-bold">يصل حوالي <Num>{fmt.time(p.eta_at)}</Num></span> : null}
            {p.assigned_at ? <span className="text-12 text-ink-muted">طُلب <Num>{fmt.dateTime(p.assigned_at)}</Num></span> : null}
          </button>
        );
      })}
    </div>
  );
}

function Stop({ id, list, loading, error, reload }: {
  id: number; list: Pickup2Out[] | null; loading: boolean; error: { code: string; message: string } | null; reload: () => void;
}) {
  const { refresh } = useSession();
  const [scan, setScan] = useState(false);
  const [giveNumber, setGiveNumber] = useState(false);
  const [code, setCode] = useState("");
  const [fail, setFail] = useState<{ code: string; message: string } | null>(null);
  const [busyScan, setBusyScan] = useState(false);
  const pdf = useAction();
  const numberRef = useRef<HTMLElement>(null);
  const stop = list?.find((p) => p.id === id);

  useEffect(() => {
    if (giveNumber && !scan) numberRef.current?.scrollIntoView({ behavior: "smooth", block: "center" });
  }, [giveNumber, scan]);

  const submit = useCallback(async (c: string) => {
    setFail(null);
    setBusyScan(true);
    try {
      await api.post<HandoverOut>(`/api/supplier/pickups/${id}/scan`, { code: c });
      toast("سُلِّم لسائق مَدَد");
      setScan(false);
      setCode("");
      reload();
      refresh();
    } catch (e) {
      setFail({ code: (e as { code?: string }).code ?? "error", message: accError(e) });
      setScan(false);
    } finally {
      setBusyScan(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);

  if (scan) {
    return (
      <Screen title="مسح رمز السائق">
        <Scanner busy={busyScan} onCode={(c) => void submit(c)} />
        <Button block variant="secondary" onClick={() => { setScan(false); setGiveNumber(true); }}>المسح لا يعمل؟ أعطه رقمك بدلاً منه</Button>
      </Screen>
    );
  }

  const title = stop ? <>استلام — نقطة <Num>{stop.seq}</Num></> : "استلام";
  if (!stop) {
    return (
      <Screen title={title} back="/pickups">
        {loading && !list ? <LoadingState rows={2} />
          : error ? <ErrorState title={error.message} code={error.code} onRetry={reload} />
          : <EmptyState icon="truck" title="الاستلام غير موجود" body="ربما أُلغي أو لم يعد لمحلّك." />}
      </Screen>
    );
  }

  const [label, tone] = badge(stop);
  const open = stop.status === "pending" && !stop.handed_over;
  const cols = [
    { key: "i", label: "الصنف", render: (l: PickupLineOut) => l.product_name },
    { key: "q", label: "الكمية", numeric: true, render: (l: PickupLineOut) => <Num>{lineQty(l.collected_qty ?? l.planned_qty, l.unit, l.unit_size)}</Num> },
  ];
  return (
    <Screen title={title} back="/pickups">
      <div className="flex flex-col gap-3">
        <div className="flex justify-between items-center gap-2">
          <span className="text-15 flex items-center gap-1.5"><Icon name="map-pin" size={18} />{stop.location_label}</span>
          <StatusBadge tone={tone}>{label}</StatusBadge>
        </div>
        {stop.status === "pending" && !stop.handed_over ? (
          stop.arrived_at ? <Note tone="info"><b>السائق عندك</b> — وصل <Num>{fmt.time(stop.arrived_at)}</Num>.</Note>
            : stop.eta_at ? <span className="text-14">اليوم حوالي <Num>{fmt.time(stop.eta_at)}</Num></span> : null
        ) : null}
        <DataTable columns={cols} rows={stop.lines} rowKey={(_, i) => i} />

        {open ? (
          <>
            <span className="text-15 font-bold">سلّم بإحدى الطريقتين</span>
            {fail ? (
              fail.code === "pickup_code_mismatch"
                ? <ErrorState compact title="الرمز لا يطابق هذه النقطة" body="تأكد أنك تمسح رمز سائق مَدَد لهذا الاستلام، أو أعطه رقمك ليكتبه." code={fail.code} />
                : <ErrorState compact title="تعذّر تسجيل التسليم" body={fail.message} code={fail.code} />
            ) : null}
            <section className="bg-surface border border-border rounded-lg p-3.5 flex flex-col gap-2">
              <span className="text-13 font-bold text-ink-muted">الطريقة 1</span>
              <Button block icon="qr-code" disabled={busyScan} onClick={() => { setFail(null); setScan(true); }}>امسح رمز QR من هاتف السائق</Button>
              <span className="text-13 text-ink-muted">أو اكتب رمز السائق المكتوب تحت الـ QR:</span>
              <OtpInput value={code} onChange={setCode} />
              <Button block variant="secondary" loading={busyScan} disabled={code.length !== 6} onClick={() => void submit(code)}>تأكيد التسليم</Button>
            </section>
            <section ref={numberRef} className="bg-primary text-on-primary rounded-lg p-3.5 flex flex-col items-center gap-1">
              <span className="text-13 font-bold text-on-primary-muted self-start">الطريقة 2 — أعطِ السائق رقمك ليكتبه</span>
              <bdi className="md-num text-26 font-bold tracking-widest" dir="ltr">{spaced(stop.supplier_code)}</bdi>
              <span className="text-12 text-on-primary-muted">رقم ثابت لهذه النقطة وحدها</span>
            </section>
            {giveNumber ? <Note tone="info">أعطِ السائق الرقم أعلاه ليكتبه في تطبيقه، ثم حدّث الصفحة.</Note> : null}
            <span className="text-13 text-ink-muted">لا تسلّم قبل أن يُسجَّل التسليم هنا: هكذا يثبت أنه سائق مَدَد لهذه النقطة.</span>
            <Button variant="ghost" icon="refresh-cw" disabled={loading} onClick={reload}>تحديث</Button>
          </>
        ) : stop.handed_over ? (
          <>
            <section className="bg-success-tint rounded-lg p-4 flex gap-2.5 items-center">
              <span className="text-success-text"><Icon name="circle-check" size={28} /></span>
              <div className="flex flex-col">
                <span className="font-bold text-16">سُلِّم لسائق مَدَد</span>
                <span className="text-13 text-ink-muted">
                  {METHOD[stop.handover_method ?? ""] ?? "سُلِّم"}{stop.handed_over_at ? <> · <Num>{fmt.time(stop.handed_over_at)}</Num></> : null}
                </span>
              </div>
            </section>
            <span className="text-13 text-ink-muted">تُحسب مستحقاتك بالكمية المستلمة فعلاً، وتظهر في «المستحقات».</span>
          </>
        ) : null}

        <Button variant="secondary" icon="file-text" loading={pdf.busy}
          onClick={() => void pdf.run(() => downloadSlip(stop.id).catch((e: unknown) => { throw new Error(accError(e)); }))}>
          ورقة الاستلام PDF
        </Button>
      </div>
    </Screen>
  );
}

interface Detector { detect(src: HTMLVideoElement): Promise<Array<{ rawValue: string }>> }
type DetectorCtor = new (o?: { formats: string[] }) => Detector;

/** الكاميرا الخلفية + BarcodeDetector: أول رمز من 6 أرقام يُرسل مرة واحدة. */
function Scanner({ busy, onCode }: { busy: boolean; onCode: (code: string) => void }) {
  const video = useRef<HTMLVideoElement>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const cb = useRef(onCode);
  cb.current = onCode;

  useEffect(() => {
    const Ctor = (window as unknown as { BarcodeDetector?: DetectorCtor }).BarcodeDetector;
    if (!Ctor || !navigator.mediaDevices?.getUserMedia) {
      setProblem("هاتفك لا يدعم المسح من التطبيق. أعطِ السائق رقمك، أو اكتب رمزه.");
      return;
    }
    let stream: MediaStream | null = null;
    let timer: ReturnType<typeof setInterval> | null = null;
    let dead = false;
    let sent = false;
    const detector = new Ctor({ formats: ["qr_code"] });
    void (async () => {
      try {
        stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: "environment" }, audio: false });
      } catch (e) {
        if (!dead) setProblem((e as DOMException).name === "NotAllowedError"
          ? "لم تسمح بالكاميرا. فعّلها من إعدادات الهاتف، أو أعطِ السائق رقمك."
          : "تعذّر فتح الكاميرا. أعطِ السائق رقمك، أو اكتب رمزه.");
        return;
      }
      if (dead || !video.current) { stream.getTracks().forEach((t) => t.stop()); return; }
      video.current.srcObject = stream;
      await video.current.play().catch(() => undefined);
      timer = setInterval(() => {
        const v = video.current;
        if (sent || !v || v.readyState < 2) return;
        detector.detect(v).then((codes) => {
          for (const c of codes) {
            const m = c.rawValue.match(/\d{6}/);
            if (m && !sent) {
              sent = true;
              cb.current(m[0]);
              return;
            }
          }
        }, () => undefined);
      }, 350);
    })();
    return () => {
      dead = true;
      if (timer) clearInterval(timer);
      stream?.getTracks().forEach((t) => t.stop());
    };
  }, []);

  return (
    <div className="flex-1 flex flex-col gap-3">
      <div className="relative rounded-lg overflow-hidden bg-ink h-map grid place-items-center">
        <video ref={video} className="absolute inset-0 w-full h-full object-cover" muted playsInline />
        <span className="relative w-2/3 aspect-square border-2 border-secondary rounded-lg" aria-hidden />
        <span className="absolute bottom-3 inset-x-0 text-center text-15 text-on-primary">
          {busy ? "جاري التسجيل…" : "وجّه الكاميرا إلى رمز QR في هاتف السائق"}
        </span>
      </div>
      {problem ? <Note tone="warning">{problem}</Note> : null}
    </div>
  );
}
