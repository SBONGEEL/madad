"""تطبيق السائق على السلك (الجزء 13)، وحرّاس الترحيلة 0012، وعروض الأجرة في اللوحة — في الاتجاهين.

حارس التسرّب لنقاطه (شرط الاستثناء 3): test_leak_responses بحالاتها في audience_cases.py، وtest_leak_openapi،
وtest_audience_cases — ونقطتا اللوحة في test_admin_guards بحالتهما في admin_cases.py. وهنا ما يخصّ كل نقطة.
"""
from __future__ import annotations

from decimal import Decimal

from tests.api.world_api import PASSWORD, login, set_passwords
from tests.db.test_isolation import COST_CANARIES as CANARIES, leaks
from tests.db.world import act, build, draft, place

H = lambda tok: {"Authorization": f"Bearer {tok}"}  # noqa: E731
JPEG = b"\xff\xd8\xff\xe0" + b"0" * 64


async def _confirmed(db, client, km="10"):
    """طلبية مؤكَّدة بمخطط كامل ومسافة، بلا سائق — متاحة للقبول."""
    w = await build(db)
    oid = await draft(db, w)
    await place(db, w, oid)
    await act(db, "admin", w.owner)
    await db.execute("UPDATE orders SET status = 'confirmed' WHERE id = $1", oid)
    if km:
        await db.execute("UPDATE orders SET route_km = $2 WHERE id = $1", oid, Decimal(km))
    await set_passwords(db)
    return w, oid, (await login(client, "driver"))["access_token"], (await login(client, "admin"))["access_token"]


# ——— المتاح والقبول (م-18) ——————————————————————————————————————————————————————————
async def test_available_shows_pay_estimate_and_accept_assigns(db, client):
    w, oid, tok, _ = await _confirmed(db, client)
    av = (await client.get("/api/driver/available", headers=H(tok))).json()
    assert [a["id"] for a in av] == [oid]
    assert av[0]["stops"] == 1 and av[0]["pay_estimate"] == "12.000"       # 5 + 2×1 + 0.5×10
    assert not leaks(str(av), CANARIES)
    r = await client.post(f"/api/driver/orders/{oid}/accept", headers=H(tok))
    assert r.status_code == 200 and r.json()["status"] == "assigned" and r.json()["driver_pay"] == "12.000"
    assert (await client.get("/api/driver/available", headers=H(tok))).json() == []


async def test_accept_without_route_km_is_refused(db, client):
    w, oid, tok, _ = await _confirmed(db, client, km=None)
    assert (await client.get("/api/driver/available", headers=H(tok))).json()[0]["pay_estimate"] is None
    r = await client.post(f"/api/driver/orders/{oid}/accept", headers=H(tok))
    assert r.status_code == 409 and r.json()["code"] == "route_km_missing"


async def test_pay_offer_decided_by_the_owner_assigns(db, client):
    w, oid, tok, adm = await _confirmed(db, client)
    r = await client.post(f"/api/driver/orders/{oid}/pay-offers", headers=H(tok), json={"amount": "20"})
    assert r.status_code == 201 and r.json()[0]["my_offer"]["status"] == "pending"
    twice = await client.post(f"/api/driver/orders/{oid}/pay-offers", headers=H(tok), json={"amount": "21"})
    assert twice.status_code == 409
    offers = (await client.get(f"/api/admin/orders/{oid}/pay-offers", headers=H(adm))).json()
    assert offers[0]["amount"] == "20.000" and offers[0]["formula_pay"] == "12.000"
    dec = await client.post(f"/api/admin/pay-offers/{offers[0]['id']}/decide", headers=H(adm), json={"decision": "accept"})
    assert dec.status_code == 200 and dec.json()[0]["status"] == "accepted"
    mine = (await client.get(f"/api/driver/orders/{oid}", headers=H(tok))).json()
    assert mine["status"] == "assigned" and mine["driver_pay"] == "20.000"


async def test_rejected_offer_leaves_the_order_open(db, client):
    w, oid, tok, adm = await _confirmed(db, client)
    await client.post(f"/api/driver/orders/{oid}/pay-offers", headers=H(tok), json={"amount": "30"})
    fid = (await client.get(f"/api/admin/orders/{oid}/pay-offers", headers=H(adm))).json()[0]["id"]
    await client.post(f"/api/admin/pay-offers/{fid}/decide", headers=H(adm), json={"decision": "reject"})
    av = (await client.get("/api/driver/available", headers=H(tok))).json()
    assert av[0]["id"] == oid and av[0]["my_offer"]["status"] == "rejected"


# ——— الاستلام والدفعات والتسليم ——————————————————————————————————————————————————————
async def _accepted(db, client):
    w, oid, tok, adm = await _confirmed(db, client)
    await client.post(f"/api/driver/orders/{oid}/accept", headers=H(tok))
    o = (await client.get(f"/api/driver/orders/{oid}", headers=H(tok))).json()
    return w, oid, tok, o


async def test_full_cycle_collect_batch_deliver_and_wallet(db, client):
    w, oid, tok, o = await _accepted(db, client)
    stop = o["stops"][0]
    code = await db.fetchval("SELECT supplier_code FROM pickup_stops WHERE id = $1", stop["id"])
    bad = await client.post(f"/api/driver/stops/{stop['id']}/code", headers=H(tok), json={"code": "000000"})
    assert bad.status_code == 409 and bad.json()["code"] == "pickup_code_mismatch"
    ok = await client.post(f"/api/driver/stops/{stop['id']}/code", headers=H(tok), json={"code": code})
    assert ok.status_code == 200
    line = stop["lines"][0]
    c = await client.post(f"/api/driver/stops/{stop['id']}/confirm", headers=H(tok),
                          json={"lines": [{"line_id": line["id"], "collected_qty": line["planned_qty"]}]})
    assert c.status_code == 200, c.text
    o = c.json()
    assert o["status"] == "collecting" and o["stops"][0]["status"] == "collected" and o["items"][0]["collected_qty"] == "2"
    item = o["items"][0]
    early = await client.post(f"/api/driver/orders/{oid}/batches", headers=H(tok),
                              json={"lines": [{"order_item_id": item["id"], "qty": "3"}]})
    assert early.status_code == 409 and early.json()["code"] == "batch_qty_exceeds_collected"
    b = (await client.post(f"/api/driver/orders/{oid}/batches", headers=H(tok),
                           json={"lines": [{"order_item_id": item["id"], "qty": "2"}]})).json()["batches"][0]
    assert b["status"] == "planned" and b["value"] == "1822.626"
    no = await client.post(f"/api/driver/batches/{b['id']}/depart", headers=H(tok))
    assert no.status_code == 409                               # لا انطلاق قبل الإشعار
    n = (await client.post(f"/api/driver/batches/{b['id']}/notify", headers=H(tok))).json()["batches"][0]
    assert n["status"] == "notified" and n["notice"]["now"][0]["item"] == "طماطم"
    await client.post(f"/api/driver/batches/{b['id']}/depart", headers=H(tok))
    done = (await client.post(f"/api/driver/batches/{b['id']}/deliver", headers=H(tok))).json()
    assert done["status"] == "delivered" and done["items"][0]["delivered_qty"] == "2"
    wal = (await client.get("/api/driver/wallet", headers=H(tok))).json()
    assert wal["cash_held"] == "1832.626" and wal["wage_due"] == "12.000" and wal["pay_method"] == "periodic"
    st = (await client.get("/api/driver/settlements", headers=H(tok))).json()
    assert [(s["kind"], s["amount"]) for s in st] == [("wage", "12.000")]
    pdf = await client.get("/api/driver/settlements.pdf", headers=H(tok))
    assert pdf.content.startswith(b"%PDF")


async def test_short_stop_needs_less_than_planned(db, client):
    w, oid, tok, o = await _accepted(db, client)
    stop = o["stops"][0]
    code = await db.fetchval("SELECT supplier_code FROM pickup_stops WHERE id = $1", stop["id"])
    await client.post(f"/api/driver/stops/{stop['id']}/code", headers=H(tok), json={"code": code})
    line = stop["lines"][0]
    r = (await client.post(f"/api/driver/stops/{stop['id']}/confirm", headers=H(tok),
                           json={"lines": [{"line_id": line["id"], "collected_qty": "1"}]})).json()
    assert r["stops"][0]["status"] == "short" and r["stops"][0]["lines"][0]["collected_qty"] == "1"


async def test_stop_needs_proof_before_confirm(db, client):
    w, oid, tok, o = await _accepted(db, client)
    stop = o["stops"][0]
    line = stop["lines"][0]
    r = await client.post(f"/api/driver/stops/{stop['id']}/confirm", headers=H(tok),
                          json={"lines": [{"line_id": line["id"], "collected_qty": line["planned_qty"]}]})
    assert r.status_code == 409 and r.json()["code"] == "pickup_proof_required"     # م-22


async def test_other_drivers_order_is_not_found(db, client):
    w, oid, tok, o = await _accepted(db, client)
    await act(db, "system")
    uid = await db.fetchval("INSERT INTO app_users (phone, audience, full_name, password_hash, phone_verified_at, "
                            "password_set_at) SELECT '+218910000041', 'driver', 'آخر', password_hash, now(), now() "
                            "FROM app_users WHERE id = $1 RETURNING id", w.drv_user)
    await db.execute("INSERT INTO drivers (user_id, city, full_name, phone, id_media_id, license_media_id, photo_media_id, "
                     "vehicle) VALUES ($1, 'TIP', 'آخر', '+218910000041', $2, $2, $2, 'car')", uid, w.media)
    other = (await client.post("/api/auth/driver/login", json={"phone": "+218910000041", "password": PASSWORD})).json()
    r = await client.get(f"/api/driver/orders/{oid}", headers=H(other["access_token"]))
    assert r.status_code == 404
    d = await client.post(f"/api/driver/orders/{oid}/disputes", headers=H(other["access_token"]),
                          json={"kind": "refused", "description": "x"})
    assert d.status_code == 404


async def test_driver_opens_dispute_on_own_order(db, client):
    w, oid, tok, o = await _accepted(db, client)
    r = await client.post(f"/api/driver/orders/{oid}/disputes", headers=H(tok),
                          json={"order_item_id": o["items"][0]["id"], "kind": "refused", "description": "رفض العميل"})
    assert r.status_code == 201 and r.json()[0]["status"] == "open"


# ——— التسجيل والوثائق (قرار 27/09: الحالة لا الصور) ——————————————————————————————————————
async def _new_driver(app, client, phone="+218910000044"):
    await client.post("/api/auth/driver/register/start", json={"phone": phone})
    code = app.state.otp_outbox[-1]["code"]
    t = (await client.post("/api/auth/driver/register/verify", json={"phone": phone, "code": code})).json()["ticket"]
    return (await client.post("/api/auth/driver/register/complete",
                              json={"ticket": t, "password": PASSWORD, "full_name": "—"})).json()["access_token"]


async def _up(client, tok, purpose):
    return (await client.post("/api/driver/media", headers=H(tok), data={"purpose": purpose},
                              files={"file": ("d.jpg", JPEG, "image/jpeg")})).json()["id"]


async def test_registration_needs_both_licence_sides(db, client, app):
    await build(db)
    tok = await _new_driver(app, client)
    ids = {}
    for purpose in ("driver_id", "driver_license", "driver_license_back", "driver_photo"):
        ids[purpose] = await _up(client, tok, purpose)
    body = {"full_name": "مراد", "vehicle": "van", "capacity_kg": "800", "id_media_id": ids["driver_id"],
            "license_media_id": ids["driver_license"], "photo_media_id": ids["driver_photo"]}
    assert (await client.post("/api/driver/registration", headers=H(tok), json=body)).status_code == 422
    r = await client.post("/api/driver/registration", headers=H(tok),
                          json={**body, "license_back_media_id": ids["driver_license_back"]})
    assert r.status_code == 201 and r.json()["status"] == "pending" and r.json()["documents_complete"] is True
    me = (await client.get("/api/driver/me", headers=H(tok))).json()
    assert me["driver"]["vehicle"] == "van" and "media" not in str(me)
    for m in ids.values():                                    # خاصّة: للّوحة وحدها
        assert (await client.get(f"/api/media/{m}")).status_code == 404


async def test_driver_insert_needs_licence_back_in_db(db):
    import asyncpg
    import pytest

    w = await build(db)
    await act(db, "system")
    uid = await db.fetchval("INSERT INTO app_users (phone, audience, full_name) VALUES ('+218910000045', 'driver', 'س') RETURNING id")
    await act(db, "driver", uid)
    with pytest.raises(asyncpg.PostgresError) as e:
        await db.execute("INSERT INTO drivers (user_id, city, full_name, phone, id_media_id, license_media_id, photo_media_id, "
                         "vehicle) VALUES ($1, 'TIP', 'س', '+218910000045', $2, $2, $2, 'car')", uid, w.media)
    assert "document_missing" in str(e.value)
    with pytest.raises(asyncpg.PostgresError) as e:
        await db.execute("INSERT INTO drivers (user_id, city, full_name, phone, id_media_id, license_media_id, "
                         "license_back_media_id, photo_media_id, vehicle) VALUES ($1, 'TIP', 'س', '+218910000045', $2, $2, $2, $2, "
                         "'car')", w.drv_user, w.media)
    assert "registers himself" in str(e.value)


# ——— إشعارا السائق (§7) ————————————————————————————————————————————————————————————————
async def test_assignment_by_owner_and_settlement_notify_the_driver(db, client):
    w, oid, tok, adm = await _confirmed(db, client)
    await client.post(f"/api/admin/orders/{oid}/assign", headers=H(adm), json={"driver_id": w.driver, "route_km": "10"})
    await act(db, "system")
    assert await db.fetchval("SELECT emit_driver_events()") == 1
    kinds = [n["kind"] for n in (await client.get("/api/driver/notifications", headers=H(tok))).json()]
    assert kinds == ["order_assigned"]


async def test_planned_batch_times_are_editable_until_notified(db, client):
    """دفعة أُنشئت بلا موعد لما بعدها لا تعلق: يُكتب الموعد ثم يُرسل الإشعار؛ وبعده يثبت."""
    w, oid, tok, o = await _accepted(db, client)
    stop = o["stops"][0]
    code = await db.fetchval("SELECT supplier_code FROM pickup_stops WHERE id = $1", stop["id"])
    await client.post(f"/api/driver/stops/{stop['id']}/code", headers=H(tok), json={"code": code})
    line = stop["lines"][0]
    o = (await client.post(f"/api/driver/stops/{stop['id']}/confirm", headers=H(tok),
                           json={"lines": [{"line_id": line["id"], "collected_qty": line["planned_qty"]}]})).json()
    item = o["items"][0]["id"]
    b = (await client.post(f"/api/driver/orders/{oid}/batches", headers=H(tok),
                           json={"lines": [{"order_item_id": item, "qty": "1"}]})).json()["batches"][0]
    stuck = await client.post(f"/api/driver/batches/{b['id']}/notify", headers=H(tok))
    assert stuck.status_code == 409 and stuck.json()["code"] == "batch_notice_needs_later_eta"
    fixed = await client.patch(f"/api/driver/batches/{b['id']}", headers=H(tok), json={"next_eta_at": "2026-09-27T16:30:00+02:00"})
    assert fixed.status_code == 200 and fixed.json()["batches"][0]["next_eta_at"] is not None
    assert (await client.post(f"/api/driver/batches/{b['id']}/notify", headers=H(tok))).status_code == 200
    late = await client.patch(f"/api/driver/batches/{b['id']}", headers=H(tok), json={"next_eta_at": "2026-09-27T18:00:00+02:00"})
    assert late.status_code == 409 and late.json()["code"] == "batch_notice_sent_is_immutable"


async def test_owner_sets_route_km_then_the_driver_sees_the_estimate(db, client):
    """م-18: بلا طول مسار لا أجر تقديري ولا قبول؛ اللوحة تكتبه فيظهر الأجر ويقبل السائق."""
    w, oid, tok, adm = await _confirmed(db, client, km=None)
    r = await client.put(f"/api/admin/orders/{oid}/route-km", headers=H(adm), json={"route_km": "14.2"})
    assert r.status_code == 200
    assert (await client.get("/api/driver/available", headers=H(tok))).json()[0]["pay_estimate"] == "14.100"
    assert (await client.post(f"/api/driver/orders/{oid}/accept", headers=H(tok))).status_code == 200
