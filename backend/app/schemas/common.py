from __future__ import annotations

from pydantic import BaseModel, ConfigDict


class Out(BaseModel):
    """أساس كل مخطط خرج: لا حقل خارج المعلن."""
    model_config = ConfigDict(extra="forbid")


class HandoverOut(Out):
    handed_over: bool
    method: str
