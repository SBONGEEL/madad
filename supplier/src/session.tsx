/** جلسة تطبيق المورد: من أنا ومحلّي وحالته، وعدّاد الاستلام المعلّق — يُحدَّث بعد كل كتابة تغيّره. */
import { createContext, type ReactNode, useCallback, useContext, useEffect, useState } from "react";

import { api } from "@/api/client";
import type { DashboardOut, Me2Out } from "@/api/types";

export interface Session {
  me: Me2Out;
  approved: boolean;
  pickupsPending: number;
  refresh: () => void;
}

const Ctx = createContext<Session | null>(null);

export function SessionProvider({ me, reload, children }: { me: Me2Out; reload: () => void; children: ReactNode }) {
  const approved = me.supplier?.status === "approved";
  const [pickupsPending, setPending] = useState(0);
  const refreshCounts = useCallback(() => {
    if (!approved) return;
    api.get<DashboardOut>(`/api/supplier/dashboard`).then((d) => setPending(d.pickups_today), () => undefined);
  }, [approved]);
  useEffect(() => refreshCounts(), [refreshCounts]);
  return (
    <Ctx.Provider value={{ me, approved, pickupsPending, refresh: () => { reload(); refreshCounts(); } }}>
      {children}
    </Ctx.Provider>
  );
}

export function useSession(): Session {
  const s = useContext(Ctx);
  if (!s) throw new Error("useSession خارج SessionProvider");
  return s;
}
