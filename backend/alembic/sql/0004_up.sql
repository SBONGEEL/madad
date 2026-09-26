-- ═══════════════════════════════════════════════════════════════════════════
-- مَدَد — الترحيلة 0004: قرارات المالك، الدفعة الثانية (2026-09-26، §12-هـ)
-- م-6 تغيّر سعر المورد · م-7 الإلغاء · م-8 مسؤول الفرع · م-9 الفروع · م-12 تكلفة المخزن
-- م-13 الوزن · م-15 الطلب فوق المتاح · م-16 المناطق · م-20 كلمة المرور · م-21 السحوبات
-- م-22 إثبات الاستلام · م-24 قنوات الرمز.
--
-- قاعدة الإعدادات: كل إعداد بقيمة ابتدائية، ويُدقَّق تغييره (zz_audit)، ولا يسري على
-- طلبية قائمة: الطلبية تأخذ لقطة الإعداد عند إرسالها (placed) وتبقى عليها.
-- ═══════════════════════════════════════════════════════════════════════════
SET search_path = madad, public;
SELECT set_config('madad.actor_role', 'system', true);

-- قيم تعداد جديدة: تُستعمل وقت التشغيل فقط (لا داخل هذه الحركة).
ALTER TYPE ledger_account_kind ADD VALUE IF NOT EXISTS 'owner_drawings';
ALTER TYPE ledger_txn_kind ADD VALUE IF NOT EXISTS 'owner_withdrawal';
ALTER TYPE ledger_txn_kind ADD VALUE IF NOT EXISTS 'cancellation';

CREATE TYPE cancel_policy   AS ENUM ('until_collecting', 'anytime');
CREATE TYPE oversell_policy AS ENUM ('forbid', 'allow');
CREATE TYPE cogs_method     AS ENUM ('average', 'fifo');
CREATE TYPE purchaser_mode  AS ENUM ('direct', 'owner_confirms');
CREATE TYPE otp_channel_kind AS ENUM ('whatsapp_official', 'whatsapp_linked', 'sms');
CREATE TYPE password_reset_method AS ENUM ('otp', 'admin', 'self');


-- ——— الإشعارات: أنواع جديدة، ودالة إشعار المالك ————————————————————————————
ALTER TABLE notifications DROP CONSTRAINT notifications_kind_check;
ALTER TABLE notifications ADD CONSTRAINT notifications_kind_check CHECK (kind IN (
    'order_confirmed', 'order_assigned', 'batch_departure', 'order_arrived', 'list_reminder',
    'pickup_request', 'driver_settlement', 'supplier_payout', 'broadcast', 'otp',
    'price_changed', 'below_cost', 'plan_short', 'otp_channel_failed', 'order_awaiting_owner',
    'branch_pending', 'weight_over_capacity'));

-- «إشعار للمالك»: لكل مستخدم لوحة دوره owner.
CREATE FUNCTION notify_owners(p_kind text, p_title text, p_body text, p_payload jsonb DEFAULT '{}'::jsonb,
                              p_order bigint DEFAULT NULL) RETURNS void AS $$
    INSERT INTO notifications (user_id, kind, order_id, title, body, payload)
    SELECT m.user_id, p_kind, p_order, p_title, p_body, p_payload FROM admin_members m WHERE m.role = 'owner';
$$ LANGUAGE sql;


-- ——— الإعدادات العامة (city_settings) ————————————————————————————————————————
-- م-6: كان NULL = «يُعلَّم للمراجعة». صار إعداداً صريحاً، والابتدائي يدوي (false).
UPDATE city_settings SET reprice_on_cost_change = false WHERE reprice_on_cost_change IS NULL;
ALTER TABLE city_settings ALTER COLUMN reprice_on_cost_change SET DEFAULT false,
                          ALTER COLUMN reprice_on_cost_change SET NOT NULL;
ALTER TABLE city_settings
    ADD COLUMN cancel_policy         cancel_policy   NOT NULL DEFAULT 'until_collecting',  -- م-7
    ADD COLUMN oversell_policy       oversell_policy NOT NULL DEFAULT 'forbid',            -- م-15
    ADD COLUMN pickup_proof_required boolean         NOT NULL DEFAULT true;                -- م-22

-- م-6: استثناء صنف بعينه من الإعداد العام. NULL = يتبع المشروع.
ALTER TABLE catalog_item_pricing ADD COLUMN reprice_override boolean;
-- م-6: «لا يُباع صنف بأقل من تكلفته» — علامة مشتقة، والصنف الموسوم موقوف عن البيع.
ALTER TABLE catalog_items ADD COLUMN below_cost boolean NOT NULL DEFAULT false;       -- ◆

-- م-8: مسؤول المشتريات، لكل منشأة، يضبطه المالك.
ALTER TABLE customers ADD COLUMN purchaser_mode purchaser_mode NOT NULL DEFAULT 'direct';


-- ——— م-9: الفروع ———————————————————————————————————————————————————————————
-- customer_locations صُمّم من 0001 ليصير الفروع (تعليقه هناك). الفرع: اسم وعنوان وموقع وحيّ،
-- ويُعتمد. الفروع الموجودة قبل هذه الترحيلة معتمدة (كانت الموقع الوحيد المعتمد مع منشأته).
DROP INDEX v1_one_active_location;
ALTER TABLE customer_locations
    ADD COLUMN name        text,
    ADD COLUMN status      party_status NOT NULL DEFAULT 'approved',
    ADD COLUMN reviewed_by bigint REFERENCES app_users(id),
    ADD COLUMN reviewed_at timestamptz,
    ADD COLUMN created_at  timestamptz NOT NULL DEFAULT now();
UPDATE customer_locations SET name = 'الفرع الرئيسي' WHERE name IS NULL;
ALTER TABLE customer_locations ALTER COLUMN name SET NOT NULL,
                               ALTER COLUMN name SET DEFAULT 'الفرع الرئيسي',
                               ALTER COLUMN status SET DEFAULT 'pending';
ALTER TABLE customer_locations ADD CONSTRAINT branch_name_present CHECK (length(btrim(name)) > 0);
ALTER TABLE customer_locations ADD CONSTRAINT branch_name_unique UNIQUE (customer_id, name);
ALTER TABLE customer_locations ADD CONSTRAINT branch_identity UNIQUE (id, customer_id);

-- مسؤول الفرع مربوط بفرع واحد؛ صاحب المنشأة لكل الفروع.
ALTER TABLE customer_members ADD COLUMN branch_id bigint;
ALTER TABLE customer_members ADD CONSTRAINT member_branch_of_customer
    FOREIGN KEY (branch_id, customer_id) REFERENCES customer_locations(id, customer_id);
ALTER TABLE customer_members ADD CONSTRAINT purchaser_has_branch
    CHECK ((role = 'owner') = (branch_id IS NULL));

-- العضو الفاعل في منشأة (أو NULL).
CREATE FUNCTION actor_member(p_customer bigint) RETURNS customer_members AS $$
    SELECT * FROM customer_members WHERE customer_id = p_customer AND user_id = actor_id()
$$ LANGUAGE sql STABLE;

-- إضافة الفروع والمستخدمين لصاحب المنشأة وحده (أو اللوحة). اعتماد الفرع للّوحة.
CREATE FUNCTION trg_branch_before() RETURNS trigger AS $$
DECLARE r text; m customer_members;
BEGIN
    r := writer_role();
    IF r IN ('trigger', 'system') THEN RETURN coalesce(NEW, OLD); END IF;
    IF TG_OP = 'DELETE' THEN
        RAISE EXCEPTION 'branch_delete_forbidden: deactivate instead' USING ERRCODE = 'restrict_violation';
    END IF;
    IF r = 'admin' THEN
        PERFORM require_admin('customers');
        IF TG_OP = 'UPDATE' AND NEW.status IS DISTINCT FROM OLD.status THEN
            PERFORM require_admin('approvals');
            NEW.reviewed_by := actor_id(); NEW.reviewed_at := now();
        END IF;
        RETURN NEW;
    END IF;
    IF r <> 'customer' THEN
        RAISE EXCEPTION 'forbidden_role: %', r USING ERRCODE = 'insufficient_privilege';
    END IF;
    m := actor_member(NEW.customer_id);
    IF m IS NULL OR m.role <> 'owner' THEN
        RAISE EXCEPTION 'forbidden_owner_member: branches are added by the establishment owner'
            USING ERRCODE = 'insufficient_privilege';
    END IF;
    IF TG_OP = 'INSERT' THEN
        NEW.status := 'pending'; NEW.reviewed_by := NULL; NEW.reviewed_at := NULL;
    ELSE
        IF NEW.status IS DISTINCT FROM OLD.status OR NEW.reviewed_by IS DISTINCT FROM OLD.reviewed_by
           OR NEW.customer_id <> OLD.customer_id THEN
            RAISE EXCEPTION 'forbidden_role: branch review is for the admin' USING ERRCODE = 'insufficient_privilege';
        END IF;
        -- تغيير الموقع أو العنوان يعيد الفرع إلى المراجعة
        IF NEW.lat <> OLD.lat OR NEW.lng <> OLD.lng OR NEW.address_text <> OLD.address_text THEN
            NEW.status := 'pending'; NEW.reviewed_by := NULL; NEW.reviewed_at := NULL;
        END IF;
    END IF;
    RETURN NEW;
END $$ LANGUAGE plpgsql;
CREATE TRIGGER b_branch BEFORE INSERT OR UPDATE OR DELETE ON customer_locations
    FOR EACH ROW EXECUTE FUNCTION trg_branch_before();
CREATE TRIGGER zz_audit AFTER INSERT OR UPDATE OR DELETE ON customer_locations
    FOR EACH ROW EXECUTE FUNCTION trg_audit();

CREATE FUNCTION trg_branch_pending_notice() RETURNS trigger AS $$
BEGIN
    IF NEW.status = 'pending' AND (TG_OP = 'INSERT' OR OLD.status <> 'pending')
       AND (SELECT status FROM customers WHERE id = NEW.customer_id) = 'approved' THEN
        PERFORM notify_owners('branch_pending', 'فرع بانتظار الاعتماد', NEW.name,
                              jsonb_build_object('branch_id', NEW.id, 'customer_id', NEW.customer_id));
    END IF;
    RETURN NULL;
END $$ LANGUAGE plpgsql;
CREATE TRIGGER branch_pending_notice AFTER INSERT OR UPDATE ON customer_locations
    FOR EACH ROW EXECUTE FUNCTION trg_branch_pending_notice();

-- الفرع الأول يُراجَع مع تسجيل المنشأة: اعتماد المنشأة يعتمد فروعها المعلّقة معه.
CREATE FUNCTION trg_customer_approved_branches() RETURNS trigger AS $$
BEGIN
    IF NEW.status = 'approved' AND OLD.status IS DISTINCT FROM 'approved' THEN
        UPDATE customer_locations SET status = 'approved', reviewed_by = NEW.reviewed_by, reviewed_at = now()
         WHERE customer_id = NEW.id AND status = 'pending';
    END IF;
    RETURN NULL;
END $$ LANGUAGE plpgsql;
CREATE TRIGGER customer_approved_branches AFTER UPDATE ON customers
    FOR EACH ROW EXECUTE FUNCTION trg_customer_approved_branches();

-- م-8: وضع المسؤول يضبطه المالك وحده.
CREATE FUNCTION trg_purchaser_mode() RETURNS trigger AS $$
BEGIN
    IF NEW.purchaser_mode IS DISTINCT FROM OLD.purchaser_mode THEN
        PERFORM require_admin('customers');
    END IF;
    RETURN NEW;
END $$ LANGUAGE plpgsql;
CREATE TRIGGER b_purchaser_mode BEFORE UPDATE ON customers FOR EACH ROW EXECUTE FUNCTION trg_purchaser_mode();

-- أعضاء المنشأة: صاحبها وحده يضيف ويعدّل (أول عضو يسجّل نفسه صاحباً).
CREATE FUNCTION trg_member_before() RETURNS trigger AS $$
DECLARE r text; m customer_members; cid bigint := coalesce(NEW.customer_id, OLD.customer_id);
BEGIN
    r := writer_role();
    IF r IN ('trigger', 'system') THEN RETURN coalesce(NEW, OLD); END IF;
    IF r = 'admin' THEN
        PERFORM require_admin('customers');
        RETURN coalesce(NEW, OLD);
    END IF;
    IF r <> 'customer' THEN
        RAISE EXCEPTION 'forbidden_role: %', r USING ERRCODE = 'insufficient_privilege';
    END IF;
    IF TG_OP = 'INSERT' AND NOT EXISTS (SELECT 1 FROM customer_members WHERE customer_id = cid)
       AND NEW.user_id = actor_id() AND NEW.role = 'owner' THEN
        RETURN NEW;   -- المسجِّل الأول صاحب المنشأة
    END IF;
    m := actor_member(cid);
    IF m IS NULL OR m.role <> 'owner' THEN
        RAISE EXCEPTION 'forbidden_owner_member: users are added by the establishment owner'
            USING ERRCODE = 'insufficient_privilege';
    END IF;
    RETURN coalesce(NEW, OLD);
END $$ LANGUAGE plpgsql;
CREATE TRIGGER b_member BEFORE INSERT OR UPDATE OR DELETE ON customer_members
    FOR EACH ROW EXECUTE FUNCTION trg_member_before();
CREATE TRIGGER zz_audit AFTER INSERT OR UPDATE OR DELETE ON customer_members
    FOR EACH ROW EXECUTE FUNCTION trg_audit('user_id');

-- الفرع المقصود لطلبية أو قائمة: المسؤول فرعه وحده؛ الصاحب يختار، وفرع معتمد واحد يُختار تلقائياً.
CREATE FUNCTION resolve_branch(p_customer bigint, p_branch bigint) RETURNS bigint AS $$
DECLARE m customer_members; b bigint; n int;
BEGIN
    m := actor_member(p_customer);
    IF m IS NULL THEN
        RAISE EXCEPTION 'forbidden_not_member' USING ERRCODE = 'insufficient_privilege';
    END IF;
    IF m.role = 'purchaser' THEN
        IF p_branch IS NOT NULL AND p_branch <> m.branch_id THEN
            RAISE EXCEPTION 'forbidden_branch: %', p_branch USING ERRCODE = 'insufficient_privilege';
        END IF;
        b := m.branch_id;
    ELSIF p_branch IS NOT NULL THEN
        b := p_branch;
    ELSE
        SELECT count(*), min(id) INTO n, b FROM customer_locations
         WHERE customer_id = p_customer AND active AND status = 'approved';
        IF n = 0 THEN
            RAISE EXCEPTION 'branch_missing: customer %', p_customer USING ERRCODE = 'check_violation';
        ELSIF n > 1 THEN
            RAISE EXCEPTION 'branch_required' USING ERRCODE = 'check_violation';
        END IF;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM customer_locations WHERE id = b AND customer_id = p_customer) THEN
        RAISE EXCEPTION 'forbidden_branch: %', b USING ERRCODE = 'insufficient_privilege';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM customer_locations WHERE id = b AND active AND status = 'approved') THEN
        RAISE EXCEPTION 'branch_not_approved: %', b USING ERRCODE = 'check_violation';
    END IF;
    RETURN b;
END $$ LANGUAGE plpgsql;

-- العضو الفاعل يلمس طلبية فرعه فقط (المسؤول)، أو أي فرع (الصاحب).
CREATE FUNCTION require_branch_access(p_customer bigint, p_branch bigint) RETURNS customer_members AS $$
DECLARE m customer_members;
BEGIN
    m := actor_member(p_customer);
    IF m IS NULL THEN
        RAISE EXCEPTION 'forbidden_not_member' USING ERRCODE = 'insufficient_privilege';
    END IF;
    IF m.role = 'purchaser' AND p_branch IS DISTINCT FROM m.branch_id THEN
        RAISE EXCEPTION 'forbidden_branch: %', p_branch USING ERRCODE = 'insufficient_privilege';
    END IF;
    RETURN m;
END $$ LANGUAGE plpgsql;

-- القوائم المتكررة لكل فرع.
ALTER TABLE recurring_lists ADD COLUMN branch_id bigint;
UPDATE recurring_lists rl SET branch_id = (SELECT min(id) FROM customer_locations cl WHERE cl.customer_id = rl.customer_id);
ALTER TABLE recurring_lists ALTER COLUMN branch_id SET NOT NULL;
ALTER TABLE recurring_lists ADD CONSTRAINT list_branch_of_customer
    FOREIGN KEY (branch_id, customer_id) REFERENCES customer_locations(id, customer_id);
ALTER TABLE recurring_lists DROP CONSTRAINT recurring_lists_customer_id_name_key;
ALTER TABLE recurring_lists ADD CONSTRAINT list_name_per_branch UNIQUE (branch_id, name);

CREATE FUNCTION trg_list_before() RETURNS trigger AS $$
DECLARE r text;
BEGIN
    r := writer_role();
    IF r IN ('trigger', 'system') THEN RETURN coalesce(NEW, OLD); END IF;
    IF r <> 'customer' THEN
        RAISE EXCEPTION 'forbidden_role: %', r USING ERRCODE = 'insufficient_privilege';
    END IF;
    IF TG_OP = 'INSERT' THEN
        NEW.branch_id := resolve_branch(NEW.customer_id, NEW.branch_id);
        RETURN NEW;
    END IF;
    PERFORM require_branch_access(OLD.customer_id, OLD.branch_id);
    IF TG_OP = 'UPDATE' AND (NEW.branch_id <> OLD.branch_id OR NEW.customer_id <> OLD.customer_id) THEN
        RAISE EXCEPTION 'list_identity_immutable' USING ERRCODE = 'restrict_violation';
    END IF;
    RETURN coalesce(NEW, OLD);
END $$ LANGUAGE plpgsql;
CREATE TRIGGER b_list BEFORE INSERT OR UPDATE OR DELETE ON recurring_lists FOR EACH ROW EXECUTE FUNCTION trg_list_before();

CREATE FUNCTION trg_list_item_before() RETURNS trigger AS $$
DECLARE l recurring_lists;
BEGIN
    IF writer_role() IN ('trigger', 'system') THEN RETURN coalesce(NEW, OLD); END IF;
    SELECT * INTO l FROM recurring_lists WHERE id = coalesce(NEW.list_id, OLD.list_id);
    PERFORM require_branch_access(l.customer_id, l.branch_id);
    RETURN coalesce(NEW, OLD);
END $$ LANGUAGE plpgsql;
CREATE TRIGGER b_list_item BEFORE INSERT OR UPDATE OR DELETE ON recurring_list_items
    FOR EACH ROW EXECUTE FUNCTION trg_list_item_before();


-- ——— م-16: الأحياء (delivery_zones) والمناطق المرسومة ————————————————————————
-- المضلّع مصفوفة نقاط [lat, lng]، ثلاث على الأقل. بلا PostGIS: الفحص بخوارزمية الشعاع.
CREATE TABLE delivery_areas (
    id      bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    city    text NOT NULL REFERENCES cities(code),
    name_ar text NOT NULL CHECK (length(btrim(name_ar)) > 0),
    fee     money_lyd NOT NULL CHECK (fee >= 0),
    polygon jsonb NOT NULL CHECK (jsonb_typeof(polygon) = 'array' AND jsonb_array_length(polygon) >= 3),
    active  boolean NOT NULL DEFAULT true,
    UNIQUE (city, name_ar)
);

CREATE FUNCTION point_in_polygon(p_lat numeric, p_lng numeric, p_poly jsonb) RETURNS boolean AS $$
DECLARE n int := jsonb_array_length(p_poly); i int; j int; inside boolean := false;
        yi numeric; xi numeric; yj numeric; xj numeric;
BEGIN
    j := n - 1;
    FOR i IN 0 .. n - 1 LOOP
        yi := (p_poly -> i ->> 0)::numeric; xi := (p_poly -> i ->> 1)::numeric;
        yj := (p_poly -> j ->> 0)::numeric; xj := (p_poly -> j ->> 1)::numeric;
        IF ((yi > p_lat) <> (yj > p_lat))
           AND (p_lng < (xj - xi) * (p_lat - yi) / (yj - yi) + xi) THEN
            inside := NOT inside;
        END IF;
        j := i;
    END LOOP;
    RETURN inside;
END $$ LANGUAGE plpgsql IMMUTABLE;

CREATE FUNCTION trg_area_before() RETURNS trigger AS $$
DECLARE pt jsonb;
BEGIN
    PERFORM require_admin('settings');
    IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
    FOR pt IN SELECT * FROM jsonb_array_elements(NEW.polygon) LOOP
        IF jsonb_typeof(pt) <> 'array' OR jsonb_array_length(pt) <> 2
           OR (pt ->> 0)::numeric NOT BETWEEN -90 AND 90 OR (pt ->> 1)::numeric NOT BETWEEN -180 AND 180 THEN
            RAISE EXCEPTION 'area_polygon_invalid' USING ERRCODE = 'check_violation';
        END IF;
    END LOOP;
    RETURN NEW;
END $$ LANGUAGE plpgsql;
CREATE TRIGGER b_area BEFORE INSERT OR UPDATE OR DELETE ON delivery_areas FOR EACH ROW EXECUTE FUNCTION trg_area_before();
CREATE TRIGGER zz_audit AFTER INSERT OR UPDATE OR DELETE ON delivery_areas FOR EACH ROW EXECUTE FUNCTION trg_audit();

-- الأحياء للّوحة وحدها (كانت بلا حارس).
CREATE FUNCTION trg_zone_before() RETURNS trigger AS $$
BEGIN
    PERFORM require_admin('settings');
    RETURN coalesce(NEW, OLD);
END $$ LANGUAGE plpgsql;
CREATE TRIGGER b_zone BEFORE INSERT OR UPDATE OR DELETE ON delivery_zones FOR EACH ROW EXECUTE FUNCTION trg_zone_before();

-- المنطقة المرسومة التي تحوي النقطة. منطقتان برسمين مختلفين تحويانها = تعارض.
CREATE FUNCTION area_for_point(p_city text, p_lat numeric, p_lng numeric) RETURNS bigint AS $$
DECLARE fees int; a bigint;
BEGIN
    SELECT count(DISTINCT fee), min(id) INTO fees, a FROM delivery_areas
     WHERE city = p_city AND active AND point_in_polygon(p_lat, p_lng, polygon);
    IF fees > 1 THEN
        RAISE EXCEPTION 'area_overlap: overlapping areas with different fees' USING ERRCODE = 'check_violation';
    END IF;
    RETURN a;
END $$ LANGUAGE plpgsql STABLE;


-- ——— لقطات الطلبية (الإعداد لا يسري على طلبية قائمة) ————————————————————————————
ALTER TABLE orders
    ADD COLUMN branch_id             bigint,
    ADD COLUMN area_id               bigint REFERENCES delivery_areas(id),          -- ◆
    ADD COLUMN cancel_policy         cancel_policy,                                 -- ◆
    ADD COLUMN oversell_policy       oversell_policy,                               -- ◆
    ADD COLUMN pickup_proof_required boolean,                                       -- ◆
    ADD COLUMN cogs_method           cogs_method,                                   -- ◆
    ADD COLUMN ready_for_owner_at    timestamptz;                                   -- م-8: المسؤول جهّز السلة
UPDATE orders o SET branch_id = coalesce(o.location_id,
                                         (SELECT min(id) FROM customer_locations cl WHERE cl.customer_id = o.customer_id));
ALTER TABLE orders ALTER COLUMN branch_id SET NOT NULL;
ALTER TABLE orders ADD CONSTRAINT order_branch_of_customer
    FOREIGN KEY (branch_id, customer_id) REFERENCES customer_locations(id, customer_id);
ALTER TABLE orders ADD CONSTRAINT placed_orders_have_policies
    CHECK (status IN ('draft', 'cancelled') OR (cancel_policy IS NOT NULL AND oversell_policy IS NOT NULL
                                                AND pickup_proof_required IS NOT NULL AND cogs_method IS NOT NULL));
DROP INDEX one_draft_per_customer;
CREATE UNIQUE INDEX one_draft_per_branch ON orders (branch_id) WHERE status = 'draft';
CREATE TRIGGER a_guard_derived_0004 BEFORE INSERT OR UPDATE ON orders FOR EACH ROW
    EXECUTE FUNCTION guard_derived('area_id:null', 'cancel_policy:null', 'oversell_policy:null',
                                   'pickup_proof_required:null', 'cogs_method:null');


-- ——— م-12: طريقة تكلفة المخزن، بتاريخ سريانها ————————————————————————————————
CREATE TABLE cogs_method_periods (
    id             bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    city           text NOT NULL REFERENCES cities(code),
    method         cogs_method NOT NULL,
    effective_from timestamptz NOT NULL DEFAULT now(),   -- ◆ لحظة التسجيل: لا رجعية
    set_by         bigint REFERENCES app_users(id),
    UNIQUE (city, effective_from)
);
CREATE FUNCTION trg_cogs_period_before() RETURNS trigger AS $$
BEGIN
    IF writer_role() NOT IN ('trigger', 'system') THEN
        PERFORM require_admin('settings');
    END IF;
    NEW.effective_from := now();
    NEW.set_by := actor_id();
    RETURN NEW;
END $$ LANGUAGE plpgsql;
CREATE TRIGGER b_cogs_period BEFORE INSERT ON cogs_method_periods FOR EACH ROW EXECUTE FUNCTION trg_cogs_period_before();
CREATE TRIGGER z_append_only BEFORE UPDATE OR DELETE ON cogs_method_periods FOR EACH ROW EXECUTE FUNCTION guard_append_only();
CREATE TRIGGER zz_audit AFTER INSERT ON cogs_method_periods FOR EACH ROW EXECUTE FUNCTION trg_audit();
INSERT INTO cogs_method_periods (city, method) SELECT code, 'average' FROM cities;

CREATE FUNCTION current_cogs_method(p_city text) RETURNS cogs_method AS $$
    SELECT method FROM cogs_method_periods WHERE city = p_city AND effective_from <= now()
     ORDER BY effective_from DESC, id DESC LIMIT 1
$$ LANGUAGE sql STABLE;

-- طبقات الإدخال للأقدم أولاً. تُستهلك بالأقدم دائماً، والطريقة تقرر أي تكلفة تُسجَّل.
CREATE TABLE stock_layers (
    id              bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    warehouse_id    bigint NOT NULL REFERENCES warehouses(id),
    catalog_item_id bigint NOT NULL REFERENCES catalog_items(id),
    movement_id     bigint REFERENCES stock_movements(id),
    unit_cost       numeric NOT NULL CHECK (unit_cost >= 0),
    qty_in          numeric NOT NULL CHECK (qty_in > 0),
    qty_left        numeric NOT NULL CHECK (qty_left >= 0 AND qty_left <= qty_in),
    created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ON stock_layers (warehouse_id, catalog_item_id, id) WHERE qty_left > 0;
INSERT INTO stock_layers (warehouse_id, catalog_item_id, unit_cost, qty_in, qty_left)
SELECT warehouse_id, catalog_item_id, avg_cost, on_hand, on_hand FROM warehouse_stock WHERE on_hand > 0;
CREATE TRIGGER a_guard_trigger_only BEFORE INSERT OR UPDATE OR DELETE ON stock_layers
    FOR EACH ROW EXECUTE FUNCTION guard_trigger_only();

ALTER TABLE stock_movements ADD COLUMN cost_method cogs_method;   -- ◆ الطريقة التي سُعِّرت بها الحركة الخارجة

-- تكلفة كمية خارجة بالأقدم أولاً (دون استهلاك).
CREATE FUNCTION fifo_cost(p_wh bigint, p_item bigint, p_qty numeric) RETURNS numeric AS $$
DECLARE l record; need numeric := p_qty; total numeric := 0; take numeric;
BEGIN
    FOR l IN SELECT * FROM stock_layers WHERE warehouse_id = p_wh AND catalog_item_id = p_item AND qty_left > 0
              ORDER BY id LOOP
        EXIT WHEN need <= 0;
        take := least(need, l.qty_left);
        total := total + take * l.unit_cost;
        need := need - take;
    END LOOP;
    IF p_qty <= 0 OR need > 0 THEN RETURN NULL; END IF;
    RETURN total / p_qty;
END $$ LANGUAGE plpgsql STABLE;

CREATE OR REPLACE FUNCTION trg_stock_movement_before() RETURNS trigger AS $$
DECLARE src stock_movements; src_city text; dst_city text; wh_city text; avg numeric; fifo numeric;
        meth cogs_method;
BEGIN
    IF writer_role() <> 'trigger' THEN
        PERFORM require_admin('warehouses');
        IF NEW.kind = 'pickup' THEN
            RAISE EXCEPTION 'derived_field_write: stock_movements.pickup' USING ERRCODE = 'restrict_violation';
        END IF;
        IF NEW.kind <> 'intake' AND NEW.unit_cost IS NOT NULL THEN
            RAISE EXCEPTION 'derived_field_write: stock_movements.unit_cost' USING ERRCODE = 'restrict_violation';
        END IF;
        IF NEW.cost_method IS NOT NULL THEN
            RAISE EXCEPTION 'derived_field_write: stock_movements.cost_method' USING ERRCODE = 'restrict_violation';
        END IF;
    END IF;
    NEW.actor_role := actor_role();
    NEW.actor_id := actor_id();
    IF NEW.kind IN ('transfer_out', 'count_adjust', 'pickup') THEN
        avg := coalesce((SELECT avg_cost FROM warehouse_stock
                          WHERE warehouse_id = NEW.warehouse_id AND catalog_item_id = NEW.catalog_item_id), 0);
        IF NEW.qty_delta < 0 THEN
            -- م-12: الحركة لطلبية تأخذ طريقة الطلبية (لقطة placed)؛ غيرها الطريقة السارية الآن
            IF NEW.kind = 'pickup' THEN
                SELECT o.cogs_method INTO meth FROM pickup_stop_lines l
                  JOIN pickup_stops s ON s.id = l.stop_id JOIN orders o ON o.id = s.order_id
                 WHERE l.id = NEW.stop_line_id;
            END IF;
            SELECT city INTO wh_city FROM warehouses WHERE id = NEW.warehouse_id;
            NEW.cost_method := coalesce(meth, current_cogs_method(wh_city));
            fifo := fifo_cost(NEW.warehouse_id, NEW.catalog_item_id, -NEW.qty_delta);
            NEW.unit_cost := CASE WHEN NEW.cost_method = 'fifo' THEN coalesce(fifo, avg) ELSE avg END;
        ELSE
            NEW.unit_cost := avg;   -- جرد بالزيادة يدخل بالمتوسط
        END IF;
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

CREATE OR REPLACE FUNCTION trg_stock_movement_apply() RETURNS trigger AS $$
DECLARE ws warehouse_stock; new_on_hand numeric; new_avg numeric; wh_city text; value numeric;
        src stock_movements; l record; need numeric; take numeric;
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
    new_avg := CASE WHEN NEW.kind IN ('intake', 'transfer_in') AND new_on_hand > 0
                    THEN (ws.on_hand * ws.avg_cost + NEW.qty_delta * NEW.unit_cost) / new_on_hand
                    ELSE ws.avg_cost END;
    UPDATE warehouse_stock SET on_hand = new_on_hand, avg_cost = new_avg
     WHERE warehouse_id = NEW.warehouse_id AND catalog_item_id = NEW.catalog_item_id;

    -- الطبقات: الداخل طبقة، والخارج يستهلك الأقدم
    IF NEW.qty_delta > 0 THEN
        INSERT INTO stock_layers (warehouse_id, catalog_item_id, movement_id, unit_cost, qty_in, qty_left)
        VALUES (NEW.warehouse_id, NEW.catalog_item_id, NEW.id, NEW.unit_cost, NEW.qty_delta, NEW.qty_delta);
    ELSE
        need := -NEW.qty_delta;
        FOR l IN SELECT * FROM stock_layers WHERE warehouse_id = NEW.warehouse_id
                   AND catalog_item_id = NEW.catalog_item_id AND qty_left > 0 ORDER BY id FOR UPDATE LOOP
            EXIT WHEN need <= 0;
            take := least(need, l.qty_left);
            UPDATE stock_layers SET qty_left = qty_left - take WHERE id = l.id;
            need := need - take;
        END LOOP;
    END IF;
    -- السحب لطلبية: التكلفة الفعلية تحلّ محل تقدير المخطط
    IF NEW.kind = 'pickup' THEN
        UPDATE pickup_line_costs SET unit_cost = NEW.unit_cost WHERE stop_line_id = NEW.stop_line_id;
    END IF;

    SELECT city INTO wh_city FROM warehouses WHERE id = NEW.warehouse_id;
    IF NEW.kind = 'intake' THEN
        value := round(NEW.qty_delta * NEW.unit_cost, 3);
        PERFORM ledger_post('stock_intake', wh_city, CASE WHEN NEW.funded_by_owner THEN 'مخزون افتتاحي من رأس المال' ELSE 'إدخال مخزون' END,
            jsonb_build_array(
                jsonb_build_array(ledger_account('warehouse_inventory', wh_city, NEW.warehouse_id), value),
                jsonb_build_array(CASE WHEN NEW.supplier_id IS NOT NULL
                                       THEN ledger_account('supplier_payable', wh_city, NEW.supplier_id)
                                       WHEN NEW.funded_by_owner
                                       THEN ledger_account('owner_equity', wh_city)
                                       ELSE ledger_account('treasury', wh_city) END, -value)),
            p_ref_table => 'stock_movements', p_ref_id => NEW.id);
    ELSIF NEW.kind = 'count_adjust' THEN
        value := round(NEW.qty_delta * NEW.unit_cost, 3);
        IF value <> 0 THEN
            PERFORM ledger_post('stock_adjustment', wh_city, 'تسوية جرد',
                jsonb_build_array(
                    jsonb_build_array(ledger_account('warehouse_inventory', wh_city, NEW.warehouse_id), value),
                    jsonb_build_array(ledger_account('operating_expense', wh_city), -value)),
                p_ref_table => 'stock_movements', p_ref_id => NEW.id);
        END IF;
    ELSIF NEW.kind = 'transfer_in' THEN
        SELECT * INTO src FROM stock_movements WHERE transfer_id = NEW.transfer_id AND kind = 'transfer_out';
        value := round(NEW.qty_delta * NEW.unit_cost, 3);
        IF value <> 0 THEN
            PERFORM ledger_post('stock_adjustment', wh_city, 'تحويل بين المخازن',
                jsonb_build_array(
                    jsonb_build_array(ledger_account('warehouse_inventory', wh_city, NEW.warehouse_id), value),
                    jsonb_build_array(ledger_account('warehouse_inventory', wh_city, src.warehouse_id), -value)),
                p_ref_table => 'stock_movements', p_ref_id => NEW.id);
        END IF;
    END IF;
    PERFORM refresh_item_availability(NEW.catalog_item_id);
    PERFORM refresh_cost_guard(NEW.catalog_item_id);
    RETURN NULL;
END $$ LANGUAGE plpgsql;


-- ——— م-6: التكلفة المرجعية وحارس «لا بيع تحت التكلفة» ——————————————————————————
-- التكلفة المرجعية = أعلى تكلفة حالية يمكن أن يُشترى بها الصنف: أعلى سعر شراء بين مصادره
-- النشطة لموردين معتمدين، وأعلى متوسط تكلفة في مخازن المدينة التي فيها مخزون منه.
CREATE FUNCTION item_cost_ref(p_item bigint) RETURNS numeric AS $$
    SELECT greatest(
        (SELECT max(o.purchase_price) FROM catalog_item_sources cs
           JOIN supplier_offers o ON o.id = cs.offer_id JOIN suppliers s ON s.id = o.supplier_id
          WHERE cs.catalog_item_id = p_item AND o.status = 'active' AND s.status = 'approved'),
        (SELECT max(ws.avg_cost) FROM warehouse_stock ws JOIN warehouses w ON w.id = ws.warehouse_id
           JOIN catalog_items ci ON ci.id = ws.catalog_item_id
          WHERE ws.catalog_item_id = p_item AND w.active AND w.city = ci.city AND ws.on_hand > 0))
$$ LANGUAGE sql STABLE;

CREATE FUNCTION refresh_cost_guard(p_item bigint) RETURNS void AS $$
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

CREATE FUNCTION trg_catalog_cost_guard() RETURNS trigger AS $$
BEGIN
    PERFORM refresh_cost_guard(NEW.id);
    RETURN NULL;
END $$ LANGUAGE plpgsql;
CREATE TRIGGER catalog_cost_guard AFTER INSERT OR UPDATE OF sale_price ON catalog_items
    FOR EACH ROW EXECUTE FUNCTION trg_catalog_cost_guard();
CREATE TRIGGER a_guard_derived_below_cost BEFORE INSERT OR UPDATE ON catalog_items FOR EACH ROW
    EXECUTE FUNCTION guard_derived('below_cost:false');

-- تغيّر سعر الشراء: إشعار للمالك دائماً؛ ثم تحديث تلقائي بالهامش أو علامة مراجعة، بحسب
-- الإعداد العام أو استثناء الصنف؛ ثم حارس التكلفة في الحالتين.
CREATE OR REPLACE FUNCTION trg_offer_after() RETURNS trigger AS $$
DECLARE item bigint; auto boolean; p catalog_item_pricing; changed boolean;
BEGIN
    changed := TG_OP = 'UPDATE' AND NEW.purchase_price IS DISTINCT FROM OLD.purchase_price;
    IF changed THEN
        PERFORM notify_owners('price_changed', 'تغيّر سعر مورد',
            (SELECT name_ar FROM products WHERE id = NEW.product_id) || ': ' || OLD.purchase_price || ' ← ' || NEW.purchase_price,
            jsonb_build_object('offer_id', NEW.id, 'old_price', OLD.purchase_price, 'new_price', NEW.purchase_price));
    END IF;
    FOR item IN SELECT catalog_item_id FROM catalog_item_sources WHERE offer_id = NEW.id LOOP
        PERFORM refresh_item_availability(item);
        IF changed THEN
            SELECT * INTO p FROM catalog_item_pricing WHERE catalog_item_id = item;
            SELECT coalesce(p.reprice_override, cs.reprice_on_cost_change) INTO auto
              FROM catalog_items ci JOIN city_settings cs ON cs.city = ci.city WHERE ci.id = item;
            IF auto AND p.mode IS NOT NULL AND p.mode <> 'manual' THEN
                PERFORM reprice_item(item);
            ELSE
                UPDATE catalog_item_pricing SET needs_review = true WHERE catalog_item_id = item;
            END IF;
        END IF;
        PERFORM refresh_cost_guard(item);
    END LOOP;
    RETURN NULL;
END $$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION trg_source_after() RETURNS trigger AS $$
DECLARE item bigint := coalesce(NEW.catalog_item_id, OLD.catalog_item_id);
BEGIN
    PERFORM refresh_item_availability(item);
    IF EXISTS (SELECT 1 FROM catalog_item_pricing WHERE catalog_item_id = item AND mode <> 'manual') THEN
        PERFORM reprice_item(item);
    END IF;
    PERFORM refresh_cost_guard(item);
    RETURN NULL;
END $$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION trg_supplier_status_after() RETURNS trigger AS $$
DECLARE item bigint;
BEGIN
    IF NEW.status IS DISTINCT FROM OLD.status THEN
        FOR item IN SELECT DISTINCT cs.catalog_item_id FROM catalog_item_sources cs
                      JOIN supplier_offers o ON o.id = cs.offer_id WHERE o.supplier_id = NEW.id LOOP
            PERFORM refresh_item_availability(item);
            PERFORM refresh_cost_guard(item);
        END LOOP;
    END IF;
    RETURN NULL;
END $$ LANGUAGE plpgsql;

-- الكتالوج العام: الصنف الموقوف تحت التكلفة لا يظهر ولا يُطلب.
CREATE OR REPLACE VIEW v_customer_catalog AS
SELECT ci.id, ci.city, ci.category_id, ci.name_ar, ci.name_en, ci.unit, ci.unit_size,
       ci.image_media_id, ci.sale_price, ci.is_available AS orderable,
       NOT ci.is_available AS out_of_stock
  FROM catalog_items ci
  JOIN city_settings cs ON cs.city = ci.city
 WHERE ci.visibility = 'visible' AND NOT ci.below_cost
   AND (ci.is_available OR coalesce(ci.oos_policy, cs.oos_policy) = 'mark_out');


-- ——— م-15: المتاح للطلب ————————————————————————————————————————————————————
CREATE FUNCTION item_available_qty(p_item bigint) RETURNS numeric AS $$
    SELECT coalesce((SELECT sum(o.available_qty) FROM catalog_item_sources cs
                       JOIN supplier_offers o ON o.id = cs.offer_id JOIN suppliers s ON s.id = o.supplier_id
                      WHERE cs.catalog_item_id = p_item AND o.status = 'active' AND s.status = 'approved'
                        AND o.available_qty > 0), 0)
         + coalesce((SELECT sum(ws.available_qty) FROM warehouse_stock ws JOIN warehouses w ON w.id = ws.warehouse_id
                       JOIN catalog_items ci ON ci.id = ws.catalog_item_id
                      WHERE ws.catalog_item_id = p_item AND w.active AND w.city = ci.city AND ws.available_qty > 0), 0)
$$ LANGUAGE sql STABLE;


-- ——— أسطر الطلبية: الفرع، ولا بيع تحت التكلفة، والمتاح (م-9، م-6، م-15) ——————————————
CREATE OR REPLACE FUNCTION trg_order_item_before() RETURNS trigger AS $$
DECLARE o orders; r text; ci catalog_items; pol oversell_policy; avail numeric;
BEGIN
    SELECT * INTO o FROM orders WHERE id = coalesce(NEW.order_id, OLD.order_id);
    r := writer_role();
    IF r <> 'trigger' THEN
        IF r = 'customer' THEN
            IF o.status NOT IN ('draft', 'placed') THEN
                RAISE EXCEPTION 'order_locked_for_customer: %', o.status USING ERRCODE = 'check_violation';
            END IF;
            PERFORM require_branch_access(o.customer_id, o.branch_id);
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
        IF r <> 'trigger' AND (ci.visibility <> 'visible' OR NOT ci.is_available) THEN
            RAISE EXCEPTION 'item_not_orderable: %', ci.id USING ERRCODE = 'check_violation';
        END IF;
        IF r <> 'trigger' AND ci.below_cost THEN
            RAISE EXCEPTION 'item_below_cost: %', ci.id USING ERRCODE = 'check_violation';
        END IF;
        IF o.status <> 'draft' THEN
            NEW.unit_price := ci.sale_price;
        END IF;
    ELSIF NEW.unit IS DISTINCT FROM OLD.unit OR NEW.catalog_item_id <> OLD.catalog_item_id THEN
        RAISE EXCEPTION 'order_item_identity_immutable' USING ERRCODE = 'restrict_violation';
    END IF;
    -- م-15: السياسة السارية للسلة، ولقطة الطلبية بعد إرسالها
    IF r = 'customer' AND (TG_OP = 'INSERT' OR NEW.qty > OLD.qty) THEN
        pol := coalesce(o.oversell_policy, (SELECT oversell_policy FROM city_settings WHERE city = o.city));
        IF pol = 'forbid' THEN
            avail := item_available_qty(NEW.catalog_item_id);
            IF NEW.qty > avail THEN
                RAISE EXCEPTION 'qty_exceeds_available: %', avail USING ERRCODE = 'check_violation';
            END IF;
        END IF;
    END IF;
    RETURN NEW;
END $$ LANGUAGE plpgsql;


-- ——— م-7: الإلغاء من المطعم بحسب لقطة الطلبية ——————————————————————————————————
CREATE FUNCTION customer_cancel_allowed(p_from order_status, p_policy cancel_policy) RETURNS boolean AS $$
    SELECT CASE p_policy
        WHEN 'until_collecting' THEN p_from IN ('confirmed', 'assigned')
        WHEN 'anytime' THEN p_from IN ('confirmed', 'assigned', 'collecting', 'partially_delivered')
        ELSE false END
$$ LANGUAGE sql IMMUTABLE;


-- ——— انتقالات الطلبية: الفرع، ووضع المسؤول، واللقطات، والإلغاء ————————————————————
CREATE OR REPLACE FUNCTION trg_order_before() RETURNS trigger AS $$
DECLARE r text; cust customers; loc customer_locations; d drivers; cs city_settings;
        cash numeric; stops int; m customer_members;
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
        NEW.branch_id := resolve_branch(NEW.customer_id, NEW.branch_id);
        NEW.city := cust.city;
        NEW.created_by := actor_id();
        IF NEW.ready_for_owner_at IS NOT NULL THEN
            RAISE EXCEPTION 'derived_field_write: orders.ready_for_owner_at' USING ERRCODE = 'restrict_violation';
        END IF;
        RETURN NEW;
    END IF;

    IF NEW.customer_id <> OLD.customer_id OR NEW.city <> OLD.city OR NEW.created_by <> OLD.created_by
       OR NEW.branch_id <> OLD.branch_id THEN
        RAISE EXCEPTION 'order_identity_immutable' USING ERRCODE = 'restrict_violation';
    END IF;
    IF r NOT IN ('trigger', 'admin', 'system') AND NEW.route_km IS DISTINCT FROM OLD.route_km THEN
        RAISE EXCEPTION 'forbidden_role: route_km' USING ERRCODE = 'insufficient_privilege';
    END IF;
    IF r = 'customer' THEN
        m := require_branch_access(NEW.customer_id, NEW.branch_id);
    END IF;
    -- م-8: «جاهزة لتأكيد الصاحب» تُعلَّم على السلة وحدها، بيد عضو المنشأة
    IF NEW.ready_for_owner_at IS DISTINCT FROM OLD.ready_for_owner_at AND r <> 'trigger' THEN
        IF r <> 'customer' OR OLD.status <> 'draft' THEN
            RAISE EXCEPTION 'forbidden_role: ready_for_owner_at' USING ERRCODE = 'insufficient_privilege';
        END IF;
        IF NEW.ready_for_owner_at IS NOT NULL THEN NEW.ready_for_owner_at := now(); END IF;
    END IF;
    IF NEW.driver_id IS DISTINCT FROM OLD.driver_id AND r <> 'trigger'
       AND NOT (OLD.status = 'confirmed' AND NEW.status = 'assigned') THEN
        RAISE EXCEPTION 'forbidden_driver_change' USING ERRCODE = 'check_violation';
    END IF;
    IF NEW.status IS NOT DISTINCT FROM OLD.status THEN
        RETURN NEW;
    END IF;

    IF NOT order_transition_allowed(OLD.status, NEW.status, r)
       AND NOT (r = 'customer' AND NEW.status = 'cancelled' AND customer_cancel_allowed(OLD.status, OLD.cancel_policy)) THEN
        RAISE EXCEPTION 'invalid_transition: % -> % by %', OLD.status, NEW.status, r
            USING ERRCODE = 'check_violation';
    END IF;
    IF r = 'admin' THEN PERFORM require_admin('orders'); END IF;
    SELECT * INTO cs FROM city_settings WHERE city = NEW.city;

    CASE NEW.status
    WHEN 'placed' THEN
        SELECT * INTO cust FROM customers WHERE id = NEW.customer_id;
        IF cust.status <> 'approved' THEN
            RAISE EXCEPTION 'party_not_approved: customer %', NEW.customer_id USING ERRCODE = 'check_violation';
        END IF;
        IF m.role = 'purchaser' AND cust.purchaser_mode = 'owner_confirms' THEN
            RAISE EXCEPTION 'owner_confirmation_required' USING ERRCODE = 'insufficient_privilege';
        END IF;
        SELECT * INTO loc FROM customer_locations WHERE id = NEW.branch_id;
        IF NOT loc.active OR loc.status <> 'approved' THEN
            RAISE EXCEPTION 'branch_not_approved: %', NEW.branch_id USING ERRCODE = 'check_violation';
        END IF;
        NEW.location_id := loc.id; NEW.dest_lat := loc.lat; NEW.dest_lng := loc.lng;
        NEW.dest_address := loc.address_text; NEW.zone_id := loc.zone_id;
        NEW.area_id := area_for_point(NEW.city, loc.lat, loc.lng);
        NEW.collection_mode := cs.collection_mode;
        -- اللقطات: ما يتغيّر بعد الآن في الإعدادات لا يمسّ هذه الطلبية
        NEW.cancel_policy := cs.cancel_policy;
        NEW.oversell_policy := cs.oversell_policy;
        NEW.pickup_proof_required := cs.pickup_proof_required;
        NEW.cogs_method := current_cogs_method(NEW.city);
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
        IF cs.driver_cash_cap IS NULL THEN PERFORM setting_missing(NEW.city, 'driver_cash_cap'); END IF;
        cash := ledger_balance('driver_cash', NEW.city, d.id);
        IF cash > cs.driver_cash_cap THEN
            RAISE EXCEPTION 'driver_cash_cap_exceeded: % > %', cash, cs.driver_cash_cap
                USING ERRCODE = 'check_violation';
        END IF;
        IF r <> 'trigger' THEN
            IF cs.driver_pay_base IS NULL OR cs.driver_pay_per_stop IS NULL OR cs.driver_pay_per_km IS NULL THEN
                PERFORM setting_missing(NEW.city, 'driver_pay_formula');
            END IF;
            IF NEW.route_km IS NULL THEN
                RAISE EXCEPTION 'route_km_missing: order %', NEW.id USING ERRCODE = 'check_violation';
            END IF;
            SELECT count(*) INTO stops FROM pickup_stops WHERE order_id = NEW.id AND status <> 'cancelled';
            NEW.driver_pay := round(cs.driver_pay_base + cs.driver_pay_per_stop * stops
                                    + cs.driver_pay_per_km * NEW.route_km, 3);
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

-- م-16: الرسم من حيّ الفرع أو منطقته المرسومة. تعارضهما قرار ينتظر المالك (م-25): يتوقف ولا يُختار.
CREATE OR REPLACE FUNCTION order_fee(p_order bigint) RETURNS numeric AS $$
DECLARE o orders; cs city_settings; z_fee numeric; a_fee numeric;
BEGIN
    SELECT * INTO o FROM orders WHERE id = p_order;
    SELECT * INTO cs FROM city_settings WHERE city = o.city;
    IF cs.fee_mode IS NULL THEN PERFORM setting_missing(o.city, 'fee_mode'); END IF;
    IF cs.free_delivery_threshold IS NOT NULL AND o.subtotal >= cs.free_delivery_threshold THEN
        RETURN 0;
    END IF;
    IF cs.fee_mode = 'flat' THEN
        RETURN cs.delivery_fee_flat;
    END IF;
    IF o.zone_id IS NOT NULL THEN
        SELECT z.fee INTO z_fee FROM delivery_zones z WHERE z.id = o.zone_id AND z.active;
        IF z_fee IS NULL THEN
            RAISE EXCEPTION 'zone_inactive: %', o.zone_id USING ERRCODE = 'check_violation';
        END IF;
    END IF;
    IF o.area_id IS NOT NULL THEN
        SELECT a.fee INTO a_fee FROM delivery_areas a WHERE a.id = o.area_id AND a.active;
    END IF;
    IF z_fee IS NULL AND a_fee IS NULL THEN
        RAISE EXCEPTION 'zone_missing: order %', p_order USING ERRCODE = 'check_violation';
    END IF;
    IF z_fee IS NOT NULL AND a_fee IS NOT NULL AND z_fee <> a_fee THEN
        RAISE EXCEPTION 'zone_conflict: neighborhood fee % vs drawn area fee % (owner decision M-25)', z_fee, a_fee
            USING ERRCODE = 'check_violation';
    END IF;
    RETURN coalesce(z_fee, a_fee);
END $$ LANGUAGE plpgsql;

-- الإلغاء بعد بدء الجمع: البضاعة المستلمة من المورد مستحقة له، وما سُلِّم للمطعم يُقيَّد عليه
-- بسعره المحجوز؛ والمالك يقرر المسترد من شاشة النزاع (م-7، م-10).
CREATE FUNCTION post_cancellation(p_order bigint) RETURNS void AS $$
DECLARE o orders; cost record; lines jsonb := '[]'::jsonb; sold numeric;
BEGIN
    SELECT * INTO o FROM orders WHERE id = p_order;
    FOR cost IN
        SELECT s.source, s.supplier_id, s.warehouse_id, sum(round(l.collected_qty * c.unit_cost, 3)) AS amount
          FROM pickup_stop_lines l JOIN pickup_stops s ON s.id = l.stop_id
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
    SELECT coalesce(sum(round(delivered_qty * unit_price, 3)), 0) INTO sold
      FROM order_items WHERE order_id = p_order AND delivered_qty > 0;
    IF sold > 0 THEN
        lines := lines || jsonb_build_array(
            jsonb_build_array(ledger_account('customer_receivable', o.city, o.customer_id), sold),
            jsonb_build_array(ledger_account('sales_revenue', o.city), -sold));
    END IF;
    IF jsonb_array_length(lines) > 0 THEN
        PERFORM ledger_post('cancellation', o.city, 'إلغاء بعد بدء الجمع', lines, p_order => p_order);
    END IF;
END $$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION trg_order_after() RETURNS trigger AS $$
DECLARE cs city_settings; l record; bad bigint;
BEGIN
    IF TG_OP = 'UPDATE' AND NEW.ready_for_owner_at IS NOT NULL AND OLD.ready_for_owner_at IS NULL THEN
        INSERT INTO notifications (user_id, kind, order_id, title, body)
        SELECT m.user_id, 'order_awaiting_owner', NEW.id, 'سلة جاهزة لتأكيدك',
               (SELECT name FROM customer_locations WHERE id = NEW.branch_id)
          FROM customer_members m WHERE m.customer_id = NEW.customer_id AND m.role = 'owner';
    END IF;
    IF TG_OP = 'UPDATE' AND NEW.status IS NOT DISTINCT FROM OLD.status THEN RETURN NULL; END IF;
    INSERT INTO order_status_events (order_id, from_status, to_status, actor_role, actor_id, reason)
    VALUES (NEW.id, CASE WHEN TG_OP = 'UPDATE' THEN OLD.status END, NEW.status, writer_role(),
            actor_id(), CASE WHEN NEW.status = 'cancelled' THEN NEW.cancel_reason END);
    IF TG_OP = 'INSERT' THEN RETURN NULL; END IF;

    IF NEW.status = 'placed' THEN
        UPDATE order_items oi SET unit_price = ci.sale_price
          FROM catalog_items ci
         WHERE oi.order_id = NEW.id AND ci.id = oi.catalog_item_id;
        IF EXISTS (SELECT 1 FROM order_items oi JOIN catalog_items ci ON ci.id = oi.catalog_item_id
                    WHERE oi.order_id = NEW.id AND (ci.visibility <> 'visible' OR NOT ci.is_available)) THEN
            RAISE EXCEPTION 'item_not_orderable_at_place' USING ERRCODE = 'check_violation';
        END IF;
        SELECT oi.catalog_item_id INTO bad FROM order_items oi JOIN catalog_items ci ON ci.id = oi.catalog_item_id
         WHERE oi.order_id = NEW.id AND ci.below_cost LIMIT 1;
        IF bad IS NOT NULL THEN
            RAISE EXCEPTION 'item_below_cost: %', bad USING ERRCODE = 'check_violation';
        END IF;
        IF NEW.oversell_policy = 'forbid' THEN
            SELECT oi.catalog_item_id INTO bad FROM order_items oi
             WHERE oi.order_id = NEW.id AND oi.qty > item_available_qty(oi.catalog_item_id) LIMIT 1;
            IF bad IS NOT NULL THEN
                RAISE EXCEPTION 'qty_exceeds_available: item %', bad USING ERRCODE = 'check_violation';
            END IF;
        END IF;
        IF NOT EXISTS (SELECT 1 FROM order_items WHERE order_id = NEW.id) THEN
            RAISE EXCEPTION 'order_empty' USING ERRCODE = 'check_violation';
        END IF;
        PERFORM refresh_order_totals(NEW.id);
        PERFORM check_min_order(NEW.id);
        SELECT * INTO cs FROM city_settings WHERE city = NEW.city;
        IF cs.auto_confirm_max_amount IS NOT NULL
           AND (SELECT total FROM orders WHERE id = NEW.id) <= cs.auto_confirm_max_amount THEN
            UPDATE orders SET status = 'confirmed' WHERE id = NEW.id;
        END IF;
    ELSIF NEW.status = 'confirmed' AND OLD.status = 'placed' THEN
        PERFORM build_pickup_plan(NEW.id);
        PERFORM refresh_plan_complete(NEW.id);
        -- م-15 «مسموح»: المخطط ناقص = لا مورد يكفي، فيُبلَّغ المالك ليكمله
        IF NOT (SELECT plan_complete FROM orders WHERE id = NEW.id) THEN
            PERFORM notify_owners('plan_short', 'مخطط استلام ناقص', 'الطلبية #' || NEW.id || ': لا مصدر يكفي الكمية',
                                  jsonb_build_object('order_id', NEW.id), NEW.id);
        END IF;
    ELSIF NEW.status = 'confirmed' AND OLD.status = 'assigned' THEN
        UPDATE driver_pay_offers SET status = 'withdrawn'
         WHERE order_id = NEW.id AND status IN ('pending', 'accepted');
    ELSIF NEW.status = 'delivered' THEN
        PERFORM post_delivery(NEW.id);
    ELSIF NEW.status = 'cancelled' THEN
        IF OLD.status IN ('collecting', 'partially_delivered') THEN
            PERFORM post_cancellation(NEW.id);
            IF NEW.cancelled_by_role = 'customer' THEN
                INSERT INTO disputes (order_id, opened_by_role, opened_by, kind, description)
                VALUES (NEW.id, 'customer', actor_id(), 'other',
                        'إلغاء من المطعم بعد بدء الجمع — يقرر المالك المسترد');
            END IF;
        END IF;
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


-- ——— م-9: كل قيد يحمل الفرع؛ حساب العميل على مستوى المنشأة ——————————————————————
ALTER TABLE ledger_transactions ADD COLUMN branch_id bigint REFERENCES customer_locations(id);   -- ◆
UPDATE ledger_transactions t SET branch_id = o.branch_id FROM orders o WHERE o.id = t.order_id;
CREATE FUNCTION trg_txn_branch() RETURNS trigger AS $$
BEGIN
    NEW.branch_id := CASE WHEN NEW.order_id IS NOT NULL
                          THEN (SELECT branch_id FROM orders WHERE id = NEW.order_id) END;
    RETURN NEW;
END $$ LANGUAGE plpgsql;
CREATE TRIGGER b_txn_branch BEFORE INSERT ON ledger_transactions FOR EACH ROW EXECUTE FUNCTION trg_txn_branch();


-- ——— م-22: إثبات الاستلام قبل «تم الجمع» (لقطة الطلبية) ————————————————————————
CREATE FUNCTION trg_stop_proof() RETURNS trigger AS $$
BEGIN
    IF NEW.status IN ('collected', 'short') AND OLD.status = 'pending' AND NEW.source = 'supplier'
       AND (SELECT pickup_proof_required FROM orders WHERE id = NEW.order_id)
       AND NOT EXISTS (SELECT 1 FROM pickup_handovers WHERE stop_id = NEW.id) THEN
        RAISE EXCEPTION 'pickup_proof_required: stop %', NEW.id USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
END $$ LANGUAGE plpgsql;
CREATE TRIGGER c_stop_proof BEFORE UPDATE ON pickup_stops FOR EACH ROW EXECUTE FUNCTION trg_stop_proof();


-- ——— م-13: حمولة الطلبية مقابل سعة مركبة السائق ————————————————————————————————
CREATE FUNCTION order_load(p_order bigint, OUT load_kg numeric, OUT weight_complete boolean) AS $$
    -- weight_kg وزن وحدة البيع الواحدة (الكرتونة كاملة، لا القطعة)
    SELECT coalesce(sum(oi.qty * ci.weight_kg), 0), coalesce(bool_and(ci.weight_kg IS NOT NULL), true)
      FROM order_items oi JOIN catalog_items ci ON ci.id = oi.catalog_item_id
     WHERE oi.order_id = p_order
$$ LANGUAGE sql STABLE;

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
       (d.capacity_kg IS NOT NULL AND (order_load(o.id)).load_kg > d.capacity_kg) AS over_capacity
  FROM orders o JOIN customers c ON c.id = o.customer_id
  JOIN customer_locations br ON br.id = o.branch_id
  LEFT JOIN drivers d ON d.id = o.driver_id
 WHERE o.status NOT IN ('draft', 'placed');

CREATE OR REPLACE VIEW v_customer_lists AS
SELECT rl.id, rl.customer_id, rl.name, rl.reminder_days, rl.reminder_time,
       EXISTS (SELECT 1 FROM recurring_list_items li JOIN catalog_items ci ON ci.id = li.catalog_item_id
                WHERE li.list_id = rl.id AND (ci.visibility <> 'visible' OR NOT ci.is_available
                                              OR ci.below_cost)) AS has_unavailable,
       rl.branch_id
  FROM recurring_lists rl;


-- ——— م-20: استعادة كلمة المرور ——————————————————————————————————————————————
ALTER TABLE otp_challenges DROP CONSTRAINT otp_challenges_purpose_check;
ALTER TABLE otp_challenges ADD CONSTRAINT otp_challenges_purpose_check CHECK (purpose IN ('register', 'reset'));
ALTER TABLE otp_challenges DROP CONSTRAINT otp_challenges_channel_check;
ALTER TABLE otp_challenges ADD CONSTRAINT otp_challenges_channel_check
    CHECK (channel IN ('whatsapp', 'sms', 'whatsapp_official', 'whatsapp_linked'));
DROP INDEX otp_register_once;
CREATE UNIQUE INDEX otp_register_once ON otp_challenges (phone, audience)
    WHERE consumed_at IS NOT NULL AND purpose = 'register';

ALTER TABLE app_users ADD COLUMN must_change_password boolean NOT NULL DEFAULT false;

-- سجل كل إعادة تعيين: من، ومتى، وبأي طريقة. لا تجزئة فيه.
CREATE TABLE password_reset_events (
    id         bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    user_id    bigint NOT NULL REFERENCES app_users(id),
    method     password_reset_method NOT NULL,
    actor_role actor_role NOT NULL,
    actor_id   bigint,
    at         timestamptz NOT NULL DEFAULT now()
);
CREATE TRIGGER a_guard_trigger_only BEFORE INSERT OR UPDATE OR DELETE ON password_reset_events
    FOR EACH ROW EXECUTE FUNCTION guard_trigger_only();
CREATE TRIGGER z_append_only BEFORE UPDATE OR DELETE ON password_reset_events FOR EACH ROW EXECUTE FUNCTION guard_append_only();
CREATE TRIGGER zz_audit AFTER INSERT ON password_reset_events FOR EACH ROW EXECUTE FUNCTION trg_audit();

-- تغيير كلمة مرور قائمة: من اللوحة للمالك وحده، ويُلزم المستخدم بتغييرها عند الدخول.
-- الطريقة من الجلسة: madad.reset_method = otp | self (الافتراضي otp) للفاعل system.
CREATE FUNCTION trg_password_change() RETURNS trigger AS $$
DECLARE meth password_reset_method;
BEGIN
    IF NEW.password_hash IS NOT DISTINCT FROM OLD.password_hash OR OLD.password_hash IS NULL THEN
        IF NEW.must_change_password IS DISTINCT FROM OLD.must_change_password AND writer_role() <> 'system' THEN
            RAISE EXCEPTION 'derived_field_write: app_users.must_change_password' USING ERRCODE = 'restrict_violation';
        END IF;
        RETURN NEW;
    END IF;
    IF actor_role() = 'admin' THEN
        PERFORM require_owner();
        meth := 'admin';
        NEW.must_change_password := true;
    ELSIF actor_role() = 'system' THEN
        meth := coalesce(nullif(current_setting('madad.reset_method', true), ''), 'otp')::password_reset_method;
        NEW.must_change_password := false;
    ELSE
        RAISE EXCEPTION 'forbidden_role: password reset' USING ERRCODE = 'insufficient_privilege';
    END IF;
    NEW.password_set_at := now();
    INSERT INTO password_reset_events (user_id, method, actor_role, actor_id)
    VALUES (NEW.id, meth, actor_role(), actor_id());
    RETURN NEW;
END $$ LANGUAGE plpgsql;
CREATE TRIGGER b_password_change BEFORE UPDATE ON app_users FOR EACH ROW EXECUTE FUNCTION trg_password_change();


-- ——— م-21: سحوبات المالك من الأرباح ——————————————————————————————————————————
CREATE TABLE owner_withdrawals (
    id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    city        text NOT NULL REFERENCES cities(code),
    amount      money_lyd NOT NULL CHECK (amount > 0),
    occurred_on date NOT NULL,
    note        text NOT NULL CHECK (length(btrim(note)) > 0),
    created_by  bigint NOT NULL REFERENCES app_users(id),
    created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE FUNCTION trg_withdrawal_before() RETURNS trigger AS $$
BEGIN
    PERFORM require_owner();
    RETURN NEW;
END $$ LANGUAGE plpgsql;
-- السحب نقدٌ يخرج من الخزينة: لا يتجاوز ما فيها.
CREATE FUNCTION trg_withdrawal_post() RETURNS trigger AS $$
DECLARE cash numeric;
BEGIN
    cash := ledger_balance('treasury', NEW.city);
    IF NEW.amount > cash THEN
        RAISE EXCEPTION 'withdrawal_exceeds_treasury: % > %', NEW.amount, cash USING ERRCODE = 'check_violation';
    END IF;
    PERFORM ledger_post('owner_withdrawal', NEW.city, 'سحب المالك: ' || NEW.note, jsonb_build_array(
        jsonb_build_array(ledger_account('owner_drawings', NEW.city), NEW.amount),
        jsonb_build_array(ledger_account('treasury', NEW.city), -NEW.amount)),
        p_ref_table => 'owner_withdrawals', p_ref_id => NEW.id);
    RETURN NULL;
END $$ LANGUAGE plpgsql;
CREATE TRIGGER b_withdrawal BEFORE INSERT ON owner_withdrawals FOR EACH ROW EXECUTE FUNCTION trg_withdrawal_before();
CREATE TRIGGER withdrawal_post AFTER INSERT ON owner_withdrawals FOR EACH ROW EXECUTE FUNCTION trg_withdrawal_post();
CREATE TRIGGER z_append_only BEFORE UPDATE OR DELETE ON owner_withdrawals FOR EACH ROW EXECUTE FUNCTION guard_append_only();
CREATE TRIGGER zz_audit AFTER INSERT ON owner_withdrawals FOR EACH ROW EXECUTE FUNCTION trg_audit();


-- ——— م-24: قنوات إرسال الرمز ——————————————————————————————————————————————
CREATE TABLE otp_channels (
    channel    otp_channel_kind PRIMARY KEY,
    enabled    boolean NOT NULL DEFAULT true,
    position   int NOT NULL CHECK (position >= 1),
    updated_by bigint REFERENCES app_users(id),
    updated_at timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT otp_channel_position_unique UNIQUE (position) DEFERRABLE INITIALLY DEFERRED
);
INSERT INTO otp_channels (channel, position) VALUES ('whatsapp_official', 1), ('whatsapp_linked', 2), ('sms', 3);

CREATE FUNCTION trg_otp_channel_before() RETURNS trigger AS $$
BEGIN
    IF writer_role() NOT IN ('trigger', 'system') THEN
        IF TG_OP <> 'UPDATE' THEN
            RAISE EXCEPTION 'otp_channels_fixed: the three channels are built in' USING ERRCODE = 'restrict_violation';
        END IF;
        PERFORM require_admin('settings');
    END IF;
    IF TG_OP = 'UPDATE' THEN
        NEW.updated_by := actor_id(); NEW.updated_at := now();
    END IF;
    RETURN coalesce(NEW, OLD);
END $$ LANGUAGE plpgsql;
CREATE TRIGGER b_otp_channel BEFORE INSERT OR UPDATE OR DELETE ON otp_channels
    FOR EACH ROW EXECUTE FUNCTION trg_otp_channel_before();
-- SMS الاحتياطي الأخير دائماً — يُفحص عند الإيداع (يُعاد ترتيب القناتين في حركة واحدة)
CREATE FUNCTION trg_sms_last() RETURNS trigger AS $$
BEGIN
    IF (SELECT position FROM otp_channels WHERE channel = 'sms') <> (SELECT max(position) FROM otp_channels) THEN
        RAISE EXCEPTION 'sms_must_be_last' USING ERRCODE = 'check_violation';
    END IF;
    RETURN NULL;
END $$ LANGUAGE plpgsql;
CREATE CONSTRAINT TRIGGER sms_last AFTER INSERT OR UPDATE ON otp_channels DEFERRABLE INITIALLY DEFERRED
    FOR EACH ROW EXECUTE FUNCTION trg_sms_last();
CREATE TRIGGER zz_audit AFTER INSERT OR UPDATE OR DELETE ON otp_channels FOR EACH ROW EXECUTE FUNCTION trg_audit('channel');

-- كل محاولة إرسال مسجّلة؛ الفشل يُبلغ المالك.
CREATE TABLE otp_deliveries (
    id           bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    challenge_id bigint NOT NULL REFERENCES otp_challenges(id),
    channel      otp_channel_kind NOT NULL,
    ok           boolean NOT NULL,
    error        text,
    at           timestamptz NOT NULL DEFAULT now(),
    CHECK (ok = (error IS NULL))
);
CREATE FUNCTION trg_otp_delivery_after() RETURNS trigger AS $$
BEGIN
    IF NOT NEW.ok THEN
        PERFORM notify_owners('otp_channel_failed', 'تعذّر إرسال رمز عبر قناة',
                              NEW.channel || ': ' || NEW.error,
                              jsonb_build_object('channel', NEW.channel, 'challenge_id', NEW.challenge_id));
    END IF;
    RETURN NULL;
END $$ LANGUAGE plpgsql;
CREATE TRIGGER otp_delivery_after AFTER INSERT ON otp_deliveries FOR EACH ROW EXECUTE FUNCTION trg_otp_delivery_after();
CREATE TRIGGER z_append_only BEFORE UPDATE OR DELETE ON otp_deliveries FOR EACH ROW EXECUTE FUNCTION guard_append_only();


-- ——— سجل الكتّاب ——————————————————————————————————————————————————————
INSERT INTO derived_fields (table_name, column_name, writer, source) VALUES
 ('catalog_items', 'below_cost',             'refresh_cost_guard', 'sale_price < item_cost_ref (م-6)'),
 ('orders', 'area_id',                       'trg_order_before', 'لقطة المنطقة المرسومة عند placed (م-16)'),
 ('orders', 'cancel_policy',                 'trg_order_before', 'لقطة city_settings عند placed (م-7)'),
 ('orders', 'oversell_policy',               'trg_order_before', 'لقطة city_settings عند placed (م-15)'),
 ('orders', 'pickup_proof_required',         'trg_order_before', 'لقطة city_settings عند placed (م-22)'),
 ('orders', 'cogs_method',                   'trg_order_before', 'current_cogs_method عند placed (م-12)'),
 ('orders', 'ready_for_owner_at',            'trg_order_before', 'لحظة تعليم المسؤول (م-8)'),
 ('stock_movements', 'cost_method',          'trg_stock_movement_before', 'طريقة الطلبية أو السارية (م-12)'),
 ('stock_layers', 'qty_left',                'trg_stock_movement_apply', 'الأقدم أولاً'),
 ('ledger_transactions', 'branch_id',        'trg_txn_branch', 'فرع الطلبية (م-9)'),
 ('cogs_method_periods', 'effective_from',   'trg_cogs_period_before', 'لحظة التسجيل'),
 ('customer_locations', 'reviewed_by',       'trg_branch_before / trg_customer_approved_branches', 'اعتماد الفرع'),
 ('app_users', 'must_change_password',       'trg_password_change', 'إعادة التعيين من اللوحة (م-20)');
