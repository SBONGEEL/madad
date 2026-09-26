/** فتح وثيقة خاصة من اللوحة: POST مسجَّل (media_views) يعيد الملف نفسه؛ يُعرض بعنوان مؤقت في المتصفح. */
import { ApiError } from "@ui/client";
import { api } from "@/api/client";

function token(): string | null {
  try {
    const raw = localStorage.getItem("madad.admin.tokens");
    return raw ? (JSON.parse(raw) as { access_token: string }).access_token : null;
  } catch {
    return null;
  }
}

/** طلب يعيد بايتات لا JSON، بالرمز نفسه، ومرة ثانية بعد تجديده إن انتهى. */
async function post(path: string): Promise<Blob> {
  const send = () => fetch(path, { method: "POST", headers: token() ? { Authorization: `Bearer ${token()}` } : {} });
  let r = await send();
  if (r.status === 401) {
    await api.get(`/api/admin/me`).catch(() => undefined);
    r = await send();
  }
  if (!r.ok) {
    const body = (await r.json().catch(() => ({}))) as { code?: string };
    throw new ApiError(r.status, body.code ?? `http_${r.status}`);
  }
  return r.blob();
}

export async function openDocument(mediaId: number): Promise<string> {
  return URL.createObjectURL(await post(`/api/admin/media/${mediaId}/open`));
}
