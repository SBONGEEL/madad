/**
 * طلبات الحساب التي لا يحملها عميل السلك المشترك: رفع ملف (multipart) وتنزيل ملف (PDF)، برمز الوصول نفسه.
 * رمز منتهٍ يُجدَّد بطلب عادي عبر api ثم يُعاد الطلب مرة واحدة. والأخطاء التي لا يعرفها ui/errors.ts بعربيتها هنا.
 */
import { ApiError, qs } from "@ui/client";
import { arabicError } from "@ui/errors";
import { api } from "@/api/client";
import type { Me2Out, MediaOut } from "@/api/types";

const KEY = "madad.customer.tokens";

function token(): string | null {
  try {
    const raw = localStorage.getItem(KEY);
    return raw ? ((JSON.parse(raw) as { access_token?: string }).access_token ?? null) : null;
  } catch {
    return null;
  }
}

/** رسائل خاصة بشاشات الحساب — تتقدّم على errors.ts حين تختلف صياغة اللوحة. */
const AR: Record<string, string> = {
  member_exists: "هذا الرقم مضاف من قبل إلى منشأة.",
  establishment_exists: "لحسابك منشأة مسجّلة من قبل.",
  forbidden_owner_member: "إضافة المستخدمين والفروع لصاحب المنشأة وحده.",
  media_type_unsupported: "الملف غير مدعوم: صورة JPG أو PNG أو WEBP، أو ملف PDF.",
  media_empty: "الملف فارغ. اختر ملفاً آخر.",
  media_too_large: "الملف أكبر من 10 ميغابايت.",
  media_purpose_unknown: "نوع المرفق غير معروف.",
  month_invalid: "الشهر غير صحيح.",
};

export function acctError(e: unknown): string {
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
      await api.get<Me2Out>(`/api/customer/me`);
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

/** يرفع صورة الواجهة أو السجل التجاري ويعيد رقم الملف (media_id). */
export async function uploadMedia(file: File, purpose: "facade" | "commercial_register"): Promise<number> {
  if (file.size > MAX_UPLOAD) throw new ApiError(413, "media_too_large");
  const form = new FormData();
  form.append("purpose", purpose);
  form.append("file", file);
  return (await post("/api/customer/media", form)).id;
}

/** تقرير الشهر PDF (م-9): يُنزَّل باسم الشهر. */
export async function downloadReportPdf(month: string): Promise<void> {
  const blob = await get(`/api/customer/reports.pdf${qs({ month })}`);
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `madad-report-${month}.pdf`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
