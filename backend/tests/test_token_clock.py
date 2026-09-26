"""رمز صدر للتوّ لا يُرفض إن رجعت ساعة الخادم قليلاً، وما وراء السماح يُرفض في الاتجاهين.

السبب المقيس: حلقة التشغيل العشرينية أسقطت اختبارات اللوحة بـ401 متقطّع، وسببه
ImmatureSignatureError — «iat» أكبر من «الآن» بثانية بعد رجوع ساعة الحاوية.
"""
from __future__ import annotations

from datetime import timedelta

import jwt
import pytest

from app.core import security

SECRET = "s" * 40


def _shifted(monkeypatch, seconds: float) -> None:
    now = security._now()
    monkeypatch.setattr(security, "_now", lambda: now + timedelta(seconds=seconds))


def test_token_signed_a_moment_ahead_is_accepted(monkeypatch):
    _shifted(monkeypatch, 2)                      # الساعة ترجع ثانيتين بعد التوقيع
    tok = security.sign(SECRET, typ="access", ttl=timedelta(minutes=15), sub="1")
    assert security.read(SECRET, tok, typ="access")["sub"] == "1"


def test_token_from_the_far_future_is_rejected(monkeypatch):
    _shifted(monkeypatch, 120)
    tok = security.sign(SECRET, typ="access", ttl=timedelta(minutes=15), sub="1")
    with pytest.raises(jwt.ImmatureSignatureError):
        security.read(SECRET, tok, typ="access")


def test_expired_beyond_leeway_is_rejected(monkeypatch):
    _shifted(monkeypatch, -120)
    tok = security.sign(SECRET, typ="access", ttl=timedelta(seconds=60), sub="1")
    with pytest.raises(jwt.ExpiredSignatureError):
        security.read(SECRET, tok, typ="access")
