/** الاعتمادات: عملاء وفروعهم وموردون وسائقون وأصناف مقترحة. لا عملية لطرف قبل اعتماده؛
 *  المورد لا يُعتمد بلا دورية صرف (SPEC §5)، والسائق بلا طريقة صرف أجره (م-11) — بلا قيمة افتراضية. */
import { useEffect, useState } from "react";

import * as fmt from "@ui/fmt";
import { Button, ConfirmDialog, cx, Dialog, EmptyState, ErrorState, Icon, LoadingState, Num, Option, PageHead, StatusBadge,
  useAction, useLoad, type Tone } from "@ui/kit";
import { api } from "@/api/client";
import type { ApprovalIn, DocumentOut, PendingOut, ProposalOut } from "@/api/types";
import { openDocument } from "@/lib/admin-media";
import { CYCLE, PAY_METHOD } from "@/lib/commerce-shared";
import { useSession } from "@/session";

type Tab = "all" | "customer" | "supplier" | "driver" | "proposal";
type Entry = { key: string; tab: Exclude<Tab, "all">; kind: string; id: number; name: string; created_at: string; pending?: PendingOut; proposal?: ProposalOut };

const KIND: Record<string, [string, Tone]> = {
  customer: ["عميل", "neutral"], branch: ["فرع", "neutral"], supplier: ["مورد", "info"], driver: ["سائق", "primary"], proposal: ["صنف مقترح", "warning"],
};
const EST: Record<string, string> = { restaurant: "مطعم", cafe: "مقهى", other: "منشأة" };
const VEHICLE: Record<string, string> = { motorcycle: "دراجة نارية", car: "سيارة", van: "فان", pickup: "بيك أب", truck: "شاحنة" };

function meta(e: Entry): string {
  const when = fmt.dateTime(e.created_at);
  if (e.proposal) return `اقترحه ${e.proposal.supplier_name}${e.proposal.similar.length ? ` · يشبه «${e.proposal.similar[0]}» في القاموس` : ""}`;
  const p = e.pending!;
  if (p.kind === "customer") {
    const [k = "", contact = ""] = p.detail.split(" · ");
    return `${EST[k] ?? k} · ${contact} · ${when}`;
  }
  if (p.kind === "driver") return `${VEHICLE[p.detail] ?? p.detail} · ${when}`;
  if (p.kind === "branch") return `فرع جديد · ${p.detail} · ${when}`;
  return `${p.detail} · ${when}`;
}

export function Approvals() {
  const { can, refreshCounts } = useSession();
  const seesProposals = can("catalog");
  const pend = useLoad(() => api.get<PendingOut[]>(`/api/admin/approvals`));
  const props = useLoad(() => (seesProposals ? api.get<ProposalOut[]>(`/api/admin/proposals`) : Promise.resolve([] as ProposalOut[])), [seesProposals]);
  const act = useAction();
  const [tab, setTab] = useState<Tab>("all");
  const [sel, setSel] = useState<string | null>(null);
  const [cycle, setCycle] = useState("");
  const [payMethod, setPayMethod] = useState("");
  const [rejecting, setRejecting] = useState(false);

  const entries: Entry[] = [
    ...(pend.data ?? []).map((p): Entry => ({
      key: `${p.kind}:${p.id}`, tab: p.kind === "branch" ? "customer" : (p.kind as Entry["tab"]), kind: p.kind, id: p.id, name: p.name,
      created_at: p.created_at, pending: p,
    })),
    ...(props.data ?? []).map((p): Entry => ({
      key: `proposal:${p.id}`, tab: "proposal", kind: "proposal", id: p.id, name: `«${p.name_ar}»`, created_at: p.created_at, proposal: p,
    })),
  ];
  const count = (t: Tab) => (t === "all" ? entries.length : entries.filter((e) => e.tab === t).length);
  const shown = tab === "all" ? entries : entries.filter((e) => e.tab === tab);
  const current = shown.find((e) => e.key === sel) ?? shown[0] ?? null;

  useEffect(() => {
    setCycle("");
    setRejecting(false);
  }, [current?.key]);

  const tabs: Array<{ value: Tab; label: string }> = [
    { value: "all", label: "الكل" }, { value: "customer", label: "عملاء" }, { value: "supplier", label: "موردون" },
    { value: "driver", label: "سائقون" }, ...(seesProposals ? [{ value: "proposal" as Tab, label: "أصناف مقترحة" }] : []),
  ];

  async function decide(decision: "approve" | "reject") {
    if (!current) return;
    let ok: unknown;
    if (current.proposal) {
      ok = await act.run(async () => {
        const list = await api.post<ProposalOut[]>(`/api/admin/proposals/${current.id}`, { decision });
        props.set(list);
        return list;
      }, decision === "approve" ? "اعتُمد الصنف في القاموس" : "رُفض الاقتراح");
    } else {
      const body: ApprovalIn = { decision };
      if (decision === "approve" && current.kind === "supplier") body.payout_cycle = cycle;
      if (decision === "approve" && current.kind === "driver") body.pay_method = payMethod;
      ok = await act.run(async () => {
        const list = await api.post<PendingOut[]>(`/api/admin/approvals/${current.kind}/${current.id}`, body);
        pend.set(list);
        return list;
      }, decision === "approve" ? "تم الاعتماد" : "تم الرفض");
    }
    if (ok) {
      setRejecting(false);
      setSel(null);
      if (current.kind === "driver") setPayMethod("");
      refreshCounts();
    }
  }

  const loading = (pend.loading && !pend.data) || (props.loading && !props.data);
  const error = pend.error ?? props.error;
  const kindName = current ? (KIND[current.kind]?.[0] ?? current.kind) : "";
  const needs = current?.kind === "supplier" ? !cycle : current?.kind === "driver" ? !payMethod : false;

  return (
    <div className="md-page">
      <PageHead title="الاعتمادات" actions={<span className="text-14 text-ink-muted">لا عملية لطرف قبل اعتماده</span>} />

      <div role="tablist" className="flex gap-2 flex-wrap">
        {tabs.map((t) => (
          <button key={t.value} type="button" role="tab" aria-selected={tab === t.value}
            className={cx("md-btn md-btn-sm rounded-full", tab === t.value ? "md-btn-primary" : "md-btn-secondary")}
            onClick={() => { setTab(t.value); setSel(null); }}>
            {t.label} <Num>{count(t.value)}</Num>
          </button>
        ))}
      </div>

      {loading ? <LoadingState rows={3} />
        : error && !entries.length ? <ErrorState compact title={error.message} code={error.code} onRetry={() => { pend.reload(); props.reload(); }} />
        : !shown.length ? <EmptyState icon="shield-check" title="لا طلبات تنتظرك" body="كل عميل أو مورد أو سائق يسجّل يظهر هنا حتى تعتمده." />
        : (
          <div className="grid grid-cols-3 gap-5 items-start">
            <div className="flex flex-col gap-2">
              {shown.map((e) => {
                const [label, tone] = KIND[e.kind] ?? [e.kind, "neutral" as Tone];
                const on = e.key === current?.key;
                return (
                  <button key={e.key} type="button" onClick={() => setSel(e.key)} aria-pressed={on}
                    className={cx("flex flex-col gap-1 py-3.5 px-4 rounded-md bg-surface text-start font-sans text-ink cursor-pointer",
                      on ? "border-2 border-primary" : "border border-border")}>
                    <span className="flex justify-between items-center gap-2">
                      <b className="text-15">{e.name}</b>
                      <StatusBadge tone={tone}>{label}</StatusBadge>
                    </span>
                    <span className="text-13 text-ink-muted">{meta(e)}</span>
                  </button>
                );
              })}

              <div className="mt-2 bg-surface border border-dashed border-border-strong rounded-md p-3 flex flex-col gap-2">
                <span className="text-13 font-bold">عند اعتماد سائق: طريقة صرف أجره <span className="text-error-text">*</span></span>
                <div role="radiogroup" className="grid grid-cols-2 gap-1.5">
                  {Object.entries(PAY_METHOD).map(([v, l]) => (
                    <button key={v} type="button" role="radio" aria-checked={payMethod === v} onClick={() => setPayMethod(v)}
                      className={cx("md-btn md-btn-sm", payMethod === v ? "md-btn-primary" : "md-btn-secondary")}>{l}</button>
                  ))}
                </div>
                <span className="text-12 text-ink-muted">بلا قيمة افتراضية (M-11). لا يُعتمد السائق قبل اختيارها.</span>
              </div>
            </div>

            {current ? (
              <section className="md-sec col-span-2 p-6 gap-4">
                <div className="flex justify-between items-start gap-3">
                  <div className="flex flex-col gap-1">
                    <h2 className="m-0 text-19 font-bold">{current.name}</h2>
                    <span className="text-14 text-ink-muted">
                      {kindName} · {current.proposal ? "اقتُرح" : "سجّل"} <Num>{fmt.dateTime(current.created_at)}</Num>
                      {current.pending?.phone ? <> · <Num>{fmt.phoneLocal(current.pending.phone)}</Num></> : null}
                    </span>
                  </div>
                  <StatusBadge tone="warning">بانتظار الاعتماد</StatusBadge>
                </div>

                <Details e={current} />

                {current.kind === "supplier" ? (
                  <div className="flex flex-col gap-2">
                    <span className="text-14 font-medium">دورية صرف المستحقات <span className="text-error-text">*</span></span>
                    <div role="radiogroup" className="grid grid-cols-4 gap-2">
                      {Object.entries(CYCLE).map(([v, l]) => <Option key={v} label={l} selected={cycle === v} onSelect={() => setCycle(v)} />)}
                    </div>
                    <span className="text-13 text-ink-muted">تُختار عند الاعتماد، بلا قيمة افتراضية (SPEC §5). لا يُعتمد المورد قبل اختيارها.</span>
                  </div>
                ) : null}
                {current.kind === "driver" && !payMethod
                  ? <span className="text-13 text-ink-muted">اختر طريقة صرف أجر السائق أولاً (في العمود المجاور).</span> : null}

                <div className="flex gap-3 flex-wrap">
                  <Button icon="check" disabled={needs} loading={act.busy && !rejecting} onClick={() => decide("approve")}>
                    {current.proposal ? "اعتماد الصنف" : `اعتماد ${kindName === "عميل" ? "العميل" : kindName === "مورد" ? "المورد" : kindName === "سائق" ? "السائق" : "الفرع"}`}
                  </Button>
                  <Button variant="danger" disabled={act.busy} onClick={() => setRejecting(true)}>رفض</Button>
                </div>
              </section>
            ) : null}
          </div>
        )}

      <ConfirmDialog open={rejecting && !!current} tone="error" title={`رفض «${current?.name ?? ""}»؟`}
        body={current?.proposal ? "لا يظهر الصنف في القاموس ولا يُعرض." : "لا يستطيع إجراء أي عملية على مَدَد بعد الرفض."}
        confirmLabel="رفض" loading={act.busy} onConfirm={() => decide("reject")} onCancel={() => setRejecting(false)} />
    </div>
  );
}

/** ما يعرفه الخادم عن الطرف: الحقول المتاحة فقط. */
function Details({ e }: { e: Entry }) {
  const rows: Array<[string, string]> = [];
  if (e.proposal) {
    rows.push(["المورد المقترِح", e.proposal.supplier_name], ["التصنيف المقترح", e.proposal.category],
      ["يشبه في القاموس", e.proposal.similar.length ? e.proposal.similar.join("، ") : "لا شيء مشابه"]);
  } else if (e.pending) {
    const p = e.pending;
    if (p.kind === "customer") {
      const [k = "", contact = ""] = p.detail.split(" · ");
      rows.push(["نوع المنشأة", EST[k] ?? k], ["المسؤول", contact]);
    } else if (p.kind === "supplier") rows.push(["المسؤول", p.detail]);
    else if (p.kind === "driver") rows.push(["المركبة", VEHICLE[p.detail] ?? p.detail]);
    else rows.push(["عنوان الفرع", p.detail]);
  }
  return (
    <div className="flex flex-col gap-3">
      <div className="grid grid-cols-2 gap-3 text-14">
        {rows.map(([k, v]) => (
          <div key={k} className="flex flex-col gap-0.5"><span className="text-ink-muted">{k}</span><span className="font-medium">{v}</span></div>
        ))}
      </div>
      {e.pending && e.pending.kind !== "branch" ? <Documents kind={e.pending.kind} id={e.pending.id} /> : null}
    </div>
  );
}

const DOC: Record<string, string> = {
  facade: "صورة الواجهة", commercial_register: "السجل التجاري", owner_id: "هوية المالك", driver_id: "الهوية",
  driver_license: "الرخصة — الوجه", driver_license_back: "الرخصة — الظهر", driver_photo: "الصورة الشخصية",
};

/** وثائق الطرف: كل فتح يُسجَّل بمن فتحه ومتى (الترحيلة 0013). */
function Documents({ kind, id }: { kind: string; id: number }) {
  const docs = useLoad(() => api.get<DocumentOut[]>(`/api/admin/approvals/${kind}/${id}/documents`), [kind, id]);
  const act = useAction();
  const [shown, setShown] = useState<{ url: string; title: string; pdf: boolean } | null>(null);
  useEffect(() => () => { if (shown) URL.revokeObjectURL(shown.url); }, [shown]);
  if (!docs.data?.length) return null;
  async function show(d: DocumentOut) {
    const url = await act.run(() => openDocument(d.media_id));
    if (url) {
      setShown({ url, title: DOC[d.purpose] ?? d.purpose, pdf: d.mime_type === "application/pdf" });
      docs.reload();
    }
  }
  return (
    <div className="flex flex-col gap-2">
      <span className="text-13 text-ink-muted">الوثائق — كل فتح يُسجَّل باسمك</span>
      <div className="grid grid-cols-2 gap-2">
        {docs.data.map((d) => (
          <button key={`${d.purpose}-${d.media_id}`} type="button" className="md-row-link justify-between cursor-pointer border-0"
            disabled={act.busy} onClick={() => void show(d)}>
            <span className="flex items-center gap-2"><Icon name={d.mime_type === "application/pdf" ? "file-text" : "camera"} size={18} />{DOC[d.purpose] ?? d.purpose}</span>
            <span className="text-12 text-ink-muted">{d.views ? <>فُتحت <Num>{d.views}</Num></> : "لم تُفتح"}</span>
          </button>
        ))}
      </div>
      <Dialog open={!!shown} onClose={() => setShown(null)} wide label={shown?.title}>
        <div className="md-dialog-title">{shown?.title}</div>
        {shown ? (shown.pdf
          ? <a className="md-link" href={shown.url} target="_blank" rel="noreferrer">فتح الملف في نافذة جديدة</a>
          : <img src={shown.url} alt={shown.title} className="w-full h-auto rounded-md" />) : null}
        <div className="md-dialog-actions"><Button variant="ghost" block onClick={() => setShown(null)}>إغلاق</Button></div>
      </Dialog>
    </div>
  );
}
