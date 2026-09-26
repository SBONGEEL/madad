-- نزول 0003. قيم التعداد (owner_equity, capital) لا تُحذف في PostgreSQL وتبقى بلا استعمال.
SET search_path = madad, public;
DROP TRIGGER c_owner_funded_intake ON stock_movements;
DROP FUNCTION trg_owner_funded_intake();
ALTER TABLE stock_movements DROP CONSTRAINT owner_funding_is_intake;
ALTER TABLE stock_movements DROP COLUMN funded_by_owner;
DROP TABLE owner_capital_entries;
DROP FUNCTION trg_capital_post();
DROP FUNCTION require_owner();
DROP TYPE capital_kind;
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
        PERFORM ledger_post('stock_intake', wh_city, 'إدخال مخزون',
            jsonb_build_array(
                jsonb_build_array(ledger_account('warehouse_inventory', wh_city, NEW.warehouse_id), value),
                jsonb_build_array(CASE WHEN NEW.supplier_id IS NOT NULL
                                       THEN ledger_account('supplier_payable', wh_city, NEW.supplier_id)
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
