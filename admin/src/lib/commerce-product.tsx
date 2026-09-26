/** اختيار صنف من القاموس بالاسم (GET /api/admin/products) — بدل كتابة رقمه. */
import { useEffect, useState } from "react";

import { qs } from "@ui/client";
import { cx, Num, StatusBadge, TextField } from "@ui/kit";
import { api } from "@/api/client";
import type { ProductOut } from "@/api/types";

export function ProductPicker({ value, onPick, label, placeholder }: {
  value: ProductOut | null; onPick: (p: ProductOut | null) => void; label?: string; placeholder?: string;
}) {
  const [q, setQ] = useState("");
  const [rows, setRows] = useState<ProductOut[]>([]);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    const term = q.trim();
    if (term.length < 2) {
      setRows([]);
      return;
    }
    let live = true;
    const t = setTimeout(() => {
      setBusy(true);
      api.get<ProductOut[]>(`/api/admin/products${qs({ q: term })}`)
        .then((r) => live && setRows(r), () => live && setRows([]))
        .finally(() => live && setBusy(false));
    }, 300);
    return () => { live = false; clearTimeout(t); };
  }, [q]);

  if (value) {
    return (
      <div className="md-field">
        {label ? <span className="md-field-label">{label}</span> : null}
        <div className="md-row-link justify-between">
          <span className="flex flex-col"><b>{value.name_ar}</b><span className="text-13 text-ink-muted">{value.category} · <Num>{value.offers}</Num> عرض</span></span>
          <button type="button" className="md-link text-13" onClick={() => { onPick(null); setQ(""); }}>تغيير</button>
        </div>
      </div>
    );
  }
  return (
    <div className="flex flex-col gap-1.5">
      <TextField label={label} value={q} onChange={setQ} icon="search" placeholder={placeholder ?? "ابحث باسم الصنف في القاموس"}
        hint={q.trim().length >= 2 && !busy && !rows.length ? "لا صنف بهذا الاسم في القاموس" : undefined} />
      {rows.length ? (
        <div className="flex flex-col gap-1" role="listbox">
          {rows.map((p) => (
            <button key={p.id} type="button" role="option" aria-selected={false} className={cx("md-row-link justify-between cursor-pointer border-0 text-start")} onClick={() => onPick(p)}>
              <span className="flex flex-col"><b className="text-14">{p.name_ar}</b><span className="text-12 text-ink-muted">{p.category}</span></span>
              <span className="flex gap-1.5 items-center">
                <span className="text-12 text-ink-muted"><Num>{p.offers}</Num> عرض</span>
                {p.in_catalog ? <StatusBadge tone="success">في الكتالوج</StatusBadge> : null}
              </span>
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}
