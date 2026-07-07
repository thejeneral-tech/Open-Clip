// Payout math for Whop campaigns — a 1:1 mirror of the backend
// `app/services/campaign_math.py` so the workspace's Payout Math panel updates
// live as the user edits, with no round-trip. Core rule: earnings =
// views/1000 * rate, capped at the per-submission max payout.

export function maxPayableViews(budget: number | null, ratePer1k: number): number | null {
  if (budget == null || ratePer1k <= 0) return null;
  return (budget / ratePer1k) * 1000;
}

export function budgetRemaining(budget: number | null, paidOut: number): number | null {
  if (budget == null) return null;
  return Math.max(0, budget - paidOut);
}

// Views a single clip needs to earn `amount` at this rate (e.g. to clear min payout).
export function viewsToClear(amount: number | null, ratePer1k: number): number | null {
  if (amount == null || ratePer1k <= 0) return null;
  return (amount / ratePer1k) * 1000;
}

export function projectPayout(
  views: number,
  ratePer1k: number,
  opts: { minPayout?: number | null; maxPayout?: number | null; remaining?: number | null } = {},
): number {
  let amount = (Math.max(0, views) / 1000) * ratePer1k;
  if (opts.maxPayout != null) amount = Math.min(amount, opts.maxPayout);
  if (opts.remaining != null) amount = Math.min(amount, opts.remaining);
  if (opts.minPayout != null && amount < opts.minPayout) return 0;
  return Math.round(Math.max(0, amount) * 100) / 100;
}

export function elapsedDays(createdAt: string, now: Date = new Date()): number {
  const seconds = (now.getTime() - new Date(createdAt).getTime()) / 1000;
  return Math.max(seconds / 86400, 0.05);
}

export function burnRatePerDay(paidOut: number, createdAt: string, now: Date = new Date()): number {
  return Math.round((paidOut / elapsedDays(createdAt, now)) * 100) / 100;
}

export function daysUntilExhausted(
  budget: number | null,
  paidOut: number,
  createdAt: string,
  now: Date = new Date(),
): number | null {
  const remaining = budgetRemaining(budget, paidOut);
  if (remaining == null || remaining <= 0) return null;
  const burn = burnRatePerDay(paidOut, createdAt, now);
  if (burn <= 0) return null;
  return Math.round((remaining / burn) * 10) / 10;
}

// A config sanity check — the warnings the panel surfaces.
export interface MathWarning {
  text: string;
}

export function configWarnings(input: {
  ratePer1k: number;
  budget: number | null;
  minPayout: number | null;
  maxPayout: number | null;
  endsAt: string | null;
}): MathWarning[] {
  const out: MathWarning[] = [];
  const { ratePer1k, budget, minPayout, maxPayout, endsAt } = input;
  if (minPayout != null && maxPayout != null && minPayout > maxPayout) {
    out.push({ text: "Min payout is higher than max payout — no clip can qualify." });
  }
  if (maxPayout != null && budget != null && maxPayout > budget) {
    out.push({ text: "Max payout exceeds the whole budget — one clip could drain it." });
  }
  if (minPayout != null && ratePer1k > 0) {
    const views = viewsToClear(minPayout, ratePer1k);
    if (views != null && views > 1_000_000) {
      out.push({
        text: `A clip needs ${compact(views)} views just to clear the $${minPayout} min payout.`,
      });
    }
  }
  if (endsAt) {
    const end = new Date(endsAt).getTime();
    if (Number.isFinite(end) && end < Date.now()) {
      out.push({ text: "End date is in the past — the campaign is already closed." });
    }
  }
  return out;
}

// Small compact-number helper for the warning strings (utils.formatCompactNumber
// is for display cards; this keeps campaign-math dependency-free).
function compact(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${Math.round(n / 1_000)}K`;
  return String(Math.round(n));
}
