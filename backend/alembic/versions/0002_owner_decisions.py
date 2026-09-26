"""قرارات المالك 2026-09-26: M-1 وM-2 وM-3 وM-4 وM-10 وM-11 وM-14 وM-19

المخطط في alembic/sql/0002_up.sql ونزوله في 0002_down.sql؛ الشرح في §12-د من SPEC-MADAD.md.

Revision ID: 0002
Revises: 0001
"""
from __future__ import annotations

import importlib.util
from pathlib import Path

from alembic import op

revision = "0002"
down_revision = "0001"
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
    _run("0002_up.sql")


def downgrade() -> None:
    _run("0002_down.sql")
