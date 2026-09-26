/**
 * طلبات لا يحملها عميل السلك المشترك: رفع ملف (multipart) وتنزيل ملف (PDF)، برمز الوصول نفسه.
 * رمز منتهٍ يُجدَّد بطلب عادي عبر api ثم يُعاد الطلب مرة واحدة. والأخطاء التي تختلف صياغتها في اللوحات هنا.
 */
import { ApiError, qs } from "@ui/client";
import { arabicError } from "@ui/errors";
import { api } from "@/api/client";
import type { Me2Out, MediaOut } from "@/api/types";

const KEY = "madad.supplier.tokens";

function token(): string | null {
  try {
    const raw = localStorage.getItem(KEY);
    return raw ? ((JSON.parse(raw) as { access_token?: string }).access_token ?? null) : null;
  } catch {
    return null;
  }
}

/** رسائل خاصة بشاشات المورد — تتقدّم على errors.ts حين تختلف صياغة اللوحة. */
const AR: Record<string, string> = {
  supplier_exists: "سجّلت محلّك من قبل.",
  media_type_unsupported: "الملف غير مدعوم: صورة JPG أو PNG أو WEBP، أو ملف PDF.",
  media_empty: "الملف فارغ. اختر ملفاً آخر.",
  media_too_large: "الملف أكبر من 10 ميغابايت.",
  media_purpose_unknown: "نوع المرفق غير معروف.",
  pickup_code_mismatch: "الرمز لا يطابق هذه النقطة. تأكد أنك تمسح رمز سائق مَدَد لهذا الاستلام، أو أعطه رقمك ليكتبه.",
  stop_locked: "هذا الاستلام مقفل: سُلِّم من قبل أو أُلغي.",
  receipt_pending: "الإيصال غير جاهز. يُصدر خلال دقائق من تسجيل الدفعة.",
};

export function accError(e: unknown): string {
  const err = e as { code?: string; message?: string };
  return (err.code && AR[err.code]) || err.message || arabicError("error");
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
      await api.get<Me2Out>(`/api/supplier/me`);
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

/** يرفع هوية المالك أو السجل التجاري (خاصّان بمَدَد) ويعيد رقم الملف. */
export async function uploadMedia(file: File, purpose: "owner_id" | "commercial_register"): Promise<number> {
  if (file.size > MAX_UPLOAD) throw new ApiError(413, "media_too_large");
  const form = new FormData();
  form.append("purpose", purpose);
  form.append("file", file);
  return (await post("/api/supplier/media", form)).id;
}

function save(blob: Blob, name: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/** كشف المستحقات الآن، أو إيصال دفعة بعينها (payout_id). */
export async function downloadDuesPdf(payout_id?: number): Promise<void> {
  const blob = await get(`/api/supplier/dues.pdf${qs({ payout_id })}`);
  save(blob, payout_id ? `madad-receipt-${payout_id}.pdf` : "madad-dues.pdf");
}

/** ورقة الاستلام لنقطة. */
export async function downloadSlip(stopId: number): Promise<void> {
  const blob = await get(`/api/supplier/pickups/${stopId}/slip.pdf`);
  save(blob, `madad-pickup-${stopId}.pdf`);
}
