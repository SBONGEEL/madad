-- نزول 0004. قيم التعداد المضافة (owner_drawings, owner_withdrawal, cancellation) تبقى بلا استعمال.
-- الدوال المستبدلة تُستعاد من تعريفها السابق (مولَّد من 0001–0003 بـgen_down4.py).
SET search_path = madad, public;
SELECT set_config('madad.actor_role', 'system', true);
DELETE FROM derived_fields WHERE (table_name, column_name) IN (
 ('catalog_items','below_cost'),('orders','area_id'),('orders','cancel_policy'),('orders','oversell_policy'),
 ('orders','pickup_proof_required'),('orders','cogs_method'),('orders','ready_for_owner_at'),
 ('stock_movements','cost_method'),('stock_layers','qty_left'),('ledger_transactions','branch_id'),
 ('cogs_method_periods','effective_from'),('customer_locations','reviewed_by'),('app_users','must_change_password'));

DROP TABLE otp_deliveries;
DROP FUNCTION trg_otp_delivery_after();
DROP TABLE otp_channels;
DROP FUNCTION trg_sms_last();
DROP FUNCTION trg_otp_channel_before();
DROP TABLE owner_withdrawals;
DROP FUNCTION trg_withdrawal_post();
DROP FUNCTION trg_withdrawal_before();
DROP TRIGGER b_password_change ON app_users;
DROP FUNCTION trg_password_change();
DROP TABLE password_reset_events;
ALTER TABLE app_users DROP COLUMN must_change_password;
DROP INDEX otp_register_once;
CREATE UNIQUE INDEX otp_register_once ON otp_challenges (phone, audience) WHERE consumed_at IS NOT NULL;
ALTER TABLE otp_challenges DROP CONSTRAINT otp_challenges_channel_check;
ALTER TABLE otp_challenges ADD CONSTRAINT otp_challenges_channel_check CHECK (channel IN ('whatsapp', 'sms'));
ALTER TABLE otp_challenges DROP CONSTRAINT otp_challenges_purpose_check;
ALTER TABLE otp_challenges ADD CONSTRAINT otp_challenges_purpose_check CHECK (purpose = 'register');

DROP VIEW v_customer_lists;
DROP VIEW v_driver_orders;
DROP VIEW v_customer_catalog;
DROP FUNCTION order_load(bigint);
DROP TRIGGER c_stop_proof ON pickup_stops;
DROP FUNCTION trg_stop_proof();
DROP TRIGGER b_txn_branch ON ledger_transactions;
DROP FUNCTION trg_txn_branch();
ALTER TABLE ledger_transactions DROP COLUMN branch_id;
CREATE OR REPLACE FUNCTION trg_stock_movement_before() RETURNS trigger AS $$
DECLARE src stock_movements; src_city text; dst_city text;
BEGIN
    IF writer_role() <> 'trigger' THEN
        PERFORM require_admin('warehouses');
        IF NEW.kind = 'pickup' THEN
            RAISE EXCEPTION 'derived_field_write: stock_movements.pickup' USING ERRCODE = 'restrict_violation';
        END IF;
        -- التكلفة مُدخل للإدخال وحده؛ غيره لقطة من متوسط المصدر
        IF NEW.kind <> 'intake' AND NEW.unit_cost IS NOT NULL THEN
            RAISE EXCEPTION 'derived_field_write: stock_movements.unit_cost' USING ERRCODE = 'restrict_violation';
        END IF;
    END IF;
    NEW.actor_role := actor_role();
    NEW.actor_id := actor_id();
    IF NEW.kind IN ('transfer_out', 'count_adjust', 'pickup') THEN
        NEW.unit_cost := coalesce((SELECT avg_cost FROM warehouse_stock
                                    WHERE warehouse_id = NEW.warehouse_id
                                      AND catalog_item_id = NEW.catalog_item_id), 0);
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

CREATE OR REPLACE FUNCTION trg_offer_after() RETURNS trigger AS $$
DECLARE item bigint; city_reprice boolean;
BEGIN
    FOR item IN SELECT catalog_item_id FROM catalog_item_sources WHERE offer_id = NEW.id LOOP
        PERFORM refresh_item_availability(item);
        IF TG_OP = 'UPDATE' AND NEW.purchase_price IS DISTINCT FROM OLD.purchase_price THEN
            SELECT cs.reprice_on_cost_change INTO city_reprice
              FROM catalog_items ci JOIN city_settings cs ON cs.city = ci.city WHERE ci.id = item;
            IF city_reprice IS TRUE AND EXISTS (SELECT 1 FROM catalog_item_pricing
                                                 WHERE catalog_item_id = item AND mode <> 'manual') THEN
                PERFORM reprice_item(item);
            ELSE
                UPDATE catalog_item_pricing SET needs_review = true WHERE catalog_item_id = item;
            END IF;
        END IF;
    END LOOP;
    RETURN NULL;
END $$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION trg_source_after() RETURNS trigger AS $$
DECLARE item bigint := coalesce(NEW.catalog_item_id, OLD.catalog_item_id);
BEGIN
    PERFORM refresh_item_availability(item);
    IF EXISTS (SELECT 1 FROM catalog_item_pricing WHERE catalog_item_id = item AND mode <> 'manual') THEN
        PERFORM reprice_item(item);
    END IF;
    RETURN NULL;
END $$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION trg_supplier_status_after() RETURNS trigger AS $$
DECLARE item bigint;
BEGIN
    IF NEW.status IS DISTINCT FROM OLD.status THEN
        FOR item IN SELECT DISTINCT cs.catalog_item_id FROM catalog_item_sources cs
                      JOIN supplier_offers o ON o.id = cs.offer_id WHERE o.supplier_id = NEW.id LOOP
            PERFORM refresh_item_availability(item);
        END LOOP;
    END IF;
    RETURN NULL;
END $$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION trg_order_item_before() RETURNS trigger AS $$
DECLARE o orders; r text; ci catalog_items; eff oos_policy;
BEGIN
    SELECT * INTO o FROM orders WHERE id = coalesce(NEW.order_id, OLD.order_id);
    r := writer_role();
    IF r <> 'trigger' THEN
        -- العميل حتى confirmed، وبعدها المالك وحده (§3.2)؛ لا تعديل بعد التسليم.
        IF r = 'customer' THEN
            IF o.status NOT IN ('draft', 'placed') THEN
                RAISE EXCEPTION 'order_locked_for_customer: %', o.status USING ERRCODE = 'check_violation';
            END IF;
            IF NOT EXISTS (SELECT 1 FROM customer_members WHERE customer_id = o.customer_id
                            AND user_id = actor_id()) THEN
                RAISE EXCEPTION 'forbidden_not_member' USING ERRCODE = 'insufficient_privilege';
            END IF;
        ELSIF r = 'admin' THEN
            PERFORM require_admin('orders');
            IF o.status IN ('draft', 'delivered', 'closed', 'cancelled') THEN
                RAISE EXCEPTION 'order_locked: %', o.status USING ERRCODE = 'check_violation';
            END IF;
        ELSE
            RAISE EXCEPTION 'forbidden_role: %', r USING ERRCODE = 'insufficient_privilege';
        END IF;
    END IF;
    IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;

    SELECT * INTO ci FROM catalog_items WHERE id = NEW.catalog_item_id;
    IF ci.city <> o.city THEN
        RAISE EXCEPTION 'item_city_mismatch' USING ERRCODE = 'check_violation';
    END IF;
    IF TG_OP = 'INSERT' THEN
        IF NEW.unit IS NOT NULL AND NEW.unit <> ci.unit THEN
            RAISE EXCEPTION 'unit_mismatch: catalog item sells %', ci.unit USING ERRCODE = 'check_violation';
        END IF;
        NEW.unit := ci.unit;
        -- صنف مخفي أو نافد لا يُضاف إلى السلة (§2.2)
        IF r <> 'trigger' AND (ci.visibility <> 'visible' OR NOT ci.is_available) THEN
            RAISE EXCEPTION 'item_not_orderable: %', ci.id USING ERRCODE = 'check_violation';
        END IF;
        -- سطر يُضاف بعد placed يُسعَّر لحظة إضافته (السعر محجوز لكل سطر منذ دخوله)
        IF o.status <> 'draft' THEN
            NEW.unit_price := ci.sale_price;
        END IF;
    ELSIF NEW.unit IS DISTINCT FROM OLD.unit OR NEW.catalog_item_id <> OLD.catalog_item_id THEN
        RAISE EXCEPTION 'order_item_identity_immutable' USING ERRCODE = 'restrict_violation';
    END IF;
    RETURN NEW;
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
                                    + cs.driver_pay_per_km * NEW.route_km, 3);
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

CREATE OR REPLACE FUNCTION order_fee(p_order bigint) RETURNS numeric AS $$
DECLARE o orders; cs city_settings; fee numeric;
BEGIN
    SELECT * INTO o FROM orders WHERE id = p_order;
    SELECT * INTO cs FROM city_settings WHERE city = o.city;
    IF cs.fee_mode IS NULL THEN PERFORM setting_missing(o.city, 'fee_mode'); END IF;
    IF cs.free_delivery_threshold IS NOT NULL AND o.subtotal >= cs.free_delivery_threshold THEN
        RETURN 0;
    END IF;
    IF cs.fee_mode = 'flat' THEN
        fee := cs.delivery_fee_flat;
    ELSE
        IF o.zone_id IS NULL THEN
            RAISE EXCEPTION 'zone_missing: order %', p_order USING ERRCODE = 'check_violation';
        END IF;
        SELECT z.fee INTO fee FROM delivery_zones z WHERE z.id = o.zone_id AND z.active;
        IF fee IS NULL THEN
            RAISE EXCEPTION 'zone_inactive: %', o.zone_id USING ERRCODE = 'check_violation';
        END IF;
    END IF;
    RETURN fee;
END $$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION trg_order_after() RETURNS trigger AS $$
DECLARE cs city_settings; l record;
BEGIN
    IF TG_OP = 'UPDATE' AND NEW.status IS NOT DISTINCT FROM OLD.status THEN RETURN NULL; END IF;
    INSERT INTO order_status_events (order_id, from_status, to_status, actor_role, actor_id, reason)
    VALUES (NEW.id, CASE WHEN TG_OP = 'UPDATE' THEN OLD.status END, NEW.status, writer_role(),
            actor_id(), CASE WHEN NEW.status = 'cancelled' THEN NEW.cancel_reason END);
    IF TG_OP = 'INSERT' THEN RETURN NULL; END IF;

    IF NEW.status = 'placed' THEN
        -- حجز السعر لحظة الطلب (§3.2)
        UPDATE order_items oi SET unit_price = ci.sale_price
          FROM catalog_items ci
         WHERE oi.order_id = NEW.id AND ci.id = oi.catalog_item_id;
        IF EXISTS (SELECT 1 FROM order_items oi JOIN catalog_items ci ON ci.id = oi.catalog_item_id
                    WHERE oi.order_id = NEW.id AND (ci.visibility <> 'visible' OR NOT ci.is_available)) THEN
            RAISE EXCEPTION 'item_not_orderable_at_place' USING ERRCODE = 'check_violation';
        END IF;
        IF NOT EXISTS (SELECT 1 FROM order_items WHERE order_id = NEW.id) THEN
            RAISE EXCEPTION 'order_empty' USING ERRCODE = 'check_violation';
        END IF;
        PERFORM refresh_order_totals(NEW.id);
        PERFORM check_min_order(NEW.id);
        -- الاعتماد الآلي (§3.2): تحت المبلغ المحدد يؤكَّد فوراً
        SELECT * INTO cs FROM city_settings WHERE city = NEW.city;
        IF cs.auto_confirm_max_amount IS NOT NULL
           AND (SELECT total FROM orders WHERE id = NEW.id) <= cs.auto_confirm_max_amount THEN
            UPDATE orders SET status = 'confirmed' WHERE id = NEW.id;
        END IF;
    ELSIF NEW.status = 'confirmed' AND OLD.status = 'placed' THEN
        PERFORM build_pickup_plan(NEW.id);
        PERFORM refresh_plan_complete(NEW.id);
    ELSIF NEW.status = 'confirmed' AND OLD.status = 'assigned' THEN
        UPDATE driver_pay_offers SET status = 'withdrawn'
         WHERE order_id = NEW.id AND status IN ('pending', 'accepted');
    ELSIF NEW.status = 'delivered' THEN
        PERFORM post_delivery(NEW.id);
    ELSIF NEW.status = 'cancelled' THEN
        -- تحرير الحجوزات
        UPDATE pickup_stops SET status = 'cancelled' WHERE order_id = NEW.id AND status = 'pending';
        FOR l IN SELECT DISTINCT psl.offer_id FROM pickup_stop_lines psl
                   JOIN pickup_stops s ON s.id = psl.stop_id
                  WHERE s.order_id = NEW.id AND psl.offer_id IS NOT NULL LOOP
            PERFORM refresh_offer_commitment(l.offer_id);
        END LOOP;
        FOR l IN SELECT DISTINCT s.warehouse_id, oi.catalog_item_id FROM pickup_stop_lines psl
                   JOIN pickup_stops s ON s.id = psl.stop_id
                   JOIN order_items oi ON oi.id = psl.order_item_id
                  WHERE s.order_id = NEW.id AND s.warehouse_id IS NOT NULL LOOP
            PERFORM refresh_warehouse_reservation(l.warehouse_id, l.catalog_item_id);
            PERFORM refresh_item_availability(l.catalog_item_id);
        END LOOP;
        FOR l IN SELECT DISTINCT oi.catalog_item_id FROM order_items oi WHERE oi.order_id = NEW.id LOOP
            PERFORM refresh_item_availability(l.catalog_item_id);
        END LOOP;
    END IF;
    RETURN NULL;
END $$ LANGUAGE plpgsql;

DROP FUNCTION post_cancellation(bigint);
DROP FUNCTION customer_cancel_allowed(order_status, cancel_policy);
DROP FUNCTION item_available_qty(bigint);
DROP TRIGGER a_guard_derived_below_cost ON catalog_items;
DROP TRIGGER catalog_cost_guard ON catalog_items;
DROP FUNCTION trg_catalog_cost_guard();
DROP FUNCTION refresh_cost_guard(bigint);
DROP FUNCTION item_cost_ref(bigint);
DROP FUNCTION fifo_cost(bigint, bigint, numeric);
ALTER TABLE stock_movements DROP COLUMN cost_method;
DROP TABLE stock_layers;
DROP FUNCTION current_cogs_method(text);
DROP TABLE cogs_method_periods;
DROP FUNCTION trg_cogs_period_before();

DROP TRIGGER a_guard_derived_0004 ON orders;
DROP INDEX one_draft_per_branch;
CREATE UNIQUE INDEX one_draft_per_customer ON orders (customer_id) WHERE status = 'draft';
ALTER TABLE orders DROP CONSTRAINT placed_orders_have_policies;
ALTER TABLE orders DROP CONSTRAINT order_branch_of_customer;
ALTER TABLE orders DROP COLUMN branch_id, DROP COLUMN area_id, DROP COLUMN cancel_policy,
                   DROP COLUMN oversell_policy, DROP COLUMN pickup_proof_required, DROP COLUMN cogs_method,
                   DROP COLUMN ready_for_owner_at;

DROP FUNCTION area_for_point(text, numeric, numeric);
DROP TRIGGER b_zone ON delivery_zones;
DROP FUNCTION trg_zone_before();
DROP TABLE delivery_areas;
DROP FUNCTION trg_area_before();
DROP FUNCTION point_in_polygon(numeric, numeric, jsonb);

DROP TRIGGER b_list_item ON recurring_list_items;
DROP FUNCTION trg_list_item_before();
DROP TRIGGER b_list ON recurring_lists;
DROP FUNCTION trg_list_before();
ALTER TABLE recurring_lists DROP CONSTRAINT list_name_per_branch;
ALTER TABLE recurring_lists ADD CONSTRAINT recurring_lists_customer_id_name_key UNIQUE (customer_id, name);
ALTER TABLE recurring_lists DROP CONSTRAINT list_branch_of_customer;
ALTER TABLE recurring_lists DROP COLUMN branch_id;
DROP FUNCTION require_branch_access(bigint, bigint);
DROP FUNCTION resolve_branch(bigint, bigint);
DROP TRIGGER zz_audit ON customer_members;
DROP TRIGGER b_member ON customer_members;
DROP FUNCTION trg_member_before();
DROP TRIGGER b_purchaser_mode ON customers;
DROP FUNCTION trg_purchaser_mode();
DROP TRIGGER customer_approved_branches ON customers;
DROP FUNCTION trg_customer_approved_branches();
DROP TRIGGER branch_pending_notice ON customer_locations;
DROP FUNCTION trg_branch_pending_notice();
DROP TRIGGER zz_audit ON customer_locations;
DROP TRIGGER b_branch ON customer_locations;
DROP FUNCTION trg_branch_before();
ALTER TABLE customer_members DROP CONSTRAINT purchaser_has_branch;
ALTER TABLE customer_members DROP CONSTRAINT member_branch_of_customer;
ALTER TABLE customer_members DROP COLUMN branch_id;
DROP FUNCTION actor_member(bigint);
ALTER TABLE customer_locations DROP CONSTRAINT branch_identity;
ALTER TABLE customer_locations DROP CONSTRAINT branch_name_unique;
ALTER TABLE customer_locations DROP CONSTRAINT branch_name_present;
ALTER TABLE customer_locations DROP COLUMN name, DROP COLUMN status, DROP COLUMN reviewed_by,
                               DROP COLUMN reviewed_at, DROP COLUMN created_at;
CREATE UNIQUE INDEX v1_one_active_location ON customer_locations (customer_id) WHERE active;

ALTER TABLE customers DROP COLUMN purchaser_mode;
ALTER TABLE catalog_items DROP COLUMN below_cost;
ALTER TABLE catalog_item_pricing DROP COLUMN reprice_override;
ALTER TABLE city_settings DROP COLUMN cancel_policy, DROP COLUMN oversell_policy, DROP COLUMN pickup_proof_required;
ALTER TABLE city_settings ALTER COLUMN reprice_on_cost_change DROP NOT NULL,
                          ALTER COLUMN reprice_on_cost_change DROP DEFAULT;

DROP FUNCTION notify_owners(text, text, text, jsonb, bigint);
ALTER TABLE notifications DROP CONSTRAINT notifications_kind_check;
ALTER TABLE notifications ADD CONSTRAINT notifications_kind_check CHECK (kind IN ('order_confirmed', 'order_assigned', 'batch_departure',
                                              'order_arrived', 'list_reminder', 'pickup_request',
                                              'driver_settlement', 'supplier_payout', 'broadcast',
                                              'otp'));

CREATE VIEW v_customer_catalog AS
SELECT ci.id, ci.city, ci.category_id, ci.name_ar, ci.name_en, ci.unit, ci.unit_size,
       ci.image_media_id, ci.sale_price, ci.is_available AS orderable,
       NOT ci.is_available AS out_of_stock
  FROM catalog_items ci
  JOIN city_settings cs ON cs.city = ci.city
 WHERE ci.visibility = 'visible'
   AND (ci.is_available OR coalesce(ci.oos_policy, cs.oos_policy) = 'mark_out');

CREATE VIEW v_driver_orders AS
SELECT o.id, o.city, o.status, o.driver_id, c.name AS customer_name, c.phone AS customer_phone,
       o.dest_lat, o.dest_lng, o.dest_address,
       greatest(0, o.total
                   - coalesce((SELECT sum(e.amount) FROM ledger_entries e
                                 JOIN ledger_transactions t ON t.id = e.transaction_id
                                 JOIN ledger_accounts la ON la.id = e.account_id
                                WHERE t.order_id = o.id AND t.kind = 'collection' AND la.kind = 'driver_cash'), 0)
                   - customer_credit_available(o.customer_id)) AS amount_to_collect,
       o.driver_pay, o.collection_mode
  FROM orders o JOIN customers c ON c.id = o.customer_id
 WHERE o.status NOT IN ('draft', 'placed');

CREATE VIEW v_customer_lists AS
SELECT rl.id, rl.customer_id, rl.name, rl.reminder_days, rl.reminder_time,
       EXISTS (SELECT 1 FROM recurring_list_items li JOIN catalog_items ci ON ci.id = li.catalog_item_id
                WHERE li.list_id = rl.id AND (ci.visibility <> 'visible' OR NOT ci.is_available)) AS has_unavailable
  FROM recurring_lists rl;

DROP TYPE password_reset_method;
DROP TYPE otp_channel_kind;
DROP TYPE purchaser_mode;
DROP TYPE cogs_method;
DROP TYPE oversell_policy;
DROP TYPE cancel_policy;
