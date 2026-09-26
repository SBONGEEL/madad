-- ═══════════════════════════════════════════════════════════════════════════
-- مَدَد — الترحيلة 0005: قرارات المالك، الدفعة الثالثة (2026-09-26، §12-و)
-- م-25 حسم تعارض رسم الحيّ والمنطقة · م-26 علامة تجاوز الربح في السحب
-- م-6 أساس «التكلفة» · أمانة السائق بعد الإلغاء ومصيرها من شاشة النزاع.
-- ═══════════════════════════════════════════════════════════════════════════
SET search_path = madad, public;
SELECT set_config('madad.actor_role', 'system', true);

-- قيم تعداد جديدة: تُستعمل وقت التشغيل فقط، وفي القيود تُقارَن نصاً (kind::text).
ALTER TYPE ledger_account_kind ADD VALUE IF NOT EXISTS 'goods_in_custody';   -- بضاعة بعهدة سائق
ALTER TYPE ledger_txn_kind ADD VALUE IF NOT EXISTS 'custody';
ALTER TYPE stock_move_kind ADD VALUE IF NOT EXISTS 'custody_in';
ALTER TYPE stop_source ADD VALUE IF NOT EXISTS 'custody';

CREATE TYPE fee_conflict_rule AS ENUM ('area_wins', 'zone_wins', 'higher', 'lower');
CREATE TYPE cost_guard_basis  AS ENUM ('max_source', 'first_priority');
CREATE TYPE custody_status    AS ENUM ('open', 'assigned', 'resolved');
CREATE TYPE custody_fate      AS ENUM ('to_warehouse', 'return_supplier', 'to_order');


-- ——— الإعدادات ——————————————————————————————————————————————————————————
ALTER TABLE city_settings
    ADD COLUMN fee_conflict_rule fee_conflict_rule NOT NULL DEFAULT 'area_wins',    -- م-25
    ADD COLUMN cost_guard_basis  cost_guard_basis  NOT NULL DEFAULT 'max_source';   -- م-6
ALTER TABLE catalog_item_pricing ADD COLUMN cost_basis_override cost_guard_basis;  -- م-6: استثناء الصنف

ALTER TABLE orders ADD COLUMN fee_conflict_rule fee_conflict_rule;                  -- ◆ لقطة عند placed
ALTER TABLE orders DROP CONSTRAINT placed_orders_have_policies;
ALTER TABLE orders ADD CONSTRAINT placed_orders_have_policies
    CHECK (status IN ('draft', 'cancelled') OR (cancel_policy IS NOT NULL AND oversell_policy IS NOT NULL
                                                AND pickup_proof_required IS NOT NULL AND cogs_method IS NOT NULL
                                                AND fee_conflict_rule IS NOT NULL));
CREATE TRIGGER a_guard_derived_0005 BEFORE INSERT OR UPDATE ON orders FOR EACH ROW
    EXECUTE FUNCTION guard_derived('fee_conflict_rule:null');

-- اللقطة تُؤخذ بعد b_order (الذي يكتب بقية اللقطات) في مشغّل مستقل لا يعيد كتابة b_order.
CREATE FUNCTION trg_order_fee_rule_snapshot() RETURNS trigger AS $$
BEGIN
    IF NEW.status = 'placed' AND OLD.status IS DISTINCT FROM 'placed' THEN
        NEW.fee_conflict_rule := (SELECT fee_conflict_rule FROM city_settings WHERE city = NEW.city);
    END IF;
    RETURN NEW;
END $$ LANGUAGE plpgsql;
CREATE TRIGGER c_order_fee_rule BEFORE UPDATE ON orders FOR EACH ROW EXECUTE FUNCTION trg_order_fee_rule_snapshot();

-- م-25: التعارض يُحسم بقاعدة لقطة الطلبية. التداخل بين منطقتين مرسومتين يبقى متوقفاً (ت-38 → م-27).
CREATE OR REPLACE FUNCTION order_fee(p_order bigint) RETURNS numeric AS $$
DECLARE o orders; cs city_settings; z_fee numeric; a_fee numeric; rule fee_conflict_rule;
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
    IF z_fee IS NULL OR a_fee IS NULL OR z_fee = a_fee THEN
        RETURN coalesce(a_fee, z_fee);
    END IF;
    rule := coalesce(o.fee_conflict_rule, cs.fee_conflict_rule);
    RETURN CASE rule WHEN 'area_wins' THEN a_fee WHEN 'zone_wins' THEN z_fee
                     WHEN 'higher' THEN greatest(a_fee, z_fee) ELSE least(a_fee, z_fee) END;
END $$ LANGUAGE plpgsql;


-- ——— م-6: أساس التكلفة التي لا يُباع الصنف تحتها ————————————————————————————————
-- max_source: أعلى سعر شراء بين موردي الصنف النشطين المعتمدين (الابتدائي).
-- first_priority: سعر المورد الأول في الأولوية بين النشطين المعتمدين.
-- الصنف بلا مورد نشط (مخزن فقط) لا تكلفة مرجعية له هنا (سؤال م-28).
CREATE OR REPLACE FUNCTION item_cost_ref(p_item bigint) RETURNS numeric AS $$
    SELECT CASE coalesce((SELECT cost_basis_override FROM catalog_item_pricing WHERE catalog_item_id = p_item),
                         (SELECT cs.cost_guard_basis FROM catalog_items ci JOIN city_settings cs ON cs.city = ci.city
                           WHERE ci.id = p_item))
        WHEN 'first_priority' THEN
            (SELECT o.purchase_price FROM catalog_item_sources src
               JOIN supplier_offers o ON o.id = src.offer_id JOIN suppliers s ON s.id = o.supplier_id
              WHERE src.catalog_item_id = p_item AND o.status = 'active' AND s.status = 'approved'
              ORDER BY src.priority LIMIT 1)
        ELSE
            (SELECT max(o.purchase_price) FROM catalog_item_sources src
               JOIN supplier_offers o ON o.id = src.offer_id JOIN suppliers s ON s.id = o.supplier_id
              WHERE src.catalog_item_id = p_item AND o.status = 'active' AND s.status = 'approved')
    END
$$ LANGUAGE sql STABLE;

-- تغيير الأساس (عاماً أو لصنف) يعيد حساب العلامة فوراً: «لا يُباع» يسري على السلة والطلب الجديد.
CREATE FUNCTION trg_cost_basis_city() RETURNS trigger AS $$
DECLARE item bigint;
BEGIN
    IF NEW.cost_guard_basis IS DISTINCT FROM OLD.cost_guard_basis THEN
        FOR item IN SELECT id FROM catalog_items WHERE city = NEW.city LOOP
            PERFORM refresh_cost_guard(item);
        END LOOP;
    END IF;
    RETURN NULL;
END $$ LANGUAGE plpgsql;
CREATE TRIGGER cost_basis_city AFTER UPDATE ON city_settings FOR EACH ROW EXECUTE FUNCTION trg_cost_basis_city();

CREATE FUNCTION trg_cost_basis_item() RETURNS trigger AS $$
BEGIN
    IF TG_OP = 'INSERT' OR NEW.cost_basis_override IS DISTINCT FROM OLD.cost_basis_override THEN
        PERFORM refresh_cost_guard(NEW.catalog_item_id);
    END IF;
    RETURN NULL;
END $$ LANGUAGE plpgsql;
CREATE TRIGGER cost_basis_item AFTER INSERT OR UPDATE ON catalog_item_pricing FOR EACH ROW EXECUTE FUNCTION trg_cost_basis_item();


-- ——— م-26: السحب فوق الربح المتراكم يُعلَّم، ولا يُمنع ————————————————————————————
-- الربح المتاح للسحب = الربح المتراكم (الحسابات الاسمية) ناقص السحوبات السابقة.
CREATE FUNCTION profit_available(p_city text) RETURNS numeric AS $$
    SELECT -coalesce(sum(balance), 0) FROM ledger_accounts
     WHERE city = p_city AND kind::text IN ('sales_revenue', 'delivery_fee_revenue', 'cost_of_goods',
                                            'driver_pay_expense', 'operating_expense', 'sales_adjustment',
                                            'owner_drawings')
$$ LANGUAGE sql STABLE;

ALTER TABLE owner_withdrawals ADD COLUMN exceeds_profit boolean NOT NULL DEFAULT false;   -- ◆
ALTER TABLE owner_withdrawals ADD COLUMN profit_at_time money_lyd;                       -- ◆ للسجل
CREATE TRIGGER a_guard_derived BEFORE INSERT ON owner_withdrawals FOR EACH ROW
    EXECUTE FUNCTION guard_derived('exceeds_profit:false', 'profit_at_time:null');
CREATE FUNCTION trg_withdrawal_flag() RETURNS trigger AS $$
DECLARE avail numeric;
BEGIN
    avail := round(profit_available(NEW.city), 3);
    NEW.profit_at_time := avail;
    NEW.exceeds_profit := NEW.amount > avail;
    RETURN NEW;
END $$ LANGUAGE plpgsql;
CREATE TRIGGER c_withdrawal_flag BEFORE INSERT ON owner_withdrawals FOR EACH ROW EXECUTE FUNCTION trg_withdrawal_flag();


-- ——— أمانة السائق: بضاعة جُمعت ولم تُسلَّم لطلبية أُلغيت ————————————————————————————
-- ledger_account يعرف الحساب الجديد (بطرف سائق)، والقيد على الأطراف يقبله.
CREATE OR REPLACE FUNCTION ledger_account(p_kind ledger_account_kind, p_city text, p_party bigint DEFAULT NULL)
RETURNS bigint AS $$
DECLARE acc bigint;
    c_id bigint; d_id bigint; s_id bigint; w_id bigint;
BEGIN
    CASE p_kind::text
        WHEN 'customer_receivable' THEN c_id := p_party;
        WHEN 'driver_cash', 'driver_wallet', 'goods_in_custody' THEN d_id := p_party;
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
ALTER TABLE ledger_accounts DROP CONSTRAINT ledger_accounts_check;
ALTER TABLE ledger_accounts ADD CONSTRAINT ledger_accounts_check
    CHECK (num_nonnulls(customer_id, driver_id, supplier_id, warehouse_id) =
           CASE WHEN kind::text IN ('customer_receivable', 'driver_cash', 'driver_wallet', 'goods_in_custody',
                                    'supplier_payable', 'warehouse_inventory') THEN 1 ELSE 0 END);
ALTER TABLE ledger_accounts ADD CONSTRAINT custody_account_has_driver
    CHECK (kind::text <> 'goods_in_custody' OR driver_id IS NOT NULL);

-- سطر الأمانة: صنف وكمية وتكلفة ومصدر. ليس جدولاً مالياً: قيمته في الدفتر (goods_in_custody).
CREATE TABLE driver_custody (
    id              bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    order_id        bigint NOT NULL REFERENCES orders(id),         -- الطلبية الملغاة
    stop_line_id    bigint NOT NULL REFERENCES pickup_stop_lines(id),
    driver_id       bigint NOT NULL REFERENCES drivers(id),
    catalog_item_id bigint NOT NULL REFERENCES catalog_items(id),
    qty             qty NOT NULL CHECK (qty > 0),
    unit_cost       numeric NOT NULL CHECK (unit_cost >= 0),
    supplier_id     bigint REFERENCES suppliers(id),               -- المصدر: مورد أو مخزن
    warehouse_id    bigint REFERENCES warehouses(id),
    dispute_id      bigint REFERENCES disputes(id),
    status          custody_status NOT NULL DEFAULT 'open',
    fate            custody_fate,
    target_warehouse_id bigint REFERENCES warehouses(id),
    target_order_id bigint REFERENCES orders(id),
    decided_by      bigint REFERENCES app_users(id),               -- ◆
    decided_at      timestamptz,                                   -- ◆
    created_at      timestamptz NOT NULL DEFAULT now(),
    CHECK (num_nonnulls(supplier_id, warehouse_id) = 1),
    CHECK ((status = 'open') = (fate IS NULL)),
    CHECK (fate IS DISTINCT FROM 'to_warehouse' OR target_warehouse_id IS NOT NULL),
    CHECK (fate IS DISTINCT FROM 'to_order' OR target_order_id IS NOT NULL),
    CHECK (fate IS DISTINCT FROM 'return_supplier' OR supplier_id IS NOT NULL),
    CHECK (target_order_id IS DISTINCT FROM order_id)
);
CREATE INDEX ON driver_custody (driver_id) WHERE status <> 'resolved';
CREATE TRIGGER zz_audit AFTER INSERT OR UPDATE ON driver_custody FOR EACH ROW EXECUTE FUNCTION trg_audit();

ALTER TABLE pickup_stops ADD COLUMN custody_id bigint REFERENCES driver_custody(id);
ALTER TABLE pickup_stops ADD CONSTRAINT custody_stop_has_no_other_source
    CHECK (custody_id IS NULL OR (supplier_id IS NULL AND warehouse_id IS NULL AND pickup_location_id IS NULL));

-- الإلغاء بعد الجمع (ت-34 موافَق عليه + الأمانة): لكل سطر مستلم، الجزء المسلَّم للمطعم تكلفةُ بضاعة،
-- والباقي أمانةٌ بعهدة سائق الطلبية بتكلفته. المورد/المخزن يُدان بكامل المستلم. ما سُلِّم يُقيَّد على المطعم.
CREATE OR REPLACE FUNCTION post_cancellation(p_order bigint) RETURNS void AS $$
DECLARE o orders; l record; lines jsonb := '[]'::jsonb; sold numeric; left_by_item jsonb := '{}'::jsonb;
        delivered numeric; take numeric; kept numeric; cost numeric; credit bigint; did bigint;
BEGIN
    SELECT * INTO o FROM orders WHERE id = p_order;
    SELECT id INTO did FROM disputes WHERE order_id = p_order ORDER BY id DESC LIMIT 1;
    FOR l IN
        SELECT pl.id, pl.collected_qty, pl.order_item_id, oi.catalog_item_id, oi.delivered_qty, c.unit_cost,
               s.source::text AS source, s.supplier_id, s.warehouse_id, s.custody_id
          FROM pickup_stop_lines pl JOIN pickup_stops s ON s.id = pl.stop_id
          JOIN pickup_line_costs c ON c.stop_line_id = pl.id
          JOIN order_items oi ON oi.id = pl.order_item_id
         WHERE s.order_id = p_order AND s.status IN ('collected', 'short') AND pl.collected_qty > 0
         ORDER BY pl.id
    LOOP
        -- ما سُلِّم من الصنف يُوزَّع على أسطره بالترتيب؛ الباقي أمانة
        delivered := coalesce((left_by_item ->> l.order_item_id::text)::numeric, l.delivered_qty);
        take := least(delivered, l.collected_qty);
        kept := l.collected_qty - take;
        left_by_item := left_by_item || jsonb_build_object(l.order_item_id::text, delivered - take);
        cost := round(l.collected_qty * l.unit_cost, 3);
        credit := CASE l.source WHEN 'supplier' THEN ledger_account('supplier_payable', o.city, l.supplier_id)
                                WHEN 'warehouse' THEN ledger_account('warehouse_inventory', o.city, l.warehouse_id)
                                ELSE ledger_account('goods_in_custody', o.city,
                                                    (SELECT driver_id FROM driver_custody WHERE id = l.custody_id)) END;
        lines := lines
            || jsonb_build_array(jsonb_build_array(ledger_account('cost_of_goods', o.city), cost - round(kept * l.unit_cost, 3)))
            || jsonb_build_array(jsonb_build_array(ledger_account('goods_in_custody', o.city, o.driver_id), round(kept * l.unit_cost, 3)))
            || jsonb_build_array(jsonb_build_array(credit, -cost));
        IF kept > 0 THEN
            INSERT INTO driver_custody (order_id, stop_line_id, driver_id, catalog_item_id, qty, unit_cost,
                                        supplier_id, warehouse_id, dispute_id)
            VALUES (p_order, l.id, o.driver_id, l.catalog_item_id, kept, l.unit_cost,
                    CASE WHEN l.source = 'supplier' THEN l.supplier_id
                         WHEN l.source = 'custody' THEN (SELECT supplier_id FROM driver_custody WHERE id = l.custody_id) END,
                    CASE WHEN l.source = 'warehouse' THEN l.warehouse_id
                         WHEN l.source = 'custody' THEN (SELECT warehouse_id FROM driver_custody WHERE id = l.custody_id) END,
                    did);
        END IF;
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

-- النزاع يُفتح قبل الأمانة لتُربط به (0004 يفتحه بعد post_cancellation): يُربط هنا بعد فتحه.
CREATE FUNCTION trg_dispute_links_custody() RETURNS trigger AS $$
BEGIN
    UPDATE driver_custody SET dispute_id = NEW.id WHERE order_id = NEW.order_id AND dispute_id IS NULL;
    RETURN NULL;
END $$ LANGUAGE plpgsql;
CREATE TRIGGER dispute_links_custody AFTER INSERT ON disputes FOR EACH ROW EXECUTE FUNCTION trg_dispute_links_custody();

-- قرار المالك في الأمانة. المصير يُكتب مرة؛ القيود هنا.
CREATE FUNCTION trg_custody_before() RETURNS trigger AS $$
DECLARE r text; t orders; item order_items; wh warehouses;
BEGIN
    r := writer_role();
    IF TG_OP = 'INSERT' THEN
        IF r NOT IN ('trigger', 'system') THEN
            RAISE EXCEPTION 'derived_field_write: driver_custody' USING ERRCODE = 'restrict_violation';
        END IF;
        RETURN NEW;
    END IF;
    IF (NEW.order_id, NEW.stop_line_id, NEW.driver_id, NEW.catalog_item_id, NEW.qty, NEW.unit_cost,
        NEW.supplier_id, NEW.warehouse_id) IS DISTINCT FROM
       (OLD.order_id, OLD.stop_line_id, OLD.driver_id, OLD.catalog_item_id, OLD.qty, OLD.unit_cost,
        OLD.supplier_id, OLD.warehouse_id) THEN
        RAISE EXCEPTION 'custody_identity_immutable' USING ERRCODE = 'restrict_violation';
    END IF;
    IF r = 'trigger' THEN RETURN NEW; END IF;
    PERFORM require_admin('orders');
    IF OLD.status <> 'open' THEN
        RAISE EXCEPTION 'custody_already_decided' USING ERRCODE = 'check_violation';
    END IF;
    IF NEW.fate IS NULL THEN RETURN NEW; END IF;
    NEW.decided_by := actor_id(); NEW.decided_at := now();
    IF NEW.fate = 'to_order' THEN
        SELECT * INTO t FROM orders WHERE id = NEW.target_order_id;
        IF t.status <> 'confirmed' THEN
            RAISE EXCEPTION 'custody_target_not_plannable: %', t.status USING ERRCODE = 'check_violation';
        END IF;
        SELECT * INTO item FROM order_items WHERE order_id = t.id AND catalog_item_id = NEW.catalog_item_id;
        IF item IS NULL THEN
            RAISE EXCEPTION 'custody_target_lacks_item' USING ERRCODE = 'check_violation';
        END IF;
        IF item.qty < NEW.qty THEN
            RAISE EXCEPTION 'custody_exceeds_target_qty: % > %', NEW.qty, item.qty USING ERRCODE = 'check_violation';
        END IF;
        NEW.status := 'assigned';
    ELSE
        IF NEW.fate = 'to_warehouse' THEN
            SELECT * INTO wh FROM warehouses WHERE id = NEW.target_warehouse_id;
            IF NOT wh.active OR wh.city <> (SELECT city FROM orders WHERE id = NEW.order_id) THEN
                RAISE EXCEPTION 'custody_warehouse_invalid' USING ERRCODE = 'check_violation';
            END IF;
        END IF;
        NEW.status := 'resolved';
    END IF;
    RETURN NEW;
END $$ LANGUAGE plpgsql;
CREATE TRIGGER b_custody BEFORE INSERT OR UPDATE ON driver_custody FOR EACH ROW EXECUTE FUNCTION trg_custody_before();
CREATE TRIGGER z_no_delete BEFORE DELETE ON driver_custody FOR EACH ROW EXECUTE FUNCTION guard_append_only();

CREATE FUNCTION trg_custody_after() RETURNS trigger AS $$
DECLARE city text; stop_id bigint; line_id bigint; item order_items; need numeric; pl record; cut numeric;
        next_seq int;
BEGIN
    IF NEW.fate IS NOT DISTINCT FROM OLD.fate OR NEW.fate IS NULL THEN RETURN NULL; END IF;
    SELECT o.city INTO city FROM orders o WHERE o.id = NEW.order_id;
    IF NEW.fate = 'to_warehouse' THEN
        -- تدخل المخزن بتكلفتها (الحركة تقيد: مخزون مدين / أمانة السائق دائن)
        INSERT INTO stock_movements (warehouse_id, catalog_item_id, kind, qty_delta, unit_cost, custody_id, note)
        VALUES (NEW.target_warehouse_id, NEW.catalog_item_id, 'custody_in', NEW.qty, NEW.unit_cost, NEW.id,
                'أمانة #' || NEW.id);
    ELSIF NEW.fate = 'return_supplier' THEN
        -- تُعاد للمورد: يُعكس مستحقه
        PERFORM ledger_post('custody', city, 'إعادة أمانة للمورد', jsonb_build_array(
            jsonb_build_array(ledger_account('supplier_payable', city, NEW.supplier_id), round(NEW.qty * NEW.unit_cost, 3)),
            jsonb_build_array(ledger_account('goods_in_custody', city, NEW.driver_id), -round(NEW.qty * NEW.unit_cost, 3))),
            p_ref_table => 'driver_custody', p_ref_id => NEW.id);
    ELSE
        -- تُسلَّم لطلبية أخرى: نقطة استلام «من السائق» تحلّ محل الكمية نفسها من مصادرها الأخرى
        SELECT * INTO item FROM order_items WHERE order_id = NEW.target_order_id AND catalog_item_id = NEW.catalog_item_id;
        need := NEW.qty;
        FOR pl IN SELECT l.* FROM pickup_stop_lines l JOIN pickup_stops s ON s.id = l.stop_id
                   WHERE l.order_item_id = item.id AND s.status = 'pending' ORDER BY l.id DESC LOOP
            EXIT WHEN need <= 0;
            cut := least(need, pl.planned_qty);
            IF cut = pl.planned_qty THEN
                DELETE FROM pickup_stop_lines WHERE id = pl.id;
            ELSE
                UPDATE pickup_stop_lines SET planned_qty = planned_qty - cut WHERE id = pl.id;
            END IF;
            need := need - cut;
        END LOOP;
        DELETE FROM pickup_stops s WHERE s.order_id = NEW.target_order_id AND s.status = 'pending'
           AND NOT EXISTS (SELECT 1 FROM pickup_stop_lines l WHERE l.stop_id = s.id);
        SELECT coalesce(max(seq), 0) + 1 INTO next_seq FROM pickup_stops WHERE order_id = NEW.target_order_id;
        INSERT INTO pickup_stops (order_id, seq, source, custody_id)
        VALUES (NEW.target_order_id, next_seq, 'custody', NEW.id) RETURNING id INTO stop_id;
        INSERT INTO pickup_stop_lines (stop_id, order_item_id, planned_qty) VALUES (stop_id, item.id, NEW.qty)
        RETURNING id INTO line_id;
        INSERT INTO pickup_line_costs (stop_line_id, unit_cost) VALUES (line_id, NEW.unit_cost);
    END IF;
    RETURN NULL;
END $$ LANGUAGE plpgsql;
CREATE TRIGGER custody_after AFTER UPDATE ON driver_custody FOR EACH ROW EXECUTE FUNCTION trg_custody_after();

-- إدخال الأمانة للمخزن: الدائن أمانة السائق لا المورد ولا الخزينة.
CREATE FUNCTION trg_custody_in_guard() RETURNS trigger AS $$
BEGIN
    IF NEW.kind::text = 'custody_in' AND writer_role() <> 'trigger' THEN
        RAISE EXCEPTION 'derived_field_write: stock_movements.custody_in' USING ERRCODE = 'restrict_violation';
    END IF;
    RETURN NEW;
END $$ LANGUAGE plpgsql;
CREATE TRIGGER a_custody_in_guard BEFORE INSERT ON stock_movements FOR EACH ROW EXECUTE FUNCTION trg_custody_in_guard();

-- الحركة custody_in مربوطة بسطر أمانتها، ومن تطبيقها يخرج قيد الأمانة.
ALTER TABLE stock_movements ADD COLUMN custody_id bigint REFERENCES driver_custody(id);
ALTER TABLE stock_movements ADD CONSTRAINT custody_in_has_custody CHECK ((kind::text = 'custody_in') = (custody_id IS NOT NULL));
CREATE FUNCTION trg_custody_in_post() RETURNS trigger AS $$
DECLARE c driver_custody; wh_city text; value numeric;
BEGIN
    IF NEW.kind::text <> 'custody_in' THEN RETURN NULL; END IF;
    SELECT * INTO c FROM driver_custody WHERE id = NEW.custody_id;
    SELECT city INTO wh_city FROM warehouses WHERE id = NEW.warehouse_id;
    value := round(NEW.qty_delta * NEW.unit_cost, 3);
    PERFORM ledger_post('custody', wh_city, 'أمانة سائق إلى المخزن', jsonb_build_array(
        jsonb_build_array(ledger_account('warehouse_inventory', wh_city, NEW.warehouse_id), value),
        jsonb_build_array(ledger_account('goods_in_custody', wh_city, c.driver_id), -value)),
        p_ref_table => 'stock_movements', p_ref_id => NEW.id);
    RETURN NULL;
END $$ LANGUAGE plpgsql;
CREATE TRIGGER custody_in_post AFTER INSERT ON stock_movements FOR EACH ROW EXECUTE FUNCTION trg_custody_in_post();

-- trg_stock_movement_before يكتب unit_cost لغير الإدخال: custody_in يحتفظ بتكلفة الأمانة.
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
    IF NEW.kind::text = 'custody_in' THEN
        RETURN NEW;
    END IF;
    IF NEW.kind IN ('transfer_out', 'count_adjust', 'pickup') THEN
        avg := coalesce((SELECT avg_cost FROM warehouse_stock
                          WHERE warehouse_id = NEW.warehouse_id AND catalog_item_id = NEW.catalog_item_id), 0);
        IF NEW.qty_delta < 0 THEN
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
            NEW.unit_cost := avg;
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

-- custody_in يدخل المتوسط المرجّح كالإدخال.
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
    new_avg := CASE WHEN NEW.kind::text IN ('intake', 'transfer_in', 'custody_in') AND new_on_hand > 0
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

-- نقطة «من السائق»: لا حركة مخزن ولا التزام مورد عند جمعها.
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
    IF NEW.custody_id IS NOT NULL THEN
        -- إلغاء الطلبية الهدف قبل الجمع يعيد الأمانة مفتوحة لقرار جديد
        IF NEW.status = 'cancelled' THEN
            UPDATE driver_custody SET status = 'open', fate = NULL, target_order_id = NULL,
                                      decided_by = NULL, decided_at = NULL
             WHERE id = NEW.custody_id AND status = 'assigned';
        END IF;
        RETURN NULL;
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

-- التسليم: سطر «من السائق» يُقفل أمانته (دائن الأمانة لا المورد).
CREATE OR REPLACE FUNCTION post_delivery(p_order bigint) RETURNS void AS $$
DECLARE o orders; collected numeric; remaining numeric; cost record; lines jsonb;
BEGIN
    SELECT * INTO o FROM orders WHERE id = p_order;
    PERFORM ledger_post('sale', o.city, 'بيع طلبية', jsonb_build_array(
        jsonb_build_array(ledger_account('customer_receivable', o.city, o.customer_id), o.total),
        jsonb_build_array(ledger_account('sales_revenue', o.city), -o.subtotal),
        jsonb_build_array(ledger_account('delivery_fee_revenue', o.city), -o.delivery_fee)),
        p_order => p_order);
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
    IF o.driver_pay > 0 THEN
        PERFORM ledger_post('driver_pay', o.city, 'أجر توصيل', jsonb_build_array(
            jsonb_build_array(ledger_account('driver_pay_expense', o.city), o.driver_pay),
            jsonb_build_array(ledger_account('driver_wallet', o.city, o.driver_id), -o.driver_pay)),
            p_order => p_order);
    END IF;
    lines := '[]'::jsonb;
    FOR cost IN
        SELECT s.source::text AS source, s.supplier_id, s.warehouse_id, dc.driver_id AS custody_driver,
               sum(round(l.collected_qty * c.unit_cost, 3)) AS amount
          FROM pickup_stop_lines l
          JOIN pickup_stops s ON s.id = l.stop_id
          JOIN pickup_line_costs c ON c.stop_line_id = l.id
          LEFT JOIN driver_custody dc ON dc.id = s.custody_id
         WHERE s.order_id = p_order AND s.status IN ('collected', 'short') AND l.collected_qty > 0
         GROUP BY s.source, s.supplier_id, s.warehouse_id, dc.driver_id
    LOOP
        CONTINUE WHEN cost.amount = 0;
        lines := lines || jsonb_build_array(jsonb_build_array(ledger_account('cost_of_goods', o.city), cost.amount))
                       || jsonb_build_array(jsonb_build_array(
                              CASE cost.source WHEN 'supplier' THEN ledger_account('supplier_payable', o.city, cost.supplier_id)
                                               WHEN 'warehouse' THEN ledger_account('warehouse_inventory', o.city, cost.warehouse_id)
                                               ELSE ledger_account('goods_in_custody', o.city, cost.custody_driver) END,
                              -cost.amount));
    END LOOP;
    IF jsonb_array_length(lines) > 0 THEN
        PERFORM ledger_post('supplier_cost', o.city, 'تكلفة البضاعة', lines, p_order => p_order);
    END IF;
    UPDATE driver_custody dc SET status = 'resolved'
      FROM pickup_stops s WHERE s.order_id = p_order AND s.custody_id = dc.id AND dc.status = 'assigned';
END $$ LANGUAGE plpgsql;

-- «لا تُقفل تسوية السائق وعليه أمانة غير محسومة».
CREATE FUNCTION trg_settlement_needs_clear_custody() RETURNS trigger AS $$
BEGIN
    IF EXISTS (SELECT 1 FROM driver_custody WHERE driver_id = NEW.driver_id AND status <> 'resolved') THEN
        RAISE EXCEPTION 'custody_open: driver %', NEW.driver_id USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
END $$ LANGUAGE plpgsql;
CREATE TRIGGER b_settlement_custody BEFORE INSERT ON cash_handovers FOR EACH ROW
    EXECUTE FUNCTION trg_settlement_needs_clear_custody();

-- ما يراه السائق من أمانته: صنف وكمية وطلبية. بلا تكلفة ولا مورد.
CREATE VIEW v_driver_custody AS
SELECT dc.id, dc.driver_id, dc.order_id, ci.name_ar, ci.unit, ci.unit_size, dc.qty, dc.status, dc.created_at
  FROM driver_custody dc JOIN catalog_items ci ON ci.id = dc.catalog_item_id
 WHERE dc.status <> 'resolved';

-- سجل الكتّاب
INSERT INTO derived_fields (table_name, column_name, writer, source) VALUES
 ('orders', 'fee_conflict_rule',            'trg_order_fee_rule_snapshot', 'لقطة city_settings عند placed (م-25)'),
 ('owner_withdrawals', 'exceeds_profit',    'trg_withdrawal_flag', 'amount > profit_available (م-26)'),
 ('owner_withdrawals', 'profit_at_time',    'trg_withdrawal_flag', 'profit_available لحظة السحب'),
 ('driver_custody', 'decided_by',           'trg_custody_before', 'قرار المالك'),
 ('driver_custody', 'decided_at',           'trg_custody_before', 'قرار المالك');
