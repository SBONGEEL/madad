-- ═══════════════════════════════════════════════════════════════════════════
-- مَدَد — الترحيلة 0007: حرّاس مستخدمي اللوحة وصلاحياتهم، وتوزيع الإشعار الجماعي (ت-40، ت-41)
-- ═══════════════════════════════════════════════════════════════════════════
SET search_path = madad, public;
SELECT set_config('madad.actor_role', 'system', true);

-- مستخدمو اللوحة: المالك يدير الجميع؛ مشرف بصلاحية المستخدمين يدير المشرفين الآخرين وحدهم.
CREATE FUNCTION trg_admin_member_before() RETURNS trigger AS $$
DECLARE target admin_members;
BEGIN
    IF writer_role() IN ('trigger', 'system') THEN RETURN coalesce(NEW, OLD); END IF;
    PERFORM require_admin('users');
    IF EXISTS (SELECT 1 FROM admin_members WHERE user_id = actor_id() AND role = 'owner') THEN
        RETURN coalesce(NEW, OLD);
    END IF;
    target := coalesce(OLD, NEW);
    IF coalesce(NEW.role, OLD.role) = 'owner' OR target.role = 'owner' THEN
        RAISE EXCEPTION 'forbidden_owner_only: owners are managed by the owner' USING ERRCODE = 'insufficient_privilege';
    END IF;
    IF target.user_id = actor_id() THEN
        RAISE EXCEPTION 'forbidden_self_edit' USING ERRCODE = 'insufficient_privilege';
    END IF;
    RETURN coalesce(NEW, OLD);
END $$ LANGUAGE plpgsql;
CREATE TRIGGER b_admin_member BEFORE INSERT OR UPDATE OR DELETE ON admin_members
    FOR EACH ROW EXECUTE FUNCTION trg_admin_member_before();

-- الصلاحيات: لا يمنح مشرفٌ صلاحية لا يملكها، ولا يعدّل صلاحياته هو.
CREATE FUNCTION trg_admin_permission_before() RETURNS trigger AS $$
DECLARE r record;
BEGIN
    IF writer_role() IN ('trigger', 'system') THEN RETURN coalesce(NEW, OLD); END IF;
    PERFORM require_admin('users');
    IF EXISTS (SELECT 1 FROM admin_members WHERE user_id = actor_id() AND role = 'owner') THEN
        RETURN coalesce(NEW, OLD);
    END IF;
    r := coalesce(NEW, OLD);
    IF r.user_id = actor_id() THEN
        RAISE EXCEPTION 'forbidden_self_edit' USING ERRCODE = 'insufficient_privilege';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM admin_permissions WHERE user_id = actor_id() AND permission = r.permission) THEN
        RAISE EXCEPTION 'forbidden_grant: %', r.permission USING ERRCODE = 'insufficient_privilege';
    END IF;
    RETURN coalesce(NEW, OLD);
END $$ LANGUAGE plpgsql;
CREATE TRIGGER b_admin_permission BEFORE INSERT OR UPDATE OR DELETE ON admin_permissions
    FOR EACH ROW EXECUTE FUNCTION trg_admin_permission_before();

-- ت-41: الإشعار الجماعي يُسجَّل بصلاحية الإشعارات، ويصل كل مستخدم من جمهوره في المدينة.
CREATE FUNCTION trg_broadcast_before() RETURNS trigger AS $$
BEGIN
    PERFORM require_admin('notifications');
    NEW.created_by := actor_id();
    RETURN NEW;
END $$ LANGUAGE plpgsql;
CREATE TRIGGER b_broadcast BEFORE INSERT ON broadcasts FOR EACH ROW EXECUTE FUNCTION trg_broadcast_before();
CREATE TRIGGER z_append_only BEFORE UPDATE OR DELETE ON broadcasts FOR EACH ROW EXECUTE FUNCTION guard_append_only();

CREATE FUNCTION trg_broadcast_fanout() RETURNS trigger AS $$
BEGIN
    IF NEW.audience = 'customer' THEN
        INSERT INTO notifications (user_id, kind, title, body, payload)
        SELECT DISTINCT m.user_id, 'broadcast', NEW.title, NEW.body, jsonb_build_object('broadcast_id', NEW.id)
          FROM customer_members m JOIN customers c ON c.id = m.customer_id
         WHERE c.city = NEW.city AND c.status = 'approved';
    ELSE
        INSERT INTO notifications (user_id, kind, title, body, payload)
        SELECT d.user_id, 'broadcast', NEW.title, NEW.body, jsonb_build_object('broadcast_id', NEW.id)
          FROM drivers d WHERE d.city = NEW.city AND d.status = 'approved';
    END IF;
    RETURN NULL;
END $$ LANGUAGE plpgsql;
CREATE TRIGGER broadcast_fanout AFTER INSERT ON broadcasts FOR EACH ROW EXECUTE FUNCTION trg_broadcast_fanout();
CREATE TRIGGER zz_audit AFTER INSERT ON broadcasts FOR EACH ROW EXECUTE FUNCTION trg_audit();

INSERT INTO derived_fields (table_name, column_name, writer, source) VALUES
 ('broadcasts', 'created_by', 'trg_broadcast_before', 'الجلسة');
