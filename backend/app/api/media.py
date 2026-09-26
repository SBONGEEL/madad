"""الوسائط العامة وحدها (صور الأصناف والعروض): بلا دخول، ولا يمرّ منها خاصّ أبداً.

الخاصّ (الهوية، الرخصة، السجل، الواجهة، صور النزاع والاستلام) للّوحة وحدها عبر /api/admin/media.
"""
from __future__ import annotations

from fastapi import APIRouter, Request, Response

from app.core.errors import ApiError

router = APIRouter(prefix="/api/media", tags=["media"])


@router.get("/{media_id}", response_class=Response, responses={200: {"content": {"image/*": {}}}})
async def public_media(media_id: int, request: Request) -> Response:
    async with request.app.state.db.tx("system") as t:
        row = await t.one("SELECT storage_key, mime_type FROM media_files WHERE id = :i AND NOT is_private", i=media_id)
    if row is None:
        raise ApiError(404, "media_not_found")
    return Response(request.app.state.media.get(row["storage_key"]), media_type=row["mime_type"],
                    headers={"Cache-Control": "public, max-age=86400"})
