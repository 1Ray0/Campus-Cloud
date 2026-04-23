"""Tests for the optional ARQ runner stub.

These tests only verify the lazy-import contract and the
ArqUnavailableError behaviour — they do not require Redis or the
``arq`` package itself.
"""

from __future__ import annotations

import pytest

from app.infrastructure.worker import arq_runner


def test_is_available_returns_bool() -> None:
    assert isinstance(arq_runner.is_available(), bool)


@pytest.mark.asyncio
async def test_enqueue_raises_when_arq_missing() -> None:
    if arq_runner.is_available():
        pytest.skip("arq is installed; this test only runs when it's missing")
    with pytest.raises(arq_runner.ArqUnavailableError):
        await arq_runner.enqueue("noop", redis_url="redis://localhost:6379/0")


@pytest.mark.asyncio
async def test_get_pool_raises_when_arq_missing() -> None:
    if arq_runner.is_available():
        pytest.skip("arq is installed; this test only runs when it's missing")
    with pytest.raises(arq_runner.ArqUnavailableError):
        await arq_runner.get_pool("redis://localhost:6379/0")


@pytest.mark.asyncio
async def test_shutdown_is_idempotent_when_no_pool() -> None:
    # Should not raise even when pool was never created
    await arq_runner.shutdown()
    await arq_runner.shutdown()


def test_arq_unavailable_error_is_runtime_error() -> None:
    assert issubclass(arq_runner.ArqUnavailableError, RuntimeError)
