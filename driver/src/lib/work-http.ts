/**
 * مساعدات مجموعة «العمل» في تطبيق السائق (المتاح، المسار، الاستلام، الدفعة، التسليم):
 * رفع صورة (multipart) وتنزيل ورقة الطلبية (PDF) برمز الوصول نفسه، ورسائل الأخطاء بصياغة اللوحات،
 * وتنفيذ عملية كتابة يعيد رمز الخطأ لتعرضه الشاشة في مكانه، وحساب حالة النقاط والدفعات.
 */
import { useCallback, useState } from "react";

import { ApiError } from "@ui/client";
import { arabicError } from "@ui/errors";
import * as fmt from "@ui/fmt";
import { toast } from "@ui/kit";
import { api } from "@/api/client";
import type { BatchOut, ItemOut, Me2Out, MediaOut, Order2Out, StopOut } from "@/api/types";

const KEY = "madad.driver.tokens";

function token(): string | null {
  try {
    const raw = localStorage.getItem(KEY);
    return raw ? ((JSON.parse(raw) as { access_token?: string }).access_token ?? null) : null;
  } catch {
    return null;
  }
}

async function send(method: string, path: string, body?: FormData): Promise<Response> {
  const go = () => {
    const t = token();
    return fetch(path, { method, body, headers: t ? { Authorization: `Bearer ${t}` } : {} });
  };
  let r: Response;
  try {
    r = await go();
    if (r.status === 401) {
      // يجدّد الرمز عبر العميل المشترك (يُخرج إلى الدخول إن فشل التجديد) ثم يعيد مرة واحدة
      await api.get<Me2Out>(`/api/driver/me`);
      r = await go();
    }
  } catch (e) {
    if (e instanceof ApiError) throw e;
    throw new ApiError(0, "network");
  }
  if (!r.ok) {
    let data: Record<string, unknown> = {};
    try {
      data = (await r.json()) as Record<string, unknown>;
    } catch {
      /* جسم غير JSON */
    }
    const code = typeof data.code === "string" ? data.code : r.status === 413 ? "media_too_large" : r.status === 422 ? "validation" : r.status >= 500 ? "server" : `http_${r.status}`;
    throw new ApiError(r.status, code, data);
  }
  return r;
}

/** رفع ملف: multipart (purpose + file). */
async function post(path: string, form: FormData): Promise<MediaOut> {
  return (await (await send("POST", path, form)).json()) as MediaOut;
}

/** تنزيل ملف برمز الوصول. */
async function get(path: string): Promise<Blob> {
  return (await send("GET", path)).blob();
}

export const MAX_UPLOAD = 10 * 1024 * 1024;

/** صورة الاستلام أو صورة النزاع (خاصّتان بمَدَد) ← رقم الملف. */
export async function uploadPhoto(file: File, purpose: "pickup_photo" | "dispute_photo"): Promise<number> {
  if (file.size > MAX_UPLOAD) throw new ApiError(413, "media_too_large");
  const form = new FormData();
  form.append("purpose", purpose);
  form.append("file", file);
  return (await post("/api/driver/media", form)).id;
}

/** ورقة الطلبية PDF: النقاط وأصنافها والوجهة. */
export async function downloadSheet(id: number): Promise<void> {
  const blob = await get(`/api/driver/orders/${id}/sheet.pdf`);
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `madad-order-${id}.pdf`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

// ——— الأخطاء بصياغة اللوحات ————————————————————————————————————————————————————————
const AR: Record<string, string> = {
  pickup_code_mismatch: "الرقم لا يطابق هذه النقطة",
  pickup_proof_required: "أرِ المورد رمزك QR ليمسحه، أو اكتب الرقم الذي يعطيك إياه، قبل تأكيد النقطة.",
  stop_short_requires_qty: "اختر لكل صنف: استلمت أو نقص أو رفض، قبل تأكيد النقطة.",
  stop_lines_incomplete: "اختر لكل صنف: استلمت أو نقص أو رفض، قبل تأكيد النقطة.",
  stop_collected_requires_full_qty: "الكمية المستلمة أقل من المطلوب: اختر «نقص» واكتب المستلم فعلاً.",
  batch_notice_needs_later_eta: "اكتب موعد ما سيصل لاحقاً؛ يصل للعميل في الإشعار.",
  batch_qty_exceeds_collected: "الكمية أكبر مما استلمته من نقاط الاستلام.",
  batch_departure_requires_notice: "لا انطلاق قبل إشعار العميل بما يصل الآن ولاحقاً.",
  batch_notice_sent_is_immutable: "محتوى الإشعار ثابت بعد إرساله؛ تغيير الأصناف يحتاج دفعة جديدة وإشعاراً جديداً.",
  batch_notice_no_recipient: "لا مستلم للإشعار في حساب العميل. تواصل مع مَدَد.",
  batch_empty: "اختر صنفاً واحداً على الأقل في الدفعة.",
  driver_cash_cap_exceeded: "الإسناد موقوف حتى التسوية: بحوزتك كاش فوق السقف.",
  order_not_open_for_offers: "لم تعد هذه الطلبية متاحة؛ قبلها سائق آخر أو أُلغيت.",
  route_km_missing: "لم يحدد مَدَد مسافة هذه الطلبية بعد.",
  media_too_large: "الصورة أكبر من 10 ميغابايت.",
  media_type_unsupported: "الملف غير مدعوم: صورة JPG أو PNG أو WEBP.",
  stop_already_arrived: "علّمت الوصول إلى هذه النقطة من قبل.",
};

export function workError(code: string, fallback?: string): string {
  return AR[code] ?? fallback ?? arabicError(code);
}

// ——— الوقت بتوقيت طرابلس (UTC+2 طوال السنة) ————————————————————————————————————————————
const TRIPOLI = "Africa/Tripoli";

/** «10:30» بتوقيت طرابلس أياً كانت منطقة الجهاز. */
export function tripoliTime(iso: string | null | undefined): string {
  if (!iso) return "";
  return new Intl.DateTimeFormat("en-GB", { timeZone: TRIPOLI, hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(new Date(iso));
}

/** «10:30» اليوم بتوقيت طرابلس ← ISO للسلك، أو null إن لم تكن ساعة صحيحة. */
export function tripoliToday(hm: string): string | null {
  const m = hm.trim().replace(/[.,٫]/, ":").match(/^([01]?\d|2[0-3]):([0-5]\d)$/);
  if (!m) return null;
  const ymd = new Intl.DateTimeFormat("en-CA", { timeZone: TRIPOLI, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
  return `${ymd}T${m[1]!.padStart(2, "0")}:${m[2]}:00+02:00`;
}

export type Res<T> = { v: T; code: null } | { v: null; code: string };

/**
 * عملية كتابة: حالة الانشغال، والخطأ بصياغة اللوحة في تنبيه عابر — إلا الرموز التي تعرضها الشاشة في مكانها (inline).
 */
export function useWork() {
  const [busy, setBusy] = useState(false);
  const run = useCallback(async <T,>(fn: () => Promise<T>, opts?: { ok?: string; inline?: string[] }): Promise<Res<T>> => {
    setBusy(true);
    try {
      const v = await fn();
      if (opts?.ok) toast(opts.ok);
      return { v, code: null };
    } catch (e) {
      const err = e as { code?: string; message?: string };
      const code = err.code ?? "error";
      if (!opts?.inline?.includes(code)) toast(workError(code, err.message), true);
      return { v: null, code };
    } finally {
      setBusy(false);
    }
  }, []);
  return { busy, run };
}

// ——— الوحدات والكميات ————————————————————————————————————————————————————————————
export const UNIT: Record<string, string> = {
  kg: "كغ", liter: "لتر", piece: "حبة", carton: "كرتونة", pack: "علبة", bag: "كيس",
  box: "صندوق", bottle: "قارورة", can: "علبة معدنية", tray: "طبق", roll: "لفة", bundle: "حزمة",
};

/** «15 كغ» أو «12 كرتونة». */
export function qtyUnit(qty: string | number, unit?: string | null): string {
  return `${fmt.qty(qty)} ${unit ? UNIT[unit] ?? unit : ""}`.trim();
}

// ——— النقاط ————————————————————————————————————————————————————————————————————
export type StopState = "done" | "next" | "todo" | "cancelled";

/** استُلمت (جُمعت أو نقصت أو رُفضت) / التالية (أول معلّقة) / بعدها. */
export function stopStates(stops: StopOut[]): Map<number, StopState> {
  const out = new Map<number, StopState>();
  let nextGiven = false;
  for (const s of [...stops].sort((a, b) => a.seq - b.seq)) {
    if (s.status === "cancelled") out.set(s.id, "cancelled");
    else if (s.status !== "pending") out.set(s.id, "done");
    else if (!nextGiven) { out.set(s.id, "next"); nextGiven = true; }
    else out.set(s.id, "todo");
  }
  return out;
}

export const STOP_STATUS: Record<string, string> = { collected: "استُلمت", short: "ناقصة", refused: "مرفوضة", pending: "بانتظار الاستلام", cancelled: "أُلغيت" };

/** رابط الملاحة في خرائط Google: بالإحداثيات، أو بالعنوان إن لم تكن. */
export function navUrl(lat: string | null, lng: string | null, address?: string | null): string | null {
  if (lat && lng) return `https://www.google.com/maps/dir/?api=1&destination=${lat},${lng}`;
  if (address) return `https://www.google.com/maps/dir/?api=1&destination=${encodeURIComponent(address)}`;
  return null;
}

// ——— الدفعات ————————————————————————————————————————————————————————————————————
export interface NoticeLine { item: string; qty: string | number; unit: string }
export interface Notice { now: NoticeLine[]; later: NoticeLine[]; eta: string | null; later_eta: string | null; channels: string[] }

export function noticeOf(b: BatchOut): Notice | null {
  const n = b.notice as Partial<Notice> | null;
  if (!n) return null;
  return { now: n.now ?? [], later: n.later ?? [], eta: n.eta ?? null, later_eta: n.later_eta ?? null, channels: n.channels ?? [] };
}

export const CHANNEL: Record<string, string> = { push: "إشعار", sms: "SMS" };

export function batchLines(b: BatchOut): Array<{ order_item_id: number; qty: string }> {
  return b.lines.map((l) => ({ order_item_id: Number(l.order_item_id), qty: String(l.qty ?? "0") }));
}

/** كمية الصنف في الدفعات التي لم تُسلَّم بعد (مخططة أو أُشعر بها أو انطلقت). */
export function inOpenBatches(o: Order2Out, itemId: number, except?: number): number {
  return o.batches
    .filter((b) => b.status !== "delivered" && b.id !== except)
    .flatMap(batchLines)
    .filter((l) => l.order_item_id === itemId)
    .reduce((s, l) => s + Number(l.qty), 0);
}

/** المتاح لدفعة جديدة من الصنف: المستلم − المسلَّم − ما في دفعات مفتوحة. */
export function availableFor(o: Order2Out, it: ItemOut): number {
  return Math.max(0, round3(Number(it.collected_qty) - Number(it.delivered_qty) - inOpenBatches(o, it.id)));
}

export function round3(n: number): number {
  return Math.round(n * 1000) / 1000;
}

/** الدفعة الجارية: آخر دفعة لم تُسلَّم. */
export function openBatch(o: Order2Out): BatchOut | null {
  return [...o.batches].reverse().find((b) => b.status !== "delivered") ?? null;
}

/** «16:30» اليوم ← ISO بتوقيت الجهاز. */
export function todayAt(hhmm: string): string | null {
  const m = hhmm.match(/^(\d{1,2}):(\d{2})$/);
  if (!m) return null;
  const d = new Date();
  d.setHours(Number(m[1]), Number(m[2]), 0, 0);
  return d.toISOString();
}

export const ACTIVE_ORDER = new Set(["assigned", "collecting", "partially_delivered"]);
