"""عالم الاختبار نفسه (tests/db/world.py) مع طلبية حيّة، وكلمات مرور للجماهير الأربعة،
ثم دخول حقيقي عبر /api/auth لكل جمهور. الرموز من المسار الحقيقي لا مصنوعة يدوياً.
"""
from __future__ import annotations

from dataclasses import dataclass
from functools import lru_cache

from app.core.security import hash_password
from tests.db.world import World, act, build, collect_all, confirm_and_assign, draft, place

PASSWORD = "madad-test-2026"
PHONES = {"admin": "+218910000001", "customer": "+218910000002", "supplier": "+218910000003",
          "driver": "+218910000004"}


@lru_cache
def _hash() -> str:
    return hash_password(PASSWORD)


@dataclass
class Live:
    w: World
    order: int
    stop: int
    tokens: dict[str, str]

    def auth(self, audience: str) -> dict[str, str]:
        return {"Authorization": f"Bearer {self.tokens[audience]}"}


async def set_passwords(db) -> None:
    await act(db, "system")
    await db.execute("UPDATE app_users SET phone_verified_at = now(), password_hash = $1, password_set_at = now()",
                     _hash())


async def login(client, audience: str) -> dict:
    r = await client.post(f"/api/auth/{audience}/login", json={"phone": PHONES[audience], "password": PASSWORD})
    assert r.status_code == 200, r.text
    return r.json()


async def live_world(db, client, *, collected: bool = True) -> Live:
    """collected=False يترك نقطة الاستلام معلّقة لاختبار إثبات الاستلام (م-3)."""
    w = await build(db)
    oid = await draft(db, w)
    await place(db, w, oid)
    await confirm_and_assign(db, w, oid)
    if collected:
        await collect_all(db, w, oid)
        await act(db, "driver", w.drv_user)
        bid = await db.fetchval("INSERT INTO order_batches (order_id, seq) VALUES ($1, 1) RETURNING id", oid)
        await db.execute("INSERT INTO order_batch_lines (batch_id, order_item_id, qty) "
                         "SELECT $1, id, qty FROM order_items WHERE order_id = $2", bid, oid)
        await db.execute("UPDATE order_batches SET status = 'notified' WHERE id = $1", bid)
    else:
        await act(db, "driver", w.drv_user)
        await db.execute("UPDATE orders SET status = 'collecting' WHERE id = $1", oid)
    stop = await db.fetchval("SELECT id FROM pickup_stops WHERE order_id = $1 AND source = 'supplier'", oid)
    await set_passwords(db)
    tokens = {a: (await login(client, a))["access_token"] for a in PHONES}
    return Live(w, oid, stop, tokens)
