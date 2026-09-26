"""أوقات الدفعة لا ترجع إلى الخلف حين ترجع ساعة الخادم (سبب الفشل المتقطع في التشغيل 7)

المخطط في alembic/sql/0011_up.sql ونزوله في 0011_down.sql.

Revision ID: 0011
Revises: 0010
"""
from __future__ import annotations

import importlib.util
from pathlib import Path

from alembic import op

revision = "0011"
down_revision = "0010"
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
    _run("0011_up.sql")


def downgrade() -> None:
    _run("0011_down.sql")
