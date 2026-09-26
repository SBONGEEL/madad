-- 0013 — وثائق الاعتماد في اللوحة: كل فتح لوثيقة خاصة (هوية، رخصة، سجل، واجهة، صورة نزاع أو استلام)
-- يُسجَّل بمن فتحها ومتى — سجل إلحاق فقط. الوثيقة الخاصة لا تُخدَم إلا عبر هذا الفتح.

CREATE TABLE media_views (
    id        bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    media_id  bigint NOT NULL REFERENCES media_files(id),
    viewed_by bigint NOT NULL REFERENCES app_users(id),
    viewed_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ON media_views (media_id, viewed_at DESC);

CREATE FUNCTION trg_media_view_before() RETURNS trigger AS $$
BEGIN
    IF TG_OP <> 'INSERT' THEN
        RAISE EXCEPTION 'append_only_: media_views' USING ERRCODE = 'restrict_violation';
    END IF;
    IF writer_role() <> 'admin' THEN
        RAISE EXCEPTION 'forbidden_role: private documents are for the panel' USING ERRCODE = 'insufficient_privilege';
    END IF;
    NEW.viewed_by := actor_id();
    NEW.viewed_at := now();
    RETURN NEW;
END $$ LANGUAGE plpgsql;
CREATE TRIGGER b_media_view BEFORE INSERT OR UPDATE OR DELETE ON media_views
    FOR EACH ROW EXECUTE FUNCTION trg_media_view_before();

-- وثائق طرف بانتظار الاعتماد أو معتمد: ما يلزم لقراره، بلا مسار الملف.
CREATE FUNCTION party_documents(p_kind text, p_id bigint) RETURNS TABLE (purpose text, media_id bigint, mime_type text) AS $$
    SELECT x.purpose, x.media_id, m.mime_type
      FROM (SELECT 'facade' AS purpose, facade_media_id AS media_id FROM customers WHERE p_kind = 'customer' AND id = p_id
            UNION ALL SELECT 'commercial_register', cr_media_id FROM customers WHERE p_kind = 'customer' AND id = p_id
            UNION ALL SELECT 'owner_id', owner_id_media_id FROM suppliers WHERE p_kind = 'supplier' AND id = p_id
            UNION ALL SELECT 'commercial_register', cr_media_id FROM suppliers WHERE p_kind = 'supplier' AND id = p_id
            UNION ALL SELECT 'driver_id', id_media_id FROM drivers WHERE p_kind = 'driver' AND id = p_id
            UNION ALL SELECT 'driver_license', license_media_id FROM drivers WHERE p_kind = 'driver' AND id = p_id
            UNION ALL SELECT 'driver_license_back', license_back_media_id FROM drivers WHERE p_kind = 'driver' AND id = p_id
            UNION ALL SELECT 'driver_photo', photo_media_id FROM drivers WHERE p_kind = 'driver' AND id = p_id) x
      JOIN media_files m ON m.id = x.media_id
$$ LANGUAGE sql STABLE;
