"""ن-3 (§12-ي): اختبار استرجاع حقيقي — نسخة من قاعدة حية بصورها، مشفّرة، تُسترجع في قاعدة نظيفة
وتُقارَن بالأصل جدولاً جدولاً وصورةً صورة. ومعه: كلمة سر خاطئة، وملف مُعدَّل أو مبتور، ومكان الحفظ ومدته.
"""
from __future__ import annotations

import hashlib
import uuid
from datetime import datetime, timezone
from pathlib import Path

import asyncpg
import httpx
import pytest

from app.core.db import Db
from app.services import backup
from app.services.s3 import S3, sign
from tests.conftest import _drop, _dsn, _recreate
from tests.db.world import act, build, collect_all, confirm_and_assign, draft, place

PASS = "كلمة سر تجريبية طويلة 2026"   # للاختبار وحده
FAST = 12                              # scrypt أخف في الاختبار؛ الإنتاج 17 (الملف يحمل معامله)


async def _live(db, tmp_path: Path) -> tuple[str, Path]:
    w = await build(db)
    oid = await draft(db, w)
    await place(db, w, oid)
    await confirm_and_assign(db, w, oid)
    await collect_all(db, w, oid)
    media = tmp_path / "media"
    for i in range(3):
        p = media / f"a{i}" / f"{uuid.uuid4().hex}.jpg"
        p.parent.mkdir(parents=True, exist_ok=True)
        p.write_bytes(b"\xff\xd8\xff" + bytes([i]) * 5000)
    return _dsn(await db.fetchval("SELECT current_database()")), media


async def _fp(dsn: str) -> dict:
    c = await asyncpg.connect(dsn)
    try:
        async with c.transaction():
            return await backup.fingerprint(c)
    finally:
        await c.close()


@pytest.fixture
async def clean_db():
    name = "madad_rs_" + uuid.uuid4().hex[:10]
    await _recreate(name)
    yield _dsn(name)
    await _drop(name)


async def test_backup_restores_into_a_clean_database_identical_to_the_original(db, tmp_path, clean_db):
    dsn, media = await _live(db, tmp_path)
    out = tmp_path / "b.mdbk"
    manifest = await backup.make_archive(dsn, media, out, PASS, log2n=FAST)
    assert manifest["tables"]["madad.orders"][0] == 1 and len(manifest["media"]) == 3
    assert b"CUSTOMER_LEAK_CANARY" not in out.read_bytes()          # مشفّرة فعلاً
    restored_media = tmp_path / "restored"
    await backup.restore(out, PASS, clean_db, restored_media)
    # المقارنة بالأصل مباشرة، لا بالبصمات المحفوظة وحدها
    assert await _fp(clean_db) == await _fp(dsn)
    for p in media.rglob("*.jpg"):
        assert (restored_media / p.relative_to(media)).read_bytes() == p.read_bytes()
    # القاعدة المسترجعة تعمل: مشغّلاتها ومسار البحث فيها
    c = await asyncpg.connect(clean_db)
    try:
        assert await c.fetchval("SELECT count(*) FROM orders") == 1
        await act(c, "customer", await c.fetchval("SELECT user_id FROM customer_members LIMIT 1"))
        with pytest.raises(asyncpg.PostgresError):
            await c.execute("UPDATE orders SET route_km = 1")
    finally:
        await c.close()


async def test_wrong_passphrase_tampering_and_truncation_are_refused(db, tmp_path, clean_db):
    dsn, media = await _live(db, tmp_path)
    out = tmp_path / "b.mdbk"
    await backup.make_archive(dsn, media, out, PASS, log2n=FAST)
    with pytest.raises(backup.BackupError, match="wrong_passphrase_or_damaged"):
        backup.decrypt_file(out, tmp_path / "x.tar", "غير صحيحة")
    raw = bytearray(out.read_bytes())
    raw[len(raw) // 2] ^= 1
    (tmp_path / "t.mdbk").write_bytes(bytes(raw))
    with pytest.raises(backup.BackupError, match="wrong_passphrase_or_damaged"):
        backup.decrypt_file(tmp_path / "t.mdbk", tmp_path / "x.tar", PASS)
    # بتر عند حدّ قطعة: القطعة الباقية ليست «الأخيرة» فلا تُقبل
    whole = out.read_bytes()
    first = 8 + 32 + 4 + int.from_bytes(whole[40:44], "big")
    (tmp_path / "c.mdbk").write_bytes(whole[:first])
    if first < len(whole):
        with pytest.raises(backup.BackupError):
            backup.decrypt_file(tmp_path / "c.mdbk", tmp_path / "x.tar", PASS)
    with pytest.raises(backup.BackupError, match="passphrase_missing"):
        await backup.make_archive(dsn, media, tmp_path / "n.mdbk", "", log2n=FAST)


async def test_restore_refuses_a_database_that_already_has_madad(db, tmp_path):
    dsn, media = await _live(db, tmp_path)
    out = tmp_path / "b.mdbk"
    await backup.make_archive(dsn, media, out, PASS, log2n=FAST)
    with pytest.raises(backup.BackupError, match="target_not_empty"):
        await backup.restore(out, PASS, dsn, None)


def test_multichunk_roundtrip(tmp_path):
    src = tmp_path / "s"
    src.write_bytes(bytes(range(256)) * (3 * backup.CHUNK // 256 + 7))
    backup.encrypt_file(src, tmp_path / "e", PASS, log2n=FAST)
    backup.decrypt_file(tmp_path / "e", tmp_path / "d", PASS)
    assert (tmp_path / "d").read_bytes() == src.read_bytes()


# ——— مكان الحفظ ومدته ————————————————————————————————————————————————————————————————
class FakeS3(httpx.AsyncBaseTransport):
    def __init__(self, fail: bool = False) -> None:
        self.objects: dict[str, bytes] = {}
        self.fail = fail
        self.auth: list[str] = []

    async def handle_async_request(self, request: httpx.Request) -> httpx.Response:
        self.auth.append(request.headers.get("authorization", ""))
        key = request.url.path.split("/", 2)[2]
        if self.fail:
            return httpx.Response(503)
        if request.method == "PUT":
            self.objects[key] = await request.aread()
            return httpx.Response(200)
        if request.method == "GET":
            return httpx.Response(200, content=self.objects[key]) if key in self.objects else httpx.Response(404)
        self.objects.pop(key, None)
        return httpx.Response(204)


def _s3(t: FakeS3) -> S3:
    return S3("https://r2.test", "auto", "madad-backups", "AKTEST", "secret-test", transport=t)


async def _setup(db, tmp_path, location: str):
    dsn, media = await _live(db, tmp_path)
    await act(db, "admin", await db.fetchval("SELECT user_id FROM admin_members WHERE role = 'owner'"))
    await db.execute("INSERT INTO backup_policies (plan, location) VALUES ('daily7_weekly12', $1)", location)
    return dsn, media, Db(dsn.replace("postgresql://", "postgresql+asyncpg://"))


async def test_both_places_then_download_the_offsite_copy(db, tmp_path):
    dsn, media, dbx = await _setup(db, tmp_path, "both")
    fake = FakeS3()
    places = backup.Places(tmp_path / "local", _s3(fake))
    try:
        rid = await backup.run_once(dbx, dsn, media, places, PASS, log2n=FAST)
    finally:
        await dbx.close()
    r = await db.fetchrow("SELECT status, kind, file_name, sha256, local_ok, offsite_ok FROM backup_runs WHERE id = $1", rid)
    assert (r["status"], r["kind"], r["local_ok"], r["offsite_ok"]) == ("ok", "weekly", True, True)
    local = (tmp_path / "local" / r["file_name"]).read_bytes()
    assert fake.objects[r["file_name"]] == local and hashlib.sha256(local).hexdigest() == r["sha256"]
    assert all(a.startswith("AWS4-HMAC-SHA256 Credential=AKTEST/") for a in fake.auth)
    got = tmp_path / "dl.mdbk"
    await _s3(fake).get_file(r["file_name"], got)
    assert got.read_bytes() == local


async def test_offsite_failure_fails_the_run_and_leaves_no_partial_copy(db, tmp_path):
    dsn, media, dbx = await _setup(db, tmp_path, "both")
    places = backup.Places(tmp_path / "local", _s3(FakeS3(fail=True)))
    try:
        rid = await backup.run_once(dbx, dsn, media, places, PASS, log2n=FAST)
    finally:
        await dbx.close()
    r = await db.fetchrow("SELECT status, error FROM backup_runs WHERE id = $1", rid)
    assert r["status"] == "failed" and "HTTPStatusError" in r["error"]
    assert not list((tmp_path / "local").glob("*.mdbk"))
    assert await db.fetchval("SELECT (backup_alert()).kind") == "failed"


async def test_missing_passphrase_or_offsite_is_a_failure_not_a_plain_copy(db, tmp_path):
    dsn, media, dbx = await _setup(db, tmp_path, "offsite")
    try:
        r1 = await backup.run_once(dbx, dsn, media, backup.Places(tmp_path / "l", _s3(FakeS3())), "", log2n=FAST)
        r2 = await backup.run_once(dbx, dsn, media, backup.Places(tmp_path / "l", S3("", "auto", "", "", "")), PASS, log2n=FAST)
    finally:
        await dbx.close()
    errs = [await db.fetchval("SELECT error FROM backup_runs WHERE id = $1", r) for r in (r1, r2)]
    assert errs == ["passphrase_missing", "offsite_not_configured"]
    assert not list((tmp_path / "l").glob("*"))


async def test_retention_keeps_weekly_longer_and_never_the_last_good_copy(db, tmp_path):
    await build(db)
    await act(db, "system")
    local = tmp_path / "local"
    local.mkdir()
    ids = {}
    for label, kind, days in (("d_old", "daily", 9), ("d_new", "daily", 3), ("w_old", "weekly", 90), ("w_mid", "weekly", 30)):
        name = f"madad-2026{len(ids) + 1:04d}-030000.mdbk"
        (local / name).write_bytes(b"x")
        ids[label] = await db.fetchval(
            "INSERT INTO backup_runs (kind, plan, location, status, finished_at, file_name, byte_size, sha256, local_ok) "
            "VALUES ($1, 'daily7_weekly12', 'local', 'ok', now() - make_interval(days => $2), $3, 1, repeat('a', 64), true) "
            "RETURNING id", kind, days, name)
    dbx = Db(_dsn(await db.fetchval("SELECT current_database()")).replace("postgresql://", "postgresql+asyncpg://"))
    try:
        gone = await backup.prune(dbx, backup.Places(local, None))
    finally:
        await dbx.close()
    assert sorted(gone) == sorted([ids["d_old"], ids["w_old"]])
    assert len(list(local.glob("*.mdbk"))) == 2


async def test_last_good_copy_survives_retention(db, tmp_path):
    await build(db)
    await act(db, "system")
    rid = await db.fetchval(
        "INSERT INTO backup_runs (kind, plan, location, status, finished_at, file_name, byte_size, sha256, local_ok) "
        "VALUES ('daily', 'daily7_weekly12', 'local', 'ok', now() - interval '60 days', 'madad-20260101-030000.mdbk', 1, "
        "repeat('a', 64), true) RETURNING id")
    dbx = Db(_dsn(await db.fetchval("SELECT current_database()")).replace("postgresql://", "postgresql+asyncpg://"))
    try:
        assert await backup.prune(dbx, backup.Places(tmp_path, None)) == []
    finally:
        await dbx.close()
    assert await db.fetchval("SELECT pruned_at FROM backup_runs WHERE id = $1", rid) is None


def test_sigv4_matches_the_aws_worked_example():
    """مثال AWS الموثّق (GET Object مع Range)."""
    h = sign("GET", "https://examplebucket.s3.amazonaws.com/test.txt", {"Range": "bytes=0-9"},
             "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
             access_key="AKIAIOSFODNN7EXAMPLE", secret_key="wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
             region="us-east-1", now=datetime(2013, 5, 24, tzinfo=timezone.utc))
    assert h["authorization"].endswith("Signature=f0e8bdb87c964420e857bd35b5d6ed310bd44f0170aba48dd91039c6036bdb41")
    assert "SignedHeaders=host;range;x-amz-content-sha256;x-amz-date" in h["authorization"]
