/** المخازن: الموجود والمحجوز والمتاح لكل صنف، وقيمة المخزون بمتوسط التكلفة (تكلفة: تُحجب بلا «التكاليف»)،
 *  والإدخال (يُقيَّد على مستحقات المورد أو من الخزينة) والجرد والتحويل. الحركات تكتبها القاعدة وقيودها. */
import { useEffect, useState } from "react";

import * as fmt from "@ui/fmt";
import { qs } from "@ui/client";
import { Button, ConfirmDialog, DataTable, Dialog, Money, Num, PageHead, Section, Select, StatCard, StatusBadge, TextField,
  useAction, useLoad, type Column } from "@ui/kit";
import { api } from "@/api/client";
import type { CatalogRowOut, MovementIn, StockOut, SupplierRowOut, WarehouseIn, WarehouseOut } from "@/api/types";
import { isQty, qtyDiff, unitLabel } from "@/lib/commerce-shared";
import { useSession } from "@/session";

type Kind = "intake" | "count_adjust" | "transfer";

function stockBadge(s: StockOut) {
  const a = Number(s.available), r = Number(s.reserved);
  if (Number(s.on_hand) <= 0 || a <= 0) return <StatusBadge tone="neutral">نافد</StatusBadge>;
  if (r > 0 && a <= r) return <StatusBadge tone="warning">قارب النفاد</StatusBadge>;
  return <StatusBadge tone="success">متوفر</StatusBadge>;
}

export function Warehouses() {
  const { can } = useSession();
  const whs = useLoad(() => api.get<WarehouseOut[]>(`/api/admin/warehouses`));
  const all = useLoad(() => api.get<StockOut[]>(`/api/admin/stock`));
  const [filter, setFilter] = useState("");
  const shown = useLoad(() => api.get<StockOut[]>(`/api/admin/stock${qs({ warehouse_id: filter })}`), [filter]);
  const catalog = useLoad(() => (can("catalog") ? api.get<CatalogRowOut[]>(`/api/admin/catalog`) : Promise.resolve(null)), []);
  const sups = useLoad(() => (can("catalog") ? api.get<SupplierRowOut[]>(`/api/admin/suppliers${qs({ status: "approved" })}`) : Promise.resolve(null)), []);
  const act = useAction();

  const [kind, setKind] = useState<Kind>("intake");
  const [wh, setWh] = useState("");
  const [to, setTo] = useState("");
  const [item, setItem] = useState("");
  const [qty, setQty] = useState("");
  const [cost, setCost] = useState("");
  const [sup, setSup] = useState("");
  const [note, setNote] = useState("");
  const [confirming, setConfirming] = useState(false);
  const [adding, setAdding] = useState(false);

  const warehouses = whs.data ?? [];
  const stock = all.data ?? [];
  const seesCosts = stock.some((s) => s.value !== undefined) || (can("costs_view") && !stock.length);

  useEffect(() => {
    if (!wh && warehouses[0]) setWh(String(warehouses[0].id));
  }, [warehouses, wh]);

  const whStock = stock.filter((s) => String(s.warehouse_id) === wh);
  const itemOptions = kind === "intake"
    ? (catalog.data ?? []).map((c) => ({ value: String(c.id), label: `${c.name_ar} — ${unitLabel(c.unit, c.unit_size)}` }))
      .concat(catalog.data ? [] : uniqueItems(stock))
    : whStock.map((s) => ({ value: String(s.item_id), label: s.item }));
  const line = whStock.find((s) => String(s.item_id) === item);
  const whName = warehouses.find((w) => String(w.id) === wh)?.name ?? "";
  const supName = (sups.data ?? []).find((s) => String(s.id) === sup)?.name;

  const valid = !!wh && !!item && (kind === "count_adjust" ? isQty(qty) : isQty(qty) && Number(qty) > 0)
    && (kind !== "intake" || fmt.isMoney(cost) && Number(cost) > 0)
    && (kind !== "transfer" || (!!to && to !== wh));
  const delta = kind === "count_adjust" && line && isQty(qty) ? qtyDiff(qty, line.on_hand) : null;

  function pick(k: Kind) {
    setKind(k);
    setItem("");
    setQty("");
    setConfirming(false);
  }

  async function submit() {
    const body: MovementIn = { kind, item_id: Number(item), qty: kind === "count_adjust" ? (delta ?? "0") : qty.trim(), note: note.trim() || null };
    if (kind === "intake") {
      body.unit_cost = cost.trim();
      body.supplier_id = sup ? Number(sup) : null;
    }
    if (kind === "transfer") body.to_warehouse_id = Number(to);
    const out = await act.run(() => api.post<StockOut[]>(`/api/admin/warehouses/${wh}/movements`, body),
      kind === "intake" ? "سُجّل الإدخال" : kind === "transfer" ? "سُجّل التحويل" : "سُجّل الجرد");
    if (out) {
      all.set(out);
      shown.reload();
      whs.reload();
      setConfirming(false);
      setQty(""); setCost(""); setNote("");
    }
  }

  const columns: Array<Column<StockOut>> = [
    { key: "item", label: "الصنف" },
    { key: "warehouse", label: "المخزن" },
    { key: "on_hand", label: "الموجود", numeric: true, render: (s) => <Num>{fmt.qty(s.on_hand)}</Num> },
    { key: "reserved", label: "المحجوز", numeric: true, render: (s) => <Num>{fmt.qty(s.reserved)}</Num> },
    { key: "available", label: "المتاح", numeric: true, render: (s) => <Num>{fmt.qty(s.available)}</Num> },
    ...(seesCosts ? [{ key: "avg_cost", label: "متوسط التكلفة", money: true, render: (s: StockOut) => (s.avg_cost != null ? <Money value={s.avg_cost} /> : "—") }] : []),
    { key: "status", label: "الحالة", render: stockBadge },
  ];

  const reservedValue = stock.reduce((t, s) => t + Number(s.reserved) * Number(s.avg_cost ?? 0), 0);
  const reservedLines = stock.filter((s) => Number(s.reserved) > 0).length;
  const deltaNum = delta != null ? Number(delta) : 0;
  const total = kind === "intake" && isQty(qty) && fmt.isMoney(cost) ? Math.round(Number(qty) * Number(cost) * 1000) / 1000 : 0;

  return (
    <div className="md-page">
      <PageHead title="المخازن" actions={<>
        <Button icon="plus" variant={kind === "intake" ? "primary" : "secondary"} onClick={() => pick("intake")}>إدخال مخزون</Button>
        <Button icon="clipboard-list" variant={kind === "count_adjust" ? "primary" : "secondary"} onClick={() => pick("count_adjust")}>جرد</Button>
        <Button icon="repeat" variant={kind === "transfer" ? "primary" : "secondary"} onClick={() => pick("transfer")}>تحويل</Button>
        <Button icon="warehouse" variant="ghost" onClick={() => setAdding(true)}>مخزن جديد</Button>
      </>} />

      {warehouses.length ? (
        <div className="grid grid-cols-3 gap-4">
          {warehouses.map((w) => {
            const rows = stock.filter((s) => s.warehouse_id === w.id);
            return seesCosts
              ? <StatCard key={w.id} label={`${w.name} — قيمة المخزون`} value={String(rows.reduce((t, s) => t + Number(s.value ?? 0), 0))} money icon="warehouse"
                  note={`${w.items} صنفاً${w.active ? "" : " · موقوف"}`} />
              : <StatCard key={w.id} label={`${w.name} — الأصناف`} value={fmt.int(w.items)} icon="warehouse" note={w.active ? undefined : "موقوف"} />;
          })}
          {seesCosts
            ? <StatCard label="محجوز لطلبيات لم تُجمع" value={String(reservedValue)} money icon="package" />
            : <StatCard label="محجوز لطلبيات لم تُجمع" value={fmt.int(reservedLines)} unit="صنفاً" icon="package" />}
        </div>
      ) : null}

      <div className="flex justify-between items-center gap-3">
        <h2 className="md-sec-title-lg">المخزون</h2>
        <div className="w-field-md">
          <Select value={filter} onChange={setFilter} options={[{ value: "", label: "كل المخازن" }, ...warehouses.map((w) => ({ value: String(w.id), label: w.name }))]} />
        </div>
      </div>
      <DataTable<StockOut> rows={shown.data} loading={shown.loading} error={shown.error} onRetry={shown.reload}
        rowKey={(s) => `${s.warehouse_id}-${s.item_id}`} columns={columns}
        rowTone={(s) => Number(s.reserved) > 0 && Number(s.available) <= Number(s.reserved) && Number(s.available) > 0 && "warning"}
        emptyIcon="warehouse" emptyTitle="المخزن فارغ" emptyBody="سجّل أول إدخال ليُقدَّم المخزن على الموردين في المخطط." />

      <Section title={kind === "intake" ? "إدخال مخزون" : kind === "count_adjust" ? "جرد" : "تحويل بين المخازن"}>
        <div className="grid grid-cols-4 gap-3 items-end">
          <Select label={kind === "transfer" ? "من المخزن" : "المخزن"} value={wh} onChange={(v) => { setWh(v); if (kind !== "intake") setItem(""); }}
            options={[{ value: "", label: "اختر المخزن" }, ...warehouses.map((w) => ({ value: String(w.id), label: w.name }))]} />
          {kind === "transfer" ? (
            <Select label="إلى المخزن" value={to} onChange={setTo}
              options={[{ value: "", label: "اختر المخزن" }, ...warehouses.filter((w) => String(w.id) !== wh).map((w) => ({ value: String(w.id), label: w.name }))]} />
          ) : null}
          <Select label="الصنف" value={item} onChange={setItem} options={[{ value: "", label: itemOptions.length ? "اختر الصنف" : "لا أصناف" }, ...itemOptions]} />
          <TextField label={kind === "count_adjust" ? "الكمية بعد الجرد" : "الكمية"} value={qty} onChange={setQty} numeric
            hint={line && kind !== "intake" ? `الموجود ${fmt.qty(line.on_hand)} · المحجوز ${fmt.qty(line.reserved)}` : undefined}
            error={qty && !isQty(qty) ? "رقم بثلاث خانات على الأكثر" : null} />
          {kind === "intake" ? (
            <>
              <TextField label="تكلفة الوحدة" value={cost} onChange={setCost} numeric suffix="د.ل"
                error={cost && !fmt.isMoney(cost) ? "مبلغ بثلاث خانات على الأكثر" : null} />
              {sups.data ? (
                <Select label="المصدر" value={sup} onChange={setSup}
                  options={[{ value: "", label: "بلا مورد — من الخزينة" }, ...sups.data.map((s) => ({ value: String(s.id), label: s.name }))]} />
              ) : null}
            </>
          ) : null}
          <TextField label={kind === "count_adjust" ? "سبب الفرق" : "ملاحظة"} value={note} onChange={setNote} />
          <Button icon="check" block disabled={!valid || (kind === "count_adjust" && (!delta || deltaNum === 0))} loading={act.busy}
            onClick={() => setConfirming(true)}>
            {kind === "intake" ? "تسجيل الإدخال" : kind === "count_adjust" ? "تسجيل الجرد" : "تسجيل التحويل"}
          </Button>
          <span className="col-span-4 text-13 text-ink-muted">
            {kind === "intake"
              ? <>{supName ? `المصدر: ${supName} (يُقيَّد على مستحقاته).` : "بلا مورد: تُدفع قيمته من الخزينة."} التكلفة الجديدة تدخل المتوسط المرجّح.</>
              : kind === "count_adjust"
                ? <>يُسجَّل الفرق بين الجرد والموجود{delta != null ? <> (<Num>{fmt.qty(delta)}</Num>)</> : null}. لا يقل الجرد عن المحجوز لطلبيات لم تُجمع.</>
                : "يُنقل الصنف بمتوسط تكلفته في مخزن المصدر."}
          </span>
        </div>
      </Section>

      <ConfirmDialog open={confirming} onCancel={() => setConfirming(false)} onConfirm={submit} loading={act.busy}
        tone={kind === "count_adjust" && deltaNum < 0 ? "warning" : "primary"}
        title={kind === "intake" ? <>تسجيل إدخال بقيمة <Money value={total} />؟</>
          : kind === "count_adjust" ? <>تسجيل جرد بفرق <Num>{fmt.qty(delta)}</Num>؟</>
          : <>تحويل <Num>{fmt.qty(qty)}</Num> إلى {warehouses.find((w) => String(w.id) === to)?.name ?? ""}؟</>}
        body={kind === "intake"
          ? `${whName}: ${fmt.qty(qty)} × ${fmt.money(cost)} د.ل — ${supName ? `يُقيَّد على مستحقات ${supName}` : "من الخزينة"}.`
          : kind === "count_adjust" ? `${whName}: الموجود ${fmt.qty(line?.on_hand)} يصير ${fmt.qty(qty)}.`
          : `من ${whName}.`}
        confirmLabel="تسجيل" />

      <NewWarehouseDialog open={adding} onClose={() => setAdding(false)} onCreated={() => { setAdding(false); whs.reload(); }} />
    </div>
  );
}

function uniqueItems(stock: StockOut[]): Array<{ value: string; label: string }> {
  const seen = new Map<number, string>();
  stock.forEach((s) => seen.set(s.item_id, s.item));
  return [...seen].map(([id, name]) => ({ value: String(id), label: name }));
}

function NewWarehouseDialog({ open, onClose, onCreated }: { open: boolean; onClose: () => void; onCreated: () => void }) {
  const act = useAction();
  const [name, setName] = useState("");
  const [addr, setAddr] = useState("");
  const [lat, setLat] = useState("");
  const [lng, setLng] = useState("");
  const coord = (s: string) => /^-?\d{1,3}(\.\d{1,7})?$/.test(s.trim());
  const valid = name.trim() && addr.trim() && coord(lat) && coord(lng);

  async function submit() {
    const body: WarehouseIn = { name: name.trim(), address_text: addr.trim(), lat: lat.trim(), lng: lng.trim() };
    const r = await act.run(() => api.post<WarehouseOut>(`/api/admin/warehouses`, body), "أُضيف المخزن");
    if (r) {
      setName(""); setAddr(""); setLat(""); setLng("");
      onCreated();
    }
  }

  return (
    <Dialog open={open} onClose={onClose} label="مخزن جديد">
      <div className="md-dialog-title">مخزن جديد</div>
      <div className="flex flex-col gap-3">
        <TextField label="اسم المخزن" value={name} onChange={setName} required />
        <TextField label="العنوان" value={addr} onChange={setAddr} required />
        <div className="grid grid-cols-2 gap-3">
          <TextField label="خط العرض" value={lat} onChange={setLat} numeric placeholder="32.8872" required />
          <TextField label="خط الطول" value={lng} onChange={setLng} numeric placeholder="13.1913" required />
        </div>
      </div>
      <div className="md-dialog-actions">
        <Button block icon="check" loading={act.busy} disabled={!valid} onClick={submit}>إضافة</Button>
        <Button variant="ghost" block onClick={onClose}>إلغاء</Button>
      </div>
    </Dialog>
  );
}
