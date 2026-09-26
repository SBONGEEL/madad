-- نزول 0010: عكس الترتيب.
DROP FUNCTION emit_supplier_events();
DELETE FROM notifier_cursors WHERE name IN ('supplier_order_events', 'supplier_payouts');
DROP FUNCTION supplier_own_due();
DROP VIEW v_supplier_payouts;
DROP VIEW v_supplier_received;
DROP VIEW v_supplier_locations;
DROP VIEW v_supplier_offers;
DROP TRIGGER b_offer_media ON supplier_offer_media;
DROP FUNCTION trg_offer_media_before();
DROP TRIGGER b_pickup_location ON supplier_pickup_locations;
DROP FUNCTION trg_pickup_location_before();
DROP TRIGGER b_supplier_member ON supplier_members;
DROP FUNCTION trg_supplier_member_before();
DROP TRIGGER a_party_insert ON suppliers;
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
    END IF;
    IF NOT ok THEN
        RAISE EXCEPTION 'media_not_owned' USING ERRCODE = 'insufficient_privilege';
    END IF;
    RETURN NEW;
END $$ LANGUAGE plpgsql;
DROP FUNCTION actor_supplier();
