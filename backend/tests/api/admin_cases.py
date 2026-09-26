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
    # الكتالوج والتصنيفات
    ("PUT", "/api/admin/catalog/{item_id}/pricing"): lambda ids: {"mode": "margin_pct", "margin_value": "17.17"},
    ("PATCH", "/api/admin/catalog/{item_id}"): lambda ids: {"visibility": "visible"},
    ("POST", "/api/admin/catalog"): lambda ids: {"product_id": ids["product_id"], "category_id": ids["category_id"],
                                                 "unit": "carton", "unit_size": "12", "name_ar": "طماطم كرتونة"},
    ("POST", "/api/admin/catalog/{item_id}/sources"): lambda ids: {"offer_id": ids["offer_id"], "priority": 2},
    ("DELETE", "/api/admin/catalog/{item_id}/sources/{offer_id}"): lambda ids: None,
    ("POST", "/api/admin/categories"): lambda ids: {"parent_id": ids["category_id"], "name_ar": "فرع", "name_en": "Sub"},
    ("PATCH", "/api/admin/categories/{category_id}"): lambda ids: {"active": True},
    ("POST", "/api/admin/proposals/{product_id}"): lambda ids: {"decision": "reject"},
}
