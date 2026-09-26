-- ═══════════════════════════════════════════════════════════════════════════
-- مَدَد — الترحيلة 0008: قرارات المالك، الدفعة الرابعة (2026-09-26، §12-ز)
-- م-27 تداخل المناطق المرسومة · م-28 تكلفة أصناف مخزن مَدَد
-- ═══════════════════════════════════════════════════════════════════════════
SET search_path = madad, public;
SELECT set_config('madad.actor_role', 'system', true);

CREATE TYPE area_overlap_rule   AS ENUM ('stop', 'higher', 'lower');
CREATE TYPE warehouse_cost_mode AS ENUM ('auto', 'manual');

ALTER TABLE notifications DROP CONSTRAINT notifications_kind_check;
ALTER TABLE notifications ADD CONSTRAINT notifications_kind_check CHECK (kind IN (
    'order_confirmed', 'order_assigned', 'batch_departure', 'order_arrived', 'list_reminder',
    'pickup_request', 'driver_settlement', 'supplier_payout', 'broadcast', 'otp',
    'price_changed', 'below_cost', 'plan_short', 'otp_channel_failed', 'order_awaiting_owner',
    'branch_pending', 'weight_over_capacity', 'area_overlap', 'cost_missing'));


-- ——— م-27: تداخل منطقتين مرسومتين بأجرتين مختلفتين ————————————————————————————————
ALTER TABLE city_settings ADD COLUMN area_overlap_rule area_overlap_rule NOT NULL DEFAULT 'stop';
ALTER TABLE orders ADD COLUMN area_overlap_rule area_overlap_rule;                  -- ◆ لقطة عند placed
CREATE TRIGGER a_guard_derived_0008 BEFORE INSERT OR UPDATE ON orders FOR EACH ROW
    EXECUTE FUNCTION guard_derived('area_overlap_rule:null');

-- المنطقة التي تُحسب للنقطة: واحدة، أو برسم واحد، أو بقاعدة المالك عند اختلاف الرسوم.
CREATE OR REPLACE FUNCTION area_for_point(p_city text, p_lat numeric, p_lng numeric) RETURNS bigint AS $$
DECLARE fees int; a bigint; rule area_overlap_rule;
BEGIN
    SELECT count(DISTINCT fee), min(id) INTO fees, a FROM delivery_areas
     WHERE city = p_city AND active AND point_in_polygon(p_lat, p_lng, polygon);
    IF fees <= 1 THEN RETURN a; END IF;
    SELECT area_overlap_rule INTO rule FROM city_settings WHERE city = p_city;
    IF rule = 'stop' THEN
        RAISE EXCEPTION 'area_overlap: overlapping areas with different fees' USING ERRCODE = 'check_violation';
    END IF;
    SELECT id INTO a FROM delivery_areas WHERE city = p_city AND active AND point_in_polygon(p_lat, p_lng, polygon)
     ORDER BY CASE WHEN rule = 'higher' THEN -fee ELSE fee END, id LIMIT 1;
    RETURN a;
END $$ LANGUAGE plpgsql STABLE;

CREATE FUNCTION trg_order_overlap_snapshot() RETURNS trigger AS $$
BEGIN
    IF NEW.status = 'placed' AND OLD.status IS DISTINCT FROM 'placed' THEN
        NEW.area_overlap_rule := (SELECT area_overlap_rule FROM city_settings WHERE city = NEW.city);
    END IF;
    RETURN NEW;
END $$ LANGUAGE plpgsql;
CREATE TRIGGER c_order_overlap_rule BEFORE UPDATE ON orders FOR EACH ROW EXECUTE FUNCTION trg_order_overlap_snapshot();

-- تقاطع مضلّعين (بلا PostGIS): رأس أحدهما داخل الآخر، أو ضلعان يتقاطعان.
CREATE FUNCTION segments_cross(ay numeric, ax numeric, by_ numeric, bx numeric,
                               cy numeric, cx numeric, dy numeric, dx numeric) RETURNS boolean AS $$
DECLARE d1 numeric; d2 numeric; d3 numeric; d4 numeric;
BEGIN
    d1 := (dx - cx) * (ay - cy) - (dy - cy) * (ax - cx);
    d2 := (dx - cx) * (by_ - cy) - (dy - cy) * (bx - cx);
    d3 := (bx - ax) * (cy - ay) - (by_ - ay) * (cx - ax);
    d4 := (bx - ax) * (dy - ay) - (by_ - ay) * (dx - ax);
    RETURN (d1 > 0) <> (d2 > 0) AND (d3 > 0) <> (d4 > 0) AND d1 <> 0 AND d2 <> 0 AND d3 <> 0 AND d4 <> 0;
END $$ LANGUAGE plpgsql IMMUTABLE;

CREATE FUNCTION polygons_overlap(p jsonb, q jsonb) RETURNS boolean AS $$
DECLARE n int := jsonb_array_length(p); m int := jsonb_array_length(q); i int; j int;
BEGIN
    FOR i IN 0 .. n - 1 LOOP
        IF point_in_polygon((p -> i ->> 0)::numeric, (p -> i ->> 1)::numeric, q) THEN RETURN true; END IF;
    END LOOP;
    FOR j IN 0 .. m - 1 LOOP
        IF point_in_polygon((q -> j ->> 0)::numeric, (q -> j ->> 1)::numeric, p) THEN RETURN true; END IF;
    END LOOP;
    FOR i IN 0 .. n - 1 LOOP
        FOR j IN 0 .. m - 1 LOOP
            IF segments_cross((p -> i ->> 0)::numeric, (p -> i ->> 1)::numeric,
                              (p -> ((i + 1) % n) ->> 0)::numeric, (p -> ((i + 1) % n) ->> 1)::numeric,
                              (q -> j ->> 0)::numeric, (q -> j ->> 1)::numeric,
                              (q -> ((j + 1) % m) ->> 0)::numeric, (q -> ((j + 1) % m) ->> 1)::numeric) THEN
                RETURN true;
            END IF;
        END LOOP;
    END LOOP;
    RETURN false;
END $$ LANGUAGE plpgsql IMMUTABLE;

-- ما يراه المالك: كل زوج منطقتين متداخلتين برسمين مختلفين، والفروع الواقعة فيهما معاً.
CREATE VIEW v_area_overlaps AS
SELECT a.city, a.id AS area_a, a.name_ar AS name_a, a.fee AS fee_a, b.id AS area_b, b.name_ar AS name_b, b.fee AS fee_b,
       coalesce((SELECT jsonb_agg(jsonb_build_object('branch_id', br.id, 'branch', c.name || ' — ' || br.name))
                   FROM customer_locations br JOIN customers c ON c.id = br.customer_id
                  WHERE br.city = a.city AND br.active
                    AND point_in_polygon(br.lat, br.lng, a.polygon) AND point_in_polygon(br.lat, br.lng, b.polygon)),
                '[]'::jsonb) AS branches
  FROM delivery_areas a JOIN delivery_areas b ON b.city = a.city AND b.id > a.id
 WHERE a.active AND b.active AND a.fee <> b.fee AND polygons_overlap(a.polygon, b.polygon);

-- تنبيه عند حفظ منطقة ترسم تداخلاً جديداً.
CREATE FUNCTION trg_area_overlap_notice() RETURNS trigger AS $$
DECLARE o record;
BEGIN
    IF NOT NEW.active THEN RETURN NULL; END IF;
    FOR o IN SELECT * FROM v_area_overlaps WHERE city = NEW.city AND (area_a = NEW.id OR area_b = NEW.id) LOOP
        IF TG_OP = 'UPDATE' AND polygons_overlap(OLD.polygon, (SELECT polygon FROM delivery_areas
               WHERE id = CASE WHEN o.area_a = NEW.id THEN o.area_b ELSE o.area_a END))
           AND OLD.fee IS NOT DISTINCT FROM NEW.fee AND OLD.active THEN
            CONTINUE;   -- التداخل قائم من قبل، لا جديد
        END IF;
        PERFORM notify_owners('area_overlap', 'تداخل منطقتين برسمين مختلفين',
            o.name_a || ' (' || o.fee_a || ') و' || o.name_b || ' (' || o.fee_b || ') — ' ||
            jsonb_array_length(o.branches) || ' فرع داخلهما',
            jsonb_build_object('area_a', o.area_a, 'area_b', o.area_b, 'branches', o.branches));
    END LOOP;
    RETURN NULL;
END $$ LANGUAGE plpgsql;
CREATE TRIGGER area_overlap_notice AFTER INSERT OR UPDATE ON delivery_areas
    FOR EACH ROW EXECUTE FUNCTION trg_area_overlap_notice();


-- ——— م-28: تكلفة أصناف المخزن ——————————————————————————————————————————————————
ALTER TABLE catalog_item_pricing
    ADD COLUMN warehouse_cost_mode  warehouse_cost_mode NOT NULL DEFAULT 'auto',
    ADD COLUMN warehouse_manual_cost money_lyd CHECK (warehouse_manual_cost > 0);
-- «الصنف اليدوي الذي لم تُكتب تكلفته لا يُعرض للبيع حتى تُكتب»
ALTER TABLE catalog_items ADD COLUMN cost_missing boolean NOT NULL DEFAULT false;          -- ◆
CREATE TRIGGER a_guard_derived_cost_missing BEFORE INSERT OR UPDATE ON catalog_items FOR EACH ROW
    EXECUTE FUNCTION guard_derived('cost_missing:false');

-- تكلفة المخزن للصنف: تلقائي بطريقة م-12 السارية (أعلى مخزن فيه منه)، أو يدوي بيد المالك.
-- لا مخزون منه في مخازن المدينة = المخزن ليس مصدراً له الآن.
CREATE FUNCTION item_warehouse_cost(p_item bigint, OUT cost numeric, OUT missing boolean) AS $$
DECLARE mode warehouse_cost_mode; manual numeric; c text; stocked boolean;
BEGIN
    SELECT ci.city INTO c FROM catalog_items ci WHERE ci.id = p_item;
    SELECT EXISTS (SELECT 1 FROM warehouse_stock ws JOIN warehouses w ON w.id = ws.warehouse_id
                    WHERE ws.catalog_item_id = p_item AND w.active AND w.city = c AND ws.on_hand > 0) INTO stocked;
    missing := false;
    IF NOT stocked THEN cost := NULL; RETURN; END IF;
    SELECT pr.warehouse_cost_mode, pr.warehouse_manual_cost INTO mode, manual
      FROM catalog_item_pricing pr WHERE pr.catalog_item_id = p_item;
    IF mode = 'manual' THEN
        cost := manual;
        missing := manual IS NULL;
    ELSIF current_cogs_method(c) = 'fifo' THEN
        SELECT max(l.unit_cost) INTO cost FROM warehouses w
          CROSS JOIN LATERAL (SELECT unit_cost FROM stock_layers sl WHERE sl.warehouse_id = w.id
                               AND sl.catalog_item_id = p_item AND sl.qty_left > 0 ORDER BY sl.id LIMIT 1) l
         WHERE w.city = c AND w.active;
    ELSE
        SELECT max(ws.avg_cost) INTO cost FROM warehouse_stock ws JOIN warehouses w ON w.id = ws.warehouse_id
         WHERE ws.catalog_item_id = p_item AND w.active AND w.city = c AND ws.on_hand > 0;
    END IF;
END $$ LANGUAGE plpgsql STABLE;

-- التكلفة المرجعية = الأعلى بين تكلفة الموردين (أساس م-6) وتكلفة المخزن (م-28).
CREATE OR REPLACE FUNCTION item_cost_ref(p_item bigint) RETURNS numeric AS $$
    SELECT greatest(
        CASE coalesce((SELECT cost_basis_override FROM catalog_item_pricing WHERE catalog_item_id = p_item),
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
        END,
        (item_warehouse_cost(p_item)).cost)
$$ LANGUAGE sql STABLE;

CREATE OR REPLACE FUNCTION refresh_cost_guard(p_item bigint) RETURNS void AS $$
DECLARE ci catalog_items; cost numeric; below boolean; missing boolean;
BEGIN
    SELECT * INTO ci FROM catalog_items WHERE id = p_item;
    cost := item_cost_ref(p_item);
    missing := (item_warehouse_cost(p_item)).missing;
    below := ci.sale_price IS NOT NULL AND cost IS NOT NULL AND ci.sale_price < cost;
    IF below IS DISTINCT FROM ci.below_cost THEN
        UPDATE catalog_items SET below_cost = below WHERE id = p_item;
        IF below THEN
            PERFORM notify_owners('below_cost', 'صنف أُوقف: سعر البيع تحت التكلفة', ci.name_ar,
                                  jsonb_build_object('catalog_item_id', p_item, 'sale_price', ci.sale_price, 'cost', cost));
        END IF;
    END IF;
    IF missing IS DISTINCT FROM ci.cost_missing THEN
        UPDATE catalog_items SET cost_missing = missing WHERE id = p_item;
        IF missing THEN
            PERFORM notify_owners('cost_missing', 'صنف موقوف: اكتب تكلفته اليدوية', ci.name_ar,
                                  jsonb_build_object('catalog_item_id', p_item));
        END IF;
    END IF;
END $$ LANGUAGE plpgsql;

-- ما يعيد الحساب: تغيير إعداد تكلفة المخزن للصنف، وتغيير طريقة م-12.
CREATE FUNCTION trg_warehouse_cost_item() RETURNS trigger AS $$
BEGIN
    IF TG_OP = 'INSERT' OR (NEW.warehouse_cost_mode, NEW.warehouse_manual_cost)
                           IS DISTINCT FROM (OLD.warehouse_cost_mode, OLD.warehouse_manual_cost) THEN
        PERFORM refresh_cost_guard(NEW.catalog_item_id);
    END IF;
    RETURN NULL;
END $$ LANGUAGE plpgsql;
CREATE TRIGGER warehouse_cost_item AFTER INSERT OR UPDATE ON catalog_item_pricing
    FOR EACH ROW EXECUTE FUNCTION trg_warehouse_cost_item();

CREATE FUNCTION trg_cogs_period_refresh() RETURNS trigger AS $$
DECLARE item bigint;
BEGIN
    FOR item IN SELECT id FROM catalog_items WHERE city = NEW.city LOOP
        PERFORM refresh_cost_guard(item);
    END LOOP;
    RETURN NULL;
END $$ LANGUAGE plpgsql;
CREATE TRIGGER cogs_period_refresh AFTER INSERT ON cogs_method_periods FOR EACH ROW EXECUTE FUNCTION trg_cogs_period_refresh();

-- الموقوف لغياب التكلفة: لا يظهر ولا يُطلب ولا يُرسل.
CREATE OR REPLACE VIEW v_customer_catalog AS
SELECT ci.id, ci.city, ci.category_id, ci.name_ar, ci.name_en, ci.unit, ci.unit_size,
       ci.image_media_id, ci.sale_price, ci.is_available AS orderable,
       NOT ci.is_available AS out_of_stock
  FROM catalog_items ci
  JOIN city_settings cs ON cs.city = ci.city
 WHERE ci.visibility = 'visible' AND NOT ci.below_cost AND NOT ci.cost_missing
   AND (ci.is_available OR coalesce(ci.oos_policy, cs.oos_policy) = 'mark_out');

CREATE FUNCTION trg_order_item_cost_missing() RETURNS trigger AS $$
BEGIN
    IF writer_role() <> 'trigger' AND (SELECT cost_missing FROM catalog_items WHERE id = NEW.catalog_item_id) THEN
        RAISE EXCEPTION 'item_cost_missing: %', NEW.catalog_item_id USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
END $$ LANGUAGE plpgsql;
CREATE TRIGGER c_order_item_cost_missing BEFORE INSERT ON order_items FOR EACH ROW EXECUTE FUNCTION trg_order_item_cost_missing();

CREATE FUNCTION trg_order_place_cost_missing() RETURNS trigger AS $$
DECLARE bad bigint;
BEGIN
    IF NEW.status = 'placed' AND OLD.status = 'draft' THEN
        SELECT oi.catalog_item_id INTO bad FROM order_items oi JOIN catalog_items ci ON ci.id = oi.catalog_item_id
         WHERE oi.order_id = NEW.id AND ci.cost_missing LIMIT 1;
        IF bad IS NOT NULL THEN
            RAISE EXCEPTION 'item_cost_missing: %', bad USING ERRCODE = 'check_violation';
        END IF;
    END IF;
    RETURN NEW;
END $$ LANGUAGE plpgsql;
CREATE TRIGGER d_order_place_cost_missing BEFORE UPDATE ON orders FOR EACH ROW EXECUTE FUNCTION trg_order_place_cost_missing();

INSERT INTO derived_fields (table_name, column_name, writer, source) VALUES
 ('orders', 'area_overlap_rule', 'trg_order_overlap_snapshot', 'لقطة city_settings عند placed (م-27)'),
 ('catalog_items', 'cost_missing', 'refresh_cost_guard', 'يدوي بلا تكلفة مكتوبة والصنف في المخزن (م-28)');
