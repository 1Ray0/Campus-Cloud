"""add migration jobs and rebalance tuning

Revision ID: y6z7a8b9c0d1
Revises: x5y6z7a8b9c0
Create Date: 2026-04-06 23:40:00.000000

"""

from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql


revision = "y6z7a8b9c0d1"
down_revision = "x5y6z7a8b9c0"
branch_labels = None
depends_on = None


migration_job_status_enum = postgresql.ENUM(
    "pending",
    "running",
    "completed",
    "failed",
    "blocked",
    "cancelled",
    name="vmmigrationjobstatus",
    create_type=False,
)


def upgrade() -> None:
    migration_job_status_enum.create(op.get_bind(), checkfirst=True)

    op.add_column(
        "proxmox_config",
        sa.Column("migration_retry_limit", sa.Integer(), nullable=False, server_default="3"),
    )
    op.add_column(
        "proxmox_config",
        sa.Column("rebalance_migration_cost", sa.Float(), nullable=False, server_default="0.15"),
    )
    op.add_column(
        "proxmox_config",
        sa.Column("rebalance_peak_cpu_margin", sa.Float(), nullable=False, server_default="1.1"),
    )
    op.add_column(
        "proxmox_config",
        sa.Column("rebalance_peak_memory_margin", sa.Float(), nullable=False, server_default="1.05"),
    )
    op.add_column(
        "proxmox_config",
        sa.Column("rebalance_loadavg_warn_per_core", sa.Float(), nullable=False, server_default="0.8"),
    )
    op.add_column(
        "proxmox_config",
        sa.Column("rebalance_loadavg_max_per_core", sa.Float(), nullable=False, server_default="1.5"),
    )
    op.add_column(
        "proxmox_config",
        sa.Column("rebalance_loadavg_penalty_weight", sa.Float(), nullable=False, server_default="0.9"),
    )

    op.create_table(
        "vm_migration_jobs",
        sa.Column("id", sa.Uuid(), nullable=False),
        sa.Column("request_id", sa.Uuid(), nullable=False),
        sa.Column("vmid", sa.Integer(), nullable=True),
        sa.Column("source_node", sa.String(length=255), nullable=True),
        sa.Column("target_node", sa.String(length=255), nullable=False),
        sa.Column("status", migration_job_status_enum, nullable=False, server_default="pending"),
        sa.Column("rebalance_epoch", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("attempt_count", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("last_error", sa.String(length=500), nullable=True),
        sa.Column("requested_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("started_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("finished_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False),
        sa.ForeignKeyConstraint(["request_id"], ["vm_requests.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index(op.f("ix_vm_migration_jobs_request_id"), "vm_migration_jobs", ["request_id"])
    op.create_index(op.f("ix_vm_migration_jobs_vmid"), "vm_migration_jobs", ["vmid"])
    op.create_index(op.f("ix_vm_migration_jobs_rebalance_epoch"), "vm_migration_jobs", ["rebalance_epoch"])
    op.create_index(op.f("ix_vm_migration_jobs_requested_at"), "vm_migration_jobs", ["requested_at"])

    op.alter_column("proxmox_config", "migration_retry_limit", server_default=None)
    op.alter_column("proxmox_config", "rebalance_migration_cost", server_default=None)
    op.alter_column("proxmox_config", "rebalance_peak_cpu_margin", server_default=None)
    op.alter_column("proxmox_config", "rebalance_peak_memory_margin", server_default=None)
    op.alter_column("proxmox_config", "rebalance_loadavg_warn_per_core", server_default=None)
    op.alter_column("proxmox_config", "rebalance_loadavg_max_per_core", server_default=None)
    op.alter_column("proxmox_config", "rebalance_loadavg_penalty_weight", server_default=None)
    op.alter_column("vm_migration_jobs", "status", server_default=None)
    op.alter_column("vm_migration_jobs", "rebalance_epoch", server_default=None)
    op.alter_column("vm_migration_jobs", "attempt_count", server_default=None)


def downgrade() -> None:
    op.drop_index(op.f("ix_vm_migration_jobs_requested_at"), table_name="vm_migration_jobs")
    op.drop_index(op.f("ix_vm_migration_jobs_rebalance_epoch"), table_name="vm_migration_jobs")
    op.drop_index(op.f("ix_vm_migration_jobs_vmid"), table_name="vm_migration_jobs")
    op.drop_index(op.f("ix_vm_migration_jobs_request_id"), table_name="vm_migration_jobs")
    op.drop_table("vm_migration_jobs")

    op.drop_column("proxmox_config", "rebalance_loadavg_penalty_weight")
    op.drop_column("proxmox_config", "rebalance_loadavg_max_per_core")
    op.drop_column("proxmox_config", "rebalance_loadavg_warn_per_core")
    op.drop_column("proxmox_config", "rebalance_peak_memory_margin")
    op.drop_column("proxmox_config", "rebalance_peak_cpu_margin")
    op.drop_column("proxmox_config", "rebalance_migration_cost")
    op.drop_column("proxmox_config", "migration_retry_limit")

    migration_job_status_enum.drop(op.get_bind(), checkfirst=True)
