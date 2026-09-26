/** جلسة تطبيق السائق: من أنا ومركبتي وحالتي، وطلبيتي الجارية — تُحدَّث بعد كل خطوة تغيّرها. */
import { createContext, type ReactNode, useCallback, useContext, useEffect, useState } from "react";

import { api } from "@/api/client";
import type { Me2Out, Order2SummaryOut } from "@/api/types";

export interface Session {
  me: Me2Out;
  approved: boolean;
  /** الطلبية الجارية (أُسندت أو يجري جمعها أو وصل جزء)، إن وُجدت. */
  current: Order2SummaryOut | null;
  refresh: () => void;
}

const ACTIVE = new Set(["assigned", "collecting", "partially_delivered"]);
const Ctx = createContext<Session | null>(null);

export function SessionProvider({ me, reload, children }: { me: Me2Out; reload: () => void; children: ReactNode }) {
  const approved = me.driver?.status === "approved";
  const [current, setCurrent] = useState<Order2SummaryOut | null>(null);
  const load = useCallback(() => {
    if (!approved) return;
    api.get<Order2SummaryOut[]>(`/api/driver/orders`).then((os) => setCurrent(os.find((o) => ACTIVE.has(o.status)) ?? null),
      () => undefined);
  }, [approved]);
  useEffect(() => load(), [load]);
  return <Ctx.Provider value={{ me, approved, current, refresh: () => { reload(); load(); } }}>{children}</Ctx.Provider>;
}

export function useSession(): Session {
  const s = useContext(Ctx);
  if (!s) throw new Error("useSession خارج SessionProvider");
  return s;
}
