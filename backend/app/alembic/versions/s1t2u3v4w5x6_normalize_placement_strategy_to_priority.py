"""normalize placement strategy to priority dominant share

Revision ID: s1t2u3v4w5x6
Revises: r1s2t3u4v5w6
Create Date: 2026-04-05 21:30:00.000000

"""

from alembic import op
import sqlalchemy as sa


revision = "s1t2u3v4w5x6"
down_revision = "r1s2t3u4v5w6"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.execute(
        sa.text(
            """
            UPDATE proxmox_config
            SET placement_strategy = 'priority_dominant_share'
            WHERE placement_strategy IS NULL
               OR placement_strategy <> 'priority_dominant_share'
            """
        )
    )
    op.alter_column(
        "proxmox_config",
        "placement_strategy",
        existing_type=sa.String(length=64),
        server_default="priority_dominant_share",
        existing_nullable=False,
    )


def downgrade() -> None:
    op.execute(
        sa.text(
            """
            UPDATE proxmox_config
            SET placement_strategy = 'dominant_share_min'
            WHERE placement_strategy = 'priority_dominant_share'
            """
        )
    )
    op.alter_column(
        "proxmox_config",
        "placement_strategy",
        existing_type=sa.String(length=64),
        server_default="dominant_share_min",
        existing_nullable=False,
    )
