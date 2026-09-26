-- نزول 0002: يعيد تعريفات 0001 ويحذف ما أضافته. قيمة التعداد driver_payout تبقى بلا استعمال.
SET search_path = madad, public;
DELETE FROM derived_fields WHERE (table_name, column_name) IN
  (('pickup_handovers','actor_role'),('pickup_handovers','actor_id'),('disputes','ledger_posted'));
DROP INDEX otp_register_once;
ALTER TABLE otp_challenges DROP COLUMN channel, DROP COLUMN purpose;
ALTER TABLE app_users DROP CONSTRAINT password_after_verification, DROP COLUMN password_set_at,
    DROP COLUMN password_hash, DROP COLUMN phone_verified_at;
DROP TABLE driver_payouts;
DROP FUNCTION trg_driver_payout();
DROP TRIGGER cash_handover_offset ON cash_handovers;
DROP FUNCTION trg_cash_handover_offset();
ALTER TABLE cash_handovers DROP COLUMN wallet_offset;
DROP TRIGGER b_driver_pay_method ON drivers;
DROP FUNCTION trg_driver_pay_method();
ALTER TABLE drivers DROP CONSTRAINT pay_method_on_approval, DROP COLUMN pay_method;
DROP TYPE driver_pay_method;
DROP VIEW v_driver_orders;
CREATE VIEW v_driver_orders AS
SELECT o.id, o.city, o.status, o.driver_id, c.name AS customer_name, c.phone AS customer_phone,
       o.dest_lat, o.dest_lng, o.dest_address, o.total AS amount_to_collect, o.driver_pay,
       o.collection_mode
  FROM orders o JOIN customers c ON c.id = o.customer_id
 WHERE o.status NOT IN ('draft', 'placed');
DROP FUNCTION customer_credit_available(bigint);
DROP TRIGGER dispute_post ON disputes;
DROP FUNCTION trg_dispute_post();
DROP TRIGGER b_dispute ON disputes;
DROP TRIGGER a_guard_derived ON disputes;
DROP FUNCTION trg_dispute_before();
ALTER TABLE disputes DROP CONSTRAINT dispute_money_needs_decision, DROP CONSTRAINT dispute_cash_refund_driver,
    DROP CONSTRAINT dispute_loss_party, DROP COLUMN ledger_posted, DROP COLUMN loss_driver_id,
    DROP COLUMN loss_supplier_id, DROP COLUMN loss_bearer, DROP COLUMN refund_driver_id, DROP COLUMN refund_method;
DROP TYPE loss_bearer;
DROP TYPE refund_method;
DROP TRIGGER b_products ON products;
DROP FUNCTION trg_products_before();
DROP TRIGGER b_categories ON categories;
DROP FUNCTION trg_categories_before();
DROP VIEW v_supplier_pickups;
CREATE VIEW v_supplier_pickups AS
SELECT s.id, s.supplier_id, s.pickup_location_id, s.status, s.pickup_code, o.assigned_at,
       l.id AS line_id, p.name_ar AS product_name, so.unit, so.unit_size, l.planned_qty, l.collected_qty
  FROM pickup_stops s
  JOIN orders o ON o.id = s.order_id
  JOIN pickup_stop_lines l ON l.stop_id = s.id
  JOIN supplier_offers so ON so.id = l.offer_id
  JOIN products p ON p.id = so.product_id
 WHERE s.source = 'supplier' AND s.status <> 'cancelled'
   AND o.status IN ('assigned', 'collecting', 'partially_delivered', 'delivered', 'closed');
DROP TABLE pickup_handovers;
DROP FUNCTION trg_handover_before();
DROP TRIGGER a_guard_stop_codes ON pickup_stops;
DROP FUNCTION trg_stop_codes_immutable();
ALTER TABLE pickup_stops DROP COLUMN supplier_code;
DROP TYPE handover_method;
DROP VIEW v_customer_order_driver;
DROP VIEW v_driver_stop_labels;
ALTER TABLE city_settings DROP COLUMN customer_can_call_driver, DROP COLUMN customer_sees_driver_name,
    DROP COLUMN driver_sees_supplier_name;
DROP VIEW v_customer_order_lines;
CREATE VIEW v_customer_order_lines AS
SELECT oi.id, oi.order_id, oi.catalog_item_id, ci.name_ar, oi.unit, ci.unit_size, oi.qty,
       coalesce(oi.unit_price, ci.sale_price) AS unit_price,
       round(oi.qty * coalesce(oi.unit_price, ci.sale_price), 2) AS line_total,
       oi.delivered_qty
  FROM order_items oi JOIN catalog_items ci ON ci.id = oi.catalog_item_id;
CREATE OR REPLACE FUNCTION reprice_item(p_item bigint) RETURNS void AS $$
DECLARE p catalog_item_pricing; base numeric; price numeric;
BEGIN
    SELECT * INTO p FROM catalog_item_pricing WHERE catalog_item_id = p_item;
    IF p IS NULL THEN RETURN; END IF;
    IF p.mode = 'manual' THEN
        price := p.manual_price;
    ELSE
        SELECT o.purchase_price INTO base FROM catalog_item_sources cs
          JOIN supplier_offers o ON o.id = cs.offer_id
         WHERE cs.catalog_item_id = p_item ORDER BY cs.priority LIMIT 1;
        IF base IS NULL THEN
            RAISE EXCEPTION 'margin_without_source: catalog_item %', p_item USING ERRCODE = 'check_violation';
        END IF;
        price := CASE p.mode WHEN 'margin_pct' THEN round(base * (1 + p.margin_value / 100), 2)
                             ELSE round(base + p.margin_value, 2) END;
    END IF;
    UPDATE catalog_items SET sale_price = price WHERE id = p_item AND sale_price IS DISTINCT FROM price;
    UPDATE catalog_item_pricing SET needs_review = false WHERE catalog_item_id = p_item AND needs_review;
END $$ LANGUAGE plpgsql;

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
        value := round(NEW.qty_delta * NEW.unit_cost, 2);
        PERFORM ledger_post('stock_intake', wh_city, 'إدخال مخزون',
            jsonb_build_array(
                jsonb_build_array(ledger_account('warehouse_inventory', wh_city, NEW.warehouse_id), value),
                jsonb_build_array(CASE WHEN NEW.supplier_id IS NOT NULL
                                       THEN ledger_account('supplier_payable', wh_city, NEW.supplier_id)
                                       ELSE ledger_account('treasury', wh_city) END, -value)),
            p_ref_table => 'stock_movements', p_ref_id => NEW.id);
    ELSIF NEW.kind = 'count_adjust' THEN
        value := round(NEW.qty_delta * NEW.unit_cost, 2);
        IF value <> 0 THEN
            PERFORM ledger_post('stock_adjustment', wh_city, 'تسوية جرد',
                jsonb_build_array(
                    jsonb_build_array(ledger_account('warehouse_inventory', wh_city, NEW.warehouse_id), value),
                    jsonb_build_array(ledger_account('operating_expense', wh_city), -value)),
                p_ref_table => 'stock_movements', p_ref_id => NEW.id);
        END IF;
    ELSIF NEW.kind = 'transfer_in' THEN
        SELECT * INTO src FROM stock_movements WHERE transfer_id = NEW.transfer_id AND kind = 'transfer_out';
        value := round(NEW.qty_delta * NEW.unit_cost, 2);
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

CREATE OR REPLACE FUNCTION trg_order_before() RETURNS trigger AS $$
DECLARE r text; cust customers; loc customer_locations; d drivers; cs city_settings;
        cash numeric; stops int;
BEGIN
    r := writer_role();
    IF TG_OP = 'INSERT' THEN
        IF r <> 'customer' THEN
            RAISE EXCEPTION 'forbidden_role: orders are created by customers' USING ERRCODE = 'insufficient_privilege';
        END IF;
        IF NEW.status <> 'draft' THEN
            RAISE EXCEPTION 'order_must_start_draft' USING ERRCODE = 'check_violation';
        END IF;
        SELECT * INTO cust FROM customers WHERE id = NEW.customer_id;
        IF cust.status <> 'approved' THEN
            RAISE EXCEPTION 'party_not_approved: customer %', NEW.customer_id USING ERRCODE = 'check_violation';
        END IF;
        IF NOT EXISTS (SELECT 1 FROM customer_members WHERE customer_id = NEW.customer_id
                        AND user_id = actor_id()) THEN
            RAISE EXCEPTION 'forbidden_not_member' USING ERRCODE = 'insufficient_privilege';
        END IF;
        NEW.city := cust.city;
        NEW.created_by := actor_id();
        RETURN NEW;
    END IF;

    IF NEW.customer_id <> OLD.customer_id OR NEW.city <> OLD.city OR NEW.created_by <> OLD.created_by THEN
        RAISE EXCEPTION 'order_identity_immutable' USING ERRCODE = 'restrict_violation';
    END IF;
    IF r NOT IN ('trigger', 'admin', 'system') AND NEW.route_km IS DISTINCT FROM OLD.route_km THEN
        RAISE EXCEPTION 'forbidden_role: route_km' USING ERRCODE = 'insufficient_privilege';
    END IF;
    -- السائق لا يتغيّر إلا مع انتقال الإسناد أو فكّه
    IF NEW.driver_id IS DISTINCT FROM OLD.driver_id AND r <> 'trigger'
       AND NOT (OLD.status = 'confirmed' AND NEW.status = 'assigned') THEN
        RAISE EXCEPTION 'forbidden_driver_change' USING ERRCODE = 'check_violation';
    END IF;
    IF NEW.status IS NOT DISTINCT FROM OLD.status THEN
        RETURN NEW;
    END IF;

    IF NOT order_transition_allowed(OLD.status, NEW.status, r) THEN
        RAISE EXCEPTION 'invalid_transition: % -> % by %', OLD.status, NEW.status, r
            USING ERRCODE = 'check_violation';
    END IF;
    IF r = 'admin' THEN PERFORM require_admin('orders'); END IF;
    IF r = 'customer' AND NOT EXISTS (SELECT 1 FROM customer_members WHERE customer_id = NEW.customer_id
                                       AND user_id = actor_id()) THEN
        RAISE EXCEPTION 'forbidden_not_member' USING ERRCODE = 'insufficient_privilege';
    END IF;
    SELECT * INTO cs FROM city_settings WHERE city = NEW.city;

    CASE NEW.status
    WHEN 'placed' THEN
        IF (SELECT status FROM customers WHERE id = NEW.customer_id) <> 'approved' THEN
            RAISE EXCEPTION 'party_not_approved: customer %', NEW.customer_id USING ERRCODE = 'check_violation';
        END IF;
        SELECT * INTO loc FROM customer_locations WHERE customer_id = NEW.customer_id AND active;
        IF loc IS NULL THEN
            RAISE EXCEPTION 'location_missing: customer %', NEW.customer_id USING ERRCODE = 'check_violation';
        END IF;
        NEW.location_id := loc.id; NEW.dest_lat := loc.lat; NEW.dest_lng := loc.lng;
        NEW.dest_address := loc.address_text; NEW.zone_id := loc.zone_id;
        NEW.collection_mode := cs.collection_mode;
        NEW.placed_at := now();
    WHEN 'confirmed' THEN
        IF OLD.status = 'assigned' THEN
            NEW.driver_id := NULL; NEW.driver_pay := NULL; NEW.assigned_at := NULL;
        ELSE
            NEW.confirmed_at := now();
        END IF;
    WHEN 'assigned' THEN
        IF NEW.driver_id IS NULL THEN
            RAISE EXCEPTION 'driver_missing' USING ERRCODE = 'check_violation';
        END IF;
        SELECT * INTO d FROM drivers WHERE id = NEW.driver_id;
        IF d.status <> 'approved' THEN
            RAISE EXCEPTION 'party_not_approved: driver %', d.id USING ERRCODE = 'check_violation';
        END IF;
        IF d.city <> NEW.city THEN
            RAISE EXCEPTION 'driver_city_mismatch' USING ERRCODE = 'check_violation';
        END IF;
        IF r = 'driver' AND d.user_id <> actor_id() THEN
            RAISE EXCEPTION 'forbidden_self_assign_only' USING ERRCODE = 'insufficient_privilege';
        END IF;
        IF NOT NEW.plan_complete THEN
            RAISE EXCEPTION 'plan_incomplete: order %', NEW.id USING ERRCODE = 'check_violation';
        END IF;
        -- سقف الكاش (§5): تجاوزه يوقف الإسناد حتى التسوية
        IF cs.driver_cash_cap IS NULL THEN PERFORM setting_missing(NEW.city, 'driver_cash_cap'); END IF;
        cash := ledger_balance('driver_cash', NEW.city, d.id);
        IF cash > cs.driver_cash_cap THEN
            RAISE EXCEPTION 'driver_cash_cap_exceeded: % > %', cash, cs.driver_cash_cap
                USING ERRCODE = 'check_violation';
        END IF;
        -- الأجر: عرض مقبول (يكتبه مشغّل العرض)، أو المعادلة
        IF r <> 'trigger' THEN
            IF cs.driver_pay_base IS NULL OR cs.driver_pay_per_stop IS NULL OR cs.driver_pay_per_km IS NULL THEN
                PERFORM setting_missing(NEW.city, 'driver_pay_formula');
            END IF;
            IF NEW.route_km IS NULL THEN
                RAISE EXCEPTION 'route_km_missing: order %', NEW.id USING ERRCODE = 'check_violation';
            END IF;
            SELECT count(*) INTO stops FROM pickup_stops WHERE order_id = NEW.id AND status <> 'cancelled';
            NEW.driver_pay := round(cs.driver_pay_base + cs.driver_pay_per_stop * stops
                                    + cs.driver_pay_per_km * NEW.route_km, 2);
        END IF;
        NEW.assigned_at := now();
    WHEN 'delivered' THEN
        NEW.delivered_at := now();
    WHEN 'closed' THEN
        NEW.closed_at := now();
    WHEN 'cancelled' THEN
        NEW.cancelled_at := now();
        NEW.cancelled_by_role := actor_role();
    ELSE NULL;
    END CASE;
    RETURN NEW;
END $$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION post_delivery(p_order bigint) RETURNS void AS $$
DECLARE o orders; collected numeric; cost record; lines jsonb;
BEGIN
    SELECT * INTO o FROM orders WHERE id = p_order;
    -- البيع: العميل مدين بقيمة الطلبية ورسم التوصيل
    PERFORM ledger_post('sale', o.city, 'بيع طلبية', jsonb_build_array(
        jsonb_build_array(ledger_account('customer_receivable', o.city, o.customer_id), o.total),
        jsonb_build_array(ledger_account('sales_revenue', o.city), -o.subtotal),
        jsonb_build_array(ledger_account('delivery_fee_revenue', o.city), -o.delivery_fee)),
        p_order => p_order);
    -- التحصيل: ما لم يُحصَّل بعد على الدفعات صار كاشاً بحوزة السائق
    SELECT coalesce(sum(e.amount), 0) INTO collected FROM ledger_transactions t
      JOIN ledger_entries e ON e.transaction_id = t.id
     WHERE t.order_id = p_order AND t.kind = 'collection'
       AND e.account_id = ledger_account('driver_cash', o.city, o.driver_id);
    IF o.total - collected > 0 THEN
        PERFORM ledger_post('collection', o.city, 'تحصيل كاش', jsonb_build_array(
            jsonb_build_array(ledger_account('driver_cash', o.city, o.driver_id), o.total - collected),
            jsonb_build_array(ledger_account('customer_receivable', o.city, o.customer_id), -(o.total - collected))),
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
               sum(round(l.collected_qty * c.unit_cost, 2)) AS amount
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

CREATE OR REPLACE FUNCTION trg_batch_after() RETURNS trigger AS $$
DECLARE o orders; remaining int; value numeric; last_batch boolean;
BEGIN
    IF NEW.status IS NOT DISTINCT FROM OLD.status OR NEW.status <> 'delivered' THEN RETURN NULL; END IF;
    UPDATE order_items oi SET delivered_qty = oi.delivered_qty + bl.qty
      FROM order_batch_lines bl WHERE bl.batch_id = NEW.id AND bl.order_item_id = oi.id;
    SELECT * INTO o FROM orders WHERE id = NEW.order_id;
    SELECT count(*) INTO remaining FROM order_items WHERE order_id = o.id AND delivered_qty < qty;
    last_batch := remaining = 0;
    -- التحصيل على الدفعات: كل دفعة بقيمتها، والرسم مع الأخيرة
    IF o.collection_mode = 'per_batch' AND NOT last_batch THEN
        SELECT coalesce(sum(round(bl.qty * oi.unit_price, 2)), 0) INTO value
          FROM order_batch_lines bl JOIN order_items oi ON oi.id = bl.order_item_id
         WHERE bl.batch_id = NEW.id;
        IF value > 0 THEN
            PERFORM ledger_post('collection', o.city, 'تحصيل دفعة', jsonb_build_array(
                jsonb_build_array(ledger_account('driver_cash', o.city, o.driver_id), value),
                jsonb_build_array(ledger_account('customer_receivable', o.city, o.customer_id), -value)),
                p_order => o.id, p_batch => NEW.id);
        END IF;
    END IF;
    UPDATE orders SET status = CASE WHEN last_batch THEN 'delivered'::order_status
                                    ELSE 'partially_delivered'::order_status END
     WHERE id = o.id AND status IS DISTINCT FROM
           CASE WHEN last_batch THEN 'delivered'::order_status ELSE 'partially_delivered'::order_status END;
    RETURN NULL;
END $$ LANGUAGE plpgsql;
ALTER TABLE order_items DROP COLUMN line_total;
ALTER TABLE order_items ADD COLUMN line_total numeric GENERATED ALWAYS AS (round(qty * unit_price, 2)) STORED;
ALTER TABLE stock_movements DROP CONSTRAINT stock_movements_check;
ALTER TABLE stock_movements ADD CONSTRAINT stock_movements_check
    CHECK (kind <> 'intake' OR (qty_delta > 0 AND unit_cost > 0 AND unit_cost = round(unit_cost, 2))) NOT VALID;
ALTER TABLE catalog_item_pricing DROP CONSTRAINT catalog_item_pricing_margin_value_check;
ALTER TABLE catalog_item_pricing ADD CONSTRAINT catalog_item_pricing_margin_value_check
    CHECK (margin_value >= 0 AND margin_value = round(margin_value, 2)) NOT VALID;
ALTER DOMAIN money_lyd DROP CONSTRAINT money_precision;
ALTER DOMAIN money_lyd ADD CONSTRAINT money_precision CHECK (VALUE = round(VALUE, 2)) NOT VALID;
