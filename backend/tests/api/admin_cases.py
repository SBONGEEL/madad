"""معرّفات مسارات اللوحة وأجسام عمليات الكتابة لحرّاس اللوحة (test_admin_guards).

تُضاف حالة كل عملية كتابة جديدة هنا في الإيداع نفسه الذي يضيفها، وإلا سقط الحارس باسمها.
"""
from __future__ import annotations

from pathlib import Path

from tests.db.world import act

BACKUP_FILE = "madad-20260927-030000.mdbk"   # نسخة ناجحة محلية في العالم ليُنزّلها المالك (§12-ي ن-3)


async def path_ids(db, live) -> dict:
    w = live.w
    await act(db, "system")
    return {"order_id": live.order, "stop_id": live.stop, "user_id": w.cust_user, "customer_id": w.customer,
            "supplier_id": w.supplier, "driver_id": w.driver, "item_id": w.item, "product_id": w.product,
            "offer_id": w.offer, "category_id": w.category,
            "branch_id": await db.fetchval("SELECT id FROM customer_locations WHERE customer_id = $1", w.customer),
            "order_item_id": await db.fetchval("SELECT id FROM order_items WHERE order_id = $1", live.order),
            "line_id": await db.fetchval("SELECT l.id FROM pickup_stop_lines l JOIN pickup_stops s ON s.id = l.stop_id "
                                         "WHERE s.order_id = $1 LIMIT 1", live.order),
            "dispute_id": await _dispute(db, live),
            "warehouse_id": await db.fetchval("INSERT INTO warehouses (city, name, lat, lng, address_text) "
                                              "VALUES ('TIP', 'الظهرة', 32.89, 13.18, 'الظهرة') RETURNING id"),
            "kind": "customer", "party_id": w.customer, "custody_id": 0, "pay_offer_id": 0, "media_id": w.media,
            "notification_id": await db.fetchval("INSERT INTO notifications (user_id, kind, title, body) VALUES ($1, "
                                                 "'broadcast', 't', 'b') RETURNING id", w.owner),
            "run_id": await _backup(db),
            "zone_id": await db.fetchval("INSERT INTO delivery_zones (city, name_ar, fee) VALUES ('TIP', 'قرقارش', 10) RETURNING id"),
            "area_id": await db.fetchval("INSERT INTO delivery_areas (city, name_ar, fee, polygon) VALUES ('TIP', 'غرب', 15, "
                                         "'[[32.8,13.1],[32.8,13.3],[33.0,13.3]]') RETURNING id")}


async def _backup(db) -> int:
    local = Path("storage/backups")
    local.mkdir(parents=True, exist_ok=True)
    (local / BACKUP_FILE).write_bytes(b"MADADBK1-test")
    return await db.fetchval("INSERT INTO backup_runs (kind, plan, location, status, finished_at, file_name, byte_size, "
                             "sha256, local_ok) VALUES ('daily', 'daily7_weekly12', 'local', 'ok', now(), $1, 13, "
                             "repeat('a', 64), true) RETURNING id", BACKUP_FILE)


async def _dispute(db, live) -> int:
    await act(db, "customer", live.w.cust_user)
    did = await db.fetchval("INSERT INTO disputes (order_id, order_item_id, opened_by_role, opened_by, kind, description) "
                            "SELECT $1, id, 'customer', $2, 'damaged', 'تالف' FROM order_items WHERE order_id = $1 "
                            "LIMIT 1 RETURNING id", live.order, live.w.cust_user)
    await act(db, "system")
    return did


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
    # الطلبيات والمخطط والإسناد والنزاعات
    ("POST", "/api/admin/orders/{order_id}/confirm"): lambda ids: {},
    ("POST", "/api/admin/orders/{order_id}/cancel"): lambda ids: {"reason": "x"},
    ("PATCH", "/api/admin/orders/{order_id}/items/{order_item_id}"): lambda ids: {"qty": "1"},
    ("POST", "/api/admin/orders/{order_id}/plan/lines"): lambda ids: {"order_item_id": ids["order_item_id"],
                                                                       "offer_id": ids["offer_id"], "qty": "1"},
    ("PATCH", "/api/admin/plan/lines/{line_id}"): lambda ids: {"qty": "1"},
    ("DELETE", "/api/admin/plan/lines/{line_id}"): lambda ids: None,
    ("POST", "/api/admin/orders/{order_id}/assign"): lambda ids: {"driver_id": ids["driver_id"], "route_km": "5"},
    ("PUT", "/api/admin/orders/{order_id}/route-km"): lambda ids: {"route_km": "10"},
    ("POST", "/api/admin/orders/{order_id}/unassign"): lambda ids: {},
    ("POST", "/api/admin/disputes/{dispute_id}/resolve"): lambda ids: {"resolution": "no_action"},
    ("POST", "/api/admin/pay-offers/{pay_offer_id}/decide"): lambda ids: {"decision": "reject"},
    ("PUT", "/api/admin/catalog/{item_id}/warehouse-cost"): lambda ids: {"mode": "auto"},
    ("PUT", "/api/admin/settings/area-overlap"): lambda ids: {"rule": "stop"},
    ("POST", "/api/admin/areas/overlap-check"): lambda ids: {"polygon": [["32.8", "13.1"], ["32.8", "13.3"], ["33.0", "13.3"]], "fee": "20"},
    ("PUT", "/api/admin/settings/contact"): lambda ids: {"phone": "+218921112233", "whatsapp": "+218921112233"},
    # المال والمخازن
    ("POST", "/api/admin/drivers/{driver_id}/handover"): lambda ids: {"amount": "1"},
    ("POST", "/api/admin/drivers/{driver_id}/payout"): lambda ids: {"amount": "1"},
    ("PUT", "/api/admin/drivers/{driver_id}/pay-method"): lambda ids: {"pay_method": "periodic"},
    ("POST", "/api/admin/suppliers/{supplier_id}/payout"): lambda ids: {"amount": "1", "period_start": "2026-09-01",
                                                                         "period_end": "2026-09-26"},
    ("POST", "/api/admin/expenses"): lambda ids: {"category": "x", "amount": "1", "spent_on": "2026-09-26"},
    ("POST", "/api/admin/withdrawals"): lambda ids: {"amount": "1", "occurred_on": "2026-09-26", "note": "x"},
    ("POST", "/api/admin/warehouses"): lambda ids: {"name": "b", "lat": "32.9", "lng": "13.1", "address_text": "x"},
    ("POST", "/api/admin/warehouses/{warehouse_id}/movements"): lambda ids: {"kind": "intake", "item_id": ids["item_id"],
                                                                              "qty": "1", "unit_cost": "5"},
    # الاعتمادات والعملاء والمستخدمون والإشعارات والإعدادات والمناطق
    ("POST", "/api/admin/approvals/{kind}/{party_id}"): lambda ids: {"decision": "approve"},
    ("POST", "/api/admin/media/{media_id}/open"): lambda ids: {},
    ("PUT", "/api/admin/customers/{customer_id}/purchaser-mode"): lambda ids: {"purchaser_mode": "direct"},
    ("POST", "/api/admin/admins"): lambda ids: {"phone": "+218910000099", "full_name": "x"},
    ("PUT", "/api/admin/admins/{user_id}/permissions"): lambda ids: {"permissions": []},
    ("POST", "/api/admin/broadcasts"): lambda ids: {"audience": "customer", "title": "t", "body": "b"},
    ("POST", "/api/admin/inbox/{notification_id}/read"): lambda ids: {},
    ("PUT", "/api/admin/settings"): lambda ids: {},
    ("POST", "/api/admin/settings/cogs"): lambda ids: {"method": "average"},
    ("PUT", "/api/admin/settings/otp-channels"): lambda ids: {"order": ["whatsapp_official", "whatsapp_linked", "sms"],
                                                               "enabled": {}},
    ("POST", "/api/admin/zones"): lambda ids: {"name_ar": "x", "fee": "1"},
    ("PUT", "/api/admin/zones/{zone_id}"): lambda ids: {"name_ar": "x", "fee": "1"},
    ("POST", "/api/admin/areas"): lambda ids: {"name_ar": "x", "fee": "1", "polygon": [[1, 1], [1, 2], [2, 2]]},
    ("PUT", "/api/admin/areas/{area_id}"): lambda ids: {"name_ar": "x", "fee": "1", "polygon": [[1, 1], [1, 2], [2, 2]]},
    # §12-ي: دورية أجر السائق وموعد الصرف، ونص الإشعار، والنسخ الاحتياطية، وطول المسار من Mapbox
    ("PUT", "/api/admin/settings/payout"): lambda ids: {"mode": "rolling", "driver_cycle": "weekly"},
    ("PUT", "/api/admin/drivers/{driver_id}/payout"): lambda ids: {"driver_cycle": "daily"},
    ("PUT", "/api/admin/suppliers/{supplier_id}/payout"): lambda ids: {"mode": "rolling"},
    ("PUT", "/api/admin/settings/push-text"): lambda ids: {"mode": "generic"},
    ("PUT", "/api/admin/backups/policy"): lambda ids: {"plan": "daily30", "location": "both"},
    ("POST", "/api/admin/orders/{order_id}/route-km/compute"): lambda ids: {},
    # الأمانة (معتمد في §12-ز)
    ("POST", "/api/admin/custody/{custody_id}/decide"): lambda ids: {"fate": "return_supplier"},
}
