-- نزول 0012: عكس الترتيب.
DROP TRIGGER c_offer_on_proposed ON supplier_offers;
DROP FUNCTION trg_offer_on_proposed();
DROP FUNCTION emit_driver_events();
DELETE FROM notifier_cursors WHERE name IN ('driver_order_events', 'driver_handovers', 'driver_payouts');
DROP VIEW v_driver_settlements;
DROP FUNCTION driver_own_balances();
DROP VIEW v_driver_order_items;
DROP VIEW v_driver_available;
DROP TRIGGER a_party_insert ON drivers;
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
ALTER TABLE drivers DROP COLUMN license_back_media_id;
DROP FUNCTION actor_driver();
