/**
 * 06 مواقع الاستلام: مواقع المورد على الخريطة بعدد العروض النشطة وحالتها، وإضافة موقع (?view=new) بدبوس ووصف للسائق،
 * وتعديل الاسم والوصف وإيقاف الموقع وتفعيله (?edit=<id>). لا يُعطَّل موقع عليه عروض نشطة (location_in_use في القاعدة).
 */
import { useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";

import { Button, Dialog, EmptyState, ErrorState, Icon, Loaded, LoadingState, Note, StatusBadge, TextField, toast, useLoad } from "@ui/kit";
import { api } from "@/api/client";
import type { LocationOut } from "@/api/types";
import { offError, offersWord } from "@/lib/off-http";
import { LocationPicker, LocationsMap, type Pin, pinValid } from "@/lib/off-map";
import { Screen } from "@/lib/shell";

const TITLE = "مواقع الاستلام";

export function Locations() {
  const [params] = useSearchParams();
  const list = useLoad(() => api.get<LocationOut[]>(`/api/supplier/locations`), []);
  const editId = params.get("edit");

  if (params.get("view") === "new") return <NewLocation onSaved={list.set} />;
  if (editId) {
    const loc = list.data?.find((l) => String(l.id) === editId);
    if (!loc) {
      return (
        <Screen title="تعديل الموقع" back="/locations">
          {list.loading ? <LoadingState rows={2} />
            : <ErrorState compact title={list.error?.message ?? "الموقع غير موجود."} code={list.error?.code ?? "location_not_found"} onRetry={list.reload} />}
        </Screen>
      );
    }
    return <EditLocation key={loc.id} loc={loc} onSaved={list.set} />;
  }
  return <LocationList state={list} />;
}

function LocationList({ state }: { state: Loaded<LocationOut[]> }) {
  const nav = useNavigate();
  if (state.loading && !state.data) {
    return <Screen title={TITLE} back="/profile"><span className="md-skel md-map block" /><LoadingState rows={2} /></Screen>;
  }
  if (!state.data) {
    return (
      <Screen title={TITLE} back="/profile">
        <div className="flex-1 flex flex-col justify-center">
          <ErrorState title="تعذّر تحميل مواقعك" body="تحقق من الاتصال ثم أعد المحاولة." code={state.error?.code} onRetry={state.reload} />
        </div>
      </Screen>
    );
  }
  const rows = state.data;
  return (
    <Screen title={TITLE} back="/profile">
      <LocationsMap points={rows.filter((l) => l.active)} label="مواقع الاستلام على الخريطة" />
      {!rows.length ? <EmptyState icon="map-pin" title="لا مواقع استلام بعد" body="أضف الموقع الذي يستلم منه سائق مَدَد بضاعتك." /> : null}
      <div className="flex flex-col gap-2">
        {rows.map((l) => (
          <button key={l.id} type="button" onClick={() => nav(`/locations?edit=${l.id}`)} aria-label={`تعديل ${l.label}`}
            className="bg-surface border border-border rounded-md p-3 flex gap-2.5 items-center text-ink text-start font-sans cursor-pointer w-full">
            <Icon name="map-pin" />
            <span className="flex-1 flex flex-col min-w-0">
              <b>{l.label}</b>
              <span className="text-13 text-ink-muted">{l.active_offers ? `${offersWord(l.active_offers)} ${l.active_offers === 1 ? "يُستلم" : "تُستلم"} من هنا` : "لا عروض نشطة من هنا"}</span>
              <span className="text-12 text-ink-muted">{l.address_text}</span>
            </span>
            {l.active ? <StatusBadge tone="success">نشط</StatusBadge> : <StatusBadge tone="neutral">موقوف</StatusBadge>}
          </button>
        ))}
      </div>
      <Button variant="secondary" icon="plus" block onClick={() => nav("/locations?view=new")}>إضافة موقع</Button>
    </Screen>
  );
}

function NewLocation({ onSaved }: { onSaved: (rows: LocationOut[]) => void }) {
  const nav = useNavigate();
  const [label, setLabel] = useState("");
  const [address, setAddress] = useState("");
  const [pin, setPin] = useState<Pin>({ lat: "", lng: "" });
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const ok = label.trim() && address.trim() && pinValid(pin);

  async function save() {
    setBusy(true);
    setErr(null);
    try {
      const rows = await api.post<LocationOut[]>(`/api/supplier/locations`, {
        label: label.trim(), lat: pin.lat.trim(), lng: pin.lng.trim(), address_text: address.trim(),
      });
      onSaved(rows);
      toast("حُفظ الموقع.");
      nav("/locations", { replace: true });
    } catch (e) {
      setErr(offError(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Screen title="موقع جديد" back="/locations">
      <LocationPicker value={pin} onChange={setPin} hint="حرّك الخريطة ليقع الدبوس على باب الاستلام" />
      <TextField label="اسم الموقع" value={label} onChange={setLabel} placeholder="مخزن طريق المطار" required disabled={busy} />
      <TextField label="وصف للسائق" value={address} onChange={setAddress} placeholder="البوابة الزرقاء خلف محطة الوقود" required disabled={busy} />
      {err ? <Note tone="error">{err}</Note> : null}
      <div className="mt-auto"><Button block loading={busy} disabled={!ok} onClick={() => void save()}>حفظ الموقع</Button></div>
    </Screen>
  );
}

function EditLocation({ loc, onSaved }: { loc: LocationOut; onSaved: (rows: LocationOut[]) => void }) {
  const nav = useNavigate();
  const [label, setLabel] = useState(loc.label);
  const [address, setAddress] = useState(loc.address_text);
  const [busy, setBusy] = useState<"save" | "toggle" | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [inUse, setInUse] = useState(false);
  const changed = label.trim() !== loc.label || address.trim() !== loc.address_text;
  const ok = label.trim() && address.trim() && changed;

  async function save() {
    setBusy("save");
    setErr(null);
    try {
      const body: Record<string, string> = {};
      if (label.trim() !== loc.label) body.label = label.trim();
      if (address.trim() !== loc.address_text) body.address_text = address.trim();
      onSaved(await api.patch<LocationOut[]>(`/api/supplier/locations/${loc.id}`, body));
      toast("حُفظ الموقع.");
      nav("/locations", { replace: true });
    } catch (e) {
      setErr(offError(e));
    } finally {
      setBusy(null);
    }
  }

  async function toggle() {
    setBusy("toggle");
    setErr(null);
    try {
      onSaved(await api.patch<LocationOut[]>(`/api/supplier/locations/${loc.id}`, { active: !loc.active }));
      toast(loc.active ? "أُوقف الموقع." : "فُعِّل الموقع.");
    } catch (e) {
      if ((e as { code?: string }).code === "location_in_use") setInUse(true);
      else setErr(offError(e));
    } finally {
      setBusy(null);
    }
  }

  return (
    <Screen title={loc.label} back="/locations">
      <div className="flex items-center gap-2 text-14">
        <Icon name="map-pin" /><span className="flex-1 text-ink-muted">
          {loc.active_offers ? `${offersWord(loc.active_offers)} ${loc.active_offers === 1 ? "يُستلم" : "تُستلم"} من هنا` : "لا عروض نشطة من هنا"}
        </span>
        {loc.active ? <StatusBadge tone="success">نشط</StatusBadge> : <StatusBadge tone="neutral">موقوف</StatusBadge>}
      </div>
      <TextField label="اسم الموقع" value={label} onChange={setLabel} required disabled={!!busy} />
      <TextField label="وصف للسائق" value={address} onChange={setAddress} required disabled={!!busy} />
      <span className="text-12 text-ink-muted">الإحداثيات: <bdi className="md-num" dir="ltr">{loc.lat}, {loc.lng}</bdi></span>
      {err ? <Note tone="error">{err}</Note> : null}
      <div className="mt-auto flex flex-col gap-2">
        <Button block loading={busy === "save"} disabled={!ok || !!busy} onClick={() => void save()}>حفظ</Button>
        <Button block variant={loc.active ? "danger" : "secondary"} loading={busy === "toggle"} disabled={!!busy} onClick={() => void toggle()}>
          {loc.active ? "إيقاف الموقع" : "تفعيل الموقع"}
        </Button>
      </div>
      <Dialog open={inUse} onClose={() => setInUse(false)} label="لا يُعطَّل موقع عليه عروض">
        <ErrorState title="لا يُعطَّل موقع عليه عروض"
          body={`${loc.active_offers ? `${offersWord(loc.active_offers)} ${loc.active_offers === 1 ? "يُستلم" : "تُستلم"}` : "عروض نشطة تُستلم"} من «${loc.label}». أوقفها أولاً، أو أضفها من موقع آخر.`}
          code="location_in_use" />
        <div className="md-dialog-actions">
          <Button block onClick={() => nav("/offers")}>عروضي</Button>
          <Button block variant="ghost" onClick={() => setInUse(false)}>إغلاق</Button>
        </div>
      </Dialog>
    </Screen>
  );
}
