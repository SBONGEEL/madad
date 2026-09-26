"""العامل الدوري للإشعارات (§7): يحوّل سجل الحالات إلى إشعارات العميل بمؤشر في القاعدة
(emit_customer_order_events وemit_supplier_events وemit_driver_events)، فلا تكرار ولا فوات مهما أُعيد تشغيله. الإرسال الفوري (FCM) يضاف هنا
حين يضبط المالك مفتاحه (قائمة ما يفعله المالك بيده).
"""
from __future__ import annotations

import asyncio
import logging

log = logging.getLogger("madad.notifier")


EMITTERS = ("emit_customer_order_events", "emit_supplier_events", "emit_driver_events")


async def tick(db) -> int:
    """كل منتج بحركته: خطأ في أحدها لا يوقف الآخرين ولا يحرّك مؤشره."""
    n = 0
    for fn in EMITTERS:
        try:
            async with db.tx("system") as t:
                n += await t.val(f"SELECT {fn}()")
        except Exception:  # noqa: BLE001
            log.exception("notifier %s failed", fn)
    return n


async def run(db, interval: float) -> None:
    while True:
        try:
            n = await tick(db)
            if n:
                log.info("notifier: %s إشعاراً", n)
        except Exception:  # noqa: BLE001 — عامل دوري لا يسقط بخطأ حركة واحدة؛ يُسجَّل ويُعاد
            log.exception("notifier tick failed")
        await asyncio.sleep(interval)
