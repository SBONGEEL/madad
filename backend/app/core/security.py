"""كلمات المرور (bcrypt وحده — م-14)، ورموز الوصول والتجديد، وتجزئة رموز التحقق."""
from __future__ import annotations

import hashlib
import hmac
import secrets
from datetime import datetime, timedelta, timezone
from typing import Any

import bcrypt
import jwt

ALG = "HS256"
PASSWORD_MIN = 8


def hash_password(password: str) -> str:
    return bcrypt.hashpw(password.encode(), bcrypt.gensalt(rounds=12)).decode()


def verify_password(password: str, hashed: str | None) -> bool:
    if not hashed:
        return False
    return bcrypt.checkpw(password.encode(), hashed.encode())


def otp_hash(secret: str, phone: str, audience: str, code: str) -> str:
    return hmac.new(secret.encode(), f"{phone}|{audience}|{code}".encode(), hashlib.sha256).hexdigest()


def new_otp_code() -> str:
    return f"{secrets.randbelow(1_000_000):06d}"


def token_hash(token: str) -> str:
    return hashlib.sha256(token.encode()).hexdigest()


def new_refresh_token() -> str:
    return secrets.token_urlsafe(32)


def _now() -> datetime:
    return datetime.now(timezone.utc)


def sign(secret: str, *, typ: str, ttl: timedelta, **claims: Any) -> str:
    now = _now()
    return jwt.encode({**claims, "typ": typ, "iat": now, "exp": now + ttl}, secret, algorithm=ALG)


def read(secret: str, token: str, *, typ: str) -> dict[str, Any]:
    """يرفع jwt.PyJWTError عند أي خلل: توقيع، انتهاء، أو نوع غير المتوقع."""
    claims = jwt.decode(token, secret, algorithms=[ALG], options={"require": ["exp", "iat", "typ"]})
    if claims.get("typ") != typ:
        raise jwt.InvalidTokenError(f"expected {typ}")
    return claims


def new_temp_password() -> str:
    """كلمة مؤقتة تُملى هاتفياً: 10 أحرف بلا ما يلتبس (0/O، 1/l)."""
    alphabet = "abcdefghjkmnpqrstuvwxyz23456789"
    return "".join(secrets.choice(alphabet) for _ in range(10))
