"""إرسال رمز التحقق (م-14، م-23، م-24).

القنوات الثلاث بترتيب المالك في otp_channels (الابتدائي: واتساب الرسمي، ثم الرقم العادي، ثم SMS
احتياطياً أخيراً). قناة معطّلة أو غير مضبوطة تُتخطّى؛ قناة فشلت أو حُظرت تُسجَّل في otp_deliveries
فيُبلَّغ المالك (مشغّل في القاعدة) ويُنتقل للتالية. كل محاولة تُودَع في حركتها، فلا يمحوها رفضٌ لاحق.

«console» للتطوير والاختبار وحده (يمنعه Settings في الإنتاج): الرمز في ذاكرة التطبيق وفي السجل.
"""
from __future__ import annotations

import logging

from fastapi import FastAPI

from app.core.errors import ApiError
from app.services.otp.providers import Provider, ProviderError, configured

log = logging.getLogger("madad.otp")


async def channel_order(app: FastAPI) -> list[tuple[str, bool]]:
    async with app.state.db.tx("system") as t:
        return [(r["channel"], r["enabled"]) for r in await t.all(
            "SELECT channel::text AS channel, enabled FROM otp_channels ORDER BY position")]


async def send(app: FastAPI, *, challenge_id: int, phone: str, audience: str, code: str,
               providers: dict[str, Provider | None] | None = None) -> str:
    """يعيد القناة التي وصل بها الرمز، أو يرفع otp_channel_unavailable."""
    mode = app.state.settings.otp_sender
    if mode == "console":
        if app.state.settings.env not in ("development", "test"):   # حارس ثانٍ عند الإرسال
            raise ApiError(503, "otp_channel_unavailable")
        app.state.otp_outbox.append({"phone": phone, "audience": audience, "code": code, "channel": "whatsapp"})
        log.warning("DEV OTP %s/%s: %s", audience, phone, code)
        return "whatsapp"
    if mode != "channels":
        raise ApiError(503, "otp_channel_unavailable")
    for channel, enabled in await channel_order(app):
        if not enabled:
            continue
        provider = (providers or {}).get(channel) if providers is not None else configured(channel)
        if provider is None:
            continue
        try:
            await provider.send(phone, code)
        except (ProviderError, Exception) as exc:  # noqa: BLE001 — أي سقوط للمزوّد فشلٌ للقناة لا للطلب
            async with app.state.db.tx("system") as t:
                await t.run("INSERT INTO otp_deliveries (challenge_id, channel, ok, error) "
                            "VALUES (:c, CAST(:ch AS otp_channel_kind), false, :e)",
                            c=challenge_id, ch=channel, e=str(exc)[:300] or exc.__class__.__name__)
            continue
        async with app.state.db.tx("system") as t:
            await t.run("INSERT INTO otp_deliveries (challenge_id, channel, ok) "
                        "VALUES (:c, CAST(:ch AS otp_channel_kind), true)", c=challenge_id, ch=channel)
            await t.run("UPDATE otp_challenges SET channel = :ch WHERE id = :c", c=challenge_id, ch=channel)
        return channel
    raise ApiError(503, "otp_channel_unavailable")


async def status(app: FastAPI) -> list[dict]:
    """للوحة: كل قناة بترتيبها وتفعيلها وهل هي مضبوطة (بلا أي قيمة سرية)."""
    return [{"channel": ch, "enabled": en, "configured": configured(ch) is not None}
            for ch, en in await channel_order(app)]
