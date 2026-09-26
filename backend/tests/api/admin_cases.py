"""معرّفات مسارات اللوحة وأجسام عمليات الكتابة لحرّاس اللوحة (test_admin_guards).

تُضاف حالة كل عملية كتابة جديدة هنا في الإيداع نفسه الذي يضيفها، وإلا سقط الحارس باسمها.
"""
from __future__ import annotations

from tests.db.world import act


async def path_ids(db, live) -> dict:
    w = live.w
    await act(db, "system")
    return {"order_id": live.order, "stop_id": live.stop, "user_id": w.cust_user, "customer_id": w.customer,
            "supplier_id": w.supplier, "driver_id": w.driver, "item_id": w.item, "product_id": w.product,
            "offer_id": w.offer, "category_id": w.category,
            "branch_id": await db.fetchval("SELECT id FROM customer_locations WHERE customer_id = $1", w.customer)}


WRITES = {
    ("PUT", "/api/admin/settings/visibility"): lambda ids: {"driver_sees_supplier_name": False,
                                                            "customer_sees_driver_name": False,
                                                            "customer_can_call_driver": False},
    ("POST", "/api/admin/capital"): lambda ids: {"kind": "injection", "amount": "1", "occurred_on": "2026-09-26", "note": "x"},
    ("POST", "/api/admin/users/{user_id}/reset-password"): lambda ids: {},
}
