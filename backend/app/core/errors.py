"""أخطاء بأسماء ثابتة. رسالة المشغّل تبدأ باسم القاعدة (pickup_code_mismatch…)، فتصل
إلى الواجهة كما هي في الحقل code، وتترجمها الواجهة إلى عربية بسيطة.
"""
from __future__ import annotations

import re

from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse
from sqlalchemy.exc import DBAPIError

# sqlstate → رمز HTTP
_STATUS = {
    "42501": 403,  # insufficient_privilege: الدور أو الصلاحية
    "23514": 409,  # check_violation: قاعدة
    "23505": 409,  # unique_violation
    "23503": 409,  # foreign_key_violation
    "23502": 422,  # not_null_violation
    "P0001": 409,  # raise_exception
    "22023": 422,  # invalid_parameter_value
}
_CODE = re.compile(r"^([a-z][a-z0-9_]*)")


class ApiError(Exception):
    def __init__(self, status: int, code: str, **extra: object) -> None:
        super().__init__(code)
        self.status, self.code, self.extra = status, code, extra


def _db_parts(exc: DBAPIError) -> tuple[str | None, str]:
    orig = exc.orig
    cause = getattr(orig, "__cause__", None) or orig
    sqlstate = getattr(cause, "sqlstate", None) or getattr(orig, "sqlstate", None)
    message = getattr(cause, "message", None) or str(cause)
    return sqlstate, message


def install(app: FastAPI) -> None:
    @app.exception_handler(ApiError)
    async def _api(_: Request, exc: ApiError) -> JSONResponse:
        return JSONResponse({"code": exc.code, **exc.extra}, status_code=exc.status)

    @app.exception_handler(DBAPIError)
    async def _db(_: Request, exc: DBAPIError) -> JSONResponse:
        sqlstate, message = _db_parts(exc)
        status = _STATUS.get(sqlstate or "")
        if status is None:
            raise exc  # خطأ غير متوقع: يسقط 500 بتتبّعه، لا يُلبَس رمزاً مهذّباً
        # قيد مسمّى يصل باسمه لا بنصّ Postgres؛ وخطأ المشغّل يصل بأول كلمة في رسالته
        constraint = getattr(getattr(exc.orig, "__cause__", None), "constraint_name", None)
        m = _CODE.match(message)
        code = constraint or (m.group(1) if m else "db_error")
        return JSONResponse({"code": code}, status_code=status)
