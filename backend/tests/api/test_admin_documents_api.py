"""وثائق الاعتماد في اللوحة (الترحيلة 0013): القائمة لصاحب «الاعتمادات»، وكل فتح مسجَّل بمن فتحه —
والوثيقة الخاصة لا تُخدَم من الباب العام ولا لمن لا يملك الصلاحية.

حارس التسرّب للنقطتين (شرط الاستثناء 3): test_admin_guards (بحالة الكتابة في admin_cases.py) وهذا الملف.
"""
from __future__ import annotations

import asyncpg
import pytest

from tests.api.test_admin_guards import SUP_NONE, supervisors
from tests.api.world_api import PASSWORD, login, set_passwords
from tests.db.world import act, build

H = lambda tok: {"Authorization": f"Bearer {tok}"}  # noqa: E731
JPEG = b"\xff\xd8\xff\xe0" + b"1" * 64


async def _pending_customer(db, client, app):
    await build(db)
    await set_passwords(db)
    await client.post("/api/auth/customer/register/start", json={"phone": "+218910000071"})
    code = app.state.otp_outbox[-1]["code"]
    t = (await client.post("/api/auth/customer/register/verify", json={"phone": "+218910000071", "code": code})).json()["ticket"]
    tok = (await client.post("/api/auth/customer/register/complete",
                             json={"ticket": t, "password": PASSWORD, "full_name": "—"})).json()["access_token"]
    mid = (await client.post("/api/customer/media", headers=H(tok), data={"purpose": "facade"},
                             files={"file": ("f.jpg", JPEG, "image/jpeg")})).json()["id"]
    cid = (await client.post("/api/customer/registration", headers=H(tok), json={
        "name": "مقهى", "kind": "cafe", "contact_name": "س", "lat": "32.8", "lng": "13.1", "address_text": "ع",
        "facade_media_id": mid})).json()["id"]
    return cid, mid, (await login(client, "admin"))["access_token"]


async def test_owner_lists_and_opens_documents_and_each_open_is_logged(db, client, app):
    cid, mid, adm = await _pending_customer(db, client, app)
    docs = (await client.get(f"/api/admin/approvals/customer/{cid}/documents", headers=H(adm))).json()
    assert docs == [{"purpose": "facade", "media_id": mid, "mime_type": "image/jpeg", "views": 0}]
    r = await client.post(f"/api/admin/media/{mid}/open", headers=H(adm))
    assert r.status_code == 200 and r.content == JPEG
    await client.post(f"/api/admin/media/{mid}/open", headers=H(adm))
    assert (await client.get(f"/api/admin/approvals/customer/{cid}/documents", headers=H(adm))).json()[0]["views"] == 2
    assert (await client.get(f"/api/media/{mid}")).status_code == 404            # الخاصّ لا يُخدَم من الباب العام


async def test_supervisor_without_approvals_cannot_open(db, client, app):
    cid, mid, adm = await _pending_customer(db, client, app)
    sup = (await supervisors(db, client))[SUP_NONE]
    assert (await client.post(f"/api/admin/media/{mid}/open", headers=sup)).status_code == 403
    assert await db.fetchval("SELECT count(*) FROM media_views") == 0


async def test_view_log_is_append_only_and_panel_only(db):
    w = await build(db)
    await act(db, "admin", w.owner)
    await db.execute("INSERT INTO media_views (media_id, viewed_by) VALUES ($1, 0)", w.media)
    assert await db.fetchval("SELECT viewed_by FROM media_views") == w.owner
    with pytest.raises(asyncpg.PostgresError, match="append_only_"):
        await db.execute("DELETE FROM media_views")
    await act(db, "customer", w.cust_user)
    with pytest.raises(asyncpg.PostgresError, match="private documents are for the panel"):
        await db.execute("INSERT INTO media_views (media_id, viewed_by) VALUES ($1, 0)", w.media)
