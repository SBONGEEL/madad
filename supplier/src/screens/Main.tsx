/**
 * 01 الرئيسية (لوحة الأرقام): مبيعاتك لمَدَد هذا الشهر، وعروضك النشطة، وطلبات الاستلام اليوم، ثم عروضك بمفتاح التشغيل والإيقاف.
 * موعد السائق المتوقَّع غير مخزَّن (NO-DB) فلا يُعرض. المورد غير المعتمد يرى حالة الانتظار وأزرار العروض معطّلة.
 */
import { type ReactNode, useState } from "react";
import { Link, useNavigate } from "react-router-dom";

import { Button, EmptyState, ErrorState, Icon, LoadingState, Note, Num, StatCard, Switch, toast, useLoad } from "@ui/kit";
import * as fmt from "@ui/fmt";
import { api } from "@/api/client";
import type { DashboardOut, OfferOut } from "@/api/types";
import { offError, unitLabel } from "@/lib/off-http";
import { HomeHeader } from "@/lib/shell";
import { useSession } from "@/session";

const PENDING: Record<string, [string, string]> = {
  pending: ["حسابك بانتظار اعتماد مَدَد", "نراجع بيانات محلّك. تضيف عروضك بعد الاعتماد، ويصلك إشعار حين يتم."],
  suspended: ["حسابك موقوف", "لا تُضاف عروض ولا تُعدَّل وحسابك موقوف. تواصل مع مَدَد."],
  rejected: ["لم يُعتمد حسابك", "لا تُضاف عروض لحساب غير معتمد. تواصل مع مَدَد."],
};

function pickupsLine(n: number): ReactNode {
  if (n === 1) return "طلب استلام اليوم";
  if (n === 2) return "طلبا استلام اليوم";
  return <><Num>{n}</Num> {n % 100 >= 3 && n % 100 <= 10 ? "طلبات" : "طلب"} استلام اليوم</>;
}

export function Main() {
  const { me, approved } = useSession();
  const nav = useNavigate();
  const state = useLoad(() => Promise.all([
    api.get<DashboardOut>(`/api/supplier/dashboard`),
    api.get<OfferOut[]>(`/api/supplier/offers`),
  ]), []);
  const [offers, setOffers] = useState<OfferOut[] | null>(null);
  const [busyId, setBusyId] = useState<number | null>(null);

  if (state.loading && !state.data) {
    return (
      <>
        <HomeHeader />
        <main className="md-mobile-main"><LoadingState rows={4} /></main>
      </>
    );
  }
  if (!state.data) {
    return (
      <>
        <HomeHeader />
        <main className="md-mobile-main">
          <div className="flex-1 flex flex-col justify-center">
            <ErrorState title="تعذّر تحميل لوحتك" body="تحقق من الاتصال. عروضك تبقى كما هي في مَدَد." code={state.error?.code} onRetry={state.reload} />
          </div>
        </main>
      </>
    );
  }

  const [dash, loaded] = state.data;
  const list = offers ?? loaded;
  const activeCount = offers ? list.filter((o) => o.status === "active").length : dash.active_offers;
  const pending = !approved ? PENDING[me.supplier?.status ?? "pending"] ?? PENDING.pending : null;

  async function toggle(o: OfferOut, on: boolean) {
    setBusyId(o.id);
    try {
      setOffers(await api.patch<OfferOut[]>(`/api/supplier/offers/${o.id}`, { active: on }));
      toast(on ? `«${o.product_name}» نشط الآن.` : `أُوقف «${o.product_name}».`);
    } catch (e) {
      toast(offError(e), true);
    } finally {
      setBusyId(null);
    }
  }

  if (approved && !list.length) {
    return (
      <>
        <HomeHeader />
        <main className="md-mobile-main">
          <div className="flex-1 flex flex-col justify-center">
            <EmptyState icon="package" title="أضف أول عرض" body="اختر الصنف من قاموس مَدَد، وحدّد سعرك والكمية المتاحة وموقع الاستلام."
              action={<Button size="sm" icon="plus" onClick={() => nav("/offers/new")}>إضافة عرض</Button>} />
          </div>
        </main>
      </>
    );
  }

  return (
    <>
      <HomeHeader />
      <main className="md-mobile-main">
        <h1 className="m-0 text-19 font-bold">لوحة التحكم</h1>
        {pending ? (
          <Note tone="warning"><b>{pending[0]}</b><br />{pending[1]}</Note>
        ) : null}
        <div className="grid grid-cols-2 gap-2.5">
          <StatCard label="مبيعاتك لمَدَد هذا الشهر" value={dash.month_sales} money />
          <StatCard label="عروضك النشطة" value={fmt.int(activeCount)} unit="عرضاً" />
        </div>
        {dash.pickups_today > 0 ? (
          <Link to="/pickups" className="flex items-center gap-2.5 p-3 rounded-md bg-warning text-on-warning no-underline">
            <Icon name="truck" />
            <span className="flex-1 text-15"><b>{pickupsLine(dash.pickups_today)}</b>
              {dash.first_eta ? <> — أول سائق حوالي <Num>{fmt.time(dash.first_eta)}</Num></> : null}</span>
            <Icon name="chevron-left" size={18} />
          </Link>
        ) : null}
        <div className="flex justify-between items-center">
          <span className="font-bold text-17">عروضك</span>
          <Button size="sm" icon="plus" disabled={!approved} onClick={() => nav("/offers/new")}>إضافة عرض</Button>
        </div>
        {!list.length ? (
          <EmptyState compact icon="package" title="لا عروض لك بعد" body="تضيف عروضك بعد اعتماد حسابك." />
        ) : (
          <div className="flex flex-col gap-2">
            {list.map((o) => {
              const on = o.status === "active";
              return (
                <div key={o.id} className="bg-surface border border-border rounded-md p-3 flex items-center gap-3">
                  <Switch checked={on} label={o.product_name} disabled={!approved || busyId === o.id || (!on && o.product_status !== "approved")}
                    onChange={(v) => void toggle(o, v)} />
                  <button type="button" onClick={() => nav(`/offers/${o.id}`)}
                    className="flex-1 flex flex-col min-w-0 text-start bg-transparent border-0 p-0 text-ink font-sans cursor-pointer">
                    <span className="font-bold text-15">{o.product_name} — {unitLabel(o.unit, o.unit_size)}</span>
                    <span className="text-13 text-ink-muted">
                      المخزون: <Num>{fmt.qty(o.available_qty)}</Num> · سعرك <Num>{fmt.money(o.purchase_price)}</Num> د.ل
                    </span>
                  </button>
                </div>
              );
            })}
          </div>
        )}
      </main>
    </>
  );
}
