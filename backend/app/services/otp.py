"""إرسال رمز التحقق (م-14): واتساب أولاً، ثم SMS إن فشل.

بوابة واتساب لم تُبنَ بعد، ومزوّد SMS بانتظار قرار المالك (م-23). حتى يُضبط أحدهما
يُرفض الإرسال برسالة صريحة (otp_channel_unavailable) ولا يُدّعى أنه أُرسل.
«console» للتطوير والاختبار وحده: يحفظ الرمز في ذاكرة التطبيق ولا يرسل شيئاً.
"""
from __future__ import annotations

from fastapi import FastAPI

from app.core.errors import ApiError


def send(app: FastAPI, *, phone: str, audience: str, code: str) -> str:
    """يعيد القناة التي أُرسل بها."""
    sender = app.state.settings.otp_sender
    if sender == "console":
        app.state.otp_outbox.append({"phone": phone, "audience": audience, "code": code, "channel": "whatsapp"})
        return "whatsapp"
    raise ApiError(503, "otp_channel_unavailable")
