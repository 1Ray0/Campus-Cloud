"""add schedule and assignment fields to vm_requests

Revision ID: r1s2t3u4v5w6
Revises: r9s0t1u2v3w4
Create Date: 2026-04-05 00:00:00.000000
"""

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision = "r1s2t3u4v5w6"
down_revision = "r9s0t1u2v3w4"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column(
        "vm_requests",
        sa.Column("start_at", sa.DateTime(timezone=True), nullable=True),
    )
    op.add_column(
        "vm_requests",
        sa.Column("end_at", sa.DateTime(timezone=True), nullable=True),
    )
    op.add_column(
        "vm_requests",
        sa.Column("assigned_node", sa.String(length=255), nullable=True),
    )
    op.add_column(
        "vm_requests",
        sa.Column("placement_strategy_used", sa.String(length=64), nullable=True),
    )


def downgrade() -> None:
    op.drop_column("vm_requests", "placement_strategy_used")
    op.drop_column("vm_requests", "assigned_node")
    op.drop_column("vm_requests", "end_at")
    op.drop_column("vm_requests", "start_at")
