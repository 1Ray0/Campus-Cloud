"""add migration policy settings

Revision ID: v3w4x5y6z7a
Revises: t2u3v4w5x6y7
Create Date: 2026-04-06 16:30:00.000000
"""

from alembic import op
import sqlalchemy as sa


revision = "v3w4x5y6z7a"
down_revision = "t2u3v4w5x6y7"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column(
        "proxmox_config",
        sa.Column(
            "migration_enabled",
            sa.Boolean(),
            nullable=False,
            server_default=sa.true(),
        ),
    )
    op.add_column(
        "proxmox_config",
        sa.Column(
            "migration_max_per_rebalance",
            sa.Integer(),
            nullable=False,
            server_default="2",
        ),
    )
    op.add_column(
        "proxmox_config",
        sa.Column(
            "migration_min_interval_minutes",
            sa.Integer(),
            nullable=False,
            server_default="60",
        ),
    )
    op.add_column(
        "vm_requests",
        sa.Column("last_migrated_at", sa.DateTime(timezone=True), nullable=True),
    )


def downgrade() -> None:
    op.drop_column("vm_requests", "last_migrated_at")
    op.drop_column("proxmox_config", "migration_min_interval_minutes")
    op.drop_column("proxmox_config", "migration_max_per_rebalance")
    op.drop_column("proxmox_config", "migration_enabled")
