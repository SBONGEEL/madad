"""حرّاس لوحة المالك — كُتبت قبل نقاط الشاشات.

١) كل عملية تحت /api/admin تعلن صلاحيتها في العقد (x-permission): صلاحية من admin_permission،
   أو owner (المالك وحده)، أو any (كل مستخدم لوحة: /me والإشعارات).
٢) مشرف بلا صلاحيات يُرفض في كل عملية تحتاج صلاحية — لا عملية تنسى فحصها.
٣) مشرف بكل الصلاحيات عدا «التكاليف» (costs_view) لا يرى سعر شراء ولا هامشاً ولا تكلفة سطر
   في أي استجابة؛ والمالك يراها (الشاهد الإيجابي) — فالفحص ليس أعمى.
٤) التغطية مغلقة: عملية لا يعرف الحارس كيف يستدعيها تُسقطه باسمها.
"""
from __future__ import annotations

from decimal import Decimal

import pytest

from tests.api.routing import operations
from tests.api.test_leak_responses import body_text
from tests.api.world_api import PASSWORD, live_world
from tests.db.test_isolation import leaks
from tests.db.world import MARGIN_CANARY, PURCHASE_CANARY, act

PERMS = {"approvals", "catalog", "costs_view", "orders", "warehouses", "money", "customers", "notifications",
         "settings", "users", "owner", "any"}
COSTS = [str(PURCHASE_CANARY), str(MARGIN_CANARY), "1555.54"]
SUP_ALL, SUP_NONE = "+218910000041", "+218910000042"

# أجسام عمليات الكتابة: تُستدعى بها ويُفحص ردّها. ما ليس هنا ولا GET يُسقط الحارس.
from tests.api.admin_cases import WRITES, path_ids  # noqa: E402  (تُملأ مع كل شاشة)


async def supervisors(db, client) -> dict[str, dict]:
    await act(db, "system")
    h = await db.fetchval("SELECT password_hash FROM app_users WHERE phone = '+218910000001'")
    out = {}
    for phone, perms in ((SUP_ALL, [p for p in PERMS if p not in ("costs_view", "owner", "any")]), (SUP_NONE, [])):
        uid = await db.fetchval("INSERT INTO app_users (phone, audience, full_name, phone_verified_at, password_hash) "
                                "VALUES ($1, 'admin', 'مشرف', now(), $2) RETURNING id", phone, h)
        await db.execute("INSERT INTO admin_members (user_id, role) VALUES ($1, 'supervisor')", uid)
        for p in perms:
            await db.execute("INSERT INTO admin_permissions (user_id, permission) VALUES ($1, $2::admin_permission)", uid, p)
        tok = (await client.post("/api/auth/admin/login", json={"phone": phone, "password": PASSWORD})).json()
        out[phone] = {"Authorization": f"Bearer {tok['access_token']}"}
    return out


def declared(app) -> dict[tuple[str, str], str]:
    spec = app.openapi()
    return {(m.upper(), p): op.get("x-permission") for p, ops in spec["paths"].items() if p.startswith("/api/admin")
            for m, op in ops.items() if m in ("get", "post", "put", "patch", "delete")}


async def call(client, method, path, ids, headers):
    url = path.format(**ids)
    if method == "GET":
        return await client.get(url, headers=headers)
    return await client.request(method, url, headers=headers, json=WRITES[(method, path)](ids))


def test_every_admin_operation_declares_its_permission(app):
    decl = declared(app)
    assert decl, "لا عمليات لوحة — حارس بلا موضوع"
    missing = [f"{m} {p}" for (m, p), perm in decl.items() if perm not in PERMS]
    assert not missing, "عمليات بلا صلاحية معلنة:\n" + "\n".join(missing)


async def test_supervisor_without_permission_is_refused_everywhere(db, client, app):
    live = await live_world(db, client)
    hdr = (await supervisors(db, client))[SUP_NONE]
    ids = await path_ids(db, live)
    uncovered, leaked = [], []
    for (method, path), perm in declared(app).items():
        if perm == "any":
            continue
        if method != "GET" and (method, path) not in WRITES:
            uncovered.append(f"{method} {path}")
            continue
        r = await call(client, method, path, ids, hdr)
        if r.status_code != 403:
            leaked.append(f"{method} {path} ({perm}) → {r.status_code}")
    assert not uncovered, "عمليات لا يغطيها الحارس:\n" + "\n".join(uncovered)
    assert not leaked, "عمليات تقبل مشرفاً بلا صلاحيتها:\n" + "\n".join(leaked)


async def test_costs_are_hidden_without_costs_view_and_seen_by_owner(db, client, app):
    live = await live_world(db, client)
    hdr = (await supervisors(db, client))[SUP_ALL]
    ids = await path_ids(db, live)
    owner_seen, offences, checked = set(), [], 0
    for (method, path), perm in sorted(declared(app).items()):
        if method != "GET":
            continue
        r = await call(client, method, path, ids, hdr)
        if perm in ("costs_view", "owner"):
            assert r.status_code == 403, f"{path}: {r.status_code}"
        else:
            assert r.status_code == 200, f"{path}: {r.status_code} {r.text[:300]}"
            bad = leaks(body_text(r), COSTS)
            if bad:
                offences.append(f"GET {path}: {bad}")
            checked += 1
        o = await call(client, method, path, ids, live.auth("admin"))
        assert o.status_code == 200, f"owner {path}: {o.status_code} {o.text[:300]}"
        owner_seen |= set(leaks(body_text(o), COSTS))
    assert checked, "لا عملية قراءة فُحصت"
    assert not offences, "تكاليف تظهر لمشرف بلا صلاحية التكاليف:\n" + "\n".join(offences)
    assert {str(PURCHASE_CANARY), str(MARGIN_CANARY)} <= owner_seen, f"الشاهد الإيجابي أعمى: {owner_seen}"


@pytest.mark.parametrize("path", ["/api/admin/me"])
async def test_any_member_reaches_its_own_profile(db, client, path):
    await live_world(db, client)
    hdr = (await supervisors(db, client))[SUP_NONE]
    assert (await client.get(path, headers=hdr)).status_code == 200


def test_money_amounts_are_three_places_on_the_wire():
    from app.core.money import fmt
    assert fmt(Decimal("911.3")) == "911.300"
