-- نزول 0005. قيم التعداد المضافة (goods_in_custody, custody, custody_in) تبقى بلا استعمال.
-- الدوال المستبدلة تُستعاد من تعريفها السابق (مولَّد بـgen_down5.py).
SET search_path = madad, public;
SELECT set_config('madad.actor_role', 'system', true);
DELETE FROM derived_fields WHERE (table_name, column_name) IN (
 ('orders','fee_conflict_rule'),('owner_withdrawals','exceeds_profit'),('owner_withdrawals','profit_at_time'),
 ('driver_custody','decided_by'),('driver_custody','decided_at'));
DROP VIEW v_driver_custody;
DROP TRIGGER b_settlement_custody ON cash_handovers;
DROP FUNCTION trg_settlement_needs_clear_custody();
DROP TRIGGER custody_in_post ON stock_movements;
DROP FUNCTION trg_custody_in_post();
DROP TRIGGER a_custody_in_guard ON stock_movements;
DROP FUNCTION trg_custody_in_guard();
ALTER TABLE stock_movements DROP CONSTRAINT custody_in_has_custody;
ALTER TABLE stock_movements DROP COLUMN custody_id;
DROP TRIGGER dispute_links_custody ON disputes;
DROP FUNCTION trg_dispute_links_custody();
ALTER TABLE pickup_stops DROP CONSTRAINT custody_stop_has_no_other_source;
ALTER TABLE pickup_stops DROP COLUMN custody_id;
CREATE OR REPLACE FUNCTION order_fee(p_order bigint) RETURNS numeric AS $$
DECLARE o orders; cs city_settings; z_fee numeric; a_fee numeric;
BEGIN
    SELECT * INTO o FROM orders WHERE id = p_order;
    SELECT * INTO cs FROM city_settings WHERE city = o.city;
    IF cs.fee_mode IS NULL THEN PERFORM setting_missing(o.city, 'fee_mode'); END IF;
    IF cs.free_delivery_threshold IS NOT NULL AND o.subtotal >= cs.free_delivery_threshold THEN
        RETURN 0;
    END IF;
    IF cs.fee_mode = 'flat' THEN
        RETURN cs.delivery_fee_flat;
    END IF;
    IF o.zone_id IS NOT NULL THEN
        SELECT z.fee INTO z_fee FROM delivery_zones z WHERE z.id = o.zone_id AND z.active;
        IF z_fee IS NULL THEN
            RAISE EXCEPTION 'zone_inactive: %', o.zone_id USING ERRCODE = 'check_violation';
        END IF;
    END IF;
    IF o.area_id IS NOT NULL THEN
        SELECT a.fee INTO a_fee FROM delivery_areas a WHERE a.id = o.area_id AND a.active;
    END IF;
    IF z_fee IS NULL AND a_fee IS NULL THEN
        RAISE EXCEPTION 'zone_missing: order %', p_order USING ERRCODE = 'check_violation';
    END IF;
    IF z_fee IS NOT NULL AND a_fee IS NOT NULL AND z_fee <> a_fee THEN
        RAISE EXCEPTION 'zone_conflict: neighborhood fee % vs drawn area fee % (owner decision M-25)', z_fee, a_fee
            USING ERRCODE = 'check_violation';
    END IF;
    RETURN coalesce(z_fee, a_fee);
END $$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION item_cost_ref(p_item bigint) RETURNS numeric AS $$
    SELECT greatest(
        (SELECT max(o.purchase_price) FROM catalog_item_sources cs
           JOIN supplier_offers o ON o.id = cs.offer_id JOIN suppliers s ON s.id = o.supplier_id
          WHERE cs.catalog_item_id = p_item AND o.status = 'active' AND s.status = 'approved'),
        (SELECT max(ws.avg_cost) FROM warehouse_stock ws JOIN warehouses w ON w.id = ws.warehouse_id
           JOIN catalog_items ci ON ci.id = ws.catalog_item_id
          WHERE ws.catalog_item_id = p_item AND w.active AND w.city = ci.city AND ws.on_hand > 0))
$$ LANGUAGE sql STABLE;

CREATE OR REPLACE FUNCTION trg_stock_movement_before() RETURNS trigger AS $$
DECLARE src stock_movements; src_city text; dst_city text; wh_city text; avg numeric; fifo numeric;
        meth cogs_method;
BEGIN
    IF writer_role() <> 'trigger' THEN
        PERFORM require_admin('warehouses');
        IF NEW.kind = 'pickup' THEN
            RAISE EXCEPTION 'derived_field_write: stock_movements.pickup' USING ERRCODE = 'restrict_violation';
        END IF;
        IF NEW.kind <> 'intake' AND NEW.unit_cost IS NOT NULL THEN
            RAISE EXCEPTION 'derived_field_write: stock_movements.unit_cost' USING ERRCODE = 'restrict_violation';
        END IF;
        IF NEW.cost_method IS NOT NULL THEN
            RAISE EXCEPTION 'derived_field_write: stock_movements.cost_method' USING ERRCODE = 'restrict_violation';
        END IF;
    END IF;
    NEW.actor_role := actor_role();
    NEW.actor_id := actor_id();
    IF NEW.kind IN ('transfer_out', 'count_adjust', 'pickup') THEN
        avg := coalesce((SELECT avg_cost FROM warehouse_stock
                          WHERE warehouse_id = NEW.warehouse_id AND catalog_item_id = NEW.catalog_item_id), 0);
        IF NEW.qty_delta < 0 THEN
            -- م-12: الحركة لطلبية تأخذ طريقة الطلبية (لقطة placed)؛ غيرها الطريقة السارية الآن
            IF NEW.kind = 'pickup' THEN
                SELECT o.cogs_method INTO meth FROM pickup_stop_lines l
                  JOIN pickup_stops s ON s.id = l.stop_id JOIN orders o ON o.id = s.order_id
                 WHERE l.id = NEW.stop_line_id;
            END IF;
            SELECT city INTO wh_city FROM warehouses WHERE id = NEW.warehouse_id;
            NEW.cost_method := coalesce(meth, current_cogs_method(wh_city));
            fifo := fifo_cost(NEW.warehouse_id, NEW.catalog_item_id, -NEW.qty_delta);
            NEW.unit_cost := CASE WHEN NEW.cost_method = 'fifo' THEN coalesce(fifo, avg) ELSE avg END;
        ELSE
            NEW.unit_cost := avg;   -- جرد بالزيادة يدخل بالمتوسط
        END IF;
    ELSIF NEW.kind = 'transfer_in' THEN
        SELECT * INTO src FROM stock_movements WHERE transfer_id = NEW.transfer_id AND kind = 'transfer_out';
        IF src IS NULL OR src.catalog_item_id <> NEW.catalog_item_id OR src.qty_delta <> -NEW.qty_delta
           OR src.warehouse_id = NEW.warehouse_id THEN
            RAISE EXCEPTION 'transfer_mismatch: %', NEW.transfer_id USING ERRCODE = 'check_violation';
        END IF;
        SELECT city INTO src_city FROM warehouses WHERE id = src.warehouse_id;
        SELECT city INTO dst_city FROM warehouses WHERE id = NEW.warehouse_id;
        IF src_city <> dst_city THEN
            RAISE EXCEPTION 'transfer_city_mismatch' USING ERRCODE = 'check_violation';
        END IF;
        NEW.unit_cost := src.unit_cost;
    END IF;
    RETURN NEW;
END $$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION trg_stock_movement_apply() RETURNS trigger AS $$
DECLARE ws warehouse_stock; new_on_hand numeric; new_avg numeric; wh_city text; value numeric;
        src stock_movements; l record; need numeric; take numeric;
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
    new_avg := CASE WHEN NEW.kind IN ('intake', 'transfer_in') AND new_on_hand > 0
                    THEN (ws.on_hand * ws.avg_cost + NEW.qty_delta * NEW.unit_cost) / new_on_hand
                    ELSE ws.avg_cost END;
    UPDATE warehouse_stock SET on_hand = new_on_hand, avg_cost = new_avg
     WHERE warehouse_id = NEW.warehouse_id AND catalog_item_id = NEW.catalog_item_id;

    -- الطبقات: الداخل طبقة، والخارج يستهلك الأقدم
    IF NEW.qty_delta > 0 THEN
        INSERT INTO stock_layers (warehouse_id, catalog_item_id, movement_id, unit_cost, qty_in, qty_left)
        VALUES (NEW.warehouse_id, NEW.catalog_item_id, NEW.id, NEW.unit_cost, NEW.qty_delta, NEW.qty_delta);
    ELSE
        need := -NEW.qty_delta;
        FOR l IN SELECT * FROM stock_layers WHERE warehouse_id = NEW.warehouse_id
                   AND catalog_item_id = NEW.catalog_item_id AND qty_left > 0 ORDER BY id FOR UPDATE LOOP
            EXIT WHEN need <= 0;
            take := least(need, l.qty_left);
            UPDATE stock_layers SET qty_left = qty_left - take WHERE id = l.id;
            need := need - take;
        END LOOP;
    END IF;
    -- السحب لطلبية: التكلفة الفعلية تحلّ محل تقدير المخطط
    IF NEW.kind = 'pickup' THEN
        UPDATE pickup_line_costs SET unit_cost = NEW.unit_cost WHERE stop_line_id = NEW.stop_line_id;
    END IF;

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
    PERFORM refresh_cost_guard(NEW.catalog_item_id);
    RETURN NULL;
END $$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION post_cancellation(p_order bigint) RETURNS void AS $$
DECLARE o orders; cost record; lines jsonb := '[]'::jsonb; sold numeric;
BEGIN
    SELECT * INTO o FROM orders WHERE id = p_order;
    FOR cost IN
        SELECT s.source, s.supplier_id, s.warehouse_id, sum(round(l.collected_qty * c.unit_cost, 3)) AS amount
          FROM pickup_stop_lines l JOIN pickup_stops s ON s.id = l.stop_id
          JOIN pickup_line_costs c ON c.stop_line_id = l.id
         WHERE s.order_id = p_order AND s.status IN ('collected', 'short') AND l.collected_qty > 0
         GROUP BY s.source, s.supplier_id, s.warehouse_id
    LOOP
        CONTINUE WHEN cost.amount = 0;
        lines := lines || jsonb_build_array(jsonb_build_array(ledger_account('cost_of_goods', o.city), cost.amount))
                       || jsonb_build_array(jsonb_build_array(
                              CASE cost.source WHEN 'supplier' THEN ledger_account('supplier_payable', o.city, cost.supplier_id)
                                               ELSE ledger_account('warehouse_inventory', o.city, cost.warehouse_id) END,
                              -cost.amount));
    END LOOP;
    SELECT coalesce(sum(round(delivered_qty * unit_price, 3)), 0) INTO sold
      FROM order_items WHERE order_id = p_order AND delivered_qty > 0;
    IF sold > 0 THEN
        lines := lines || jsonb_build_array(
            jsonb_build_array(ledger_account('customer_receivable', o.city, o.customer_id), sold),
            jsonb_build_array(ledger_account('sales_revenue', o.city), -sold));
    END IF;
    IF jsonb_array_length(lines) > 0 THEN
        PERFORM ledger_post('cancellation', o.city, 'إلغاء بعد بدء الجمع', lines, p_order => p_order);
    END IF;
END $$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION post_delivery(p_order bigint) RETURNS void AS $$
DECLARE o orders; collected numeric; remaining numeric; cost record; lines jsonb;
BEGIN
    SELECT * INTO o FROM orders WHERE id = p_order;
    -- البيع: العميل مدين بقيمة الطلبية ورسم التوصيل
    PERFORM ledger_post('sale', o.city, 'بيع طلبية', jsonb_build_array(
        jsonb_build_array(ledger_account('customer_receivable', o.city, o.customer_id), o.total),
        jsonb_build_array(ledger_account('sales_revenue', o.city), -o.subtotal),
        jsonb_build_array(ledger_account('delivery_fee_revenue', o.city), -o.delivery_fee)),
        p_order => p_order);
    -- التحصيل: ما لم يُحصَّل بعد على الدفعات، ناقص رصيد العميل من نزاعات سابقة (M-10)،
    -- صار كاشاً بحوزة السائق. بلا رصيد: النتيجة كما في 0001 تماماً.
    SELECT coalesce(sum(e.amount), 0) INTO collected FROM ledger_transactions t
      JOIN ledger_entries e ON e.transaction_id = t.id
     WHERE t.order_id = p_order AND t.kind = 'collection'
       AND e.account_id = ledger_account('driver_cash', o.city, o.driver_id);
    remaining := least(o.total - collected,
                       greatest(0, ledger_balance('customer_receivable', o.city, o.customer_id)));
    IF remaining > 0 THEN
        PERFORM ledger_post('collection', o.city, 'تحصيل كاش', jsonb_build_array(
            jsonb_build_array(ledger_account('driver_cash', o.city, o.driver_id), remaining),
            jsonb_build_array(ledger_account('customer_receivable', o.city, o.customer_id), -remaining)),
            p_order => p_order);
    END IF;
    -- أجر السائق إلى محفظته
    IF o.driver_pay > 0 THEN
        PERFORM ledger_post('driver_pay', o.city, 'أجر توصيل', jsonb_build_array(
            jsonb_build_array(ledger_account('driver_pay_expense', o.city), o.driver_pay),
            jsonb_build_array(ledger_account('driver_wallet', o.city, o.driver_id), -o.driver_pay)),
            p_order => p_order);
    END IF;
    -- مستحقات الموردين وتكلفة المخزن: سعر الشراء × الكمية المستلمة فعلاً
    lines := '[]'::jsonb;
    FOR cost IN
        SELECT s.source, s.supplier_id, s.warehouse_id,
               sum(round(l.collected_qty * c.unit_cost, 3)) AS amount
          FROM pickup_stop_lines l
          JOIN pickup_stops s ON s.id = l.stop_id
          JOIN pickup_line_costs c ON c.stop_line_id = l.id
         WHERE s.order_id = p_order AND s.status IN ('collected', 'short') AND l.collected_qty > 0
         GROUP BY s.source, s.supplier_id, s.warehouse_id
    LOOP
        CONTINUE WHEN cost.amount = 0;
        lines := lines || jsonb_build_array(jsonb_build_array(ledger_account('cost_of_goods', o.city), cost.amount))
                       || jsonb_build_array(jsonb_build_array(
                              CASE cost.source WHEN 'supplier' THEN ledger_account('supplier_payable', o.city, cost.supplier_id)
                                               ELSE ledger_account('warehouse_inventory', o.city, cost.warehouse_id) END,
                              -cost.amount));
    END LOOP;
    IF jsonb_array_length(lines) > 0 THEN
        PERFORM ledger_post('supplier_cost', o.city, 'تكلفة البضاعة', lines, p_order => p_order);
    END IF;
END $$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION ledger_account(p_kind ledger_account_kind, p_city text, p_party bigint DEFAULT NULL)
RETURNS bigint AS $$
DECLARE acc bigint;
    c_id bigint; d_id bigint; s_id bigint; w_id bigint;
BEGIN
    CASE p_kind
        WHEN 'customer_receivable' THEN c_id := p_party;
        WHEN 'driver_cash', 'driver_wallet' THEN d_id := p_party;
        WHEN 'supplier_payable' THEN s_id := p_party;
        WHEN 'warehouse_inventory' THEN w_id := p_party;
        ELSE NULL;
    END CASE;
    SELECT id INTO acc FROM ledger_accounts
     WHERE kind = p_kind AND city = p_city
       AND coalesce(customer_id, 0) = coalesce(c_id, 0) AND coalesce(driver_id, 0) = coalesce(d_id, 0)
       AND coalesce(supplier_id, 0) = coalesce(s_id, 0) AND coalesce(warehouse_id, 0) = coalesce(w_id, 0);
    IF acc IS NULL THEN
        INSERT INTO ledger_accounts (kind, city, customer_id, driver_id, supplier_id, warehouse_id)
        VALUES (p_kind, p_city, c_id, d_id, s_id, w_id)
        ON CONFLICT DO NOTHING
        RETURNING id INTO acc;
        IF acc IS NULL THEN
            RETURN ledger_account(p_kind, p_city, p_party);
        END IF;
    END IF;
    RETURN acc;
END $$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION trg_stop_after() RETURNS trigger AS $$
DECLARE l record; missing int;
BEGIN
    IF NEW.status IS NOT DISTINCT FROM OLD.status THEN RETURN NULL; END IF;
    IF NEW.status = 'collected' THEN
        SELECT count(*) INTO missing FROM pickup_stop_lines
         WHERE stop_id = NEW.id AND (collected_qty IS NULL OR collected_qty <> planned_qty);
        IF missing > 0 THEN
            RAISE EXCEPTION 'stop_collected_requires_full_qty: use short' USING ERRCODE = 'check_violation';
        END IF;
    ELSIF NEW.status = 'short' THEN
        SELECT count(*) INTO missing FROM pickup_stop_lines WHERE stop_id = NEW.id AND collected_qty IS NULL;
        IF missing > 0 THEN
            RAISE EXCEPTION 'stop_short_requires_qty' USING ERRCODE = 'check_violation';
        END IF;
    END IF;
    FOR l IN SELECT psl.*, oi.catalog_item_id FROM pickup_stop_lines psl
               JOIN order_items oi ON oi.id = psl.order_item_id WHERE psl.stop_id = NEW.id LOOP
        IF l.offer_id IS NOT NULL THEN
            IF NEW.status IN ('collected', 'short') THEN
                UPDATE pickup_stop_lines SET offer_report_seq =
                       (SELECT report_seq FROM supplier_offers WHERE id = l.offer_id)
                 WHERE id = l.id;
            END IF;
            PERFORM refresh_offer_commitment(l.offer_id);
        ELSE
            IF NEW.status IN ('collected', 'short') AND l.collected_qty > 0 THEN
                INSERT INTO stock_movements (warehouse_id, catalog_item_id, kind, qty_delta, stop_line_id)
                VALUES (NEW.warehouse_id, l.catalog_item_id, 'pickup', -l.collected_qty, l.id);
            END IF;
            PERFORM refresh_warehouse_reservation(NEW.warehouse_id, l.catalog_item_id);
            PERFORM refresh_item_availability(l.catalog_item_id);
        END IF;
    END LOOP;
    RETURN NULL;
END $$ LANGUAGE plpgsql;

DROP TABLE driver_custody;
DROP FUNCTION trg_custody_after();
DROP FUNCTION trg_custody_before();
ALTER TABLE ledger_accounts DROP CONSTRAINT custody_account_has_driver;
ALTER TABLE ledger_accounts DROP CONSTRAINT ledger_accounts_check;
ALTER TABLE ledger_accounts ADD CONSTRAINT ledger_accounts_check
    CHECK (num_nonnulls(customer_id, driver_id, supplier_id, warehouse_id) =
           CASE WHEN kind IN ('customer_receivable', 'driver_cash', 'driver_wallet',
                              'supplier_payable', 'warehouse_inventory') THEN 1 ELSE 0 END);
DROP TRIGGER c_withdrawal_flag ON owner_withdrawals;
DROP FUNCTION trg_withdrawal_flag();
DROP TRIGGER a_guard_derived ON owner_withdrawals;
ALTER TABLE owner_withdrawals DROP COLUMN exceeds_profit, DROP COLUMN profit_at_time;
DROP FUNCTION profit_available(text);
DROP TRIGGER cost_basis_item ON catalog_item_pricing;
DROP FUNCTION trg_cost_basis_item();
DROP TRIGGER cost_basis_city ON city_settings;
DROP FUNCTION trg_cost_basis_city();
DROP TRIGGER c_order_fee_rule ON orders;
DROP FUNCTION trg_order_fee_rule_snapshot();
DROP TRIGGER a_guard_derived_0005 ON orders;
ALTER TABLE orders DROP CONSTRAINT placed_orders_have_policies;
ALTER TABLE orders ADD CONSTRAINT placed_orders_have_policies
    CHECK (status IN ('draft', 'cancelled') OR (cancel_policy IS NOT NULL AND oversell_policy IS NOT NULL
                                                AND pickup_proof_required IS NOT NULL AND cogs_method IS NOT NULL));
ALTER TABLE orders DROP COLUMN fee_conflict_rule;
ALTER TABLE catalog_item_pricing DROP COLUMN cost_basis_override;
ALTER TABLE city_settings DROP COLUMN fee_conflict_rule, DROP COLUMN cost_guard_basis;
DROP TYPE custody_fate;
DROP TYPE custody_status;
DROP TYPE cost_guard_basis;
DROP TYPE fee_conflict_rule;
