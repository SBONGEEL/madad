-- نزول 0016: عكس الترتيب. قيمتا admin_permission تبقيان (PostgreSQL لا يحذف قيمة من تعداد)، وتُسحب كل منحة لهما.
DROP TRIGGER backup_download_logged ON backup_downloads;
DROP FUNCTION trg_backup_download_logged();
DROP TABLE backup_requests;
DROP FUNCTION trg_backup_request_logged();
DROP FUNCTION trg_backup_request_before();
DROP TABLE backup_access_log;
DROP FUNCTION trg_backup_access_before();
ALTER TABLE backup_runs DROP CONSTRAINT backup_runs_kind_check;
ALTER TABLE backup_runs ADD CONSTRAINT backup_runs_kind_check CHECK (kind IN ('daily', 'weekly')) NOT VALID;
DROP TRIGGER c_backup_permission_grant ON admin_permissions;
DROP FUNCTION trg_backup_permission_grant();
SELECT set_config('madad.actor_role', 'system', true);
DELETE FROM admin_permissions WHERE permission::text IN ('backups_run', 'backups_view');
