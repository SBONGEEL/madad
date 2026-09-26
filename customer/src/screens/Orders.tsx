/** 07 الطلبات: قسم «طلباتي» — كل طلبية بحالتها وموعدها وعدد أصنافها ومبلغها، والضغط يفتح تتبّعها. */
import { Link, useNavigate } from "react-router-dom";

import { Button, EmptyState, ErrorState, LoadingState, Money, Num, OrderStatusBadge, useLoad } from "@ui/kit";
import { api } from "@/api/client";
import type { Order2SummaryOut } from "@/api/types";
import { itemsWord, whenLabel } from "@/lib/ord-shared";
import { OrdersTabs } from "@/lib/ord-tabs";
import { HomeHeader } from "@/lib/shell";

export function Orders() {
  const nav = useNavigate();
  const orders = useLoad(() => api.get<Order2SummaryOut[]>(`/api/customer/orders`));
  const rows = orders.data ?? [];
  // اسم الفرع يظهر حين تتوزع الطلبيات على أكثر من فرع (صاحب منشأة بفروع)
  const manyBranches = new Set(rows.map((o) => o.branch_id)).size > 1;

  let body;
  if (orders.loading && !orders.data) body = <LoadingState rows={5} />;
  else if (orders.error && !orders.data) {
    body = <ErrorState title="تعذّر تحميل طلباتك" body="تحقق من الاتصال ثم أعد المحاولة." code={orders.error.code} onRetry={orders.reload} />;
  } else if (!rows.length) {
    body = (
      <EmptyState icon="clipboard-list" title="لا طلبات بعد" body="طلباتك وحالتها تظهر هنا من لحظة التأكيد حتى التسليم."
        action={<Button size="sm" icon="search" onClick={() => nav("/search")}>تصفّح الكتالوج</Button>} />
    );
  } else {
    body = (
      <div className="flex flex-col gap-2">
        {rows.map((o) => (
          <Link key={o.id} to={`/orders/${o.id}`}
            className="bg-surface border border-border rounded-md p-3 flex flex-col gap-1.5 text-ink no-underline">
            <div className="flex justify-between items-center gap-2">
              <span className="font-bold"><Num>#{o.id}</Num></span>
              <OrderStatusBadge status={o.status} />
            </div>
            <div className="flex justify-between items-center gap-2 text-14 text-ink-muted">
              <span>
                {whenLabel(o.placed_at)} · {itemsWord(o.line_count)}
                {manyBranches ? <> · {o.branch_name}</> : null}
              </span>
              <Money value={o.total} size="sm" />
            </div>
          </Link>
        ))}
      </div>
    );
  }

  return (
    <>
      <HomeHeader />
      <main className="md-mobile-main">
        <OrdersTabs active="orders" />
        {body}
      </main>
    </>
  );
}
