"""هوية الطالب. الرمز يحمل جمهوره، وموجّه كل جمهور لا يقبل إلا رمز جمهوره."""
from __future__ import annotations

from dataclasses import dataclass

import jwt
from fastapi import Depends, Request
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer

from app.core import security
from app.core.db import Db
from app.core.errors import ApiError

_bearer = HTTPBearer(auto_error=False)


@dataclass(frozen=True)
class Principal:
    user_id: int
    audience: str


def db(request: Request) -> Db:
    return request.app.state.db


def audience(expected: str):
    async def dependency(request: Request,
                         cred: HTTPAuthorizationCredentials | None = Depends(_bearer)) -> Principal:
        if cred is None:
            raise ApiError(401, "unauthenticated")
        try:
            claims = security.read(request.app.state.settings.jwt_secret, cred.credentials, typ="access")
        except jwt.ExpiredSignatureError:
            raise ApiError(401, "access_expired") from None
        except jwt.PyJWTError:
            raise ApiError(401, "token_invalid") from None
        if claims.get("au") != expected:
            raise ApiError(403, "wrong_audience")
        return Principal(int(claims["sub"]), expected)

    return dependency


customer_user = audience("customer")
supplier_user = audience("supplier")
driver_user = audience("driver")
admin_user = audience("admin")
