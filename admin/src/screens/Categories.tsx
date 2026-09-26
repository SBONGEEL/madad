/** التصنيفات وقاموس الأصناف: العشر الرئيسية ثابتة بأيقونات الهوية، والفروع تضيفها الإدارة وتعدّلها؛
 *  واقتراحات الموردين لا تظهر في القاموس قبل الاعتماد (§2.1، م-4). */
import { useRef, useState } from "react";

import { Button, CATEGORY_ICON, ConfirmDialog, cx, Dialog, EmptyState, Icon, Loader, Num, PageHead, Section, Select, StatusBadge,
  Switch, TextField, useAction, useLoad } from "@ui/kit";
import { api } from "@/api/client";
import type { CategoryNodeOut, ProposalOut } from "@/api/types";
import { useSession } from "@/session";

export function Categories() {
  const { refreshCounts } = useSession();
  const tree = useLoad(() => api.get<CategoryNodeOut[]>(`/api/admin/categories`));
  const props = useLoad(() => api.get<ProposalOut[]>(`/api/admin/proposals`));
  const act = useAction();
  const formRef = useRef<HTMLDivElement>(null);
  const [parent, setParent] = useState("");
  const [nameAr, setNameAr] = useState("");
  const [nameEn, setNameEn] = useState("");
  const [editing, setEditing] = useState<CategoryNodeOut | null>(null);
  const [rejecting, setRejecting] = useState<ProposalOut | null>(null);

  async function addBranch() {
    const r = await act.run(() => api.post<CategoryNodeOut>(`/api/admin/categories`, { parent_id: Number(parent), name_ar: nameAr.trim(), name_en: nameEn.trim() }),
      "أُضيف الفرع");
    if (r) {
      setNameAr(""); setNameEn("");
      tree.reload();
    }
  }

  async function decide(pr: ProposalOut, decision: "approve" | "reject") {
    const list = await act.run(() => api.post<ProposalOut[]>(`/api/admin/proposals/${pr.id}`, { decision }),
      decision === "approve" ? "اعتُمد الصنف في القاموس" : "رُفض الاقتراح");
    if (list) {
      props.set(list);
      setRejecting(null);
      tree.reload();
      refreshCounts();
    }
  }

  const mains = tree.data ?? [];
  const pending = props.data?.length ?? 0;
  const validBranch = parent && nameAr.trim() && nameEn.trim();

  return (
    <div className="md-page">
      <PageHead title="التصنيفات وقاموس الأصناف" sub="العشر الرئيسية بأيقونات الهوية ثابتة، والفروع والأصناف تضيفها الإدارة مباشرة."
        actions={<Button variant="secondary" icon="plus" onClick={() => formRef.current?.scrollIntoView({ behavior: "smooth" })}>فرع جديد</Button>} />

      <div className="grid grid-cols-3 gap-5 items-start">
        <section className="col-span-2 bg-surface border border-border rounded-lg p-3">
          <Loader state={tree} rows={6}>
            {(cats) => cats.length ? (
              <div className="grid grid-cols-2 gap-x-4 gap-y-1 content-start">
                {cats.map((c) => {
                  const total = c.items + (c.children ?? []).reduce((s, k) => s + k.items, 0);
                  return (
                    <div key={c.id} className="flex flex-col gap-0.5 py-1.5">
                      <div className={cx("flex items-center gap-2.5 py-2 px-2.5 rounded-sm bg-page font-bold text-14", !c.active && "text-ink-muted")}>
                        <Icon name={CATEGORY_ICON[c.icon_key ?? ""] ?? "cat-more"} size={22} strokeWidth={1.6} />
                        <span className="flex-1">{c.name_ar}</span>
                        {!c.active ? <StatusBadge tone="neutral">موقوف</StatusBadge> : null}
                        <Num className="font-medium text-ink-muted">{total}</Num>
                      </div>
                      {(c.children ?? []).map((k) => (
                        <div key={k.id} className={cx("flex items-center gap-2 py-1 pe-2.5 ps-10 text-14", !k.active && "text-ink-muted")}>
                          <span className="flex-1">{k.name_ar}</span>
                          {!k.active ? <StatusBadge tone="neutral">موقوف</StatusBadge> : null}
                          <Num className="text-ink-muted">{k.items}</Num>
                          <button type="button" className="md-btn md-btn-ghost md-btn-sm" aria-label={`تعديل ${k.name_ar}`} onClick={() => setEditing(k)}>
                            <Icon name="pencil" size={14} />
                          </button>
                        </div>
                      ))}
                    </div>
                  );
                })}
              </div>
            ) : <EmptyState compact icon="folder-tree" title="لا تصنيفات" />}
          </Loader>
        </section>

        <div className="flex flex-col gap-3">
          <Section title="اقتراحات الموردين" right={pending ? <StatusBadge tone="warning">{pending} بانتظارك</StatusBadge> : null}>
            <span className="text-13 text-ink-muted">لا يظهر صنف مقترح في القاموس ولا يُعرض قبل اعتمادك (§2.1).</span>
            <Loader state={props}>
              {(list) => list.length ? list.map((pr) => (
                <div key={pr.id} className="border border-border rounded-md p-3 flex flex-col gap-2">
                  <div className="flex justify-between gap-2"><b>{pr.name_ar}</b><span className="text-13 text-ink-muted">{pr.supplier_name}</span></div>
                  <span className="text-13 text-ink-muted">
                    {pr.similar.length ? `يشبه «${pr.similar.slice(0, 2).join("»، «")}» في القاموس — ربما دمج. ` : ""}مقترح تحت: {pr.category}.
                  </span>
                  <div className="grid grid-cols-2 gap-1.5">
                    <Button size="sm" icon="check" disabled={act.busy} onClick={() => decide(pr, "approve")}>اعتماد</Button>
                    <Button size="sm" variant="ghost" disabled={act.busy} onClick={() => setRejecting(pr)}>رفض</Button>
                  </div>
                </div>
              )) : <EmptyState compact icon="inbox" title="لا اقتراحات تنتظرك" body="ما يقترحه المورد من أصناف جديدة يظهر هنا لتعتمده أو تدمجه." />}
            </Loader>
          </Section>

          <div ref={formRef}>
            <Section title="فرع جديد">
              <Select label="تحت" value={parent} onChange={setParent}
                options={[{ value: "", label: "اختر التصنيف الرئيسي" }, ...mains.map((c) => ({ value: String(c.id), label: c.name_ar }))]} />
              <TextField label="اسم الفرع" value={nameAr} onChange={setNameAr} required />
              <TextField label="الاسم بالإنجليزية" value={nameEn} onChange={setNameEn} ltr required />
              <Button icon="check" loading={act.busy} disabled={!validBranch} onClick={addBranch}>إضافة</Button>
            </Section>
          </div>
        </div>
      </div>

      <EditDialog cat={editing} onClose={() => setEditing(null)} onSaved={() => { setEditing(null); tree.reload(); }} />

      <ConfirmDialog open={!!rejecting} tone="error" title={`رفض «${rejecting?.name_ar ?? ""}»؟`}
        body="لا يظهر الصنف في القاموس ولا يُعرض، ولا يبيعه المورد." confirmLabel="رفض" loading={act.busy}
        onCancel={() => setRejecting(null)} onConfirm={() => rejecting && decide(rejecting, "reject")} />
    </div>
  );
}

function EditDialog({ cat, onClose, onSaved }: { cat: CategoryNodeOut | null; onClose: () => void; onSaved: () => void }) {
  const act = useAction();
  const [ar, setAr] = useState("");
  const [en, setEn] = useState("");
  const [active, setActive] = useState(true);
  const [for_, setFor] = useState<number | null>(null);
  if (cat && for_ !== cat.id) {
    setFor(cat.id);
    setAr(cat.name_ar);
    setEn(cat.name_en);
    setActive(cat.active);
  }

  async function save() {
    if (!cat) return;
    const r = await act.run(() => api.patch<CategoryNodeOut>(`/api/admin/categories/${cat.id}`, { name_ar: ar.trim(), name_en: en.trim(), active }),
      "حُفظ الفرع");
    if (r) {
      setFor(null);
      onSaved();
    }
  }

  return (
    <Dialog open={!!cat} onClose={() => { setFor(null); onClose(); }} label="تعديل الفرع">
      <div className="md-dialog-title">تعديل الفرع</div>
      <div className="flex flex-col gap-3">
        <TextField label="اسم الفرع" value={ar} onChange={setAr} required />
        <TextField label="الاسم بالإنجليزية" value={en} onChange={setEn} ltr required />
        <label className="flex items-center justify-between gap-3 text-14">
          <span>الفرع نشط</span>
          <Switch checked={active} onChange={setActive} label="الفرع نشط" />
        </label>
      </div>
      <div className="md-dialog-actions">
        <Button block icon="check" loading={act.busy} disabled={!ar.trim() || !en.trim()} onClick={save}>حفظ</Button>
        <Button variant="ghost" block onClick={() => { setFor(null); onClose(); }}>إلغاء</Button>
      </div>
    </Dialog>
  );
}
