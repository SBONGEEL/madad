"""خدمة النسخ الاحتياطية (§12-ي ن-3) — تعمل حاويةً مستقلة بجوار الخلفية.

  python -m app.backup worker            النسخة اليومية في ساعتها، ومدة الحفظ (الخدمة الدائمة)
  python -m app.backup run               نسخة الآن
  python -m app.backup verify FILE       استرجاع تجريبي في قاعدة مؤقتة ومقارنتها بالبصمات ثم حذفها
  python -m app.backup restore FILE      استرجاع إلى القاعدة المضبوطة (يجب أن تكون فارغة) وإلى مجلد الصور
  python -m app.backup decrypt FILE OUT  فكّ التشفير إلى ملف tar (للفتح على جهاز المالك)

كلمة السر من MADAD_BACKUP_PASSPHRASE، أو تُسأل في الطرفية إن غابت (restore وverify وdecrypt).
"""
from __future__ import annotations

import argparse
import asyncio
import getpass
import logging
import sys
import uuid
from pathlib import Path

import asyncpg

from app.core.config import get_settings
from app.core.db import Db
from app.services import backup
from app.services.s3 import S3

log = logging.getLogger("madad.backup")


def _places(s) -> backup.Places:
    return backup.Places(Path(s.backup_dir), S3(s.backup_s3_endpoint, s.backup_s3_region, s.backup_s3_bucket,
                                                s.backup_s3_access_key, s.backup_s3_secret_key))


def _passphrase(s) -> str:
    return s.backup_passphrase or getpass.getpass("كلمة سر النسخ الاحتياطية: ")


async def _worker(s) -> None:
    db = Db(s.database_url)
    places = _places(s)
    while True:
        try:
            if await backup.due(db, s.backup_hour):
                await backup.run_once(db, backup.plain_dsn(s.database_url), Path(s.media_dir), places, s.backup_passphrase)
        except Exception:  # noqa: BLE001 — الخدمة لا تسقط؛ الفشل مسجَّل في القاعدة وينبَّه المالك
            log.exception("backup worker tick failed")
        await asyncio.sleep(600)


async def _verify(s, file: Path) -> None:
    dsn = backup.plain_dsn(s.database_url)
    name = "madad_verify_" + uuid.uuid4().hex[:8]
    admin = await asyncpg.connect(dsn)
    await admin.execute(f'CREATE DATABASE "{name}"')
    try:
        m = await backup.restore(file, _passphrase(s), dsn.rsplit("/", 1)[0] + "/" + name, None)
        rows = sum(v[0] for v in m["tables"].values())
        print(f"سليمة: {len(m['tables'])} جدولاً، {rows} صفاً، {len(m['media'])} صورة — مطابقة لبصماتها. نسخة {m['created_at']}")
    finally:
        await admin.execute(f'DROP DATABASE IF EXISTS "{name}" WITH (FORCE)')
        await admin.close()


def main(argv: list[str] | None = None) -> int:
    logging.basicConfig(level=logging.INFO)
    ap = argparse.ArgumentParser(prog="python -m app.backup")
    sub = ap.add_subparsers(dest="cmd", required=True)
    sub.add_parser("worker")
    sub.add_parser("run")
    for c in ("verify", "restore"):
        sub.add_parser(c).add_argument("file", type=Path)
    d = sub.add_parser("decrypt")
    d.add_argument("file", type=Path)
    d.add_argument("out", type=Path)
    a = ap.parse_args(argv)
    s = get_settings()
    try:
        if a.cmd == "worker":
            asyncio.run(_worker(s))
        elif a.cmd == "run":
            rid = asyncio.run(backup.run_once(Db(s.database_url), backup.plain_dsn(s.database_url), Path(s.media_dir),
                                              _places(s), s.backup_passphrase))
            print(f"التشغيل {rid} — حالته في اللوحة (الإعدادات ← النسخ الاحتياطية)")
        elif a.cmd == "verify":
            asyncio.run(_verify(s, a.file))
        elif a.cmd == "restore":
            m = asyncio.run(backup.restore(a.file, _passphrase(s), backup.plain_dsn(s.database_url), Path(s.media_dir)))
            print(f"استُرجعت نسخة {m['created_at']}: {len(m['tables'])} جدولاً و{len(m['media'])} صورة، مطابقة لبصماتها.")
        elif a.cmd == "decrypt":
            backup.decrypt_file(a.file, a.out, _passphrase(s))
            print(f"فُكّ التشفير إلى {a.out}")
    except backup.BackupError as e:
        print(f"فشل: {e}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
