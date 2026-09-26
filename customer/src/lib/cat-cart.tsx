/**
 * مشترك شاشات الكتالوج والسلة: تسمية الوحدة، ورابط الصورة العامة، وفرع السلة لصاحب المنشأة متعدد الفروع،
 * وتعديل كمية صنف في السلة (سلة الخادم بعد الاعتماد، وسلة الجهاز قبله).
 */
import { useCallback, useEffect, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import { useNavigate } from "react-router-dom";

import * as fmt from "@ui/fmt";
import { ProductCard, toast } from "@ui/kit";
import { api } from "@/api/client";
import type { BranchOut, CartOut, Catalog2Out } from "@/api/types";
import { localCart } from "@/lib/local-cart";
import { useSession } from "@/session";

/** وحدات البيع (sale_unit). */
export const UNIT: Record<string, string> = {
  kg: "كغ", liter: "لتر", piece: "حبة", carton: "كرتونة", pack: "علبة", bag: "كيس",
  box: "صندوق", bottle: "قارورة", can: "علبة معدنية", tray: "صينية", roll: "لفة", bundle: "حزمة",
};

/** «كغ»، «2 كغ»، «كرتونة ×24». */
export function unitLabel(unit: string, size: string | number): string {
  const u = UNIT[unit] ?? unit;
  const n = Number(size);
  if (!n || n === 1) return u;
  return unit === "kg" || unit === "liter" ? `${fmt.qty(size)} ${u}` : `${u} ×${fmt.qty(size)}`;
}

/** صورة الصنف العامة (بلا رمز دخول). */
export function mediaUrl(id: number | null | undefined): string | null {
  return id ? `/api/media/${id}` : null;
}

// ——— فرع السلة ——————————————————————————————————————————————————————————————
const BRANCH_KEY = "madad.customer.cartBranch";
let chosen: number | null = (() => {
  try {
    const v = Number(localStorage.getItem(BRANCH_KEY));
    return v > 0 ? v : null;
  } catch {
    return null;
  }
})();
let version = 0;
const subs = new Set<() => void>();
let branchesP: Promise<BranchOut[]> | null = null;

/** فروع المنشأة المعتمدة الفعّالة (تُحمَّل مرة في الجلسة). */
export function approvedBranches(fresh = false): Promise<BranchOut[]> {
  if (fresh) branchesP = null;
  branchesP ??= api.get<BranchOut[]>(`/api/customer/branches`)
    .then((bs) => bs.filter((b) => b.status === "approved" && b.active))
    .catch((e: unknown) => {
      branchesP = null;
      throw e;
    });
  return branchesP;
}

/**
 * الفرع الذي يُرسل مع نداءات السلة: المسؤول مثبَّت على فرعه والصاحب بفرع معتمد واحد لا يحتاجان شيئاً (null)،
 * والصاحب بعدة فروع يرسل ما اختاره (أو أولها).
 */
export async function cartBranchId(isOwner: boolean): Promise<number | null> {
  if (!isOwner) return null;
  try {
    const bs = await approvedBranches();
    if (bs.length < 2) return null;
    return bs.some((b) => b.id === chosen) ? chosen : (bs[0]?.id ?? null);
  } catch {
    return null;
  }
}

export function chooseBranch(id: number) {
  chosen = id;
  try {
    localStorage.setItem(BRANCH_KEY, String(id));
  } catch {
    /* تخزين غير متاح: الاختيار لهذه الجلسة */
  }
  version += 1;
  subs.forEach((f) => f());
}

/** رقم يتغيّر حين يتغيّر فرع السلة: يوضع في تبعيات التحميل. */
export function useBranchVersion(): number {
  return useSyncExternalStore((f) => {
    subs.add(f);
    return () => { subs.delete(f); };
  }, () => version);
}

// ——— كمية الصنف في السلة ————————————————————————————————————————————————————————
type QtySource = { id: number; cart_qty: string | null };

export function useCartQty() {
  const { approved, isOwner, setCart } = useSession();
  const [over, setOver] = useState<Record<number, number>>({});
  const [, tick] = useState(0);
  const pending = useRef(new Set<number>());
  useEffect(() => localCart.subscribe(() => tick((n) => n + 1)), []);

  const qtyOf = useCallback((it: QtySource): number => {
    if (!approved) return Number(localCart.qty(it.id) ?? 0);
    return over[it.id] ?? Number(it.cart_qty ?? 0);
  }, [approved, over]);

  /** يضبط الكمية كما هي (0 = حذف). يعيد true عند النجاح. */
  const setQty = useCallback(async (id: number, qty: number, prev: number): Promise<boolean> => {
    if (!approved) {
      localCart.set(id, String(qty));
      return true;
    }
    if (pending.current.has(id)) return false;
    pending.current.add(id);
    setOver((o) => ({ ...o, [id]: qty }));
    try {
      const branch_id = await cartBranchId(isOwner);
      const cart = await api.put<CartOut>(`/api/customer/cart/items/${id}`, { qty: String(qty), branch_id });
      setCart(cart);
      const line = cart.lines.find((l) => l.catalog_item_id === id);
      setOver((o) => ({ ...o, [id]: line ? Number(line.qty) : 0 }));
      return true;
    } catch (e) {
      setOver((o) => ({ ...o, [id]: prev }));
      toast((e as Error).message, true);
      return false;
    } finally {
      pending.current.delete(id);
    }
  }, [approved, isOwner, setCart]);

  return { qtyOf, setQty };
}

/** بطاقة صنف تفتح صفحته، وزرّ الإضافة/العدّاد فيها يعدّل السلة. */
export function ItemCard({ item, qty, onQty, layout }: {
  item: Catalog2Out; qty: number; onQty: (v: number) => void; layout?: "row";
}) {
  const nav = useNavigate();
  const open = () => nav(`/product/${item.id}`);
  return (
    <div role="link" tabIndex={0} className="cursor-pointer min-w-0" aria-label={item.name_ar}
      onClick={(e) => { if (!(e.target as HTMLElement).closest("button")) open(); }}
      onKeyDown={(e) => { if (e.key === "Enter" && e.target === e.currentTarget) open(); }}>
      <ProductCard name={item.name_ar} unit={unitLabel(item.unit, item.unit_size)} price={item.sale_price ?? 0}
        image={mediaUrl(item.image_media_id)} outOfStock={item.out_of_stock || !item.orderable}
        qty={qty} onQty={onQty} layout={layout} />
    </div>
  );
}

/** قائمة بطاقات مربوطة بالسلة. */
export function ItemList({ items, layout, className }: { items: Catalog2Out[]; layout?: "row"; className?: string }) {
  const { qtyOf, setQty } = useCartQty();
  return (
    <div className={className ?? (layout === "row" ? "flex flex-col gap-2" : "grid grid-cols-2 gap-2.5")}>
      {items.map((it) => {
        const q = qtyOf(it);
        return <ItemCard key={it.id} item={it} qty={q} layout={layout} onQty={(v) => void setQty(it.id, v, q)} />;
      })}
    </div>
  );
}

/** سطر مجموع: عنوان يميناً وقيمة يساراً. */
export function SumRow({ label, children, big }: { label: ReactNode; children: ReactNode; big?: boolean }) {
  return (
    <div className={big ? "flex justify-between items-center text-18 font-bold" : "flex justify-between items-center text-15"}>
      <span>{label}</span>{children}
    </div>
  );
}
