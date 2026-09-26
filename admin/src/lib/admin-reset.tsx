/** إعادة تعيين كلمة مرور (م-20) — للمالك وحده: تأكيد، ثم الكلمة المؤقتة تُعرض مرة واحدة ولا تُحفظ في الواجهة. */
import { useState } from "react";

import { Button, ConfirmDialog, Dialog, Icon, useAction } from "@ui/kit";
import type { TempPasswordOut } from "@/api/types";

/** زر «إعادة تعيين» لمستخدم واحد. الطلب نفسه يمرّره المستدعي (reset) ليبقى مسار السلك في الشاشة. */
export function ResetPasswordButton({ name, reset, onDone }: {
  name: string; reset: () => Promise<TempPasswordOut>; onDone?: () => void;
}) {
  const act = useAction();
  const [ask, setAsk] = useState(false);
  const [temp, setTemp] = useState<string | null>(null);

  async function go() {
    const v = await act.run(reset);
    setAsk(false);
    if (v) {
      setTemp(v.temporary_password);
      onDone?.();
    }
  }

  return (
    <>
      <Button size="sm" variant="secondary" icon="refresh-cw" onClick={() => setAsk(true)}>إعادة تعيين</Button>
      <ConfirmDialog open={ask} tone="warning" icon="shield-check" loading={act.busy}
        title={`إعادة تعيين كلمة مرور ${name}؟`}
        body="تُغلق جلساته القائمة، وتظهر لك كلمة مؤقتة مرة واحدة، ويُلزم بوضع كلمة جديدة عند أول دخول. تُسجَّل في سجل التدقيق."
        confirmLabel="إعادة تعيين" onConfirm={go} onCancel={() => setAsk(false)} />
      <Dialog open={temp != null} onClose={() => setTemp(null)} label="كلمة المرور المؤقتة">
        <div className="md-dialog-ico md-tone-bg-primary"><Icon name="shield-check" size={22} /></div>
        <div className="md-dialog-title">كلمة المرور المؤقتة لـ{name}</div>
        <bdi className="md-num text-26 font-bold tracking-widest bg-primary-tint px-4 py-2.5 rounded-md select-all" dir="ltr">{temp}</bdi>
        <div className="md-dialog-body">تظهر مرة واحدة فقط. أملِها له هاتفياً؛ سيُطلب منه وضع كلمة جديدة عند الدخول. جلساته القائمة أُغلقت.</div>
        <div className="md-dialog-actions"><Button block onClick={() => setTemp(null)}>تم، أغلق</Button></div>
      </Dialog>
    </>
  );
}
