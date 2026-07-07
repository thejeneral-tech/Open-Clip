"""Deterministic payout math for Whop campaigns.

Pure functions with no I/O so they're trivially testable and can be mirrored
1:1 on the frontend (``frontend/src/lib/campaign-math.ts``) for a live,
round-trip-free payout panel. The core earnings rule matches the backend
elsewhere (``_earnings_estimate`` in the whop endpoint): ``views/1000 * rate``,
capped at the per-submission ``max_payout``.
"""
from __future__ import annotations

import statistics
from datetime import datetime, timezone


def max_payable_views(budget: float | None, rate_per_1k: float) -> float | None:
    """How many total views the whole budget can pay for at this rate.

    ``None`` when the budget is unlimited or the rate is non-positive.
    """
    if budget is None or rate_per_1k <= 0:
        return None
    return budget / rate_per_1k * 1000.0


def budget_remaining(budget: float | None, paid_out: float) -> float | None:
    """Budget left to pay out (never negative). ``None`` when unlimited."""
    if budget is None:
        return None
    return max(0.0, budget - paid_out)


def views_to_clear(amount: float | None, rate_per_1k: float) -> float | None:
    """Views a single clip needs to earn ``amount`` at this rate (e.g. min payout)."""
    if amount is None or rate_per_1k <= 0:
        return None
    return amount / rate_per_1k * 1000.0


def project_payout(
    views: float,
    rate_per_1k: float,
    *,
    min_payout: float | None = None,
    max_payout: float | None = None,
    remaining: float | None = None,
) -> float:
    """Projected earnings for a clip that reaches ``views``.

    ``views/1000 * rate``, capped by ``max_payout`` and by the campaign's
    ``remaining`` budget. If the result is below ``min_payout`` the clip is not
    yet eligible to pay out, so it returns 0.
    """
    amount = max(0.0, views) / 1000.0 * rate_per_1k
    if max_payout is not None:
        amount = min(amount, max_payout)
    if remaining is not None:
        amount = min(amount, remaining)
    if min_payout is not None and amount < min_payout:
        return 0.0
    return round(max(0.0, amount), 2)


def _as_utc(value: datetime) -> datetime:
    return value if value.tzinfo is not None else value.replace(tzinfo=timezone.utc)


def elapsed_days(created_at: datetime, now: datetime | None = None) -> float:
    """Fractional days since the campaign was created (at least a sliver)."""
    now = now or datetime.now(timezone.utc)
    seconds = (_as_utc(now) - _as_utc(created_at)).total_seconds()
    return max(seconds / 86400.0, 0.05)


def burn_rate_per_day(paid_out: float, created_at: datetime, now: datetime | None = None) -> float:
    """Average $ paid out per day since launch."""
    return round(paid_out / elapsed_days(created_at, now), 2)


def days_until_exhausted(
    budget: float | None, paid_out: float, created_at: datetime, now: datetime | None = None
) -> float | None:
    """At the current burn rate, days until the budget is fully paid out.

    ``None`` when unlimited, nothing spent yet, or already exhausted.
    """
    remaining = budget_remaining(budget, paid_out)
    if remaining is None or remaining <= 0:
        return None
    burn = burn_rate_per_day(paid_out, created_at, now)
    if burn <= 0:
        return None
    return round(remaining / burn, 1)


def median_views(views: list[int]) -> float | None:
    """Median of non-zero submission view counts, for projecting clip payout."""
    nonzero = [v for v in views if v and v > 0]
    if not nonzero:
        return None
    return float(statistics.median(nonzero))
