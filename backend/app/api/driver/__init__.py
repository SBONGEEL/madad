"""موجّه السائق. يقرأ من v_driver_* وحدها، ولا يرى إلا طلبياته وصفوفه هو."""
from __future__ import annotations

from fastapi import APIRouter

from app.api.driver import core, work

router = APIRouter(prefix="/api/driver", tags=["driver"])
for sub in (core, work):
    router.include_router(sub.router)
