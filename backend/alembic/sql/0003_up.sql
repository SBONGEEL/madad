-- ═══════════════════════════════════════════════════════════════════════════
-- مَدَد — الترحيلة 0003: رأس مال المالك (2026-09-26)
-- حساب owner_equity في الدفتر نفسه، ومصدر حركات للنقد الافتتاحي والضخّ اللاحق،
-- والمخزون الافتتاحي إدخالٌ ممولٌ من رأس المال فتبقى الكمية والقيمة متطابقتين.
-- سحب المالك من الأرباح لم يُقرَّر (م-21) ولا يُبنى هنا.
-- ═══════════════════════════════════════════════════════════════════════════
SET search_path = madad, public;
SELECT set_config('madad.actor_role', 'system', true);

-- قيم تعداد جديدة: تُستعمل وقت التشغيل فقط (لا داخل هذه الحركة).
ALTER TYPE ledger_account_kind ADD VALUE IF NOT EXISTS 'owner_equity';
ALTER TYPE ledger_txn_kind ADD VALUE IF NOT EXISTS 'capital';

CREATE TYPE capital_kind AS ENUM ('opening_cash', 'injection');

-- مصدر حركة لا رصيد: الرصيد في الدفتر وحده.
CREATE TABLE owner_capital_entries (
    id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    city        text NOT NULL REFERENCES cities(code),
    kind        capital_kind NOT NULL,
    amount      money_lyd NOT NULL CHECK (amount > 0),
    occurred_on date NOT NULL,
    note        text NOT NULL CHECK (length(btrim(note)) > 0),
    created_by  bigint NOT NULL REFERENCES app_users(id),
    created_at  timestamptz NOT NULL DEFAULT now()
);
-- النقد الافتتاحي مرة واحدة لكل مدينة
CREATE UNIQUE INDEX one_opening_cash_per_city ON owner_capital_entries (city) WHERE kind = 'opening_cash';

-- المالك وحده يسجّل رأس المال (لا مشرف ولو بصلاحية المال).
CREATE FUNCTION require_owner() RETURNS void AS $$
BEGIN
    IF writer_role() IN ('trigger', 'system') THEN RETURN; END IF;
    IF actor_role() <> 'admin' OR NOT EXISTS (SELECT 1 FROM admin_members WHERE user_id = actor_id() AND role = 'owner') THEN
        RAISE EXCEPTION 'forbidden_owner_only' USING ERRCODE = 'insufficient_privilege';
    END IF;
END $$ LANGUAGE plpgsql;

CREATE FUNCTION trg_capital_post() RETURNS trigger AS $$
BEGIN
    PERFORM require_owner();
    PERFORM ledger_post('capital', NEW.city,
        CASE NEW.kind WHEN 'opening_cash' THEN 'نقد افتتاحي للخزينة' ELSE 'ضخّ من المالك' END || ' — ' || NEW.note,
        jsonb_build_array(
            jsonb_build_array(ledger_account('treasury', NEW.city), NEW.amount),
            jsonb_build_array(ledger_account('owner_equity', NEW.city), -NEW.amount)),
        p_ref_table => 'owner_capital_entries', p_ref_id => NEW.id);
    RETURN NULL;
END $$ LANGUAGE plpgsql;
CREATE TRIGGER capital_post AFTER INSERT ON owner_capital_entries FOR EACH ROW EXECUTE FUNCTION trg_capital_post();
CREATE TRIGGER z_append_only BEFORE UPDATE OR DELETE ON owner_capital_entries FOR EACH ROW EXECUTE FUNCTION guard_append_only();
CREATE TRIGGER zz_audit AFTER INSERT ON owner_capital_entries FOR EACH ROW EXECUTE FUNCTION trg_audit();

-- المخزون الافتتاحي: إدخال مخزن تموّله حقوق المالك (لا مورد ولا خزينة).
ALTER TABLE stock_movements ADD COLUMN funded_by_owner boolean NOT NULL DEFAULT false;
ALTER TABLE stock_movements ADD CONSTRAINT owner_funding_is_intake
    CHECK (NOT funded_by_owner OR (kind = 'intake' AND supplier_id IS NULL));

CREATE FUNCTION trg_owner_funded_intake() RETURNS trigger AS $$
BEGIN
    IF NEW.funded_by_owner THEN PERFORM require_owner(); END IF;
    RETURN NEW;
END $$ LANGUAGE plpgsql;
CREATE TRIGGER c_owner_funded_intake BEFORE INSERT ON stock_movements FOR EACH ROW EXECUTE FUNCTION trg_owner_funded_intake();

-- إدخال المخزون: الطرف الدائن مورد أو رأس المال أو الخزينة
CREATE OR REPLACE FUNCTION trg_stock_movement_apply() RETURNS trigger AS $$
DECLARE ws warehouse_stock; new_on_hand numeric; new_avg numeric; wh_city text; value numeric;
        src stock_movements;
BEGIN
    INSERT INTO warehouse_stock (warehouse_id, catalog_item_id) VALUES (NEW.warehouse_id, NEW.catalog_item_id)
    ON CONFLICT DO NOTHING;
    SELECT * INTO ws FROM warehouse_stock
     WHERE warehouse_id = NEW.warehouse_id AND catalog_item_id = NEW.catalog_item_id FOR UPDATE;
    new_on_hand := ws.on_hand + NEW.qty_delta;
    IF new_on_hand < 0 THEN
        RAISE EXCEPTION 'stock_negative: warehouse % item %', NEW.warehouse_id, NEW.catalog_item_id
            USING ERRCODE = 'check_violation';
    END IF;
    -- متوسط مرجّح عند كل دخول بتكلفة (إدخال أو تحويل وارد) — م-12
    new_avg := CASE WHEN NEW.kind IN ('intake', 'transfer_in') AND new_on_hand > 0
                    THEN (ws.on_hand * ws.avg_cost + NEW.qty_delta * NEW.unit_cost) / new_on_hand
                    ELSE ws.avg_cost END;
    UPDATE warehouse_stock SET on_hand = new_on_hand, avg_cost = new_avg
     WHERE warehouse_id = NEW.warehouse_id AND catalog_item_id = NEW.catalog_item_id;

    SELECT city INTO wh_city FROM warehouses WHERE id = NEW.warehouse_id;
    IF NEW.kind = 'intake' THEN
        value := round(NEW.qty_delta * NEW.unit_cost, 3);
        PERFORM ledger_post('stock_intake', wh_city, CASE WHEN NEW.funded_by_owner THEN 'مخزون افتتاحي من رأس المال' ELSE 'إدخال مخزون' END,
            jsonb_build_array(
                jsonb_build_array(ledger_account('warehouse_inventory', wh_city, NEW.warehouse_id), value),
                jsonb_build_array(CASE WHEN NEW.supplier_id IS NOT NULL
                                       THEN ledger_account('supplier_payable', wh_city, NEW.supplier_id)
                                       WHEN NEW.funded_by_owner
                                       THEN ledger_account('owner_equity', wh_city)
                                       ELSE ledger_account('treasury', wh_city) END, -value)),
            p_ref_table => 'stock_movements', p_ref_id => NEW.id);
    ELSIF NEW.kind = 'count_adjust' THEN
        value := round(NEW.qty_delta * NEW.unit_cost, 3);
        IF value <> 0 THEN
            PERFORM ledger_post('stock_adjustment', wh_city, 'تسوية جرد',
                jsonb_build_array(
                    jsonb_build_array(ledger_account('warehouse_inventory', wh_city, NEW.warehouse_id), value),
                    jsonb_build_array(ledger_account('operating_expense', wh_city), -value)),
                p_ref_table => 'stock_movements', p_ref_id => NEW.id);
        END IF;
    ELSIF NEW.kind = 'transfer_in' THEN
        SELECT * INTO src FROM stock_movements WHERE transfer_id = NEW.transfer_id AND kind = 'transfer_out';
        value := round(NEW.qty_delta * NEW.unit_cost, 3);
        IF value <> 0 THEN
            PERFORM ledger_post('stock_adjustment', wh_city, 'تحويل بين المخازن',
                jsonb_build_array(
                    jsonb_build_array(ledger_account('warehouse_inventory', wh_city, NEW.warehouse_id), value),
                    jsonb_build_array(ledger_account('warehouse_inventory', wh_city, src.warehouse_id), -value)),
                p_ref_table => 'stock_movements', p_ref_id => NEW.id);
        END IF;
    END IF;
    PERFORM refresh_item_availability(NEW.catalog_item_id);
    RETURN NULL;
END $$ LANGUAGE plpgsql;
