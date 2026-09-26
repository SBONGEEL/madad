"""تطبيق حقيقي فوق قاعدة اختبار حقيقية (منسوخة من القالب المرحَّل)، ويُكلَّم عبر HTTP
داخل العملية. لا تزييف للقاعدة ولا للمشغّلات: ما يمرّ هنا يمرّ في الإنتاج.
"""
from __future__ import annotations

import httpx
import pytest

from app.core.config import Settings
from app.main import create_app
from tests.conftest import _dsn

JWT_TEST_SECRET = "test-only-" + "x" * 40  # سرّ اختبار محلي، لا يُستعمل خارج pytest


@pytest.fixture
async def app(db):
    name = await db.fetchval("SELECT current_database()")
    settings = Settings(database_url=_dsn(name).replace("postgresql://", "postgresql+asyncpg://"),
                        jwt_secret=JWT_TEST_SECRET, env="test", otp_sender="console")
    application = create_app(settings)
    yield application
    await application.state.db.close()


@pytest.fixture
async def client(app):
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://madad.test") as c:
        yield c
