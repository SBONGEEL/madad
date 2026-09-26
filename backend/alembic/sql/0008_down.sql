-- نزول 0008. الدوال المستبدلة تُستعاد من 0004 و0005 (مولَّد بـgen_down8.py).
SET search_path = madad, public;
SELECT set_config('madad.actor_role', 'system', true);
DELETE FROM derived_fields WHERE (table_name, column_name) IN (('orders','area_overlap_rule'),('catalog_items','cost_missing'));
DROP TRIGGER d_order_place_cost_missing ON orders;
DROP FUNCTION trg_order_place_cost_missing();
DROP TRIGGER c_order_item_cost_missing ON order_items;
DROP FUNCTION trg_order_item_cost_missing();
CREATE OR REPLACE VIEW v_customer_catalog AS
SELECT ci.id, ci.city, ci.category_id, ci.name_ar, ci.name_en, ci.unit, ci.unit_size,
       ci.image_media_id, ci.sale_price, ci.is_available AS orderable,
       NOT ci.is_available AS out_of_stock
  FROM catalog_items ci
  JOIN city_settings cs ON cs.city = ci.city
 WHERE ci.visibility = 'visible' AND NOT ci.below_cost
   AND (ci.is_available OR coalesce(ci.oos_policy, cs.oos_policy) = 'mark_out');

DROP TRIGGER cogs_period_refresh ON cogs_method_periods;
DROP FUNCTION trg_cogs_period_refresh();
DROP TRIGGER warehouse_cost_item ON catalog_item_pricing;
DROP FUNCTION trg_warehouse_cost_item();
CREATE OR REPLACE FUNCTION refresh_cost_guard(p_item bigint) RETURNS void AS $$
DECLARE ci catalog_items; cost numeric; below boolean;
BEGIN
    SELECT * INTO ci FROM catalog_items WHERE id = p_item;
    cost := item_cost_ref(p_item);
    below := ci.sale_price IS NOT NULL AND cost IS NOT NULL AND ci.sale_price < cost;
    IF below IS DISTINCT FROM ci.below_cost THEN
        UPDATE catalog_items SET below_cost = below WHERE id = p_item;
        IF below THEN
            PERFORM notify_owners('below_cost', 'صنف أُوقف: سعر البيع تحت التكلفة', ci.name_ar,
                                  jsonb_build_object('catalog_item_id', p_item, 'sale_price', ci.sale_price,
                                                     'cost', cost));
        END IF;
    END IF;
END $$ LANGUAGE plpgsql;

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

DROP FUNCTION item_warehouse_cost(bigint);
DROP TRIGGER a_guard_derived_cost_missing ON catalog_items;
ALTER TABLE catalog_items DROP COLUMN cost_missing;
ALTER TABLE catalog_item_pricing DROP COLUMN warehouse_cost_mode, DROP COLUMN warehouse_manual_cost;
DROP TRIGGER area_overlap_notice ON delivery_areas;
DROP FUNCTION trg_area_overlap_notice();
DROP VIEW v_area_overlaps;
DROP FUNCTION polygons_overlap(jsonb, jsonb);
DROP FUNCTION segments_cross(numeric, numeric, numeric, numeric, numeric, numeric, numeric, numeric);
DROP TRIGGER c_order_overlap_rule ON orders;
DROP FUNCTION trg_order_overlap_snapshot();
CREATE OR REPLACE FUNCTION area_for_point(p_city text, p_lat numeric, p_lng numeric) RETURNS bigint AS $$
DECLARE fees int; a bigint;
BEGIN
    SELECT count(DISTINCT fee), min(id) INTO fees, a FROM delivery_areas
     WHERE city = p_city AND active AND point_in_polygon(p_lat, p_lng, polygon);
    IF fees > 1 THEN
        RAISE EXCEPTION 'area_overlap: overlapping areas with different fees' USING ERRCODE = 'check_violation';
    END IF;
    RETURN a;
END $$ LANGUAGE plpgsql STABLE;

DROP TRIGGER a_guard_derived_0008 ON orders;
ALTER TABLE orders DROP COLUMN area_overlap_rule;
ALTER TABLE city_settings DROP COLUMN area_overlap_rule;
ALTER TABLE notifications DROP CONSTRAINT notifications_kind_check;
ALTER TABLE notifications ADD CONSTRAINT notifications_kind_check CHECK (kind IN (
    'order_confirmed', 'order_assigned', 'batch_departure', 'order_arrived', 'list_reminder',
    'pickup_request', 'driver_settlement', 'supplier_payout', 'broadcast', 'otp',
    'price_changed', 'below_cost', 'plan_short', 'otp_channel_failed', 'order_awaiting_owner',
    'branch_pending', 'weight_over_capacity'));
DROP TYPE warehouse_cost_mode;
DROP TYPE area_overlap_rule;
