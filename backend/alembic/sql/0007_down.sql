-- نزول 0007.
SET search_path = madad, public;
SELECT set_config('madad.actor_role', 'system', true);
DELETE FROM derived_fields WHERE table_name = 'broadcasts' AND column_name = 'created_by';
DROP TRIGGER zz_audit ON broadcasts;
DROP TRIGGER broadcast_fanout ON broadcasts;
DROP FUNCTION trg_broadcast_fanout();
DROP TRIGGER z_append_only ON broadcasts;
DROP TRIGGER b_broadcast ON broadcasts;
DROP FUNCTION trg_broadcast_before();
DROP TRIGGER b_admin_permission ON admin_permissions;
DROP FUNCTION trg_admin_permission_before();
DROP TRIGGER b_admin_member ON admin_members;
DROP FUNCTION trg_admin_member_before();
