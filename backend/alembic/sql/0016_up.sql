-- 0016 — قرارات المالك الدفعة الثامنة (§12-ك ٢): صلاحيتا النسخ الاحتياطية.
-- «إنشاء نسخة الآن» و«عرض حالة النسخ» يمنحهما المالك وحده لمشرف بعينه، كلٌّ على حدة. التنزيل والإعدادات
-- والاسترجاع وكلمة السر للمالك وحده دائماً (0015). كل إنشاء أو عرض أو تنزيل يُسجَّل بمن ومتى.

ALTER TYPE admin_permission ADD VALUE IF NOT EXISTS 'backups_run';
ALTER TYPE admin_permission ADD VALUE IF NOT EXISTS 'backups_view';

-- المالك وحده يمنحهما أو يسحبهما (مشرف «المستخدمون» لا يمنحهما ولو ملكهما)
CREATE FUNCTION trg_backup_permission_grant() RETURNS trigger AS $$
BEGIN
    IF writer_role() IN ('trigger', 'system') THEN RETURN coalesce(NEW, OLD); END IF;
    IF coalesce(NEW.permission, OLD.permission)::text IN ('backups_run', 'backups_view')
       OR (TG_OP = 'UPDATE' AND OLD.permission::text IN ('backups_run', 'backups_view')) THEN
        PERFORM require_owner();
    END IF;
    RETURN coalesce(NEW, OLD);
END $$ LANGUAGE plpgsql;
CREATE TRIGGER c_backup_permission_grant BEFORE INSERT OR UPDATE OR DELETE ON admin_permissions
    FOR EACH ROW EXECUTE FUNCTION trg_backup_permission_grant();

-- نسخة يدوية: تُطلب من اللوحة، ويأخذها العامل (الخلفية لا تملك كلمة السر فلا تنسخ بنفسها)
ALTER TABLE backup_runs DROP CONSTRAINT backup_runs_kind_check;
ALTER TABLE backup_runs ADD CONSTRAINT backup_runs_kind_check CHECK (kind IN ('daily', 'weekly', 'manual'));

CREATE TABLE backup_requests (
    id           bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    requested_by bigint NOT NULL REFERENCES app_users(id),
    at           timestamptz NOT NULL DEFAULT now(),
    run_id       bigint UNIQUE REFERENCES backup_runs(id)      -- يملؤه العامل حين يبدأ
);
CREATE UNIQUE INDEX backup_requests_one_pending ON backup_requests ((true)) WHERE run_id IS NULL;

CREATE TABLE backup_access_log (
    id      bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    user_id bigint NOT NULL REFERENCES app_users(id),
    action  text NOT NULL CHECK (action IN ('view', 'create', 'download')),
    run_id  bigint REFERENCES backup_runs(id),
    at      timestamptz NOT NULL DEFAULT now()
);
CREATE TRIGGER z_append_only BEFORE UPDATE OR DELETE ON backup_access_log FOR EACH ROW EXECUTE FUNCTION guard_append_only();

-- العرض: يكتبه صاحب «عرض حالة النسخ» (أو المالك) عن نفسه؛ الإنشاء والتنزيل تكتبهما مشغّلاتهما وحدها
CREATE FUNCTION trg_backup_access_before() RETURNS trigger AS $$
BEGIN
    IF writer_role() = 'trigger' THEN RETURN NEW; END IF;
    IF NEW.action <> 'view' THEN
        RAISE EXCEPTION 'forbidden_role: backup access is logged by its own action' USING ERRCODE = 'insufficient_privilege';
    END IF;
    PERFORM require_admin('backups_view');
    NEW.user_id := actor_id();
    NEW.at := now();
    RETURN NEW;
END $$ LANGUAGE plpgsql;
CREATE TRIGGER b_backup_access BEFORE INSERT ON backup_access_log FOR EACH ROW EXECUTE FUNCTION trg_backup_access_before();

CREATE FUNCTION trg_backup_request_before() RETURNS trigger AS $$
BEGIN
    IF TG_OP = 'INSERT' THEN
        IF writer_role() NOT IN ('trigger', 'system') THEN
            PERFORM require_admin('backups_run');
        END IF;
        IF EXISTS (SELECT 1 FROM backup_runs WHERE status = 'running')
           OR EXISTS (SELECT 1 FROM backup_requests WHERE run_id IS NULL) THEN
            RAISE EXCEPTION 'backup_in_progress' USING ERRCODE = 'check_violation';
        END IF;
        NEW.requested_by := actor_id();
        NEW.at := now();
        NEW.run_id := NULL;
        RETURN NEW;
    END IF;
    -- العامل وحده يربط الطلب بتشغيله، مرة واحدة
    IF writer_role() NOT IN ('system', 'trigger') OR OLD.run_id IS NOT NULL
       OR (NEW.requested_by, NEW.at) IS DISTINCT FROM (OLD.requested_by, OLD.at) THEN
        RAISE EXCEPTION 'append_only: backup_requests' USING ERRCODE = 'insufficient_privilege';
    END IF;
    RETURN NEW;
END $$ LANGUAGE plpgsql;
CREATE TRIGGER b_backup_request BEFORE INSERT OR UPDATE ON backup_requests FOR EACH ROW EXECUTE FUNCTION trg_backup_request_before();
CREATE TRIGGER z_append_only BEFORE DELETE ON backup_requests FOR EACH ROW EXECUTE FUNCTION guard_append_only();

CREATE FUNCTION trg_backup_request_logged() RETURNS trigger AS $$
BEGIN
    INSERT INTO backup_access_log (user_id, action, at) VALUES (NEW.requested_by, 'create', NEW.at);
    RETURN NULL;
END $$ LANGUAGE plpgsql;
CREATE TRIGGER backup_request_logged AFTER INSERT ON backup_requests FOR EACH ROW EXECUTE FUNCTION trg_backup_request_logged();

CREATE FUNCTION trg_backup_download_logged() RETURNS trigger AS $$
BEGIN
    INSERT INTO backup_access_log (user_id, action, run_id, at) VALUES (NEW.user_id, 'download', NEW.run_id, NEW.at);
    RETURN NULL;
END $$ LANGUAGE plpgsql;
CREATE TRIGGER backup_download_logged AFTER INSERT ON backup_downloads FOR EACH ROW EXECUTE FUNCTION trg_backup_download_logged();
