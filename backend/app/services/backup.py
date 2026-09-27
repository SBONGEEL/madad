"""النسخ الاحتياطية (§12-ي ن-3): القاعدة والصور في ملف واحد مشفّر، محلياً و/أو في مساحة منفصلة.

الملف (.mdbk): tar فيه manifest.json وdb.dump (pg_dump بصيغته المخصّصة) وmedia/، مشفّراً كلّه بـAES-256-GCM
على قطع (كل قطعة برقم تسلسلي وعلَم «الأخيرة»: لا تبديل ولا حذف ولا بتر يمرّ)، والمفتاح من كلمة سر المالك
بـscrypt وملح عشوائي لكل ملف. كلمة السر في بيئة خدمة النسخ وحدها: لا مستودع ولا قاعدة ولا سجل.

manifest.json يحمل عدد صفوف كل جدول وبصمته، مأخوذة من لقطة pg_dump نفسها (pg_export_snapshot)، فالاسترجاع
يُقارَن بالأصل صفاً صفاً: نسخة لا تطابق بصمتها لا تُعدّ مسترجعة.
"""
from __future__ import annotations

import asyncio
import hashlib
import json
import logging
import os
import secrets
import shutil
import struct
import tarfile
import tempfile
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from pathlib import Path
from urllib.parse import unquote, urlsplit
from zoneinfo import ZoneInfo

import asyncpg
from cryptography.exceptions import InvalidTag
from cryptography.hazmat.primitives.ciphers.aead import AESGCM
from cryptography.hazmat.primitives.kdf.scrypt import Scrypt

log = logging.getLogger("madad.backup")
TRIPOLI = ZoneInfo("Africa/Tripoli")
MAGIC = b"MADADBK1"
CHUNK = 1 << 20
SCHEMAS = ("madad", "public")


class BackupError(Exception):
    """سبب قصير يُكتب في backup_runs.error — بلا سرّ."""


# ═══ التشفير ═══════════════════════════════════════════════════════════════════
def _key(passphrase: str, salt: bytes, log2n: int, r: int, p: int) -> bytes:
    if not passphrase:
        raise BackupError("passphrase_missing")
    return Scrypt(salt=salt, length=32, n=1 << log2n, r=r, p=p).derive(passphrase.encode())


def _nonce(i: int, last: bool) -> bytes:
    return i.to_bytes(11, "big") + (b"\x01" if last else b"\x00")


def encrypt_file(src: Path, dst: Path, passphrase: str, *, log2n: int = 17) -> None:
    salt = secrets.token_bytes(16)
    header = MAGIC + salt + struct.pack(">IIII", log2n, 8, 1, CHUNK)
    aead = AESGCM(_key(passphrase, salt, log2n, 8, 1))
    with src.open("rb") as fin, dst.open("wb") as fout:
        fout.write(header)
        i, cur = 0, fin.read(CHUNK)
        while True:
            nxt = fin.read(CHUNK)
            ct = aead.encrypt(_nonce(i, not nxt), cur, header)
            fout.write(struct.pack(">I", len(ct)) + ct)
            if not nxt:
                break
            i, cur = i + 1, nxt


def decrypt_file(src: Path, dst: Path, passphrase: str) -> None:
    with src.open("rb") as fin, dst.open("wb") as fout:
        head = fin.read(len(MAGIC) + 16 + 16)
        if len(head) != len(MAGIC) + 32 or not head.startswith(MAGIC):
            raise BackupError("not_a_madad_backup")
        salt = head[len(MAGIC):len(MAGIC) + 16]
        log2n, r, p, chunk = struct.unpack(">IIII", head[len(MAGIC) + 16:])
        if not (10 <= log2n <= 22 and r == 8 and p == 1 and chunk == CHUNK):
            raise BackupError("not_a_madad_backup")
        aead = AESGCM(_key(passphrase, salt, log2n, r, p))

        def record() -> bytes | None:
            n = fin.read(4)
            if not n:
                return None
            if len(n) != 4:
                raise BackupError("backup_truncated")
            ct = fin.read(struct.unpack(">I", n)[0])
            if len(ct) != struct.unpack(">I", n)[0]:
                raise BackupError("backup_truncated")
            return ct

        i, cur = 0, record()
        if cur is None:
            raise BackupError("backup_truncated")
        while cur is not None:
            nxt = record()
            try:
                fout.write(aead.decrypt(_nonce(i, nxt is None), cur, head))
            except InvalidTag:
                # كلمة سر خاطئة، أو ملف مُعدَّل أو مبتور: لا يُفرَّق بينها عمداً
                raise BackupError("wrong_passphrase_or_damaged") from None
            i, cur = i + 1, nxt


def sha256_file(path: Path) -> str:
    h = hashlib.sha256()
    with path.open("rb") as f:
        while b := f.read(CHUNK):
            h.update(b)
    return h.hexdigest()


# ═══ القاعدة: لقطة واحدة للتفريغ وللبصمات ═══════════════════════════════════════════
def plain_dsn(url: str) -> str:
    return url.replace("postgresql+asyncpg://", "postgresql://")


def _pg_env(dsn: str) -> dict[str, str]:
    u = urlsplit(dsn)
    return dict(os.environ, PGHOST=u.hostname or "localhost", PGPORT=str(u.port or 5432), PGUSER=unquote(u.username or ""),
                PGPASSWORD=unquote(u.password or ""), PGDATABASE=u.path.lstrip("/"))


async def fingerprint(conn: asyncpg.Connection) -> dict:
    """عدد الصفوف وبصمة كل جدول، وقيم التسلسلات — في الحركة الجارية (اللقطة)."""
    await conn.execute("SET LOCAL TIME ZONE 'UTC'")
    tables = {}
    for r in await conn.fetch("SELECT schemaname, tablename FROM pg_tables WHERE schemaname = ANY($1::text[]) "
                              "ORDER BY 1, 2", list(SCHEMAS)):
        q = f'"{r["schemaname"]}"."{r["tablename"]}"'
        row = await conn.fetchrow(f"SELECT count(*) AS n, coalesce(md5(string_agg(md5(t::text), '' ORDER BY md5(t::text))), "
                                  f"'') AS h FROM {q} t")
        tables[f'{r["schemaname"]}.{r["tablename"]}'] = [row["n"], row["h"]]
    seqs = {f'{r["schemaname"]}.{r["sequencename"]}': r["last_value"] for r in await conn.fetch(
        "SELECT schemaname, sequencename, last_value FROM pg_sequences WHERE schemaname = ANY($1::text[])", list(SCHEMAS))}
    return {"tables": tables, "sequences": seqs}


async def _proc(*args: str, env: dict[str, str]) -> None:
    p = await asyncio.create_subprocess_exec(*args, env=env, stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE)
    _, err = await p.communicate()
    if p.returncode:
        raise BackupError(f"{args[0]}: {err.decode(errors='replace').strip()[-300:]}")


def _media_files(root: Path) -> list[Path]:
    return sorted(p for p in root.rglob("*") if p.is_file()) if root.is_dir() else []


async def make_archive(dsn: str, media_dir: Path, out: Path, passphrase: str, *, log2n: int = 17) -> dict:
    """ينتج الملف المشفّر في out ويعيد manifest."""
    if not passphrase:
        raise BackupError("passphrase_missing")
    with tempfile.TemporaryDirectory(dir=out.parent) as tmp:
        work = Path(tmp)
        conn = await asyncpg.connect(dsn)
        try:
            async with conn.transaction(isolation="repeatable_read", readonly=True):
                snap = await conn.fetchval("SELECT pg_export_snapshot()")
                fp = await fingerprint(conn)
                await _proc("pg_dump", "--format=custom", f"--snapshot={snap}", "--no-owner",
                            f"--file={work / 'db.dump'}", env=_pg_env(dsn))
        finally:
            await conn.close()
        media = [{"path": p.relative_to(media_dir).as_posix(), "sha256": sha256_file(p), "bytes": p.stat().st_size}
                 for p in _media_files(media_dir)]
        manifest = {"format": 1, "created_at": datetime.now(timezone.utc).isoformat(), **fp, "media": media}
        (work / "manifest.json").write_text(json.dumps(manifest, ensure_ascii=False), encoding="utf-8")
        with tarfile.open(work / "b.tar", "w") as tar:
            tar.add(work / "manifest.json", "manifest.json")
            tar.add(work / "db.dump", "db.dump")
            for m in media:
                tar.add(media_dir / m["path"], "media/" + m["path"])
        encrypt_file(work / "b.tar", out, passphrase, log2n=log2n)
    return manifest


# ═══ الاسترجاع إلى بيئة نظيفة، ثم المقارنة بالأصل ════════════════════════════════════════
def _safe_extract(tar: tarfile.TarFile, dest: Path) -> None:
    for m in tar.getmembers():
        target = (dest / m.name).resolve()
        if dest.resolve() not in target.parents or not (m.isfile() or m.isdir()):
            raise BackupError("backup_bad_member")
    tar.extractall(dest, filter="data")


async def restore(archive: Path, passphrase: str, target_dsn: str, media_target: Path | None) -> dict:
    """يسترجع إلى قاعدة فارغة (يرفض قاعدة فيها مَدَد)، ويقارن كل جدول ببصمته في النسخة، ويتحقق من كل صورة."""
    with tempfile.TemporaryDirectory() as tmp:
        work = Path(tmp)
        decrypt_file(archive, work / "b.tar", passphrase)
        with tarfile.open(work / "b.tar") as tar:
            _safe_extract(tar, work / "x")
        manifest = json.loads((work / "x" / "manifest.json").read_text(encoding="utf-8"))
        conn = await asyncpg.connect(target_dsn)
        try:
            if await conn.fetchval("SELECT count(*) FROM pg_namespace WHERE nspname = 'madad'"):
                raise BackupError("target_not_empty")
            name = await conn.fetchval("SELECT current_database()")
        finally:
            await conn.close()
        await _proc("pg_restore", "--exit-on-error", "--no-owner", f"--dbname={name}", str(work / "x" / "db.dump"),
                    env=_pg_env(target_dsn))
        conn = await asyncpg.connect(target_dsn)
        try:
            await conn.execute(f'ALTER DATABASE "{name}" SET search_path = madad, public')
            async with conn.transaction():
                got = await fingerprint(conn)
        finally:
            await conn.close()
        bad = [t for t, v in manifest["tables"].items() if got["tables"].get(t) != v]
        bad += [s for s, v in manifest["sequences"].items() if got["sequences"].get(s) != v]
        if bad or set(got["tables"]) != set(manifest["tables"]):
            raise BackupError("restore_mismatch: " + ", ".join(sorted(bad))[:200])
        for m in manifest["media"]:
            src = work / "x" / "media" / m["path"]
            if sha256_file(src) != m["sha256"]:
                raise BackupError("restore_media_mismatch")
            if media_target is not None:
                dst = media_target / m["path"]
                dst.parent.mkdir(parents=True, exist_ok=True)
                shutil.copy2(src, dst)
        return manifest


# ═══ العامل: التشغيل، ومكان الحفظ، ومدة الحفظ ═════════════════════════════════════════
@dataclass
class Places:
    local_dir: Path
    offsite: object | None   # app.services.s3.S3


def file_name(at: datetime) -> str:
    return "madad-" + at.astimezone(TRIPOLI).strftime("%Y%m%d-%H%M%S") + ".mdbk"


async def run_once(db, dsn: str, media_dir: Path, places: Places, passphrase: str, *, log2n: int = 17,
                   request_id: int | None = None) -> int:
    """نسخة واحدة الآن حسب السياسة السارية. تعيد رقم التشغيل؛ الفشل مسجَّل في القاعدة (وتنبيه المالك منها).
    request_id: طلب «إنشاء نسخة الآن» من اللوحة (§12-ك) — نسخة يدوية تُربط بطلبها."""
    async with db.tx("system") as t:
        pol = await t.one("SELECT plan::text AS plan, location::text AS location FROM current_backup_policy()")
        weekly = pol["plan"] == "daily7_weekly12" and not await t.val(
            "SELECT 1 FROM backup_runs WHERE status = 'ok' AND kind = 'weekly' AND date_trunc('week', finished_at "
            "AT TIME ZONE 'Africa/Tripoli') = date_trunc('week', now() AT TIME ZONE 'Africa/Tripoli')")
        kind = "manual" if request_id else ("weekly" if weekly else "daily")
        rid = await t.val("INSERT INTO backup_runs (kind, plan, location) VALUES (:k, CAST(:p AS backup_plan), "
                          "CAST(:l AS backup_location)) RETURNING id", k=kind, p=pol["plan"], l=pol["location"])
        if request_id:
            await t.run("UPDATE backup_requests SET run_id = :r WHERE id = :q", r=rid, q=request_id)
    want_local, want_off = pol["location"] in ("local", "both"), pol["location"] in ("offsite", "both")
    places.local_dir.mkdir(parents=True, exist_ok=True)
    name = file_name(datetime.now(timezone.utc))
    path = places.local_dir / name
    local_ok = offsite_ok = False
    try:
        if not passphrase:
            raise BackupError("passphrase_missing")
        if want_off and not (places.offsite and places.offsite.configured):
            raise BackupError("offsite_not_configured")
        await make_archive(dsn, media_dir, path, passphrase, log2n=log2n)
        size, digest = path.stat().st_size, sha256_file(path)
        if want_off:
            await places.offsite.put_file(name, path)
            offsite_ok = True
        local_ok = want_local
        if not want_local:
            path.unlink()
        async with db.tx("system") as t:
            await t.run("UPDATE backup_runs SET status = 'ok', finished_at = now(), file_name = :n, byte_size = :s, "
                        "sha256 = :h, local_ok = :lo, offsite_ok = :oo WHERE id = :i",
                        n=name, s=size, h=digest, lo=local_ok, oo=offsite_ok, i=rid)
    except Exception as e:  # noqa: BLE001 — كل فشل يُسجَّل بسببه وينبَّه المالك
        path.unlink(missing_ok=True)
        if offsite_ok:
            await places.offsite.delete(name)
        reason = str(e) if isinstance(e, BackupError) else f"{type(e).__name__}: {str(e)[:200]}"
        log.error("backup %s failed: %s", rid, reason)
        async with db.tx("system") as t:
            await t.run("UPDATE backup_runs SET status = 'failed', finished_at = now(), error = :e WHERE id = :i",
                        e=reason, i=rid)
    await prune(db, places)
    return rid


KEEP = {("daily30", "daily"): 30, ("daily30", "weekly"): 30, ("daily7_weekly12", "daily"): 7,
        ("daily7_weekly12", "weekly"): 84, ("daily30", "manual"): 30, ("daily7_weekly12", "manual"): 7}


async def prune(db, places: Places) -> list[int]:
    """مدة الحفظ حسب السياسة السارية. آخر نسخة ناجحة لا تُحذف أبداً."""
    async with db.tx("system") as t:
        plan = await t.val("SELECT plan::text FROM current_backup_policy()")
        rows = await t.all("SELECT id, kind, file_name, local_ok, offsite_ok, finished_at FROM backup_runs "
                           "WHERE status = 'ok' AND pruned_at IS NULL ORDER BY finished_at DESC, id DESC")
    now, gone = datetime.now(timezone.utc), []
    for r in rows[1:]:
        if r["finished_at"] >= now - timedelta(days=KEEP[(plan, r["kind"])]):
            continue
        if r["local_ok"]:
            (places.local_dir / r["file_name"]).unlink(missing_ok=True)
        if r["offsite_ok"] and places.offsite and places.offsite.configured:
            await places.offsite.delete(r["file_name"])
        async with db.tx("system") as t:
            await t.run("UPDATE backup_runs SET pruned_at = now() WHERE id = :i", i=r["id"])
        gone.append(r["id"])
    return gone


async def pending_request(db) -> int | None:
    async with db.tx("system") as t:
        return await t.val("SELECT id FROM backup_requests WHERE run_id IS NULL ORDER BY id LIMIT 1")


async def due(db, hour: int) -> bool:
    """نسخة اليوم لم تنجح بعد، ومرّت ساعتها، ولا محاولة في الساعة الأخيرة."""
    if datetime.now(TRIPOLI).hour < hour:
        return False
    async with db.tx("system") as t:
        return not await t.val(
            "SELECT 1 FROM backup_runs WHERE (status = 'ok' AND (started_at AT TIME ZONE 'Africa/Tripoli')::date = "
            "(now() AT TIME ZONE 'Africa/Tripoli')::date) OR started_at > now() - interval '1 hour'")
