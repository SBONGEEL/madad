"""حارس العزل على العقد: أسماء الحقول في مخططات الاستجابة المعلنة (OpenAPI)، لكل
مسار تحت بادئة جمهوره، لا تحمل ما يُحظر عليه. ومعه تِعداد مسارات مُعلَن يُكسَر عند
أول مسار جديد، فلا يمرّ مسار بلا مراجعة لهذا الحارس.
"""
from __future__ import annotations

import re

from tests.api.routing import AUDIENCE_PREFIXES, operations
from tests.db.test_isolation import FORBIDDEN_COLUMNS

# يُحدَّث يدوياً مع كل مسار، بعد مراجعة المسارات وحرّاسها.
EXPECTED_OPERATIONS = {
    "customer": 6,   # me · categories · catalog · orders · order · receipt.pdf
    "supplier": 4,   # me · pickups · scan · slip.pdf
    "driver": 5,     # me · orders · order · code · sheet.pdf
    "admin": 6,      # visibility (قراءة/كتابة) · capital (قراءة/كتابة) · order costs · me
    "auth": 6,       # register start/verify/complete · login · refresh · logout
}


def _walk(schema: dict, components: dict, seen: set[str]) -> set[str]:
    names: set[str] = set()
    if not isinstance(schema, dict):
        return names
    ref = schema.get("$ref")
    if ref:
        key = ref.rsplit("/", 1)[-1]
        if key in seen:
            return names
        seen.add(key)
        return _walk(components.get(key, {}), components, seen)
    for name, sub in (schema.get("properties") or {}).items():
        names.add(name)
        names |= _walk(sub, components, seen)
    for key in ("items", "additionalProperties"):
        if isinstance(schema.get(key), dict):
            names |= _walk(schema[key], components, seen)
    for key in ("allOf", "anyOf", "oneOf"):
        for sub in schema.get(key) or []:
            names |= _walk(sub, components, seen)
    return names


def response_fields(app, prefix: str) -> dict[str, set[str]]:
    spec = app.openapi()
    components = spec.get("components", {}).get("schemas", {})
    out: dict[str, set[str]] = {}
    for path, ops in spec["paths"].items():
        if not (path == prefix or path.startswith(prefix + "/")):
            continue
        for method, op in ops.items():
            for status, resp in (op.get("responses") or {}).items():
                for media in (resp.get("content") or {}).values():
                    names = _walk(media.get("schema") or {}, components, set())
                    if names:
                        out.setdefault(f"{method.upper()} {path} {status}", set()).update(names)
    return out


def test_routing_probe_sees_the_routes(app):
    """المسبار (§11.4): التعداد يرى ما سُجِّل فعلاً، لا صفراً ينجح في فراغ."""
    paths = {p for _, p in operations(app, "/api")}
    assert "/api/auth/{audience}/login" in paths
    assert any(p.startswith("/api/customer/") for p in paths)


def test_operation_census_is_declared(app):
    actual = {a: len(operations(app, p)) for a, p in {**AUDIENCE_PREFIXES, "auth": "/api/auth"}.items()}
    assert actual == EXPECTED_OPERATIONS, f"المعلَن {EXPECTED_OPERATIONS} والفعلي {actual}: راجع الحرّاس ثم حدّث"


def test_positive_witness_admin_schema_carries_cost_fields(app):
    names = set().union(*response_fields(app, "/api/admin").values())
    assert any(FORBIDDEN_COLUMNS["customer"].search(n) for n in names), sorted(names)


def test_audience_response_schemas_carry_no_forbidden_field(app):
    offences = []
    for audience in ("customer", "supplier", "driver"):
        fields = response_fields(app, AUDIENCE_PREFIXES[audience])
        assert fields, f"لا مخطط استجابة لـ{audience}"
        for op, names in fields.items():
            offences += [f"{op}: {n}" for n in sorted(names) if FORBIDDEN_COLUMNS[audience].search(n)]
    assert not offences, "حقول محظورة في العقد:\n" + "\n".join(offences)


def test_each_side_sees_only_its_own_handover_secret(app):
    """م-3: رقم المورد لا يخرج للسائق، وكود السائق (الـQR) لا يخرج للمورد."""
    drv = set().union(*response_fields(app, "/api/driver").values())
    sup = set().union(*response_fields(app, "/api/supplier").values())
    assert "pickup_code" in drv and "supplier_code" not in drv
    assert "supplier_code" in sup and "pickup_code" not in sup
    assert not re.search("supplier", " ".join(drv))
