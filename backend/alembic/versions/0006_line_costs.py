"""تكلفة كل سطر في مخطط الاستلام، ومنه ما يضيفه المالك يدوياً (ت-39)

المخطط في alembic/sql/0006_up.sql ونزوله في 0006_down.sql.

Revision ID: 0006
Revises: 0005
"""
from __future__ import annotations

import importlib.util
from pathlib import Path

from alembic import op

revision = "0006"
down_revision = "0005"
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
    _run("0006_up.sql")


def downgrade() -> None:
    _run("0006_down.sql")
