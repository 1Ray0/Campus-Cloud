"""remove pve_ip from subnet_config

Revision ID: ip02_drop_pve_ip
Revises: ip01_subnet_ip_mgmt
Create Date: 2026-04-16

"""

import sqlalchemy as sa
from alembic import op

# revision identifiers, used by Alembic.
revision = "ip02_drop_pve_ip"
down_revision = "ip01_subnet_ip_mgmt"
branch_labels = None
depends_on = None


def _has_column(table_name: str, column_name: str) -> bool:
    bind = op.get_bind()
    inspector = sa.inspect(bind)
    return any(col["name"] == column_name for col in inspector.get_columns(table_name))


def upgrade() -> None:
    # Idempotent: only drop if the legacy column is still present.
    # Some environments never had `pve_ip` because they were initialised after
    # the column was removed from the model.
    if _has_column("subnet_config", "pve_ip"):
        op.drop_column("subnet_config", "pve_ip")


def downgrade() -> None:
    if not _has_column("subnet_config", "pve_ip"):
        op.add_column(
            "subnet_config",
            sa.Column("pve_ip", sa.String(length=50), nullable=True),
        )
