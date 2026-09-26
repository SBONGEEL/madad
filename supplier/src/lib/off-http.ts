/**
 * مساعدات مجموعة العروض (الرئيسية، العروض، نموذج العرض، مواقع الاستلام):
 * رفع صورة العرض (multipart برمز الوصول نفسه، مع تجديد مرة واحدة عند 401)، والوحدات بالعربية، والتحقق من المنازل العشرية (م-1)،
 * ورسائل الأخطاء التي تختلف صياغتها في اللوحات عن ui/errors.ts.
 */
import { ApiError } from "@ui/client";
import { arabicError } from "@ui/errors";
import * as fmt from "@ui/fmt";
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

const AR: Record<string, string> = {
  party_not_approved: "حسابك بانتظار اعتماد مَدَد. تضيف عروضك بعد الاعتماد.",
  offer_identity_immutable: "الصنف والوحدة لا يتغيران بعد إضافة العرض. أضف عرضاً جديداً.",
  location_in_use: "لا يُعطَّل موقع عليه عروض نشطة. أوقف عروضه أولاً.",
  media_type_unsupported: "الصورة غير مدعومة: JPG أو PNG أو WEBP.",
  media_empty: "الملف فارغ. اختر صورة أخرى.",
  media_too_large: "الصورة أكبر من 10 ميغابايت.",
  validation: "تحقق من الحقول: الأرقام بثلاث منازل عشرية على الأكثر.",
};

export function offError(e: unknown): string {
  const err = e as { code?: string; message?: string };
  const code = err.code ?? "";
  if (/^supplier_offers_.*_key$/.test(code)) return "لديك عرض بالصنف والوحدة والموقع نفسها. عدّله بدل إضافة عرض جديد.";
  return AR[code] || err.message || arabicError("error");
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

export const MAX_UPLOAD = 10 * 1024 * 1024;

/** يرفع صورة العرض (عامة) ويعيد رقمها. */
export async function uploadOfferPhoto(file: File): Promise<number> {
  if (file.size > MAX_UPLOAD) throw new ApiError(413, "media_too_large");
  const form = new FormData();
  form.append("purpose", "offer_photo");
  form.append("file", file);
  return (await post("/api/supplier/media", form)).id;
}

export const mediaUrl = (id: number) => `/api/media/${id}`;

/** وحدات البيع (sale_unit) بترتيب القائمة. */
export const UNITS = ["kg", "liter", "piece", "carton", "pack", "bag", "box", "bottle", "can", "tray", "roll", "bundle"] as const;
export type SaleUnit = (typeof UNITS)[number];

export const UNIT: Record<string, string> = {
  kg: "كغ", liter: "لتر", piece: "حبة", carton: "كرتونة", pack: "علبة", bag: "كيس",
  box: "صندوق", bottle: "قارورة", can: "علبة معدنية", tray: "طبق", roll: "لفة", bundle: "حزمة",
};

/** «كغ»، «2 كغ»، «كرتونة ×12». */
export function unitLabel(unit: string, size?: string | number | null): string {
  const u = UNIT[unit] ?? unit;
  const n = Number(size ?? 1);
  if (!n || n === 1) return u;
  return unit === "kg" || unit === "liter" ? `${fmt.qty(size)} ${u}` : `${u} ×${fmt.qty(size)}`;
}

/** اسم الوحدة وحدها لاحقةً للكمية («كغ»، «كيس»). */
export const unitWord = (unit: string) => UNIT[unit] ?? unit;

/** رقم بثلاث منازل عشرية على الأكثر (م-1). */
export const dec3 = (s: string) => /^\d+(\.\d{1,3})?$/.test(s.trim());

/** خطأ حقل رقمي؛ الفارغ يُعالَج عند الحفظ (مطلوب أو اختياري). */
export function numError(s: string, { positive = true, what = "الرقم" }: { positive?: boolean; what?: string } = {}): string | null {
  const v = s.trim();
  if (!v) return null;
  if (/^\d+\.\d{4,}$/.test(v)) return `${what} بثلاث منازل عشرية على الأكثر، مثل 9.505`;
  if (!dec3(v)) return "اكتب رقماً صحيحاً، مثل 9.505";
  if (positive && Number(v) <= 0) return "أكبر من صفر.";
  return null;
}

/** «اليوم 08:10»، «أمس 09:10»، أو التاريخ. */
export function whenLabel(iso: string | null | undefined): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const start = (x: Date) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const days = Math.round((start(new Date()) - start(d)) / 86400000);
  if (days === 0) return `اليوم ${fmt.time(iso)}`;
  if (days === 1) return `أمس ${fmt.time(iso)}`;
  return fmt.date(iso);
}

/** العدد مع «عرض»: عرض واحد، عرضان، 3 عروض، 11 عرضاً. */
export function offersWord(n: number): string {
  if (n === 0) return "لا عروض";
  if (n === 1) return "عرض واحد";
  if (n === 2) return "عرضان";
  const m = n % 100;
  return m >= 3 && m <= 10 ? `${n} عروض` : `${n} عرضاً`;
}
