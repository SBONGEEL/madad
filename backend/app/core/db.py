"""الوصول إلى القاعدة. كل طلب حركة واحدة، وأول ما فيها تسمية الفاعل.

القواعد في القاعدة (مشغّلات تقرأ madad.actor_role وmadad.actor_id)، فالتطبيق لا
يكتب سطراً قبل أن يقول من يكتبه. set_config(…, true) محلي للحركة: لا يتسرّب
الفاعل إلى طلب آخر يعيد استعمال الاتصال نفسه.
"""
from __future__ import annotations

from contextlib import asynccontextmanager
from typing import Any, AsyncIterator

from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncConnection, AsyncEngine, create_async_engine


class Db:
    def __init__(self, url: str) -> None:
        self.engine: AsyncEngine = create_async_engine(url, pool_pre_ping=True)

    @asynccontextmanager
    async def tx(self, role: str, actor_id: int | None = None) -> AsyncIterator["Tx"]:
        async with self.engine.begin() as conn:
            await conn.execute(
                text("SELECT set_config('madad.actor_role', :r, true), set_config('madad.actor_id', :i, true)"),
                {"r": role, "i": "" if actor_id is None else str(actor_id)})
            yield Tx(conn)

    async def close(self) -> None:
        await self.engine.dispose()


class Tx:
    """غلاف رقيق: SQL صريح بمعاملات مسمّاة، ونتائج قواميس."""

    def __init__(self, conn: AsyncConnection) -> None:
        self.conn = conn

    async def all(self, sql: str, **params: Any) -> list[dict[str, Any]]:
        return [dict(r) for r in (await self.conn.execute(text(sql), params)).mappings().all()]

    async def one(self, sql: str, **params: Any) -> dict[str, Any] | None:
        row = (await self.conn.execute(text(sql), params)).mappings().first()
        return dict(row) if row is not None else None

    async def val(self, sql: str, **params: Any) -> Any:
        return (await self.conn.execute(text(sql), params)).scalar()

    async def run(self, sql: str, **params: Any) -> None:
        await self.conn.execute(text(sql), params)
