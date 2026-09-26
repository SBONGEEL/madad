"""المخطط الأولي لمَدَد: الجداول والقيود والمشغّلات والدفتر

المخطط نفسه في alembic/sql/0001_up.sql — ملف SQL واحد تقرؤه هذه الترحيلة
وتُبنى منه قاعدة الاختبارات، فلا نسخة ثانية من المخطط. شرحه في القسم 13 من
SPEC-MADAD.md.

Revision ID: 0001
Revises:
"""
from __future__ import annotations

from pathlib import Path

from alembic import op

revision = "0001"
down_revision = None
branch_labels = None
depends_on = None

SQL_DIR = Path(__file__).resolve().parent.parent / "sql"


def _statements(sql: str) -> list[str]:
    """يقسّم نصّ SQL إلى أوامر مفردة، محترماً أجسام الدوال بين $$.

    asyncpg ينفّذ أمراً واحداً في كل استدعاء. تعليقات «--» خارج أجسام
    الدوال تُحذف أولاً حتى لا تقسم فاصلةٌ منقوطة داخل تعليقٍ أمراً.
    """
    out, buf, in_body = [], [], False
    for part in sql.split("$$"):
        if in_body:
            buf.append("$$" + part + "$$")
        else:
            part = "\n".join(line.split("--", 1)[0] if "--" in line else line
                             for line in part.split("\n"))
            pieces = part.split(";")
            for piece in pieces[:-1]:
                buf.append(piece)
                stmt = "".join(buf).strip()
                if stmt:
                    out.append(stmt)
                buf = []
            buf.append(pieces[-1])
        in_body = not in_body
    tail = "".join(buf).strip()
    if tail:
        out.append(tail)
    return out


def _run(name: str) -> None:
    for stmt in _statements((SQL_DIR / name).read_text(encoding="utf-8")):
        op.execute(stmt)


def upgrade() -> None:
    _run("0001_up.sql")


def downgrade() -> None:
    _run("0001_down.sql")
