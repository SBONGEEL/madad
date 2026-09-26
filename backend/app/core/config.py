"""إعدادات التشغيل من البيئة. لا قيمة افتراضية لسرّ ولا لقاعدة (§11.7: لا احتياط صامت)."""
from __future__ import annotations

from functools import lru_cache

from pydantic import Field
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_prefix="MADAD_", extra="ignore")

    database_url: str = Field(description="postgresql+asyncpg://…")
    jwt_secret: str = Field(min_length=32)
    env: str = "production"
    # المدينة التي تُقرأ منها حدود محاولات الدخول (city_settings.login_*) — مدينة واحدة في الإصدار الأول
    auth_city: str = "TIP"
    access_ttl_minutes: int = 15
    refresh_ttl_days: int = 30
    otp_ttl_minutes: int = 5
    ticket_ttl_minutes: int = 15
    # قناة رمز التحقق (م-14): whatsapp أولاً ثم sms. «console» للتطوير والاختبار وحده.
    # غياب القناة يرفض الإرسال برسالة صريحة، ولا يدّعي أنه أرسل.
    otp_sender: str = ""


@lru_cache
def get_settings() -> Settings:
    return Settings()  # type: ignore[call-arg]
