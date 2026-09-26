/**
 * ما لا يمرّ بعميل JSON المشترك: رفع صورة (multipart) وتنزيل ملف (PDF) — بالرمز نفسه.
 * رمز منتهٍ: نداء خفيف عبر api يجدّده بصمت، ثم يُعاد الطلب مرة واحدة.
 */
import { ApiError } from "@ui/client";
import { api } from "@/api/client";
import type { MediaOut } from "@/api/types";

const KEY = "madad.customer.tokens";

function token(): string | null {
  try {
    const raw = localStorage.getItem(KEY);
    return raw ? ((JSON.parse(raw) as { access_token?: string }).access_token ?? null) : null;
  } catch {
    return null;
  }
}

async function send(method: string, path: string, body?: FormData): Promise<Response> {
  const go = async () => {
    const t = token();
    try {
      return await fetch(path, { method, body, headers: t ? { Authorization: `Bearer ${t}` } : {} });
    } catch {
      throw new ApiError(0, "network");
    }
  };
  let r = await go();
  if (r.status === 401) {
    // يجدّد الرمز إن أمكن (وإلا يُخرج إلى الدخول)
    await api.get<unknown>(`/api/customer/me`).catch(() => undefined);
    r = await go();
  }
  if (!r.ok) {
    let data: Record<string, unknown> = {};
    try {
      data = (await r.json()) as Record<string, unknown>;
    } catch {
      /* جسم غير JSON */
    }
    const code = typeof data.code === "string" ? data.code : r.status === 422 ? "validation" : r.status >= 500 ? "server" : `http_${r.status}`;
    throw new ApiError(r.status, code, data);
  }
  return r;
}

/** رفع ملف: post("/api/customer/media", form) — form فيه purpose وfile. */
export async function post(path: string, form: FormData): Promise<MediaOut> {
  return (await (await send("POST", path, form)).json()) as MediaOut;
}

/** تنزيل ملف ثنائي بالرمز. */
export async function get(path: string): Promise<Blob> {
  return (await send("GET", path)).blob();
}

/** يحفظ الملف على الجهاز (أو يفتحه حيث لا يدعم المتصفح التنزيل). */
export function saveBlob(blob: Blob, name: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.rel = "noopener";
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60000);
}
