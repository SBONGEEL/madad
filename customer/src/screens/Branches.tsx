/**
 * 13 الفروع (م-9): الصاحب يرى فروع منشأته ويضيف فرعاً (?view=new) أو يعدّله (?edit=<id>)، وكل فرع جديد يمرّ باعتماد مَدَد.
 * تغيير الموقع أو العنوان يعيد الفرع إلى «بانتظار الاعتماد» (حارس القاعدة). المسؤول يرى فرعه وحده.
 */
import { useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";

import { Button, EmptyState, ErrorState, Icon, LoadingState, Note, Select, StatusBadge, TextField, toast, useLoad } from "@ui/kit";
import { api } from "@/api/client";
import type { BranchOut, ZoneOut } from "@/api/types";
import { acctError } from "@/lib/acct-http";
import { LocationPicker, type Pin, pinValid } from "@/lib/acct-map";
import { BRANCH_STATUS } from "@/lib/acct-ui";
import { Screen } from "@/lib/shell";
import { useSession } from "@/session";

/** فرق حقيقي في الإحداثي لا فرق تقريب. */
const far = (a: string, b: string) => Math.abs(Number(a) - Number(b)) > 0.000002;

const addr = (b: BranchOut) => [b.zone_name, b.address_text].filter(Boolean).join(" · ");

function Badge({ b }: { b: BranchOut }) {
  if (!b.active) return <StatusBadge tone="neutral">موقوف</StatusBadge>;
  const [label, tone] = BRANCH_STATUS[b.status] ?? [b.status, "neutral" as const];
  return <StatusBadge tone={tone}>{label}</StatusBadge>;
}

export function Branches() {
  const { isOwner } = useSession();
  const [params] = useSearchParams();
  const list = useLoad(() => api.get<BranchOut[]>(`/api/customer/branches`));
  const [sent, setSent] = useState<string | null>(null);
  const editId = params.get("edit");
  const creating = params.get("view") === "new";

  if (sent) {
    return (
      <Screen title="الفروع" back="/branches">
        <div className="flex-1 flex flex-col gap-3.5 items-center justify-center text-center">
          <span className="rounded-full bg-secondary-tint text-primary-text grid place-items-center p-5"><Icon name="clock" size={36} /></span>
          <h1 className="m-0 text-22 font-bold">نراجع «{sent}»</h1>
          <span className="text-15 text-ink-muted">تصلك رسالة حين نعتمده، وتستطيع بعدها الطلب له.</span>
          <StatusBadge tone="warning">بانتظار الاعتماد</StatusBadge>
        </div>
        <Button variant="secondary" block onClick={() => setSent(null)}>رجوع إلى الفروع</Button>
      </Screen>
    );
  }

  if (isOwner && (creating || editId)) {
    const editing = editId ? list.data?.find((b) => String(b.id) === editId) : undefined;
    if (editId && !editing) {
      return (
        <Screen title="تعديل الفرع" back="/branches">
          {list.loading ? <LoadingState rows={3} />
            : <ErrorState compact title={list.error?.message ?? "الفرع غير موجود."} code={list.error?.code ?? "branch_missing"} onRetry={list.reload} />}
        </Screen>
      );
    }
    return <BranchForm key={editId ?? "new"} branch={editing} onSaved={(rows, name, pending) => { list.set(rows); if (pending) setSent(name); }} />;
  }

  return <BranchList list={list.data} loading={list.loading} error={list.error} reload={list.reload} owner={isOwner} />;
}

function BranchList({ list, loading, error, reload, owner }: {
  list: BranchOut[] | null; loading: boolean; error: { code: string; message: string } | null; reload: () => void; owner: boolean;
}) {
  const nav = useNavigate();
  const title = owner ? "الفروع" : "فرعي";
  if (loading && !list) return <Screen title={title}><LoadingState rows={2} /></Screen>;
  if (error && !list) {
    return (
      <Screen title={title}>
        <div className="flex-1 flex flex-col justify-center"><ErrorState compact title={error.message} code={error.code} onRetry={reload} /></div>
      </Screen>
    );
  }
  const rows = list ?? [];
  if (!owner) {
    return (
      <Screen title="فرعي">
        {rows.map((b) => (
          <div key={b.id} className="bg-surface border border-border rounded-md p-3 flex flex-col gap-1.5 text-14">
            <div className="flex justify-between items-center gap-2"><b>{b.name}</b><Badge b={b} /></div>
            <span className="text-13 text-ink-muted">{addr(b)}</span>
            <span className="text-13 text-ink-muted">أنت مسؤول مشتريات هذا الفرع. تطلب له وترى طلبياته وفواتيره فقط.</span>
          </div>
        ))}
        {!rows.length ? <EmptyState icon="store" title="لا فرع مرتبط بحسابك" body="اطلب من صاحب المنشأة ربطك بفرع." /> : null}
        <Note tone="info">إضافة فروع أو مستخدمين لصاحب المنشأة وحده.</Note>
      </Screen>
    );
  }
  return (
    <Screen title="الفروع">
      <div className="flex flex-col gap-2.5">
        {rows.map((b) => (
          <button key={b.id} type="button" onClick={() => nav(`/branches?edit=${b.id}`)} aria-label={`تعديل ${b.name}`}
            className="bg-surface border border-border rounded-md p-3 flex gap-2.5 items-center text-ink text-start font-sans cursor-pointer w-full">
            <Icon name="store" />
            <span className="flex-1 flex flex-col min-w-0"><b>{b.name}</b><span className="text-13 text-ink-muted">{addr(b)}</span></span>
            <Badge b={b} />
          </button>
        ))}
      </div>
      {!rows.length ? <EmptyState icon="store" title="لا فروع بعد" body="أضف فرعاً ليمرّ باعتماد مَدَد." /> : null}
      <Note tone="info">صاحب المنشأة وحده يضيف الفروع. كل فرع جديد يمرّ باعتماد مَدَد قبل الطلب منه.</Note>
      <div className="mt-auto"><Button icon="plus" block onClick={() => nav("/branches?view=new")}>إضافة فرع</Button></div>
    </Screen>
  );
}

function BranchForm({ branch, onSaved }: { branch?: BranchOut; onSaved: (rows: BranchOut[], name: string, pending: boolean) => void }) {
  const nav = useNavigate();
  const zones = useLoad(() => api.get<ZoneOut[]>(`/api/customer/zones`));
  const [name, setName] = useState(branch?.name ?? "");
  const [pin, setPin] = useState<Pin>({ lat: branch?.lat ?? "", lng: branch?.lng ?? "" });
  const [zone, setZone] = useState(branch?.zone_id != null ? String(branch.zone_id) : "");
  const [address, setAddress] = useState(branch?.address_text ?? "");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const moved = !!branch && (far(pin.lat, branch.lat) || far(pin.lng, branch.lng) || address.trim() !== branch.address_text);
  const ok = name.trim() && address.trim() && pinValid(pin);

  async function save() {
    setBusy(true);
    setErr(null);
    const body = { name: name.trim(), lat: pin.lat.trim(), lng: pin.lng.trim(), zone_id: zone ? Number(zone) : null, address_text: address.trim() };
    try {
      const rows = branch
        ? await api.patch<BranchOut[]>(`/api/customer/branches/${branch.id}`, body)
        : await api.post<BranchOut[]>(`/api/customer/branches`, body);
      const pending = !branch || (moved && branch.status === "approved");
      if (!pending) toast("حُفظ الفرع.");
      onSaved(rows, body.name, pending);
      nav("/branches", { replace: true });
    } catch (e) {
      setErr(acctError(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Screen title={branch ? "تعديل الفرع" : "فرع جديد"} back="/branches">
      <TextField label="اسم الفرع" value={name} onChange={setName} required disabled={busy} />
      <LocationPicker value={pin} onChange={setPin} hint="حرّك الخريطة لتضع الدبوس على باب الفرع" />
      {zones.data && zones.data.length ? (
        <Select label="الحي — من قائمة الأحياء" value={zone} onChange={setZone} disabled={busy}
          options={[{ value: "", label: "اختر الحي" }, ...zones.data.map((z) => ({ value: String(z.id), label: z.name_ar }))]} />
      ) : zones.error ? <Note tone="warning">تعذّر تحميل قائمة الأحياء. تستطيع الإرسال دونها.</Note> : null}
      <TextField label="وصف العنوان" value={address} onChange={setAddress} placeholder="شارع، علامة قريبة" required disabled={busy} />
      {branch ? (
        <Note tone="warning">تغيير الموقع أو وصف العنوان يعيد الفرع إلى «بانتظار الاعتماد»، ولا يُطلب له حتى يعتمده مَدَد من جديد.</Note>
      ) : null}
      {err ? <Note tone="error">{err}</Note> : null}
      <div className="mt-auto">
        <Button block loading={busy} disabled={!ok} onClick={() => void save()}>{branch ? (moved ? "حفظ وإرسال للاعتماد" : "حفظ") : "إرسال للاعتماد"}</Button>
      </div>
    </Screen>
  );
}
