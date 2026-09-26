"""قاعدة الاختبارات تُبنى بالترحيلات نفسها (alembic upgrade head)، لا بنسخة موازية.

قالب واحد يُرحَّل مرة في الجلسة، وكل اختبار ينال قاعدة جديدة منسوخة منه —
فالمشغّلات المؤجّلة تُختبر عند إيداع حقيقي، لا بتراجع يخفيها.
"""
from __future__ import annotations

import os
import subprocess
import sys
import uuid
from pathlib import Path

import asyncpg
import pytest

BACKEND = Path(__file__).resolve().parent.parent
# لا قيمة افتراضية: قاعدة غير مسمّاة لا تُخمَّن، ولا DSN بكلمة مرور في المستودع.
ADMIN_DSN = os.environ.get("MADAD_TEST_ADMIN_DSN") or pytest.exit(
    "MADAD_TEST_ADMIN_DSN غير مضبوط (مثال: postgresql://USER:PASS@HOST:5432/postgres)", returncode=2)
TEMPLATE = "madad_tpl"


def _dsn(db: str) -> str:
    return ADMIN_DSN.rsplit("/", 1)[0] + "/" + db


def alembic(db: str, *args: str) -> None:
    env = dict(os.environ, DATABASE_URL=_dsn(db).replace("postgresql://", "postgresql+asyncpg://"))
    subprocess.run([sys.executable, "-m", "alembic", *args], cwd=BACKEND, env=env, check=True)


async def _recreate(name: str, template: str | None = None) -> None:
    admin = await asyncpg.connect(ADMIN_DSN)
    try:
        await admin.execute(f'DROP DATABASE IF EXISTS "{name}" WITH (FORCE)')
        tpl = f' TEMPLATE "{template}"' if template else ""
        await admin.execute(f'CREATE DATABASE "{name}"{tpl}')
    finally:
        await admin.close()


async def _drop(name: str) -> None:
    admin = await asyncpg.connect(ADMIN_DSN)
    try:
        await admin.execute(f'DROP DATABASE IF EXISTS "{name}" WITH (FORCE)')
    finally:
        await admin.close()


@pytest.fixture(scope="session")
async def template_db():
    await _recreate(TEMPLATE)
    alembic(TEMPLATE, "upgrade", "head")
    yield TEMPLATE
    await _drop(TEMPLATE)


@pytest.fixture
async def db(template_db):
    name = "madad_t_" + uuid.uuid4().hex[:10]
    await _recreate(name, template_db)
    conn = await asyncpg.connect(_dsn(name))
    try:
        yield conn
    finally:
        await conn.close()
        await _drop(name)


@pytest.fixture
def fresh_db_name():
    return "madad_rt_" + uuid.uuid4().hex[:10]
