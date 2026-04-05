"""add rebalance fields to vm_requests

Revision ID: t2u3v4w5x6y7
Revises: s1t2u3v4w5x6
Create Date: 2026-04-06 00:30:00.000000
"""

from alembic import op
import sqlalchemy as sa


revision = "t2u3v4w5x6y7"
down_revision = "s1t2u3v4w5x6"
branch_labels = None
depends_on = None


migration_status_enum = sa.Enum(
    "idle",
    "pending",
    "running",
    "completed",
    "failed",
    "blocked",
    name="vmmigrationstatus",
)


def upgrade() -> None:
    migration_status_enum.create(op.get_bind(), checkfirst=True)

    op.add_column(
        "vm_requests",
        sa.Column("desired_node", sa.String(length=255), nullable=True),
    )
    op.add_column(
        "vm_requests",
        sa.Column("actual_node", sa.String(length=255), nullable=True),
    )
    op.add_column(
        "vm_requests",
        sa.Column(
            "migration_status",
            migration_status_enum,
            nullable=False,
            server_default="idle",
        ),
    )
    op.add_column(
        "vm_requests",
        sa.Column("migration_error", sa.String(length=500), nullable=True),
    )
    op.add_column(
        "vm_requests",
        sa.Column("rebalance_epoch", sa.Integer(), nullable=False, server_default="0"),
    )
    op.add_column(
        "vm_requests",
        sa.Column("last_rebalanced_at", sa.DateTime(timezone=True), nullable=True),
    )

    op.execute(
        sa.text(
            """
            UPDATE vm_requests
            SET desired_node = assigned_node
            WHERE desired_node IS NULL AND assigned_node IS NOT NULL
            """
        )
    )
    op.execute(
        sa.text(
            """
            UPDATE vm_requests
            SET actual_node = assigned_node
            WHERE actual_node IS NULL AND vmid IS NOT NULL AND assigned_node IS NOT NULL
            """
        )
    )

    op.alter_column(
        "vm_requests",
        "migration_status",
        existing_type=migration_status_enum,
        server_default=None,
        existing_nullable=False,
    )
    op.alter_column(
        "vm_requests",
        "rebalance_epoch",
        existing_type=sa.Integer(),
        server_default=None,
        existing_nullable=False,
    )


def downgrade() -> None:
    op.drop_column("vm_requests", "last_rebalanced_at")
    op.drop_column("vm_requests", "rebalance_epoch")
    op.drop_column("vm_requests", "migration_error")
    op.drop_column("vm_requests", "migration_status")
    op.drop_column("vm_requests", "actual_node")
    op.drop_column("vm_requests", "desired_node")

    migration_status_enum.drop(op.get_bind(), checkfirst=True)
