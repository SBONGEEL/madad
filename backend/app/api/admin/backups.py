"""اللوحة — النسخ الاحتياطية (§12-ي ن-3، §12-ك ٢). المالك وحده: السياسة والتنزيل وسجل الوصول.
صلاحيتان يمنحهما المالك وحده لمشرف بعينه: «عرض حالة النسخ» (backups_view) و«إنشاء نسخة الآن» (backups_run).

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
from app.schemas.admin import (BackupAccessOut, BackupPolicyIn, BackupPolicyOut, BackupRequestOut, BackupRunOut, BackupStatusOut,
                               BackupsOut)
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
    await t.run("INSERT INTO backup_access_log (action) VALUES ('view')")        # كل عرض يُسجَّل
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


# ——— §12-ك: عرض الحالة، وإنشاء نسخة الآن، وسجل الوصول ——————————————————————————————————
@router.get("/backups/status", response_model=BackupStatusOut, **P("backups_view"))
async def backup_status(request: Request, p: Principal = Depends(admin_user)) -> BackupStatusOut:
    """الحالة والسجل والتنبيهات، بلا تنزيل ولا إعدادات. العرض يُسجَّل، والقاعدة ترفضه بلا الصلاحية."""
    async with request.app.state.db.tx("admin", p.user_id) as t:
        b = await _backups(t, request)
    runs = [r.model_copy(update={"downloadable": False}) for r in b.runs]
    return BackupStatusOut(plan=b.policy.plan, location=b.policy.location, alert=b.alert, alert_since=b.alert_since, runs=runs)


@router.post("/backups/run", response_model=BackupRequestOut, status_code=202, **P("backups_run"))
async def backup_now(request: Request, p: Principal = Depends(admin_user)) -> BackupRequestOut:
    """طلب نسخة الآن: يأخذه عامل النسخ خلال دقيقة (الخلفية لا تملك كلمة السر). طلب والأول لم ينتهِ ← backup_in_progress."""
    async with request.app.state.db.tx("admin", p.user_id) as t:
        at = await t.val("INSERT INTO backup_requests (requested_by) VALUES (:u) RETURNING at", u=p.user_id)
    return BackupRequestOut(requested_at=at)


@router.get("/backups/access", response_model=list[BackupAccessOut], **P("owner"))
async def backup_access(request: Request, p: Principal = Depends(admin_user)) -> list[BackupAccessOut]:
    async with request.app.state.db.tx("admin", p.user_id) as t:
        rows = await t.all("SELECT l.at, coalesce(u.full_name, u.phone) AS who, l.action, r.file_name FROM backup_access_log l "
                           "JOIN app_users u ON u.id = l.user_id LEFT JOIN backup_runs r ON r.id = l.run_id "
                           "ORDER BY l.at DESC, l.id DESC LIMIT 200")
    return [BackupAccessOut(**r) for r in rows]
