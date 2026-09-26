"""شرطا المالك على نقل الحالات (استثناء 7، 2026-09-27):

1. عدد الحالات المقروءة يساوي عدد العمليات المسجّلة لكل جمهور — لا صفر ولا أقل ولا أكثر.
2. الشاهد الإيجابي ما زال يُمسك تسريباً مدسوساً في عملية كتابة لكل جمهور من الثلاثة، بأدوات
   test_leak_responses نفسها (الحالة والمسار والجسم والفاحص وقائمة المحظور).
"""
from __future__ import annotations

import json

import httpx

from tests.api.audience_cases import CASES, WRITE_CASES, _path
from tests.api.routing import AUDIENCE_PREFIXES, operations
from tests.api.test_leak_responses import FORBIDDEN, body_text
from tests.api.world_api import live_world
from tests.db.test_isolation import leaks

AUDIENCES = ("customer", "supplier", "driver")
WITNESS = {"customer": ("PUT", "/api/customer/cart/items/{catalog_item_id}"),
           "supplier": ("POST", "/api/supplier/pickups/{stop_id}/scan"),
           "driver": ("POST", "/api/driver/stops/{stop_id}/code")}


def test_every_operation_has_exactly_one_case(app):
    for audience in AUDIENCES:
        prefix = AUDIENCE_PREFIXES[audience]
        ops = set(operations(app, prefix))
        cases = {op for op in CASES if op[1] == prefix or op[1].startswith(prefix + "/")}
        assert ops, f"لا عمليات لـ{audience}"
        assert len(cases) == len(ops) and cases == ops, (
            f"{audience}: {len(cases)} حالة لـ{len(ops)} عملية\nبلا حالة: {sorted(ops - cases)}\n"
            f"حالة بلا عملية: {sorted(cases - ops)}")


def test_witness_ops_are_real_write_cases():
    for audience, op in WITNESS.items():
        assert op in WRITE_CASES and op[0] != "GET", (audience, op)


class _Inject:
    """يدسّ في جسم استجابة عملية واحدة شاهداً محظوراً على جمهورها — كما لو سرّبه موجّه."""

    def __init__(self, app, path: str, canary: str) -> None:
        self.app, self.path, self.canary = app, path, canary

    async def __call__(self, scope, receive, send):
        if scope["type"] != "http" or scope["path"] != self.path:
            return await self.app(scope, receive, send)

        async def patched(message):
            if message["type"] == "http.response.start":
                message = {**message, "headers": [(k, v) for k, v in message["headers"] if k.lower() != b"content-length"]}
            elif message["type"] == "http.response.body":
                body = message.get("body", b"")
                message = {**message, "body": body + json.dumps({"leak": self.canary}).encode()}
            await send(message)

        return await self.app(scope, receive, patched)


async def test_positive_witness_catches_a_leak_injected_in_a_write_for_each_audience(db, client, app):
    live = await live_world(db, client)
    for audience, (method, path) in WITNESS.items():
        url = _path(path, live)
        canary = FORBIDDEN[audience][0]
        transport = httpx.ASGITransport(app=_Inject(app, url, canary))
        async with httpx.AsyncClient(transport=transport, base_url="http://madad.test") as c:
            r = await c.request(method, url, headers=live.auth(audience), json=WRITE_CASES[(method, path)](live))
        assert r.status_code < 500, (audience, r.status_code, r.text[:300])
        assert canary in leaks(body_text(r), FORBIDDEN[audience]), f"{audience} {method} {path}: الفاحص أعمى"
        clean = await client.request(method, url, headers=live.auth(audience), json=WRITE_CASES[(method, path)](live))
        assert not leaks(body_text(clean), FORBIDDEN[audience]), f"{audience}: العملية نفسها تسرّب بلا دسّ"
