/**
 * قطع مجموعة «العمل» المشتركة: خريطة المسار (DMap)، ورمز QR لنقطة الاستلام، واختيار صورة، وحالة الحساب غير المعتمد.
 * الخريطة Mapbox داكنة بالعربية مع إضافة الكتابة من اليمين حين يوجد VITE_MAPBOX_TOKEN والنقاط لها إحداثيات؛
 * وإلا رسم تخطيطي كـ DMap: دبابيس مرقّمة بترتيب النقاط ثم دبوس الوجهة، بلا جغرافيا. الألوان من الرموز وقت التشغيل.
 */
import { useEffect, useRef, useState } from "react";
import type { GeoJSONSource, Map as MapboxMap } from "mapbox-gl";
import QRCode from "qrcode";

import { EmptyState, ErrorState, Icon, cx } from "@ui/kit";
import { useSession } from "@/session";
import { type StopState } from "@/lib/work-http";
// ملف الإضافة المبني يُخدَم كما هو (حقل exports في الحزمة لا يكشفه، فالمسار مباشر إلى node_modules في جذر المشروع).
import rtlPluginUrl from "../../../node_modules/@mapbox/mapbox-gl-rtl-text/dist/mapbox-gl-rtl-text.js?url";

export const MAPBOX_TOKEN = (import.meta.env.VITE_MAPBOX_TOKEN as string | undefined) || "";

export interface Pin { key: number | string; n: string; lat: string | null; lng: string | null; tone: StopState }
export interface Dest { lat: string | null; lng: string | null }

const has = (p: { lat: string | null; lng: string | null }) => p.lat != null && p.lng != null;

/** خريطة المسار: Mapbox إن أمكن، وإلا الرسم التخطيطي. */
export function RouteMap({ pins, dest, label }: { pins: Pin[]; dest: Dest | null; label: string }) {
  const [failed, setFailed] = useState(false);
  const shown = pins.filter((p) => p.tone !== "cancelled");
  const geo = shown.some(has) || (dest != null && has(dest));
  if (MAPBOX_TOKEN && geo) {
    if (failed) {
      return (
        <div className="md-map-ground h-chart w-full grid place-items-center">
          <ErrorState compact title="الخريطة غير متاحة" body="النقاط والعناوين أدناه تعمل. افتح الملاحة من زر كل نقطة." code="map_unavailable" />
        </div>
      );
    }
    return <MapboxRoute pins={shown} dest={dest} label={label} onFail={() => setFailed(true)} />;
  }
  return <Schematic pins={shown} label={label} />;
}

function css(name: string): string {
  return getComputedStyle(document.documentElement).getPropertyValue(`--${name}`).trim();
}

function MapboxRoute({ pins, dest, label, onFail }: { pins: Pin[]; dest: Dest | null; label: string; onFail: () => void }) {
  const box = useRef<HTMLDivElement>(null);
  const map = useRef<MapboxMap | null>(null);
  const live = useRef({ pins, dest, onFail });
  live.current = { pins, dest, onFail };
  const ready = useRef(false);

  function data() {
    const { pins: p, dest: d } = live.current;
    const pts = p.filter(has).map((x) => ({ n: x.n, tone: x.tone, c: [Number(x.lng), Number(x.lat)] }));
    const dc = d && has(d) ? [Number(d.lng), Number(d.lat)] : null;
    const line = [...pts.map((x) => x.c), ...(dc ? [dc] : [])];
    return {
      pts: { type: "FeatureCollection" as const, features: pts.map((x) => ({
        type: "Feature" as const, properties: { n: x.n, tone: x.tone }, geometry: { type: "Point" as const, coordinates: x.c } })) },
      dest: { type: "FeatureCollection" as const, features: dc ? [{
        type: "Feature" as const, properties: {}, geometry: { type: "Point" as const, coordinates: dc } }] : [] },
      line: { type: "FeatureCollection" as const, features: line.length >= 2 ? [{
        type: "Feature" as const, properties: {}, geometry: { type: "LineString" as const, coordinates: line } }] : [] },
      all: line,
    };
  }

  function paint() {
    const m = map.current;
    if (!m || !ready.current) return;
    const g = data();
    (m.getSource("route") as GeoJSONSource | undefined)?.setData(g.line);
    (m.getSource("pins") as GeoJSONSource | undefined)?.setData(g.pts);
    (m.getSource("dest") as GeoJSONSource | undefined)?.setData(g.dest);
  }

  useEffect(() => {
    let dead = false;
    void (async () => {
      try {
        const mapboxgl = (await import("mapbox-gl")).default;
        await import("mapbox-gl/dist/mapbox-gl.css");
        if (dead || !box.current) return;
        mapboxgl.accessToken = MAPBOX_TOKEN;
        if (mapboxgl.getRTLTextPluginStatus() === "unavailable") mapboxgl.setRTLTextPlugin(rtlPluginUrl, () => undefined, false);
        const g = data();
        const first = g.all[0] ?? [13.18, 32.885];
        const m = new mapboxgl.Map({ container: box.current, style: "mapbox://styles/mapbox/dark-v11", center: first as [number, number],
          zoom: 12, language: "ar", attributionControl: false });
        map.current = m;
        m.on("error", (e) => {
          const status = (e.error as { status?: number } | undefined)?.status;
          if (!ready.current || status === 401 || status === 403) live.current.onFail();
        });
        m.on("load", () => {
          const sec = css("secondary"), prim = css("primary"), ok = css("success"), white = css("white");
          m.addSource("route", { type: "geojson", data: g.line });
          m.addSource("pins", { type: "geojson", data: g.pts });
          m.addSource("dest", { type: "geojson", data: g.dest });
          m.addLayer({ id: "route-line", type: "line", source: "route", layout: { "line-cap": "round", "line-join": "round" },
            paint: { "line-color": sec, "line-width": 5 } });
          m.addLayer({ id: "dest-pin", type: "circle", source: "dest",
            paint: { "circle-radius": 14, "circle-color": ok, "circle-stroke-color": white, "circle-stroke-width": 3 } });
          m.addLayer({ id: "pins-dot", type: "circle", source: "pins",
            paint: { "circle-radius": 16, "circle-stroke-color": sec, "circle-stroke-width": 3,
              "circle-color": ["match", ["get", "tone"], "done", ok, "next", sec, prim] } });
          m.addLayer({ id: "pins-n", type: "symbol", source: "pins",
            layout: { "text-field": ["get", "n"], "text-size": 14, "text-allow-overlap": true },
            paint: { "text-color": ["match", ["get", "tone"], "todo", white, prim] } });
          ready.current = true;
          paint();
          if (g.all.length >= 2) {
            const xs = g.all.map((c) => c[0] ?? 0), ys = g.all.map((c) => c[1] ?? 0);
            m.fitBounds([[Math.min(...xs), Math.min(...ys)], [Math.max(...xs), Math.max(...ys)]], { padding: 40, duration: 0, maxZoom: 15 });
          }
        });
      } catch {
        if (!dead) live.current.onFail();
      }
    })();
    return () => {
      dead = true;
      ready.current = false;
      map.current?.remove();
      map.current = null;
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => paint());

  return <div ref={box} className="md-map-ground h-chart w-full" role="img" aria-label={label} />;
}

/** الرسم التخطيطي (DMap): شبكة شوارع رمزية، ومسار من موضع السائق عبر النقاط بترتيبها إلى الوجهة. */
function Schematic({ pins, label }: { pins: Pin[]; label: string }) {
  const W = 390, H = 260;
  const n = pins.length;
  const start: [number, number] = [320, 236];
  const end: [number, number] = [80, 60];
  const pos = pins.map((_, i): [number, number] => {
    const t = (i + 1) / (n + 1);
    const zig = i % 2 === 0 ? 34 : -34;
    return [start[0] + (end[0] - start[0]) * t + zig, start[1] + (end[1] - start[1]) * t];
  });
  const way = [start, ...pos, end];
  // مسار بزوايا قائمة كالشوارع: أفقي ثم عمودي بين كل نقطتين
  const d = way.map((p, i) => {
    if (i === 0) return `M${p[0]} ${p[1]}`;
    const prev = way[i - 1] ?? p;
    return `L${prev[0]} ${p[1]} L${p[0]} ${p[1]}`;
  }).join(" ");
  const dot = (t: StopState) => (t === "done" ? "fill-success" : t === "next" ? "fill-secondary" : "fill-primary");
  const txt = (t: StopState) => (t === "todo" ? "fill-white" : "fill-primary");
  return (
    <div className="md-map-ground w-full">
      <svg viewBox={`0 0 ${W} ${H}`} className="block w-full" role="img" aria-label={label}>
        <g className="stroke-on-primary-muted" strokeOpacity={0.25} strokeWidth={1.5} fill="none">
          <path d="M0 50 H390 M0 120 H390 M0 190 H390 M60 0 V260 M150 0 V260 M250 0 V260 M330 0 V260" />
          <path d="M0 170 L390 70" strokeWidth={6} />
        </g>
        <path d={d} fill="none" className="stroke-secondary" strokeWidth={5} strokeLinecap="round" strokeLinejoin="round" />
        <circle cx={start[0]} cy={start[1]} r={9} className="fill-white" />
        <circle cx={start[0]} cy={start[1]} r={5} className="fill-secondary" />
        {pins.map((p, i) => {
          const c = pos[i] ?? start;
          return (
            <g key={p.key}>
              <circle cx={c[0]} cy={c[1]} r={16} className={cx(dot(p.tone), "stroke-secondary")} strokeWidth={3} />
              <text x={c[0]} y={c[1] + 5} textAnchor="middle" className={cx("md-num font-bold text-14", txt(p.tone))}>{p.n}</text>
            </g>
          );
        })}
        <g transform={`translate(${end[0] - 90} ${end[1] - 98})`}>
          <path d="M90 44 C 76 44 68 54 68 64 C 68 80 90 98 90 98 C 90 98 112 80 112 64 C 112 54 104 44 90 44 Z" className="fill-success" />
          <circle cx={90} cy={64} r={7} className="fill-primary" />
        </g>
      </svg>
    </div>
  );
}

/** رمز QR لنقطة الاستلام (م-3): أسود على أبيض ليقرأه ماسح المورد في الشمس. */
export function PickupQr({ value }: { value: string }) {
  const [svg, setSvg] = useState("");
  useEffect(() => {
    let live = true;
    QRCode.toString(value, { type: "svg", margin: 1, errorCorrectionLevel: "M" })
      .then((s) => { if (live) setSvg(s.replace("<svg ", '<svg width="100%" height="100%" ')); }, () => undefined);
    return () => { live = false; };
  }, [value]);
  return <div className="w-chart bg-white p-2 rounded-md" role="img" aria-label="رمز QR لنقطة الاستلام" dangerouslySetInnerHTML={{ __html: svg }} />;
}

/** زر «صورة (اختيارية)» بحدّ متقطع، وحالة الصورة المرفقة. */
export function PhotoPick({ attached, busy, onPick, onClear, label = "صورة (اختيارية)" }: {
  attached: boolean; busy: boolean; onPick: (f: File) => void; onClear: () => void; label?: string;
}) {
  const ref = useRef<HTMLInputElement>(null);
  if (attached) {
    return (
      <div className="flex items-center gap-2 rounded-md border border-dashed border-success p-3 text-14">
        <Icon name="circle-check" size={18} />
        <span className="flex-1">أُرفقت الصورة</span>
        <button type="button" className="md-link" onClick={onClear}>إزالة</button>
      </div>
    );
  }
  return (
    <>
      <input ref={ref} type="file" accept="image/jpeg,image/png,image/webp" capture="environment" className="sr-only"
        onChange={(e) => { const f = e.target.files?.[0]; e.target.value = ""; if (f) onPick(f); }} />
      <button type="button" disabled={busy} onClick={() => ref.current?.click()}
        className="md-btn md-btn-ghost md-btn-block border border-dashed border-border-strong">
        {busy ? <span className="md-spinner" aria-hidden /> : <Icon name="camera" size={18} />}{busy ? "جاري رفع الصورة" : label}
      </button>
    </>
  );
}

/** الحساب غير المعتمد: نراجع أوراقك / موقوف / مرفوض — ولا طلبيات. */
export function NotApproved() {
  const { me } = useSession();
  const st = me.driver?.status;
  if (st === "suspended") {
    return <ErrorState title="حسابك موقوف" body="لا تصلك طلبيات جديدة. تواصل مع مَدَد لمعرفة السبب. رصيدك وأجرك محفوظان." code="driver_suspended" />;
  }
  if (st === "rejected") {
    return <ErrorState title="لم تُعتمد أوراقك" body="راجع حالة أوراقك في «حسابي» وتواصل مع مَدَد." code="driver_rejected" />;
  }
  return <EmptyState icon="clock" title="نراجع أوراقك" body="الهوية والرخصة والصورة وصلت. نبلغك حين تُعتمد، ومعها طريقة صرف أجرك التي يحددها مَدَد." />;
}
