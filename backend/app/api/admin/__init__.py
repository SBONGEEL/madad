"""موجّه اللوحة: وحدة لكل مجموعة شاشات، تحت بادئة واحدة. كل عملية تعلن صلاحيتها (common.P)."""
from __future__ import annotations

from fastapi import APIRouter

from app.api.admin import core

router = APIRouter(prefix="/api/admin", tags=["admin"])
for sub in (core,):
    router.include_router(sub.router)
