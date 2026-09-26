"""موجّه العميل. يقرأ من عروض العميل (v_customer_*) وحدها، ولا يرى إلا منشأته — والمسؤول فرعه (م-9)."""
from __future__ import annotations

from fastapi import APIRouter

from app.api.customer import account, cart, core, lists, orders

router = APIRouter(prefix="/api/customer", tags=["customer"])
for sub in (core, account, cart, orders, lists):
    router.include_router(sub.router)
