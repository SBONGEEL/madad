"""م-2 وم-19 مفروضان في مخطط الخرج، ويُختبران في الاتجاهين على السلك (JSON وPDF):
الإعداد مغلق → الحقل غائب عن الاستجابة أصلاً؛ مفتوح → حاضر. والمالك وحده يغيّرها.
"""
from __future__ import annotations

from tests.api.test_leak_responses import body_text
from tests.api.world_api import live_world
from tests.db.world import SUPPLIER_CANARY

VIS = "/api/admin/settings/visibility"


async def _set(client, live, **flags):
    cur = (await client.get(VIS, headers=live.auth("admin"))).json()
    r = await client.put(VIS, headers=live.auth("admin"), json={**cur, **flags})
    assert r.status_code == 200, r.text
    return r.json()


async def test_visibility_starts_closed(db, client):
    live = await live_world(db, client)
    r = await client.get(VIS, headers=live.auth("admin"))
    assert r.json() == {"driver_sees_supplier_name": False, "customer_sees_driver_name": False,
                        "customer_can_call_driver": False}


async def test_m2_supplier_name_reaches_driver_only_when_owner_opens_it(db, client):
    live = await live_world(db, client)
    order = f"/api/driver/orders/{live.order}"
    sheet = f"/api/driver/orders/{live.order}/sheet.pdf"

    closed = await client.get(order, headers=live.auth("driver"))
    closed_pdf = await client.get(sheet, headers=live.auth("driver"))
    assert SUPPLIER_CANARY not in closed.text and SUPPLIER_CANARY not in body_text(closed_pdf)
    labels = [s["label"] for s in closed.json()["stops"]]
    assert any(label.startswith("نقطة استلام") for label in labels), labels
    # الموقع يظهر دائماً
    assert all(s["address_text"] for s in closed.json()["stops"])

    await _set(client, live, driver_sees_supplier_name=True)
    opened = await client.get(order, headers=live.auth("driver"))
    opened_pdf = await client.get(sheet, headers=live.auth("driver"))
    assert SUPPLIER_CANARY in opened.text          # الشاهد الإيجابي: الفحص يرى الاسم حين يُفتح
    assert SUPPLIER_CANARY in body_text(opened_pdf)


async def test_m19_driver_name_and_call_are_absent_keys_when_closed(db, client):
    live = await live_world(db, client)
    order = f"/api/customer/orders/{live.order}"

    card = (await client.get(order, headers=live.auth("customer"))).json()["driver"]
    assert card == {"assigned": True}, card     # لا مفتاح، لا null

    await _set(client, live, customer_sees_driver_name=True)
    card = (await client.get(order, headers=live.auth("customer"))).json()["driver"]
    assert card == {"assigned": True, "first_name": "السائق"}, card

    await _set(client, live, customer_sees_driver_name=False, customer_can_call_driver=True)
    card = (await client.get(order, headers=live.auth("customer"))).json()["driver"]
    assert card == {"assigned": True, "phone": "+218910000004"}, card


async def test_only_admin_with_settings_permission_changes_visibility(db, client):
    live = await live_world(db, client)
    for audience in ("customer", "driver", "supplier"):
        r = await client.put(VIS, headers=live.auth(audience), json={"driver_sees_supplier_name": True,
                             "customer_sees_driver_name": True, "customer_can_call_driver": True})
        assert r.status_code in (401, 403), (audience, r.status_code)
    assert (await client.get(VIS, headers=live.auth("admin"))).json()["driver_sees_supplier_name"] is False
