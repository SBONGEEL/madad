"""أساس موجّهات اللوحة: الصلاحية معلنة في العقد ومفحوصة في القاعدة، والتكاليف لمن يملكها.

كل عملية تُعلن صلاحيتها بـ P("…"): تبعيةٌ تفحصها بـrequire_admin/require_owner في القاعدة قبل
أي شيء آخر، و«x-permission» في OpenAPI يقرؤه الحارس tests/api/test_admin_guards.py.
"""
from __future__ import annotations

from typing import Any

from fastapi import Depends, Request

from app.api.deps import Principal, admin_user
from app.core.db import Tx
from app.core.errors import ApiError


def need(perm: str):
    async def dependency(request: Request, p: Principal = Depends(admin_user)) -> Principal:
        async with request.app.state.db.tx("admin", p.user_id) as t:
            if perm == "owner":
                await t.run("SELECT require_owner()")
            elif perm == "any":
                if not await t.val("SELECT 1 FROM admin_members WHERE user_id = :u", u=p.user_id):
                    raise ApiError(403, "forbidden_role")
            else:
                await t.run("SELECT require_admin(CAST(:p AS admin_permission))", p=perm)
        return p

    return dependency


def P(perm: str) -> dict[str, Any]:
    """وسائط المسار: @router.get("/x", **P("catalog"))."""
    return {"dependencies": [Depends(need(perm))], "openapi_extra": {"x-permission": perm}}


async def sees_costs(t: Tx, user_id: int) -> bool:
    """المالك، أو مشرف بصلاحية «التكاليف»."""
    return bool(await t.val(
        "SELECT EXISTS (SELECT 1 FROM admin_members WHERE user_id = :u AND role = 'owner') "
        "OR EXISTS (SELECT 1 FROM admin_permissions WHERE user_id = :u AND permission = 'costs_view')", u=user_id))


def city(request: Request) -> str:
    return request.app.state.settings.auth_city
