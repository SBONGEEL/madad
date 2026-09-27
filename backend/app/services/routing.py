"""طول المسار وموعد الوصول من Mapbox Directions (§12-ي ن-5).

لا يُرسل إلا الإحداثيات بالترتيب — لا اسم ولا هاتف ولا عنوان. غياب الرمز أو تعطّل الخدمة
يُعاد حالةً صريحة (Unavailable) تعرضها الشاشة تنبيهاً وتعود للإدخال اليدوي — لا احتياط صامت.
"""
from __future__ import annotations

import logging
from dataclasses import dataclass
from decimal import ROUND_HALF_UP, Decimal

import httpx

log = logging.getLogger("madad.routing")


class Unavailable(Exception):
    def __init__(self, reason: str) -> None:   # no_key | error
        super().__init__(reason)
        self.reason = reason


@dataclass
class Route:
    km: Decimal
    seconds: int


class Router:
    def __init__(self, token: str, base: str, transport: httpx.AsyncBaseTransport | None = None) -> None:
        self.token, self.base, self.transport = token, base.rstrip("/"), transport

    @property
    def configured(self) -> bool:
        return bool(self.token)

    async def route(self, points: list[tuple[float, float]]) -> Route:
        """points: (lat, lng) بالترتيب. Mapbox يأخذها lng,lat."""
        if not self.token:
            raise Unavailable("no_key")
        if len(points) < 2:
            raise Unavailable("error")
        coords = ";".join(f"{float(lng):.6f},{float(lat):.6f}" for lat, lng in points)
        try:
            async with httpx.AsyncClient(transport=self.transport, timeout=8.0) as c:
                r = await c.get(f"{self.base}/directions/v5/mapbox/driving/{coords}",
                                params={"access_token": self.token, "overview": "false", "alternatives": "false"})
            r.raise_for_status()
            best = r.json()["routes"][0]
            km = (Decimal(str(best["distance"])) / 1000).quantize(Decimal("0.01"), ROUND_HALF_UP)
            return Route(km=km, seconds=int(best["duration"]))
        except (httpx.HTTPError, KeyError, IndexError, ValueError, TypeError) as e:
            log.warning("mapbox unavailable: %s", type(e).__name__)
            raise Unavailable("error") from None
