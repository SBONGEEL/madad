"""العامل الدوري للإشعارات (§7): يحوّل سجل الحالات إلى إشعارات العميل بمؤشر في القاعدة
(emit_customer_order_events)، فلا تكرار ولا فوات مهما أُعيد تشغيله. الإرسال الفوري (FCM) يضاف هنا
حين يضبط المالك مفتاحه (قائمة ما يفعله المالك بيده).
"""
from __future__ import annotations

import asyncio
import logging

log = logging.getLogger("madad.notifier")


async def tick(db) -> int:
    async with db.tx("system") as t:
        return await t.val("SELECT emit_customer_order_events()")


async def run(db, interval: float) -> None:
    while True:
        try:
            n = await tick(db)
            if n:
                log.info("notifier: %s إشعاراً", n)
        except Exception:  # noqa: BLE001 — عامل دوري لا يسقط بخطأ حركة واحدة؛ يُسجَّل ويُعاد
            log.exception("notifier tick failed")
        await asyncio.sleep(interval)
