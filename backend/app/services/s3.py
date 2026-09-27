"""عميل S3 الأدنى (توقيع AWS SigV4 بـhttpx) لمساحة النسخ الاحتياطية المنفصلة (§12-ي ن-3).

يكفي Cloudflare R2 وBackblaze B2 وأي خدمة S3-متوافقة: رفع وتنزيل وحذف كائن. لا حزمة جديدة (§14).
المفتاحان من بيئة الخادم وحدها، ولا يُسجَّل منهما شيء.
"""
from __future__ import annotations

import hashlib
import hmac
from datetime import datetime, timezone
from pathlib import Path
from typing import AsyncIterator
from urllib.parse import quote, urlsplit

import httpx

UNSIGNED = "UNSIGNED-PAYLOAD"


def _h(b: bytes) -> str:
    return hashlib.sha256(b).hexdigest()


def _hmac(key: bytes, msg: str) -> bytes:
    return hmac.new(key, msg.encode(), hashlib.sha256).digest()


def sign(method: str, url: str, headers: dict[str, str], payload_hash: str, *, access_key: str, secret_key: str,
         region: str, now: datetime, service: str = "s3") -> dict[str, str]:
    """ترويسات موقّعة (SigV4). headers تُوقَّع كلها مع host وx-amz-date وx-amz-content-sha256."""
    u = urlsplit(url)
    amz_date = now.strftime("%Y%m%dT%H%M%SZ")
    day = amz_date[:8]
    h = {k.lower(): v.strip() for k, v in headers.items()}
    h.update({"host": u.netloc, "x-amz-date": amz_date, "x-amz-content-sha256": payload_hash})
    names = sorted(h)
    canonical = "\n".join([
        method, quote(u.path or "/", safe="/-_.~"),
        "&".join(f"{quote(k, safe='-_.~')}={quote(v, safe='-_.~')}"
                 for k, v in sorted(p.split("=", 1) if "=" in p else (p, "") for p in u.query.split("&") if p)),
        "".join(f"{k}:{h[k]}\n" for k in names), ";".join(names), payload_hash])
    scope = f"{day}/{region}/{service}/aws4_request"
    to_sign = "\n".join(["AWS4-HMAC-SHA256", amz_date, scope, _h(canonical.encode())])
    key = _hmac(_hmac(_hmac(_hmac(f"AWS4{secret_key}".encode(), day), region), service), "aws4_request")
    sig = hmac.new(key, to_sign.encode(), hashlib.sha256).hexdigest()
    out = {k: v for k, v in h.items() if k != "host"}
    out["authorization"] = (f"AWS4-HMAC-SHA256 Credential={access_key}/{scope}, SignedHeaders={';'.join(names)}, "
                            f"Signature={sig}")
    return out


class S3:
    def __init__(self, endpoint: str, region: str, bucket: str, access_key: str, secret_key: str,
                 transport: httpx.AsyncBaseTransport | None = None) -> None:
        self.endpoint, self.region, self.bucket = endpoint.rstrip("/"), region, bucket
        self.access_key, self.secret_key, self.transport = access_key, secret_key, transport

    @property
    def configured(self) -> bool:
        return all((self.endpoint, self.bucket, self.access_key, self.secret_key))

    def _url(self, key: str) -> str:
        return f"{self.endpoint}/{self.bucket}/{quote(key, safe='/-_.~')}"

    def _headers(self, method: str, key: str, extra: dict[str, str] | None = None, payload: str = UNSIGNED) -> dict[str, str]:
        return sign(method, self._url(key), extra or {}, payload, access_key=self.access_key, secret_key=self.secret_key,
                    region=self.region, now=datetime.now(timezone.utc))

    def _client(self) -> httpx.AsyncClient:
        return httpx.AsyncClient(transport=self.transport, timeout=httpx.Timeout(60.0, read=600.0))

    async def put_file(self, key: str, path: Path) -> None:
        size = path.stat().st_size

        async def body() -> AsyncIterator[bytes]:
            with path.open("rb") as f:
                while chunk := f.read(1 << 20):
                    yield chunk

        extra = {"content-length": str(size), "content-type": "application/octet-stream"}
        async with self._client() as c:
            r = await c.put(self._url(key), content=body(), headers=self._headers("PUT", key, extra))
        r.raise_for_status()

    async def get_file(self, key: str, path: Path) -> None:
        async with self._client() as c, c.stream("GET", self._url(key), headers=self._headers("GET", key)) as r:
            r.raise_for_status()
            with path.open("wb") as f:
                async for chunk in r.aiter_bytes(1 << 20):
                    f.write(chunk)

    async def delete(self, key: str) -> None:
        async with self._client() as c:
            r = await c.delete(self._url(key), headers=self._headers("DELETE", key))
        if r.status_code not in (200, 204, 404):
            r.raise_for_status()
