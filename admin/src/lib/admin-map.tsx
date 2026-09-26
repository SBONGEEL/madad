/**
 * خريطة المناطق المرسومة (م-16): Mapbox بالعربية ومع إضافة الكتابة من اليمين (§14) — تُحمَّل فقط حين يوجد
 * VITE_MAPBOX_TOKEN. بلا المفتاح: معاينة SVG للحدود، ومحرّر نقاط (خط العرض، خط الطول) يكفي لإنشاء المناطق وتعديلها.
 * النقطة في الخادم [lat, lng]؛ Mapbox يريد [lng, lat]، والتحويل هنا وحده. الألوان من رموز tokens.css وقت التشغيل.
 */
import { useEffect, useRef, useState } from "react";
import type { GeoJSONSource, Map as MapboxMap, MapMouseEvent } from "mapbox-gl";

import { Button, Icon, TextField, cx } from "@ui/kit";
// ملف الإضافة المبني يُخدَم كما هو (حقل exports في الحزمة لا يكشفه، فالمسار مباشر إلى node_modules في جذر المشروع).
import rtlPluginUrl from "../../../node_modules/@mapbox/mapbox-gl-rtl-text/dist/mapbox-gl-rtl-text.js?url";

export const MAPBOX_TOKEN = (import.meta.env.VITE_MAPBOX_TOKEN as string | undefined) || "";

/** طرابلس */
const CENTER: [number, number] = [13.18, 32.885];

export interface MapArea { id: number; name: string; fee: string; active: boolean; polygon: number[][] }

function token(name: string): string {
  return getComputedStyle(document.documentElement).getPropertyValue(`--${name}`).trim();
}

const ring = (pts: number[][]) => {
  const r = pts.map((p) => [p[1] ?? 0, p[0] ?? 0]);
  const first = r[0];
  return first ? [...r, first] : r;
};

function centroid(pts: number[][]): [number, number] {
  const n = Math.max(pts.length, 1);
  return [pts.reduce((s, p) => s + (p[1] ?? 0), 0) / n, pts.reduce((s, p) => s + (p[0] ?? 0), 0) / n];
}

function areasGeo(areas: MapArea[], hideId: number | null) {
  const shown = areas.filter((a) => a.id !== hideId && a.polygon.length >= 3);
  return {
    polys: { type: "FeatureCollection" as const, features: shown.map((a) => ({
      type: "Feature" as const, id: a.id, properties: { id: a.id, active: a.active },
      geometry: { type: "Polygon" as const, coordinates: [ring(a.polygon)] } })) },
    labels: { type: "FeatureCollection" as const, features: shown.map((a) => ({
      type: "Feature" as const, properties: { label: `${a.name} · ${Number(a.fee).toFixed(3)}` },
      geometry: { type: "Point" as const, coordinates: centroid(a.polygon) } })) },
  };
}

function draftGeo(pts: number[][]) {
  const features: Array<{ type: "Feature"; properties: Record<string, never>; geometry:
    { type: "Polygon"; coordinates: number[][][] } | { type: "Point"; coordinates: number[] } | { type: "LineString"; coordinates: number[][] } }> = [];
  if (pts.length >= 3) features.push({ type: "Feature", properties: {}, geometry: { type: "Polygon", coordinates: [ring(pts)] } });
  else if (pts.length === 2) features.push({ type: "Feature", properties: {}, geometry: { type: "LineString", coordinates: pts.map((p) => [p[1] ?? 0, p[0] ?? 0]) } });
  pts.forEach((p) => features.push({ type: "Feature", properties: {}, geometry: { type: "Point", coordinates: [p[1] ?? 0, p[0] ?? 0] } }));
  return { type: "FeatureCollection" as const, features };
}

/** خريطة Mapbox: المناطق المحفوظة، والمسودة، والنقر يضيف نقطة أثناء الرسم أو يختار منطقة خارجه. */
export function AreaMap({ areas, editingId, draft, drawing, onAddPoint, onSelect }: {
  areas: MapArea[]; editingId: number | null; draft: number[][]; drawing: boolean;
  onAddPoint: (p: [number, number]) => void; onSelect: (id: number) => void;
}) {
  const box = useRef<HTMLDivElement>(null);
  const map = useRef<MapboxMap | null>(null);
  const ready = useRef(false);
  const live = useRef({ areas, editingId, draft, drawing, onAddPoint, onSelect });
  live.current = { areas, editingId, draft, drawing, onAddPoint, onSelect };

  function paint() {
    const m = map.current;
    if (!m || !ready.current) return;
    const { areas: a, editingId: e, draft: d } = live.current;
    const g = areasGeo(a, e);
    (m.getSource("areas") as GeoJSONSource | undefined)?.setData(g.polys);
    (m.getSource("area-labels") as GeoJSONSource | undefined)?.setData(g.labels);
    (m.getSource("draft") as GeoJSONSource | undefined)?.setData(draftGeo(d));
  }

  useEffect(() => {
    let dead = false;
    void (async () => {
      const mapboxgl = (await import("mapbox-gl")).default;
      await import("mapbox-gl/dist/mapbox-gl.css");
      if (dead || !box.current) return;
      mapboxgl.accessToken = MAPBOX_TOKEN;
      if (mapboxgl.getRTLTextPluginStatus() === "unavailable") mapboxgl.setRTLTextPlugin(rtlPluginUrl, () => undefined, false);
      const m = new mapboxgl.Map({ container: box.current, style: "mapbox://styles/mapbox/streets-v12", center: CENTER, zoom: 11, language: "ar" });   // = setLanguage("ar") من أول سطر (§14)
      map.current = m;
      m.addControl(new mapboxgl.NavigationControl({ showCompass: false }), "top-left");
      m.on("load", () => {
        const sec = token("secondary"), secTint = token("secondary-tint"), warn = token("warning"), ink = token("ink"), white = token("white");
        m.addSource("areas", { type: "geojson", data: { type: "FeatureCollection", features: [] } });
        m.addSource("area-labels", { type: "geojson", data: { type: "FeatureCollection", features: [] } });
        m.addSource("draft", { type: "geojson", data: { type: "FeatureCollection", features: [] } });
        m.addLayer({ id: "areas-fill", type: "fill", source: "areas", paint: { "fill-color": secTint || sec, "fill-opacity": ["case", ["get", "active"], 1, 0.4] } });
        m.addLayer({ id: "areas-line", type: "line", source: "areas", paint: { "line-color": sec, "line-width": 2 } });
        m.addLayer({ id: "areas-label", type: "symbol", source: "area-labels",
          layout: { "text-field": ["get", "label"], "text-size": 14 }, paint: { "text-color": ink, "text-halo-color": white, "text-halo-width": 1.5 } });
        m.addLayer({ id: "draft-fill", type: "fill", source: "draft", filter: ["==", ["geometry-type"], "Polygon"], paint: { "fill-color": warn, "fill-opacity": 0.18 } });
        m.addLayer({ id: "draft-line", type: "line", source: "draft", filter: ["!=", ["geometry-type"], "Point"],
          paint: { "line-color": warn, "line-width": 2, "line-dasharray": [3, 2] } });
        m.addLayer({ id: "draft-pts", type: "circle", source: "draft", filter: ["==", ["geometry-type"], "Point"],
          paint: { "circle-radius": 5, "circle-color": warn, "circle-stroke-color": white, "circle-stroke-width": 2 } });
        ready.current = true;
        paint();
        const all = live.current.areas.flatMap((a) => a.polygon);
        if (all.length) {
          const lngs = all.map((p) => p[1] ?? 0), lats = all.map((p) => p[0] ?? 0);
          m.fitBounds([[Math.min(...lngs), Math.min(...lats)], [Math.max(...lngs), Math.max(...lats)]], { padding: 40, duration: 0, maxZoom: 14 });
        }
      });
      m.on("click", (e: MapMouseEvent) => {
        if (live.current.drawing) return live.current.onAddPoint([Number(e.lngLat.lat.toFixed(6)), Number(e.lngLat.lng.toFixed(6))]);
        const hit = m.queryRenderedFeatures(e.point, { layers: ["areas-fill"] })[0];
        const id = (hit as unknown as { id?: unknown } | undefined)?.id;
        if (typeof id === "number") live.current.onSelect(id);
      });
    })();
    return () => {
      dead = true;
      ready.current = false;
      map.current?.remove();
      map.current = null;
    };
  }, []);

  useEffect(() => {
    paint();
    const c = map.current?.getCanvas();
    if (c) c.style.cursor = drawing ? "crosshair" : "";
  });

  return <div ref={box} className="md-map" role="application" aria-label="خريطة طرابلس للمناطق المرسومة" />;
}

/** معاينة الحدود بلا خريطة: الأشكال مرسومة في مربع يحيط بها كلها. */
export function AreaPreview({ areas, editingId, draft, onSelect }: {
  areas: MapArea[]; editingId: number | null; draft: number[][]; onSelect: (id: number) => void;
}) {
  const W = 640, H = 420, PAD = 24;
  const shown = areas.filter((a) => a.id !== editingId && a.polygon.length);
  const all = [...shown.flatMap((a) => a.polygon), ...draft];
  if (!all.length) {
    return (
      <div className="md-map grid place-items-center text-ink-muted text-14">
        <span className="flex flex-col items-center gap-2"><Icon name="map-pin" size={28} />لا مناطق مرسومة بعد</span>
      </div>
    );
  }
  const lats = all.map((p) => p[0] ?? 0), lngs = all.map((p) => p[1] ?? 0);
  const minLat = Math.min(...lats), maxLat = Math.max(...lats), minLng = Math.min(...lngs), maxLng = Math.max(...lngs);
  const sx = (W - PAD * 2) / Math.max(maxLng - minLng, 1e-6), sy = (H - PAD * 2) / Math.max(maxLat - minLat, 1e-6);
  const k = Math.min(sx, sy);
  const x = (lng: number) => PAD + (lng - minLng) * k;
  const y = (lat: number) => H - PAD - (lat - minLat) * k;
  const pts = (poly: number[][]) => poly.map((p) => `${x(p[1] ?? 0)},${y(p[0] ?? 0)}`).join(" ");
  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="md-map block" role="img" aria-label="معاينة حدود المناطق المرسومة">
      {shown.map((a) => {
        const [lx, ly] = centroid(a.polygon);
        return (
          <g key={a.id} className="cursor-pointer" onClick={() => onSelect(a.id)}>
            <polygon points={pts(a.polygon)} className={cxFill(a.active)} strokeWidth={2} />
            <text x={x(lx)} y={y(ly)} textAnchor="middle" className="fill-ink text-14 font-bold">{a.name} · {Number(a.fee).toFixed(3)}</text>
          </g>
        );
      })}
      {draft.length >= 2 ? <polygon points={pts(draft)} className="fill-warning-tint stroke-warning" strokeWidth={2} strokeDasharray="6 4" /> : null}
      {draft.map((p, i) => <circle key={i} cx={x(p[1] ?? 0)} cy={y(p[0] ?? 0)} r={5} className="fill-warning stroke-white" strokeWidth={2} />)}
    </svg>
  );
}

function cxFill(active: boolean) {
  return cx("stroke-secondary", active ? "fill-secondary-tint" : "fill-page");
}

/** محرّر النقاط: خط العرض وخط الطول لكل رأس، بالترتيب حول الشكل. */
export function PointsEditor({ points, onChange, disabled }: { points: number[][]; onChange: (p: number[][]) => void; disabled?: boolean }) {
  const set = (i: number, j: 0 | 1, v: string) => onChange(points.map((p, n) => (n === i ? (j === 0 ? [Number(v), p[1] ?? 0] : [p[0] ?? 0, Number(v)]) : p)));
  return (
    <div className="flex flex-col gap-2">
      {points.map((p, i) => (
        <div key={i} className="grid grid-cols-[auto_minmax(0,1fr)_minmax(0,1fr)_auto] gap-2 items-end">
          <span className="md-num w-8 h-8 rounded-full bg-page grid place-items-center font-bold text-13">{i + 1}</span>
          <PointField label="خط العرض" value={p[0]} onChange={(v) => set(i, 0, v)} disabled={disabled} />
          <PointField label="خط الطول" value={p[1]} onChange={(v) => set(i, 1, v)} disabled={disabled} />
          <Button variant="ghost" size="sm" icon="trash-2" title="حذف النقطة" disabled={disabled} onClick={() => onChange(points.filter((_, n) => n !== i))} />
        </div>
      ))}
      <div>
        <Button variant="secondary" size="sm" icon="plus" disabled={disabled}
          onClick={() => onChange([...points, points[points.length - 1] ? [...(points[points.length - 1] as number[])] : [CENTER[1], CENTER[0]]])}>
          إضافة نقطة
        </Button>
      </div>
    </div>
  );
}

function PointField({ label, value, onChange, disabled }: { label: string; value: number | undefined; onChange: (v: string) => void; disabled?: boolean }) {
  const [text, setText] = useState(value == null ? "" : String(value));
  useEffect(() => {
    setText((t) => (Number(t) === value && t.trim() !== "" ? t : value == null ? "" : String(value)));
  }, [value]);
  const bad = text.trim() !== "" && !Number.isFinite(Number(text));
  return (
    <TextField label={label} value={text} numeric disabled={disabled} error={bad || !text.trim() ? "رقم غير صالح" : null}
      onChange={(v) => { setText(v); if (v.trim() && Number.isFinite(Number(v))) onChange(v); }} />
  );
}
