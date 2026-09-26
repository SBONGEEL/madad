"""تعداد المسارات للحرّاس — من OpenAPI لا من app.routes.

قِيس في رَفّ على FastAPI 0.141: include_router لم يعد يفرد المسارات في app.routes،
فحارس يعدّ منها يعدّ صفراً وينجح في فراغ. test_routing_probe يثبت هنا أن التعداد
يرى المسارات فعلاً (§11.4: سلوك المكتبة يُقاس بمسبار).
"""
from __future__ import annotations

HTTP_METHODS = {"get", "post", "put", "patch", "delete"}
AUDIENCE_PREFIXES = {"customer": "/api/customer", "supplier": "/api/supplier", "driver": "/api/driver",
                     "admin": "/api/admin"}


def operations(app, prefix: str) -> list[tuple[str, str]]:
    """(method, path) لكل عملية تحت البادئة."""
    out = []
    for path, ops in app.openapi()["paths"].items():
        if path == prefix or path.startswith(prefix + "/"):
            out += [(m.upper(), path) for m in ops if m in HTTP_METHODS]
    return sorted(out)
