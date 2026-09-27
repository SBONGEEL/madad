-- نزول 0014: عكس الترتيب. العروض تُعاد كما كانت (بلا الأعمدة الجديدة) بإسقاطها وإنشائها.
DROP FUNCTION supplier_next_payout(bigint);
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
DROP TRIGGER c_stop_eta_arrival ON pickup_stops;
DROP FUNCTION trg_stop_eta_arrival();
ALTER TABLE pickup_stops DROP COLUMN eta_at, DROP COLUMN arrived_at;
DROP TRIGGER c_unavailable_assign ON orders;
DROP FUNCTION trg_unavailable_self_assign();
DROP TRIGGER c_unavailable_offer ON driver_pay_offers;
DROP FUNCTION trg_unavailable_driver();
DROP VIEW v_driver_available;
CREATE VIEW v_driver_available AS
SELECT o.id, c.name AS customer_name, br.name AS branch_name, o.dest_address, o.dest_lat, o.dest_lng,
       st.stops, o.route_km,
       CASE WHEN o.route_km IS NOT NULL THEN round(cs.driver_pay_base + cs.driver_pay_per_stop * st.stops
                                                   + cs.driver_pay_per_km * o.route_km, 3) END AS pay_estimate,
       greatest(0, o.total - customer_credit_available(o.customer_id)) AS amount_to_collect,
       (order_load(o.id)).load_kg, (order_load(o.id)).weight_complete, d.capacity_kg,
       (d.capacity_kg IS NOT NULL AND (order_load(o.id)).load_kg > d.capacity_kg) AS over_capacity,
       (SELECT jsonb_build_object('id', f.id, 'amount', f.amount, 'status', f.status) FROM driver_pay_offers f
         WHERE f.order_id = o.id AND f.driver_id = d.id ORDER BY f.id DESC LIMIT 1) AS my_offer,
       o.confirmed_at
  FROM orders o
  JOIN customers c ON c.id = o.customer_id
  JOIN customer_locations br ON br.id = o.branch_id
  JOIN city_settings cs ON cs.city = o.city
  JOIN drivers d ON d.user_id = actor_id() AND d.city = o.city AND d.status = 'approved'
  CROSS JOIN LATERAL (SELECT count(*) AS stops FROM pickup_stops s WHERE s.order_id = o.id AND s.status <> 'cancelled') st
 WHERE o.status = 'confirmed' AND o.driver_id IS NULL AND o.plan_complete;
DROP TRIGGER b_driver_self ON drivers;
DROP FUNCTION trg_driver_self_update();
ALTER TABLE drivers DROP COLUMN accepting;
DROP VIEW v_driver_orders;
CREATE VIEW v_driver_orders AS
SELECT o.id, o.city, o.status, o.driver_id, c.name AS customer_name, c.phone AS customer_phone,
       o.dest_lat, o.dest_lng, o.dest_address,
       greatest(0, o.total
                   - coalesce((SELECT sum(e.amount) FROM ledger_entries e
                                 JOIN ledger_transactions t ON t.id = e.transaction_id
                                 JOIN ledger_accounts la ON la.id = e.account_id
                                WHERE t.order_id = o.id AND t.kind = 'collection' AND la.kind = 'driver_cash'), 0)
                   - customer_credit_available(o.customer_id)) AS amount_to_collect,
       o.driver_pay, o.collection_mode,
       br.name AS branch_name,
       (order_load(o.id)).load_kg, (order_load(o.id)).weight_complete, d.capacity_kg,
       (d.capacity_kg IS NOT NULL AND (order_load(o.id)).load_kg > d.capacity_kg) AS over_capacity
  FROM orders o JOIN customers c ON c.id = o.customer_id
  JOIN customer_locations br ON br.id = o.branch_id
  LEFT JOIN drivers d ON d.id = o.driver_id
 WHERE o.status NOT IN ('draft', 'placed');
DROP VIEW v_customer_branches;
CREATE VIEW v_customer_branches AS
SELECT b.id, b.customer_id, b.name, b.address_text, b.lat, b.lng, b.zone_id, z.name_ar AS zone_name,
       b.status, b.active
  FROM customer_locations b
  JOIN customer_members m ON m.customer_id = b.customer_id AND m.user_id = actor_id()
  LEFT JOIN delivery_zones z ON z.id = b.zone_id
 WHERE m.role = 'owner' OR b.id = m.branch_id;
DROP VIEW v_customer_orders;
CREATE VIEW v_customer_orders AS
SELECT o.id, o.customer_id, o.branch_id, br.name AS branch_name, o.status, o.placed_at, o.confirmed_at,
       o.delivered_at, o.dest_address, o.subtotal, o.delivery_fee, o.total, o.line_count, o.notes,
       o.ready_for_owner_at, o.created_by, o.cancel_policy,
       -- ما يُحصَّل عند الاستلام: الصيغة نفسها في v_driver_orders، فلا يختلف ما يراه العميل عمّا يحصّله السائق
       CASE WHEN o.status IN ('draft', 'delivered', 'closed', 'cancelled') THEN NULL ELSE
       greatest(0, o.total
                   - coalesce((SELECT sum(e.amount) FROM ledger_entries e
                                 JOIN ledger_transactions t ON t.id = e.transaction_id
                                 JOIN ledger_accounts la ON la.id = e.account_id
                                WHERE t.order_id = o.id AND t.kind = 'collection' AND la.kind = 'driver_cash'), 0)
                   - customer_credit_available(o.customer_id)) END AS amount_due
  FROM orders o
  JOIN customer_members m ON m.customer_id = o.customer_id AND m.user_id = actor_id()
  JOIN customer_locations br ON br.id = o.branch_id
 WHERE m.role = 'owner' OR o.branch_id = m.branch_id;
DROP TRIGGER c_order_recipient ON orders;
DROP FUNCTION trg_order_recipient();
ALTER TABLE orders DROP COLUMN recipient_name;
ALTER TABLE customer_locations DROP COLUMN default_recipient;
ALTER TABLE city_settings DROP COLUMN contact_phone, DROP COLUMN contact_whatsapp;
DROP FUNCTION customer_can_cancel(bigint);
DROP TRIGGER back_in_stock ON catalog_items;
DROP FUNCTION trg_back_in_stock();
DROP TRIGGER b_stock_alert ON stock_alerts;
DROP FUNCTION trg_stock_alert_before();
DROP TABLE stock_alerts;
DELETE FROM notifications WHERE kind = 'back_in_stock';
ALTER TABLE notifications DROP CONSTRAINT notifications_kind_check;
ALTER TABLE notifications ADD CONSTRAINT notifications_kind_check CHECK (kind IN (
    'order_confirmed', 'order_assigned', 'batch_departure', 'order_arrived', 'list_reminder',
    'pickup_request', 'driver_settlement', 'supplier_payout', 'broadcast', 'otp',
    'price_changed', 'below_cost', 'plan_short', 'otp_channel_failed', 'order_awaiting_owner',
    'branch_pending', 'weight_over_capacity', 'area_overlap', 'cost_missing'));
