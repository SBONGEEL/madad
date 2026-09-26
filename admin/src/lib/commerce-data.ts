/** بيانات مشتركة لشاشات التجارة: شجرة التصنيفات مسطّحة لقوائم الاختيار. */
import type { CategoryNodeOut } from "@/api/types";

/** كل تصنيف رئيسي ثم فروعه: «مواد غذائية › لحوم». */
export function flatCategories(tree: CategoryNodeOut[] | null | undefined): Array<{ value: string; label: string }> {
  return (tree ?? []).flatMap((c) => [
    { value: String(c.id), label: c.name_ar },
    ...(c.children ?? []).map((k) => ({ value: String(k.id), label: `${c.name_ar} › ${k.name_ar}` })),
  ]);
}
