/** الجلسة: من أنا وما صلاحياتي (GET /api/admin/me). الخادم يفرض الصلاحية؛ هنا تُخفى الأقسام التي لا تُفتح فقط. */
import { createContext, type ReactNode, useContext } from "react";

import type { MeOut } from "@/api/types";

export type Perm = "any" | "owner" | "approvals" | "catalog" | "costs_view" | "orders" | "warehouses" | "money" | "customers"
  | "notifications" | "settings" | "users";

export interface Session {
  me: MeOut;
  isOwner: boolean;
  can: (p: Perm) => boolean;
  refreshCounts: () => void;
}

const Ctx = createContext<Session | null>(null);

export function SessionProvider({ me, refreshCounts, children }: { me: MeOut; refreshCounts: () => void; children: ReactNode }) {
  const isOwner = me.role === "owner";
  const can = (p: Perm) => p === "any" || isOwner || (p !== "owner" && me.permissions.includes(p));
  return <Ctx.Provider value={{ me, isOwner, can, refreshCounts }}>{children}</Ctx.Provider>;
}

export function useSession(): Session {
  const s = useContext(Ctx);
  if (!s) throw new Error("useSession خارج SessionProvider");
  return s;
}
