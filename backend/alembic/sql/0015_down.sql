-- نزول 0015: عكس الترتيب. ما استُبدل من 0014 (العرض والدالة) يُعاد كما كان.
DROP VIEW v_supplier_pickups;
CREATE VIEW v_supplier_pickups AS
SELECT s.id, s.supplier_id, s.pickup_location_id, s.status, s.supplier_code, o.assigned_at,
       (h.stop_id IS NOT NULL) AS handed_over,
       l.id AS line_id, p.name_ar AS product_name, so.unit, so.unit_size, l.planned_qty, l.collected_qty,
       s.eta_at, s.arrived_at
  FROM pickup_stops s
  JOIN orders o ON o.id = s.order_id
  JOIN pickup_stop_lines l ON l.stop_id = s.id
  JOIN supplier_offers so ON so.id = l.offer_id
  JOIN products p ON p.id = so.product_id
  LEFT JOIN pickup_handovers h ON h.stop_id = s.id
 WHERE s.source = 'supplier' AND s.status <> 'cancelled'
   AND o.status IN ('assigned', 'collecting', 'partially_delivered', 'delivered', 'closed');
DROP TRIGGER d_route_km_source ON orders;
DROP FUNCTION trg_route_km_source();
DROP TRIGGER d_stop_eta_source ON pickup_stops;
DROP FUNCTION trg_stop_eta_source();
ALTER TABLE orders DROP COLUMN route_km_source;
ALTER TABLE pickup_stops DROP COLUMN eta_source;

DROP TABLE push_outbox;
DROP FUNCTION trg_push_outbox_before();
DROP TRIGGER push_outbox ON notifications;
DROP FUNCTION trg_push_outbox();
DROP FUNCTION push_text(notifications, push_text_mode);
DROP FUNCTION user_city(bigint);
DROP FUNCTION order_status_ar(order_status);
ALTER TABLE city_settings DROP COLUMN push_text_mode;
DROP TYPE push_text_mode;

DROP TABLE backup_downloads;
DROP FUNCTION trg_backup_download_before();
DROP FUNCTION backup_alert();
DROP TRIGGER backup_run_failed ON backup_runs;
DROP FUNCTION trg_backup_run_failed();
DELETE FROM notifications WHERE kind = 'backup_failed';
ALTER TABLE notifications DROP CONSTRAINT notifications_kind_check;
ALTER TABLE notifications ADD CONSTRAINT notifications_kind_check CHECK (kind IN (
    'order_confirmed', 'order_assigned', 'batch_departure', 'order_arrived', 'list_reminder',
    'pickup_request', 'driver_settlement', 'supplier_payout', 'broadcast', 'otp',
    'price_changed', 'below_cost', 'plan_short', 'otp_channel_failed', 'order_awaiting_owner',
    'branch_pending', 'weight_over_capacity', 'area_overlap', 'cost_missing', 'back_in_stock'));
DROP TABLE backup_runs;
DROP FUNCTION trg_backup_run_before();
DROP FUNCTION current_backup_policy();
DROP TABLE backup_policies;
DROP FUNCTION trg_backup_policy_before();
DROP TYPE backup_location;
DROP TYPE backup_plan;

DROP FUNCTION driver_payout_cycle(bigint);
DROP FUNCTION driver_next_payout(bigint);
CREATE OR REPLACE FUNCTION supplier_next_payout(p_supplier bigint) RETURNS date AS $$
    SELECT CASE s.payout_cycle
               WHEN 'daily' THEN base + 1
               WHEN 'weekly' THEN base + 7
               WHEN 'semimonthly' THEN base + 15
               WHEN 'monthly' THEN (base + interval '1 month')::date
           END
      FROM suppliers s
     CROSS JOIN LATERAL (SELECT coalesce((SELECT max(created_at)::date FROM supplier_payouts WHERE supplier_id = s.id),
                                         s.reviewed_at::date) AS base) b
     WHERE s.id = p_supplier AND s.payout_cycle IS NOT NULL
$$ LANGUAGE sql STABLE;
DROP FUNCTION payout_next_date(payout_cycle, date, payout_schedule_mode, smallint, smallint, smallint[]);
DROP FUNCTION payout_rule_at(text, bigint, bigint, timestamptz);
DELETE FROM derived_fields WHERE table_name = 'payout_rules';
DROP TABLE payout_rules;
DROP FUNCTION trg_payout_rule_before();
DROP TYPE payout_schedule_mode;
