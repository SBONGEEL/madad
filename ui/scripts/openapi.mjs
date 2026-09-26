/** مصدر OpenAPI المشترك لمولّد الأنواع وحارس العقد. */
import { readFileSync } from "node:fs";

export async function loadSpec() {
  const file = process.env.MADAD_OPENAPI;
  if (file) return JSON.parse(readFileSync(file, "utf8"));
  const base = process.env.VITE_API_TARGET ?? "http://localhost:8000";
  const r = await fetch(`${base}/api/openapi.json`);
  if (!r.ok) throw new Error(`تعذّر جلب OpenAPI من ${base}: ${r.status}`);
  return r.json();
}

export const mine = (aud) => (p) => p.startsWith(`/api/${aud}/`) || p === `/api/${aud}` || p.startsWith("/api/auth/");

/** اسم المخطط كما تراه الواجهة: app__schemas__admin__MeOut ← MeOut. */
export const shortName = (key) => key.split("__").pop().replace(/-(Input|Output)$/, "");
