/**
 * 06 الكاش والمحفظة (M-11): الكاش بحوزتك مقابل السقف، أجرك المستحق، وما تسلّمه للخزينة حسب طريقتك.
 * طريقة الأجر يحددها مَدَد لكل سائق: خصم من الكاش عند التسوية، أو صرف دوري (موعد الدورة لا عمود له — NO-DB).
 * آخر رصيد ناجح يُحفظ على الجهاز ليُعرض «آخر رصيد معروف» حين ينقطع الاتصال.
 */
import { type ReactNode, useEffect } from "react";
import { Link } from "react-router-dom";

import * as fmt from "@ui/fmt";
import { EmptyState, ErrorState, Icon, LoadingState, Money, Note, Num, StatusBadge, cx, useLoad } from "@ui/kit";
import { api } from "@/api/client";
import type { WalletOut } from "@/api/types";
import { HomeHeader } from "@/lib/shell";

const CACHE = "madad.driver.wallet";

interface Cached { at: string; data: WalletOut }

function readCache(): Cached | null {
  try {
    const raw = localStorage.getItem(CACHE);
    return raw ? (JSON.parse(raw) as Cached) : null;
  } catch {
    return null;
  }
}

function writeCache(data: WalletOut) {
  try {
    localStorage.setItem(CACHE, JSON.stringify({ at: new Date().toISOString(), data }));
  } catch { /* تخزين غير متاح */ }
}

export function Wallet() {
  const w = useLoad(() => api.get<WalletOut>(`/api/driver/wallet`));
  useEffect(() => { if (w.data && !w.error) writeCache(w.data); }, [w.data, w.error]);

  let body;
  if (w.loading && !w.data) {
    body = <LoadingState rows={2} />;
  } else if (w.error || !w.data) {
    const cached = readCache();
    body = (
      <>
        <ErrorState compact title="تعذّر تحديث الرصيد"
          body={cached ? `آخر رصيد معروف من ${fmt.time(cached.at)}. أعد المحاولة.` : "تحقق من اتصالك ثم أعد المحاولة."}
          code={w.error?.code === "network" ? "network_offline" : w.error?.code} onRetry={w.reload} />
        {cached ? <Balance w={cached.data} stale /> : null}
      </>
    );
  } else if (Number(w.data.cash_held) === 0 && Number(w.data.wage_due) === 0) {
    body = (
      <>
        <div className="flex-1 flex flex-col justify-center">
          <EmptyState icon="wallet" title="محفظتك فارغة" body="بعد أول تسليم يظهر هنا الكاش الذي بحوزتك وأجرك المستحق." />
        </div>
        <SettlementsLink />
      </>
    );
  } else {
    body = <Balance w={w.data} />;
  }

  return (
    <>
      <HomeHeader />
      <main className="md-mobile-main">{body}</main>
    </>
  );
}

function Balance({ w, stale }: { w: WalletOut; stale?: boolean }) {
  const cap = w.cash_cap != null ? Number(w.cash_cap) : null;
  const pct = cap && cap > 0 ? Math.min(100, Math.round((Number(w.cash_held) / cap) * 100)) : null;
  return (
    <div className={cx("flex flex-col gap-3", stale && "opacity-70")}>
      <section className={cx("bg-surface rounded-lg p-4 flex flex-col gap-1.5 border", w.over_cap ? "border-error" : "border-border")}>
        <div className="flex justify-between items-center">
          <span className="text-14 text-ink-muted">الكاش بحوزتك</span>
          {w.over_cap ? <StatusBadge tone="error">فوق السقف</StatusBadge> : null}
        </div>
        <Money value={w.cash_held} size="lg" className="self-end text-26 font-bold" />
        {pct != null ? (
          <div className="h-2 rounded-sm bg-primary-tint overflow-hidden" role="meter" aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100} aria-label="الكاش من السقف">
            <div className={cx("h-full", w.over_cap ? "bg-error" : "bg-secondary")} style={{ width: `${pct}%` }} />
          </div>
        ) : null}
        {w.cash_cap != null ? (
          <span className="text-13 text-ink-muted">
            السقف <Num>{fmt.money(w.cash_cap)}</Num>{w.over_cap ? " — لن تُسند لك طلبيات حتى تسلّم." : null}
          </span>
        ) : null}
      </section>

      <section className="bg-surface border border-border rounded-lg p-4 flex flex-col gap-1">
        <span className="text-14 text-ink-muted">أجرك المستحق (المحفظة)</span>
        <Money value={w.wage_due} size="lg" className="self-end text-22 font-bold text-success" />
      </section>

      <PayMethod w={w} />
      <SettlementsLink />
    </div>
  );
}

function Row({ label, children, strong }: { label: string; children: ReactNode; strong?: boolean }) {
  return (
    <div className={cx("flex justify-between items-center gap-2", strong ? "text-17 font-bold border-t border-border pt-1.5" : "text-15")}>
      <span>{label}</span>
      {children}
    </div>
  );
}

function PayMethod({ w }: { w: WalletOut }) {
  if (w.pay_method !== "offset_on_settlement" && w.pay_method !== "periodic") {
    return <Note tone="info">طريقة صرف أجرك يحددها مَدَد في ملفك عند اعتمادك، ولا تتغير من التطبيق.</Note>;
  }
  const offset = w.pay_method === "offset_on_settlement";
  return (
    <section className="bg-secondary-tint rounded-lg p-3.5 flex flex-col gap-1.5">
      <span className="font-bold">{offset ? "عند التسوية القادمة — خصم من الكاش" : "عند التسوية القادمة — تسلّم الكاش كاملاً"}</span>
      <span className="text-13 text-ink-muted">
        {offset ? "طريقتك: خصم من الكاش. يُخصم أجرك عند تسليمك القادم للكاش." : "طريقتك يحددها مَدَد في ملفك، ولا تتغير من التطبيق."}
      </span>
      {offset ? (
        <>
          <Row label="الكاش بحوزتك"><Num>{fmt.money(w.cash_held)}</Num></Row>
          <Row label="ناقص أجرك"><Num>− {fmt.money(w.wage_due)}</Num></Row>
          <Row label="تسلّم للخزينة" strong><Num>{fmt.money(w.handover_due)}</Num></Row>
        </>
      ) : (
        <>
          <Row label="تسلّم للخزينة"><Num>{fmt.money(w.handover_due)}</Num></Row>
          <Row label="أجرك يُصرف في"><span>دورة الصرف</span></Row>
          <Row label="أجرك المستحق" strong><Num>{fmt.money(w.wage_due)}</Num></Row>
        </>
      )}
    </section>
  );
}

function SettlementsLink() {
  return (
    <Link to="/settlements" className="flex items-center gap-3 py-3.5 px-3 bg-surface border border-border rounded-md text-ink no-underline">
      <Icon name="hand-coins" />
      <span className="flex-1">التسويات</span>
      <Icon name="chevron-left" size={18} />
    </Link>
  );
}
