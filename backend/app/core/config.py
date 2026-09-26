"""إعدادات التشغيل من البيئة. لا قيمة افتراضية لسرّ ولا لقاعدة (§11.7: لا احتياط صامت)."""
from __future__ import annotations

from functools import lru_cache

from pydantic import Field, model_validator
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
    # إرسال الرمز (م-24): «channels» = القنوات الثلاث بترتيب المالك (الافتراضي)؛
    # «console» = الرمز في السجل، للتطوير والاختبار وحده ويستحيل على الإنتاج؛ "" = معطّل.
    otp_sender: str = "channels"

    @model_validator(mode="after")
    def _no_console_in_production(self) -> "Settings":
        if self.otp_sender not in ("channels", "console", ""):
            raise ValueError(f"otp_sender غير معروف: {self.otp_sender}")
        if self.otp_sender == "console" and self.env not in ("development", "test"):
            raise ValueError("otp_sender=console مسموح في development وtest وحدهما، لا في " + self.env)
        return self


@lru_cache
def get_settings() -> Settings:
    return Settings()  # type: ignore[call-arg]
