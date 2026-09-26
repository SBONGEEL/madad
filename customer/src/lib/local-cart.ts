/**
 * سلة الجهاز للمنشأة التي لم تُعتمد بعد: القاعدة لا تفتح سلة قبل الاعتماد (party_not_approved)،
 * والتصميم يعِد «سلتك محفوظة». تُرفع إلى سلة الخادم عند أول فتح بعد الاعتماد (syncToServer).
 */
import { api } from "@/api/client";
import type { CartOut } from "@/api/types";

const KEY = "madad.customer.localCart";
type Lines = Record<string, string>;
const listeners = new Set<() => void>();

function read(): Lines {
  try {
    return JSON.parse(localStorage.getItem(KEY) ?? "{}") as Lines;
  } catch {
    return {};
  }
}

function write(l: Lines) {
  try {
    localStorage.setItem(KEY, JSON.stringify(l));
  } catch {
    /* تخزين غير متاح: السلة في هذه الجلسة وحدها */
  }
  listeners.forEach((f) => f());
}

export const localCart = {
  lines: (): Array<{ id: number; qty: string }> => Object.entries(read()).map(([id, qty]) => ({ id: Number(id), qty })),
  qty: (id: number): string | null => read()[String(id)] ?? null,
  set(id: number, qty: string) {
    const l = read();
    if (Number(qty) > 0) l[String(id)] = qty;
    else delete l[String(id)];
    write(l);
  },
  clear: () => write({}),
  subscribe(f: () => void) {
    listeners.add(f);
    return () => { listeners.delete(f); };
  },
  /** بعد الاعتماد: كل سطر إلى سلة الخادم، ثم تُفرَّغ سلة الجهاز. غير المتاح يسقط بصمت ويبقى ما نجح. */
  async syncToServer(): Promise<CartOut | null> {
    const lines = localCart.lines();
    if (!lines.length) return null;
    let last: CartOut | null = null;
    for (const ln of lines) {
      try {
        last = await api.put<CartOut>(`/api/customer/cart/items/${ln.id}`, { qty: ln.qty });
      } catch {
        /* الصنف لم يعد متاحاً */
      }
    }
    localCart.clear();
    return last;
  },
};
