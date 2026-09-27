"""موجّه اللوحة: وحدة لكل مجموعة شاشات، تحت بادئة واحدة. كل عملية تعلن صلاحيتها (common.P)."""
from __future__ import annotations

from fastapi import APIRouter

from app.api.admin import backups, catalog, core, custody, money, orders, payouts, people, settings, warehouses

router = APIRouter(prefix="/api/admin", tags=["admin"])
for sub in (core, catalog, orders, money, warehouses, people, settings, custody, payouts, backups):
    router.include_router(sub.router)
