"""TOTP (RFC 6238) primitives for opt-in 2FA.

This module is *infrastructure-only* — it generates secrets, provisioning
URIs, and verifies codes. Wiring it into login / user models and adding
the corresponding DB column (`users.totp_secret`) is intentionally left
to a follow-up PR after schema design is signed off.

Lazily imports ``pyotp`` so the rest of the codebase stays importable
even before the dep is installed.
"""

from __future__ import annotations

import secrets
from typing import TYPE_CHECKING

if TYPE_CHECKING:  # pragma: no cover - typing only
    pass

try:  # pragma: no cover - optional dep
    import pyotp

    _AVAILABLE = True
except ImportError:  # pragma: no cover - optional dep
    pyotp = None  # type: ignore[assignment]
    _AVAILABLE = False


class TotpUnavailableError(RuntimeError):
    """Raised when pyotp is not installed but TOTP functionality is invoked."""


def _require_pyotp() -> None:
    if not _AVAILABLE:
        raise TotpUnavailableError(
            "pyotp is not installed; run `uv add pyotp` to enable TOTP MFA."
        )


def generate_secret() -> str:
    """Return a fresh base32-encoded secret suitable for storing in DB."""
    _require_pyotp()
    return pyotp.random_base32()  # type: ignore[union-attr]


def provisioning_uri(*, secret: str, account_name: str, issuer: str) -> str:
    """Build the otpauth:// URI used by Google Authenticator / 1Password."""
    _require_pyotp()
    return pyotp.TOTP(secret).provisioning_uri(  # type: ignore[union-attr]
        name=account_name, issuer_name=issuer
    )


def verify_code(*, secret: str, code: str, valid_window: int = 1) -> bool:
    """Verify a 6-digit TOTP code; ``valid_window=1`` accepts ±30s skew."""
    _require_pyotp()
    if not code or not code.isdigit() or len(code) != 6:
        return False
    return bool(
        pyotp.TOTP(secret).verify(code, valid_window=valid_window)  # type: ignore[union-attr]
    )


def generate_recovery_codes(count: int = 10, length: int = 10) -> list[str]:
    """Generate one-time recovery codes (hex). Hash before persisting."""
    return [secrets.token_hex(length // 2) for _ in range(count)]
