-- 0012 — تطبيق السائق: الطلبيات المتاحة له وأجره التقديري، ورصيده وتسوياته هو وحده، والرخصة بوجهيها،
-- وحارس إدراجه، وإشعاراه (§7: إسناد، تسوية/صرف) بمؤشر.

CREATE FUNCTION actor_driver() RETURNS bigint AS $$
    SELECT id FROM drivers WHERE user_id = actor_id()
$$ LANGUAGE sql STABLE;

-- الرخصة «من الوجهين» كما في لوحة التسجيل المعتمدة. عمود جديد يقبل NULL للسائقين القائمين،
-- وإلزامي على كل سائق يسجّل من تطبيقه (a_party_insert أدناه).
ALTER TABLE drivers ADD COLUMN license_back_media_id bigint REFERENCES media_files(id);


-- ═══════════════════════════════════════════════════════════════════════════
-- حارس الإدراج: السائق يبدأ pending، ووثائقه الأربع من رفعه هو
-- ═══════════════════════════════════════════════════════════════════════════
CREATE OR REPLACE FUNCTION trg_party_insert() RETURNS trigger AS $$
DECLARE r text; ok boolean;
BEGIN
    r := writer_role();
    IF r IN ('trigger', 'system', 'admin') THEN RETURN NEW; END IF;
    IF NEW.status <> 'pending' OR NEW.reviewed_by IS NOT NULL OR NEW.reviewed_at IS NOT NULL THEN
        RAISE EXCEPTION 'forbidden_role: a new party starts pending' USING ERRCODE = 'insufficient_privilege';
    END IF;
    -- كل جدول بفرعه: PL/pgSQL لا يقرأ حقلاً ليس في السجل حتى في فرع لا يُنفَّذ من CASE واحدة
    ok := true;
    IF TG_TABLE_NAME = 'customers' THEN
        ok := media_owned(NEW.facade_media_id) AND media_owned(NEW.cr_media_id);
    ELSIF TG_TABLE_NAME = 'suppliers' THEN
        ok := media_owned(NEW.owner_id_media_id) AND media_owned(NEW.cr_media_id);
    ELSIF TG_TABLE_NAME = 'drivers' THEN
        IF r = 'driver' THEN
            IF NEW.user_id <> actor_id() THEN
                RAISE EXCEPTION 'forbidden_role: a driver registers himself' USING ERRCODE = 'insufficient_privilege';
            END IF;
            IF NEW.license_back_media_id IS NULL THEN
                RAISE EXCEPTION 'document_missing: license_back' USING ERRCODE = 'check_violation';
            END IF;
        END IF;
        ok := media_owned(NEW.id_media_id) AND media_owned(NEW.license_media_id)
              AND media_owned(NEW.license_back_media_id) AND media_owned(NEW.photo_media_id);
    END IF;
    IF NOT ok THEN
        RAISE EXCEPTION 'media_not_owned' USING ERRCODE = 'insufficient_privilege';
    END IF;
    RETURN NEW;
END $$ LANGUAGE plpgsql;
CREATE TRIGGER a_party_insert BEFORE INSERT ON drivers FOR EACH ROW EXECUTE FUNCTION trg_party_insert();


-- ═══════════════════════════════════════════════════════════════════════════
-- الطلبيات المتاحة للسائق (§4.2، م-18): مؤكَّدة بلا سائق، مخططها مكتمل، في مدينته، وهو معتمد.
-- الأجر التقديري بصيغة الإسناد نفسها (trg_order_before)، والمبلغ الذي سيحصّله بصيغة v_driver_orders.
-- ═══════════════════════════════════════════════════════════════════════════
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

-- أصناف الطلبية كما يسلّمها السائق: الكمية والمسلَّم وقيمة ما يحصّله (سعر البيع = ما يحصّله، مسموح له).
CREATE VIEW v_driver_order_items AS
SELECT oi.id, oi.order_id, ci.name_ar, oi.unit, ci.unit_size, oi.qty, oi.delivered_qty,
       coalesce((SELECT sum(l.collected_qty) FROM pickup_stop_lines l JOIN pickup_stops s ON s.id = l.stop_id
                  WHERE l.order_item_id = oi.id AND s.status IN ('collected', 'short')), 0) AS collected_qty,
       oi.unit_price AS price, oi.line_total AS line_value
  FROM order_items oi JOIN catalog_items ci ON ci.id = oi.catalog_item_id;


-- ═══════════════════════════════════════════════════════════════════════════
-- رصيده وتسوياته هو وحده («سطور الدفتر التي تخص الطرف نفسه عبر نقطة مخصّصة» §13)
-- ═══════════════════════════════════════════════════════════════════════════
CREATE FUNCTION driver_own_balances(OUT cash_held numeric, OUT wage_due numeric) AS $$
    SELECT coalesce((SELECT balance FROM ledger_accounts WHERE kind = 'driver_cash' AND driver_id = actor_driver()), 0),
           -coalesce((SELECT balance FROM ledger_accounts WHERE kind = 'driver_wallet' AND driver_id = actor_driver()), 0)
$$ LANGUAGE sql STABLE;

CREATE VIEW v_driver_settlements AS
SELECT 'handover' AS kind, h.id, h.amount, h.wallet_offset AS offset_amount, NULL::bigint AS order_id,
       u.full_name AS received_by, h.created_at AS at
  FROM cash_handovers h JOIN app_users u ON u.id = h.received_by
 WHERE h.driver_id = actor_driver()
UNION ALL
SELECT 'payout', p.id, p.amount, 0, NULL, u.full_name, p.created_at
  FROM driver_payouts p JOIN app_users u ON u.id = p.paid_by
 WHERE p.driver_id = actor_driver()
UNION ALL
SELECT 'wage', o.id, o.driver_pay, 0, o.id, NULL, o.delivered_at
  FROM orders o
 WHERE o.driver_id = actor_driver() AND o.status IN ('delivered', 'closed') AND o.driver_pay IS NOT NULL;


-- ═══════════════════════════════════════════════════════════════════════════
-- §7 للسائق: إسناد طلبية له، وتسليم كاش/صرف أجر — بمؤشر كإشعارات العميل والمورد.
-- ═══════════════════════════════════════════════════════════════════════════
INSERT INTO notifier_cursors (name, last_id) VALUES
    ('driver_order_events', coalesce((SELECT max(id) FROM order_status_events), 0)),
    ('driver_handovers', coalesce((SELECT max(id) FROM cash_handovers), 0)),
    ('driver_payouts', coalesce((SELECT max(id) FROM driver_payouts), 0));

CREATE FUNCTION emit_driver_events() RETURNS int AS $$
DECLARE cur bigint; e record; x record; n int := 0; uid bigint;
BEGIN
    SELECT last_id INTO cur FROM notifier_cursors WHERE name = 'driver_order_events' FOR UPDATE;
    FOR e IN SELECT * FROM order_status_events WHERE id > cur ORDER BY id LOOP
        -- الإسناد من اللوحة (لا حين يقبله السائق بنفسه)
        IF e.to_status = 'assigned' AND e.actor_role <> 'driver' THEN
            SELECT d.user_id INTO uid FROM orders o JOIN drivers d ON d.id = o.driver_id WHERE o.id = e.order_id;
            IF uid IS NOT NULL THEN
                INSERT INTO notifications (user_id, kind, order_id, title, body)
                VALUES (uid, 'order_assigned', e.order_id, 'أُسندت إليك الطلبية #' || e.order_id,
                        'افتح المسار وابدأ الجمع من نقطة الاستلام الأولى.');
                n := n + 1;
            END IF;
        END IF;
        cur := e.id;
    END LOOP;
    UPDATE notifier_cursors SET last_id = cur WHERE name = 'driver_order_events';

    SELECT last_id INTO cur FROM notifier_cursors WHERE name = 'driver_handovers' FOR UPDATE;
    FOR x IN SELECT h.*, d.user_id FROM cash_handovers h JOIN drivers d ON d.id = h.driver_id WHERE h.id > cur ORDER BY h.id LOOP
        INSERT INTO notifications (user_id, kind, title, body)
        VALUES (x.user_id, 'driver_settlement', 'سُجّل تسليمك للكاش',
                'استلمت الخزينة ' || to_char(x.amount, 'FM999,999,990.000') || ' د.ل'
                || CASE WHEN x.wallet_offset > 0 THEN '، وخُصم من أجرك ' || to_char(x.wallet_offset, 'FM999,999,990.000') || ' د.ل' ELSE '' END || '.');
        n := n + 1; cur := x.id;
    END LOOP;
    UPDATE notifier_cursors SET last_id = cur WHERE name = 'driver_handovers';

    SELECT last_id INTO cur FROM notifier_cursors WHERE name = 'driver_payouts' FOR UPDATE;
    FOR x IN SELECT p.*, d.user_id FROM driver_payouts p JOIN drivers d ON d.id = p.driver_id WHERE p.id > cur ORDER BY p.id LOOP
        INSERT INTO notifications (user_id, kind, title, body)
        VALUES (x.user_id, 'driver_settlement', 'صُرف أجرك', 'صرف مَدَد لك ' || to_char(x.amount, 'FM999,999,990.000') || ' د.ل.');
        n := n + 1; cur := x.id;
    END LOOP;
    UPDATE notifier_cursors SET last_id = cur WHERE name = 'driver_payouts';
    RETURN n;
END $$ LANGUAGE plpgsql;


-- ═══════════════════════════════════════════════════════════════════════════
-- م-4 كما في لوحة «إضافة عرض» المعتمدة: «عرضك عليه يبقى موقوفاً حتى الاعتماد» — مفروض هنا لا في التطبيق.
-- ═══════════════════════════════════════════════════════════════════════════
CREATE FUNCTION trg_offer_on_proposed() RETURNS trigger AS $$
BEGIN
    IF NEW.status = 'active' AND (SELECT status FROM products WHERE id = NEW.product_id) = 'proposed' THEN
        RAISE EXCEPTION 'offer_on_proposed_product: stays paused until MADAD approves the item'
            USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
END $$ LANGUAGE plpgsql;
CREATE TRIGGER c_offer_on_proposed BEFORE INSERT OR UPDATE ON supplier_offers
    FOR EACH ROW EXECUTE FUNCTION trg_offer_on_proposed();
