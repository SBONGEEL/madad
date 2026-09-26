"""م-3 على السلك: المورد يمسح كود السائق، أو السائق يكتب رقم المورد. كلاهما في الاتجاهين."""
from __future__ import annotations

from tests.api.world_api import live_world


async def _driver_stop(client, live):
    r = await client.get(f"/api/driver/orders/{live.order}", headers=live.auth("driver"))
    return next(s for s in r.json()["stops"] if s["id"] == live.stop)


async def _supplier_stop(client, live):
    r = await client.get("/api/supplier/pickups", headers=live.auth("supplier"))
    return next(p for p in r.json() if p["id"] == live.stop)


async def test_supplier_scans_driver_qr(db, client):
    live = await live_world(db, client, collected=False)
    qr = (await _driver_stop(client, live))["pickup_code"]
    url = f"/api/supplier/pickups/{live.stop}/scan"

    wrong = await client.post(url, headers=live.auth("supplier"), json={"code": "000000" if qr != "000000" else "111111"})
    assert wrong.status_code == 409 and wrong.json()["code"] == "pickup_code_mismatch", wrong.text
    assert (await _supplier_stop(client, live))["handed_over"] is False

    ok = await client.post(url, headers=live.auth("supplier"), json={"code": qr})
    assert ok.status_code == 200, ok.text
    assert ok.json() == {"handed_over": True, "method": "qr_scan"}
    assert (await _supplier_stop(client, live))["handed_over"] is True
    assert (await _driver_stop(client, live))["handed_over"] is True


async def test_driver_types_supplier_number(db, client):
    live = await live_world(db, client, collected=False)
    number = (await _supplier_stop(client, live))["supplier_code"]
    url = f"/api/driver/stops/{live.stop}/code"

    wrong = await client.post(url, headers=live.auth("driver"), json={"code": "000000" if number != "000000" else "111111"})
    assert wrong.status_code == 409 and wrong.json()["code"] == "pickup_code_mismatch", wrong.text

    ok = await client.post(url, headers=live.auth("driver"), json={"code": number})
    assert ok.status_code == 200, ok.text
    assert ok.json() == {"handed_over": True, "method": "code_entry"}


async def test_handover_is_recorded_once(db, client):
    live = await live_world(db, client, collected=False)
    number = (await _supplier_stop(client, live))["supplier_code"]
    url = f"/api/driver/stops/{live.stop}/code"
    assert (await client.post(url, headers=live.auth("driver"), json={"code": number})).status_code == 200
    again = await client.post(url, headers=live.auth("driver"), json={"code": number})
    assert again.status_code == 409, again.text


async def test_other_supplier_or_driver_cannot_touch_the_stop(db, client):
    live = await live_world(db, client, collected=False)
    # رمز العميل على مسار المورد والسائق → مرفوض بنيوياً قبل القاعدة
    for url in (f"/api/supplier/pickups/{live.stop}/scan", f"/api/driver/stops/{live.stop}/code"):
        r = await client.post(url, headers=live.auth("customer"), json={"code": "123456"})
        assert r.status_code in (401, 403), (url, r.status_code)
