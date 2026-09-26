"""خدمة الرفع الواحدة (§2.1): لا صورة نصّاً في القاعدة — الملف في المخزن، وفي media_files سجلّه.

النوع يُعرف من بايتات الملف لا من اسمه ولا مما يعلنه المتصفح، والحدّ 10 ميغابايت (القيد نفسه في القاعدة).
الخاصّ (الهوية، الرخصة، السجل، الواجهة، صور النزاع والاستلام) للّوحة وحدها؛ العامّ صور العروض والأصناف.
"""
from __future__ import annotations

import hashlib
import uuid
from pathlib import Path

from app.core.errors import ApiError

MAX_BYTES = 10 * 1024 * 1024
PURPOSES = {
    "customer": {"facade", "commercial_register", "dispute_photo"},
    "supplier": {"owner_id", "commercial_register", "offer_photo"},
    "driver": {"driver_id", "driver_license", "driver_license_back", "driver_photo", "pickup_photo", "dispute_photo"},
}
PUBLIC = {"offer_photo"}
_EXT = {"image/jpeg": ".jpg", "image/png": ".png", "image/webp": ".webp", "application/pdf": ".pdf"}


def sniff(data: bytes) -> str:
    if data[:3] == b"\xff\xd8\xff":
        return "image/jpeg"
    if data[:8] == b"\x89PNG\r\n\x1a\n":
        return "image/png"
    if data[:4] == b"RIFF" and data[8:12] == b"WEBP":
        return "image/webp"
    if data[:5] == b"%PDF-":
        return "application/pdf"
    raise ApiError(422, "media_type_unsupported")


class Store:
    """المخزن المحلي. storage_key مسار نسبي عشوائي — لا يُشتق من اسم الملف ولا من صاحبه."""

    def __init__(self, root: str) -> None:
        self.root = Path(root)

    def put(self, data: bytes) -> tuple[str, str, int, str]:
        if not data:
            raise ApiError(422, "media_empty")
        if len(data) > MAX_BYTES:
            raise ApiError(413, "media_too_large")
        mime = sniff(data)
        key = f"{uuid.uuid4().hex[:2]}/{uuid.uuid4().hex}{_EXT[mime]}"
        path = self.root / key
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(data)
        return key, mime, len(data), hashlib.sha256(data).hexdigest()

    def get(self, key: str) -> bytes:
        path = (self.root / key).resolve()
        if self.root.resolve() not in path.parents or not path.is_file():
            raise ApiError(404, "media_not_found")
        return path.read_bytes()
