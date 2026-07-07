from datetime import datetime, timedelta, timezone

from app.services import campaign_math as cm


def test_max_payable_views():
    # $26,118.89 budget at $1 / 1K views → ~26.1M payable views.
    assert cm.max_payable_views(26118.89, 1.0) == 26118890.0
    assert cm.max_payable_views(None, 1.0) is None       # unlimited budget
    assert cm.max_payable_views(100.0, 0.0) is None       # non-positive rate


def test_budget_remaining_never_negative():
    assert cm.budget_remaining(100.0, 30.0) == 70.0
    assert cm.budget_remaining(100.0, 130.0) == 0.0
    assert cm.budget_remaining(None, 999.0) is None


def test_views_to_clear():
    # To earn a $5 min payout at $1/1K you need 5,000 views.
    assert cm.views_to_clear(5.0, 1.0) == 5000.0
    assert cm.views_to_clear(None, 1.0) is None


def test_project_payout_basic_and_caps():
    assert cm.project_payout(100000, 1.0) == 100.0                       # 100k views * $1/1k
    assert cm.project_payout(100000, 1.0, max_payout=50.0) == 50.0        # capped at max
    assert cm.project_payout(100000, 1.0, remaining=20.0) == 20.0         # capped at budget left


def test_project_payout_below_min_is_zero():
    # 1,000 views earns $1 — below a $5 min payout, so not yet eligible → $0.
    assert cm.project_payout(1000, 1.0, min_payout=5.0) == 0.0
    assert cm.project_payout(10000, 1.0, min_payout=5.0) == 10.0          # clears the min


def test_burn_rate_and_exhaustion():
    now = datetime(2026, 1, 11, tzinfo=timezone.utc)
    created = now - timedelta(days=10)
    # $100 paid over 10 days → $10/day.
    assert cm.burn_rate_per_day(100.0, created, now) == 10.0
    # $400 budget, $100 spent → $300 left / $10 day → 30 days.
    assert cm.days_until_exhausted(400.0, 100.0, created, now) == 30.0
    # Nothing spent → no projection; unlimited budget → None.
    assert cm.days_until_exhausted(400.0, 0.0, created, now) is None
    assert cm.days_until_exhausted(None, 100.0, created, now) is None


def test_median_views_ignores_zeros():
    assert cm.median_views([0, 0, 10000, 30000, 50000]) == 30000.0
    assert cm.median_views([0, 0]) is None
    assert cm.median_views([]) is None
