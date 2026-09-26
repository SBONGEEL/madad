"""حالات حارس التسرّب لجماهير التطبيقات الثلاثة (استثناء 7، 2026-09-27).

كل عملية تحت /api/customer و/api/supplier و/api/driver لها حالة هنا: GET بلا جسم (None)، والكتابة
بجسمها. تُضاف حالة كل عملية جديدة هنا في الإيداع نفسه الذي يضيفها؛ test_audience_cases يُسقط الحارس
إن نقص عدد الحالات عن عدد العمليات لأي جمهور أو زاد.

المعرّفات في المسار من العالم الحيّ؛ معرّف ما لا يوجد فيه (قائمة، فرع) يُستدعى بصفر فتعود الكتابة
بـ404 مفحوصاً جسمها — ومحتواها الفعلي في اختبار النقطة نفسها.
"""
from __future__ import annotations

BRANCH = {"name": "فرع", "lat": "32.9", "lng": "13.2", "address_text": "عنوان"}

CASES = {
    # ——— العميل ———
    ("GET", "/api/customer/branches"): None,
    ("GET", "/api/customer/cart"): None,
    ("GET", "/api/customer/carts/ready"): None,
    ("GET", "/api/customer/catalog"): None,
    ("GET", "/api/customer/catalog/{catalog_item_id}"): None,
    ("GET", "/api/customer/categories"): None,
    ("GET", "/api/customer/lists"): None,
    ("GET", "/api/customer/me"): None,
    ("GET", "/api/customer/members"): None,
    ("GET", "/api/customer/notifications"): None,
    ("GET", "/api/customer/orders"): None,
    ("GET", "/api/customer/orders/{order_id}"): None,
    ("GET", "/api/customer/orders/{order_id}/disputes"): None,
    ("GET", "/api/customer/orders/{order_id}/receipt.pdf"): None,
    ("GET", "/api/customer/reports"): None,
    ("GET", "/api/customer/reports.pdf"): None,
    ("GET", "/api/customer/zones"): None,
    ("DELETE", "/api/customer/lists/{list_id}"): lambda live: None,
    ("PATCH", "/api/customer/branches/{branch_id}"): lambda live: BRANCH,
    ("PATCH", "/api/customer/lists/{list_id}"): lambda live: {"name": "قائمة"},
    ("POST", "/api/customer/branches"): lambda live: BRANCH,
    ("POST", "/api/customer/cart/place"): lambda live: {},
    ("POST", "/api/customer/cart/ready"): lambda live: {},
    ("POST", "/api/customer/devices"): lambda live: {"fcm_token": "token-" + "x" * 20, "platform": "android"},
    ("POST", "/api/customer/lists"): lambda live: {"name": "طلب السبت", "items": [{"catalog_item_id": live.w.item, "qty": "1"}]},
    ("POST", "/api/customer/lists/{list_id}/to-cart"): lambda live: {},
    ("POST", "/api/customer/media"): lambda live: {},
    ("POST", "/api/customer/members"): lambda live: {"phone": "+218910000055", "full_name": "مسؤول", "role": "owner"},
    ("POST", "/api/customer/notifications/read"): lambda live: {"all": True},
    ("POST", "/api/customer/orders/{order_id}/disputes"): lambda live: {"kind": "damaged", "description": "تالف"},
    ("POST", "/api/customer/orders/{order_id}/reorder"): lambda live: {},
    ("POST", "/api/customer/registration"): lambda live: {**BRANCH, "name": "مطعم", "kind": "restaurant",
                                                          "contact_name": "علي", "facade_media_id": live.w.media},
    ("PUT", "/api/customer/cart/items/{catalog_item_id}"): lambda live: {"qty": "1"},
    ("PUT", "/api/customer/orders/{order_id}/items/{catalog_item_id}"): lambda live: {"qty": "1"},
    # ——— المورد ———
    ("GET", "/api/supplier/categories"): None,
    ("GET", "/api/supplier/dashboard"): None,
    ("GET", "/api/supplier/dues"): None,
    ("GET", "/api/supplier/dues.pdf"): None,
    ("GET", "/api/supplier/locations"): None,
    ("GET", "/api/supplier/me"): None,
    ("GET", "/api/supplier/notifications"): None,
    ("GET", "/api/supplier/offers"): None,
    ("GET", "/api/supplier/pickups"): None,
    ("GET", "/api/supplier/pickups/{stop_id}/slip.pdf"): None,
    ("GET", "/api/supplier/products"): None,
    ("PATCH", "/api/supplier/locations/{location_id}"): lambda live: {"label": "المخزن الرئيسي"},
    ("PATCH", "/api/supplier/offers/{offer_id}"): lambda live: {"reported_qty": "100"},
    ("POST", "/api/supplier/devices"): lambda live: {"fcm_token": "token-" + "y" * 20, "platform": "android"},
    ("POST", "/api/supplier/locations"): lambda live: {"label": "فرع ثانٍ", "lat": "32.8", "lng": "13.1", "address_text": "سوق"},
    ("POST", "/api/supplier/media"): lambda live: {},
    ("POST", "/api/supplier/notifications/read"): lambda live: {"all": True},
    ("POST", "/api/supplier/offers"): lambda live: {"product_id": live.w.product, "unit": "carton", "unit_size": "12",
                                                     "purchase_price": "50", "reported_qty": "5",
                                                     "pickup_location_id": live.w.location},
    ("POST", "/api/supplier/pickups/{stop_id}/scan"): lambda live: {"code": "000000"},
    ("POST", "/api/supplier/products"): lambda live: {"name_ar": "فلفل أحمر", "category_id": live.w.category},
    ("POST", "/api/supplier/registration"): lambda live: {"name": "م", "contact_name": "س", "owner_id_media_id": live.w.media,
                                                           "locations": [{"label": "م", "lat": "32.8", "lng": "13.1",
                                                                          "address_text": "س"}]},
    ("PUT", "/api/supplier/offers/{offer_id}/media"): lambda live: {"media_ids": []},
    # ——— السائق ———
    ("GET", "/api/driver/custody"): None,
    ("GET", "/api/driver/me"): None,
    ("GET", "/api/driver/orders"): None,
    ("GET", "/api/driver/orders/{order_id}"): None,
    ("GET", "/api/driver/orders/{order_id}/sheet.pdf"): None,
    ("POST", "/api/driver/stops/{stop_id}/code"): lambda live: {"code": "000000"},
}

# ما يقرؤه test_leak_responses: الكتابة بأجسامها، ومسار كل عملية بمعرّفاته.
WRITE_CASES = {op: body for op, body in CASES.items() if op[0] != "GET"}


def _path(path: str, live) -> str:
    return path.format(order_id=live.order, stop_id=live.stop, catalog_item_id=live.w.item, list_id=0, branch_id=0,
                       offer_id=live.w.offer, location_id=live.w.location)
