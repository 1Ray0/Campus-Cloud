"""Add local search, disk contention, and migration queue claim fields."""

from alembic import op
import sqlalchemy as sa


revision = "z7a8b9c0d1e2"
down_revision = "y6z7a8b9c0d1"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column(
        "proxmox_config",
        sa.Column(
            "rebalance_disk_contention_warn_share",
            sa.Float(),
            nullable=False,
            server_default="0.7",
        ),
    )
    op.add_column(
        "proxmox_config",
        sa.Column(
            "rebalance_disk_contention_high_share",
            sa.Float(),
            nullable=False,
            server_default="0.9",
        ),
    )
    op.add_column(
        "proxmox_config",
        sa.Column(
            "rebalance_disk_penalty_weight",
            sa.Float(),
            nullable=False,
            server_default="0.75",
        ),
    )
    op.add_column(
        "proxmox_config",
        sa.Column(
            "rebalance_search_max_relocations",
            sa.Integer(),
            nullable=False,
            server_default="2",
        ),
    )
    op.add_column(
        "proxmox_config",
        sa.Column(
            "rebalance_search_depth",
            sa.Integer(),
            nullable=False,
            server_default="3",
        ),
    )
    op.add_column(
        "proxmox_config",
        sa.Column(
            "migration_worker_concurrency",
            sa.Integer(),
            nullable=False,
            server_default="2",
        ),
    )
    op.add_column(
        "proxmox_config",
        sa.Column(
            "migration_job_claim_timeout_seconds",
            sa.Integer(),
            nullable=False,
            server_default="300",
        ),
    )
    op.add_column(
        "proxmox_config",
        sa.Column(
            "migration_retry_backoff_seconds",
            sa.Integer(),
            nullable=False,
            server_default="120",
        ),
    )
    op.add_column(
        "vm_migration_jobs",
        sa.Column("available_at", sa.DateTime(timezone=True), nullable=True),
    )
    op.add_column(
        "vm_migration_jobs",
        sa.Column("claimed_by", sa.String(length=128), nullable=True),
    )
    op.add_column(
        "vm_migration_jobs",
        sa.Column("claimed_at", sa.DateTime(timezone=True), nullable=True),
    )
    op.add_column(
        "vm_migration_jobs",
        sa.Column("claim_expires_at", sa.DateTime(timezone=True), nullable=True),
    )
    op.create_index(
        op.f("ix_vm_migration_jobs_available_at"),
        "vm_migration_jobs",
        ["available_at"],
        unique=False,
    )
    op.create_index(
        op.f("ix_vm_migration_jobs_claim_expires_at"),
        "vm_migration_jobs",
        ["claim_expires_at"],
        unique=False,
    )


def downgrade() -> None:
    op.drop_index(op.f("ix_vm_migration_jobs_claim_expires_at"), table_name="vm_migration_jobs")
    op.drop_index(op.f("ix_vm_migration_jobs_available_at"), table_name="vm_migration_jobs")
    op.drop_column("vm_migration_jobs", "claim_expires_at")
    op.drop_column("vm_migration_jobs", "claimed_at")
    op.drop_column("vm_migration_jobs", "claimed_by")
    op.drop_column("vm_migration_jobs", "available_at")
    op.drop_column("proxmox_config", "migration_retry_backoff_seconds")
    op.drop_column("proxmox_config", "migration_job_claim_timeout_seconds")
    op.drop_column("proxmox_config", "migration_worker_concurrency")
    op.drop_column("proxmox_config", "rebalance_search_depth")
    op.drop_column("proxmox_config", "rebalance_search_max_relocations")
    op.drop_column("proxmox_config", "rebalance_disk_penalty_weight")
    op.drop_column("proxmox_config", "rebalance_disk_contention_high_share")
    op.drop_column("proxmox_config", "rebalance_disk_contention_warn_share")
