"""sync constraints and comments to match models

- Drop unique constraint (node_name, storage) on proxmox_storages (model no longer requires it)
- Add unique constraint on tunnel_proxies.proxy_name (model declares unique=True)
- Drop legacy SQL comment on ai_api_credentials.rate_limit
  (SQLModel's Field(description=...) does NOT propagate to column.comment, so the
  comment created by earlier migrations now drifts from the model.)

Revision ID: dr01_sync_constraints
Revises: d4ffdd95ee6e
Create Date: 2026-04-23 00:00:00.000000

"""
from alembic import op
import sqlalchemy as sa


revision = "dr01_sync_constraints"
down_revision = "d4ffdd95ee6e"
branch_labels = None
depends_on = None


_RATE_LIMIT_COMMENT = "每分鐘請求限制（1-1000），None 使用預設值 20"


def upgrade():
    # 1. proxmox_storages: drop legacy unique constraint
    op.drop_constraint(
        "uq_proxmox_storages_node_name_storage",
        "proxmox_storages",
        type_="unique",
    )

    # 2. tunnel_proxies: add unique constraint on proxy_name
    #    (a unique index already exists; constraint keeps autogenerate clean)
    op.create_unique_constraint(
        "uq_tunnel_proxies_proxy_name",
        "tunnel_proxies",
        ["proxy_name"],
    )

    # 3. ai_api_credentials.rate_limit / ai_api_requests.rate_limit:
    #    drop SQL comment (model no longer carries one)
    for _table in ("ai_api_credentials", "ai_api_requests"):
        op.alter_column(
            _table,
            "rate_limit",
            existing_type=sa.Integer(),
            existing_nullable=True,
            existing_comment=_RATE_LIMIT_COMMENT,
            comment=None,
        )


def downgrade():
    for _table in ("ai_api_requests", "ai_api_credentials"):
        op.alter_column(
            _table,
            "rate_limit",
            existing_type=sa.Integer(),
            existing_nullable=True,
            existing_comment=None,
            comment=_RATE_LIMIT_COMMENT,
        )
    op.drop_constraint(
        "uq_tunnel_proxies_proxy_name",
        "tunnel_proxies",
        type_="unique",
    )
    op.create_unique_constraint(
        "uq_proxmox_storages_node_name_storage",
        "proxmox_storages",
        ["node_name", "storage"],
    )
