"""موجّه المورد. يقرأ من عروض المورد (v_supplier_*) وحدها، ولا يرى إلا صفوف مورده (§2.1)."""
from __future__ import annotations

from fastapi import APIRouter

from app.api.supplier import core, offers, pickups

router = APIRouter(prefix="/api/supplier", tags=["supplier"])
for sub in (core, offers, pickups):
    router.include_router(sub.router)
