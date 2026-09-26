/** جلسة تطبيق العميل: من أنا، ودوري في منشأتي، وعدّاد السلة والإشعارات — تُحدَّث بعد كل كتابة تغيّرها. */
import { createContext, type ReactNode, useCallback, useContext, useEffect, useState } from "react";

import type { CartOut, Me2Out } from "@/api/types";
import { api } from "@/api/client";
import { localCart } from "@/lib/local-cart";

export interface Session {
  me: Me2Out;
  approved: boolean;
  isOwner: boolean;
  cartCount: number;
  refresh: () => void;
  setCart: (c: CartOut) => void;
}

const Ctx = createContext<Session | null>(null);

export function SessionProvider({ me, reload, children }: { me: Me2Out; reload: () => void; children: ReactNode }) {
  const approved = me.customer?.status === "approved";
  const [cartCount, setCartCount] = useState(0);
  const refreshCart = useCallback(() => {
    if (!approved) {
      setCartCount(localCart.lines().length);
      return;
    }
    api.get<CartOut>(`/api/customer/cart`).then((c) => setCartCount(c.lines.length), () => undefined);
  }, [approved]);
  useEffect(() => refreshCart(), [refreshCart]);
  useEffect(() => localCart.subscribe(refreshCart), [refreshCart]);
  const value: Session = {
    me, approved, isOwner: me.member?.role === "owner", cartCount,
    refresh: () => { reload(); refreshCart(); },
    setCart: (c) => setCartCount(c.lines.length),
  };
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useSession(): Session {
  const s = useContext(Ctx);
  if (!s) throw new Error("useSession خارج SessionProvider");
  return s;
}
