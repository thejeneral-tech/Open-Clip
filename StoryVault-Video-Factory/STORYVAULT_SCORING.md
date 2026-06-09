# StoryVault Quality Score (0–100)

Implemented in [`src/services/scoring.js`](src/services/scoring.js). Every score is computed from
**real available signals** + heuristic story analysis ([`analysis.js`](src/services/analysis.js)).
Engagement metrics are labelled **verified / estimated / unavailable** and are **never fabricated**.

## Categories & weights (sum = 100)

| # | Category | Max | What it measures |
|---|----------|-----|------------------|
| 1 | Engagement quality | 20 | Real upvotes/comments/views + comment‑to‑upvote ratio + awards, **log‑scaled and normalised per community** (relative to the community's own top post) **and** against a global anchor, so a small sub isn't out‑ranked by a giant one. |
| 2 | Story structure | 20 | Setup, conflict, escalation, a clear decision, consequence, ending, and an easy‑to‑follow timeline. |
| 3 | Hook strength | 15 | Curiosity / conflict / stakes / a question in the title + first lines. |
| 4 | Emotional tension | 15 | Emotional beats, conflict intensity, controversy (divisive upvote ratio). |
| 5 | Narration suitability | 10 | Readability, sentence length, formatting noise (URLs/markdown/ALL‑CAPS), number of names to anonymise. |
| 6 | Ending quality | 10 | Explicit ending + update/resolution + twist. |
| 7 | Originality | 5 | `1 − duplicate similarity` (MinHash/near‑dupe). |
| 8 | Duration fit | 5 | Usable narration length vs the selected 1–3 min target. |

## Labels
`90–100 Exceptional · 80–89 Strong · 70–79 Usable · 60–69 Weak · <60 Reject (by default)`.

**100 is deliberately almost impossible** — every category must be near‑perfect, and Engagement
cannot reach the top unless metrics are *verified* (Reddit API). Estimated metrics are capped at 75%
of the engagement weight; unavailable metrics get a modest neutral baseline (~28%).

## Provenance (never fabricated)
Per metric, `metrics_provenance` records:
- **verified** — fetched from the source's real API (Reddit posts).
- **estimated** — a value exists but the source isn't authoritative.
- **unavailable** — no metric (e.g. pasted/Quora text). The category is scored conservatively and the
  card/modal shows an `unavailable` label rather than inventing a number.

## Where it shows
- A label pill (`Strong · 86`) on every story card.
- A **"Why this score?"** link → modal with all 8 category bars, values, plain‑English detail per
  category, and the engagement provenance label (see the verified live render in this session).

## Worked example (verified live)
A pasted AITA story scored **59 → Reject**: Structure 16.4/20 and Originality 5/5 were strong, but
Engagement was **5.6/20 (unavailable** — no verified metrics for pasted text**)** and Duration fit
1.3/5 (~27s vs a 90s target). The same story sourced from Reddit with real upvotes/comments would score
higher on Engagement (verified), which is exactly the intended behaviour.

## Persistence
Stored on `stories`: `score_overall`, `score_label`, `score_breakdown` (JSON of the 8 categories),
`metrics_provenance` (JSON), plus the legacy 0–100 sub‑columns the UI bars use. Added by the
non‑destructive migration in [`src/db/migrate.js`](src/db/migrate.js).
