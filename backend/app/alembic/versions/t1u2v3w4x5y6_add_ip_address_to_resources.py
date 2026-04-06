"""add ip_address to resources

Revision ID: t1u2v3w4x5y6
Revises: w4x5y6z7a8b9
Create Date: 2026-04-06

"""
import sqlalchemy as sa
from alembic import op

revision = "t1u2v3w4x5y6"
down_revision = "w4x5y6z7a8b9"
branch_labels = None
depends_on = None


def upgrade():
    conn = op.get_bind()
    cols = [row[0] for row in conn.execute(
        sa.text("SELECT column_name FROM information_schema.columns WHERE table_name='resources'")
    )]
    if "ip_address" not in cols:
        op.add_column(
            "resources",
            sa.Column("ip_address", sa.String(length=64), nullable=True),
        )


def downgrade():
    op.drop_column("resources", "ip_address")
