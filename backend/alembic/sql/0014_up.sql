-- 0014 — قرارات المالك الدفعة السادسة (§12-ط): العناصر السبعة المقبولة في الإصدار الأول.
-- كل عنصر مصدره هنا ويُفرض هنا ما يمكن فرضه.

-- ═══════════════════════════════════════════════════════════════════════════
-- ١) «نبّهني حين يتوفر»: على صنف نافذ وحده، وإشعار واحد حين يعود متاحاً ثم يُلغى التنبيه
-- ═══════════════════════════════════════════════════════════════════════════
ALTER TABLE notifications DROP CONSTRAINT notifications_kind_check;
ALTER TABLE notifications ADD CONSTRAINT notifications_kind_check CHECK (kind IN (
    'order_confirmed', 'order_assigned', 'batch_departure', 'order_arrived', 'list_reminder',
    'pickup_request', 'driver_settlement', 'supplier_payout', 'broadcast', 'otp',
    'price_changed', 'below_cost', 'plan_short', 'otp_channel_failed', 'order_awaiting_owner',
    'branch_pending', 'weight_over_capacity', 'area_overlap', 'cost_missing', 'back_in_stock'));

CREATE TABLE stock_alerts (
    user_id         bigint NOT NULL REFERENCES app_users(id),
    catalog_item_id bigint NOT NULL REFERENCES catalog_items(id),
    created_at      timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (user_id, catalog_item_id)
);

CREATE FUNCTION trg_stock_alert_before() RETURNS trigger AS $$
DECLARE ci catalog_items;
BEGIN
    IF writer_role() IN ('trigger', 'system') THEN RETURN coalesce(NEW, OLD); END IF;
    IF writer_role() <> 'customer' OR coalesce(NEW.user_id, OLD.user_id) <> actor_id() THEN
        RAISE EXCEPTION 'forbidden_role: an alert is the customer''s own' USING ERRCODE = 'insufficient_privilege';
    END IF;
    IF TG_OP = 'INSERT' THEN
        IF NOT EXISTS (SELECT 1 FROM customer_members WHERE user_id = actor_id()) THEN
            RAISE EXCEPTION 'no_establishment' USING ERRCODE = 'insufficient_privilege';
        END IF;
        SELECT * INTO ci FROM catalog_items WHERE id = NEW.catalog_item_id;
        -- الصنف نافد (غير متاح) وهو ظاهر للعميل موسوماً أو في قوائمه؛ المتاح لا تنبيه عليه
        IF ci.is_available OR ci.visibility <> 'visible' THEN
            RAISE EXCEPTION 'alert_item_available: alerts are for out-of-stock items' USING ERRCODE = 'check_violation';
        END IF;
    END IF;
    RETURN coalesce(NEW, OLD);
END $$ LANGUAGE plpgsql;
CREATE TRIGGER b_stock_alert BEFORE INSERT OR UPDATE OR DELETE ON stock_alerts
    FOR EACH ROW EXECUTE FUNCTION trg_stock_alert_before();

-- الصنف عاد متاحاً: إشعار لكل من طلب التنبيه، ثم يُحذف تنبيهه (مرة واحدة).
CREATE FUNCTION trg_back_in_stock() RETURNS trigger AS $$
BEGIN
    IF NEW.is_available AND NOT OLD.is_available AND NEW.visibility = 'visible' THEN
        INSERT INTO notifications (user_id, kind, title, body, payload)
        SELECT a.user_id, 'back_in_stock', 'عاد «' || NEW.name_ar || '» متاحاً',
               'اطلبه الآن قبل أن ينفد.', jsonb_build_object('catalog_item_id', NEW.id)
          FROM stock_alerts a WHERE a.catalog_item_id = NEW.id;
        DELETE FROM stock_alerts WHERE catalog_item_id = NEW.id;
    END IF;
    RETURN NULL;
END $$ LANGUAGE plpgsql;
CREATE TRIGGER back_in_stock AFTER UPDATE ON catalog_items FOR EACH ROW EXECUTE FUNCTION trg_back_in_stock();


-- ═══════════════════════════════════════════════════════════════════════════
-- ٢) إلغاء العميل: حسب إعداد م-7 المُلتقط في الطلبية وحالتها وحدهما (customer_cancel_allowed في القاعدة)
-- ═══════════════════════════════════════════════════════════════════════════
CREATE FUNCTION customer_can_cancel(p_order bigint) RETURNS boolean AS $$
    SELECT o.status = 'placed' OR customer_cancel_allowed(o.status, o.cancel_policy) FROM orders o WHERE o.id = p_order
$$ LANGUAGE sql STABLE;


-- ═══════════════════════════════════════════════════════════════════════════
-- ٣) رقم «تواصل مع مَدَد»: إعداد للمالك (اتصال وواتساب)، يُدقَّق كغيره (zz_audit على city_settings)
-- ═══════════════════════════════════════════════════════════════════════════
ALTER TABLE city_settings
    ADD COLUMN contact_phone text CHECK (contact_phone IS NULL OR contact_phone ~ '^\+2189[0-9]{8}$'),
    ADD COLUMN contact_whatsapp text CHECK (contact_whatsapp IS NULL OR contact_whatsapp ~ '^\+2189[0-9]{8}$');


-- ═══════════════════════════════════════════════════════════════════════════
-- ٤) مستلم الطلبية في الفرع: افتراضي لكل فرع يضبطه صاحب المنشأة، ويُكتب في الطلبية (اختياري)
-- ═══════════════════════════════════════════════════════════════════════════
ALTER TABLE customer_locations ADD COLUMN default_recipient text CHECK (default_recipient IS NULL OR length(btrim(default_recipient)) > 0);
ALTER TABLE orders ADD COLUMN recipient_name text CHECK (recipient_name IS NULL OR length(btrim(recipient_name)) > 0);

-- العميل يرى مستلم طلبيته ومستلم فرعه الافتراضي (عروض 0009 بعمود جديد في آخرها)
CREATE OR REPLACE VIEW v_customer_orders AS
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
                   - customer_credit_available(o.customer_id)) END AS amount_due,
       o.recipient_name
  FROM orders o
  JOIN customer_members m ON m.customer_id = o.customer_id AND m.user_id = actor_id()
  JOIN customer_locations br ON br.id = o.branch_id
 WHERE m.role = 'owner' OR o.branch_id = m.branch_id;

CREATE OR REPLACE VIEW v_customer_branches AS
SELECT b.id, b.customer_id, b.name, b.address_text, b.lat, b.lng, b.zone_id, z.name_ar AS zone_name,
       b.status, b.active, b.default_recipient
  FROM customer_locations b
  JOIN customer_members m ON m.customer_id = b.customer_id AND m.user_id = actor_id()
  LEFT JOIN delivery_zones z ON z.id = b.zone_id
 WHERE m.role = 'owner' OR b.id = m.branch_id;

-- عند الإرسال: بلا مستلم مكتوب يُلتقط مستلم الفرع الافتراضي
CREATE FUNCTION trg_order_recipient() RETURNS trigger AS $$
BEGIN
    IF NEW.status = 'placed' AND OLD.status = 'draft' AND NEW.recipient_name IS NULL THEN
        NEW.recipient_name := (SELECT default_recipient FROM customer_locations WHERE id = NEW.branch_id);
    END IF;
    RETURN NEW;
END $$ LANGUAGE plpgsql;
CREATE TRIGGER c_order_recipient BEFORE UPDATE ON orders FOR EACH ROW EXECUTE FUNCTION trg_order_recipient();

-- يراه السائق عند التسليم
CREATE OR REPLACE VIEW v_driver_orders AS
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
       (d.capacity_kg IS NOT NULL AND (order_load(o.id)).load_kg > d.capacity_kg) AS over_capacity,
       o.recipient_name
  FROM orders o JOIN customers c ON c.id = o.customer_id
  JOIN customer_locations br ON br.id = o.branch_id
  LEFT JOIN drivers d ON d.id = o.driver_id
 WHERE o.status NOT IN ('draft', 'placed');


-- ═══════════════════════════════════════════════════════════════════════════
-- ٥) «أستقبل طلبيات الآن»: السائق يبدّل توفره هو وحده؛ غير المتاح لا تُعرض عليه طلبيات
-- ═══════════════════════════════════════════════════════════════════════════
ALTER TABLE drivers ADD COLUMN accepting boolean NOT NULL DEFAULT true;

CREATE FUNCTION trg_driver_self_update() RETURNS trigger AS $$
BEGIN
    IF writer_role() <> 'driver' THEN RETURN NEW; END IF;
    IF OLD.user_id <> actor_id() THEN
        RAISE EXCEPTION 'forbidden_role: not your driver profile' USING ERRCODE = 'insufficient_privilege';
    END IF;
    -- السائق لا يغيّر من ملفه غير توفره
    IF (NEW.full_name, NEW.phone, NEW.city, NEW.vehicle, NEW.capacity_kg, NEW.status, NEW.pay_method,
        NEW.id_media_id, NEW.license_media_id, NEW.license_back_media_id, NEW.photo_media_id)
       IS DISTINCT FROM (OLD.full_name, OLD.phone, OLD.city, OLD.vehicle, OLD.capacity_kg, OLD.status, OLD.pay_method,
                         OLD.id_media_id, OLD.license_media_id, OLD.license_back_media_id, OLD.photo_media_id) THEN
        RAISE EXCEPTION 'forbidden_role: a driver changes only his availability' USING ERRCODE = 'insufficient_privilege';
    END IF;
    RETURN NEW;
END $$ LANGUAGE plpgsql;
CREATE TRIGGER b_driver_self BEFORE UPDATE ON drivers FOR EACH ROW EXECUTE FUNCTION trg_driver_self_update();

CREATE OR REPLACE VIEW v_driver_available AS
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
  JOIN drivers d ON d.user_id = actor_id() AND d.city = o.city AND d.status = 'approved' AND d.accepting
  CROSS JOIN LATERAL (SELECT count(*) AS stops FROM pickup_stops s WHERE s.order_id = o.id AND s.status <> 'cancelled') st
 WHERE o.status = 'confirmed' AND o.driver_id IS NULL AND o.plan_complete;

-- غير المتاح لا يقبل بنفسه ولا يعرض أجرة؛ الإسناد اليدوي من اللوحة يبقى (مع تنبيه يكتبه emit_driver_events)
CREATE FUNCTION trg_unavailable_driver() RETURNS trigger AS $$
BEGIN
    IF writer_role() = 'driver' AND NOT (SELECT accepting FROM drivers WHERE user_id = actor_id()) THEN
        RAISE EXCEPTION 'driver_unavailable: turn on accepting orders first' USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
END $$ LANGUAGE plpgsql;
CREATE TRIGGER c_unavailable_offer BEFORE INSERT ON driver_pay_offers FOR EACH ROW EXECUTE FUNCTION trg_unavailable_driver();
CREATE FUNCTION trg_unavailable_self_assign() RETURNS trigger AS $$
BEGIN
    IF NEW.status = 'assigned' AND OLD.status = 'confirmed' AND writer_role() = 'driver'
       AND NOT (SELECT accepting FROM drivers WHERE user_id = actor_id()) THEN
        RAISE EXCEPTION 'driver_unavailable: turn on accepting orders first' USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
END $$ LANGUAGE plpgsql;
CREATE TRIGGER c_unavailable_assign BEFORE UPDATE ON orders FOR EACH ROW EXECUTE FUNCTION trg_unavailable_self_assign();


-- ═══════════════════════════════════════════════════════════════════════════
-- ٦) موعد وصول السائق للمورد و«السائق عندك»: يكتب السائق الموعد (قبل مفتاح الخرائط) ويعلّم الوصول
-- ═══════════════════════════════════════════════════════════════════════════
ALTER TABLE pickup_stops ADD COLUMN eta_at timestamptz, ADD COLUMN arrived_at timestamptz;

CREATE FUNCTION trg_stop_eta_arrival() RETURNS trigger AS $$
DECLARE r text;
BEGIN
    IF NEW.eta_at IS NOT DISTINCT FROM OLD.eta_at AND NEW.arrived_at IS NOT DISTINCT FROM OLD.arrived_at THEN
        RETURN NEW;
    END IF;
    r := writer_role();
    IF r IN ('trigger', 'system') THEN RETURN NEW; END IF;
    IF r <> 'driver' OR NOT EXISTS (SELECT 1 FROM orders o JOIN drivers d ON d.id = o.driver_id
                                     WHERE o.id = NEW.order_id AND d.user_id = actor_id()) THEN
        RAISE EXCEPTION 'forbidden_not_assigned' USING ERRCODE = 'insufficient_privilege';
    END IF;
    IF OLD.status <> 'pending' THEN
        RAISE EXCEPTION 'stop_locked' USING ERRCODE = 'check_violation';
    END IF;
    IF NEW.arrived_at IS DISTINCT FROM OLD.arrived_at THEN
        IF OLD.arrived_at IS NOT NULL THEN
            RAISE EXCEPTION 'stop_already_arrived' USING ERRCODE = 'check_violation';
        END IF;
        NEW.arrived_at := now();       -- الوقت من القاعدة لا من الهاتف
    END IF;
    RETURN NEW;
END $$ LANGUAGE plpgsql;
CREATE TRIGGER c_stop_eta_arrival BEFORE UPDATE ON pickup_stops FOR EACH ROW EXECUTE FUNCTION trg_stop_eta_arrival();

-- يراه المورد: الموعد والوصول، بلا عميل ولا وجهة (الأعمدة الجديدة في آخر العرض)
CREATE OR REPLACE VIEW v_supplier_pickups AS
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


-- ═══════════════════════════════════════════════════════════════════════════
-- ٧) موعد الصرف القادم للمورد: من دوريته ومن آخر صرف له (أو من اعتماده إن لم يُصرف له بعد).
-- السائق: المقاصّة عند تسليمه القادم للكاش (بلا تاريخ)، والصرف الدوري بانتظار قرار دوريته.
-- ═══════════════════════════════════════════════════════════════════════════
CREATE FUNCTION supplier_next_payout(p_supplier bigint) RETURNS date AS $$
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
