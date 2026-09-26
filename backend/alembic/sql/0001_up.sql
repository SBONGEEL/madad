-- ═══════════════════════════════════════════════════════════════════════════
-- مَدَد — المخطط الأولي (الترحيلة 0001)
-- المرجع: SPEC-MADAD.md، والقسم 13 «مخطط قاعدة البيانات» فيه يشرح هذا الملف.
--
-- ثلاث قواعد تحكم كل سطر هنا (القسم 11 من الـSPEC):
--   1. كل قاعدة قابلة للفرض في القاعدة تُفرض هنا (قيد / مشغّل)، لا في الكود.
--   2. كل حقل مشتق له كاتب واحد معلن في جدول derived_fields، وكتابته من
--      التطبيق ترفع derived_field_write. الكاتب مشغّل (pg_trigger_depth() > 1)
--      أو مشغّل BEFORE على الجدول نفسه يأتي بعد الحارس أبجدياً.
--   3. العزل: أسعار الشراء والهوامش والتكاليف في جداول للّوحة وحدها
--      (ADMIN_ONLY_TABLES في القسم 13)، والجماهير الأخرى تقرأ من عروض v_*.
--
-- كل كتابة تحمل هوية فاعلها: SET LOCAL madad.actor_role / madad.actor_id.
-- غيابها يرفع actor_missing — لا فاعل مجهول في سجل التدقيق.
-- ═══════════════════════════════════════════════════════════════════════════

CREATE EXTENSION IF NOT EXISTS pgcrypto WITH SCHEMA public;

CREATE SCHEMA madad;
SET search_path = madad, public;

-- ——— الأنواع الأساسية ————————————————————————————————————————————————
-- المال بلا typmod عمداً: numeric(12,3) يقرّب المدخل صامتاً، وهنا يُرفض.
-- الدقة «قرشان» = منزلتان (بانتظار قرار المالك م-1؛ تغييرها سطر واحد).
CREATE DOMAIN money_lyd AS numeric
    CONSTRAINT money_precision CHECK (VALUE = round(VALUE, 2))
    CONSTRAINT money_range CHECK (abs(VALUE) < 1000000000);

CREATE DOMAIN qty AS numeric
    CONSTRAINT qty_precision CHECK (VALUE = round(VALUE, 3))
    CONSTRAINT qty_range CHECK (VALUE >= 0 AND VALUE < 1000000000);

CREATE TYPE audience          AS ENUM ('customer', 'supplier', 'driver', 'admin');
CREATE TYPE actor_role        AS ENUM ('customer', 'supplier', 'driver', 'admin', 'system');
CREATE TYPE party_status      AS ENUM ('pending', 'approved', 'rejected', 'suspended');
CREATE TYPE establishment_kind AS ENUM ('restaurant', 'cafe', 'other');
CREATE TYPE member_role       AS ENUM ('owner', 'purchaser');
CREATE TYPE admin_role        AS ENUM ('owner', 'supervisor');
CREATE TYPE admin_permission  AS ENUM ('approvals', 'catalog', 'costs_view', 'orders',
                                       'warehouses', 'money', 'customers', 'notifications',
                                       'settings', 'users');
CREATE TYPE vehicle_type      AS ENUM ('motorcycle', 'car', 'van', 'pickup', 'truck');
CREATE TYPE sale_unit         AS ENUM ('kg', 'liter', 'piece', 'carton', 'pack', 'bag',
                                       'box', 'bottle', 'can', 'tray', 'roll', 'bundle');
CREATE TYPE product_status    AS ENUM ('proposed', 'approved', 'rejected', 'merged');
CREATE TYPE offer_status      AS ENUM ('active', 'paused');
CREATE TYPE visibility        AS ENUM ('visible', 'hidden');
CREATE TYPE oos_policy        AS ENUM ('auto_hide', 'mark_out');
CREATE TYPE pricing_mode      AS ENUM ('manual', 'margin_pct', 'margin_amount');
CREATE TYPE fee_mode          AS ENUM ('flat', 'by_zone');
CREATE TYPE collection_mode   AS ENUM ('on_completion', 'per_batch');
CREATE TYPE payout_cycle      AS ENUM ('daily', 'weekly', 'semimonthly', 'monthly');
CREATE TYPE order_status      AS ENUM ('draft', 'placed', 'confirmed', 'assigned', 'collecting',
                                       'partially_delivered', 'delivered', 'closed', 'cancelled');
CREATE TYPE payment_method    AS ENUM ('cash');
CREATE TYPE stop_source       AS ENUM ('supplier', 'warehouse');
CREATE TYPE stop_status       AS ENUM ('pending', 'collected', 'short', 'refused', 'cancelled');
CREATE TYPE batch_status      AS ENUM ('planned', 'notified', 'departed', 'delivered');
CREATE TYPE driver_offer_status AS ENUM ('pending', 'accepted', 'rejected', 'withdrawn');
CREATE TYPE dispute_kind      AS ENUM ('damaged', 'short', 'refused', 'other');
CREATE TYPE dispute_status    AS ENUM ('open', 'resolved');
CREATE TYPE dispute_resolution AS ENUM ('partial_discount', 'return', 'cancel', 'no_action');
CREATE TYPE stock_move_kind   AS ENUM ('intake', 'count_adjust', 'transfer_out', 'transfer_in',
                                       'pickup');
CREATE TYPE notification_channel AS ENUM ('push', 'sms');
CREATE TYPE ledger_account_kind AS ENUM (
    'treasury',              -- خزينة المالك (كاش بيده) — لكل مدينة
    'customer_receivable',   -- ما على العميل
    'driver_cash',           -- كاش محصَّل بحوزة السائق (دين عليه للخزينة)
    'driver_wallet',         -- محفظة السائق: أجره المستحق
    'supplier_payable',      -- مستحقات المورد
    'warehouse_inventory',   -- قيمة مخزون مخزن مَدَد
    'sales_revenue',
    'delivery_fee_revenue',
    'cost_of_goods',
    'driver_pay_expense',
    'operating_expense',
    'sales_adjustment'       -- خصومات النزاعات
);
CREATE TYPE ledger_txn_kind AS ENUM ('sale', 'collection', 'driver_pay', 'supplier_cost',
                                     'cash_handover', 'supplier_payout', 'expense',
                                     'dispute_adjustment', 'stock_intake', 'stock_adjustment',
                                     'reversal');


-- ——— سجلّ الحقول المشتقة: الكاتب الواحد المعلن ————————————————————————————
CREATE TABLE derived_fields (
    table_name  text NOT NULL,
    column_name text NOT NULL,
    writer      text NOT NULL,        -- اسم الدالة/المشغّل الكاتب الوحيد
    source      text NOT NULL,        -- ما يُشتق منه
    PRIMARY KEY (table_name, column_name)
);


-- ——— الفاعل ————————————————————————————————————————————————————————————
CREATE FUNCTION actor_role() RETURNS actor_role AS $$
DECLARE v text := current_setting('madad.actor_role', true);
BEGIN
    IF v IS NULL OR v = '' THEN
        RAISE EXCEPTION 'actor_missing' USING ERRCODE = 'insufficient_privilege';
    END IF;
    RETURN v::actor_role;
END $$ LANGUAGE plpgsql STABLE;

CREATE FUNCTION actor_id() RETURNS bigint AS $$
DECLARE v text := current_setting('madad.actor_id', true);
BEGIN
    IF actor_role() = 'system' THEN
        RETURN NULLIF(v, '')::bigint;
    END IF;
    IF v IS NULL OR v = '' THEN
        RAISE EXCEPTION 'actor_missing' USING ERRCODE = 'insufficient_privilege';
    END IF;
    RETURN v::bigint;
END $$ LANGUAGE plpgsql STABLE;

-- «من يكتب الآن»: مشغّل داخل مشغّل = 'trigger'، وإلا فدور الجلسة.
CREATE FUNCTION writer_role() RETURNS text AS $$
BEGIN
    IF pg_trigger_depth() > 1 THEN RETURN 'trigger'; END IF;
    RETURN actor_role()::text;
END $$ LANGUAGE plpgsql STABLE;


-- ——— الحارسان العامّان ———————————————————————————————————————————————————
-- حارس الحقول المشتقة. الوسائط: 'column:default_json' لكل عمود.
-- يسمح بالكتابة من مشغّل (عمق > 1) ويرفض من التطبيق (عمق = 1).
-- مشغّلات BEFORE على الجدول نفسه تكتب بعده لأن اسمه يبدأ بـa_ (ترتيب أبجدي).
CREATE FUNCTION guard_derived() RETURNS trigger AS $$
DECLARE
    i int; col text; dflt jsonb; newj jsonb; oldj jsonb;
BEGIN
    IF pg_trigger_depth() > 1 THEN
        RETURN NEW;
    END IF;
    newj := to_jsonb(NEW);
    IF TG_OP = 'UPDATE' THEN oldj := to_jsonb(OLD); END IF;
    FOR i IN 0 .. TG_NARGS - 1 LOOP
        col  := split_part(TG_ARGV[i], ':', 1);
        dflt := substr(TG_ARGV[i], length(col) + 2)::jsonb;
        IF TG_OP = 'INSERT' AND (newj -> col) IS DISTINCT FROM dflt THEN
            RAISE EXCEPTION 'derived_field_write: %.%', TG_TABLE_NAME, col
                USING ERRCODE = 'restrict_violation';
        ELSIF TG_OP = 'UPDATE' AND (newj -> col) IS DISTINCT FROM (oldj -> col) THEN
            RAISE EXCEPTION 'derived_field_write: %.%', TG_TABLE_NAME, col
                USING ERRCODE = 'restrict_violation';
        END IF;
    END LOOP;
    RETURN NEW;
END $$ LANGUAGE plpgsql;

CREATE FUNCTION guard_append_only() RETURNS trigger AS $$
BEGIN
    RAISE EXCEPTION 'append_only_%: %', lower(TG_OP), TG_TABLE_NAME
        USING ERRCODE = 'restrict_violation';
END $$ LANGUAGE plpgsql;


-- ═══════════════════════════════════════════════════════════════════════════
-- الجغرافيا والإعدادات
-- ═══════════════════════════════════════════════════════════════════════════
CREATE TABLE cities (
    code     text PRIMARY KEY CHECK (code ~ '^[A-Z]{3}$'),
    name_ar  text NOT NULL,
    name_en  text NOT NULL,
    active   boolean NOT NULL DEFAULT true
);

-- إعدادات المالك لكل مدينة. قيمة NULL = «لم يقرّرها المالك بعد»: العملية التي
-- تحتاجها ترفع missing_setting ولا تسقط على افتراض (لا احتياط صامت).
CREATE TABLE city_settings (
    city                    text PRIMARY KEY REFERENCES cities(code),
    -- الحد الأدنى للطلبية (§2.3): مبلغ و/أو عدد أصناف. كلاهما NULL = لم يُقرَّر.
    min_order_amount        money_lyd CHECK (min_order_amount >= 0),
    min_order_lines         int CHECK (min_order_lines >= 0),
    min_order_decided       boolean NOT NULL DEFAULT false,
    -- رسم التوصيل (§2.3)
    fee_mode                fee_mode,
    delivery_fee_flat       money_lyd CHECK (delivery_fee_flat >= 0),
    free_delivery_threshold money_lyd CHECK (free_delivery_threshold > 0),
    -- سياسة النفاد (§2.2) على مستوى المشروع
    oos_policy              oos_policy,
    -- مخزن مَدَد أولاً (§4.1) — الـSPEC يسمّي الافتراضي صراحة
    warehouse_first         boolean NOT NULL DEFAULT true,
    -- الاعتماد الآلي (§3.2): NULL = يدوي دائماً
    auto_confirm_max_amount money_lyd CHECK (auto_confirm_max_amount > 0),
    -- أجر السائق (§4.2)
    driver_pay_base         money_lyd CHECK (driver_pay_base >= 0),
    driver_pay_per_stop     money_lyd CHECK (driver_pay_per_stop >= 0),
    driver_pay_per_km       money_lyd CHECK (driver_pay_per_km >= 0),
    -- سقف الكاش بحوزة السائق (§5)
    driver_cash_cap         money_lyd CHECK (driver_cash_cap >= 0),
    -- التحصيل على الدفعات (§4.3) — الـSPEC يسمّي الافتراضي صراحة
    collection_mode         collection_mode NOT NULL DEFAULT 'on_completion',
    -- إعادة التسعير عند تغيّر سعر الشراء (بانتظار قرار المالك م-6). NULL = يُوسَم للمراجعة فقط.
    reprice_on_cost_change  boolean,
    -- حدّ محاولات الدخول (§1.1) — تقني
    login_max_failures      int NOT NULL DEFAULT 5 CHECK (login_max_failures > 0),
    login_lock_minutes      int NOT NULL DEFAULT 15 CHECK (login_lock_minutes > 0),
    CHECK (fee_mode IS DISTINCT FROM 'flat' OR delivery_fee_flat IS NOT NULL)
);

CREATE TABLE delivery_zones (
    id      bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    city    text NOT NULL REFERENCES cities(code),
    name_ar text NOT NULL,
    fee     money_lyd NOT NULL CHECK (fee >= 0),
    active  boolean NOT NULL DEFAULT true,
    UNIQUE (city, name_ar)
);


-- ═══════════════════════════════════════════════════════════════════════════
-- الملفات — خدمة رفع واحدة، ولا صور داخل القاعدة
-- ═══════════════════════════════════════════════════════════════════════════
CREATE TABLE media_files (
    id           bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    storage_key  text NOT NULL UNIQUE CHECK (storage_key !~ '^data:'),
    mime_type    text NOT NULL CHECK (mime_type IN ('image/jpeg', 'image/png', 'image/webp',
                                                    'application/pdf')),
    byte_size    int NOT NULL CHECK (byte_size > 0 AND byte_size <= 10485760),
    sha256       text NOT NULL CHECK (sha256 ~ '^[0-9a-f]{64}$'),
    -- private: هوية/رخصة/سجل — للّوحة وحدها
    is_private   boolean NOT NULL,
    uploaded_by  bigint,
    created_at   timestamptz NOT NULL DEFAULT now()
);


-- ═══════════════════════════════════════════════════════════════════════════
-- الهوية والدخول
-- ═══════════════════════════════════════════════════════════════════════════
-- المفتاح المركّب (رقم + نوع الحساب) — §1.1
CREATE TABLE app_users (
    id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    phone       text NOT NULL CHECK (phone ~ '^\+2189[0-9]{8}$'),
    audience    audience NOT NULL,
    full_name   text NOT NULL CHECK (length(btrim(full_name)) > 0),
    active      boolean NOT NULL DEFAULT true,
    created_at  timestamptz NOT NULL DEFAULT now(),
    UNIQUE (phone, audience),
    UNIQUE (id, audience)
);

CREATE TABLE otp_challenges (
    id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    phone       text NOT NULL,
    audience    audience NOT NULL,
    code_hash   text NOT NULL,
    expires_at  timestamptz NOT NULL,
    consumed_at timestamptz,
    created_at  timestamptz NOT NULL DEFAULT now(),
    CHECK (expires_at > created_at)
);
CREATE INDEX ON otp_challenges (phone, audience, created_at DESC);

-- حدّ المحاولات على (رقم + نوع الحساب) — §1.1
CREATE TABLE auth_throttle (
    phone         text NOT NULL,
    audience      audience NOT NULL,
    failed_count  int NOT NULL DEFAULT 0 CHECK (failed_count >= 0),
    locked_until  timestamptz,
    PRIMARY KEY (phone, audience)
);

-- رمز التجديد يُستهلك مرة ويُدوَّر؛ إعادة استعمال رمز مستهلك تُبطل العائلة كلها.
CREATE TABLE refresh_tokens (
    id           bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    user_id      bigint NOT NULL,
    audience     audience NOT NULL,
    family_id    uuid NOT NULL,
    token_hash   text NOT NULL UNIQUE,
    expires_at   timestamptz NOT NULL,
    consumed_at  timestamptz,
    revoked_at   timestamptz,
    created_at   timestamptz NOT NULL DEFAULT now(),
    FOREIGN KEY (user_id, audience) REFERENCES app_users(id, audience)
);
CREATE INDEX ON refresh_tokens (family_id);

CREATE TABLE device_tokens (
    id         bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    user_id    bigint NOT NULL REFERENCES app_users(id),
    fcm_token  text NOT NULL UNIQUE,
    platform   text NOT NULL CHECK (platform IN ('android', 'web')),
    updated_at timestamptz NOT NULL DEFAULT now()
);

-- مستخدمو اللوحة: المالك ومشرفون بصلاحيات جزئية — §6
CREATE TABLE admin_members (
    user_id   bigint PRIMARY KEY,
    audience  audience NOT NULL DEFAULT 'admin' CHECK (audience = 'admin'),
    role      admin_role NOT NULL,
    FOREIGN KEY (user_id, audience) REFERENCES app_users(id, audience)
);
CREATE TABLE admin_permissions (
    user_id    bigint NOT NULL REFERENCES admin_members(user_id) ON DELETE CASCADE,
    permission admin_permission NOT NULL,
    PRIMARY KEY (user_id, permission)
);


-- ═══════════════════════════════════════════════════════════════════════════
-- الأطراف
-- ═══════════════════════════════════════════════════════════════════════════
CREATE TABLE customers (
    id               bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    city             text NOT NULL REFERENCES cities(code),
    name             text NOT NULL CHECK (length(btrim(name)) > 0),
    kind             establishment_kind NOT NULL,
    contact_name     text NOT NULL,
    phone            text NOT NULL CHECK (phone ~ '^\+2189[0-9]{8}$'),
    facade_media_id  bigint NOT NULL REFERENCES media_files(id),     -- إلزامية
    cr_media_id      bigint REFERENCES media_files(id),              -- اختياري
    status           party_status NOT NULL DEFAULT 'pending',
    reviewed_by      bigint REFERENCES app_users(id),
    reviewed_at      timestamptz,
    -- نقطتا امتداد §8: معطّلتان في الإصدار الأول، والقيد يثبت ذلك.
    credit_limit     money_lyd NOT NULL DEFAULT 0 CONSTRAINT v1_credit_disabled CHECK (credit_limit = 0),
    referrer_id      bigint CONSTRAINT v1_referrer_disabled CHECK (referrer_id IS NULL),
    created_at       timestamptz NOT NULL DEFAULT now(),
    CHECK (status = 'pending' OR (reviewed_by IS NOT NULL AND reviewed_at IS NOT NULL))
);

CREATE TABLE customer_members (
    customer_id bigint NOT NULL REFERENCES customers(id),
    user_id     bigint NOT NULL,
    audience    audience NOT NULL DEFAULT 'customer' CHECK (audience = 'customer'),
    role        member_role NOT NULL,
    PRIMARY KEY (customer_id, user_id),
    FOREIGN KEY (user_id, audience) REFERENCES app_users(id, audience)
);

-- موقع التسليم. جدول مستقل لتضاف الفروع لاحقاً بلا كسر (م-9)؛ الإصدار الأول:
-- موقع فعّال واحد لكل منشأة (الفهرس الجزئي أدناه).
CREATE TABLE customer_locations (
    id           bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    customer_id  bigint NOT NULL REFERENCES customers(id),
    city         text NOT NULL REFERENCES cities(code),
    lat          numeric(9,6) NOT NULL CHECK (lat BETWEEN -90 AND 90),
    lng          numeric(9,6) NOT NULL CHECK (lng BETWEEN -180 AND 180),
    address_text text NOT NULL CHECK (length(btrim(address_text)) > 0),
    zone_id      bigint REFERENCES delivery_zones(id),
    active       boolean NOT NULL DEFAULT true
);
CREATE UNIQUE INDEX v1_one_active_location ON customer_locations (customer_id) WHERE active;

CREATE TABLE suppliers (
    id               bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    city             text NOT NULL REFERENCES cities(code),
    name             text NOT NULL CHECK (length(btrim(name)) > 0),
    contact_name     text NOT NULL,
    phone            text NOT NULL CHECK (phone ~ '^\+2189[0-9]{8}$'),
    owner_id_media_id bigint NOT NULL REFERENCES media_files(id),   -- إلزامية
    cr_media_id      bigint REFERENCES media_files(id),
    status           party_status NOT NULL DEFAULT 'pending',
    -- دورية الصرف: تُختار عند الاعتماد بلا قيمة افتراضية (§5).
    payout_cycle     payout_cycle,
    reviewed_by      bigint REFERENCES app_users(id),
    reviewed_at      timestamptz,
    created_at       timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT payout_cycle_on_approval CHECK (status <> 'approved' OR payout_cycle IS NOT NULL),
    CHECK (status = 'pending' OR (reviewed_by IS NOT NULL AND reviewed_at IS NOT NULL))
);

CREATE TABLE supplier_members (
    supplier_id bigint NOT NULL REFERENCES suppliers(id),
    user_id     bigint NOT NULL UNIQUE,
    audience    audience NOT NULL DEFAULT 'supplier' CHECK (audience = 'supplier'),
    PRIMARY KEY (supplier_id, user_id),
    FOREIGN KEY (user_id, audience) REFERENCES app_users(id, audience)
);

CREATE TABLE supplier_pickup_locations (
    id           bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    supplier_id  bigint NOT NULL REFERENCES suppliers(id),
    city         text NOT NULL REFERENCES cities(code),
    label        text NOT NULL,
    lat          numeric(9,6) NOT NULL CHECK (lat BETWEEN -90 AND 90),
    lng          numeric(9,6) NOT NULL CHECK (lng BETWEEN -180 AND 180),
    address_text text NOT NULL,
    active       boolean NOT NULL DEFAULT true,
    UNIQUE (id, supplier_id)
);

CREATE TABLE drivers (
    id               bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    user_id          bigint NOT NULL UNIQUE,
    audience         audience NOT NULL DEFAULT 'driver' CHECK (audience = 'driver'),
    city             text NOT NULL REFERENCES cities(code),
    full_name        text NOT NULL,
    phone            text NOT NULL CHECK (phone ~ '^\+2189[0-9]{8}$'),
    id_media_id      bigint NOT NULL REFERENCES media_files(id),
    license_media_id bigint NOT NULL REFERENCES media_files(id),
    photo_media_id   bigint NOT NULL REFERENCES media_files(id),
    vehicle          vehicle_type NOT NULL,
    capacity_kg      numeric(8,1) CHECK (capacity_kg > 0),
    status           party_status NOT NULL DEFAULT 'pending',
    reviewed_by      bigint REFERENCES app_users(id),
    reviewed_at      timestamptz,
    created_at       timestamptz NOT NULL DEFAULT now(),
    FOREIGN KEY (user_id, audience) REFERENCES app_users(id, audience),
    CHECK (status = 'pending' OR (reviewed_by IS NOT NULL AND reviewed_at IS NOT NULL))
);

CREATE TABLE warehouses (
    id           bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    city         text NOT NULL REFERENCES cities(code),
    name         text NOT NULL,
    lat          numeric(9,6) NOT NULL,
    lng          numeric(9,6) NOT NULL,
    address_text text NOT NULL,
    active       boolean NOT NULL DEFAULT true
);


-- ═══════════════════════════════════════════════════════════════════════════
-- القاموس والكتالوج
-- ═══════════════════════════════════════════════════════════════════════════
-- التصنيف الأعلى يحمل أيقونة من أيقونات الهوية العشر (§9)؛ الفروع بلا أيقونة إلزامية.
CREATE TABLE categories (
    id        bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    parent_id bigint REFERENCES categories(id),
    name_ar   text NOT NULL,
    name_en   text NOT NULL,
    icon_key  text CHECK (icon_key IN ('food', 'beverages', 'kitchen_tools', 'cleaning',
                                       'packaging', 'general', 'equipment', 'cooling',
                                       'paper', 'more')),
    sort      int NOT NULL DEFAULT 0,
    active    boolean NOT NULL DEFAULT true,
    CHECK (parent_id IS NOT NULL OR icon_key IS NOT NULL),
    CHECK (parent_id IS DISTINCT FROM id)
);

-- قاموس أصناف مَدَد الموحّد (§2.1). الاسم المطبَّع يمنع «طماطم» بعشرة أسماء.
CREATE TABLE products (
    id                      bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    name_ar                 text NOT NULL CHECK (length(btrim(name_ar)) > 0),
    name_en                 text,
    name_norm               text GENERATED ALWAYS AS (
        regexp_replace(translate(lower(btrim(name_ar)), 'أإآةىـ', 'اااهي'), '\s+', ' ', 'g')
    ) STORED,
    category_id             bigint NOT NULL REFERENCES categories(id),
    status                  product_status NOT NULL,
    proposed_by_supplier_id bigint REFERENCES suppliers(id),
    merged_into_id          bigint REFERENCES products(id),
    created_at              timestamptz NOT NULL DEFAULT now(),
    CHECK (status <> 'proposed' OR proposed_by_supplier_id IS NOT NULL),
    CHECK ((status = 'merged') = (merged_into_id IS NOT NULL))
);
CREATE UNIQUE INDEX products_unique_name ON products (name_norm)
    WHERE status IN ('proposed', 'approved');

-- عرض المورد (§2.1). الكمية: المورد يكتب reported_qty، والمنظومة تشتق الباقي.
CREATE TABLE supplier_offers (
    id                 bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    supplier_id        bigint NOT NULL REFERENCES suppliers(id),
    product_id         bigint NOT NULL REFERENCES products(id),
    unit               sale_unit NOT NULL,
    unit_size          qty NOT NULL CHECK (unit_size > 0),   -- «كرتونة ×12» → 12
    purchase_price     money_lyd NOT NULL CHECK (purchase_price > 0),
    reported_qty       qty NOT NULL,
    qty_reported_at    timestamptz NOT NULL DEFAULT now(),       -- ◆ للعرض فقط
    -- عدّاد الإبلاغ: يزيد مع كل إبلاغ بكمية. المقارنة به لا بالوقت —
    -- ساعة الخادم قد تُصحَّح إلى الخلف فتقلب مقارنة now() بـnow().
    report_seq         int NOT NULL DEFAULT 0,                   -- ◆
    reserved_qty       qty NOT NULL DEFAULT 0,                   -- ◆ مخطط استلام لم يُجمع
    consumed_qty       qty NOT NULL DEFAULT 0,                   -- ◆ جُمع منذ آخر إبلاغ
    available_qty      numeric GENERATED ALWAYS AS (reported_qty - reserved_qty - consumed_qty) STORED,
    min_order_qty      qty CHECK (min_order_qty > 0),
    pickup_location_id bigint NOT NULL,
    status             offer_status NOT NULL DEFAULT 'active',
    created_at         timestamptz NOT NULL DEFAULT now(),
    updated_at         timestamptz NOT NULL DEFAULT now(),
    -- موقع الاستلام من مواقع المورد نفسه — بنيوياً بمفتاح مركّب
    FOREIGN KEY (pickup_location_id, supplier_id)
        REFERENCES supplier_pickup_locations(id, supplier_id),
    UNIQUE (supplier_id, product_id, unit, unit_size, pickup_location_id)
);

CREATE TABLE supplier_offer_media (
    offer_id bigint NOT NULL REFERENCES supplier_offers(id) ON DELETE CASCADE,
    media_id bigint NOT NULL REFERENCES media_files(id),
    sort     int NOT NULL DEFAULT 0,
    PRIMARY KEY (offer_id, media_id)
);

-- سجل أسعار الشراء (§2.2) — ملحق فقط، كاتبه مشغّل.
CREATE TABLE supplier_offer_price_history (
    id         bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    offer_id   bigint NOT NULL REFERENCES supplier_offers(id),
    old_price  money_lyd,
    new_price  money_lyd NOT NULL,
    actor_role actor_role NOT NULL,
    actor_id   bigint,
    changed_at timestamptz NOT NULL DEFAULT now()
);

-- صنف الكتالوج العام (§2.2). ما يراه العميل فقط؛ التسعير والمصادر في جداول اللوحة.
CREATE TABLE catalog_items (
    id            bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    city          text NOT NULL REFERENCES cities(code),
    product_id    bigint NOT NULL REFERENCES products(id),
    category_id   bigint NOT NULL REFERENCES categories(id),
    name_ar       text NOT NULL,
    name_en       text,
    unit          sale_unit NOT NULL,
    unit_size     qty NOT NULL CHECK (unit_size > 0),
    image_media_id bigint REFERENCES media_files(id),
    weight_kg     numeric(8,3) CHECK (weight_kg > 0),   -- لتقدير الحمولة (م-13)
    sale_price    money_lyd CHECK (sale_price > 0),      -- ◆ مخزّن صراحة
    visibility    visibility NOT NULL DEFAULT 'hidden',
    oos_policy    oos_policy,                            -- NULL = سياسة المدينة
    is_available  boolean NOT NULL DEFAULT false,        -- ◆
    created_at    timestamptz NOT NULL DEFAULT now(),
    UNIQUE (city, product_id, unit, unit_size),
    CHECK (visibility = 'hidden' OR sale_price IS NOT NULL)
);

-- للّوحة وحدها: الهامش وطريقة التسعير.
CREATE TABLE catalog_item_pricing (
    catalog_item_id bigint PRIMARY KEY REFERENCES catalog_items(id),
    mode            pricing_mode NOT NULL,
    manual_price    money_lyd CHECK (manual_price > 0),
    margin_value    numeric CHECK (margin_value >= 0 AND margin_value = round(margin_value, 2)),
    needs_review    boolean NOT NULL DEFAULT false,      -- ◆ سعر الشراء تغيّر بعد آخر تسعير
    updated_at      timestamptz NOT NULL DEFAULT now(),
    CHECK ((mode = 'manual') = (manual_price IS NOT NULL)),
    CHECK ((mode = 'manual') = (margin_value IS NULL))
);

-- للّوحة وحدها: من أين يُشترى وبأي أولوية.
CREATE TABLE catalog_item_sources (
    catalog_item_id bigint NOT NULL REFERENCES catalog_items(id),
    offer_id        bigint NOT NULL REFERENCES supplier_offers(id),
    priority        int NOT NULL CHECK (priority >= 1),
    PRIMARY KEY (catalog_item_id, offer_id),
    UNIQUE (catalog_item_id, priority) DEFERRABLE INITIALLY DEFERRED
);

-- سجل أسعار البيع (§2.2) — ملحق فقط، كاتبه مشغّل.
CREATE TABLE catalog_price_history (
    id              bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    catalog_item_id bigint NOT NULL REFERENCES catalog_items(id),
    old_price       money_lyd,
    new_price       money_lyd NOT NULL,
    actor_role      actor_role NOT NULL,
    actor_id        bigint,
    changed_at      timestamptz NOT NULL DEFAULT now()
);


-- ═══════════════════════════════════════════════════════════════════════════
-- المخازن
-- ═══════════════════════════════════════════════════════════════════════════
CREATE TABLE warehouse_stock (
    warehouse_id    bigint NOT NULL REFERENCES warehouses(id),
    catalog_item_id bigint NOT NULL REFERENCES catalog_items(id),
    on_hand         qty NOT NULL DEFAULT 0,                 -- ◆ مجموع الحركات
    reserved_qty    qty NOT NULL DEFAULT 0,                 -- ◆ مخطط استلام لم يُجمع
    avg_cost        numeric NOT NULL DEFAULT 0 CHECK (avg_cost >= 0),  -- ◆ (م-12)
    available_qty   numeric GENERATED ALWAYS AS (on_hand - reserved_qty) STORED,
    PRIMARY KEY (warehouse_id, catalog_item_id),
    CHECK (reserved_qty <= on_hand)
);

-- إدخال / جرد / تحويل / سحب لطلبية — ملحق فقط.
CREATE TABLE stock_movements (
    id              bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    warehouse_id    bigint NOT NULL REFERENCES warehouses(id),
    catalog_item_id bigint NOT NULL REFERENCES catalog_items(id),
    kind            stock_move_kind NOT NULL,
    qty_delta       numeric NOT NULL CHECK (qty_delta <> 0 AND qty_delta = round(qty_delta, 3)),
    unit_cost       numeric CHECK (unit_cost >= 0),        -- ◆ للتحويل: متوسط تكلفة المصدر
    supplier_id     bigint REFERENCES suppliers(id),       -- مصدر الإدخال إن كان مورداً
    transfer_id     uuid,
    stop_line_id    bigint,
    note            text,
    actor_role      actor_role NOT NULL,                  -- ◆
    actor_id        bigint,                               -- ◆
    created_at      timestamptz NOT NULL DEFAULT now(),
    CHECK (kind <> 'intake' OR (qty_delta > 0 AND unit_cost > 0 AND unit_cost = round(unit_cost, 2))),
    CHECK (kind NOT IN ('transfer_out', 'transfer_in') OR transfer_id IS NOT NULL),
    CHECK (kind <> 'transfer_out' OR qty_delta < 0),
    CHECK (kind <> 'transfer_in' OR qty_delta > 0),
    CHECK (kind <> 'pickup' OR (qty_delta < 0 AND stop_line_id IS NOT NULL))
);


-- ═══════════════════════════════════════════════════════════════════════════
-- القوائم المتكررة (§3.1)
-- ═══════════════════════════════════════════════════════════════════════════
CREATE TABLE recurring_lists (
    id              bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    customer_id     bigint NOT NULL REFERENCES customers(id),
    name            text NOT NULL CHECK (length(btrim(name)) > 0),
    reminder_days   smallint[] CHECK (reminder_days <@ ARRAY[0,1,2,3,4,5,6]::smallint[]),
    reminder_time   time,
    created_by      bigint NOT NULL REFERENCES app_users(id),
    created_at      timestamptz NOT NULL DEFAULT now(),
    UNIQUE (customer_id, name),
    CHECK ((reminder_days IS NULL) = (reminder_time IS NULL))
);

CREATE TABLE recurring_list_items (
    list_id         bigint NOT NULL REFERENCES recurring_lists(id) ON DELETE CASCADE,
    catalog_item_id bigint NOT NULL REFERENCES catalog_items(id),
    qty             qty NOT NULL CHECK (qty > 0),
    PRIMARY KEY (list_id, catalog_item_id)
);


-- ═══════════════════════════════════════════════════════════════════════════
-- الطلبات (§3)
-- ═══════════════════════════════════════════════════════════════════════════
CREATE TABLE orders (
    id                  bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    city                text NOT NULL REFERENCES cities(code),
    customer_id         bigint NOT NULL REFERENCES customers(id),
    created_by          bigint NOT NULL REFERENCES app_users(id),
    status              order_status NOT NULL DEFAULT 'draft',
    payment_method      payment_method NOT NULL DEFAULT 'cash',
    -- لقطة الوجهة لحظة placed ◆
    location_id         bigint REFERENCES customer_locations(id),
    dest_lat            numeric(9,6),
    dest_lng            numeric(9,6),
    dest_address        text,
    zone_id             bigint REFERENCES delivery_zones(id),
    -- المال ◆
    subtotal            money_lyd NOT NULL DEFAULT 0,
    line_count          int NOT NULL DEFAULT 0,
    delivery_fee        money_lyd NOT NULL DEFAULT 0,
    total               numeric GENERATED ALWAYS AS (subtotal + delivery_fee) STORED,
    collection_mode     collection_mode,                     -- ◆ لقطة عند placed
    -- الإسناد
    driver_id           bigint REFERENCES drivers(id),
    route_km            numeric(7,2) CHECK (route_km >= 0),  -- مُدخل خدمة المسار (Mapbox)
    driver_pay          money_lyd CHECK (driver_pay >= 0),   -- ◆ المعادلة أو العرض المقبول
    plan_complete       boolean NOT NULL DEFAULT false,      -- ◆ كل الكميات مخطّطة
    -- الحالة
    placed_at           timestamptz,
    confirmed_at        timestamptz,
    assigned_at         timestamptz,
    delivered_at        timestamptz,
    closed_at           timestamptz,
    cancelled_at        timestamptz,
    cancelled_by_role   actor_role,
    cancel_reason       text,
    notes               text,
    created_at          timestamptz NOT NULL DEFAULT now(),
    CHECK (status NOT IN ('assigned', 'collecting', 'partially_delivered', 'delivered', 'closed')
           OR (driver_id IS NOT NULL AND driver_pay IS NOT NULL)),
    CHECK (status IN ('draft', 'cancelled') OR placed_at IS NOT NULL),
    CHECK (status <> 'cancelled' OR cancelled_by_role <> 'admin'
           OR length(btrim(coalesce(cancel_reason, ''))) > 0)
);
-- سلة واحدة مفتوحة لكل منشأة (مسودة مشتركة بين مستخدميها).
CREATE UNIQUE INDEX one_draft_per_customer ON orders (customer_id) WHERE status = 'draft';
CREATE INDEX ON orders (city, status);
CREATE INDEX ON orders (driver_id) WHERE driver_id IS NOT NULL;

CREATE TABLE order_items (
    id               bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    order_id         bigint NOT NULL REFERENCES orders(id),
    catalog_item_id  bigint NOT NULL REFERENCES catalog_items(id),
    unit             sale_unit NOT NULL,
    qty              qty NOT NULL CHECK (qty > 0),
    unit_price       money_lyd,                             -- ◆ يُحجز عند placed
    line_total       numeric GENERATED ALWAYS AS (round(qty * unit_price, 2)) STORED,
    delivered_qty    qty NOT NULL DEFAULT 0,                -- ◆ من الدفعات المسلَّمة
    UNIQUE (order_id, catalog_item_id),
    CHECK (unit IN ('kg', 'liter') OR qty = trunc(qty)),
    CHECK (delivered_qty <= qty)
);

-- سجل الحالات — ملحق فقط، كاتبه مشغّل الانتقال.
CREATE TABLE order_status_events (
    id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    order_id    bigint NOT NULL REFERENCES orders(id),
    from_status order_status,
    to_status   order_status NOT NULL,
    actor_role  text NOT NULL,
    actor_id    bigint,
    reason      text,
    at          timestamptz NOT NULL DEFAULT now()
);


-- ═══════════════════════════════════════════════════════════════════════════
-- مخطط الاستلام (§4.1)
-- ═══════════════════════════════════════════════════════════════════════════
CREATE TABLE pickup_stops (
    id                 bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    order_id           bigint NOT NULL REFERENCES orders(id),
    seq                int NOT NULL CHECK (seq >= 1),
    source             stop_source NOT NULL,
    supplier_id        bigint REFERENCES suppliers(id),
    pickup_location_id bigint,
    warehouse_id       bigint REFERENCES warehouses(id),
    pickup_code        text NOT NULL DEFAULT lpad(((('x' || encode(public.gen_random_bytes(4), 'hex'))::bit(32)::bigint % 1000000))::text, 6, '0')
                       CHECK (pickup_code ~ '^[0-9]{6}$'),
    status             stop_status NOT NULL DEFAULT 'pending',
    confirmed_at       timestamptz,
    photo_media_id     bigint REFERENCES media_files(id),
    UNIQUE (order_id, seq) DEFERRABLE INITIALLY DEFERRED,
    FOREIGN KEY (pickup_location_id, supplier_id)
        REFERENCES supplier_pickup_locations(id, supplier_id),
    CHECK ((source = 'supplier') = (supplier_id IS NOT NULL AND pickup_location_id IS NOT NULL)),
    CHECK ((source = 'warehouse') = (warehouse_id IS NOT NULL)),
    CHECK ((status = 'pending') = (confirmed_at IS NULL) OR status = 'cancelled')
);

CREATE TABLE pickup_stop_lines (
    id              bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    stop_id         bigint NOT NULL REFERENCES pickup_stops(id),
    order_item_id   bigint NOT NULL REFERENCES order_items(id),
    offer_id        bigint REFERENCES supplier_offers(id),   -- NULL لسطر المخزن
    planned_qty     qty NOT NULL CHECK (planned_qty > 0),
    collected_qty   qty CHECK (collected_qty <= planned_qty),
    offer_report_seq int,                                     -- ◆ عدّاد إبلاغ العرض لحظة الجمع
    UNIQUE (stop_id, order_item_id)
);

-- للّوحة وحدها: تكلفة السطر (سعر الشراء أو متوسط تكلفة المخزن) لحظة التخطيط.
CREATE TABLE pickup_line_costs (
    stop_line_id bigint PRIMARY KEY REFERENCES pickup_stop_lines(id) ON DELETE CASCADE,
    unit_cost    numeric NOT NULL CHECK (unit_cost >= 0)
);


-- ═══════════════════════════════════════════════════════════════════════════
-- السائق: عروض الأجرة (§4.2)
-- ═══════════════════════════════════════════════════════════════════════════
CREATE TABLE driver_pay_offers (
    id         bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    order_id   bigint NOT NULL REFERENCES orders(id),
    driver_id  bigint NOT NULL REFERENCES drivers(id),
    amount     money_lyd NOT NULL CHECK (amount > 0),
    status     driver_offer_status NOT NULL DEFAULT 'pending',
    decided_by bigint REFERENCES app_users(id),
    created_at timestamptz NOT NULL DEFAULT now(),
    decided_at timestamptz
);
CREATE UNIQUE INDEX one_pending_offer_per_driver ON driver_pay_offers (order_id, driver_id)
    WHERE status = 'pending';


-- ═══════════════════════════════════════════════════════════════════════════
-- الإشعارات (§7)
-- ═══════════════════════════════════════════════════════════════════════════
CREATE TABLE notifications (
    id           bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    user_id      bigint NOT NULL REFERENCES app_users(id),
    kind         text NOT NULL CHECK (kind IN ('order_confirmed', 'order_assigned', 'batch_departure',
                                              'order_arrived', 'list_reminder', 'pickup_request',
                                              'driver_settlement', 'supplier_payout', 'broadcast',
                                              'otp')),
    order_id     bigint REFERENCES orders(id),
    batch_id     bigint,
    title        text NOT NULL,
    body         text NOT NULL,
    payload      jsonb NOT NULL DEFAULT '{}'::jsonb,
    channels     notification_channel[] NOT NULL DEFAULT ARRAY['push']::notification_channel[],
    created_at   timestamptz NOT NULL DEFAULT now(),
    sent_at      timestamptz,
    read_at      timestamptz,
    CHECK (kind <> 'batch_departure' OR (order_id IS NOT NULL AND batch_id IS NOT NULL))
);
CREATE INDEX ON notifications (user_id, created_at DESC);

CREATE TABLE broadcasts (
    id         bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    city       text NOT NULL REFERENCES cities(code),
    audience   audience NOT NULL CHECK (audience IN ('customer', 'driver')),
    title      text NOT NULL,
    body       text NOT NULL,
    created_by bigint NOT NULL REFERENCES app_users(id),
    created_at timestamptz NOT NULL DEFAULT now()
);


-- ═══════════════════════════════════════════════════════════════════════════
-- التسليم على دفعات (§4.3)
-- ═══════════════════════════════════════════════════════════════════════════
CREATE TABLE order_batches (
    id              bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    order_id        bigint NOT NULL REFERENCES orders(id),
    seq             int NOT NULL CHECK (seq >= 1),
    status          batch_status NOT NULL DEFAULT 'planned',
    eta_at          timestamptz,                 -- موعد هذه الدفعة
    next_eta_at     timestamptz,                 -- موعد ما سيصل لاحقاً
    notification_id bigint REFERENCES notifications(id),   -- ◆ كاتبه مشغّل الإشعار
    notified_at     timestamptz,                             -- ◆
    departed_at     timestamptz,                             -- ◆
    delivered_at    timestamptz,                             -- ◆
    UNIQUE (order_id, seq),
    -- لا دفعة بلا إشعار (§4.3): بنيوياً
    CONSTRAINT batch_departure_requires_notice CHECK (
        status IN ('planned') OR (notification_id IS NOT NULL AND notified_at IS NOT NULL)),
    CHECK (status NOT IN ('departed', 'delivered') OR (departed_at IS NOT NULL AND departed_at >= notified_at)),
    CHECK (status <> 'delivered' OR delivered_at IS NOT NULL)
);
ALTER TABLE notifications ADD FOREIGN KEY (batch_id) REFERENCES order_batches(id);

CREATE TABLE order_batch_lines (
    batch_id      bigint NOT NULL REFERENCES order_batches(id),
    order_item_id bigint NOT NULL REFERENCES order_items(id),
    qty           qty NOT NULL CHECK (qty > 0),
    PRIMARY KEY (batch_id, order_item_id)
);


-- ═══════════════════════════════════════════════════════════════════════════
-- التنازع (§3.2) — يقرره المالك يدوياً
-- ═══════════════════════════════════════════════════════════════════════════
CREATE TABLE disputes (
    id              bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    order_id        bigint NOT NULL REFERENCES orders(id),
    order_item_id   bigint REFERENCES order_items(id),
    opened_by_role  actor_role NOT NULL CHECK (opened_by_role IN ('customer', 'driver')),
    opened_by       bigint NOT NULL REFERENCES app_users(id),
    kind            dispute_kind NOT NULL,
    description     text NOT NULL,
    status          dispute_status NOT NULL DEFAULT 'open',
    resolution      dispute_resolution,
    resolution_amount money_lyd CHECK (resolution_amount >= 0),
    resolution_note text,
    resolved_by     bigint REFERENCES app_users(id),
    resolved_at     timestamptz,
    created_at      timestamptz NOT NULL DEFAULT now(),
    CHECK ((status = 'resolved') = (resolution IS NOT NULL AND resolved_by IS NOT NULL
                                    AND resolved_at IS NOT NULL))
);
CREATE TABLE dispute_media (
    dispute_id bigint NOT NULL REFERENCES disputes(id),
    media_id   bigint NOT NULL REFERENCES media_files(id),
    PRIMARY KEY (dispute_id, media_id)
);


-- ═══════════════════════════════════════════════════════════════════════════
-- الدفتر (§5) — دفتر واحد، قيد مزدوج، لا جدول محفظة لأي طرف
-- ═══════════════════════════════════════════════════════════════════════════
-- إشارة المبلغ: موجب = مدين، سالب = دائن. مجموع قيود كل حركة = صفر.
CREATE TABLE ledger_accounts (
    id           bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    kind         ledger_account_kind NOT NULL,
    city         text NOT NULL REFERENCES cities(code),
    customer_id  bigint REFERENCES customers(id),
    driver_id    bigint REFERENCES drivers(id),
    supplier_id  bigint REFERENCES suppliers(id),
    warehouse_id bigint REFERENCES warehouses(id),
    balance      numeric NOT NULL DEFAULT 0,          -- ◆ مجموع القيود
    CHECK (num_nonnulls(customer_id, driver_id, supplier_id, warehouse_id) =
           CASE WHEN kind IN ('customer_receivable', 'driver_cash', 'driver_wallet',
                              'supplier_payable', 'warehouse_inventory') THEN 1 ELSE 0 END),
    CHECK (kind <> 'customer_receivable' OR customer_id IS NOT NULL),
    CHECK (kind NOT IN ('driver_cash', 'driver_wallet') OR driver_id IS NOT NULL),
    CHECK (kind <> 'supplier_payable' OR supplier_id IS NOT NULL),
    CHECK (kind <> 'warehouse_inventory' OR warehouse_id IS NOT NULL)
);
CREATE UNIQUE INDEX ledger_account_identity ON ledger_accounts
    (kind, city, coalesce(customer_id, 0), coalesce(driver_id, 0),
     coalesce(supplier_id, 0), coalesce(warehouse_id, 0));

CREATE TABLE ledger_transactions (
    id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    kind        ledger_txn_kind NOT NULL,
    city        text NOT NULL REFERENCES cities(code),
    order_id    bigint REFERENCES orders(id),
    batch_id    bigint REFERENCES order_batches(id),
    ref_table   text,
    ref_id      bigint,
    reverses_id bigint REFERENCES ledger_transactions(id),
    memo        text NOT NULL,
    actor_role  text NOT NULL,
    actor_id    bigint,
    occurred_at timestamptz NOT NULL DEFAULT now(),
    CHECK ((kind = 'reversal') = (reverses_id IS NOT NULL))
);
CREATE UNIQUE INDEX one_reversal_per_txn ON ledger_transactions (reverses_id) WHERE reverses_id IS NOT NULL;

CREATE TABLE ledger_entries (
    id             bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    transaction_id bigint NOT NULL REFERENCES ledger_transactions(id),
    account_id     bigint NOT NULL REFERENCES ledger_accounts(id),
    amount         money_lyd NOT NULL CHECK (amount <> 0)
);
CREATE INDEX ON ledger_entries (account_id);
CREATE INDEX ON ledger_entries (transaction_id);

-- مصادر الحركات اليدوية — كلها ملحقة فقط، وكل صف يولّد حركته بمشغّل.
CREATE TABLE cash_handovers (
    id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    driver_id   bigint NOT NULL REFERENCES drivers(id),
    amount      money_lyd NOT NULL CHECK (amount > 0),
    received_by bigint NOT NULL REFERENCES app_users(id),
    note        text,
    created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE supplier_payouts (
    id               bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    supplier_id      bigint NOT NULL REFERENCES suppliers(id),
    amount           money_lyd NOT NULL CHECK (amount > 0),
    period_start     date NOT NULL,
    period_end       date NOT NULL,
    receipt_media_id bigint REFERENCES media_files(id),
    paid_by          bigint NOT NULL REFERENCES app_users(id),
    created_at       timestamptz NOT NULL DEFAULT now(),
    CHECK (period_end >= period_start)
);

CREATE TABLE expenses (
    id         bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    city       text NOT NULL REFERENCES cities(code),
    category   text NOT NULL,
    amount     money_lyd NOT NULL CHECK (amount > 0),
    spent_on   date NOT NULL,
    order_id   bigint REFERENCES orders(id),
    note       text,
    created_by bigint NOT NULL REFERENCES app_users(id),
    created_at timestamptz NOT NULL DEFAULT now()
);


-- ═══════════════════════════════════════════════════════════════════════════
-- سجل التدقيق (§6) — كل تغيير في سعر أو حالة أو مال
-- ═══════════════════════════════════════════════════════════════════════════
CREATE TABLE audit_log (
    id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    table_name  text NOT NULL,
    row_pk      text NOT NULL,
    op          text NOT NULL CHECK (op IN ('INSERT', 'UPDATE', 'DELETE')),
    actor_role  text NOT NULL,
    actor_id    bigint,
    before      jsonb,
    after       jsonb,
    at          timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ON audit_log (table_name, row_pk);


-- ═══════════════════════════════════════════════════════════════════════════
-- الدوال المساعدة
-- ═══════════════════════════════════════════════════════════════════════════
CREATE FUNCTION setting_missing(p_city text, p_key text) RETURNS void AS $$
BEGIN
    RAISE EXCEPTION 'missing_setting: %.%', p_city, p_key USING ERRCODE = 'check_violation';
END $$ LANGUAGE plpgsql;

CREATE FUNCTION require_admin(p_perm admin_permission) RETURNS void AS $$
DECLARE r admin_role;
BEGIN
    IF writer_role() IN ('trigger', 'system') THEN RETURN; END IF;
    IF actor_role() <> 'admin' THEN
        RAISE EXCEPTION 'forbidden_role: % needs admin', actor_role() USING ERRCODE = 'insufficient_privilege';
    END IF;
    SELECT role INTO r FROM admin_members WHERE user_id = actor_id();
    IF r IS NULL THEN
        RAISE EXCEPTION 'forbidden_role: not an admin member' USING ERRCODE = 'insufficient_privilege';
    END IF;
    IF r = 'owner' THEN RETURN; END IF;
    IF NOT EXISTS (SELECT 1 FROM admin_permissions WHERE user_id = actor_id() AND permission = p_perm) THEN
        RAISE EXCEPTION 'forbidden_permission: %', p_perm USING ERRCODE = 'insufficient_privilege';
    END IF;
END $$ LANGUAGE plpgsql;

-- حساب دفتر: يُجلب أو يُنشأ.
CREATE FUNCTION ledger_account(p_kind ledger_account_kind, p_city text, p_party bigint DEFAULT NULL)
RETURNS bigint AS $$
DECLARE acc bigint;
    c_id bigint; d_id bigint; s_id bigint; w_id bigint;
BEGIN
    CASE p_kind
        WHEN 'customer_receivable' THEN c_id := p_party;
        WHEN 'driver_cash', 'driver_wallet' THEN d_id := p_party;
        WHEN 'supplier_payable' THEN s_id := p_party;
        WHEN 'warehouse_inventory' THEN w_id := p_party;
        ELSE NULL;
    END CASE;
    SELECT id INTO acc FROM ledger_accounts
     WHERE kind = p_kind AND city = p_city
       AND coalesce(customer_id, 0) = coalesce(c_id, 0) AND coalesce(driver_id, 0) = coalesce(d_id, 0)
       AND coalesce(supplier_id, 0) = coalesce(s_id, 0) AND coalesce(warehouse_id, 0) = coalesce(w_id, 0);
    IF acc IS NULL THEN
        INSERT INTO ledger_accounts (kind, city, customer_id, driver_id, supplier_id, warehouse_id)
        VALUES (p_kind, p_city, c_id, d_id, s_id, w_id)
        ON CONFLICT DO NOTHING
        RETURNING id INTO acc;
        IF acc IS NULL THEN
            RETURN ledger_account(p_kind, p_city, p_party);
        END IF;
    END IF;
    RETURN acc;
END $$ LANGUAGE plpgsql;

CREATE FUNCTION ledger_balance(p_kind ledger_account_kind, p_city text, p_party bigint DEFAULT NULL)
RETURNS numeric AS $$
    SELECT coalesce((SELECT balance FROM ledger_accounts WHERE id = ledger_account(p_kind, p_city, p_party)), 0)
$$ LANGUAGE sql;

-- حركة دفتر: p_lines = [[account_id, amount], ...]. التوازن يُفحص عند الإيداع (مشغّل مؤجّل).
CREATE FUNCTION ledger_post(p_kind ledger_txn_kind, p_city text, p_memo text, p_lines jsonb,
                            p_order bigint DEFAULT NULL, p_batch bigint DEFAULT NULL,
                            p_ref_table text DEFAULT NULL, p_ref_id bigint DEFAULT NULL)
RETURNS bigint AS $$
DECLARE txn bigint; line jsonb;
BEGIN
    INSERT INTO ledger_transactions (kind, city, order_id, batch_id, ref_table, ref_id, memo,
                                     actor_role, actor_id)
    VALUES (p_kind, p_city, p_order, p_batch, p_ref_table, p_ref_id, p_memo,
            actor_role()::text, actor_id())
    RETURNING id INTO txn;
    FOR line IN SELECT * FROM jsonb_array_elements(p_lines) LOOP
        IF (line->>1)::numeric <> 0 THEN
            INSERT INTO ledger_entries (transaction_id, account_id, amount)
            VALUES (txn, (line->>0)::bigint, (line->>1)::numeric);
        END IF;
    END LOOP;
    RETURN txn;
END $$ LANGUAGE plpgsql;


-- ═══════════════════════════════════════════════════════════════════════════
-- مشغّلات الدفتر
-- ═══════════════════════════════════════════════════════════════════════════
CREATE FUNCTION trg_ledger_entry_apply() RETURNS trigger AS $$
DECLARE acc_city text; txn_city text;
BEGIN
    SELECT city INTO acc_city FROM ledger_accounts WHERE id = NEW.account_id;
    SELECT city INTO txn_city FROM ledger_transactions WHERE id = NEW.transaction_id;
    IF acc_city <> txn_city THEN
        RAISE EXCEPTION 'ledger_city_mismatch' USING ERRCODE = 'check_violation';
    END IF;
    UPDATE ledger_accounts SET balance = balance + NEW.amount WHERE id = NEW.account_id;
    RETURN NEW;
END $$ LANGUAGE plpgsql;
CREATE TRIGGER ledger_entry_apply AFTER INSERT ON ledger_entries
    FOR EACH ROW EXECUTE FUNCTION trg_ledger_entry_apply();

-- توازن القيد المزدوج: عند الإيداع، كل حركة مجموعها صفر ولها قيدان على الأقل.
CREATE FUNCTION trg_ledger_balanced() RETURNS trigger AS $$
DECLARE txn bigint; s numeric; n int;
BEGIN
    IF TG_TABLE_NAME = 'ledger_entries' THEN
        txn := (to_jsonb(NEW) ->> 'transaction_id')::bigint;
    ELSE
        txn := NEW.id;
    END IF;
    SELECT coalesce(sum(amount), 0), count(*) INTO s, n FROM ledger_entries WHERE transaction_id = txn;
    IF s <> 0 OR n < 2 THEN
        RAISE EXCEPTION 'ledger_unbalanced: txn % sum % entries %', txn, s, n
            USING ERRCODE = 'check_violation';
    END IF;
    RETURN NULL;
END $$ LANGUAGE plpgsql;
CREATE CONSTRAINT TRIGGER ledger_entries_balanced AFTER INSERT ON ledger_entries
    DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION trg_ledger_balanced();
CREATE CONSTRAINT TRIGGER ledger_txn_balanced AFTER INSERT ON ledger_transactions
    DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION trg_ledger_balanced();


-- ═══════════════════════════════════════════════════════════════════════════
-- سجلات الأسعار والتدقيق
-- ═══════════════════════════════════════════════════════════════════════════
CREATE FUNCTION trg_audit() RETURNS trigger AS $$
DECLARE pk text; b jsonb; a jsonb;
BEGIN
    IF TG_OP IN ('UPDATE', 'DELETE') THEN b := to_jsonb(OLD); END IF;
    IF TG_OP IN ('UPDATE', 'INSERT') THEN a := to_jsonb(NEW); END IF;
    IF TG_OP = 'UPDATE' AND a = b THEN RETURN NULL; END IF;
    pk := coalesce(a, b) ->> coalesce(TG_ARGV[0], 'id');
    INSERT INTO audit_log (table_name, row_pk, op, actor_role, actor_id, before, after)
    VALUES (TG_TABLE_NAME, pk, TG_OP, actor_role()::text, actor_id(), b, a);
    RETURN NULL;
END $$ LANGUAGE plpgsql;

CREATE FUNCTION trg_offer_price_history() RETURNS trigger AS $$
BEGIN
    IF TG_OP = 'INSERT' OR NEW.purchase_price IS DISTINCT FROM OLD.purchase_price THEN
        INSERT INTO supplier_offer_price_history (offer_id, old_price, new_price, actor_role, actor_id)
        VALUES (NEW.id, CASE WHEN TG_OP = 'UPDATE' THEN OLD.purchase_price END, NEW.purchase_price,
                actor_role(), actor_id());
    END IF;
    RETURN NULL;
END $$ LANGUAGE plpgsql;

CREATE FUNCTION trg_catalog_price_history() RETURNS trigger AS $$
BEGIN
    IF NEW.sale_price IS NOT NULL AND
       (TG_OP = 'INSERT' OR NEW.sale_price IS DISTINCT FROM OLD.sale_price) THEN
        INSERT INTO catalog_price_history (catalog_item_id, old_price, new_price, actor_role, actor_id)
        VALUES (NEW.id, CASE WHEN TG_OP = 'UPDATE' THEN OLD.sale_price END, NEW.sale_price,
                actor_role(), actor_id());
    END IF;
    RETURN NULL;
END $$ LANGUAGE plpgsql;


-- ═══════════════════════════════════════════════════════════════════════════
-- الاعتماد قبل أي عملية (§1.1)
-- ═══════════════════════════════════════════════════════════════════════════
CREATE FUNCTION trg_party_review() RETURNS trigger AS $$
BEGIN
    IF NEW.status IS DISTINCT FROM OLD.status THEN
        PERFORM require_admin('approvals');
    END IF;
    RETURN NEW;
END $$ LANGUAGE plpgsql;


-- ═══════════════════════════════════════════════════════════════════════════
-- العروض والتوفّر
-- ═══════════════════════════════════════════════════════════════════════════
-- b_: بعد الحارس. إبلاغ المورد بكمية جديدة يصفّر المستهلَك منذ الإبلاغ السابق.
CREATE FUNCTION trg_offer_before() RETURNS trigger AS $$
DECLARE s_status party_status;
BEGIN
    IF writer_role() <> 'trigger' THEN
        IF actor_role() = 'supplier' THEN
            IF NOT EXISTS (SELECT 1 FROM supplier_members
                            WHERE supplier_id = NEW.supplier_id AND user_id = actor_id()) THEN
                RAISE EXCEPTION 'forbidden_not_member' USING ERRCODE = 'insufficient_privilege';
            END IF;
        ELSIF actor_role() <> 'admin' THEN
            RAISE EXCEPTION 'forbidden_role: %', actor_role() USING ERRCODE = 'insufficient_privilege';
        END IF;
    END IF;
    SELECT status INTO s_status FROM suppliers WHERE id = NEW.supplier_id;
    IF TG_OP = 'INSERT' AND s_status <> 'approved' THEN
        RAISE EXCEPTION 'party_not_approved: supplier %', NEW.supplier_id USING ERRCODE = 'check_violation';
    END IF;
    IF TG_OP = 'UPDATE' AND (NEW.supplier_id <> OLD.supplier_id OR NEW.product_id <> OLD.product_id
                             OR NEW.unit <> OLD.unit OR NEW.unit_size <> OLD.unit_size) THEN
        RAISE EXCEPTION 'offer_identity_immutable' USING ERRCODE = 'restrict_violation';
    END IF;
    IF TG_OP = 'UPDATE' AND NEW.reported_qty IS DISTINCT FROM OLD.reported_qty THEN
        NEW.qty_reported_at := now();
        NEW.report_seq := OLD.report_seq + 1;
        NEW.consumed_qty := 0;
    END IF;
    IF TG_OP = 'UPDATE' THEN NEW.updated_at := now(); END IF;
    RETURN NEW;
END $$ LANGUAGE plpgsql;

CREATE FUNCTION refresh_offer_commitment(p_offer bigint) RETURNS void AS $$
DECLARE cur_seq int;
BEGIN
    SELECT report_seq INTO cur_seq FROM supplier_offers WHERE id = p_offer;
    UPDATE supplier_offers o SET
        reserved_qty = coalesce((
            SELECT sum(l.planned_qty) FROM pickup_stop_lines l
              JOIN pickup_stops s ON s.id = l.stop_id
             WHERE l.offer_id = p_offer AND s.status = 'pending'), 0),
        consumed_qty = coalesce((
            SELECT sum(l.collected_qty) FROM pickup_stop_lines l
              JOIN pickup_stops s ON s.id = l.stop_id
             WHERE l.offer_id = p_offer AND s.status IN ('collected', 'short')
               AND l.offer_report_seq = cur_seq), 0)
     WHERE o.id = p_offer;
END $$ LANGUAGE plpgsql;

CREATE FUNCTION refresh_warehouse_reservation(p_wh bigint, p_item bigint) RETURNS void AS $$
BEGIN
    INSERT INTO warehouse_stock (warehouse_id, catalog_item_id) VALUES (p_wh, p_item)
    ON CONFLICT DO NOTHING;
    UPDATE warehouse_stock SET reserved_qty = coalesce((
        SELECT sum(l.planned_qty) FROM pickup_stop_lines l
          JOIN pickup_stops s ON s.id = l.stop_id
          JOIN order_items oi ON oi.id = l.order_item_id
         WHERE s.warehouse_id = p_wh AND oi.catalog_item_id = p_item AND s.status = 'pending'), 0)
     WHERE warehouse_id = p_wh AND catalog_item_id = p_item;
END $$ LANGUAGE plpgsql;

-- توفّر صنف الكتالوج: مصدر نشط لمورد معتمد بكمية متاحة، أو مخزون في مخزن المدينة.
CREATE FUNCTION refresh_item_availability(p_item bigint) RETURNS void AS $$
DECLARE avail boolean;
BEGIN
    SELECT EXISTS (
        SELECT 1 FROM catalog_item_sources cs
          JOIN supplier_offers o ON o.id = cs.offer_id
          JOIN suppliers s ON s.id = o.supplier_id
         WHERE cs.catalog_item_id = p_item AND o.status = 'active' AND s.status = 'approved'
           AND o.available_qty > 0
    ) OR EXISTS (
        SELECT 1 FROM warehouse_stock ws
          JOIN warehouses w ON w.id = ws.warehouse_id
          JOIN catalog_items ci ON ci.id = ws.catalog_item_id
         WHERE ws.catalog_item_id = p_item AND w.active AND w.city = ci.city AND ws.available_qty > 0
    ) INTO avail;
    UPDATE catalog_items SET is_available = avail WHERE id = p_item AND is_available IS DISTINCT FROM avail;
END $$ LANGUAGE plpgsql;

-- السعر المشتق من التسعير. الأساس للهامش: سعر شراء المصدر الأعلى أولوية (§2.2).
CREATE FUNCTION reprice_item(p_item bigint) RETURNS void AS $$
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
        price := CASE p.mode WHEN 'margin_pct' THEN round(base * (1 + p.margin_value / 100), 2)
                             ELSE round(base + p.margin_value, 2) END;
    END IF;
    UPDATE catalog_items SET sale_price = price WHERE id = p_item AND sale_price IS DISTINCT FROM price;
    UPDATE catalog_item_pricing SET needs_review = false WHERE catalog_item_id = p_item AND needs_review;
END $$ LANGUAGE plpgsql;

CREATE FUNCTION trg_offer_after() RETURNS trigger AS $$
DECLARE item bigint; city_reprice boolean;
BEGIN
    FOR item IN SELECT catalog_item_id FROM catalog_item_sources WHERE offer_id = NEW.id LOOP
        PERFORM refresh_item_availability(item);
        IF TG_OP = 'UPDATE' AND NEW.purchase_price IS DISTINCT FROM OLD.purchase_price THEN
            SELECT cs.reprice_on_cost_change INTO city_reprice
              FROM catalog_items ci JOIN city_settings cs ON cs.city = ci.city WHERE ci.id = item;
            IF city_reprice IS TRUE AND EXISTS (SELECT 1 FROM catalog_item_pricing
                                                 WHERE catalog_item_id = item AND mode <> 'manual') THEN
                PERFORM reprice_item(item);
            ELSE
                UPDATE catalog_item_pricing SET needs_review = true WHERE catalog_item_id = item;
            END IF;
        END IF;
    END LOOP;
    RETURN NULL;
END $$ LANGUAGE plpgsql;

CREATE FUNCTION trg_supplier_status_after() RETURNS trigger AS $$
DECLARE item bigint;
BEGIN
    IF NEW.status IS DISTINCT FROM OLD.status THEN
        FOR item IN SELECT DISTINCT cs.catalog_item_id FROM catalog_item_sources cs
                      JOIN supplier_offers o ON o.id = cs.offer_id WHERE o.supplier_id = NEW.id LOOP
            PERFORM refresh_item_availability(item);
        END LOOP;
    END IF;
    RETURN NULL;
END $$ LANGUAGE plpgsql;

-- المصدر يطابق الصنف: نفس منتج القاموس ونفس الوحدة وحجمها، ومنتج معتمد.
CREATE FUNCTION trg_source_check() RETURNS trigger AS $$
DECLARE ci catalog_items; o supplier_offers; pst product_status; s_city text;
BEGIN
    PERFORM require_admin('catalog');
    IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
    SELECT * INTO ci FROM catalog_items WHERE id = NEW.catalog_item_id;
    SELECT * INTO o FROM supplier_offers WHERE id = NEW.offer_id;
    SELECT status INTO pst FROM products WHERE id = o.product_id;
    SELECT city INTO s_city FROM suppliers WHERE id = o.supplier_id;
    IF o.product_id <> ci.product_id OR o.unit <> ci.unit OR o.unit_size <> ci.unit_size THEN
        RAISE EXCEPTION 'source_mismatch: offer % does not sell catalog_item % unit', o.id, ci.id
            USING ERRCODE = 'check_violation';
    END IF;
    IF pst <> 'approved' THEN
        RAISE EXCEPTION 'product_not_approved: %', o.product_id USING ERRCODE = 'check_violation';
    END IF;
    IF s_city <> ci.city THEN
        RAISE EXCEPTION 'source_city_mismatch' USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
END $$ LANGUAGE plpgsql;

CREATE FUNCTION trg_source_after() RETURNS trigger AS $$
DECLARE item bigint := coalesce(NEW.catalog_item_id, OLD.catalog_item_id);
BEGIN
    PERFORM refresh_item_availability(item);
    IF EXISTS (SELECT 1 FROM catalog_item_pricing WHERE catalog_item_id = item AND mode <> 'manual') THEN
        PERFORM reprice_item(item);
    END IF;
    RETURN NULL;
END $$ LANGUAGE plpgsql;

CREATE FUNCTION trg_pricing_after() RETURNS trigger AS $$
BEGIN
    PERFORM reprice_item(NEW.catalog_item_id);
    RETURN NULL;
END $$ LANGUAGE plpgsql;

CREATE FUNCTION trg_pricing_before() RETURNS trigger AS $$
BEGIN
    PERFORM require_admin('catalog');
    NEW.updated_at := now();
    RETURN NEW;
END $$ LANGUAGE plpgsql;

CREATE FUNCTION trg_catalog_item_before() RETURNS trigger AS $$
BEGIN
    IF writer_role() <> 'trigger' THEN
        PERFORM require_admin('catalog');
    END IF;
    RETURN NEW;
END $$ LANGUAGE plpgsql;

CREATE FUNCTION trg_catalog_item_after_insert() RETURNS trigger AS $$
BEGIN
    PERFORM refresh_item_availability(NEW.id);
    RETURN NULL;
END $$ LANGUAGE plpgsql;


-- ═══════════════════════════════════════════════════════════════════════════
-- المخزون
-- ═══════════════════════════════════════════════════════════════════════════
CREATE FUNCTION trg_stock_movement_before() RETURNS trigger AS $$
DECLARE src stock_movements; src_city text; dst_city text;
BEGIN
    IF writer_role() <> 'trigger' THEN
        PERFORM require_admin('warehouses');
        IF NEW.kind = 'pickup' THEN
            RAISE EXCEPTION 'derived_field_write: stock_movements.pickup' USING ERRCODE = 'restrict_violation';
        END IF;
        -- التكلفة مُدخل للإدخال وحده؛ غيره لقطة من متوسط المصدر
        IF NEW.kind <> 'intake' AND NEW.unit_cost IS NOT NULL THEN
            RAISE EXCEPTION 'derived_field_write: stock_movements.unit_cost' USING ERRCODE = 'restrict_violation';
        END IF;
    END IF;
    NEW.actor_role := actor_role();
    NEW.actor_id := actor_id();
    IF NEW.kind IN ('transfer_out', 'count_adjust', 'pickup') THEN
        NEW.unit_cost := coalesce((SELECT avg_cost FROM warehouse_stock
                                    WHERE warehouse_id = NEW.warehouse_id
                                      AND catalog_item_id = NEW.catalog_item_id), 0);
    ELSIF NEW.kind = 'transfer_in' THEN
        SELECT * INTO src FROM stock_movements WHERE transfer_id = NEW.transfer_id AND kind = 'transfer_out';
        IF src IS NULL OR src.catalog_item_id <> NEW.catalog_item_id OR src.qty_delta <> -NEW.qty_delta
           OR src.warehouse_id = NEW.warehouse_id THEN
            RAISE EXCEPTION 'transfer_mismatch: %', NEW.transfer_id USING ERRCODE = 'check_violation';
        END IF;
        SELECT city INTO src_city FROM warehouses WHERE id = src.warehouse_id;
        SELECT city INTO dst_city FROM warehouses WHERE id = NEW.warehouse_id;
        IF src_city <> dst_city THEN
            RAISE EXCEPTION 'transfer_city_mismatch' USING ERRCODE = 'check_violation';
        END IF;
        NEW.unit_cost := src.unit_cost;
    END IF;
    RETURN NEW;
END $$ LANGUAGE plpgsql;

CREATE FUNCTION trg_stock_movement_apply() RETURNS trigger AS $$
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
        value := round(NEW.qty_delta * NEW.unit_cost, 2);
        PERFORM ledger_post('stock_intake', wh_city, 'إدخال مخزون',
            jsonb_build_array(
                jsonb_build_array(ledger_account('warehouse_inventory', wh_city, NEW.warehouse_id), value),
                jsonb_build_array(CASE WHEN NEW.supplier_id IS NOT NULL
                                       THEN ledger_account('supplier_payable', wh_city, NEW.supplier_id)
                                       ELSE ledger_account('treasury', wh_city) END, -value)),
            p_ref_table => 'stock_movements', p_ref_id => NEW.id);
    ELSIF NEW.kind = 'count_adjust' THEN
        value := round(NEW.qty_delta * NEW.unit_cost, 2);
        IF value <> 0 THEN
            PERFORM ledger_post('stock_adjustment', wh_city, 'تسوية جرد',
                jsonb_build_array(
                    jsonb_build_array(ledger_account('warehouse_inventory', wh_city, NEW.warehouse_id), value),
                    jsonb_build_array(ledger_account('operating_expense', wh_city), -value)),
                p_ref_table => 'stock_movements', p_ref_id => NEW.id);
        END IF;
    ELSIF NEW.kind = 'transfer_in' THEN
        SELECT * INTO src FROM stock_movements WHERE transfer_id = NEW.transfer_id AND kind = 'transfer_out';
        value := round(NEW.qty_delta * NEW.unit_cost, 2);
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

-- التحويل نصفان: خارج بلا داخل في الحركة نفسها يُرفض عند الإيداع.
CREATE FUNCTION trg_transfer_paired() RETURNS trigger AS $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM stock_movements WHERE transfer_id = NEW.transfer_id AND kind = 'transfer_in') THEN
        RAISE EXCEPTION 'transfer_unpaired: %', NEW.transfer_id USING ERRCODE = 'check_violation';
    END IF;
    RETURN NULL;
END $$ LANGUAGE plpgsql;


-- ═══════════════════════════════════════════════════════════════════════════
-- الطلبية: الحساب والحدّ الأدنى
-- ═══════════════════════════════════════════════════════════════════════════
CREATE FUNCTION order_fee(p_order bigint) RETURNS numeric AS $$
DECLARE o orders; cs city_settings; fee numeric;
BEGIN
    SELECT * INTO o FROM orders WHERE id = p_order;
    SELECT * INTO cs FROM city_settings WHERE city = o.city;
    IF cs.fee_mode IS NULL THEN PERFORM setting_missing(o.city, 'fee_mode'); END IF;
    IF cs.free_delivery_threshold IS NOT NULL AND o.subtotal >= cs.free_delivery_threshold THEN
        RETURN 0;
    END IF;
    IF cs.fee_mode = 'flat' THEN
        fee := cs.delivery_fee_flat;
    ELSE
        IF o.zone_id IS NULL THEN
            RAISE EXCEPTION 'zone_missing: order %', p_order USING ERRCODE = 'check_violation';
        END IF;
        SELECT z.fee INTO fee FROM delivery_zones z WHERE z.id = o.zone_id AND z.active;
        IF fee IS NULL THEN
            RAISE EXCEPTION 'zone_inactive: %', o.zone_id USING ERRCODE = 'check_violation';
        END IF;
    END IF;
    RETURN fee;
END $$ LANGUAGE plpgsql;

-- مجاميع الطلبية — كاتبها الوحيد. الرسم يتبع المجموع حتى التأكيد، ثم يُجمَّد.
CREATE FUNCTION refresh_order_totals(p_order bigint) RETURNS void AS $$
DECLARE st order_status; sub numeric; n int;
BEGIN
    SELECT status INTO st FROM orders WHERE id = p_order;
    SELECT coalesce(sum(line_total), 0), count(*) INTO sub, n
      FROM order_items WHERE order_id = p_order AND unit_price IS NOT NULL;
    UPDATE orders SET subtotal = sub, line_count = n WHERE id = p_order;
    IF st = 'placed' THEN
        UPDATE orders SET delivery_fee = order_fee(p_order) WHERE id = p_order;
    END IF;
END $$ LANGUAGE plpgsql;

-- الحدّ الأدنى (§2.3) — يُفحص عند الإيداع ما دامت الطلبية placed.
CREATE FUNCTION check_min_order(p_order bigint) RETURNS void AS $$
DECLARE o orders; cs city_settings;
BEGIN
    SELECT * INTO o FROM orders WHERE id = p_order;
    IF o.status <> 'placed' THEN RETURN; END IF;
    SELECT * INTO cs FROM city_settings WHERE city = o.city;
    IF NOT cs.min_order_decided THEN PERFORM setting_missing(o.city, 'min_order'); END IF;
    IF cs.min_order_amount IS NOT NULL AND o.subtotal < cs.min_order_amount THEN
        RAISE EXCEPTION 'min_order_amount: % < %', o.subtotal, cs.min_order_amount
            USING ERRCODE = 'check_violation';
    END IF;
    IF cs.min_order_lines IS NOT NULL AND o.line_count < cs.min_order_lines THEN
        RAISE EXCEPTION 'min_order_lines: % < %', o.line_count, cs.min_order_lines
            USING ERRCODE = 'check_violation';
    END IF;
END $$ LANGUAGE plpgsql;

CREATE FUNCTION trg_min_order_deferred() RETURNS trigger AS $$
BEGIN
    IF TG_TABLE_NAME = 'orders' THEN
        PERFORM check_min_order(NEW.id);
    ELSIF TG_OP = 'DELETE' THEN
        PERFORM check_min_order(OLD.order_id);
    ELSE
        PERFORM check_min_order(NEW.order_id);
    END IF;
    RETURN NULL;
END $$ LANGUAGE plpgsql;


-- ═══════════════════════════════════════════════════════════════════════════
-- أسطر الطلبية
-- ═══════════════════════════════════════════════════════════════════════════
CREATE FUNCTION trg_order_item_before() RETURNS trigger AS $$
DECLARE o orders; r text; ci catalog_items; eff oos_policy;
BEGIN
    SELECT * INTO o FROM orders WHERE id = coalesce(NEW.order_id, OLD.order_id);
    r := writer_role();
    IF r <> 'trigger' THEN
        -- العميل حتى confirmed، وبعدها المالك وحده (§3.2)؛ لا تعديل بعد التسليم.
        IF r = 'customer' THEN
            IF o.status NOT IN ('draft', 'placed') THEN
                RAISE EXCEPTION 'order_locked_for_customer: %', o.status USING ERRCODE = 'check_violation';
            END IF;
            IF NOT EXISTS (SELECT 1 FROM customer_members WHERE customer_id = o.customer_id
                            AND user_id = actor_id()) THEN
                RAISE EXCEPTION 'forbidden_not_member' USING ERRCODE = 'insufficient_privilege';
            END IF;
        ELSIF r = 'admin' THEN
            PERFORM require_admin('orders');
            IF o.status IN ('draft', 'delivered', 'closed', 'cancelled') THEN
                RAISE EXCEPTION 'order_locked: %', o.status USING ERRCODE = 'check_violation';
            END IF;
        ELSE
            RAISE EXCEPTION 'forbidden_role: %', r USING ERRCODE = 'insufficient_privilege';
        END IF;
    END IF;
    IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;

    SELECT * INTO ci FROM catalog_items WHERE id = NEW.catalog_item_id;
    IF ci.city <> o.city THEN
        RAISE EXCEPTION 'item_city_mismatch' USING ERRCODE = 'check_violation';
    END IF;
    IF TG_OP = 'INSERT' THEN
        IF NEW.unit IS NOT NULL AND NEW.unit <> ci.unit THEN
            RAISE EXCEPTION 'unit_mismatch: catalog item sells %', ci.unit USING ERRCODE = 'check_violation';
        END IF;
        NEW.unit := ci.unit;
        -- صنف مخفي أو نافد لا يُضاف إلى السلة (§2.2)
        IF r <> 'trigger' AND (ci.visibility <> 'visible' OR NOT ci.is_available) THEN
            RAISE EXCEPTION 'item_not_orderable: %', ci.id USING ERRCODE = 'check_violation';
        END IF;
        -- سطر يُضاف بعد placed يُسعَّر لحظة إضافته (السعر محجوز لكل سطر منذ دخوله)
        IF o.status <> 'draft' THEN
            NEW.unit_price := ci.sale_price;
        END IF;
    ELSIF NEW.unit IS DISTINCT FROM OLD.unit OR NEW.catalog_item_id <> OLD.catalog_item_id THEN
        RAISE EXCEPTION 'order_item_identity_immutable' USING ERRCODE = 'restrict_violation';
    END IF;
    RETURN NEW;
END $$ LANGUAGE plpgsql;

CREATE FUNCTION trg_order_item_after() RETURNS trigger AS $$
BEGIN
    PERFORM refresh_order_totals(coalesce(NEW.order_id, OLD.order_id));
    RETURN NULL;
END $$ LANGUAGE plpgsql;


-- ═══════════════════════════════════════════════════════════════════════════
-- مخطط الاستلام — يُبنى عند confirmed (§4.1)
-- ═══════════════════════════════════════════════════════════════════════════
CREATE FUNCTION build_pickup_plan(p_order bigint) RETURNS void AS $$
DECLARE
    o orders; cs city_settings; it record; src record;
    need numeric; take numeric; stop_id bigint; line_id bigint; next_seq int := 1;
BEGIN
    SELECT * INTO o FROM orders WHERE id = p_order;
    SELECT * INTO cs FROM city_settings WHERE city = o.city;
    IF EXISTS (SELECT 1 FROM pickup_stops WHERE order_id = p_order AND status <> 'cancelled') THEN
        RETURN;   -- إعادة تأكيد بعد فكّ إسناد: المخطط قائم
    END IF;
    FOR it IN SELECT * FROM order_items WHERE order_id = p_order ORDER BY id LOOP
        need := it.qty;
        FOR src IN
            SELECT * FROM (
                SELECT 'warehouse'::stop_source AS source, 0 AS prio, ws.warehouse_id AS wh,
                       NULL::bigint AS offer, NULL::bigint AS sup, NULL::bigint AS loc,
                       ws.available_qty AS avail, ws.avg_cost AS cost, NULL::numeric AS min_qty
                  FROM warehouse_stock ws JOIN warehouses w ON w.id = ws.warehouse_id
                 WHERE ws.catalog_item_id = it.catalog_item_id AND w.active AND w.city = o.city
                   AND ws.available_qty > 0
                UNION ALL
                SELECT 'supplier', cs2.priority, NULL, so.id, so.supplier_id, so.pickup_location_id,
                       so.available_qty, so.purchase_price, so.min_order_qty
                  FROM catalog_item_sources cs2
                  JOIN supplier_offers so ON so.id = cs2.offer_id
                  JOIN suppliers s ON s.id = so.supplier_id
                 WHERE cs2.catalog_item_id = it.catalog_item_id AND so.status = 'active'
                   AND s.status = 'approved' AND so.available_qty > 0
            ) c
            ORDER BY CASE WHEN c.source = 'warehouse' AND cs.warehouse_first THEN 0
                          WHEN c.source = 'warehouse' THEN 2 ELSE 1 END,
                     c.prio, c.avail DESC
        LOOP
            EXIT WHEN need <= 0;
            take := least(need, src.avail);
            -- حدّ المورد الأدنى: لا يُشترى منه أقل منه؛ يُتخطّى إلى المصدر التالي.
            CONTINUE WHEN src.min_qty IS NOT NULL AND take < src.min_qty;
            SELECT id INTO stop_id FROM pickup_stops
             WHERE order_id = p_order AND status = 'pending'
               AND ((src.source = 'warehouse' AND warehouse_id = src.wh)
                 OR (src.source = 'supplier' AND pickup_location_id = src.loc));
            IF stop_id IS NULL THEN
                INSERT INTO pickup_stops (order_id, seq, source, supplier_id, pickup_location_id, warehouse_id)
                VALUES (p_order, next_seq, src.source, src.sup, src.loc, src.wh)
                RETURNING id INTO stop_id;
                next_seq := next_seq + 1;
            END IF;
            INSERT INTO pickup_stop_lines (stop_id, order_item_id, offer_id, planned_qty)
            VALUES (stop_id, it.id, src.offer, take) RETURNING id INTO line_id;
            INSERT INTO pickup_line_costs (stop_line_id, unit_cost) VALUES (line_id, src.cost);
            need := need - take;
        END LOOP;
    END LOOP;
END $$ LANGUAGE plpgsql;

CREATE FUNCTION refresh_plan_complete(p_order bigint) RETURNS void AS $$
DECLARE done boolean;
BEGIN
    SELECT NOT EXISTS (
        SELECT 1 FROM order_items oi
         WHERE oi.order_id = p_order
           AND oi.qty > coalesce((SELECT sum(l.planned_qty) FROM pickup_stop_lines l
                                    JOIN pickup_stops s ON s.id = l.stop_id
                                   WHERE l.order_item_id = oi.id AND s.status <> 'cancelled'), 0)
    ) INTO done;
    UPDATE orders SET plan_complete = done WHERE id = p_order AND plan_complete IS DISTINCT FROM done;
END $$ LANGUAGE plpgsql;

CREATE FUNCTION trg_stop_line_before() RETURNS trigger AS $$
DECLARE s pickup_stops; o orders; r text; oi order_items;
BEGIN
    r := writer_role();
    SELECT * INTO s FROM pickup_stops WHERE id = coalesce(NEW.stop_id, OLD.stop_id);
    SELECT * INTO o FROM orders WHERE id = s.order_id;
    IF r = 'admin' THEN
        PERFORM require_admin('orders');
        -- المالك يعدّل المخطط قبل الإسناد (§4.1)
        IF o.status <> 'confirmed' THEN
            RAISE EXCEPTION 'plan_locked: %', o.status USING ERRCODE = 'check_violation';
        END IF;
    ELSIF r = 'driver' THEN
        IF TG_OP <> 'UPDATE' OR NEW.planned_qty <> OLD.planned_qty OR NEW.offer_id IS DISTINCT FROM OLD.offer_id THEN
            RAISE EXCEPTION 'forbidden_role: driver edits collected_qty only' USING ERRCODE = 'insufficient_privilege';
        END IF;
        IF o.driver_id IS DISTINCT FROM (SELECT id FROM drivers WHERE user_id = actor_id()) THEN
            RAISE EXCEPTION 'forbidden_not_assigned' USING ERRCODE = 'insufficient_privilege';
        END IF;
        IF s.status <> 'pending' OR o.status NOT IN ('collecting', 'partially_delivered') THEN
            RAISE EXCEPTION 'stop_locked' USING ERRCODE = 'check_violation';
        END IF;
    ELSIF r <> 'trigger' THEN
        RAISE EXCEPTION 'forbidden_role: %', r USING ERRCODE = 'insufficient_privilege';
    END IF;
    IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
    SELECT * INTO oi FROM order_items WHERE id = NEW.order_item_id;
    IF oi.order_id <> s.order_id THEN
        RAISE EXCEPTION 'stop_line_order_mismatch' USING ERRCODE = 'check_violation';
    END IF;
    IF (s.source = 'supplier') <> (NEW.offer_id IS NOT NULL) THEN
        RAISE EXCEPTION 'stop_line_source_mismatch' USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
END $$ LANGUAGE plpgsql;

CREATE FUNCTION trg_stop_line_after() RETURNS trigger AS $$
DECLARE s pickup_stops; off bigint; oi order_items;
BEGIN
    SELECT * INTO s FROM pickup_stops WHERE id = coalesce(NEW.stop_id, OLD.stop_id);
    off := coalesce(NEW.offer_id, OLD.offer_id);
    IF off IS NOT NULL THEN PERFORM refresh_offer_commitment(off); END IF;
    IF TG_OP = 'UPDATE' AND OLD.offer_id IS NOT NULL AND OLD.offer_id IS DISTINCT FROM NEW.offer_id THEN
        PERFORM refresh_offer_commitment(OLD.offer_id);
    END IF;
    IF s.warehouse_id IS NOT NULL THEN
        SELECT * INTO oi FROM order_items WHERE id = coalesce(NEW.order_item_id, OLD.order_item_id);
        PERFORM refresh_warehouse_reservation(s.warehouse_id, oi.catalog_item_id);
        PERFORM refresh_item_availability(oi.catalog_item_id);
    END IF;
    PERFORM refresh_plan_complete(s.order_id);
    RETURN NULL;
END $$ LANGUAGE plpgsql;

-- السائق يؤكد النقطة (استلمت/نقص/رفض) — §4.2
CREATE FUNCTION trg_stop_before() RETURNS trigger AS $$
DECLARE o orders; r text;
BEGIN
    r := writer_role();
    SELECT * INTO o FROM orders WHERE id = NEW.order_id;
    IF TG_OP = 'UPDATE' AND NEW.pickup_code <> OLD.pickup_code THEN
        RAISE EXCEPTION 'derived_field_write: pickup_stops.pickup_code' USING ERRCODE = 'restrict_violation';
    END IF;
    IF r = 'trigger' THEN RETURN NEW; END IF;
    IF r = 'admin' THEN
        PERFORM require_admin('orders');
        IF TG_OP = 'INSERT' AND o.status <> 'confirmed' THEN
            RAISE EXCEPTION 'plan_locked: %', o.status USING ERRCODE = 'check_violation';
        END IF;
    ELSIF r = 'driver' THEN
        IF TG_OP <> 'UPDATE' OR o.driver_id IS DISTINCT FROM (SELECT id FROM drivers WHERE user_id = actor_id()) THEN
            RAISE EXCEPTION 'forbidden_not_assigned' USING ERRCODE = 'insufficient_privilege';
        END IF;
        IF o.status NOT IN ('collecting', 'partially_delivered') THEN
            RAISE EXCEPTION 'order_not_collecting: %', o.status USING ERRCODE = 'check_violation';
        END IF;
    ELSE
        RAISE EXCEPTION 'forbidden_role: %', r USING ERRCODE = 'insufficient_privilege';
    END IF;
    IF TG_OP = 'UPDATE' AND NEW.status IS DISTINCT FROM OLD.status THEN
        IF OLD.status <> 'pending' THEN
            RAISE EXCEPTION 'stop_already_confirmed' USING ERRCODE = 'check_violation';
        END IF;
        IF NEW.status IN ('collected', 'short', 'refused') THEN
            NEW.confirmed_at := now();
        END IF;
    END IF;
    RETURN NEW;
END $$ LANGUAGE plpgsql;

CREATE FUNCTION trg_stop_after() RETURNS trigger AS $$
DECLARE l record; missing int;
BEGIN
    IF NEW.status IS NOT DISTINCT FROM OLD.status THEN RETURN NULL; END IF;
    IF NEW.status = 'collected' THEN
        SELECT count(*) INTO missing FROM pickup_stop_lines
         WHERE stop_id = NEW.id AND (collected_qty IS NULL OR collected_qty <> planned_qty);
        IF missing > 0 THEN
            RAISE EXCEPTION 'stop_collected_requires_full_qty: use short' USING ERRCODE = 'check_violation';
        END IF;
    ELSIF NEW.status = 'short' THEN
        SELECT count(*) INTO missing FROM pickup_stop_lines WHERE stop_id = NEW.id AND collected_qty IS NULL;
        IF missing > 0 THEN
            RAISE EXCEPTION 'stop_short_requires_qty' USING ERRCODE = 'check_violation';
        END IF;
    END IF;
    FOR l IN SELECT psl.*, oi.catalog_item_id FROM pickup_stop_lines psl
               JOIN order_items oi ON oi.id = psl.order_item_id WHERE psl.stop_id = NEW.id LOOP
        IF l.offer_id IS NOT NULL THEN
            IF NEW.status IN ('collected', 'short') THEN
                UPDATE pickup_stop_lines SET offer_report_seq =
                       (SELECT report_seq FROM supplier_offers WHERE id = l.offer_id)
                 WHERE id = l.id;
            END IF;
            PERFORM refresh_offer_commitment(l.offer_id);
        ELSE
            IF NEW.status IN ('collected', 'short') AND l.collected_qty > 0 THEN
                INSERT INTO stock_movements (warehouse_id, catalog_item_id, kind, qty_delta, stop_line_id)
                VALUES (NEW.warehouse_id, l.catalog_item_id, 'pickup', -l.collected_qty, l.id);
            END IF;
            PERFORM refresh_warehouse_reservation(NEW.warehouse_id, l.catalog_item_id);
            PERFORM refresh_item_availability(l.catalog_item_id);
        END IF;
    END LOOP;
    RETURN NULL;
END $$ LANGUAGE plpgsql;


-- ═══════════════════════════════════════════════════════════════════════════
-- انتقالات حالة الطلبية (§3.2) — آلة الحالة في القاعدة
-- ═══════════════════════════════════════════════════════════════════════════
CREATE FUNCTION order_transition_allowed(p_from order_status, p_to order_status, p_role text)
RETURNS boolean AS $$
    SELECT (p_from, p_to, p_role) IN (
        ('draft', 'placed', 'customer'),
        ('draft', 'cancelled', 'customer'),
        ('placed', 'confirmed', 'admin'), ('placed', 'confirmed', 'system'),
        ('placed', 'confirmed', 'trigger'),
        ('placed', 'cancelled', 'customer'), ('placed', 'cancelled', 'admin'),
        ('confirmed', 'assigned', 'admin'), ('confirmed', 'assigned', 'driver'),
        ('confirmed', 'assigned', 'trigger'),
        ('confirmed', 'cancelled', 'admin'),
        ('assigned', 'confirmed', 'admin'),
        ('assigned', 'collecting', 'driver'), ('assigned', 'collecting', 'admin'),
        ('assigned', 'cancelled', 'admin'),
        ('collecting', 'cancelled', 'admin'),
        ('collecting', 'partially_delivered', 'trigger'),
        ('collecting', 'delivered', 'trigger'),
        ('partially_delivered', 'delivered', 'trigger'),
        ('delivered', 'closed', 'system'), ('delivered', 'closed', 'admin')
    )
$$ LANGUAGE sql IMMUTABLE;

CREATE FUNCTION trg_order_before() RETURNS trigger AS $$
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
                                    + cs.driver_pay_per_km * NEW.route_km, 2);
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

CREATE FUNCTION post_delivery(p_order bigint) RETURNS void AS $$
DECLARE o orders; collected numeric; cost record; lines jsonb;
BEGIN
    SELECT * INTO o FROM orders WHERE id = p_order;
    -- البيع: العميل مدين بقيمة الطلبية ورسم التوصيل
    PERFORM ledger_post('sale', o.city, 'بيع طلبية', jsonb_build_array(
        jsonb_build_array(ledger_account('customer_receivable', o.city, o.customer_id), o.total),
        jsonb_build_array(ledger_account('sales_revenue', o.city), -o.subtotal),
        jsonb_build_array(ledger_account('delivery_fee_revenue', o.city), -o.delivery_fee)),
        p_order => p_order);
    -- التحصيل: ما لم يُحصَّل بعد على الدفعات صار كاشاً بحوزة السائق
    SELECT coalesce(sum(e.amount), 0) INTO collected FROM ledger_transactions t
      JOIN ledger_entries e ON e.transaction_id = t.id
     WHERE t.order_id = p_order AND t.kind = 'collection'
       AND e.account_id = ledger_account('driver_cash', o.city, o.driver_id);
    IF o.total - collected > 0 THEN
        PERFORM ledger_post('collection', o.city, 'تحصيل كاش', jsonb_build_array(
            jsonb_build_array(ledger_account('driver_cash', o.city, o.driver_id), o.total - collected),
            jsonb_build_array(ledger_account('customer_receivable', o.city, o.customer_id), -(o.total - collected))),
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
               sum(round(l.collected_qty * c.unit_cost, 2)) AS amount
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

CREATE FUNCTION trg_order_after() RETURNS trigger AS $$
DECLARE cs city_settings; l record;
BEGIN
    IF TG_OP = 'UPDATE' AND NEW.status IS NOT DISTINCT FROM OLD.status THEN RETURN NULL; END IF;
    INSERT INTO order_status_events (order_id, from_status, to_status, actor_role, actor_id, reason)
    VALUES (NEW.id, CASE WHEN TG_OP = 'UPDATE' THEN OLD.status END, NEW.status, writer_role(),
            actor_id(), CASE WHEN NEW.status = 'cancelled' THEN NEW.cancel_reason END);
    IF TG_OP = 'INSERT' THEN RETURN NULL; END IF;

    IF NEW.status = 'placed' THEN
        -- حجز السعر لحظة الطلب (§3.2)
        UPDATE order_items oi SET unit_price = ci.sale_price
          FROM catalog_items ci
         WHERE oi.order_id = NEW.id AND ci.id = oi.catalog_item_id;
        IF EXISTS (SELECT 1 FROM order_items oi JOIN catalog_items ci ON ci.id = oi.catalog_item_id
                    WHERE oi.order_id = NEW.id AND (ci.visibility <> 'visible' OR NOT ci.is_available)) THEN
            RAISE EXCEPTION 'item_not_orderable_at_place' USING ERRCODE = 'check_violation';
        END IF;
        IF NOT EXISTS (SELECT 1 FROM order_items WHERE order_id = NEW.id) THEN
            RAISE EXCEPTION 'order_empty' USING ERRCODE = 'check_violation';
        END IF;
        PERFORM refresh_order_totals(NEW.id);
        PERFORM check_min_order(NEW.id);
        -- الاعتماد الآلي (§3.2): تحت المبلغ المحدد يؤكَّد فوراً
        SELECT * INTO cs FROM city_settings WHERE city = NEW.city;
        IF cs.auto_confirm_max_amount IS NOT NULL
           AND (SELECT total FROM orders WHERE id = NEW.id) <= cs.auto_confirm_max_amount THEN
            UPDATE orders SET status = 'confirmed' WHERE id = NEW.id;
        END IF;
    ELSIF NEW.status = 'confirmed' AND OLD.status = 'placed' THEN
        PERFORM build_pickup_plan(NEW.id);
        PERFORM refresh_plan_complete(NEW.id);
    ELSIF NEW.status = 'confirmed' AND OLD.status = 'assigned' THEN
        UPDATE driver_pay_offers SET status = 'withdrawn'
         WHERE order_id = NEW.id AND status IN ('pending', 'accepted');
    ELSIF NEW.status = 'delivered' THEN
        PERFORM post_delivery(NEW.id);
    ELSIF NEW.status = 'cancelled' THEN
        -- تحرير الحجوزات
        UPDATE pickup_stops SET status = 'cancelled' WHERE order_id = NEW.id AND status = 'pending';
        FOR l IN SELECT DISTINCT psl.offer_id FROM pickup_stop_lines psl
                   JOIN pickup_stops s ON s.id = psl.stop_id
                  WHERE s.order_id = NEW.id AND psl.offer_id IS NOT NULL LOOP
            PERFORM refresh_offer_commitment(l.offer_id);
        END LOOP;
        FOR l IN SELECT DISTINCT s.warehouse_id, oi.catalog_item_id FROM pickup_stop_lines psl
                   JOIN pickup_stops s ON s.id = psl.stop_id
                   JOIN order_items oi ON oi.id = psl.order_item_id
                  WHERE s.order_id = NEW.id AND s.warehouse_id IS NOT NULL LOOP
            PERFORM refresh_warehouse_reservation(l.warehouse_id, l.catalog_item_id);
            PERFORM refresh_item_availability(l.catalog_item_id);
        END LOOP;
        FOR l IN SELECT DISTINCT oi.catalog_item_id FROM order_items oi WHERE oi.order_id = NEW.id LOOP
            PERFORM refresh_item_availability(l.catalog_item_id);
        END LOOP;
    END IF;
    RETURN NULL;
END $$ LANGUAGE plpgsql;


-- ═══════════════════════════════════════════════════════════════════════════
-- عروض أجرة السائق (§4.2)
-- ═══════════════════════════════════════════════════════════════════════════
CREATE FUNCTION trg_driver_offer_before() RETURNS trigger AS $$
DECLARE r text; o orders;
BEGIN
    r := writer_role();
    SELECT * INTO o FROM orders WHERE id = NEW.order_id;
    IF TG_OP = 'INSERT' THEN
        IF r <> 'driver' OR NEW.driver_id <> (SELECT id FROM drivers WHERE user_id = actor_id()) THEN
            RAISE EXCEPTION 'forbidden_role: offers are made by the driver' USING ERRCODE = 'insufficient_privilege';
        END IF;
        IF o.status <> 'confirmed' THEN
            RAISE EXCEPTION 'order_not_open_for_offers: %', o.status USING ERRCODE = 'check_violation';
        END IF;
        RETURN NEW;
    END IF;
    IF NEW.status IS DISTINCT FROM OLD.status THEN
        IF OLD.status <> 'pending' THEN
            IF r = 'trigger' AND NEW.status = 'withdrawn' THEN RETURN NEW; END IF;
            RAISE EXCEPTION 'offer_already_decided' USING ERRCODE = 'check_violation';
        END IF;
        IF NEW.status IN ('accepted', 'rejected') THEN
            PERFORM require_admin('orders');
            NEW.decided_by := actor_id();
            NEW.decided_at := now();
        END IF;
    END IF;
    RETURN NEW;
END $$ LANGUAGE plpgsql;

CREATE FUNCTION trg_driver_offer_after() RETURNS trigger AS $$
BEGIN
    IF NEW.status = 'accepted' AND OLD.status = 'pending' THEN
        UPDATE orders SET driver_id = NEW.driver_id, driver_pay = NEW.amount, status = 'assigned'
         WHERE id = NEW.order_id;
        UPDATE driver_pay_offers SET status = 'withdrawn'
         WHERE order_id = NEW.order_id AND id <> NEW.id AND status = 'pending';
    END IF;
    RETURN NULL;
END $$ LANGUAGE plpgsql;


-- ═══════════════════════════════════════════════════════════════════════════
-- الدفعات: لا انطلاق بلا إشعار (§4.3)
-- ═══════════════════════════════════════════════════════════════════════════
CREATE FUNCTION batch_notice_payload(p_batch bigint) RETURNS jsonb AS $$
    SELECT jsonb_build_object(
        'now', coalesce((SELECT jsonb_agg(jsonb_build_object('item', ci.name_ar, 'qty', bl.qty, 'unit', oi.unit)
                                          ORDER BY oi.id)
                           FROM order_batch_lines bl
                           JOIN order_items oi ON oi.id = bl.order_item_id
                           JOIN catalog_items ci ON ci.id = oi.catalog_item_id
                          WHERE bl.batch_id = b.id), '[]'::jsonb),
        'later', coalesce((SELECT jsonb_agg(jsonb_build_object('item', ci.name_ar,
                                          'qty', oi.qty - oi.delivered_qty - coalesce(bl.qty, 0), 'unit', oi.unit)
                                          ORDER BY oi.id)
                             FROM order_items oi
                             JOIN catalog_items ci ON ci.id = oi.catalog_item_id
                             LEFT JOIN order_batch_lines bl ON bl.batch_id = b.id AND bl.order_item_id = oi.id
                            WHERE oi.order_id = b.order_id
                              AND oi.qty - oi.delivered_qty - coalesce(bl.qty, 0) > 0), '[]'::jsonb),
        'eta', b.eta_at,
        'later_eta', b.next_eta_at)
    FROM order_batches b WHERE b.id = p_batch
$$ LANGUAGE sql STABLE;

CREATE FUNCTION trg_batch_before() RETURNS trigger AS $$
DECLARE r text; o orders; payload jsonb; cust_user bigint; nid bigint;
BEGIN
    r := writer_role();
    SELECT * INTO o FROM orders WHERE id = NEW.order_id;
    IF r NOT IN ('trigger') THEN
        IF r <> 'driver' OR o.driver_id IS DISTINCT FROM (SELECT id FROM drivers WHERE user_id = actor_id()) THEN
            RAISE EXCEPTION 'forbidden_not_assigned' USING ERRCODE = 'insufficient_privilege';
        END IF;
    END IF;
    IF o.status NOT IN ('collecting', 'partially_delivered') THEN
        RAISE EXCEPTION 'order_not_collecting: %', o.status USING ERRCODE = 'check_violation';
    END IF;
    IF TG_OP = 'INSERT' THEN
        IF NEW.status <> 'planned' THEN
            RAISE EXCEPTION 'batch_must_start_planned' USING ERRCODE = 'check_violation';
        END IF;
        RETURN NEW;
    END IF;
    IF NEW.status IS NOT DISTINCT FROM OLD.status THEN
        IF OLD.status <> 'planned' AND (NEW.eta_at IS DISTINCT FROM OLD.eta_at
                                        OR NEW.next_eta_at IS DISTINCT FROM OLD.next_eta_at) THEN
            RAISE EXCEPTION 'batch_notice_sent_is_immutable' USING ERRCODE = 'check_violation';
        END IF;
        RETURN NEW;
    END IF;
    IF (OLD.status, NEW.status) NOT IN (('planned', 'notified'), ('notified', 'departed'),
                                        ('departed', 'delivered')) THEN
        RAISE EXCEPTION 'invalid_batch_transition: % -> %', OLD.status, NEW.status USING ERRCODE = 'check_violation';
    END IF;
    IF NEW.status = 'notified' THEN
        IF NOT EXISTS (SELECT 1 FROM order_batch_lines WHERE batch_id = NEW.id) THEN
            RAISE EXCEPTION 'batch_empty' USING ERRCODE = 'check_violation';
        END IF;
        payload := batch_notice_payload(NEW.id);
        -- ما سيصل لاحقاً يحتاج موعداً (§4.3)
        IF jsonb_array_length(payload->'later') > 0 AND NEW.next_eta_at IS NULL THEN
            RAISE EXCEPTION 'batch_notice_needs_later_eta' USING ERRCODE = 'check_violation';
        END IF;
        payload := jsonb_set(payload, '{later_eta}', coalesce(to_jsonb(NEW.next_eta_at), 'null'::jsonb));
        payload := jsonb_set(payload, '{eta}', coalesce(to_jsonb(NEW.eta_at), 'null'::jsonb));
        FOR cust_user IN SELECT user_id FROM customer_members WHERE customer_id = o.customer_id LOOP
            INSERT INTO notifications (user_id, kind, order_id, batch_id, title, body, payload, channels)
            VALUES (cust_user, 'batch_departure', o.id, NEW.id, 'دفعة في الطريق',
                    'تصل الآن ' || jsonb_array_length(payload->'now') || ' أصناف'
                    || CASE WHEN jsonb_array_length(payload->'later') > 0
                            THEN '، والباقي لاحقاً' ELSE '' END,
                    payload, ARRAY['push', 'sms']::notification_channel[])
            RETURNING id INTO nid;
        END LOOP;
        IF nid IS NULL THEN
            RAISE EXCEPTION 'batch_notice_no_recipient' USING ERRCODE = 'check_violation';
        END IF;
        NEW.notification_id := nid;
        NEW.notified_at := now();
    ELSIF NEW.status = 'departed' THEN
        NEW.departed_at := now();
    ELSIF NEW.status = 'delivered' THEN
        NEW.delivered_at := now();
    END IF;
    RETURN NEW;
END $$ LANGUAGE plpgsql;

CREATE FUNCTION trg_batch_after() RETURNS trigger AS $$
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
        SELECT coalesce(sum(round(bl.qty * oi.unit_price, 2)), 0) INTO value
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

CREATE FUNCTION trg_batch_line_before() RETURNS trigger AS $$
DECLARE b order_batches; oi order_items; collected numeric; in_batches numeric;
BEGIN
    SELECT * INTO b FROM order_batches WHERE id = coalesce(NEW.batch_id, OLD.batch_id);
    IF b.status <> 'planned' THEN
        RAISE EXCEPTION 'batch_notice_sent_is_immutable' USING ERRCODE = 'check_violation';
    END IF;
    IF writer_role() <> 'trigger' AND (writer_role() <> 'driver' OR
       (SELECT driver_id FROM orders WHERE id = b.order_id) IS DISTINCT FROM
       (SELECT id FROM drivers WHERE user_id = actor_id())) THEN
        RAISE EXCEPTION 'forbidden_not_assigned' USING ERRCODE = 'insufficient_privilege';
    END IF;
    IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
    SELECT * INTO oi FROM order_items WHERE id = NEW.order_item_id;
    IF oi.order_id <> b.order_id THEN
        RAISE EXCEPTION 'batch_line_order_mismatch' USING ERRCODE = 'check_violation';
    END IF;
    SELECT coalesce(sum(l.collected_qty), 0) INTO collected FROM pickup_stop_lines l
      JOIN pickup_stops s ON s.id = l.stop_id
     WHERE l.order_item_id = oi.id AND s.status IN ('collected', 'short');
    SELECT coalesce(sum(bl.qty), 0) INTO in_batches FROM order_batch_lines bl
      JOIN order_batches ob ON ob.id = bl.batch_id
     WHERE bl.order_item_id = oi.id AND ob.id <> NEW.batch_id;
    IF in_batches + NEW.qty > least(collected, oi.qty) THEN
        RAISE EXCEPTION 'batch_qty_exceeds_collected: % + % > %', in_batches, NEW.qty, least(collected, oi.qty)
            USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
END $$ LANGUAGE plpgsql;


-- ═══════════════════════════════════════════════════════════════════════════
-- المال اليدوي: تسليم الكاش، صرف المورد، المصاريف (§5)
-- ═══════════════════════════════════════════════════════════════════════════
CREATE FUNCTION trg_cash_handover() RETURNS trigger AS $$
DECLARE d drivers; held numeric;
BEGIN
    PERFORM require_admin('money');
    SELECT * INTO d FROM drivers WHERE id = NEW.driver_id;
    held := ledger_balance('driver_cash', d.city, d.id);
    IF NEW.amount > held THEN
        RAISE EXCEPTION 'handover_exceeds_cash: % > %', NEW.amount, held USING ERRCODE = 'check_violation';
    END IF;
    PERFORM ledger_post('cash_handover', d.city, 'تسليم كاش للخزينة', jsonb_build_array(
        jsonb_build_array(ledger_account('treasury', d.city), NEW.amount),
        jsonb_build_array(ledger_account('driver_cash', d.city, d.id), -NEW.amount)),
        p_ref_table => 'cash_handovers', p_ref_id => NEW.id);
    RETURN NULL;
END $$ LANGUAGE plpgsql;

CREATE FUNCTION trg_supplier_payout() RETURNS trigger AS $$
DECLARE s suppliers; owed numeric;
BEGIN
    PERFORM require_admin('money');
    SELECT * INTO s FROM suppliers WHERE id = NEW.supplier_id;
    owed := -ledger_balance('supplier_payable', s.city, s.id);
    IF NEW.amount > owed THEN
        RAISE EXCEPTION 'payout_exceeds_payable: % > %', NEW.amount, owed USING ERRCODE = 'check_violation';
    END IF;
    PERFORM ledger_post('supplier_payout', s.city, 'صرف مستحقات مورد', jsonb_build_array(
        jsonb_build_array(ledger_account('supplier_payable', s.city, s.id), NEW.amount),
        jsonb_build_array(ledger_account('treasury', s.city), -NEW.amount)),
        p_ref_table => 'supplier_payouts', p_ref_id => NEW.id);
    RETURN NULL;
END $$ LANGUAGE plpgsql;

CREATE FUNCTION trg_expense() RETURNS trigger AS $$
BEGIN
    PERFORM require_admin('money');
    PERFORM ledger_post('expense', NEW.city, 'مصروف: ' || NEW.category, jsonb_build_array(
        jsonb_build_array(ledger_account('operating_expense', NEW.city), NEW.amount),
        jsonb_build_array(ledger_account('treasury', NEW.city), -NEW.amount)),
        p_order => NEW.order_id, p_ref_table => 'expenses', p_ref_id => NEW.id);
    RETURN NULL;
END $$ LANGUAGE plpgsql;

CREATE FUNCTION trg_settings_before() RETURNS trigger AS $$
BEGIN
    PERFORM require_admin('settings');
    RETURN NEW;
END $$ LANGUAGE plpgsql;


-- ═══════════════════════════════════════════════════════════════════════════
-- ربط المشغّلات
-- ═══════════════════════════════════════════════════════════════════════════
-- حرّاس الحقول المشتقة (a_ ليسبقوا كل BEFORE آخر على الجدول)
CREATE TRIGGER a_guard_derived BEFORE INSERT OR UPDATE ON supplier_offers FOR EACH ROW
    EXECUTE FUNCTION guard_derived('reserved_qty:0', 'consumed_qty:0', 'report_seq:0');
CREATE TRIGGER a_guard_derived_reported BEFORE UPDATE ON supplier_offers FOR EACH ROW
    EXECUTE FUNCTION guard_derived('qty_reported_at:null');
CREATE TRIGGER a_guard_derived BEFORE INSERT OR UPDATE ON pickup_stop_lines FOR EACH ROW
    EXECUTE FUNCTION guard_derived('offer_report_seq:null');
CREATE TRIGGER a_guard_derived BEFORE INSERT OR UPDATE ON catalog_items FOR EACH ROW
    EXECUTE FUNCTION guard_derived('sale_price:null', 'is_available:false');
CREATE TRIGGER a_guard_derived BEFORE INSERT OR UPDATE ON catalog_item_pricing FOR EACH ROW
    EXECUTE FUNCTION guard_derived('needs_review:false');
CREATE TRIGGER a_guard_derived BEFORE INSERT OR UPDATE ON warehouse_stock FOR EACH ROW
    EXECUTE FUNCTION guard_derived('on_hand:0', 'reserved_qty:0', 'avg_cost:0');
CREATE TRIGGER a_guard_derived BEFORE INSERT OR UPDATE ON orders FOR EACH ROW
    EXECUTE FUNCTION guard_derived('subtotal:0', 'line_count:0', 'delivery_fee:0', 'collection_mode:null',
                                   'driver_pay:null', 'plan_complete:false', 'location_id:null',
                                   'dest_lat:null', 'dest_lng:null', 'dest_address:null', 'zone_id:null',
                                   'placed_at:null', 'confirmed_at:null', 'assigned_at:null',
                                   'delivered_at:null', 'closed_at:null', 'cancelled_at:null',
                                   'cancelled_by_role:null');
CREATE TRIGGER a_guard_derived BEFORE INSERT OR UPDATE ON order_items FOR EACH ROW
    EXECUTE FUNCTION guard_derived('unit_price:null', 'delivered_qty:0');
CREATE TRIGGER a_guard_derived BEFORE INSERT OR UPDATE ON order_batches FOR EACH ROW
    EXECUTE FUNCTION guard_derived('notification_id:null', 'notified_at:null', 'departed_at:null',
                                   'delivered_at:null');
CREATE TRIGGER a_guard_derived BEFORE INSERT OR UPDATE ON ledger_accounts FOR EACH ROW
    EXECUTE FUNCTION guard_derived('balance:0');
CREATE TRIGGER a_guard_derived BEFORE INSERT OR UPDATE ON pickup_stops FOR EACH ROW
    EXECUTE FUNCTION guard_derived('confirmed_at:null');
CREATE TRIGGER a_guard_derived BEFORE INSERT OR UPDATE ON driver_pay_offers FOR EACH ROW
    EXECUTE FUNCTION guard_derived('decided_by:null', 'decided_at:null');

-- جداول تُكتب من المشغّلات وحدها: أي كتابة مباشرة من التطبيق تُرفض.
CREATE FUNCTION guard_trigger_only() RETURNS trigger AS $$
BEGIN
    IF pg_trigger_depth() > 1 THEN RETURN coalesce(NEW, OLD); END IF;
    RAISE EXCEPTION 'derived_field_write: %', TG_TABLE_NAME USING ERRCODE = 'restrict_violation';
END $$ LANGUAGE plpgsql;
CREATE TRIGGER a_guard_trigger_only BEFORE INSERT OR UPDATE OR DELETE ON ledger_entries
    FOR EACH ROW EXECUTE FUNCTION guard_trigger_only();
CREATE TRIGGER a_guard_trigger_only BEFORE INSERT OR UPDATE OR DELETE ON ledger_transactions
    FOR EACH ROW EXECUTE FUNCTION guard_trigger_only();
CREATE TRIGGER a_guard_trigger_only BEFORE INSERT OR UPDATE OR DELETE ON order_status_events
    FOR EACH ROW EXECUTE FUNCTION guard_trigger_only();
CREATE TRIGGER a_guard_trigger_only BEFORE INSERT OR UPDATE OR DELETE ON supplier_offer_price_history
    FOR EACH ROW EXECUTE FUNCTION guard_trigger_only();
CREATE TRIGGER a_guard_trigger_only BEFORE INSERT OR UPDATE OR DELETE ON catalog_price_history
    FOR EACH ROW EXECUTE FUNCTION guard_trigger_only();
CREATE TRIGGER a_guard_trigger_only BEFORE INSERT OR UPDATE OR DELETE ON audit_log
    FOR EACH ROW EXECUTE FUNCTION guard_trigger_only();
CREATE TRIGGER a_guard_trigger_only BEFORE INSERT OR UPDATE OR DELETE ON pickup_line_costs
    FOR EACH ROW EXECUTE FUNCTION guard_trigger_only();

-- ملحق فقط
CREATE TRIGGER z_append_only BEFORE UPDATE OR DELETE ON ledger_entries FOR EACH ROW EXECUTE FUNCTION guard_append_only();
CREATE TRIGGER z_append_only BEFORE UPDATE OR DELETE ON ledger_transactions FOR EACH ROW EXECUTE FUNCTION guard_append_only();
CREATE TRIGGER z_append_only BEFORE UPDATE OR DELETE ON order_status_events FOR EACH ROW EXECUTE FUNCTION guard_append_only();
CREATE TRIGGER z_append_only BEFORE UPDATE OR DELETE ON supplier_offer_price_history FOR EACH ROW EXECUTE FUNCTION guard_append_only();
CREATE TRIGGER z_append_only BEFORE UPDATE OR DELETE ON catalog_price_history FOR EACH ROW EXECUTE FUNCTION guard_append_only();
CREATE TRIGGER z_append_only BEFORE UPDATE OR DELETE ON audit_log FOR EACH ROW EXECUTE FUNCTION guard_append_only();
CREATE TRIGGER z_append_only BEFORE UPDATE OR DELETE ON stock_movements FOR EACH ROW EXECUTE FUNCTION guard_append_only();
CREATE TRIGGER z_append_only BEFORE UPDATE OR DELETE ON cash_handovers FOR EACH ROW EXECUTE FUNCTION guard_append_only();
CREATE TRIGGER z_append_only BEFORE UPDATE OR DELETE ON supplier_payouts FOR EACH ROW EXECUTE FUNCTION guard_append_only();
CREATE TRIGGER z_append_only BEFORE UPDATE OR DELETE ON expenses FOR EACH ROW EXECUTE FUNCTION guard_append_only();

-- الأطراف
CREATE TRIGGER b_review BEFORE UPDATE ON customers FOR EACH ROW EXECUTE FUNCTION trg_party_review();
CREATE TRIGGER b_review BEFORE UPDATE ON suppliers FOR EACH ROW EXECUTE FUNCTION trg_party_review();
CREATE TRIGGER b_review BEFORE UPDATE ON drivers FOR EACH ROW EXECUTE FUNCTION trg_party_review();
CREATE TRIGGER supplier_status_after AFTER UPDATE ON suppliers FOR EACH ROW EXECUTE FUNCTION trg_supplier_status_after();

-- العروض والكتالوج
CREATE TRIGGER b_offer BEFORE INSERT OR UPDATE ON supplier_offers FOR EACH ROW EXECUTE FUNCTION trg_offer_before();
CREATE TRIGGER offer_after AFTER UPDATE ON supplier_offers FOR EACH ROW EXECUTE FUNCTION trg_offer_after();
CREATE TRIGGER offer_price_history AFTER INSERT OR UPDATE OF purchase_price ON supplier_offers
    FOR EACH ROW EXECUTE FUNCTION trg_offer_price_history();
CREATE TRIGGER b_catalog_item BEFORE INSERT OR UPDATE ON catalog_items FOR EACH ROW EXECUTE FUNCTION trg_catalog_item_before();
CREATE TRIGGER catalog_item_after_insert AFTER INSERT ON catalog_items FOR EACH ROW EXECUTE FUNCTION trg_catalog_item_after_insert();
CREATE TRIGGER catalog_price_history AFTER INSERT OR UPDATE OF sale_price ON catalog_items
    FOR EACH ROW EXECUTE FUNCTION trg_catalog_price_history();
CREATE TRIGGER b_pricing BEFORE INSERT OR UPDATE ON catalog_item_pricing FOR EACH ROW EXECUTE FUNCTION trg_pricing_before();
CREATE TRIGGER pricing_after AFTER INSERT OR UPDATE OF mode, manual_price, margin_value ON catalog_item_pricing
    FOR EACH ROW EXECUTE FUNCTION trg_pricing_after();
CREATE TRIGGER b_source BEFORE INSERT OR UPDATE OR DELETE ON catalog_item_sources FOR EACH ROW EXECUTE FUNCTION trg_source_check();
CREATE TRIGGER source_after AFTER INSERT OR UPDATE OR DELETE ON catalog_item_sources FOR EACH ROW EXECUTE FUNCTION trg_source_after();

-- المخزون
CREATE TRIGGER b_stock_movement BEFORE INSERT ON stock_movements FOR EACH ROW EXECUTE FUNCTION trg_stock_movement_before();
CREATE TRIGGER stock_movement_apply AFTER INSERT ON stock_movements FOR EACH ROW EXECUTE FUNCTION trg_stock_movement_apply();
CREATE CONSTRAINT TRIGGER stock_transfer_paired AFTER INSERT ON stock_movements DEFERRABLE INITIALLY DEFERRED
    FOR EACH ROW WHEN (NEW.kind = 'transfer_out') EXECUTE FUNCTION trg_transfer_paired();

-- الطلبات
CREATE TRIGGER b_order BEFORE INSERT OR UPDATE ON orders FOR EACH ROW EXECUTE FUNCTION trg_order_before();
CREATE TRIGGER order_after AFTER INSERT OR UPDATE ON orders FOR EACH ROW EXECUTE FUNCTION trg_order_after();
CREATE CONSTRAINT TRIGGER order_min_check AFTER UPDATE ON orders DEFERRABLE INITIALLY DEFERRED
    FOR EACH ROW WHEN (NEW.status = 'placed') EXECUTE FUNCTION trg_min_order_deferred();
CREATE TRIGGER b_order_item BEFORE INSERT OR UPDATE OR DELETE ON order_items FOR EACH ROW EXECUTE FUNCTION trg_order_item_before();
CREATE TRIGGER order_item_after AFTER INSERT OR UPDATE OF qty, unit_price OR DELETE ON order_items
    FOR EACH ROW EXECUTE FUNCTION trg_order_item_after();
CREATE CONSTRAINT TRIGGER order_item_min_check AFTER INSERT OR UPDATE OR DELETE ON order_items
    DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION trg_min_order_deferred();

-- مخطط الاستلام
CREATE TRIGGER b_stop BEFORE INSERT OR UPDATE ON pickup_stops FOR EACH ROW EXECUTE FUNCTION trg_stop_before();
CREATE TRIGGER stop_after AFTER UPDATE ON pickup_stops FOR EACH ROW EXECUTE FUNCTION trg_stop_after();
CREATE TRIGGER b_stop_line BEFORE INSERT OR UPDATE OR DELETE ON pickup_stop_lines FOR EACH ROW EXECUTE FUNCTION trg_stop_line_before();
CREATE TRIGGER stop_line_after AFTER INSERT OR UPDATE OR DELETE ON pickup_stop_lines FOR EACH ROW EXECUTE FUNCTION trg_stop_line_after();

-- السائق والدفعات
CREATE TRIGGER b_driver_offer BEFORE INSERT OR UPDATE ON driver_pay_offers FOR EACH ROW EXECUTE FUNCTION trg_driver_offer_before();
CREATE TRIGGER driver_offer_after AFTER UPDATE ON driver_pay_offers FOR EACH ROW EXECUTE FUNCTION trg_driver_offer_after();
CREATE TRIGGER b_batch BEFORE INSERT OR UPDATE ON order_batches FOR EACH ROW EXECUTE FUNCTION trg_batch_before();
CREATE TRIGGER batch_after AFTER UPDATE ON order_batches FOR EACH ROW EXECUTE FUNCTION trg_batch_after();
CREATE TRIGGER b_batch_line BEFORE INSERT OR UPDATE OR DELETE ON order_batch_lines FOR EACH ROW EXECUTE FUNCTION trg_batch_line_before();

-- المال اليدوي والإعدادات
CREATE TRIGGER cash_handover_post AFTER INSERT ON cash_handovers FOR EACH ROW EXECUTE FUNCTION trg_cash_handover();
CREATE TRIGGER supplier_payout_post AFTER INSERT ON supplier_payouts FOR EACH ROW EXECUTE FUNCTION trg_supplier_payout();
CREATE TRIGGER expense_post AFTER INSERT ON expenses FOR EACH ROW EXECUTE FUNCTION trg_expense();
CREATE TRIGGER b_settings BEFORE UPDATE ON city_settings FOR EACH ROW EXECUTE FUNCTION trg_settings_before();

-- التدقيق: كل تغيير في سعر أو حالة أو مال
CREATE TRIGGER zz_audit AFTER INSERT OR UPDATE OR DELETE ON city_settings FOR EACH ROW EXECUTE FUNCTION trg_audit('city');
CREATE TRIGGER zz_audit AFTER INSERT OR UPDATE OR DELETE ON delivery_zones FOR EACH ROW EXECUTE FUNCTION trg_audit();
CREATE TRIGGER zz_audit AFTER INSERT OR UPDATE OR DELETE ON customers FOR EACH ROW EXECUTE FUNCTION trg_audit();
CREATE TRIGGER zz_audit AFTER INSERT OR UPDATE OR DELETE ON suppliers FOR EACH ROW EXECUTE FUNCTION trg_audit();
CREATE TRIGGER zz_audit AFTER INSERT OR UPDATE OR DELETE ON drivers FOR EACH ROW EXECUTE FUNCTION trg_audit();
CREATE TRIGGER zz_audit AFTER INSERT OR UPDATE OR DELETE ON supplier_offers FOR EACH ROW EXECUTE FUNCTION trg_audit();
CREATE TRIGGER zz_audit AFTER INSERT OR UPDATE OR DELETE ON catalog_items FOR EACH ROW EXECUTE FUNCTION trg_audit();
CREATE TRIGGER zz_audit AFTER INSERT OR UPDATE OR DELETE ON catalog_item_pricing FOR EACH ROW EXECUTE FUNCTION trg_audit('catalog_item_id');
CREATE TRIGGER zz_audit AFTER INSERT OR UPDATE OR DELETE ON catalog_item_sources FOR EACH ROW EXECUTE FUNCTION trg_audit('catalog_item_id');
CREATE TRIGGER zz_audit AFTER INSERT OR UPDATE OR DELETE ON orders FOR EACH ROW EXECUTE FUNCTION trg_audit();
CREATE TRIGGER zz_audit AFTER INSERT OR UPDATE OR DELETE ON order_items FOR EACH ROW EXECUTE FUNCTION trg_audit();
CREATE TRIGGER zz_audit AFTER INSERT OR UPDATE OR DELETE ON pickup_stops FOR EACH ROW EXECUTE FUNCTION trg_audit();
CREATE TRIGGER zz_audit AFTER INSERT OR UPDATE OR DELETE ON pickup_stop_lines FOR EACH ROW EXECUTE FUNCTION trg_audit();
CREATE TRIGGER zz_audit AFTER INSERT OR UPDATE OR DELETE ON driver_pay_offers FOR EACH ROW EXECUTE FUNCTION trg_audit();
CREATE TRIGGER zz_audit AFTER INSERT OR UPDATE OR DELETE ON disputes FOR EACH ROW EXECUTE FUNCTION trg_audit();
CREATE TRIGGER zz_audit AFTER INSERT OR UPDATE OR DELETE ON admin_permissions FOR EACH ROW EXECUTE FUNCTION trg_audit('user_id');
CREATE TRIGGER zz_audit AFTER INSERT OR UPDATE OR DELETE ON admin_members FOR EACH ROW EXECUTE FUNCTION trg_audit('user_id');


-- ═══════════════════════════════════════════════════════════════════════════
-- عروض الجماهير — ما يقرؤه غير اللوحة. لا عمود تكلفة ولا اسم مورد فيها.
-- ═══════════════════════════════════════════════════════════════════════════
-- الكتالوج العام: auto_hide يُخفي النافد، mark_out يُبقيه موسوماً (§2.2)
CREATE VIEW v_customer_catalog AS
SELECT ci.id, ci.city, ci.category_id, ci.name_ar, ci.name_en, ci.unit, ci.unit_size,
       ci.image_media_id, ci.sale_price, ci.is_available AS orderable,
       NOT ci.is_available AS out_of_stock
  FROM catalog_items ci
  JOIN city_settings cs ON cs.city = ci.city
 WHERE ci.visibility = 'visible'
   AND (ci.is_available OR coalesce(ci.oos_policy, cs.oos_policy) = 'mark_out');

-- السلة: السعر حيّ في المسودة، ومحجوز بعدها
CREATE VIEW v_customer_order_lines AS
SELECT oi.id, oi.order_id, oi.catalog_item_id, ci.name_ar, oi.unit, ci.unit_size, oi.qty,
       coalesce(oi.unit_price, ci.sale_price) AS unit_price,
       round(oi.qty * coalesce(oi.unit_price, ci.sale_price), 2) AS line_total,
       oi.delivered_qty
  FROM order_items oi JOIN catalog_items ci ON ci.id = oi.catalog_item_id;

-- القائمة المتكررة موسومة إن صار فيها صنف غير متاح (§3.1)
CREATE VIEW v_customer_lists AS
SELECT rl.id, rl.customer_id, rl.name, rl.reminder_days, rl.reminder_time,
       EXISTS (SELECT 1 FROM recurring_list_items li JOIN catalog_items ci ON ci.id = li.catalog_item_id
                WHERE li.list_id = rl.id AND (ci.visibility <> 'visible' OR NOT ci.is_available)) AS has_unavailable
  FROM recurring_lists rl;

-- السائق: نقاط الاستلام بلا تكلفة. اسم المورد غير مكشوف حتى يقرر المالك (م-2).
CREATE VIEW v_driver_stops AS
SELECT s.id, s.order_id, s.seq, s.source, s.status, s.pickup_code,
       coalesce(pl.lat, w.lat) AS lat, coalesce(pl.lng, w.lng) AS lng,
       coalesce(pl.address_text, w.address_text) AS address_text
  FROM pickup_stops s
  LEFT JOIN supplier_pickup_locations pl ON pl.id = s.pickup_location_id
  LEFT JOIN warehouses w ON w.id = s.warehouse_id
 WHERE s.status <> 'cancelled';

CREATE VIEW v_driver_stop_lines AS
SELECT l.id, l.stop_id, ci.name_ar, oi.unit, ci.unit_size, l.planned_qty, l.collected_qty
  FROM pickup_stop_lines l
  JOIN order_items oi ON oi.id = l.order_item_id
  JOIN catalog_items ci ON ci.id = oi.catalog_item_id;

-- السائق يرى المنشأة وهاتفها وعنوانها والمبلغ الذي سيحصّله فقط (§4.2)
CREATE VIEW v_driver_orders AS
SELECT o.id, o.city, o.status, o.driver_id, c.name AS customer_name, c.phone AS customer_phone,
       o.dest_lat, o.dest_lng, o.dest_address, o.total AS amount_to_collect, o.driver_pay,
       o.collection_mode
  FROM orders o JOIN customers c ON c.id = o.customer_id
 WHERE o.status NOT IN ('draft', 'placed');

-- المورد: طلبات الاستلام — صنف، كمية، موعد، كود. لا عميل ولا سعر بيع ولا وجهة (§2.1).
CREATE VIEW v_supplier_pickups AS
SELECT s.id, s.supplier_id, s.pickup_location_id, s.status, s.pickup_code, o.assigned_at,
       l.id AS line_id, p.name_ar AS product_name, so.unit, so.unit_size, l.planned_qty, l.collected_qty
  FROM pickup_stops s
  JOIN orders o ON o.id = s.order_id
  JOIN pickup_stop_lines l ON l.stop_id = s.id
  JOIN supplier_offers so ON so.id = l.offer_id
  JOIN products p ON p.id = so.product_id
 WHERE s.source = 'supplier' AND s.status <> 'cancelled'
   AND o.status IN ('assigned', 'collecting', 'partially_delivered', 'delivered', 'closed');


-- ═══════════════════════════════════════════════════════════════════════════
-- البذور
-- ═══════════════════════════════════════════════════════════════════════════
SELECT set_config('madad.actor_role', 'system', true);
INSERT INTO cities (code, name_ar, name_en) VALUES ('TIP', 'طرابلس', 'Tripoli');
INSERT INTO city_settings (city) VALUES ('TIP');   -- القيم المالية كلها NULL حتى يقررها المالك

INSERT INTO derived_fields (table_name, column_name, writer, source) VALUES
 ('supplier_offers', 'reserved_qty',    'refresh_offer_commitment', 'مجموع planned_qty لنقاط الاستلام المعلّقة'),
 ('supplier_offers', 'consumed_qty',    'refresh_offer_commitment / trg_offer_before', 'المجموع منذ آخر إبلاغ'),
 ('supplier_offers', 'qty_reported_at', 'trg_offer_before', 'لحظة تغيّر reported_qty'),
 ('supplier_offers', 'report_seq',      'trg_offer_before', 'يزيد مع كل تغيّر في reported_qty'),
 ('pickup_stop_lines', 'offer_report_seq', 'trg_stop_after', 'report_seq للعرض لحظة الجمع'),
 ('supplier_offers', 'available_qty',   'GENERATED', 'reported − reserved − consumed'),
 ('catalog_items', 'sale_price',        'reprice_item', 'catalog_item_pricing + سعر المصدر الأعلى أولوية'),
 ('catalog_items', 'is_available',      'refresh_item_availability', 'العروض النشطة ومخزون المخازن'),
 ('catalog_item_pricing', 'needs_review', 'trg_offer_after / reprice_item', 'تغيّر سعر الشراء'),
 ('warehouse_stock', 'on_hand',         'trg_stock_movement_apply', 'مجموع stock_movements'),
 ('warehouse_stock', 'avg_cost',        'trg_stock_movement_apply', 'متوسط مرجّح عند الإدخال'),
 ('warehouse_stock', 'reserved_qty',    'refresh_warehouse_reservation', 'نقاط استلام المخزن المعلّقة'),
 ('warehouse_stock', 'available_qty',   'GENERATED', 'on_hand − reserved'),
 ('stock_movements', 'unit_cost',       'trg_stock_movement_before', 'متوسط المصدر للخارج والتحويل (مُدخل للإدخال)'),
 ('stock_movements', 'actor_role',      'trg_stock_movement_before', 'الجلسة'),
 ('stock_movements', 'actor_id',        'trg_stock_movement_before', 'الجلسة'),
 ('orders', 'subtotal',                 'refresh_order_totals', 'مجموع line_total'),
 ('orders', 'line_count',               'refresh_order_totals', 'عدد الأسطر المسعّرة'),
 ('orders', 'delivery_fee',             'refresh_order_totals → order_fee', 'city_settings / delivery_zones'),
 ('orders', 'total',                    'GENERATED', 'subtotal + delivery_fee'),
 ('orders', 'collection_mode',          'trg_order_before', 'لقطة city_settings عند placed'),
 ('orders', 'driver_pay',               'trg_order_before / trg_driver_offer_after', 'المعادلة أو العرض المقبول'),
 ('orders', 'plan_complete',            'refresh_plan_complete', 'مخطط الاستلام يغطي كل الكميات'),
 ('orders', 'location_id',              'trg_order_before', 'لقطة الموقع عند placed'),
 ('orders', 'dest_lat',                 'trg_order_before', 'لقطة الموقع عند placed'),
 ('orders', 'dest_lng',                 'trg_order_before', 'لقطة الموقع عند placed'),
 ('orders', 'dest_address',             'trg_order_before', 'لقطة الموقع عند placed'),
 ('orders', 'zone_id',                  'trg_order_before', 'لقطة الموقع عند placed'),
 ('orders', 'placed_at',                'trg_order_before', 'الانتقال'),
 ('orders', 'confirmed_at',             'trg_order_before', 'الانتقال'),
 ('orders', 'assigned_at',              'trg_order_before', 'الانتقال'),
 ('orders', 'delivered_at',             'trg_order_before', 'الانتقال'),
 ('orders', 'closed_at',                'trg_order_before', 'الانتقال'),
 ('orders', 'cancelled_at',             'trg_order_before', 'الانتقال'),
 ('orders', 'cancelled_by_role',        'trg_order_before', 'الانتقال'),
 ('order_items', 'unit_price',          'trg_order_after / trg_order_item_before', 'sale_price لحظة placed أو لحظة الإضافة بعده'),
 ('order_items', 'line_total',          'GENERATED', 'qty × unit_price'),
 ('order_items', 'delivered_qty',       'trg_batch_after', 'مجموع الدفعات المسلَّمة'),
 ('order_batches', 'notification_id',   'trg_batch_before', 'إشعار الانطلاق'),
 ('order_batches', 'notified_at',       'trg_batch_before', 'الانتقال'),
 ('order_batches', 'departed_at',       'trg_batch_before', 'الانتقال'),
 ('order_batches', 'delivered_at',      'trg_batch_before', 'الانتقال'),
 ('pickup_stops', 'confirmed_at',       'trg_stop_before', 'تأكيد السائق'),
 ('driver_pay_offers', 'decided_by',    'trg_driver_offer_before', 'قرار المالك'),
 ('driver_pay_offers', 'decided_at',    'trg_driver_offer_before', 'قرار المالك'),
 ('ledger_accounts', 'balance',         'trg_ledger_entry_apply', 'مجموع ledger_entries');

-- مسار البحث للجلسات الجديدة
DO $$ BEGIN
    EXECUTE format('ALTER DATABASE %I SET search_path = madad, public', current_database());
END $$;
