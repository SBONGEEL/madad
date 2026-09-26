-- ═══════════════════════════════════════════════════════════════════════════
-- مَدَد — الترحيلة 0002: قرارات المالك (2026-09-26)
-- M-1 ثلاث خانات · M-2 اسم المورد للسائق · M-3 إثبات الاستلام بطريقتين
-- M-4 التصنيفات · M-10 النزاع في الدفتر · M-11 طريقة صرف أجر السائق
-- M-14 كلمة المرور بعد OTP واحد · M-19 ما يراه العميل من السائق
-- المرجع: SPEC-MADAD.md §12-د. لا تعديل على 0001: كل تغيير هنا إضافة أو استبدال دالة.
-- ═══════════════════════════════════════════════════════════════════════════
SET search_path = madad, public;
SELECT set_config('madad.actor_role', 'system', true);

-- ——— M-1: كل المبالغ بثلاث خانات عشرية ——————————————————————————————————
ALTER DOMAIN money_lyd DROP CONSTRAINT money_precision;
ALTER DOMAIN money_lyd ADD CONSTRAINT money_precision CHECK (VALUE = round(VALUE, 3));
ALTER TABLE catalog_item_pricing DROP CONSTRAINT catalog_item_pricing_margin_value_check;
ALTER TABLE catalog_item_pricing ADD CONSTRAINT catalog_item_pricing_margin_value_check
    CHECK (margin_value >= 0 AND margin_value = round(margin_value, 3));
ALTER TABLE stock_movements DROP CONSTRAINT stock_movements_check;
ALTER TABLE stock_movements ADD CONSTRAINT stock_movements_check
    CHECK (kind <> 'intake' OR (qty_delta > 0 AND unit_cost > 0 AND unit_cost = round(unit_cost, 3)));
-- العمود المولَّد لا يُعدَّل تعبيره في PostgreSQL 16: يُسقط ويُعاد بالتقريب الجديد.
ALTER TABLE order_items DROP COLUMN line_total;
ALTER TABLE order_items ADD COLUMN line_total numeric GENERATED ALWAYS AS (round(qty * unit_price, 3)) STORED;

-- نوع حركة لصرف أجر السائق (يُستعمل وقت التشغيل لا في هذه الترحيلة)
ALTER TYPE ledger_txn_kind ADD VALUE IF NOT EXISTS 'driver_payout';

-- الدوال التي تقرّب: نسخها من 0001 بثلاث خانات (post_delivery يطرح رصيد العميل أيضاً — M-10)
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
        price := CASE p.mode WHEN 'margin_pct' THEN round(base * (1 + p.margin_value / 100), 3)
                             ELSE round(base + p.margin_value, 3) END;
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
        SELECT coalesce(sum(round(bl.qty * oi.unit_price, 3)), 0) INTO value
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

-- السلة: السعر الحيّ بالتقريب الجديد
CREATE OR REPLACE VIEW v_customer_order_lines AS
SELECT oi.id, oi.order_id, oi.catalog_item_id, ci.name_ar, oi.unit, ci.unit_size, oi.qty,
       coalesce(oi.unit_price, ci.sale_price) AS unit_price,
       round(oi.qty * coalesce(oi.unit_price, ci.sale_price), 3) AS line_total,
       oi.delivered_qty
  FROM order_items oi JOIN catalog_items ci ON ci.id = oi.catalog_item_id;


-- ——— M-2 وM-19: إعدادات الإظهار — يتحكم فيها المالك من اللوحة ——————————————
-- القيمة الأولى «مغلق» (العزل هو الأصل في §0)، والمالك يفتحها.
ALTER TABLE city_settings
    ADD COLUMN driver_sees_supplier_name boolean NOT NULL DEFAULT false,
    ADD COLUMN customer_sees_driver_name boolean NOT NULL DEFAULT false,
    ADD COLUMN customer_can_call_driver  boolean NOT NULL DEFAULT false;

-- M-2: تسمية نقطة الاستلام عند السائق. الاسم لا يخرج من هنا إلا والإعداد مفتوح.
CREATE VIEW v_driver_stop_labels AS
SELECT s.id AS stop_id, s.order_id,
       CASE WHEN s.source = 'warehouse' THEN w.name
            WHEN cs.driver_sees_supplier_name THEN sp.name
            ELSE 'نقطة استلام ' || s.seq END AS pickup_label
  FROM pickup_stops s
  JOIN orders o ON o.id = s.order_id
  JOIN city_settings cs ON cs.city = o.city
  LEFT JOIN suppliers sp ON sp.id = s.supplier_id
  LEFT JOIN warehouses w ON w.id = s.warehouse_id
 WHERE s.status <> 'cancelled';

-- M-19: ما يراه العميل من سائق طلبيته. المغلق NULL هنا، ومخطط الخرج يسقطه.
CREATE VIEW v_customer_order_driver AS
SELECT o.id AS order_id, o.customer_id,
       CASE WHEN cs.customer_sees_driver_name THEN split_part(btrim(d.full_name), ' ', 1) END AS driver_first_name,
       CASE WHEN cs.customer_can_call_driver THEN d.phone END AS driver_phone
  FROM orders o
  JOIN city_settings cs ON cs.city = o.city
  JOIN drivers d ON d.id = o.driver_id
 WHERE o.status IN ('assigned', 'collecting', 'partially_delivered');


-- ——— M-3: إثبات الاستلام عند المورد بطريقتين ——————————————————————————————
-- (أ) السائق يعرض QR فيه pickup_code والمورد يمسحه · (ب) المورد يعطي supplier_code والسائق يكتبه.
-- كل طرف يرى سرّه وحده: السائق لا يرى supplier_code، والمورد لا يرى pickup_code.
CREATE TYPE handover_method AS ENUM ('qr_scan', 'code_entry');

ALTER TABLE pickup_stops ADD COLUMN supplier_code text NOT NULL
    DEFAULT lpad(((('x' || encode(public.gen_random_bytes(4), 'hex'))::bit(32)::bigint % 1000000))::text, 6, '0')
    CHECK (supplier_code ~ '^[0-9]{6}$');

CREATE FUNCTION trg_stop_codes_immutable() RETURNS trigger AS $$
BEGIN
    IF NEW.supplier_code <> OLD.supplier_code THEN
        RAISE EXCEPTION 'derived_field_write: pickup_stops.supplier_code' USING ERRCODE = 'restrict_violation';
    END IF;
    RETURN NEW;
END $$ LANGUAGE plpgsql;
CREATE TRIGGER a_guard_stop_codes BEFORE UPDATE ON pickup_stops FOR EACH ROW EXECUTE FUNCTION trg_stop_codes_immutable();

CREATE TABLE pickup_handovers (
    stop_id    bigint PRIMARY KEY REFERENCES pickup_stops(id),
    method     handover_method NOT NULL,
    code_given text NOT NULL CHECK (code_given ~ '^[0-9]{6}$'),
    actor_role actor_role NOT NULL,        -- ◆
    actor_id   bigint NOT NULL,            -- ◆
    created_at timestamptz NOT NULL DEFAULT now()
);

CREATE FUNCTION trg_handover_before() RETURNS trigger AS $$
DECLARE s pickup_stops; o orders; r text;
BEGIN
    r := writer_role();
    SELECT * INTO s FROM pickup_stops WHERE id = NEW.stop_id;
    SELECT * INTO o FROM orders WHERE id = s.order_id;
    IF s.source <> 'supplier' THEN
        RAISE EXCEPTION 'handover_supplier_stops_only' USING ERRCODE = 'check_violation';
    END IF;
    IF s.status <> 'pending' OR o.status NOT IN ('assigned', 'collecting', 'partially_delivered') THEN
        RAISE EXCEPTION 'stop_locked' USING ERRCODE = 'check_violation';
    END IF;
    IF NEW.method = 'qr_scan' THEN
        -- المورد يمسح QR السائق
        IF r <> 'supplier' OR NOT EXISTS (SELECT 1 FROM supplier_members
                                           WHERE supplier_id = s.supplier_id AND user_id = actor_id()) THEN
            RAISE EXCEPTION 'forbidden_handover: qr_scan is done by the stop''s supplier' USING ERRCODE = 'insufficient_privilege';
        END IF;
        IF NEW.code_given <> s.pickup_code THEN
            RAISE EXCEPTION 'pickup_code_mismatch' USING ERRCODE = 'check_violation';
        END IF;
    ELSE
        -- السائق يكتب رقم المورد
        IF r <> 'driver' OR o.driver_id IS DISTINCT FROM (SELECT id FROM drivers WHERE user_id = actor_id()) THEN
            RAISE EXCEPTION 'forbidden_handover: code_entry is done by the assigned driver' USING ERRCODE = 'insufficient_privilege';
        END IF;
        IF NEW.code_given <> s.supplier_code THEN
            RAISE EXCEPTION 'pickup_code_mismatch' USING ERRCODE = 'check_violation';
        END IF;
    END IF;
    NEW.actor_role := actor_role();
    NEW.actor_id := actor_id();
    RETURN NEW;
END $$ LANGUAGE plpgsql;
CREATE TRIGGER a_guard_derived BEFORE INSERT OR UPDATE ON pickup_handovers FOR EACH ROW
    EXECUTE FUNCTION guard_derived('actor_role:null', 'actor_id:null');
CREATE TRIGGER b_handover BEFORE INSERT ON pickup_handovers FOR EACH ROW EXECUTE FUNCTION trg_handover_before();
CREATE TRIGGER z_append_only BEFORE UPDATE OR DELETE ON pickup_handovers FOR EACH ROW EXECUTE FUNCTION guard_append_only();
CREATE TRIGGER zz_audit AFTER INSERT ON pickup_handovers FOR EACH ROW EXECUTE FUNCTION trg_audit('stop_id');

-- المورد يرى رقمه هو (supplier_code) لا كود السائق.
DROP VIEW v_supplier_pickups;
CREATE VIEW v_supplier_pickups AS
SELECT s.id, s.supplier_id, s.pickup_location_id, s.status, s.supplier_code, o.assigned_at,
       (h.stop_id IS NOT NULL) AS handed_over,
       l.id AS line_id, p.name_ar AS product_name, so.unit, so.unit_size, l.planned_qty, l.collected_qty
  FROM pickup_stops s
  JOIN orders o ON o.id = s.order_id
  JOIN pickup_stop_lines l ON l.stop_id = s.id
  JOIN supplier_offers so ON so.id = l.offer_id
  JOIN products p ON p.id = so.product_id
  LEFT JOIN pickup_handovers h ON h.stop_id = s.id
 WHERE s.source = 'supplier' AND s.status <> 'cancelled'
   AND o.status IN ('assigned', 'collecting', 'partially_delivered', 'delivered', 'closed');


-- ——— M-4: التصنيفات العشر رئيسية وتحتها الفروع؛ الإدارة تضيف مباشرة والمورد يقترح ——
CREATE FUNCTION trg_categories_before() RETURNS trigger AS $$
BEGIN
    IF writer_role() IN ('trigger', 'system') THEN RETURN coalesce(NEW, OLD); END IF;
    PERFORM require_admin('catalog');
    RETURN coalesce(NEW, OLD);
END $$ LANGUAGE plpgsql;
CREATE TRIGGER b_categories BEFORE INSERT OR UPDATE OR DELETE ON categories FOR EACH ROW EXECUTE FUNCTION trg_categories_before();

CREATE FUNCTION trg_products_before() RETURNS trigger AS $$
DECLARE r text; sup bigint;
BEGIN
    r := writer_role();
    IF r IN ('trigger', 'system') THEN RETURN NEW; END IF;
    IF r = 'admin' THEN
        PERFORM require_admin('catalog');
        RETURN NEW;
    END IF;
    IF r = 'supplier' AND TG_OP = 'INSERT' THEN
        SELECT supplier_id INTO sup FROM supplier_members WHERE user_id = actor_id();
        IF NEW.status <> 'proposed' OR NEW.proposed_by_supplier_id IS DISTINCT FROM sup THEN
            RAISE EXCEPTION 'supplier_may_only_propose' USING ERRCODE = 'insufficient_privilege';
        END IF;
        RETURN NEW;
    END IF;
    RAISE EXCEPTION 'forbidden_role: % on products', r USING ERRCODE = 'insufficient_privilege';
END $$ LANGUAGE plpgsql;
CREATE TRIGGER b_products BEFORE INSERT OR UPDATE ON products FOR EACH ROW EXECUTE FUNCTION trg_products_before();

-- البذور: العشر بأيقونات الهوية، وفروع §2.2 تحت أصحابها.
INSERT INTO categories (name_ar, name_en, icon_key, sort) VALUES
 ('مواد غذائية', 'Food', 'food', 1), ('مشروبات', 'Beverages', 'beverages', 2),
 ('أدوات مطبخ', 'Kitchen tools', 'kitchen_tools', 3), ('مستلزمات نظافة', 'Cleaning supplies', 'cleaning', 4),
 ('تغليف وعبوات', 'Packaging', 'packaging', 5), ('مستلزمات عامة', 'General supplies', 'general', 6),
 ('معدات', 'Equipment', 'equipment', 7), ('مبردات وتبريد', 'Cooling', 'cooling', 8),
 ('منتجات ورقية', 'Paper products', 'paper', 9), ('مزيد', 'More', 'more', 10);
INSERT INTO categories (parent_id, name_ar, name_en, sort)
SELECT p.id, c.name_ar, c.name_en, c.sort
  FROM (VALUES ('food', 'لحوم', 'Meat', 1), ('food', 'دواجن', 'Poultry', 2), ('food', 'خضار وفواكه', 'Fruit & vegetables', 3),
               ('food', 'ألبان وأجبان', 'Dairy & cheese', 4), ('food', 'معلبات', 'Canned goods', 5), ('food', 'بقالة جافة', 'Dry groceries', 6),
               ('beverages', 'مشروبات', 'Drinks', 1), ('beverages', 'قهوة ومستلزماتها', 'Coffee & supplies', 2),
               ('packaging', 'تغليف وأدوات تقديم', 'Packaging & serving', 1),
               ('cleaning', 'تنظيف', 'Cleaning', 1),
               ('equipment', 'معدات صغيرة', 'Small equipment', 1)) AS c(parent_key, name_ar, name_en, sort)
  JOIN categories p ON p.icon_key = c.parent_key AND p.parent_id IS NULL;


-- ——— M-10: الاسترداد وتحمّل الخسارة يقررهما المالك لكل نزاع، وكلها قيود ——————
CREATE TYPE refund_method AS ENUM ('credit_next_order', 'cash_via_driver');
CREATE TYPE loss_bearer AS ENUM ('supplier', 'madad', 'driver');

ALTER TABLE disputes
    ADD COLUMN refund_method refund_method,
    ADD COLUMN refund_driver_id bigint REFERENCES drivers(id),
    ADD COLUMN loss_bearer loss_bearer,
    ADD COLUMN loss_supplier_id bigint REFERENCES suppliers(id),
    ADD COLUMN loss_driver_id bigint REFERENCES drivers(id),
    ADD COLUMN ledger_posted boolean NOT NULL DEFAULT false,            -- ◆
    ADD CONSTRAINT dispute_money_needs_decision CHECK (
        status <> 'resolved' OR coalesce(resolution_amount, 0) = 0
        OR (refund_method IS NOT NULL AND loss_bearer IS NOT NULL)),
    ADD CONSTRAINT dispute_cash_refund_driver CHECK (
        refund_method IS DISTINCT FROM 'cash_via_driver' OR refund_driver_id IS NOT NULL),
    ADD CONSTRAINT dispute_loss_party CHECK (
        (loss_bearer IS DISTINCT FROM 'supplier' OR loss_supplier_id IS NOT NULL)
        AND (loss_bearer IS DISTINCT FROM 'driver' OR loss_driver_id IS NOT NULL));

CREATE FUNCTION trg_dispute_before() RETURNS trigger AS $$
BEGIN
    IF writer_role() = 'trigger' THEN RETURN NEW; END IF;
    IF OLD.status = 'resolved' THEN
        RAISE EXCEPTION 'dispute_already_resolved' USING ERRCODE = 'check_violation';
    END IF;
    IF NEW.status IS DISTINCT FROM OLD.status OR NEW.resolution IS DISTINCT FROM OLD.resolution THEN
        PERFORM require_admin('orders');
    END IF;
    RETURN NEW;
END $$ LANGUAGE plpgsql;
CREATE TRIGGER a_guard_derived BEFORE INSERT OR UPDATE ON disputes FOR EACH ROW
    EXECUTE FUNCTION guard_derived('ledger_posted:false');
CREATE TRIGGER b_dispute BEFORE UPDATE ON disputes FOR EACH ROW EXECUTE FUNCTION trg_dispute_before();

-- القيود عند القرار: العميل يُدان له بالمبلغ؛ ثم يُرد نقداً عبر سائق أو يبقى رصيداً للطلبية القادمة؛
-- والخسارة على المورد (من مستحقاته) أو السائق (من محفظته) أو تبقى على مَدَد.
CREATE FUNCTION trg_dispute_post() RETURNS trigger AS $$
DECLARE o orders; a numeric; lines jsonb; held numeric;
BEGIN
    IF NEW.status <> 'resolved' OR OLD.status = 'resolved' OR coalesce(NEW.resolution_amount, 0) = 0 THEN
        RETURN NULL;
    END IF;
    SELECT * INTO o FROM orders WHERE id = NEW.order_id;
    a := NEW.resolution_amount;
    lines := jsonb_build_array(
        jsonb_build_array(ledger_account('sales_adjustment', o.city), a),
        jsonb_build_array(ledger_account('customer_receivable', o.city, o.customer_id), -a));
    IF NEW.refund_method = 'cash_via_driver' THEN
        held := ledger_balance('driver_cash', o.city, NEW.refund_driver_id);
        IF a > held THEN
            RAISE EXCEPTION 'refund_exceeds_driver_cash: % > %', a, held USING ERRCODE = 'check_violation';
        END IF;
        lines := lines || jsonb_build_array(
            jsonb_build_array(ledger_account('customer_receivable', o.city, o.customer_id), a),
            jsonb_build_array(ledger_account('driver_cash', o.city, NEW.refund_driver_id), -a));
    END IF;
    IF NEW.loss_bearer = 'supplier' THEN
        lines := lines || jsonb_build_array(
            jsonb_build_array(ledger_account('supplier_payable', o.city, NEW.loss_supplier_id), a),
            jsonb_build_array(ledger_account('sales_adjustment', o.city), -a));
    ELSIF NEW.loss_bearer = 'driver' THEN
        lines := lines || jsonb_build_array(
            jsonb_build_array(ledger_account('driver_wallet', o.city, NEW.loss_driver_id), a),
            jsonb_build_array(ledger_account('sales_adjustment', o.city), -a));
    END IF;
    PERFORM ledger_post('dispute_adjustment', o.city, 'قرار نزاع', lines,
                        p_order => o.id, p_ref_table => 'disputes', p_ref_id => NEW.id);
    UPDATE disputes SET ledger_posted = true WHERE id = NEW.id;
    RETURN NULL;
END $$ LANGUAGE plpgsql;
CREATE TRIGGER dispute_post AFTER UPDATE ON disputes FOR EACH ROW EXECUTE FUNCTION trg_dispute_post();

-- رصيد العميل المتاح (من نزاعات) = ما له علينا ناقص ما دفعه مقدّماً على دفعات طلبيات لم تُسلَّم.
CREATE FUNCTION customer_credit_available(p_customer bigint) RETURNS numeric AS $$
    SELECT greatest(0, -coalesce((SELECT balance FROM ledger_accounts
                                   WHERE kind = 'customer_receivable' AND customer_id = p_customer), 0)
                       - coalesce((SELECT -sum(e.amount) FROM ledger_entries e
                                     JOIN ledger_transactions t ON t.id = e.transaction_id
                                     JOIN ledger_accounts la ON la.id = e.account_id
                                     JOIN orders o ON o.id = t.order_id
                                    WHERE t.kind = 'collection' AND la.kind = 'customer_receivable'
                                      AND la.customer_id = p_customer
                                      AND o.status IN ('collecting', 'partially_delivered')), 0))
$$ LANGUAGE sql STABLE;

-- المبلغ الذي يحصّله السائق ينقص منه رصيد العميل (M-10).
CREATE OR REPLACE VIEW v_driver_orders AS
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


-- ——— M-11: طريقة صرف أجر السائق تُختار عند اعتماده، بلا قيمة افتراضية ——————————
CREATE TYPE driver_pay_method AS ENUM ('offset_on_settlement', 'periodic');
ALTER TABLE drivers ADD COLUMN pay_method driver_pay_method;
ALTER TABLE drivers ADD CONSTRAINT pay_method_on_approval CHECK (status <> 'approved' OR pay_method IS NOT NULL);

CREATE FUNCTION trg_driver_pay_method() RETURNS trigger AS $$
BEGIN
    IF NEW.pay_method IS DISTINCT FROM OLD.pay_method AND writer_role() <> 'trigger' THEN
        PERFORM require_admin('money');
    END IF;
    RETURN NEW;
END $$ LANGUAGE plpgsql;
CREATE TRIGGER b_driver_pay_method BEFORE UPDATE ON drivers FOR EACH ROW EXECUTE FUNCTION trg_driver_pay_method();

-- المقاصّة عند التسوية: جزء من الكاش يبقى معه أجراً. يسبق مشغّل التسليم أبجدياً،
-- فيُفحص المبلغ المسلَّم بعد المقاصّة على ما بقي بيده.
ALTER TABLE cash_handovers ADD COLUMN wallet_offset money_lyd NOT NULL DEFAULT 0 CHECK (wallet_offset >= 0);

CREATE FUNCTION trg_cash_handover_offset() RETURNS trigger AS $$
DECLARE d drivers; owed numeric; held numeric;
BEGIN
    IF NEW.wallet_offset = 0 THEN RETURN NULL; END IF;
    PERFORM require_admin('money');
    SELECT * INTO d FROM drivers WHERE id = NEW.driver_id;
    IF d.pay_method IS DISTINCT FROM 'offset_on_settlement' THEN
        RAISE EXCEPTION 'pay_method_not_offset: driver %', d.id USING ERRCODE = 'check_violation';
    END IF;
    owed := -ledger_balance('driver_wallet', d.city, d.id);
    held := ledger_balance('driver_cash', d.city, d.id);
    IF NEW.wallet_offset > owed OR NEW.wallet_offset > held THEN
        RAISE EXCEPTION 'offset_exceeds: % > owed % or held %', NEW.wallet_offset, owed, held
            USING ERRCODE = 'check_violation';
    END IF;
    PERFORM ledger_post('cash_handover', d.city, 'أجر مقتطع من الكاش', jsonb_build_array(
        jsonb_build_array(ledger_account('driver_wallet', d.city, d.id), NEW.wallet_offset),
        jsonb_build_array(ledger_account('driver_cash', d.city, d.id), -NEW.wallet_offset)),
        p_ref_table => 'cash_handovers', p_ref_id => NEW.id);
    RETURN NULL;
END $$ LANGUAGE plpgsql;
CREATE TRIGGER cash_handover_offset AFTER INSERT ON cash_handovers FOR EACH ROW EXECUTE FUNCTION trg_cash_handover_offset();

-- الصرف الدوري: مصدر حركة لا محفظة؛ الرصيد في الدفتر وحده.
CREATE TABLE driver_payouts (
    id         bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    driver_id  bigint NOT NULL REFERENCES drivers(id),
    amount     money_lyd NOT NULL CHECK (amount > 0),
    paid_by    bigint NOT NULL REFERENCES app_users(id),
    note       text,
    created_at timestamptz NOT NULL DEFAULT now()
);
CREATE FUNCTION trg_driver_payout() RETURNS trigger AS $$
DECLARE d drivers; owed numeric;
BEGIN
    PERFORM require_admin('money');
    SELECT * INTO d FROM drivers WHERE id = NEW.driver_id;
    IF d.pay_method IS DISTINCT FROM 'periodic' THEN
        RAISE EXCEPTION 'pay_method_not_periodic: driver %', d.id USING ERRCODE = 'check_violation';
    END IF;
    owed := -ledger_balance('driver_wallet', d.city, d.id);
    IF NEW.amount > owed THEN
        RAISE EXCEPTION 'payout_exceeds_wallet: % > %', NEW.amount, owed USING ERRCODE = 'check_violation';
    END IF;
    PERFORM ledger_post('driver_payout', d.city, 'صرف أجر سائق', jsonb_build_array(
        jsonb_build_array(ledger_account('driver_wallet', d.city, d.id), NEW.amount),
        jsonb_build_array(ledger_account('treasury', d.city), -NEW.amount)),
        p_ref_table => 'driver_payouts', p_ref_id => NEW.id);
    RETURN NULL;
END $$ LANGUAGE plpgsql;
CREATE TRIGGER driver_payout_post AFTER INSERT ON driver_payouts FOR EACH ROW EXECUTE FUNCTION trg_driver_payout();
CREATE TRIGGER z_append_only BEFORE UPDATE OR DELETE ON driver_payouts FOR EACH ROW EXECUTE FUNCTION guard_append_only();


-- ——— M-14: OTP مرة واحدة عند التسجيل، ثم الهاتف وكلمة المرور ——————————————
-- كلمة المرور تُخزَّن بـbcrypt وحده: نصّ لا يطابق صيغته يُرفض، فلا تُخزَّن كلمة مرور صريحة أبداً.
ALTER TABLE app_users
    ADD COLUMN phone_verified_at timestamptz,
    ADD COLUMN password_hash text
        CONSTRAINT password_hash_bcrypt CHECK (password_hash IS NULL OR password_hash ~ '^\$2[aby]\$[0-9]{2}\$[./A-Za-z0-9]{53}$'),
    ADD COLUMN password_set_at timestamptz,
    ADD CONSTRAINT password_after_verification CHECK (password_hash IS NULL OR phone_verified_at IS NOT NULL);

ALTER TABLE otp_challenges
    ADD COLUMN purpose text NOT NULL DEFAULT 'register' CHECK (purpose = 'register'),
    ADD COLUMN channel text CHECK (channel IN ('whatsapp', 'sms'));
-- رمز التحقق يُستهلك مرة واحدة فقط لكل (رقم + نوع حساب).
CREATE UNIQUE INDEX otp_register_once ON otp_challenges (phone, audience) WHERE consumed_at IS NOT NULL;


-- ——— سجل الكتّاب ——————————————————————————————————————————————————————
INSERT INTO derived_fields (table_name, column_name, writer, source) VALUES
 ('pickup_handovers', 'actor_role', 'trg_handover_before', 'الجلسة'),
 ('pickup_handovers', 'actor_id',   'trg_handover_before', 'الجلسة'),
 ('disputes', 'ledger_posted',      'trg_dispute_post', 'قيود قرار النزاع');
