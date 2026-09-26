/**
 * دبوس الموقع للتسجيل والفروع: خريطة Mapbox بالعربية حين يوجد VITE_MAPBOX_TOKEN (الدبوس في الوسط، تُحرَّك الخريطة تحته).
 * بلا المفتاح: «استخدم موقعي الحالي» من الهاتف، مع خط العرض وخط الطول يدوياً. النقطة هنا [lat, lng] كما في الخادم.
 */
import { useEffect, useRef, useState } from "react";
import type { Map as MapboxMap } from "mapbox-gl";

import { Button, Icon, Note, TextField } from "@ui/kit";
import rtlPluginUrl from "../../../node_modules/@mapbox/mapbox-gl-rtl-text/dist/mapbox-gl-rtl-text.js?url";

const MAPBOX_TOKEN = (import.meta.env.VITE_MAPBOX_TOKEN as string | undefined) || "";

/** طرابلس */
const TRIPOLI = { lat: 32.885, lng: 13.18 };

export interface Pin { lat: string; lng: string }

export const pinValid = (p: Pin) => {
  const lat = Number(p.lat), lng = Number(p.lng);
  return p.lat.trim() !== "" && p.lng.trim() !== "" && Number.isFinite(lat) && Number.isFinite(lng) && Math.abs(lat) <= 90 && Math.abs(lng) <= 180;
};

const fix = (n: number) => n.toFixed(6);

export function LocationPicker({ value, onChange, hint }: { value: Pin; onChange: (p: Pin) => void; hint: string }) {
  return MAPBOX_TOKEN ? <MapPin value={value} onChange={onChange} hint={hint} /> : <ManualPin value={value} onChange={onChange} />;
}

function MapPin({ value, onChange, hint }: { value: Pin; onChange: (p: Pin) => void; hint: string }) {
  const box = useRef<HTMLDivElement>(null);
  const map = useRef<MapboxMap | null>(null);
  const cb = useRef(onChange);
  cb.current = onChange;
  const start = useRef(value);

  useEffect(() => {
    let dead = false;
    void (async () => {
      const mapboxgl = (await import("mapbox-gl")).default;
      await import("mapbox-gl/dist/mapbox-gl.css");
      if (dead || !box.current) return;
      mapboxgl.accessToken = MAPBOX_TOKEN;
      if (mapboxgl.getRTLTextPluginStatus() === "unavailable") mapboxgl.setRTLTextPlugin(rtlPluginUrl, () => undefined, false);
      const s = start.current;
      const center: [number, number] = pinValid(s) ? [Number(s.lng), Number(s.lat)] : [TRIPOLI.lng, TRIPOLI.lat];
      const m = new mapboxgl.Map({ container: box.current, style: "mapbox://styles/mapbox/streets-v12", center, zoom: 15, language: "ar" });
      map.current = m;
      m.addControl(new mapboxgl.GeolocateControl({ positionOptions: { enableHighAccuracy: true } }), "top-left");
      const report = () => {
        const c = m.getCenter();
        cb.current({ lat: fix(c.lat), lng: fix(c.lng) });
      };
      m.on("moveend", report);
      m.on("load", report);
    })();
    return () => {
      dead = true;
      map.current?.remove();
      map.current = null;
    };
  }, []);

  return (
    <div className="relative">
      <div ref={box} className="md-map" role="application" aria-label="خريطة لوضع الدبوس" />
      <span className="absolute inset-0 grid place-items-center pointer-events-none text-secondary">
        <Icon name="map-pin" size={32} />
      </span>
      <span className="absolute bottom-1.5 start-2.5 text-12 text-ink-muted bg-surface rounded-sm px-1.5 pointer-events-none">{hint}</span>
    </div>
  );
}

function ManualPin({ value, onChange }: { value: Pin; onChange: (p: Pin) => void }) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  function locate() {
    if (!("geolocation" in navigator)) return setErr("الهاتف لا يعطي الموقع. اكتب الإحداثيات يدوياً.");
    setBusy(true);
    setErr(null);
    navigator.geolocation.getCurrentPosition(
      (p) => {
        setBusy(false);
        onChange({ lat: fix(p.coords.latitude), lng: fix(p.coords.longitude) });
      },
      (e) => {
        setBusy(false);
        setErr(e.code === e.PERMISSION_DENIED ? "لم تسمح بالوصول إلى الموقع. فعّله من إعدادات الهاتف أو اكتب الإحداثيات." : "تعذّر تحديد موقعك الآن. أعد المحاولة عند الباب.");
      },
      { enableHighAccuracy: true, timeout: 15000 },
    );
  }
  const set = pinValid(value);
  return (
    <div className="flex flex-col gap-2">
      <div className="rounded-md bg-secondary-tint p-3 flex items-center gap-2.5">
        <span className="text-secondary"><Icon name="map-pin" size={28} /></span>
        <span className="flex flex-col gap-0.5 flex-1 text-13">
          <b>{set ? "الدبوس محدَّد" : "لم يُحدَّد الموقع بعد"}</b>
          <span className="text-ink-muted">{set ? <bdi className="md-num" dir="ltr">{value.lat}, {value.lng}</bdi> : "قف عند المدخل واضغط «استخدم موقعي الحالي»."}</span>
        </span>
      </div>
      <Button variant="secondary" icon="navigation" block loading={busy} onClick={locate}>{busy ? "جاري تحديد الموقع" : "استخدم موقعي الحالي"}</Button>
      {err ? <Note tone="warning">{err}</Note> : null}
      <div className="grid grid-cols-2 gap-2">
        <TextField label="خط العرض" value={value.lat} onChange={(lat) => onChange({ ...value, lat })} numeric placeholder="32.885" />
        <TextField label="خط الطول" value={value.lng} onChange={(lng) => onChange({ ...value, lng })} numeric placeholder="13.180" />
      </div>
      <Note tone="info">الخريطة غير مفعّلة في هذه النسخة: نأخذ موقعك من الهاتف، أو تكتب الإحداثيات يدوياً.</Note>
    </div>
  );
}
