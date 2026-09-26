"""العامل الدوري يستدعي منتجي الإشعارات الثلاثة (العميل والمورد والسائق)، وخطأ أحدهم لا يوقف الآخرين."""
from __future__ import annotations

from app.services import notifier


class _Tx:
    def __init__(self, calls: list[str], fail: str | None) -> None:
        self.calls, self.fail = calls, fail

    async def __aenter__(self):
        return self

    async def __aexit__(self, *a) -> None:
        return None

    async def val(self, sql: str) -> int:
        name = sql.removeprefix("SELECT ").removesuffix("()")
        self.calls.append(name)
        if name == self.fail:
            raise RuntimeError("boom")
        return 2


class _Db:
    def __init__(self, fail: str | None = None) -> None:
        self.calls: list[str] = []
        self.fail = fail

    def tx(self, role: str):
        assert role == "system"
        return _Tx(self.calls, self.fail)


async def test_tick_runs_every_emitter():
    db = _Db()
    assert await notifier.tick(db) == 6
    assert db.calls == ["emit_customer_order_events", "emit_supplier_events", "emit_driver_events"]


async def test_one_failing_emitter_does_not_stop_the_others():
    db = _Db(fail="emit_supplier_events")
    assert await notifier.tick(db) == 4
    assert db.calls == ["emit_customer_order_events", "emit_supplier_events", "emit_driver_events"]
