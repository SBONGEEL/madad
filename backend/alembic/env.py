"""بيئة Alembic لمَدَد — غير متزامنة (asyncpg) كما في رَفّ.

لا نماذج SQLAlchemy بعد: المخطط يُكتب SQL صريحاً في alembic/sql/. حين تُضاف
النماذج في جزء الخلفية يصير target_metadata = Base.metadata ويدخل
`alembic check` في الـCI.
"""
from __future__ import annotations

import asyncio
import os
from logging.config import fileConfig

from alembic import context
from sqlalchemy import pool
from sqlalchemy.engine import Connection
from sqlalchemy.ext.asyncio import create_async_engine

config = context.config
if config.config_file_name is not None:
    fileConfig(config.config_file_name)

target_metadata = None


def _database_url() -> str:
    url = os.environ.get("DATABASE_URL")
    if not url:
        # لا احتياط صامت: قاعدة غير مسمّاة لا تُخمَّن.
        raise RuntimeError("DATABASE_URL غير مضبوط")
    return url


def run_migrations_offline() -> None:
    context.configure(url=_database_url(), target_metadata=target_metadata, literal_binds=True)
    with context.begin_transaction():
        context.run_migrations()


def _run(connection: Connection) -> None:
    context.configure(connection=connection, target_metadata=target_metadata)
    with context.begin_transaction():
        context.run_migrations()


async def run_migrations_online() -> None:
    engine = create_async_engine(_database_url(), poolclass=pool.NullPool)
    async with engine.connect() as connection:
        await connection.run_sync(_run)
    await engine.dispose()


if context.is_offline_mode():
    run_migrations_offline()
else:
    asyncio.run(run_migrations_online())
