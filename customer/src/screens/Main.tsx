/** 01 الرئيسية: البحث، وتذكير القائمة المتكررة، والتصنيفات، و«طلبتها سابقاً». */
import { useState } from "react";
import { useNavigate } from "react-router-dom";

import { ApiError, qs } from "@ui/client";
import { Button, CategoryTile, EmptyState, ErrorState, Icon, LoadingState, Note, TextField, toast, useLoad } from "@ui/kit";
import { api } from "@/api/client";
import type { Catalog2Out, CategoryOut, ListDetailOut, ReorderOut } from "@/api/types";
import { cartBranchId, chooseBranch, ItemList, useBranchVersion } from "@/lib/cat-cart";
import { HomeHeader } from "@/lib/shell";
import { useSession } from "@/session";

const PREV_SHOWN = 5;
const TALL = { height: "var(--h-cbar)" };

export function Main() {
  const nav = useNavigate();
  const { me, approved, isOwner, setCart } = useSession();
  const bv = useBranchVersion();
  const cats = useLoad(() => api.get<CategoryOut[]>(`/api/customer/categories`));
  const prev = useLoad(async () => {
    const br = await cartBranchId(isOwner);
    return api.get<Catalog2Out[]>(`/api/customer/catalog${qs({ previously_ordered: true, branch_id: br })}`);
  }, [bv, isOwner]);
  const lists = useLoad(
    () => (approved ? api.get<ListDetailOut[]>(`/api/customer/lists`) : Promise.resolve([] as ListDetailOut[])),
    [approved],
  );
  const [allCats, setAllCats] = useState(false);
  const [allPrev, setAllPrev] = useState(false);
  const [busy, setBusy] = useState(false);

  const due = (lists.data ?? []).find((l) => l.list.due_today);

  async function reorder(listId: number) {
    setBusy(true);
    try {
      const r = await api.post<ReorderOut>(`/api/customer/lists/${listId}/to-cart`, { skip_unavailable: false });
      if (r.cart.branch && isOwner) chooseBranch(r.cart.branch.id);
      setCart(r.cart);
      nav("/cart");
    } catch (e) {
      // صنف غير متاح في القائمة: شاشة القوائم تعرضه وتعرض «اطلب بدون الصنف الناقص»
      if (e instanceof ApiError && e.code === "list_has_unavailable") nav("/lists");
      else toast((e as Error).message, true);
    } finally {
      setBusy(false);
    }
  }

  const search = (
    <TextField value="" icon="search" placeholder="ابحث عن منتج أو فئة"
      onChange={(v) => nav(`/search${qs({ q: v })}`)} />
  );

  if (cats.loading && !cats.data) {
    return (
      <>
        <HomeHeader />
        <main className="md-mobile-main">
          <span className="md-skel h-12 rounded-md" />
          <span className="md-skel rounded-lg" style={TALL} />
          <div className="grid grid-cols-3 gap-2">{Array.from({ length: 6 }, (_, i) => <span key={i} className="md-skel" style={TALL} />)}</div>
          <LoadingState rows={2} />
        </main>
      </>
    );
  }

  if (cats.error && !cats.data) {
    const offline = cats.error.code === "network";
    return (
      <>
        <HomeHeader />
        <main className="md-mobile-main justify-center">
          <ErrorState title={offline ? "لا اتصال بالإنترنت" : cats.error.message}
            body={offline ? "الكتالوج يحتاج اتصالاً ليعرض الأسعار الحالية. السلة محفوظة كما تركتها." : undefined}
            code={cats.error.code} onRetry={() => { cats.reload(); prev.reload(); lists.reload(); }} />
        </main>
      </>
    );
  }

  const top = cats.data ?? [];
  const shownCats = allCats || top.length <= 6 ? top : top.slice(0, 5);
  const prevItems = prev.data ?? [];
  const hasPrev = prevItems.length > 0;

  return (
    <>
      <HomeHeader />
      <main className="md-mobile-main">
        {search}

        {!approved ? (
          <Note tone="info">
            <b>نراجع بيانات «{me.customer?.name}» الآن.</b> تستطيع تصفّح الكتالوج بالأسعار الآن، والطلب يُفتح بعد الاعتماد.
          </Note>
        ) : null}

        {hasPrev ? (
          <div className="bg-primary text-on-primary rounded-lg p-4 flex flex-col gap-1.5 justify-center">
            <span className="text-19 font-bold leading-30">كل ما تحتاجه لمشروعك<br />في مكان واحد</span>
            <span className="text-13 text-on-primary-muted">توصيل لباب مطعمك في {me.context?.city_name}</span>
          </div>
        ) : null}

        {due ? (
          <div className="flex items-center gap-2.5 p-3 rounded-md bg-secondary-tint text-ink">
            <Icon name="repeat" />
            <span className="flex-1 text-14"><b>حان وقت {due.list.name}</b> · {due.list.item_count} صنفاً</span>
            <Button size="sm" variant="ghost" loading={busy} onClick={() => void reorder(due.list.id)}>أعد الطلب</Button>
          </div>
        ) : null}

        {top.length ? (
          <div className="grid grid-cols-3 gap-2">
            {shownCats.map((c) => (
              <CategoryTile key={c.id} category={c.icon_key ?? "more"} label={c.name_ar} onClick={() => nav(`/category/${c.id}`)} />
            ))}
            {shownCats.length < top.length ? <CategoryTile category="more" label="أخرى" onClick={() => setAllCats(true)} /> : null}
          </div>
        ) : null}

        {prev.loading && !prev.data ? <LoadingState rows={2} />
          : prev.error && !prev.data ? <ErrorState compact title={prev.error.message} code={prev.error.code} onRetry={prev.reload} />
          : hasPrev ? (
            <>
              <div className="flex justify-between items-center">
                <span className="font-bold text-17">طلبتها سابقاً</span>
                {prevItems.length > PREV_SHOWN ? (
                  <button type="button" className="md-link text-14" onClick={() => setAllPrev(!allPrev)}>{allPrev ? "أقل" : "الكل"}</button>
                ) : null}
              </div>
              <ItemList layout="row" items={allPrev ? prevItems : prevItems.slice(0, PREV_SHOWN)} />
            </>
          ) : (
            <EmptyState compact icon="repeat" title="أول طلب لك يظهر هنا"
              body="ما تطلبه يتصدّر الرئيسية لتعيد طلبه بسرعة، ويمكنك حفظه قائمة متكررة."
              action={<Button size="sm" icon="search" onClick={() => nav("/search")}>تصفّح الكتالوج</Button>} />
          )}
      </main>
    </>
  );
}
