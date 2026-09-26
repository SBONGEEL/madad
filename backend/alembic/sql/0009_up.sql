-- 0009 — تطبيق العميل: القراءة حسب الفرع (م-9) مفروضة في القاعدة، وحرّاس الإدراج للأطراف والوسائط
-- والنزاعات، ومعاينة رسم التوصيل للسلة، وإشعارات الأحداث الدنيا للعميل (§7).

-- ═══════════════════════════════════════════════════════════════════════════
-- م-9: ما يقرؤه عضو المنشأة — الصاحب كل الفروع، والمسؤول فرعه وحده
-- ═══════════════════════════════════════════════════════════════════════════
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

CREATE VIEW v_customer_branches AS
SELECT b.id, b.customer_id, b.name, b.address_text, b.lat, b.lng, b.zone_id, z.name_ar AS zone_name,
       b.status, b.active
  FROM customer_locations b
  JOIN customer_members m ON m.customer_id = b.customer_id AND m.user_id = actor_id()
  LEFT JOIN delivery_zones z ON z.id = b.zone_id
 WHERE m.role = 'owner' OR b.id = m.branch_id;

-- طلبية ليست للمنشأة: NULL (لا وجود لها عند هذا العميل). طلبية فرع آخر للمسؤول: forbidden_branch باسمه.
CREATE FUNCTION customer_order_access(p_order bigint) RETURNS bigint AS $$
DECLARE o orders;
BEGIN
    SELECT * INTO o FROM orders WHERE id = p_order;
    IF o.id IS NULL OR actor_member(o.customer_id) IS NULL THEN RETURN NULL; END IF;
    PERFORM require_branch_access(o.customer_id, o.branch_id);
    RETURN o.id;
END $$ LANGUAGE plpgsql STABLE;


-- ═══════════════════════════════════════════════════════════════════════════
-- حرّاس الإدراج (§11.2): طرف جديد يبدأ «بانتظار الاعتماد»، ووسائطه له لا لغيره
-- ═══════════════════════════════════════════════════════════════════════════
CREATE FUNCTION media_owned(p_media bigint) RETURNS boolean AS $$
    SELECT p_media IS NULL OR EXISTS (SELECT 1 FROM media_files
                                       WHERE id = p_media AND (uploaded_by IS NULL OR uploaded_by = actor_id()))
$$ LANGUAGE sql STABLE;

CREATE FUNCTION trg_media_before() RETURNS trigger AS $$
BEGIN
    IF writer_role() NOT IN ('trigger', 'system') THEN
        NEW.uploaded_by := actor_id();
    END IF;
    RETURN NEW;
END $$ LANGUAGE plpgsql;
CREATE TRIGGER b_media BEFORE INSERT ON media_files FOR EACH ROW EXECUTE FUNCTION trg_media_before();

CREATE FUNCTION trg_party_insert() RETURNS trigger AS $$
DECLARE r text; ok boolean;
BEGIN
    r := writer_role();
    IF r IN ('trigger', 'system', 'admin') THEN RETURN NEW; END IF;
    IF NEW.status <> 'pending' OR NEW.reviewed_by IS NOT NULL OR NEW.reviewed_at IS NOT NULL THEN
        RAISE EXCEPTION 'forbidden_role: a new party starts pending' USING ERRCODE = 'insufficient_privilege';
    END IF;
    ok := CASE TG_TABLE_NAME
        WHEN 'customers' THEN media_owned(NEW.facade_media_id) AND media_owned(NEW.cr_media_id)
        ELSE true END;
    IF NOT ok THEN
        RAISE EXCEPTION 'media_not_owned' USING ERRCODE = 'insufficient_privilege';
    END IF;
    RETURN NEW;
END $$ LANGUAGE plpgsql;
CREATE TRIGGER a_party_insert BEFORE INSERT ON customers FOR EACH ROW EXECUTE FUNCTION trg_party_insert();

-- النزاع يفتحه عضو منشأة الطلبية (بفرعها) أو سائقها؛ يبدأ مفتوحاً بلا قرار.
CREATE FUNCTION trg_dispute_insert() RETURNS trigger AS $$
DECLARE r text; o orders;
BEGIN
    r := writer_role();
    IF r IN ('trigger', 'system') THEN RETURN NEW; END IF;
    SELECT * INTO o FROM orders WHERE id = NEW.order_id;
    IF r = 'customer' THEN
        PERFORM require_branch_access(o.customer_id, o.branch_id);
    ELSIF r = 'driver' THEN
        IF NOT EXISTS (SELECT 1 FROM drivers d WHERE d.id = o.driver_id AND d.user_id = actor_id()) THEN
            RAISE EXCEPTION 'forbidden_not_assigned' USING ERRCODE = 'insufficient_privilege';
        END IF;
    ELSE
        RAISE EXCEPTION 'forbidden_role: disputes are opened by the customer or the driver'
            USING ERRCODE = 'insufficient_privilege';
    END IF;
    IF o.status = 'draft' THEN
        RAISE EXCEPTION 'order_not_found' USING ERRCODE = 'check_violation';
    END IF;
    IF NEW.order_item_id IS NOT NULL
       AND NOT EXISTS (SELECT 1 FROM order_items WHERE id = NEW.order_item_id AND order_id = NEW.order_id) THEN
        RAISE EXCEPTION 'line_not_found' USING ERRCODE = 'check_violation';
    END IF;
    IF NEW.status <> 'open' OR NEW.resolution IS NOT NULL OR NEW.resolution_amount IS NOT NULL
       OR NEW.refund_method IS NOT NULL OR NEW.loss_bearer IS NOT NULL THEN
        RAISE EXCEPTION 'forbidden_role: a dispute starts open' USING ERRCODE = 'insufficient_privilege';
    END IF;
    NEW.opened_by_role := r::actor_role;
    NEW.opened_by := actor_id();
    RETURN NEW;
END $$ LANGUAGE plpgsql;
CREATE TRIGGER b_dispute_insert BEFORE INSERT ON disputes FOR EACH ROW EXECUTE FUNCTION trg_dispute_insert();

-- نزاع مفتوح واحد لكل صنف في الطلبية
CREATE UNIQUE INDEX dispute_open_per_item ON disputes (order_item_id) WHERE status = 'open' AND order_item_id IS NOT NULL;

CREATE FUNCTION trg_dispute_media_before() RETURNS trigger AS $$
BEGIN
    IF writer_role() IN ('trigger', 'system', 'admin') THEN RETURN NEW; END IF;
    IF NOT EXISTS (SELECT 1 FROM disputes WHERE id = NEW.dispute_id AND opened_by = actor_id() AND status = 'open')
       OR NOT media_owned(NEW.media_id) THEN
        RAISE EXCEPTION 'media_not_owned' USING ERRCODE = 'insufficient_privilege';
    END IF;
    RETURN NEW;
END $$ LANGUAGE plpgsql;
CREATE TRIGGER b_dispute_media BEFORE INSERT ON dispute_media FOR EACH ROW EXECUTE FUNCTION trg_dispute_media_before();

-- الإشعار يقرؤه صاحبه ويعلّمه مقروءاً وحده؛ لا يغيّر فيه غير read_at.
CREATE FUNCTION trg_notification_before() RETURNS trigger AS $$
BEGIN
    IF writer_role() IN ('trigger', 'system', 'admin') THEN RETURN NEW; END IF;
    IF OLD.user_id <> actor_id() THEN
        RAISE EXCEPTION 'forbidden_role: not your notification' USING ERRCODE = 'insufficient_privilege';
    END IF;
    IF (NEW.user_id, NEW.kind, NEW.order_id, NEW.batch_id, NEW.title, NEW.body, NEW.payload, NEW.sent_at)
       IS DISTINCT FROM (OLD.user_id, OLD.kind, OLD.order_id, OLD.batch_id, OLD.title, OLD.body, OLD.payload, OLD.sent_at) THEN
        RAISE EXCEPTION 'append_only_: notifications change read_at only' USING ERRCODE = 'restrict_violation';
    END IF;
    RETURN NEW;
END $$ LANGUAGE plpgsql;
CREATE TRIGGER b_notification BEFORE UPDATE ON notifications FOR EACH ROW EXECUTE FUNCTION trg_notification_before();


-- ═══════════════════════════════════════════════════════════════════════════
-- معاينة رسم التوصيل للسلة: منطق order_fee نفسه بإعدادات اليوم على موقع الفرع
-- (الطلبية تلتقط الإعدادات عند placed؛ هذه معاينة لا تُكتب).
-- ═══════════════════════════════════════════════════════════════════════════
CREATE FUNCTION fee_preview(p_branch bigint, p_subtotal numeric) RETURNS numeric AS $$
DECLARE b customer_locations; cs city_settings; z_fee numeric; a_fee numeric; a bigint;
BEGIN
    SELECT * INTO b FROM customer_locations WHERE id = p_branch;
    SELECT * INTO cs FROM city_settings WHERE city = b.city;
    IF cs.fee_mode IS NULL THEN PERFORM setting_missing(b.city, 'fee_mode'); END IF;
    IF cs.free_delivery_threshold IS NOT NULL AND p_subtotal >= cs.free_delivery_threshold THEN RETURN 0; END IF;
    IF cs.fee_mode = 'flat' THEN RETURN cs.delivery_fee_flat; END IF;
    IF b.zone_id IS NOT NULL THEN
        SELECT z.fee INTO z_fee FROM delivery_zones z WHERE z.id = b.zone_id AND z.active;
    END IF;
    a := area_for_point(b.city, b.lat, b.lng);
    IF a IS NOT NULL THEN SELECT fee INTO a_fee FROM delivery_areas WHERE id = a; END IF;
    IF z_fee IS NULL AND a_fee IS NULL THEN
        RAISE EXCEPTION 'zone_missing: branch %', p_branch USING ERRCODE = 'check_violation';
    END IF;
    IF z_fee IS NULL OR a_fee IS NULL OR z_fee = a_fee THEN RETURN coalesce(a_fee, z_fee); END IF;
    RETURN CASE cs.fee_conflict_rule WHEN 'area_wins' THEN a_fee WHEN 'zone_wins' THEN z_fee
                                     WHEN 'higher' THEN greatest(a_fee, z_fee) ELSE least(a_fee, z_fee) END;
END $$ LANGUAGE plpgsql STABLE;


-- ═══════════════════════════════════════════════════════════════════════════
-- §7 الأحداث الدنيا للعميل: تأكيد الطلبية، والإسناد، والوصول — لأعضاء المنشأة المعنيين بالفرع.
-- بلا سعر شراء ولا مورد (الحارس test_customer_notifications_carry_no_cost_or_supplier).
-- ═══════════════════════════════════════════════════════════════════════════
CREATE FUNCTION notify_order_members(p_order orders, p_kind text, p_title text, p_body text) RETURNS void AS $$
    INSERT INTO notifications (user_id, kind, order_id, title, body)
    SELECT m.user_id, p_kind, p_order.id, p_title, p_body FROM customer_members m
     WHERE m.customer_id = p_order.customer_id AND (m.role = 'owner' OR m.branch_id = p_order.branch_id);
$$ LANGUAGE sql;

-- تُنتَج من سجل الحالات order_status_events بعامل دوري (app/services/notifier.py) لا بمشغّل:
-- المؤشر يحفظ آخر حدث عولج، فلا إشعار مكرر ولا فائت، والعامل نفسه يتولى التذكير والدفع لاحقاً.
CREATE TABLE notifier_cursors (
    name    text PRIMARY KEY,
    last_id bigint NOT NULL DEFAULT 0
);
INSERT INTO notifier_cursors (name, last_id) VALUES ('customer_order_events', coalesce((SELECT max(id) FROM order_status_events), 0));

CREATE FUNCTION emit_customer_order_events() RETURNS int AS $$
DECLARE cur bigint; e record; o orders; n int := 0;
BEGIN
    SELECT last_id INTO cur FROM notifier_cursors WHERE name = 'customer_order_events' FOR UPDATE;
    FOR e IN SELECT * FROM order_status_events WHERE id > cur ORDER BY id LOOP
        SELECT * INTO o FROM orders WHERE id = e.order_id;
        IF e.to_status = 'confirmed' AND e.from_status = 'placed' THEN
            PERFORM notify_order_members(o, 'order_confirmed', 'أكّد مَدَد طلبيتك #' || o.id,
                                         'نجمع أصنافك الآن، ونخبرك حين تنطلق إليك.');
            n := n + 1;
        ELSIF e.to_status = 'assigned' THEN
            PERFORM notify_order_members(o, 'order_assigned', 'طلبيتك #' || o.id || ' مع سائق مَدَد',
                                         'بدأ السائق جمع أصنافك من نقاط الاستلام.');
            n := n + 1;
        ELSIF e.to_status = 'delivered' THEN
            PERFORM notify_order_members(o, 'order_arrived', 'وصلت طلبيتك #' || o.id,
                                         'سُلِّمت كل الأصناف. شكراً لطلبك من مَدَد.');
            n := n + 1;
        END IF;
        cur := e.id;
    END LOOP;
    UPDATE notifier_cursors SET last_id = cur WHERE name = 'customer_order_events';
    RETURN n;
END $$ LANGUAGE plpgsql;
