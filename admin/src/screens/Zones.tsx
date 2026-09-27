/** مناطق التوصيل (م-16، م-25): الأحياء تُختار لكل فرع، والمناطق تُرسم على الخريطة. تسري الرسوم على الطلبيات الجديدة. */
import { useState } from "react";

import * as fmt from "@ui/fmt";
import { Button, DataTable, Dialog, Icon, Money, Note, Num, PageHead, Section, StatusBadge, Switch, TextField, useAction, useLoad } from "@ui/kit";
import { api } from "@/api/client";
import type { AreaOut, AreaOverlapOut, OverlapHitOut, ZoneOut } from "@/api/types";
import { AreaMap, AreaPreview, MAPBOX_TOKEN, PointsEditor } from "@/lib/admin-map";

export function Zones() {
  return (
    <div className="md-page">
      <PageHead title="مناطق التوصيل"
        sub="الطريقتان معاً: حيّ يُختار لكل فرع من القائمة، ومناطق تُرسم على الخريطة. تسري الرسوم على الطلبيات الجديدة."
        actions={<StatusBadge tone="neutral">M-16</StatusBadge>} />
      <OverlapAlert />
      <div className="grid grid-cols-3 gap-4 items-start">
        <ZonesCard />
        <AreasCard />
      </div>
    </div>
  );
}

/** الأحياء: جدول، وسطر إضافة؛ النقر على حيّ يفتحه للتعديل. */
function ZonesCard() {
  const z = useLoad(() => api.get<ZoneOut[]>(`/api/admin/zones`));
  const act = useAction();
  const [edit, setEdit] = useState<ZoneOut | null>(null);
  const [name, setName] = useState("");
  const [fee, setFee] = useState("");
  const [active, setActive] = useState(true);

  const feeBad = fee.trim() !== "" && !fmt.isMoney(fee);
  const canSave = name.trim() !== "" && fee.trim() !== "" && !feeBad;

  function open(row: ZoneOut) {
    setEdit(row);
    setName(row.name_ar);
    setFee(row.fee);
    setActive(row.active);
  }
  function reset() {
    setEdit(null);
    setName("");
    setFee("");
    setActive(true);
  }

  async function submit() {
    if (!canSave) return;
    const body = { name_ar: name.trim(), fee: fee.trim(), active };
    const v = edit
      ? await act.run(() => api.put<ZoneOut[]>(`/api/admin/zones/${edit.id}`, body), "حُفظ الحي")
      : await act.run(() => api.post<ZoneOut[]>(`/api/admin/zones`, body), "أُضيف الحي");
    if (v) {
      z.set(v);
      reset();
    }
  }

  return (
    <Section title="الأحياء" right={edit ? <Button variant="ghost" size="sm" icon="x" onClick={reset}>إلغاء التعديل</Button> : undefined}>
      <DataTable rows={z.data} loading={z.loading} error={z.error} onRetry={z.reload} rowKey={(r) => r.id}
        emptyIcon="map-pin" emptyTitle="لا مناطق بعد" emptyBody="أضف حيّاً أو ارسم منطقة ليُحسب رسم التوصيل حسب المكان."
        onRowClick={open} rowTone={(r) => edit?.id === r.id && "warning"}
        columns={[
          { key: "n", label: "الحي", render: (r) => <>{r.name_ar}{r.active ? null : <> <StatusBadge tone="neutral">موقوف</StatusBadge></>}</> },
          { key: "f", label: "الرسم", money: true, render: (r) => <Money value={r.fee} /> },
          { key: "c", label: "فروع", numeric: true, render: (r) => <Num>{fmt.int(r.branches)}</Num> },
        ]} />
      <div className="grid grid-cols-2 gap-2 items-start">
        <TextField label={edit ? "اسم الحي" : "حي جديد"} value={name} onChange={setName} disabled={act.busy} />
        <TextField label="الرسم" value={fee} onChange={setFee} numeric suffix="د.ل" disabled={act.busy} error={feeBad ? "مبلغ غير صالح" : null} />
      </div>
      {edit ? (
        <label className="flex gap-2.5 items-center text-14"><Switch checked={active} onChange={setActive} label="الحي مفعّل" /> الحي مفعّل</label>
      ) : null}
      <Button icon={edit ? "check" : "plus"} variant="secondary" loading={act.busy} disabled={!canSave} onClick={submit}>
        {edit ? "حفظ الحي" : "إضافة الحي"}
      </Button>
    </Section>
  );
}

/** المناطق المرسومة: خريطة Mapbox حين يوجد المفتاح، وإلا معاينة ومحرّر نقاط. */
function AreasCard() {
  const a = useLoad(() => api.get<AreaOut[]>(`/api/admin/areas`));
  const act = useAction();
  const [editId, setEditId] = useState<number | null>(null);   // null مع mode=new = منطقة جديدة
  const [mode, setMode] = useState<"idle" | "new" | "edit">("idle");
  const [drawing, setDrawing] = useState(false);
  const [points, setPoints] = useState<number[][]>([]);
  const [name, setName] = useState("");
  const [fee, setFee] = useState("");
  const [active, setActive] = useState(true);

  const areas = a.data ?? [];
  const feeBad = fee.trim() !== "" && !fmt.isMoney(fee);
  const canSave = mode !== "idle" && name.trim() !== "" && fee.trim() !== "" && !feeBad && points.length >= 3
    && points.every((p) => p.length === 2 && p.every((n) => Number.isFinite(n)));

  function startNew() {
    setMode("new");
    setEditId(null);
    setPoints([]);
    setName("");
    setFee("");
    setActive(true);
    setDrawing(true);
  }
  function select(id: number) {
    const ar = areas.find((x) => x.id === id);
    if (!ar) return;
    setMode("edit");
    setEditId(id);
    setPoints(ar.polygon.map((p) => [...p]));
    setName(ar.name_ar);
    setFee(ar.fee);
    setActive(ar.active);
    setDrawing(false);
  }
  function cancel() {
    setMode("idle");
    setEditId(null);
    setPoints([]);
    setDrawing(false);
  }

  const [overlap, setOverlap] = useState<OverlapHitOut[] | null>(null);

  /** م-27: قبل الحفظ يُفحص التداخل مع منطقة برسم مختلف؛ يُعرض قبل الحفظ ويُحفظ رغم ذلك إن شاء المالك. */
  async function check() {
    if (!canSave) return;
    if (active) {
      const hits = await act.run(() => api.post<OverlapHitOut[]>(`/api/admin/areas/overlap-check`,
        { polygon: points, fee: fee.trim(), area_id: mode === "edit" ? editId : null }));
      if (hits === undefined) return;
      if (hits.length) { setOverlap(hits); return; }
    }
    await submit();
  }

  async function submit() {
    setOverlap(null);
    if (!canSave) return;
    const body = { name_ar: name.trim(), fee: fee.trim(), polygon: points, active };
    const v = mode === "edit" && editId != null
      ? await act.run(() => api.put<AreaOut[]>(`/api/admin/areas/${editId}`, body), "حُفظت المنطقة")
      : await act.run(() => api.post<AreaOut[]>(`/api/admin/areas`, body), "أُضيفت المنطقة");
    if (v) {
      a.set(v);
      cancel();
    }
  }

  const shapes = areas.map((x) => ({ id: x.id, name: x.name_ar, fee: x.fee, active: x.active, polygon: x.polygon }));
  const hideId = mode === "edit" ? editId : null;

  return (
    <Section title="المناطق المرسومة" className="col-span-2"
      right={mode !== "idle" ? <Button variant="ghost" size="sm" icon="x" onClick={cancel}>إلغاء</Button> : undefined}>
      {a.loading && !a.data ? <div className="md-map" aria-busy /> : a.error && !a.data ? (
        <Note tone="error">{a.error.message} <button type="button" className="md-link" onClick={a.reload}>إعادة المحاولة</button></Note>
      ) : MAPBOX_TOKEN ? (
        <AreaMap areas={shapes} editingId={hideId} draft={mode === "idle" ? [] : points} drawing={drawing}
          onAddPoint={(p) => setPoints((ps) => [...ps, p])} onSelect={select} />
      ) : (
        <>
          <Note tone="warning">الخريطة تحتاج مفتاح Mapbox (VITE_MAPBOX_TOKEN) في إعداد اللوحة. إلى أن يُضبط: اكتب رؤوس المنطقة بخط العرض وخط الطول، بالترتيب حول الشكل.</Note>
          <AreaPreview areas={shapes} editingId={hideId} draft={mode === "idle" ? [] : points} onSelect={select} />
        </>
      )}

      <div className="flex gap-2 items-center flex-wrap">
        <Button icon="pencil" disabled={act.busy} onClick={startNew}>ارسم منطقة</Button>
        <Button variant="secondary" disabled={mode === "idle" || act.busy || !MAPBOX_TOKEN} onClick={() => {
            if (!drawing && mode === "edit") setPoints([]);   // يُعاد رسم حدود المنطقة المختارة من أول نقطة
            setDrawing(!drawing);
          }}>
          {drawing ? "إنهاء الرسم" : "تعديل النقاط"}
        </Button>
        {MAPBOX_TOKEN && mode !== "idle" ? (
          <Button variant="ghost" size="sm" icon="trash-2" disabled={!points.length} onClick={() => setPoints((ps) => ps.slice(0, -1))}>تراجع عن آخر نقطة</Button>
        ) : null}
        <span className="text-13 text-ink-muted">
          {MAPBOX_TOKEN ? "اضغط على الخريطة لوضع النقاط، ثم أغلق الشكل." : "اختر منطقة من المعاينة أو القائمة لتعديلها، أو ارسم منطقة جديدة."}
          {mode !== "idle" ? <> · <Num>{points.length}</Num> نقاط</> : null}
        </span>
      </div>

      {mode !== "idle" && !MAPBOX_TOKEN ? <PointsEditor points={points} onChange={setPoints} disabled={act.busy} /> : null}

      {mode !== "idle" ? (
        <div className="grid grid-cols-3 gap-2 items-start">
          <TextField label="اسم المنطقة" value={name} onChange={setName} disabled={act.busy} />
          <TextField label="الرسم" value={fee} onChange={setFee} numeric suffix="د.ل" disabled={act.busy} error={feeBad ? "مبلغ غير صالح" : null} />
          <div className="self-end flex flex-col gap-2">
            {mode === "edit" ? <label className="flex gap-2.5 items-center text-14"><Switch checked={active} onChange={setActive} label="المنطقة مفعّلة" /> مفعّلة</label> : null}
            <Button icon="check" block loading={act.busy} disabled={!canSave} onClick={check}>حفظ المنطقة</Button>
          </div>
        </div>
      ) : null}

      <DataTable rows={a.data} loading={a.loading} error={a.error} onRetry={a.reload} rowKey={(r) => r.id}
        emptyIcon="map-pin" emptyTitle="لا مناطق بعد" emptyBody="أضف حيّاً أو ارسم منطقة ليُحسب رسم التوصيل حسب المكان."
        onRowClick={(r) => select(r.id)} rowTone={(r) => editId === r.id && mode === "edit" && "warning"}
        columns={[
          { key: "n", label: "المنطقة", render: (r) => r.name_ar },
          { key: "f", label: "الرسم", money: true, render: (r) => <Money value={r.fee} /> },
          { key: "p", label: "النقاط", numeric: true, render: (r) => <Num>{r.polygon.length}</Num> },
          { key: "s", label: "الحالة", render: (r) => r.active ? <StatusBadge tone="success">مفعّلة</StatusBadge> : <StatusBadge tone="neutral">موقوفة</StatusBadge> },
        ]} />
          <Dialog open={!!overlap} onClose={() => setOverlap(null)} label="تداخل منطقتين">
        <span className="md-dialog-ico md-tone-bg-warning"><Icon name="triangle-alert" size={22} /></span>
        <div className="md-dialog-title">المنطقة {mode === "edit" ? "" : "الجديدة "}تتداخل مع «{overlap?.map((h) => h.name_ar).join("» و«")}»</div>
        <div className="md-dialog-body">
          «{name.trim()}» (<Money value={fee.trim()} />) تتقاطع مع {overlap?.map((h, i) => <span key={h.area_id}>{i ? " و" : ""}«{h.name_ar}» (<Money value={h.fee} />)</span>)}
          {overlap && overlap.some((h) => h.branches.length) ? <>، و<Num>{overlap.reduce((n, h) => n + h.branches.length, 0)}</Num> فرع يقع في الاثنتين</> : null}.
          {" "}بالإعداد الحالي (M-27) قد تتوقف طلبياتها أو يتغير رسمها.
        </div>
        <div className="md-dialog-actions">
          <Button block icon="pencil" onClick={() => setOverlap(null)}>تعديل الحدود قبل الحفظ</Button>
          <Button block variant="secondary" loading={act.busy} onClick={() => void submit()}>حفظ رغم التداخل</Button>
        </div>
      </Dialog>
</Section>
  );
}

/** م-27: تنبيه المالك بالمنطقتين المتداخلتين برسمين مختلفين والفروع الواقعة فيهما، والإعداد الساري. */
function OverlapAlert() {
  const st = useLoad(() => api.get<AreaOverlapOut>(`/api/admin/settings/area-overlap`));
  const d = st.data;
  if (!d || !d.overlaps.length) return null;
  const ruleText = { stop: "تتوقف طلبياتها حتى تُصحَّح الحدود", higher: "يُؤخذ الرسم الأعلى", lower: "يُؤخذ الرسم الأقل" }[d.rule] ?? d.rule;
  const rows = d.overlaps.flatMap((o) => (o.branches.length ? o.branches : [{ branch: "لا فرع فيهما الآن" }]).map((b, i) => ({
    key: `${o.area_a}-${o.area_b}-${i}`, branch: String((b as { branch?: string }).branch ?? ""),
    areas: `${o.name_a} ${fmt.money(o.fee_a)} · ${o.name_b} ${fmt.money(o.fee_b)}`, has: o.branches.length > 0,
  })));
  return (
    <Section title="تنبيه: منطقتان متداخلتان برسمين مختلفين" right={<StatusBadge tone="error">M-27</StatusBadge>}>
      {d.overlaps.map((o) => (
        <Note key={`${o.area_a}-${o.area_b}`} tone="error">
          <b>«{o.name_a}» (<Money value={o.fee_a} />) و«{o.name_b}» (<Money value={o.fee_b} />) تتداخلان.</b>{" "}
          {o.branches.length ? <><Num>{o.branches.length}</Num> فرع يقع فيهما معاً. </> : null}
          الإعداد الآن: <b>{ruleText}</b> (M-27).
        </Note>
      ))}
      <DataTable rows={rows} rowKey={(r) => r.key} columns={[
        { key: "branch", label: "الفرع" },
        { key: "areas", label: "المنطقتان" },
        { key: "s", label: "الحالة", render: (r) => (r.has ? <StatusBadge tone={d.rule === "stop" ? "error" : "warning"}>{d.rule === "stop" ? "متوقفة" : ruleText}</StatusBadge> : "—") },
      ]} />
      <span className="text-13 text-ink-muted">صحّح الحدود بتعديل المنطقة أدناه، أو غيّر القاعدة من الإعدادات.</span>
    </Section>
  );
}
