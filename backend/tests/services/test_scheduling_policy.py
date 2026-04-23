"""Tests for pure helpers in app.services.scheduling.policy."""

from __future__ import annotations

from datetime import UTC, datetime, timedelta, timezone

from app.services.scheduling import policy as p


def test_utc_now_is_timezone_aware() -> None:
    now = p.utc_now()
    assert now.tzinfo is not None and now.utcoffset() == timedelta(0)


def test_normalize_datetime_attaches_utc_to_naive() -> None:
    naive = datetime(2026, 4, 23, 12, 0, 0)
    normalized = p.normalize_datetime(naive)
    assert normalized is not None
    assert normalized.tzinfo == UTC


def test_normalize_datetime_keeps_aware_unchanged() -> None:
    aware = datetime(2026, 4, 23, 12, 0, 0, tzinfo=timezone(timedelta(hours=8)))
    assert p.normalize_datetime(aware) is aware


def test_normalize_datetime_handles_none() -> None:
    assert p.normalize_datetime(None) is None


def test_migration_worker_id_is_stable_within_process() -> None:
    assert p.migration_worker_id() == p.migration_worker_id()
    assert p.migration_worker_id().startswith("scheduler-")


def _make_policy(*, retry_backoff: int = 120) -> p.MigrationPolicy:
    return p.MigrationPolicy(
        enabled=True,
        max_per_rebalance=2,
        min_interval_minutes=60,
        retry_limit=3,
        worker_concurrency=2,
        claim_timeout_seconds=300,
        retry_backoff_seconds=retry_backoff,
        lxc_live_enabled=False,
    )


def test_next_retry_at_uses_exponential_backoff() -> None:
    now = datetime(2026, 4, 23, 0, 0, 0, tzinfo=UTC)
    policy = _make_policy(retry_backoff=120)

    # attempt 1 → base × 2^0
    delta_1 = p.next_retry_at(now=now, policy=policy, attempt_count=1) - now
    # attempt 2 → base × 2^1
    delta_2 = p.next_retry_at(now=now, policy=policy, attempt_count=2) - now
    # attempt 3 → base × 2^2
    delta_3 = p.next_retry_at(now=now, policy=policy, attempt_count=3) - now

    base = max(120, p.SCHEDULER_POLL_SECONDS)
    assert delta_1 == timedelta(seconds=base)
    assert delta_2 == timedelta(seconds=base * 2)
    assert delta_3 == timedelta(seconds=base * 4)


def test_next_retry_at_floors_low_backoff_at_poll_seconds() -> None:
    now = datetime(2026, 4, 23, 0, 0, 0, tzinfo=UTC)
    # If retry_backoff is shorter than SCHEDULER_POLL_SECONDS, use poll as floor
    policy = _make_policy(retry_backoff=10)
    delta = p.next_retry_at(now=now, policy=policy, attempt_count=1) - now
    assert delta == timedelta(seconds=p.SCHEDULER_POLL_SECONDS)


def test_next_retry_at_zero_or_negative_attempt_treated_as_first() -> None:
    now = datetime(2026, 4, 23, 0, 0, 0, tzinfo=UTC)
    policy = _make_policy(retry_backoff=120)
    base = max(120, p.SCHEDULER_POLL_SECONDS)

    assert (
        p.next_retry_at(now=now, policy=policy, attempt_count=0) - now
        == timedelta(seconds=base)
    )
    assert (
        p.next_retry_at(now=now, policy=policy, attempt_count=-5) - now
        == timedelta(seconds=base)
    )
