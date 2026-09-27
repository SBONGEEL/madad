/** النسخ الاحتياطية (§12-ي ن-3، §12-ك ٢) — للمالك: الدورية ومدة الحفظ ومكانها، والنسخ وتنزيلها، وسجل الوصول.
 * الملف يُنزَّل مشفّراً كما هو؛ كلمة السر لا تمرّ باللوحة ولا بالخلفية. المشرف: «عرض حالة النسخ» يرى الحالة والسجل
 * والتنبيهات، و«إنشاء نسخة الآن» يطلب نسخة؛ بلاهما «للمالك وحده». كل عرض وإنشاء وتنزيل يُسجَّل في الخادم. */
import { useState } from "react";

import { ApiError } from "@ui/client";
import * as fmt from "@ui/fmt";
import {
  Button, DataTable, EmptyState, Loader, Note, Num, Option, PageHead, Section, StatusBadge, type Tone, toast, useAction, useLoad,
} from "@ui/kit";
import { api } from "@/api/client";
import type { BackupAccessOut, BackupRequestOut, BackupRunOut, BackupStatusOut, BackupsOut } from "@/api/types";
import { useSession } from "@/session";

const STATUS: Record<string, [string, Tone]> = { ok: ["ناجحة", "success"], failed: ["فشلت", "error"], running: ["جارية", "info"] };
const KIND: Record<string, string> = { daily: "يومية", weekly: "أسبوعية", manual: "يدوية" };
const ACTION: Record<string, string> = { view: "عرض حالة النسخ", create: "إنشاء نسخة الآن", download: "تنزيل نسخة" };
const PLAN: Record<string, string> = { daily30: "يومية 30 يوماً", daily7_weekly12: "يومية 7 أيام + أسبوعية 12 أسبوعاً" };
const PLACE: Record<string, string> = { both: "الخادم + المنفصلة", local: "الخادم", offsite: "المنفصلة" };
const REASON: Record<string, string> = {
  passphrase_missing: "كلمة سر التشفير غير مضبوطة على الخادم",
  offsite_not_configured: "المساحة المنفصلة غير مضبوطة",
};

const reason = (e: string | null) => (e && REASON[e]) || "تعذّر إكمال النسخة أو رفعها";

/** أين حُفظت فعلاً. */
function where(r: BackupRunOut): string {
  if (r.status !== "ok") return r.location === "both" ? "الخادم + المنفصلة" : r.location === "local" ? "الخادم" : "المنفصلة";
  return r.local_ok && r.offsite_ok ? "الخادم + المنفصلة" : r.local_ok ? "الخادم" : "المنفصلة";
}

function size(b: number | null): string {
  if (!b) return "—";
  return b >= 1024 ** 3 ? `${(b / 1024 ** 3).toFixed(1)} GB` : `${Math.max(1, Math.round(b / 1024 ** 2))} MB`;
}

function token(): string | null {
  try {
    const raw = localStorage.getItem("madad.admin.tokens");
    return raw ? (JSON.parse(raw) as { access_token: string }).access_token : null;
  } catch {
    return null;
  }
}

/** طلب يعيد بايتات لا JSON، بالرمز نفسه، ومرة ثانية بعد تجديده إن انتهى. */
async function get(path: string): Promise<Blob> {
  const send = () => fetch(path, { headers: token() ? { Authorization: `Bearer ${token()}` } : {} });
  let res = await send().catch(() => { throw new ApiError(0, "network"); });
  if (res.status === 401) {
    await api.get(`/api/admin/me`).catch(() => undefined);
    res = await send();
  }
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { code?: string };
    throw new ApiError(res.status, body.code ?? `http_${res.status}`);
  }
  return res.blob();
}

/** تنزيل النسخة (يُسجَّل في الخادم قبل أن يبدأ) وحفظها باسم ملفها. */
async function download(r: BackupRunOut): Promise<void> {
  const url = URL.createObjectURL(await get(`/api/admin/backups/${r.id}/download`));
  const a = document.createElement("a");
  a.href = url;
  a.download = r.file_name ?? `madad-backup-${r.id}.mdbk`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function Backups() {
  const { isOwner, can } = useSession();
  const view = can("backups_view"), run = can("backups_run");
  return (
    <div className="md-page">
      <PageHead title="النسخ الاحتياطية" sub="نسخة مشفّرة من القاعدة والملفات. تسري الإعدادات من النسخة التالية." />
      {isOwner ? <><OwnerView /><AccessLog /></> : view || run ? (
        <div className="grid grid-cols-2 gap-4 items-start">
          {view ? <ViewerView /> : null}
          {run ? <CreateNow /> : null}
        </div>
      ) : <OwnerOnly />}
    </div>
  );
}

/** «إنشاء نسخة الآن»: طلب يأخذه عامل النسخ خلال دقيقة. طلب والأول لم ينتهِ يُرفض: «نسخة قيد الإنشاء». */
function CreateNow({ inline }: { inline?: boolean }) {
  const act = useAction();
  const [done, setDone] = useState(false);
  async function go() {
    const v = await act.run(() => api.post<BackupRequestOut>(`/api/admin/backups/run`));
    if (v) setDone(true);
  }
  const body = (
    <>
      <div><Button icon="refresh-cw" variant={inline ? "secondary" : undefined} loading={act.busy} onClick={() => void go()}>إنشاء نسخة احتياطية الآن</Button></div>
      {done ? <Note tone="success"><b>طُلبت نسخة الآن.</b> تبدأ خلال دقيقة، ويصل المالك تنبيه إن فشلت.</Note> : null}
    </>
  );
  if (inline) return body;
  return (
    <Section title="إنشاء نسخة الآن">
      {body}
      <span className="text-13 text-ink-muted">طلب ثانٍ والأول لم ينتهِ يُرفض: «نسخة قيد الإنشاء».</span>
    </Section>
  );
}

/** ما يراه صاحب «عرض حالة النسخ»: الحالة والسجل والتنبيهات — لا تنزيل ولا إعدادات. */
function ViewerView() {
  const st = useLoad(() => api.get<BackupStatusOut>(`/api/admin/backups/status`));
  return (
    <Loader state={st} rows={5}>{(d) => {
      const lastFail = d.runs.find((r) => r.status === "failed");
      return (
        <Section title="حالة النسخ">
          {d.alert === "failed" && lastFail ? (
            <Note tone="error"><b>فشلت نسخة <Num>{fmt.dateTime(lastFail.started_at)}</Num>.</b> السبب: {reason(lastFail.error)}.</Note>
          ) : d.alert === "stale" ? <Note tone="warning"><b>مرّ يوم بلا نسخة ناجحة.</b></Note> : null}
          <div className="flex gap-2 flex-wrap">
            <StatusBadge tone="neutral">{PLAN[d.plan] ?? d.plan}</StatusBadge>
            <StatusBadge tone="neutral">{PLACE[d.location] ?? d.location}</StatusBadge>
          </div>
          <span className="text-13 font-bold text-ink-muted">السجل</span>
          <Runs runs={d.runs} />
          <Note tone="info">ترى الحالة والسجل والتنبيهات فقط: لا تنزيل ولا إعدادات. كل فتح لهذا القسم يُسجَّل.</Note>
        </Section>
      );
    }}</Loader>
  );
}

/** سجل الوصول — من ومتى (المالك وحده). */
function AccessLog() {
  const log = useLoad(() => api.get<BackupAccessOut[]>(`/api/admin/backups/access`));
  return (
    <Section title="سجل الوصول — من ومتى">
      <Loader state={log} rows={4}>{(rows) => (
        <DataTable<BackupAccessOut> rows={rows} rowKey={(r) => `${r.at}-${r.who}-${r.action}`} emptyIcon="history"
          emptyTitle="لا وصول مسجَّل بعد" emptyBody="كل عرض وإنشاء وتنزيل يظهر هنا."
          columns={[
            { key: "at", label: "الوقت", render: (r) => <Num>{fmt.dateTime(r.at)}</Num> },
            { key: "who", label: "من", render: (r) => r.who },
            { key: "what", label: "ماذا", render: (r) => (r.action === "download" && r.file_name ? `${ACTION.download} ${r.file_name}` : ACTION[r.action] ?? r.action) },
          ]} />
      )}</Loader>
    </Section>
  );
}

/** جدول النسخ بلا تنزيل (للمشرف). */
function Runs({ runs }: { runs: BackupRunOut[] }) {
  return (
    <DataTable<BackupRunOut> rows={runs} rowKey={(r) => r.id} emptyIcon="shield-check" emptyTitle="لا نسخ بعد"
      emptyBody="أول نسخة تظهر هنا بعد موعدها الليلي." rowTone={(r) => r.status === "failed" && "error"}
      columns={[
        { key: "w", label: "الوقت", render: (r) => <Num>{fmt.dateTime(r.started_at)}</Num> },
        { key: "k", label: "النوع", render: (r) => KIND[r.kind] ?? r.kind },
        { key: "s", label: "الحجم", render: (r) => <Num>{size(r.byte_size)}</Num> },
        { key: "l", label: "المكان", render: where },
        { key: "st", label: "الحالة", render: (r) => { const [l, t] = STATUS[r.status] ?? [r.status, "neutral"]; return <StatusBadge tone={t}>{l}</StatusBadge>; } },
      ]} />
  );
}

function OwnerOnly() {
  return <Section><EmptyState compact icon="shield-check" title="للمالك وحده" body="إعدادات النسخ الاحتياطية وتنزيلها صلاحية المالك وحده." /></Section>;
}

function OwnerView() {
  const st = useLoad(() => api.get<BackupsOut>(`/api/admin/backups`));
  if (st.error?.code === "forbidden_owner_only" || st.error?.code === "http_403") return <OwnerOnly />;
  return <Loader state={st} rows={6}>{(d) => <Body key={d.policy.at} d={d} onSaved={st.set} />}</Loader>;
}

function Body({ d, onSaved }: { d: BackupsOut; onSaved: (v: BackupsOut) => void }) {
  const act = useAction();
  const [plan, setPlan] = useState(d.policy.plan);
  const [location, setLocation] = useState(d.policy.location);
  const [loading, setLoading] = useState<number | null>(null);
  const lastOk = d.runs.find((r) => r.status === "ok");
  const lastFail = d.runs.find((r) => r.status === "failed");
  const noPass = d.runs[0]?.status === "failed" && d.runs[0].error === "passphrase_missing";

  async function save() {
    const v = await act.run(() => api.put<BackupsOut>(`/api/admin/backups/policy`, { plan, location }), "حُفظت إعدادات النسخ — تسري من النسخة التالية");
    if (v) onSaved(v);
  }

  async function get(r: BackupRunOut) {
    setLoading(r.id);
    try {
      await download(r);
    } catch (e) {
      toast((e as Error).message, true);
    } finally {
      setLoading(null);
    }
  }

  const okAt = lastOk ? <> آخر نسخة ناجحة <Num>{fmt.dateTime(lastOk.finished_at ?? lastOk.started_at)}</Num>.</> : " لا نسخة ناجحة بعد.";
  return (
    <Section right={<StatusBadge tone="neutral" icon="shield-check">المالك وحده</StatusBadge>} title="النسخ الاحتياطية">
      {d.alert === "failed" && lastFail ? (
        <Note tone="error">
          <b>فشلت نسخة <Num>{fmt.dateTime(lastFail.started_at)}</Num>.</b> السبب: {reason(lastFail.error)}.{okAt} وصلك التنبيه في صندوقك أيضاً.
        </Note>
      ) : d.alert === "stale" ? (
        <Note tone="warning"><b>مرّ يوم بلا نسخة ناجحة.</b>{okAt}</Note>
      ) : null}

      <div className="grid grid-cols-2 gap-4 items-start">
        <div className="flex flex-col gap-2">
          <span className="text-13 font-bold text-ink-muted">الدورية ومدة الحفظ</span>
          <Option label="يومية، تُحفظ 30 يوماً" sub="30 نسخة في كل وقت." selected={plan === "daily30"} disabled={act.busy} onSelect={() => setPlan("daily30")} />
          <Option label="يومية 7 أيام + أسبوعية 12 أسبوعاً" sub="أول نسخة ناجحة في كل أسبوع تُحفظ 12 أسبوعاً." initial
            selected={plan === "daily7_weekly12"} disabled={act.busy} onSelect={() => setPlan("daily7_weekly12")} />
        </div>
        <div className="flex flex-col gap-2">
          <span className="text-13 font-bold text-ink-muted">مكان الحفظ</span>
          <Option label="خارج الخادم" sub="في مساحة التخزين المنفصلة وحدها." selected={location === "offsite"} disabled={act.busy} onSelect={() => setLocation("offsite")} />
          <Option label="على الخادم نفسه" sub="أسرع في الاسترجاع، ويضيع مع الخادم." selected={location === "local"} disabled={act.busy} onSelect={() => setLocation("local")} />
          <Option label="الاثنان" sub="على الخادم وفي المساحة المنفصلة." initial selected={location === "both"} disabled={act.busy} onSelect={() => setLocation("both")} />
        </div>
      </div>

      <div className="flex gap-2 flex-wrap">
        {noPass ? <StatusBadge tone="error" icon="shield-check">كلمة سر التشفير: غير مضبوطة على الخادم</StatusBadge>
          : lastOk ? <StatusBadge tone="success" icon="shield-check">كلمة سر التشفير: مضبوطة على الخادم</StatusBadge> : null}
        {d.offsite_configured ? <StatusBadge tone="success" icon="check">المساحة المنفصلة: مضبوطة</StatusBadge>
          : <StatusBadge tone="warning" icon="triangle-alert">المساحة المنفصلة: غير مضبوطة</StatusBadge>}
        <StatusBadge tone="info" icon="clock">تسري من النسخة التالية</StatusBadge>
      </div>
      <div>
        <Button icon="check" loading={act.busy} disabled={plan === d.policy.plan && location === d.policy.location} onClick={() => void save()}>حفظ</Button>
      </div>
      <CreateNow inline />

      <span className="text-13 font-bold text-ink-muted">النسخ المتاحة</span>
      <DataTable<BackupRunOut> rows={d.runs} rowKey={(r) => r.id} emptyIcon="shield-check" emptyTitle="لا نسخ بعد"
        emptyBody="أول نسخة تظهر هنا بعد موعدها الليلي." rowTone={(r) => r.status === "failed" && "error"}
        columns={[
          { key: "w", label: "الوقت", render: (r) => <Num>{fmt.dateTime(r.started_at)}</Num> },
          { key: "k", label: "النوع", render: (r) => KIND[r.kind] ?? r.kind },
          { key: "s", label: "الحجم", render: (r) => <Num>{size(r.byte_size)}</Num> },
          { key: "l", label: "المكان", render: where },
          { key: "st", label: "الحالة", render: (r) => { const [l, t] = STATUS[r.status] ?? [r.status, "neutral"]; return <StatusBadge tone={t}>{l}</StatusBadge>; } },
          { key: "a", label: "", render: (r) => (r.downloadable
            ? <Button size="sm" variant="secondary" icon="file-text" loading={loading === r.id} disabled={loading != null} onClick={() => void get(r)}>تنزيل</Button>
            : null) },
        ]} />
      <Note tone="info">
        التنزيل لك وحدك (لا للمشرفين)، ويُسجَّل كل تنزيل. الملف مشفّر ولا يُفتح إلا بكلمة السر التي وضعتها — كلمة السر لا تُحفظ هنا ولا في القاعدة. خطوات الاسترجاع في دليل النشر.
      </Note>
    </Section>
  );
}
