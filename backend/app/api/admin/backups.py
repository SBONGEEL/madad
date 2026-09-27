"""اللوحة — النسخ الاحتياطية (§12-ي ن-3). المالك وحده: السياسة والقائمة والتنزيل.

القاعدة تفرض ذلك أيضاً: السياسة (trg_backup_policy_before) والتنزيل (trg_backup_download_before)
للمالك وحده مهما كانت صلاحيات المشرف، وكل تنزيل يُسجَّل قبل أن يبدأ. الملف مشفّر كما هو في مكانه؛
كلمة السر لا تمرّ بالخلفية أبداً.
"""
from __future__ import annotations

import tempfile
from pathlib import Path

from fastapi import APIRouter, Depends, Request
from fastapi.responses import FileResponse
from starlette.background import BackgroundTask

from app.api.admin.common import P
from app.api.deps import Principal, admin_user
from app.core.db import Tx
from app.core.errors import ApiError
from app.schemas.admin import BackupPolicyIn, BackupPolicyOut, BackupRunOut, BackupsOut
from app.services.s3 import S3

router = APIRouter()


def _offsite(request: Request) -> S3:
    s = request.app.state.settings
    return S3(s.backup_s3_endpoint, s.backup_s3_region, s.backup_s3_bucket, s.backup_s3_access_key, s.backup_s3_secret_key,
              transport=getattr(request.app.state, "s3_transport", None))


async def _backups(t: Tx, request: Request) -> BackupsOut:
    pol = await t.one("SELECT b.plan::text AS plan, b.location::text AS location, b.effective_from AS at, "
                      "coalesce(u.full_name, 'النظام') AS by FROM current_backup_policy() b "
                      "LEFT JOIN app_users u ON u.id = b.set_by")
    alert = await t.one("SELECT kind, since FROM backup_alert()")
    rows = await t.all("SELECT id, started_at, finished_at, status, kind, location::text AS location, file_name, byte_size, "
                       "local_ok, offsite_ok, error, status = 'ok' AND pruned_at IS NULL AS downloadable FROM backup_runs "
                       "WHERE pruned_at IS NULL OR started_at > now() - interval '90 days' ORDER BY started_at DESC, id DESC LIMIT 60")
    return BackupsOut(policy=BackupPolicyOut(**pol), alert=alert["kind"], alert_since=alert["since"],
                      offsite_configured=_offsite(request).configured, runs=[BackupRunOut(**r) for r in rows])


@router.get("/backups", response_model=BackupsOut, **P("owner"))
async def backups(request: Request, p: Principal = Depends(admin_user)) -> BackupsOut:
    async with request.app.state.db.tx("admin", p.user_id) as t:
        return await _backups(t, request)


@router.put("/backups/policy", response_model=BackupsOut, **P("owner"))
async def set_policy(body: BackupPolicyIn, request: Request, p: Principal = Depends(admin_user)) -> BackupsOut:
    """يسري من النسخة التالية (والمدة على ما يُحذف بعدها)."""
    async with request.app.state.db.tx("admin", p.user_id) as t:
        await t.run("INSERT INTO backup_policies (plan, location) VALUES (CAST(:p AS backup_plan), CAST(:l AS backup_location))",
                    p=body.plan, l=body.location)
        return await _backups(t, request)


@router.get("/backups/{run_id}/download", response_class=FileResponse, **P("owner"),
            responses={200: {"content": {"application/octet-stream": {}}}})
async def download(run_id: int, request: Request, p: Principal = Depends(admin_user)) -> FileResponse:
    """النسخة كما هي (مشفّرة) إلى جهاز المالك: من الخادم إن كانت فيه، وإلا من المساحة المنفصلة."""
    async with request.app.state.db.tx("admin", p.user_id) as t:
        r = await t.one("SELECT file_name, local_ok, offsite_ok FROM backup_runs WHERE id = :i", i=run_id)
        if r is None:
            raise ApiError(404, "backup_not_found")
        await t.run("INSERT INTO backup_downloads (run_id) VALUES (:i)", i=run_id)   # المالك وحده، ويُسجَّل
    local = Path(request.app.state.settings.backup_dir) / r["file_name"]
    if r["local_ok"] and local.is_file():
        return FileResponse(local, media_type="application/octet-stream", filename=r["file_name"])
    off = _offsite(request)
    if not (r["offsite_ok"] and off.configured):
        raise ApiError(404, "backup_file_missing")
    tmp = Path(tempfile.mkdtemp()) / r["file_name"]
    await off.get_file(r["file_name"], tmp)
    return FileResponse(tmp, media_type="application/octet-stream", filename=r["file_name"],
                        background=BackgroundTask(lambda: (tmp.unlink(missing_ok=True), tmp.parent.rmdir())))
