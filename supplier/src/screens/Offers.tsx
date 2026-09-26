/**
 * 02 العروض: كل عروض المورد بحالتها (نشط/موقوف/صنف مقترح)، ووحدتها والمتاح والمحجوز والحد الأدنى وسعره وآخر تحديث.
 * البحث في القائمة محلياً. الضغط على عرض يفتح تعديله، و«عرض +» يفتح عرضاً جديداً.
 */
import { useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";

import { Button, EmptyState, ErrorState, LoadingState, Note, Num, StatusBadge, TextField, type Tone, useLoad } from "@ui/kit";
import * as fmt from "@ui/fmt";
import { api } from "@/api/client";
import type { OfferOut } from "@/api/types";
import { unitLabel, unitWord, whenLabel } from "@/lib/off-http";
import { HomeHeader } from "@/lib/shell";
import { useSession } from "@/session";

function badge(o: OfferOut): [string, Tone] {
  if (o.product_status === "proposed") return ["صنف مقترح", "warning"];
  if (o.product_status !== "approved") return ["صنف غير معتمد", "error"];
  return o.status === "active" ? ["نشط", "success"] : ["موقوف", "neutral"];
}

function meta(o: OfferOut): string {
  if (o.product_status === "proposed") return "بانتظار اعتماد مَدَد للصنف في القاموس";
  const parts: string[] = [];
  const u = unitWord(o.unit);
  if (Number(o.reserved_qty) > 0) parts.push(`محجوز ${fmt.qty(o.reserved_qty)} ${u} للاستلام`);
  if (o.min_order_qty) parts.push(`حد أدنى للطلب ${fmt.qty(o.min_order_qty)} ${u}`);
  parts.push(`${o.status === "active" ? "حُدِّث" : "أوقفته"} ${whenLabel(o.updated_at)}`);
  return parts.join(" · ");
}

export function Offers() {
  const nav = useNavigate();
  const { approved } = useSession();
  const state = useLoad(() => api.get<OfferOut[]>(`/api/supplier/offers`), []);
  const [q, setQ] = useState("");
  const rows = useMemo(() => {
    const t = q.trim();
    return (state.data ?? []).filter((o) => !t || o.product_name.includes(t) || o.location_label.includes(t));
  }, [state.data, q]);

  const add = <Button size="sm" icon="plus" disabled={!approved} onClick={() => nav("/offers/new")}>إضافة عرض</Button>;

  let body;
  if (state.loading && !state.data) body = <LoadingState rows={5} />;
  else if (!state.data) {
    body = (
      <div className="flex-1 flex flex-col justify-center">
        <ErrorState title="تعذّر تحميل عروضك" body="تحقق من الاتصال. عروضك تبقى كما هي في مَدَد." code={state.error?.code} onRetry={state.reload} />
      </div>
    );
  } else if (!state.data.length) {
    body = (
      <div className="flex-1 flex flex-col justify-center">
        <EmptyState icon="package" title="لا عروض لك بعد" body="كل عرض: صنف من القاموس، ووحدة البيع، وسعرك، والكمية المتاحة، وموقع الاستلام." action={add} />
      </div>
    );
  } else {
    body = (
      <>
        <div className="flex gap-2 items-center">
          <TextField className="flex-1" placeholder="ابحث في عروضك" icon="search" value={q} onChange={setQ} />
          <Button icon="plus" disabled={!approved} onClick={() => nav("/offers/new")}>عرض</Button>
        </div>
        {!rows.length ? <EmptyState compact icon="search" title="لا عرض بهذا الاسم" body="جرّب كلمة أخرى." /> : null}
        <div className="flex flex-col gap-2">
          {rows.map((o) => {
            const [label, tone] = badge(o);
            return (
              <button key={o.id} type="button" onClick={() => nav(`/offers/${o.id}`)}
                className="bg-surface border border-border rounded-md p-3 flex flex-col gap-1.5 text-ink text-start font-sans cursor-pointer w-full">
                <span className="flex justify-between items-center gap-2 w-full"><b>{o.product_name}</b><StatusBadge tone={tone}>{label}</StatusBadge></span>
                <span className="flex justify-between gap-2 text-14 text-ink-muted w-full">
                  <span>{unitLabel(o.unit, o.unit_size)} · متاح <Num>{fmt.qty(o.available_qty)}</Num></span>
                  <span>سعرك <Num className="text-ink font-bold">{fmt.money(o.purchase_price)}</Num> د.ل</span>
                </span>
                <span className="text-12 text-ink-muted">{meta(o)}</span>
              </button>
            );
          })}
        </div>
      </>
    );
  }

  return (
    <>
      <HomeHeader />
      <main className="md-mobile-main">
        {!approved ? <Note tone="warning">حسابك بانتظار اعتماد مَدَد. تضيف عروضك وتعدّلها بعد الاعتماد.</Note> : null}
        {body}
      </main>
    </>
  );
}
