/**
 * عميل السلك المشترك بين الواجهات الأربع: رمز وصول قصير + تجديد يُدوَّر (§14).
 * رمز منتهٍ يُجدَّد مرة واحدة بصمت ثم يُعاد الطلب؛ فشل التجديد يُخرج إلى الدخول.
 * الخطأ يصل برمزه الثابت (code) وبعربيته من errors.ts.
 */
import { arabicError } from "./errors";

export type Audience = "admin" | "customer" | "supplier" | "driver";

export class ApiError extends Error {
  constructor(public status: number, public code: string, public extra: Record<string, unknown> = {}) {
    super(arabicError(code));
  }
}

interface Tokens {
  access_token: string;
  refresh_token: string;
}

type Listener = () => void;

export function createClient(audience: Audience) {
  const KEY = `madad.${audience}.tokens`;
  const listeners = new Set<Listener>();
  let refreshing: Promise<boolean> | null = null;

  function read(): Tokens | null {
    try {
      const raw = localStorage.getItem(KEY);
      return raw ? (JSON.parse(raw) as Tokens) : null;
    } catch {
      return null;
    }
  }

  function save(t: Tokens | null) {
    try {
      if (t) localStorage.setItem(KEY, JSON.stringify({ access_token: t.access_token, refresh_token: t.refresh_token }));
      else localStorage.removeItem(KEY);
    } catch {
      /* تخزين غير متاح: تبقى الجلسة في هذه الصفحة وحدها */
    }
    listeners.forEach((l) => l());
  }

  async function raw(method: string, path: string, body?: unknown, token?: string): Promise<Response> {
    const headers: Record<string, string> = {};
    if (body !== undefined) headers["Content-Type"] = "application/json";
    if (token) headers.Authorization = `Bearer ${token}`;
    try {
      return await fetch(path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
    } catch {
      throw new ApiError(0, "network");
    }
  }

  async function fail(r: Response): Promise<never> {
    let data: Record<string, unknown> = {};
    try {
      data = (await r.json()) as Record<string, unknown>;
    } catch {
      /* جسم غير JSON */
    }
    const code = typeof data.code === "string" ? data.code : r.status === 422 ? "validation" : r.status >= 500 ? "server" : `http_${r.status}`;
    const { code: _c, ...extra } = data;
    void _c;
    throw new ApiError(r.status, code, extra);
  }

  async function refresh(): Promise<boolean> {
    const t = read();
    if (!t) return false;
    refreshing ??= (async () => {
      const r = await raw("POST", "/api/auth/refresh", { refresh_token: t.refresh_token });
      if (!r.ok) {
        save(null);
        return false;
      }
      save((await r.json()) as Tokens);
      return true;
    })().finally(() => {
      refreshing = null;
    });
    return refreshing;
  }

  async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
    let r = await raw(method, path, body, read()?.access_token);
    if (r.status === 401 && (await refresh())) r = await raw(method, path, body, read()?.access_token);
    if (r.status === 401) save(null);
    if (!r.ok) return fail(r);
    if (r.status === 204) return undefined as T;
    return (await r.json()) as T;
  }

  /** طلب بلا رمز (الدخول والاستعادة). */
  async function open<T>(method: string, path: string, body?: unknown): Promise<T> {
    const r = await raw(method, path, body);
    if (!r.ok) return fail(r);
    if (r.status === 204) return undefined as T;
    return (await r.json()) as T;
  }

  return {
    audience,
    get: <T>(path: string) => request<T>("GET", path),
    post: <T>(path: string, body?: unknown) => request<T>("POST", path, body ?? {}),
    put: <T>(path: string, body?: unknown) => request<T>("PUT", path, body ?? {}),
    patch: <T>(path: string, body?: unknown) => request<T>("PATCH", path, body ?? {}),
    del: <T>(path: string) => request<T>("DELETE", path),
    open,
    /** طلب برمز معيّن لا يُحفظ: رمز «تغيير كلمة المرور أولاً» بعد إعادة التعيين (م-20). */
    async postAs<T>(path: string, body: unknown, token: string): Promise<T> {
      const r = await raw("POST", path, body, token);
      if (!r.ok) return fail(r);
      return (r.status === 204 ? undefined : await r.json()) as T;
    },
    signedIn: () => read() !== null,
    setTokens: (t: Tokens) => save(t),
    async logout() {
      const t = read();
      save(null);
      if (t) await raw("POST", "/api/auth/logout", { refresh_token: t.refresh_token }).catch(() => undefined);
    },
    subscribe(l: Listener) {
      listeners.add(l);
      return () => listeners.delete(l);
    },
  };
}

export type Client = ReturnType<typeof createClient>;

/** ?a=1&b=… بلا القيم الفارغة. */
export function qs(params: Record<string, string | number | boolean | null | undefined>): string {
  const q = Object.entries(params)
    .filter(([, v]) => v !== undefined && v !== null && v !== "")
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`)
    .join("&");
  return q ? `?${q}` : "";
}
