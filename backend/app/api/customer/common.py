"""أساس موجّه العميل: من أنا في منشأتي، وقراءة الطلبية بفرعها (م-9) من القاعدة لا من هنا."""
from __future__ import annotations

from app.core.db import Tx
from app.core.errors import ApiError

MEMBER_SQL = """
SELECT c.id, c.name, c.city, c.status::text AS status, c.kind::text AS kind, c.purchaser_mode::text AS purchaser_mode,
       m.role::text AS role, m.branch_id
  FROM customer_members m JOIN customers c ON c.id = m.customer_id
 WHERE m.user_id = :u ORDER BY c.id LIMIT 1"""


async def member(t: Tx, user_id: int) -> dict:
    """المنشأة ودور المستخدم فيها. بلا منشأة: 404 no_establishment (التسجيل لم يكتمل بعد)."""
    row = await t.one(MEMBER_SQL, u=user_id)
    if row is None:
        raise ApiError(404, "no_establishment")
    return row


async def approved_member(t: Tx, user_id: int) -> dict:
    m = await member(t, user_id)
    if m["status"] != "approved":
        raise ApiError(409, "party_not_approved")
    return m


async def order_access(t: Tx, order_id: int) -> int:
    """customer_order_access في القاعدة: ليست للمنشأة ← 404؛ فرع آخر للمسؤول ← forbidden_branch."""
    oid = await t.val("SELECT customer_order_access(:o)", o=order_id)
    if oid is None:
        raise ApiError(404, "order_not_found")
    return oid
