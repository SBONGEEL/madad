from __future__ import annotations

from pydantic import BaseModel, Field

from app.core.security import PASSWORD_MIN
from app.schemas.common import Out

Phone = Field(pattern=r"^\+2189[0-9]{8}$")


class StartIn(BaseModel):
    phone: str = Phone


class StartOut(Out):
    channel: str
    expires_in: int


class VerifyIn(BaseModel):
    phone: str = Phone
    code: str = Field(pattern=r"^[0-9]{6}$")


class TicketOut(Out):
    ticket: str


class CompleteIn(BaseModel):
    ticket: str
    password: str = Field(min_length=PASSWORD_MIN, max_length=128)
    full_name: str = Field(min_length=1, max_length=120)


class LoginIn(BaseModel):
    phone: str = Phone
    password: str = Field(min_length=1, max_length=128)


class RefreshIn(BaseModel):
    refresh_token: str


class TokensOut(Out):
    access_token: str
    refresh_token: str
    token_type: str = "bearer"
