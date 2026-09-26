"""مَدَد — تطبيق FastAPI. موجّه مستقل لكل جمهور (§11.1): العزل بنيوي لا اتفاقي."""
from __future__ import annotations

import asyncio
from contextlib import asynccontextmanager

from fastapi import FastAPI

from app.api import routers
from app.core import errors
from app.core.config import Settings, get_settings
from app.core.db import Db
from app.services import notifier, pdf
from app.services.media import Store


def create_app(settings: Settings | None = None) -> FastAPI:
    settings = settings or get_settings()

    @asynccontextmanager
    async def lifespan(app: FastAPI):
        # فحص الإقلاع (§14): صورة تُقلع ثم تسقط عند أول إيصال هي ما لا نريده.
        pdf.self_check()
        worker = None
        if settings.notifier_interval > 0 and settings.env != "test":
            worker = asyncio.create_task(notifier.run(app.state.db, settings.notifier_interval))
        yield
        if worker:
            worker.cancel()
        await app.state.db.close()

    app = FastAPI(title="مَدَد — Madad API", version="0.1.0", lifespan=lifespan,
                  docs_url="/api/docs" if settings.env != "production" else None,
                  openapi_url="/api/openapi.json")
    app.state.settings = settings
    app.state.db = Db(settings.database_url)
    app.state.media = Store(settings.media_dir)
    app.state.otp_outbox = []  # قناة «console» وحدها تكتب هنا (تطوير واختبار)
    errors.install(app)
    for router in routers:
        app.include_router(router)

    @app.get("/health", include_in_schema=False)
    async def health() -> dict:
        return {"status": "ok"}

    return app


def __getattr__(name: str):
    # uvicorn app.main:app — يُبنى عند الطلب فلا يُقرأ الإعداد عند الاستيراد في الاختبارات
    if name == "app":
        return create_app()
    raise AttributeError(name)
