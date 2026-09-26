/** 03 الصنف (م-15): السعر، والمتاح اليوم حين يمنع الإعداد تجاوزه، والإضافة إلى السلة، وبدائل من التصنيف نفسه. */
import { useEffect, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";

import { qs } from "@ui/client";
import * as fmt from "@ui/fmt";
import { Button, ErrorState, Icon, Money, Num, QtyStepper, StatusBadge, toast, useLoad } from "@ui/kit";
import { api } from "@/api/client";
import type { Catalog2Out, ItemDetailOut } from "@/api/types";
import { cartBranchId, ItemList, mediaUrl, unitLabel, useBranchVersion, useCartQty } from "@/lib/cat-cart";
import { Screen } from "@/lib/shell";
import { useSession } from "@/session";

const GONE = new Set(["item_not_found", "item_not_orderable", "http_404"]);

export function Product() {
  const { itemId } = useParams();
  const id = Number(itemId);
  const nav = useNavigate();
  const { isOwner } = useSession();
  const bv = useBranchVersion();
  const detail = useLoad(async () => {
    const br = await cartBranchId(isOwner);
    return api.get<ItemDetailOut>(`/api/customer/catalog/${id}${qs({ branch_id: br })}`);
  }, [id, bv, isOwner]);
  const catId = detail.data?.item.category_id ?? null;
  const alts = useLoad(async () => {
    if (catId == null) return [] as Catalog2Out[];
    const br = await cartBranchId(isOwner);
    return api.get<Catalog2Out[]>(`/api/customer/catalog${qs({ category_id: catId, branch_id: br })}`);
  }, [catId, bv, isOwner]);

  if (detail.loading && !detail.data) {
    return (
      <Screen title="" flush>
        <span className="md-skel h-chart" />
        <div className="px-4 flex flex-col gap-3">
          <span className="md-skel h-7 w-2/3" /><span className="md-skel h-4 w-2/5" /><span className="md-skel h-8 w-1/2" />
        </div>
      </Screen>
    );
  }
  if (detail.error || !detail.data) {
    const gone = GONE.has(detail.error?.code ?? "");
    return (
      <Screen title="الصنف">
        <div className="flex-1 flex flex-col justify-center">
          <ErrorState title={gone ? "الصنف لم يعد متاحاً" : detail.error?.message}
            body={gone ? "أُخفي من الكتالوج أثناء تصفّحك. ما في سلتك منه لا يُطلب حتى يعود." : undefined}
            code={detail.error?.code} onRetry={gone ? undefined : detail.reload} />
          {gone ? <Button variant="secondary" icon="search" onClick={() => nav("/search")}>ابحث عن بديل</Button> : null}
        </div>
      </Screen>
    );
  }

  const { item, category_name } = detail.data;
  const others = (alts.data ?? []).filter((a) => a.id !== item.id && a.orderable && !a.out_of_stock);
  const out = item.out_of_stock || !item.orderable;

  return (
    <Screen title={item.name_ar} flush>
      <div className={out ? "h-chart bg-primary-tint grid place-items-center text-ink-muted overflow-hidden opacity-60" : "h-chart bg-primary-tint grid place-items-center text-ink-muted overflow-hidden"}>
        {item.image_media_id ? <img src={mediaUrl(item.image_media_id) ?? ""} alt="" className="w-full h-full object-cover" />
          : <Icon name="package" size={48} strokeWidth={1.5} />}
      </div>
      <div className="px-4 flex flex-col gap-2.5">
        <h1 className="m-0 text-22 font-bold">{item.name_ar}</h1>
        <span className="text-15 text-ink-muted">{unitLabel(item.unit, item.unit_size)} · {category_name}</span>
        {out ? (
          <>
            <div><StatusBadge tone="warning">نافد الآن</StatusBadge></div>
            <span className="text-15">لا يُضاف إلى السلة حتى يتوفر.</span>
            {others.length ? <span className="text-13 text-ink-muted text-center">بدائل من «{category_name}» أدناه</span> : null}
          </>
        ) : (
          <AddToCart item={item} />
        )}
      </div>
      {others.length ? (
        <div className="px-4 flex flex-col gap-2">
          <span className="font-bold text-17">{out ? `بدائل من «${category_name}»` : `من «${category_name}» أيضاً`}</span>
          <ItemList layout="row" items={others.slice(0, 6)} />
        </div>
      ) : null}
    </Screen>
  );
}

function AddToCart({ item }: { item: Catalog2Out }) {
  const nav = useNavigate();
  const { qtyOf, setQty } = useCartQty();
  const inCart = qtyOf(item);
  const max = item.available_qty != null ? Number(item.available_qty) : undefined;
  const [qty, setLocal] = useState(() => Math.max(1, inCart));
  const [busy, setBusy] = useState(false);
  useEffect(() => { if (inCart > 0) setLocal(inCart); }, [inCart]);
  const capped = max != null && qty >= max;
  const total = Number(item.sale_price ?? 0) * qty;
  const unit = unitLabel(item.unit, "1");

  async function add() {
    setBusy(true);
    const ok = await setQty(item.id, qty, inCart);
    setBusy(false);
    if (ok) toast(inCart ? "حُدّثت الكمية في السلة" : "أُضيف إلى السلة");
  }

  return (
    <>
      <Money value={item.sale_price} size="lg" />
      <div className="flex justify-between items-center gap-2">
        <QtyStepper value={qty} unit={unit} max={max} onChange={(v) => setLocal(Math.max(1, max != null ? Math.min(v, max) : v))} />
        {max != null ? <span className="text-14 text-ink-muted">المتاح اليوم <Num>{fmt.qty(max)}</Num></span> : null}
      </div>
      {max != null && max <= 0 ? <div className="bg-secondary-tint rounded-md p-2.5 text-14">لا متاح اليوم من هذا الصنف.</div>
        : capped ? <div className="bg-secondary-tint rounded-md p-2.5 text-14">وصلت الحد المتاح. للكميات الأكبر تواصل معنا من «حسابي».</div> : null}
      <Button block icon="shopping-cart" loading={busy} disabled={max != null && max <= 0} onClick={() => void add()}>
        {inCart ? <>اجعلها <Num>{fmt.qty(qty)}</Num> في السلة</> : <>أضف <Num>{fmt.qty(qty)}</Num> إلى السلة</>} ·<Num>{fmt.money(total)}</Num> د.ل
      </Button>
      {inCart ? <button type="button" className="md-link text-14 text-center" onClick={() => nav("/cart")}>في سلتك <Num>{fmt.qty(inCart)}</Num> — افتح السلة</button> : null}
    </>
  );
}
