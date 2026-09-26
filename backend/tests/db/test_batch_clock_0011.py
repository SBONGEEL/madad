"""الترحيلة 0011: «لا انطلاق قبل الإشعار» لا تسقط حين ترجع ساعة الخادم.

السبب المقيس في حلقة التشغيل العشرينية (التشغيل 7): departed_at كُتب قبل notified_at بـ1.7 ثانية
لأن ساعة حاوية القاعدة رجعت، فسقط القيد. هنا يُحاكى الرجوع بإشعارٍ مؤرَّخ في المستقبل.
"""
from __future__ import annotations

from tests.db.world import act, build, collect_all, confirm_and_assign, draft, place


async def _notified_batch(db):
    w = await build(db)
    oid = await draft(db, w)
    await place(db, w, oid)
    await confirm_and_assign(db, w, oid)
    await collect_all(db, w, oid)
    await act(db, "driver", w.drv_user)
    bid = await db.fetchval("INSERT INTO order_batches (order_id, seq) VALUES ($1, 1) RETURNING id", oid)
    await db.execute("INSERT INTO order_batch_lines (batch_id, order_item_id, qty) "
                     "SELECT $1, id, qty FROM order_items WHERE order_id = $2", bid, oid)
    await db.execute("UPDATE order_batches SET status = 'notified' WHERE id = $1", bid)
    return w, bid


async def _clock_went_back(db, bid, seconds: int):
    """كأن الساعة رجعت: الإشعار سُجِّل «بعد» ما ستسجله الساعة الآن."""
    await db.execute("ALTER TABLE order_batches DISABLE TRIGGER USER")
    await db.execute(f"UPDATE order_batches SET notified_at = now() + interval '{seconds} seconds' WHERE id = $1", bid)
    await db.execute("ALTER TABLE order_batches ENABLE TRIGGER USER")


async def test_departure_after_a_clock_step_back_keeps_the_order(db):
    w, bid = await _notified_batch(db)
    await _clock_went_back(db, bid, 5)
    await act(db, "driver", w.drv_user)
    await db.execute("UPDATE order_batches SET status = 'departed' WHERE id = $1", bid)
    row = await db.fetchrow("SELECT notified_at, departed_at FROM order_batches WHERE id = $1", bid)
    assert row["departed_at"] >= row["notified_at"]


async def test_departure_without_a_step_back_is_the_real_time(db):
    w, bid = await _notified_batch(db)
    await act(db, "driver", w.drv_user)
    await db.execute("UPDATE order_batches SET status = 'departed' WHERE id = $1", bid)
    assert await db.fetchval("SELECT departed_at > notified_at AND departed_at <= clock_timestamp() "
                             "FROM order_batches WHERE id = $1", bid)
