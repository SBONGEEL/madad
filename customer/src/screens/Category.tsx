/** 02 التصنيف (م-4): تصنيف رئيسي بفروعه شرائح، وأصنافه ببطاقات مربوطة بالسلة. */
import { useEffect, useState } from "react";
import { useParams } from "react-router-dom";

import { qs } from "@ui/client";
import { CATEGORY_ICON, cx, EmptyState, ErrorState, useLoad } from "@ui/kit";
import { api } from "@/api/client";
import type { Catalog2Out, CategoryOut } from "@/api/types";
import { cartBranchId, ItemList, useBranchVersion } from "@/lib/cat-cart";
import { Screen } from "@/lib/shell";
import { useSession } from "@/session";

/** التصنيف المطلوب وأبوه الرئيسي (إن فُتح فرعٌ مباشرة). */
function locate(tree: CategoryOut[], id: number): { top: CategoryOut; sub: CategoryOut | null } | null {
  for (const t of tree) {
    if (t.id === id) return { top: t, sub: null };
    const k = (t.children ?? []).find((c) => c.id === id);
    if (k) return { top: t, sub: k };
  }
  return null;
}

export function Category() {
  const { categoryId } = useParams();
  const id = Number(categoryId);
  const { isOwner } = useSession();
  const bv = useBranchVersion();
  const cats = useLoad(() => api.get<CategoryOut[]>(`/api/customer/categories`));
  const found = cats.data ? locate(cats.data, id) : null;
  const [picked, setPicked] = useState<number | null>(null);
  useEffect(() => setPicked(null), [id]);
  const current = picked ?? found?.sub?.id ?? id;
  const items = useLoad(async () => {
    const br = await cartBranchId(isOwner);
    return api.get<Catalog2Out[]>(`/api/customer/catalog${qs({ category_id: current, branch_id: br })}`);
  }, [current, bv, isOwner]);

  const top = found?.top;
  const subs = top?.children ?? [];
  const title = top?.name_ar ?? "التصنيف";

  let body;
  if ((items.loading && !items.data) || (cats.loading && !cats.data)) {
    body = (
      <div className="grid grid-cols-2 gap-2.5">
        {Array.from({ length: 4 }, (_, i) => <span key={i} className="md-skel h-chart rounded-lg" />)}
      </div>
    );
  } else if (items.error && !items.data) {
    body = (
      <div className="flex-1 flex flex-col justify-center">
        <ErrorState title="تعذّر تحميل الأصناف" body="انقطع الاتصال أثناء التحميل. أعد المحاولة."
          code={items.error.code} onRetry={items.reload} />
      </div>
    );
  } else if (!items.data?.length) {
    body = (
      <div className="flex-1 flex flex-col justify-center">
        <EmptyState icon={CATEGORY_ICON[top?.icon_key ?? ""] ?? "package"} title="لا أصناف متوفرة هنا الآن"
          body="نضيف أصنافاً جديدة كل أسبوع." />
      </div>
    );
  } else {
    body = <ItemList items={items.data} />;
  }

  return (
    <Screen title={title}>
      {subs.length ? (
        <div className="md-hscroll" role="tablist" aria-label="التصنيفات الفرعية">
          {top ? (
            <button type="button" role="tab" aria-selected={current === top.id}
              className={cx("md-chip", current === top.id && "md-chip-on")} onClick={() => setPicked(top.id)}>الكل</button>
          ) : null}
          {subs.map((s) => (
            <button key={s.id} type="button" role="tab" aria-selected={current === s.id}
              className={cx("md-chip", current === s.id && "md-chip-on")} onClick={() => setPicked(s.id)}>{s.name_ar}</button>
          ))}
        </div>
      ) : null}
      {body}
    </Screen>
  );
}
