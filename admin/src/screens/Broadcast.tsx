/** الإشعارات الجماعية (ت-41): رسالة واحدة إلى كل العملاء أو كل السائقين، ومعاينتها كما تظهر على الهاتف. */
import { useState } from "react";

import * as fmt from "@ui/fmt";
import { Button, ConfirmDialog, DataTable, Num, Option, PageHead, TextField, useAction, useLoad } from "@ui/kit";
import { api } from "@/api/client";
import type { BroadcastOut } from "@/api/types";

const AUDIENCE: Record<string, string> = { customer: "العملاء", driver: "السائقون", supplier: "الموردون", admin: "المشرفون" };

export function Broadcast() {
  const list = useLoad(() => api.get<BroadcastOut[]>(`/api/admin/broadcasts`));
  const act = useAction();
  const [audience, setAudience] = useState<"customer" | "driver">("customer");
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [ask, setAsk] = useState(false);
  const ready = title.trim() !== "" && body.trim() !== "";

  async function send() {
    const v = await act.run(() => api.post<BroadcastOut[]>(`/api/admin/broadcasts`, { audience, title: title.trim(), body: body.trim() }), "أُرسلت الرسالة");
    setAsk(false);
    if (v) {
      list.set(v);
      setTitle("");
      setBody("");
    }
  }

  const preview = body.trim().length > 90 ? `${body.trim().slice(0, 90)}…` : body.trim();

  return (
    <div className="md-page">
      <PageHead title="الإشعارات الجماعية" />
      <div className="grid grid-cols-[minmax(0,1fr)_var(--w-col-side)] gap-5 items-start">
        <section className="md-sec">
          <div className="flex flex-col gap-1.5">
            <span className="text-14 font-medium">إلى</span>
            <div role="radiogroup" className="grid grid-cols-2 gap-2">
              <Option label="العملاء" selected={audience === "customer"} onSelect={() => setAudience("customer")} />
              <Option label="السائقون" selected={audience === "driver"} onSelect={() => setAudience("driver")} />
            </div>
          </div>
          <TextField label="العنوان" value={title} onChange={setTitle} disabled={act.busy} />
          <TextField label="النص" value={body} onChange={setBody} multiline hint="لا يُذكر فيه اسم مورد ولا سعر شراء." disabled={act.busy} />
          <div className="flex gap-2">
            <Button icon="send" disabled={!ready} loading={act.busy} onClick={() => setAsk(true)}>إرسال الآن</Button>
          </div>
        </section>

        <section className="flex flex-col gap-2.5">
          <span className="text-14 font-bold">كيف يظهر على الهاتف</span>
          <div className="bg-ink rounded-lg p-4 flex flex-col gap-2.5">
            <div className="bg-white rounded-lg p-3 flex gap-2.5">
              <img src="/madad-mark.png" alt="" className="w-10 h-10 object-contain flex-none" />
              <div className="flex flex-col gap-0.5 min-w-0">
                <span className="font-bold text-14">{title.trim() || "عنوان الرسالة"}</span>
                <span className="text-13 md-muted">{preview || "نص الرسالة يظهر هنا."}</span>
              </div>
            </div>
          </div>
          <DataTable rows={list.data} loading={list.loading} error={list.error} onRetry={list.reload} rowKey={(r) => r.id}
            emptyIcon="megaphone" emptyTitle="لم ترسل رسالة جماعية بعد" emptyBody="الرسائل السابقة تظهر هنا مع عدد من وصلته."
            columns={[
              { key: "t", label: "السابقة", render: (r) => <div className="flex flex-col"><span>{r.title}</span><span className="text-12 text-ink-muted"><Num>{fmt.dateTime(r.created_at)}</Num></span></div> },
              { key: "a", label: "إلى", render: (r) => AUDIENCE[r.audience] ?? r.audience },
              { key: "r", label: "وصلت", numeric: true, render: (r) => <Num>{fmt.int(r.recipients)}</Num> },
            ]} />
        </section>
      </div>

      <ConfirmDialog open={ask} tone="warning" icon="megaphone" loading={act.busy}
        title={`إرسال إلى كل ${AUDIENCE[audience]}؟`} body={<><b>{title.trim()}</b><br />تصل الرسالة فوراً ولا تُسحب بعد الإرسال.</>}
        confirmLabel="إرسال الآن" onConfirm={send} onCancel={() => setAsk(false)} />
    </div>
  );
}
