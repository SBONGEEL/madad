-- مَدَد — نزول الترحيلة 0001: كل كائنات المشروع في مخطط madad وحده،
-- وجدول alembic_version في public فيبقى.
DROP SCHEMA IF EXISTS madad CASCADE;
DO $$ BEGIN
    EXECUTE format('ALTER DATABASE %I RESET search_path', current_database());
END $$;
