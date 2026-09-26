/** 04 البحث: نتائج الكتالوج بالاسم، بتأخير قصير بين الكتابة والطلب. */
import { useEffect, useState } from "react";
import { useSearchParams } from "react-router-dom";

import { ApiError, qs } from "@ui/client";
import { EmptyState, ErrorState, LoadingState, Num, TextField, useLoad } from "@ui/kit";
import { api } from "@/api/client";
import type { Catalog2Out, CategoryOut } from "@/api/types";
import { cartBranchId, ItemList, useBranchVersion } from "@/lib/cat-cart";
import { Screen } from "@/lib/shell";
import { useSession } from "@/session";

const DEBOUNCE_MS = 300;
const TIMEOUT_MS = 12000;

function withTimeout<T>(p: Promise<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new ApiError(0, "search_timeout")), TIMEOUT_MS);
    p.then((v) => { clearTimeout(t); resolve(v); }, (e: unknown) => { clearTimeout(t); reject(e); });
  });
}

export function Search() {
  const [params, setParams] = useSearchParams();
  const [text, setText] = useState(params.get("q") ?? "");
  const [q, setQ] = useState(text.trim());
  const { isOwner } = useSession();
  const bv = useBranchVersion();

  useEffect(() => {
    const t = setTimeout(() => {
      const v = text.trim();
      setQ(v);
      setParams(v ? { q: v } : {}, { replace: true });
    }, DEBOUNCE_MS);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [text]);

  const cats = useLoad(() => api.get<CategoryOut[]>(`/api/customer/categories`));
  const res = useLoad(async () => {
    if (!q) return null;
    const br = await cartBranchId(isOwner);
    return withTimeout(api.get<Catalog2Out[]>(`/api/customer/catalog${qs({ q, branch_id: br })}`));
  }, [q, bv, isOwner]);

  const names = new Map<number, string>();
  for (const c of cats.data ?? []) {
    names.set(c.id, c.name_ar);
    for (const k of c.children ?? []) names.set(k.id, k.name_ar);
  }

  let body;
  if (!q) {
    body = <EmptyState icon="search" title="ابحث عن منتج أو فئة" body="اكتب اسم الصنف، مثل «أكواب» أو «جبنة»." />;
  } else if (res.loading) {
    body = <LoadingState rows={5} />;
  } else if (res.error) {
    body = (
      <div className="flex-1 flex flex-col justify-center">
        <ErrorState title="البحث لا يستجيب" body="أعد المحاولة بعد لحظة." code={res.error.code} onRetry={res.reload} />
      </div>
    );
  } else if (!res.data?.length) {
    body = (
      <div className="flex-1 flex flex-col justify-center">
        <EmptyState icon="search" title={`لا نتائج لـ«${q}»`} body="جرّب كلمة أقصر، أو تصفّح التصنيفات من الرئيسية." />
      </div>
    );
  } else {
    const rows = res.data;
    const catIds = new Set(rows.map((r) => r.category_id));
    const only = catIds.size === 1 ? names.get(rows[0]?.category_id ?? 0) : undefined;
    body = (
      <>
        <span className="text-13 text-ink-muted"><Num>{rows.length}</Num> {rows.length === 1 ? "نتيجة" : "نتائج"}{only ? ` في «${only}»` : ""}</span>
        <ItemList layout="row" items={rows} />
      </>
    );
  }

  return (
    <Screen title="البحث">
      <TextField value={text} onChange={setText} icon="search" placeholder="ابحث عن منتج أو فئة" autoFocus />
      {body}
    </Screen>
  );
}
