-- 0015 — قرارات المالك الدفعة السابعة (§12-ي): دورية أجر السائق (D-1)، وموعد الصرف القادم،
-- والنسخ الاحتياطية (ن-3)، ونص الإشعار على الشاشة المقفلة (ن-4)، والمسار والموعد من Mapbox (ن-5).

-- ═══════════════════════════════════════════════════════════════════════════
-- ١) D-1 وموعد الصرف القادم: قواعد صرف بالإلحاق وحده (السجل نفسه سجل التدقيق)
--    صف عام لكل مدينة (دورية أجر السائق الدوري + طريقة موعد الصرف)، وصف استثناء لمورد أو سائق.
--    كل صف لقطة كاملة لما يسري من لحظته، والقاعدة التي تحكم دورةً هي السارية عند بدايتها
--    (آخر صرف أو الاعتماد): التغيير يسري على الدورات الجديدة وحدها.
-- ═══════════════════════════════════════════════════════════════════════════
CREATE TYPE payout_schedule_mode AS ENUM ('rolling', 'fixed');

CREATE TABLE payout_rules (
    id                   bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    city                 text NOT NULL REFERENCES cities(code),
    supplier_id          bigint REFERENCES suppliers(id),
    driver_id            bigint REFERENCES drivers(id),
    -- العام: دورية أجر السائق الدوري (NULL = لم يضبطها المالك بعد). السائق: استثناؤه (NULL = العامة).
    driver_cycle         payout_cycle,
    -- rolling = آخر صرف (أو الاعتماد) + طول الدورة؛ fixed = أيام ثابتة. للطرف: NULL = العام.
    mode                 payout_schedule_mode,
    -- الأيام الثابتة حسب الدورية: الأسبوعية يوم من الأسبوع (0 الأحد … 6 السبت)،
    -- والشهرية يوم من الشهر، ونصف الشهرية يومان منه. اليومية كل يوم.
    fixed_weekday        smallint CHECK (fixed_weekday BETWEEN 0 AND 6),
    fixed_month_day      smallint CHECK (fixed_month_day BETWEEN 1 AND 28),
    fixed_semimonth_days smallint[] CHECK (fixed_semimonth_days IS NULL OR (
                             array_length(fixed_semimonth_days, 1) = 2 AND fixed_semimonth_days[1] >= 1
                             AND fixed_semimonth_days[1] < fixed_semimonth_days[2] AND fixed_semimonth_days[2] <= 28)),
    effective_from       timestamptz NOT NULL DEFAULT now(),
    set_by               bigint REFERENCES app_users(id),
    CHECK (supplier_id IS NULL OR driver_id IS NULL),
    CHECK (supplier_id IS NULL OR driver_cycle IS NULL),          -- دورية المورد في ملفه منذ اعتماده
    CHECK (supplier_id IS NOT NULL OR driver_id IS NOT NULL OR mode IS NOT NULL),   -- للعام طريقة دائماً
    CHECK (CASE WHEN mode = 'fixed'
                THEN fixed_weekday IS NOT NULL AND fixed_month_day IS NOT NULL AND fixed_semimonth_days IS NOT NULL
                ELSE fixed_weekday IS NULL AND fixed_month_day IS NULL AND fixed_semimonth_days IS NULL END)
);
CREATE INDEX payout_rules_lookup ON payout_rules (city, supplier_id, driver_id, effective_from);

CREATE FUNCTION trg_payout_rule_before() RETURNS trigger AS $$
DECLARE c text;
BEGIN
    IF writer_role() NOT IN ('trigger', 'system') THEN
        -- العام من الإعدادات، والاستثناء من ملف الطرف (مال)
        IF NEW.supplier_id IS NULL AND NEW.driver_id IS NULL THEN
            PERFORM require_admin('settings');
        ELSE
            PERFORM require_admin('money');
        END IF;
    END IF;
    c := coalesce((SELECT city FROM suppliers WHERE id = NEW.supplier_id), (SELECT city FROM drivers WHERE id = NEW.driver_id));
    IF c IS NOT NULL AND c <> NEW.city THEN
        RAISE EXCEPTION 'payout_rule_city_mismatch' USING ERRCODE = 'check_violation';
    END IF;
    NEW.effective_from := now();
    NEW.set_by := actor_id();
    RETURN NEW;
END $$ LANGUAGE plpgsql;
CREATE TRIGGER b_payout_rule BEFORE INSERT ON payout_rules FOR EACH ROW EXECUTE FUNCTION trg_payout_rule_before();
CREATE TRIGGER z_append_only BEFORE UPDATE OR DELETE ON payout_rules FOR EACH ROW EXECUTE FUNCTION guard_append_only();
CREATE TRIGGER zz_audit AFTER INSERT ON payout_rules FOR EACH ROW EXECUTE FUNCTION trg_audit();

-- الابتدائي (§12-ي ٣): آخر صرف + طول الدورة؛ ودورية السائق العامة لم تُضبط بعد
INSERT INTO payout_rules (city, mode) SELECT code, 'rolling' FROM cities;

INSERT INTO derived_fields (table_name, column_name, writer, source) VALUES
 ('payout_rules', 'effective_from', 'trg_payout_rule_before', 'لحظة التسجيل: يسري على الدورات الجديدة'),
 ('payout_rules', 'set_by',         'trg_payout_rule_before', 'الفاعل');

-- القاعدة السارية لطرف عند لحظة (بداية دورته). الاستثناء يغلب العام حقلاً حقلاً؛ وقبل أي صف عام
-- يُؤخذ أول صف عام، ودورية السائق التي لم تُضبط عند بداية الدورة تُؤخذ من أول ضبط لها بعدها.
CREATE FUNCTION payout_rule_at(p_city text, p_supplier bigint, p_driver bigint, p_at timestamptz,
                               OUT driver_cycle payout_cycle, OUT mode payout_schedule_mode, OUT fixed_weekday smallint,
                               OUT fixed_month_day smallint, OUT fixed_semimonth_days smallint[], OUT overridden boolean) AS $$
DECLARE g payout_rules; o payout_rules;
BEGIN
    SELECT * INTO g FROM payout_rules r WHERE r.city = p_city AND r.supplier_id IS NULL AND r.driver_id IS NULL
       AND r.effective_from <= p_at ORDER BY r.effective_from DESC, r.id DESC LIMIT 1;
    IF g.id IS NULL THEN
        SELECT * INTO g FROM payout_rules r WHERE r.city = p_city AND r.supplier_id IS NULL AND r.driver_id IS NULL
         ORDER BY r.effective_from, r.id LIMIT 1;
    END IF;
    IF p_supplier IS NOT NULL OR p_driver IS NOT NULL THEN
        SELECT * INTO o FROM payout_rules r WHERE r.city = p_city
           AND r.supplier_id IS NOT DISTINCT FROM p_supplier AND r.driver_id IS NOT DISTINCT FROM p_driver
           AND r.effective_from <= p_at ORDER BY r.effective_from DESC, r.id DESC LIMIT 1;
    END IF;
    overridden := o.id IS NOT NULL AND (o.driver_cycle IS NOT NULL OR o.mode IS NOT NULL);
    driver_cycle := coalesce(o.driver_cycle, g.driver_cycle,
                             (SELECT r.driver_cycle FROM payout_rules r WHERE r.city = p_city AND r.supplier_id IS NULL
                                 AND r.driver_id IS NULL AND r.driver_cycle IS NOT NULL
                               ORDER BY r.effective_from, r.id LIMIT 1));
    IF o.mode IS NOT NULL THEN
        mode := o.mode; fixed_weekday := o.fixed_weekday; fixed_month_day := o.fixed_month_day;
        fixed_semimonth_days := o.fixed_semimonth_days;
    ELSE
        mode := g.mode; fixed_weekday := g.fixed_weekday; fixed_month_day := g.fixed_month_day;
        fixed_semimonth_days := g.fixed_semimonth_days;
    END IF;
END $$ LANGUAGE plpgsql STABLE;

-- أول يوم صرف بعد بداية الدورة
CREATE FUNCTION payout_next_date(p_cycle payout_cycle, p_base date, p_mode payout_schedule_mode, p_wd smallint,
                                 p_md smallint, p_sm smallint[]) RETURNS date AS $$
DECLARE m date := date_trunc('month', p_base)::date;
BEGIN
    IF p_cycle IS NULL OR p_base IS NULL THEN RETURN NULL; END IF;
    IF p_mode = 'fixed' AND p_cycle <> 'daily' THEN
        RETURN CASE p_cycle
            WHEN 'weekly' THEN p_base + 1 + ((p_wd - extract(dow FROM p_base + 1)::int + 7) % 7)
            WHEN 'monthly' THEN CASE WHEN m + p_md - 1 > p_base THEN m + p_md - 1
                                     ELSE (m + interval '1 month')::date + p_md - 1 END
            WHEN 'semimonthly' THEN (SELECT min(d) FROM (VALUES (m + p_sm[1] - 1), (m + p_sm[2] - 1),
                                                          ((m + interval '1 month')::date + p_sm[1] - 1)) v(d)
                                      WHERE d > p_base)
        END;
    END IF;
    RETURN CASE p_cycle
        WHEN 'daily' THEN p_base + 1
        WHEN 'weekly' THEN p_base + 7
        WHEN 'semimonthly' THEN p_base + 15
        WHEN 'monthly' THEN (p_base + interval '1 month')::date
    END;
END $$ LANGUAGE plpgsql IMMUTABLE;

-- المورد: دوريته من ملفه، والطريقة من القاعدة السارية عند بداية دورته (بدل 0014)
CREATE OR REPLACE FUNCTION supplier_next_payout(p_supplier bigint) RETURNS date AS $$
    SELECT payout_next_date(s.payout_cycle, b.base::date, r.mode, r.fixed_weekday, r.fixed_month_day, r.fixed_semimonth_days)
      FROM suppliers s
     CROSS JOIN LATERAL (SELECT coalesce((SELECT max(created_at) FROM supplier_payouts WHERE supplier_id = s.id),
                                         s.reviewed_at) AS base) b
     CROSS JOIN LATERAL payout_rule_at(s.city, s.id, NULL, b.base) r
     WHERE s.id = p_supplier AND s.payout_cycle IS NOT NULL
$$ LANGUAGE sql STABLE;

-- السائق: الصرف الدوري وحده له تاريخ (المقاصّة عند تسليمه القادم للكاش)
CREATE FUNCTION driver_next_payout(p_driver bigint) RETURNS date AS $$
    SELECT payout_next_date(r.driver_cycle, b.base::date, r.mode, r.fixed_weekday, r.fixed_month_day, r.fixed_semimonth_days)
      FROM drivers d
     CROSS JOIN LATERAL (SELECT coalesce((SELECT max(created_at) FROM driver_payouts WHERE driver_id = d.id),
                                         d.reviewed_at) AS base) b
     CROSS JOIN LATERAL payout_rule_at(d.city, NULL, d.id, b.base) r
     WHERE d.id = p_driver AND d.pay_method = 'periodic'
$$ LANGUAGE sql STABLE;

-- الدورية النافذة لسائق الآن (للعرض): استثناؤه أو العامة
CREATE FUNCTION driver_payout_cycle(p_driver bigint) RETURNS payout_cycle AS $$
    SELECT (payout_rule_at(d.city, NULL, d.id, now())).driver_cycle FROM drivers d WHERE d.id = p_driver
$$ LANGUAGE sql STABLE;


-- ═══════════════════════════════════════════════════════════════════════════
-- ٢) ن-3 النسخ الاحتياطية: السياسة للمالك وحده (بالإلحاق)، والتشغيلات يكتبها العامل وحده،
--    والتنزيل للمالك وحده ويُسجَّل. كلمة سر التشفير لا تدخل القاعدة أبداً (بيئة الخادم وحدها).
-- ═══════════════════════════════════════════════════════════════════════════
CREATE TYPE backup_plan AS ENUM ('daily30', 'daily7_weekly12');
CREATE TYPE backup_location AS ENUM ('offsite', 'local', 'both');

CREATE TABLE backup_policies (
    id             bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    plan           backup_plan NOT NULL,
    location       backup_location NOT NULL,
    effective_from timestamptz NOT NULL DEFAULT now(),
    set_by         bigint REFERENCES app_users(id)
);
CREATE FUNCTION trg_backup_policy_before() RETURNS trigger AS $$
BEGIN
    PERFORM require_owner();
    NEW.effective_from := now();
    NEW.set_by := actor_id();
    RETURN NEW;
END $$ LANGUAGE plpgsql;
CREATE TRIGGER b_backup_policy BEFORE INSERT ON backup_policies FOR EACH ROW EXECUTE FUNCTION trg_backup_policy_before();
CREATE TRIGGER z_append_only BEFORE UPDATE OR DELETE ON backup_policies FOR EACH ROW EXECUTE FUNCTION guard_append_only();
CREATE TRIGGER zz_audit AFTER INSERT ON backup_policies FOR EACH ROW EXECUTE FUNCTION trg_audit();
-- الابتدائي (§12-ي ن-3): يومية 7 أيام + أسبوعية 12 أسبوعاً، في المكانين
INSERT INTO backup_policies (plan, location) VALUES ('daily7_weekly12', 'both');

CREATE FUNCTION current_backup_policy() RETURNS backup_policies AS $$
    SELECT * FROM backup_policies ORDER BY effective_from DESC, id DESC LIMIT 1
$$ LANGUAGE sql STABLE;

CREATE TABLE backup_runs (
    id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    started_at  timestamptz NOT NULL DEFAULT now(),
    finished_at timestamptz,
    status      text NOT NULL DEFAULT 'running' CHECK (status IN ('running', 'ok', 'failed')),
    kind        text NOT NULL CHECK (kind IN ('daily', 'weekly')),
    plan        backup_plan NOT NULL,
    location    backup_location NOT NULL,
    file_name   text CHECK (file_name ~ '^madad-[0-9]{8}-[0-9]{6}\.mdbk$'),
    byte_size   bigint CHECK (byte_size > 0),
    sha256      text CHECK (sha256 ~ '^[0-9a-f]{64}$'),
    local_ok    boolean NOT NULL DEFAULT false,
    offsite_ok  boolean NOT NULL DEFAULT false,
    error       text,
    pruned_at   timestamptz,
    CHECK (status <> 'ok' OR (finished_at IS NOT NULL AND file_name IS NOT NULL AND byte_size IS NOT NULL
                              AND sha256 IS NOT NULL AND (local_ok OR offsite_ok))),
    -- نسخة «ناجحة» في كل مكان طلبته السياسة، وإلا فهي فاشلة
    CHECK (status <> 'ok' OR ((location = 'offsite' OR local_ok) AND (location = 'local' OR offsite_ok))),
    CHECK (status <> 'failed' OR (finished_at IS NOT NULL AND error IS NOT NULL)),
    CHECK (pruned_at IS NULL OR status = 'ok')
);

-- العامل الدوري وحده يكتب (system)؛ running ← ok/failed مرة واحدة، وok ← محذوفة بمدة الحفظ مرة واحدة
CREATE FUNCTION trg_backup_run_before() RETURNS trigger AS $$
BEGIN
    IF writer_role() NOT IN ('system', 'trigger') THEN
        RAISE EXCEPTION 'forbidden_role: backups are written by the backup worker' USING ERRCODE = 'insufficient_privilege';
    END IF;
    IF TG_OP = 'DELETE' THEN
        RAISE EXCEPTION 'append_only: backup_runs' USING ERRCODE = 'insufficient_privilege';
    END IF;
    IF TG_OP = 'UPDATE' THEN
        IF OLD.status = 'failed' OR (OLD.status = 'ok' AND (NEW.status <> 'ok' OR OLD.pruned_at IS NOT NULL
             OR (NEW.file_name, NEW.byte_size, NEW.sha256, NEW.local_ok, NEW.offsite_ok, NEW.finished_at)
                IS DISTINCT FROM (OLD.file_name, OLD.byte_size, OLD.sha256, OLD.local_ok, OLD.offsite_ok, OLD.finished_at))) THEN
            RAISE EXCEPTION 'backup_run_final: run %', OLD.id USING ERRCODE = 'check_violation';
        END IF;
        IF (NEW.started_at, NEW.kind, NEW.plan, NEW.location) IS DISTINCT FROM (OLD.started_at, OLD.kind, OLD.plan, OLD.location) THEN
            RAISE EXCEPTION 'backup_run_final: run %', OLD.id USING ERRCODE = 'check_violation';
        END IF;
    END IF;
    RETURN coalesce(NEW, OLD);
END $$ LANGUAGE plpgsql;
CREATE TRIGGER b_backup_run BEFORE INSERT OR UPDATE OR DELETE ON backup_runs FOR EACH ROW EXECUTE FUNCTION trg_backup_run_before();

-- فشل نسخة ← تنبيه في صندوق المالك
ALTER TABLE notifications DROP CONSTRAINT notifications_kind_check;
ALTER TABLE notifications ADD CONSTRAINT notifications_kind_check CHECK (kind IN (
    'order_confirmed', 'order_assigned', 'batch_departure', 'order_arrived', 'list_reminder',
    'pickup_request', 'driver_settlement', 'supplier_payout', 'broadcast', 'otp',
    'price_changed', 'below_cost', 'plan_short', 'otp_channel_failed', 'order_awaiting_owner',
    'branch_pending', 'weight_over_capacity', 'area_overlap', 'cost_missing', 'back_in_stock',
    'backup_failed'));

CREATE FUNCTION trg_backup_run_failed() RETURNS trigger AS $$
BEGIN
    IF NEW.status = 'failed' AND OLD.status = 'running' THEN
        INSERT INTO notifications (user_id, kind, title, body, payload)
        SELECT m.user_id, 'backup_failed', 'فشلت النسخة الاحتياطية',
               'لم تكتمل نسخة ' || to_char(NEW.started_at AT TIME ZONE 'Africa/Tripoli', 'YYYY-MM-DD HH24:MI')
               || '. افتح «النسخ الاحتياطية» في الإعدادات.', jsonb_build_object('backup_run_id', NEW.id)
          FROM admin_members m WHERE m.role = 'owner';
    END IF;
    RETURN NULL;
END $$ LANGUAGE plpgsql;
CREATE TRIGGER backup_run_failed AFTER UPDATE ON backup_runs FOR EACH ROW EXECUTE FUNCTION trg_backup_run_failed();

-- تنبيه اللوحة: آخر نسخة منتهية فشلت، أو مرّ يوم بلا نسخة ناجحة (من أول سياسة إن لم تنجح نسخة بعد)
CREATE FUNCTION backup_alert(OUT kind text, OUT since timestamptz) AS $$
DECLARE last_ok timestamptz; last_fin backup_runs;
BEGIN
    SELECT max(finished_at) INTO last_ok FROM backup_runs WHERE status = 'ok';
    SELECT * INTO last_fin FROM backup_runs WHERE status <> 'running' ORDER BY finished_at DESC, id DESC LIMIT 1;
    IF last_fin.status = 'failed' THEN
        kind := 'failed'; since := last_fin.finished_at;
    ELSIF coalesce(last_ok, (SELECT min(effective_from) FROM backup_policies)) < now() - interval '1 day' THEN
        kind := 'stale'; since := last_ok;
    END IF;
END $$ LANGUAGE plpgsql STABLE;

-- كل تنزيل يُسجَّل، والمالك وحده ينزّل (المشرف يُرفض هنا مهما كانت صلاحياته)
CREATE TABLE backup_downloads (
    id      bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    run_id  bigint NOT NULL REFERENCES backup_runs(id),
    user_id bigint REFERENCES app_users(id),
    at      timestamptz NOT NULL DEFAULT now()
);
CREATE FUNCTION trg_backup_download_before() RETURNS trigger AS $$
BEGIN
    IF writer_role() <> 'admin' THEN
        RAISE EXCEPTION 'forbidden_owner_only' USING ERRCODE = 'insufficient_privilege';
    END IF;
    PERFORM require_owner();
    IF NOT EXISTS (SELECT 1 FROM backup_runs WHERE id = NEW.run_id AND status = 'ok' AND pruned_at IS NULL) THEN
        RAISE EXCEPTION 'backup_unavailable: run %', NEW.run_id USING ERRCODE = 'check_violation';
    END IF;
    NEW.user_id := actor_id();
    NEW.at := now();
    RETURN NEW;
END $$ LANGUAGE plpgsql;
CREATE TRIGGER b_backup_download BEFORE INSERT ON backup_downloads FOR EACH ROW EXECUTE FUNCTION trg_backup_download_before();
CREATE TRIGGER z_append_only BEFORE UPDATE OR DELETE ON backup_downloads FOR EACH ROW EXECUTE FUNCTION guard_append_only();


-- ═══════════════════════════════════════════════════════════════════════════
-- ٣) ن-4 نص الإشعار على الشاشة المقفلة: إعداد للمالك (عام ابتداءً). النص يُبنى هنا من حقول ثابتة
--    لا من نص الإشعار الحر: لا رمز دخول ولا اسم ولا هاتف فيه في أي حال.
-- ═══════════════════════════════════════════════════════════════════════════
CREATE TYPE push_text_mode AS ENUM ('full', 'generic');
ALTER TABLE city_settings ADD COLUMN push_text_mode push_text_mode NOT NULL DEFAULT 'generic';

CREATE FUNCTION order_status_ar(s order_status) RETURNS text AS $$
    SELECT CASE s WHEN 'placed' THEN 'بانتظار التأكيد' WHEN 'confirmed' THEN 'مؤكَّدة' WHEN 'assigned' THEN 'أُسندت لسائق'
                  WHEN 'collecting' THEN 'جاري التجميع' WHEN 'partially_delivered' THEN 'سُلّم جزء منها'
                  WHEN 'delivered' THEN 'سُلّمت' WHEN 'closed' THEN 'أُغلقت' WHEN 'cancelled' THEN 'أُلغيت'
                  ELSE 'مسودة' END
$$ LANGUAGE sql IMMUTABLE;

CREATE FUNCTION user_city(p_user bigint) RETURNS text AS $$
    SELECT coalesce((SELECT c.city FROM customer_members m JOIN customers c ON c.id = m.customer_id WHERE m.user_id = p_user),
                    (SELECT s.city FROM supplier_members m JOIN suppliers s ON s.id = m.supplier_id WHERE m.user_id = p_user),
                    (SELECT d.city FROM drivers d WHERE d.user_id = p_user),
                    (SELECT min(city) FROM city_settings))
$$ LANGUAGE sql STABLE;

CREATE FUNCTION push_text(n notifications, p_mode push_text_mode, OUT title text, OUT body text) AS $$
DECLARE aud audience; o orders;
BEGIN
    SELECT u.audience INTO aud FROM app_users u WHERE u.id = n.user_id;
    SELECT * INTO o FROM orders WHERE id = n.order_id;
    title := 'مَدَد';
    IF p_mode = 'generic' THEN
        body := CASE WHEN aud = 'customer' AND o.id IS NOT NULL THEN 'لديك تحديث على طلبيتك'
                     ELSE 'لديك إشعار جديد من مَدَد' END;
        RETURN;
    END IF;
    -- كامل: رقم الطلبية وحالتها ومبلغها — للعميل والسائق واللوحة؛ والمورد لا يصله عن الطلبية شيء
    IF o.id IS NOT NULL AND aud = 'customer' THEN
        body := 'طلبيتك #' || o.id || ' — ' || order_status_ar(o.status) || ' · ' || to_char(o.total, 'FM999G999G990D000') || ' د.ل';
    ELSIF o.id IS NOT NULL AND aud IN ('driver', 'admin') THEN
        body := 'الطلبية #' || o.id || ' — ' || order_status_ar(o.status);
    ELSE
        body := CASE n.kind
            WHEN 'list_reminder' THEN 'تذكير بقائمة طلبك'
            WHEN 'pickup_request' THEN 'طلب استلام جديد'
            WHEN 'driver_settlement' THEN 'سُجّلت تسوية الكاش'
            WHEN 'supplier_payout' THEN 'صُرفت لك مستحقات'
            WHEN 'broadcast' THEN 'رسالة جديدة من مَدَد'
            WHEN 'back_in_stock' THEN 'عاد صنف طلبت التنبيه عليه متاحاً'
            WHEN 'price_changed' THEN 'تغيّر سعر صنف'
            ELSE 'لديك إشعار جديد من مَدَد' END;
    END IF;
END $$ LANGUAGE plpgsql STABLE;

-- صندوق الإرسال الفوري: ما يُرسَل إلى FCM (يرسله العامل حين يُضبط Firebase). رمز الدخول لا يدخله أبداً،
-- ولا رقم هاتف في نصه.
CREATE TABLE push_outbox (
    id              bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    notification_id bigint NOT NULL UNIQUE REFERENCES notifications(id),
    user_id         bigint NOT NULL REFERENCES app_users(id),
    kind            text NOT NULL CHECK (kind <> 'otp'),
    mode            push_text_mode NOT NULL,
    title           text NOT NULL,
    body            text NOT NULL,
    created_at      timestamptz NOT NULL DEFAULT now(),
    sent_at         timestamptz,
    CHECK (title || ' ' || body !~ '(\+?218|\m0)9[0-9]{8}')
);
CREATE FUNCTION trg_push_outbox() RETURNS trigger AS $$
DECLARE m push_text_mode; t record;
BEGIN
    IF NEW.kind = 'otp' OR NOT ('push' = ANY (NEW.channels)) THEN RETURN NULL; END IF;
    m := coalesce((SELECT push_text_mode FROM city_settings
                    WHERE city = coalesce((SELECT city FROM orders WHERE id = NEW.order_id), user_city(NEW.user_id))), 'generic');
    t := push_text(NEW, m);
    INSERT INTO push_outbox (notification_id, user_id, kind, mode, title, body)
    VALUES (NEW.id, NEW.user_id, NEW.kind, m, t.title, t.body);
    RETURN NULL;
END $$ LANGUAGE plpgsql;
CREATE TRIGGER push_outbox AFTER INSERT ON notifications FOR EACH ROW EXECUTE FUNCTION trg_push_outbox();
CREATE FUNCTION trg_push_outbox_before() RETURNS trigger AS $$
BEGIN
    IF writer_role() NOT IN ('system', 'trigger') THEN
        RAISE EXCEPTION 'forbidden_role: push outbox' USING ERRCODE = 'insufficient_privilege';
    END IF;
    IF TG_OP = 'UPDATE' AND ((NEW.notification_id, NEW.user_id, NEW.kind, NEW.mode, NEW.title, NEW.body)
                             IS DISTINCT FROM (OLD.notification_id, OLD.user_id, OLD.kind, OLD.mode, OLD.title, OLD.body)
                             OR OLD.sent_at IS NOT NULL) THEN
        RAISE EXCEPTION 'append_only: push_outbox' USING ERRCODE = 'insufficient_privilege';
    END IF;
    RETURN coalesce(NEW, OLD);
END $$ LANGUAGE plpgsql;
CREATE TRIGGER b_push_outbox BEFORE INSERT OR UPDATE OR DELETE ON push_outbox FOR EACH ROW EXECUTE FUNCTION trg_push_outbox_before();


-- ═══════════════════════════════════════════════════════════════════════════
-- ٤) ن-5 المسار والموعد من Mapbox: مصدر كل قيمة محفوظ. كتابة القيمة بلا مصدر = يدوي
--    (فالتعديل اليدوي للسائق أو المالك لا يُنسب للخرائط أبداً).
-- ═══════════════════════════════════════════════════════════════════════════
ALTER TABLE pickup_stops ADD COLUMN eta_source text CHECK (eta_source IN ('manual', 'mapbox'));
UPDATE pickup_stops SET eta_source = 'manual' WHERE eta_at IS NOT NULL;
ALTER TABLE pickup_stops ADD CONSTRAINT eta_source_with_eta CHECK ((eta_at IS NULL) = (eta_source IS NULL));
ALTER TABLE orders ADD COLUMN route_km_source text CHECK (route_km_source IN ('manual', 'mapbox'));
UPDATE orders SET route_km_source = 'manual' WHERE route_km IS NOT NULL;
ALTER TABLE orders ADD CONSTRAINT route_km_source_with_km CHECK ((route_km IS NULL) = (route_km_source IS NULL));

CREATE FUNCTION trg_stop_eta_source() RETURNS trigger AS $$
BEGIN
    IF NEW.eta_at IS NULL THEN
        NEW.eta_source := NULL;
    ELSIF TG_OP = 'INSERT' OR NEW.eta_at IS DISTINCT FROM OLD.eta_at THEN
        IF TG_OP = 'INSERT' OR NEW.eta_source IS NOT DISTINCT FROM OLD.eta_source THEN
            NEW.eta_source := coalesce(CASE WHEN TG_OP = 'INSERT' THEN NEW.eta_source END, 'manual');
        END IF;
    ELSIF NEW.eta_source IS DISTINCT FROM OLD.eta_source THEN
        NEW.eta_source := OLD.eta_source;          -- لا يتغيّر المصدر بلا قيمة جديدة
    END IF;
    RETURN NEW;
END $$ LANGUAGE plpgsql;
CREATE TRIGGER d_stop_eta_source BEFORE INSERT OR UPDATE ON pickup_stops FOR EACH ROW EXECUTE FUNCTION trg_stop_eta_source();

CREATE FUNCTION trg_route_km_source() RETURNS trigger AS $$
BEGIN
    IF NEW.route_km IS NULL THEN
        NEW.route_km_source := NULL;
    ELSIF TG_OP = 'INSERT' OR NEW.route_km IS DISTINCT FROM OLD.route_km THEN
        IF TG_OP = 'INSERT' OR NEW.route_km_source IS NOT DISTINCT FROM OLD.route_km_source THEN
            NEW.route_km_source := coalesce(CASE WHEN TG_OP = 'INSERT' THEN NEW.route_km_source END, 'manual');
        END IF;
    ELSIF NEW.route_km_source IS DISTINCT FROM OLD.route_km_source THEN
        NEW.route_km_source := OLD.route_km_source;
    END IF;
    RETURN NEW;
END $$ LANGUAGE plpgsql;
CREATE TRIGGER d_route_km_source BEFORE INSERT OR UPDATE ON orders FOR EACH ROW EXECUTE FUNCTION trg_route_km_source();

-- يراه المورد: مصدر الموعد (محسوب أو يكتبه السائق) — عمود جديد في آخر العرض، بلا عميل ولا وجهة
CREATE OR REPLACE VIEW v_supplier_pickups AS
SELECT s.id, s.supplier_id, s.pickup_location_id, s.status, s.supplier_code, o.assigned_at,
       (h.stop_id IS NOT NULL) AS handed_over,
       l.id AS line_id, p.name_ar AS product_name, so.unit, so.unit_size, l.planned_qty, l.collected_qty,
       s.eta_at, s.arrived_at, s.eta_source
  FROM pickup_stops s
  JOIN orders o ON o.id = s.order_id
  JOIN pickup_stop_lines l ON l.stop_id = s.id
  JOIN supplier_offers so ON so.id = l.offer_id
  JOIN products p ON p.id = so.product_id
  LEFT JOIN pickup_handovers h ON h.stop_id = s.id
 WHERE s.source = 'supplier' AND s.status <> 'cancelled'
   AND o.status IN ('assigned', 'collecting', 'partially_delivered', 'delivered', 'closed');
