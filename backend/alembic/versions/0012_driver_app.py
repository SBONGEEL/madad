"""تطبيق السائق: المتاح له وأجره التقديري، ورصيده وتسوياته هو، والرخصة بوجهيها، وإشعاراه (§7)

المخطط في alembic/sql/0012_up.sql ونزوله في 0012_down.sql.

Revision ID: 0012
Revises: 0011
"""
from __future__ import annotations

import importlib.util
from pathlib import Path

from alembic import op

revision = "0012"
down_revision = "0011"
branch_labels = None
depends_on = None

_HERE = Path(__file__).resolve().parent
_spec = importlib.util.spec_from_file_location("_m0001", _HERE / "0001_initial_schema.py")
_m0001 = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(_m0001)


def _run(name: str) -> None:
    for stmt in _m0001._statements((_HERE.parent / "sql" / name).read_text(encoding="utf-8")):
        op.execute(stmt)


def upgrade() -> None:
    _run("0012_up.sql")


def downgrade() -> None:
    _run("0012_down.sql")
