-- 0010 — تطبيق المورد: صفوف المورد نفسه وحدها في عروض مخصّصة (§2.1)، وحرّاس إدراجه ومواقعه،
-- وإشعارا §7 للمورد (طلب استلام، صرف) بمؤشر.

CREATE FUNCTION actor_supplier() RETURNS bigint AS $$
    SELECT supplier_id FROM supplier_members WHERE user_id = actor_id()
$$ LANGUAGE sql STABLE;


-- ═══════════════════════════════════════════════════════════════════════════
-- حرّاس الإدراج (§11.2)
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
    END IF;
    IF NOT ok THEN
        RAISE EXCEPTION 'media_not_owned' USING ERRCODE = 'insufficient_privilege';
    END IF;
    RETURN NEW;
END $$ LANGUAGE plpgsql;
CREATE TRIGGER a_party_insert BEFORE INSERT ON suppliers FOR EACH ROW EXECUTE FUNCTION trg_party_insert();

-- عضو المورد: المسجِّل نفسه أولاً، ولا يضيف المورد أعضاءً بنفسه (الإضافة للّوحة).
CREATE FUNCTION trg_supplier_member_before() RETURNS trigger AS $$
BEGIN
    IF writer_role() <> 'supplier' THEN RETURN coalesce(NEW, OLD); END IF;
    IF TG_OP = 'INSERT' AND NEW.user_id = actor_id()
       AND NOT EXISTS (SELECT 1 FROM supplier_members WHERE supplier_id = NEW.supplier_id)
       AND (SELECT status FROM suppliers WHERE id = NEW.supplier_id) = 'pending' THEN
        RETURN NEW;
    END IF;
    RAISE EXCEPTION 'forbidden_role: supplier members are managed by MADAD' USING ERRCODE = 'insufficient_privilege';
END $$ LANGUAGE plpgsql;
CREATE TRIGGER b_supplier_member BEFORE INSERT OR UPDATE OR DELETE ON supplier_members
    FOR EACH ROW EXECUTE FUNCTION trg_supplier_member_before();

-- مواقع الاستلام: للمورد نفسه، ولا يُعطَّل موقع عليه عروض نشطة.
CREATE FUNCTION trg_pickup_location_before() RETURNS trigger AS $$
DECLARE r text;
BEGIN
    r := writer_role();
    IF r IN ('trigger', 'system') THEN RETURN coalesce(NEW, OLD); END IF;
    IF r = 'supplier' AND coalesce(NEW.supplier_id, OLD.supplier_id) IS DISTINCT FROM actor_supplier() THEN
        RAISE EXCEPTION 'forbidden_not_member' USING ERRCODE = 'insufficient_privilege';
    END IF;
    IF TG_OP = 'UPDATE' THEN
        IF NEW.supplier_id <> OLD.supplier_id OR NEW.city <> OLD.city THEN
            RAISE EXCEPTION 'location_identity_immutable' USING ERRCODE = 'restrict_violation';
        END IF;
        IF OLD.active AND NOT NEW.active AND EXISTS (SELECT 1 FROM supplier_offers
                 WHERE pickup_location_id = OLD.id AND status = 'active') THEN
            RAISE EXCEPTION 'location_in_use: active offers are picked up here' USING ERRCODE = 'check_violation';
        END IF;
    END IF;
    RETURN coalesce(NEW, OLD);
END $$ LANGUAGE plpgsql;
CREATE TRIGGER b_pickup_location BEFORE INSERT OR UPDATE OR DELETE ON supplier_pickup_locations
    FOR EACH ROW EXECUTE FUNCTION trg_pickup_location_before();

-- صورة العرض: من رفع المورد نفسه، على عرضه.
CREATE FUNCTION trg_offer_media_before() RETURNS trigger AS $$
BEGIN
    IF writer_role() IN ('trigger', 'system', 'admin') THEN RETURN coalesce(NEW, OLD); END IF;
    IF (SELECT supplier_id FROM supplier_offers WHERE id = coalesce(NEW.offer_id, OLD.offer_id)) IS DISTINCT FROM actor_supplier()
       OR (TG_OP <> 'DELETE' AND NOT media_owned(NEW.media_id)) THEN
        RAISE EXCEPTION 'media_not_owned' USING ERRCODE = 'insufficient_privilege';
    END IF;
    RETURN coalesce(NEW, OLD);
END $$ LANGUAGE plpgsql;
CREATE TRIGGER b_offer_media BEFORE INSERT OR UPDATE OR DELETE ON supplier_offer_media
    FOR EACH ROW EXECUTE FUNCTION trg_offer_media_before();


-- ═══════════════════════════════════════════════════════════════════════════
-- ما يقرؤه المورد: صفوفه وحدها. لا عميل ولا وجهة ولا سعر بيع ولا مورد آخر.
-- ═══════════════════════════════════════════════════════════════════════════
CREATE VIEW v_supplier_offers AS
SELECT o.id, o.supplier_id, o.product_id, p.name_ar AS product_name, p.status AS product_status, o.unit, o.unit_size,
       o.purchase_price, o.reported_qty, o.reserved_qty, o.available_qty, o.min_order_qty, o.pickup_location_id,
       l.label AS location_label, o.status, o.qty_reported_at, o.updated_at,
       (SELECT h.old_price FROM supplier_offer_price_history h WHERE h.offer_id = o.id ORDER BY h.id DESC LIMIT 1)
           AS previous_price,
       (SELECT m.media_id FROM supplier_offer_media m WHERE m.offer_id = o.id ORDER BY m.sort, m.media_id LIMIT 1)
           AS image_media_id
  FROM supplier_offers o
  JOIN products p ON p.id = o.product_id
  JOIN supplier_pickup_locations l ON l.id = o.pickup_location_id
 WHERE o.supplier_id = actor_supplier();

CREATE VIEW v_supplier_locations AS
SELECT l.id, l.label, l.lat, l.lng, l.address_text, l.active,
       (SELECT count(*) FROM supplier_offers o WHERE o.pickup_location_id = l.id AND o.status = 'active') AS active_offers
  FROM supplier_pickup_locations l
 WHERE l.supplier_id = actor_supplier();

-- ما استُلم منه: الكمية بسعر شرائه لحظة التخطيط (سعره هو، لا سعر مَدَد).
CREATE VIEW v_supplier_received AS
SELECT l.id, s.id AS stop_id, coalesce(s.confirmed_at, h.created_at) AS received_at, p.name_ar AS product_name, so.unit,
       so.unit_size, l.collected_qty, c.unit_cost AS unit_price, round(l.collected_qty * c.unit_cost, 3) AS amount
  FROM pickup_stop_lines l
  JOIN pickup_stops s ON s.id = l.stop_id
  JOIN supplier_offers so ON so.id = l.offer_id
  JOIN products p ON p.id = so.product_id
  LEFT JOIN pickup_line_costs c ON c.stop_line_id = l.id
  LEFT JOIN pickup_handovers h ON h.stop_id = s.id
 WHERE s.supplier_id = actor_supplier() AND s.status IN ('collected', 'short') AND coalesce(l.collected_qty, 0) > 0;

CREATE VIEW v_supplier_payouts AS
SELECT id, amount, period_start, period_end, created_at AS paid_at, receipt_media_id IS NOT NULL AS receipt_ready
  FROM supplier_payouts WHERE supplier_id = actor_supplier();

-- رصيد مستحقه هو وحده («سطور الدفتر التي تخص الطرف نفسه عبر نقطة مخصّصة» §13).
CREATE FUNCTION supplier_own_due() RETURNS numeric AS $$
    SELECT -coalesce((SELECT balance FROM ledger_accounts WHERE kind = 'supplier_payable' AND supplier_id = actor_supplier()), 0)
$$ LANGUAGE sql STABLE;


-- ═══════════════════════════════════════════════════════════════════════════
-- §7 للمورد: طلب استلام عند إسناد الطلبية، وإشعار الصرف — بمؤشر كإشعارات العميل.
-- بلا اسم عميل ولا وجهة ولا سعر بيع.
-- ═══════════════════════════════════════════════════════════════════════════
INSERT INTO notifier_cursors (name, last_id) VALUES
    ('supplier_order_events', coalesce((SELECT max(id) FROM order_status_events), 0)),
    ('supplier_payouts', coalesce((SELECT max(id) FROM supplier_payouts), 0));

CREATE FUNCTION emit_supplier_events() RETURNS int AS $$
DECLARE cur bigint; e record; st record; py record; n int := 0;
BEGIN
    SELECT last_id INTO cur FROM notifier_cursors WHERE name = 'supplier_order_events' FOR UPDATE;
    FOR e IN SELECT * FROM order_status_events WHERE id > cur ORDER BY id LOOP
        IF e.to_status = 'assigned' THEN
            FOR st IN SELECT s.id, s.supplier_id, s.supplier_code,
                             (SELECT count(*) FROM pickup_stop_lines WHERE stop_id = s.id) AS lines
                        FROM pickup_stops s WHERE s.order_id = e.order_id AND s.source = 'supplier' AND s.status = 'pending' LOOP
                INSERT INTO notifications (user_id, kind, title, body, payload)
                SELECT m.user_id, 'pickup_request', 'طلب استلام جديد',
                       'سائق مَدَد في الطريق لاستلام ' || st.lines || ' صنف. رقمك ' || st.supplier_code || '.',
                       jsonb_build_object('stop_id', st.id)
                  FROM supplier_members m WHERE m.supplier_id = st.supplier_id;
                n := n + 1;
            END LOOP;
        END IF;
        cur := e.id;
    END LOOP;
    UPDATE notifier_cursors SET last_id = cur WHERE name = 'supplier_order_events';

    SELECT last_id INTO cur FROM notifier_cursors WHERE name = 'supplier_payouts' FOR UPDATE;
    FOR py IN SELECT * FROM supplier_payouts WHERE id > cur ORDER BY id LOOP
        INSERT INTO notifications (user_id, kind, title, body, payload)
        SELECT m.user_id, 'supplier_payout', 'صُرفت مستحقاتك',
               'صرف مَدَد ' || to_char(py.amount, 'FM999,999,990.000') || ' د.ل عن الفترة '
                   || to_char(py.period_start, 'DD/MM') || ' – ' || to_char(py.period_end, 'DD/MM') || '.',
               jsonb_build_object('payout_id', py.id)
          FROM supplier_members m WHERE m.supplier_id = py.supplier_id;
        n := n + 1;
        cur := py.id;
    END LOOP;
    UPDATE notifier_cursors SET last_id = cur WHERE name = 'supplier_payouts';
    RETURN n;
END $$ LANGUAGE plpgsql;
