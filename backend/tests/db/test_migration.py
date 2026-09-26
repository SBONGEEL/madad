"""upgrade/downgrade مقيسان: نزول كامل ثم صعود على قاعدة نظيفة، والنتيجة
مطابقة للقالب (نفس الجداول والمشغّلات والدوال)."""
from __future__ import annotations

import asyncpg

from tests.conftest import _drop, _dsn, _recreate, alembic

INVENTORY = """
SELECT (SELECT count(*) FROM pg_tables WHERE schemaname = 'madad') AS tables,
       (SELECT count(*) FROM pg_views WHERE schemaname = 'madad') AS views,
       (SELECT count(*) FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid
          JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'madad' AND NOT t.tgisinternal) AS triggers,
       (SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
         WHERE n.nspname = 'madad') AS functions
"""


async def test_downgrade_then_upgrade_roundtrip(template_db, fresh_db_name):
    await _recreate(fresh_db_name)
    try:
        alembic(fresh_db_name, "upgrade", "head")
        c = await asyncpg.connect(_dsn(fresh_db_name))
        before = dict(await c.fetchrow(INVENTORY))
        await c.close()
        assert before["tables"] > 40 and before["triggers"] > 60

        alembic(fresh_db_name, "downgrade", "base")
        c = await asyncpg.connect(_dsn(fresh_db_name))
        assert await c.fetchval("SELECT count(*) FROM pg_namespace WHERE nspname = 'madad'") == 0
        await c.close()

        alembic(fresh_db_name, "upgrade", "head")
        c = await asyncpg.connect(_dsn(fresh_db_name))
        assert dict(await c.fetchrow(INVENTORY)) == before
        await c.close()
    finally:
        await _drop(fresh_db_name)
