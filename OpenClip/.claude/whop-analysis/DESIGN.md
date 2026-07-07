# Whop Campaigns stack — implementation contract

A third sidebar stack ("Whop Campaigns") for OpenClip, letting the user run/track Whop-style
clipping & UGC campaigns: create campaigns, collect submissions, review (approve/reject),
track views/payouts/analytics, and request clawbacks. Modeled on Whop Content Rewards
(see video-digest.md) and built to match the existing OpenClip/Story Vault house style
exactly (see backend.md, frontend.md, featureslice.md in this folder).

EVERY agent must read the relevant pattern docs in this folder before writing code, and must
follow the contracts below EXACTLY — other agents build against these names in parallel.

## Domain rules

- Campaign: pays `rate_per_1k` dollars per 1,000 views on approved submissions.
- `earnings_estimate` per submission = `views / 1000 * rate_per_1k`, capped at campaign
  `max_payout` when set. Computed server-side in the Out enricher (never stored).
- "Pay" action: sets submission `status="paid"` and stores `paid_amount = earnings_estimate`
  computed at that moment.
- Campaign `paid_out` (enriched) = sum of `paid_amount` over submissions with status `paid`.
- Campaign `pending_payout` (enriched) = sum of `earnings_estimate` over `approved` submissions.
- `budget_used_pct` = `paid_out / budget * 100` when `budget` set and > 0, else None/null.
- `days_left` = days until `ends_at` (ceil, min 0) when set, else None.
- Approval rate = `(approved + paid) / (approved + paid + rejected) * 100`, 0 when no decisions.
- Clawback: `clawback_requested` bool + `clawback_reason` on a submission (only meaningful for
  approved/paid). It flags the submission; paid totals still include it, UI shows warning badge.
- Views history: whenever a submission's `views` value changes (create with views>0, PATCH,
  or any action that changes views), insert a `WhopViewSnapshot(submission_id, views)` row.
  Analytics series derives daily view deltas from snapshots.

## Backend (FastAPI) — file plan

### `backend/app/models/enums.py` (append)
```python
class WhopCampaignStatus(str, Enum):
    ACTIVE = "active"
    PAUSED = "paused"
    ENDED = "ended"

class WhopCampaignType(str, Enum):
    CLIPPING = "clipping"
    UGC = "ugc"
    FACELESS = "faceless"

class WhopSubmissionStatus(str, Enum):
    PENDING = "pending"
    APPROVED = "approved"
    REJECTED = "rejected"
    PAID = "paid"
```
Category vocabulary (plain strings, validated in schema comment style):
`personal_brand | products | education | entertainment | music | gaming | other`
Platform vocabulary: `tiktok | instagram | youtube | x`

### `backend/app/models/whop.py` (new)
Three models, tables prefixed `whop_`, following storyvault conventions
(TimestampMixin/CreatedAtMixin FIRST in MRO, int PKs, owner FK CASCADE indexed,
String(32) status columns indexed storing enum .value, JSON blobs):

```python
class WhopCampaign(TimestampMixin, Base):
    __tablename__ = "whop_campaigns"
    id; owner_id FK users.id CASCADE index
    name: String(255) not null
    description: Text | None
    campaign_type: String(32) default "clipping"      # clipping|ugc|faceless
    category: String(64) default "personal_brand"
    status: String(32) default "active", index
    rate_per_1k: Float default 1.0 not null
    budget: Float | None                               # None = unlimited
    min_payout: Float | None
    max_payout: Float | None                           # per-submission cap
    platforms: JSON (list[str]) default list not null
    requirements: JSON (list[str]) default list not null
    asset_links: JSON (list[dict {label,url}]) default list not null
    whop_url: String(500) | None
    thumbnail_path: String(500) | None                 # storage key, NOT url
    ends_at: DateTime(timezone=True) | None

class WhopSubmission(TimestampMixin, Base):
    __tablename__ = "whop_submissions"
    id; owner_id FK users.id CASCADE index
    campaign_id FK whop_campaigns.id CASCADE index not null
    creator_handle: String(120) | None
    platform: String(32) default "tiktok" not null
    post_url: String(500) not null
    title: String(255) | None
    status: String(32) default "pending" index
    views: Integer default 0 not null
    likes: Integer default 0 not null
    paid_amount: Float default 0.0 not null
    rejection_reason: Text | None
    clawback_requested: Boolean default False not null
    clawback_reason: Text | None
    notes: Text | None

class WhopViewSnapshot(CreatedAtMixin, Base):
    __tablename__ = "whop_view_snapshots"
    id; submission_id FK whop_submissions.id CASCADE index not null
    views: Integer not null
```
Register all three in `app/models/__init__.py` (+ `__all__`).

### `backend/app/services/storage.py` (append one key builder, near the other key fns)
```python
def whop_thumbnail_key(campaign_id: int, ext: str) -> str:
    return f"whop/campaigns/{campaign_id}/thumbnail{ext}"
```

### `backend/app/schemas/whop.py` (new)
Pydantic v2, mirroring schemas/storyvault.py style. Field names EXACTLY as in the TS
interfaces below (snake_case identical on both sides).

- `WhopAssetLink { label: str (1..120), url: str (1..500) }`
- `WhopCampaignCreate { name (1..255), description?: str|None (<=2000), campaign_type: str = "clipping", category: str = "personal_brand", rate_per_1k: float = 1.0 (gt=0, le=1000), budget: float|None (ge=0), min_payout: float|None (ge=0), max_payout: float|None (ge=0), platforms: list[str] = [], requirements: list[str] = [] (each <=280, max 25), asset_links: list[WhopAssetLink] = [] (max 10), whop_url: str|None (<=500), ends_at: datetime|None }`
  Validate campaign_type/platforms values against the vocabularies (422 on bad values —
  use a field_validator).
- `WhopCampaignUpdate` — all fields optional (also `status`, validated against enum).
- `WhopCampaignOut` — from_attributes=True; all stored fields plus enriched (defaulted):
  `thumbnail_url: str|None = None`, `submissions_total/submissions_pending/submissions_approved/submissions_rejected/submissions_paid: int = 0`, `views_total: int = 0`, `paid_out: float = 0`, `pending_payout: float = 0`, `budget_used_pct: float|None = None`, `days_left: int|None = None`.
- `WhopSubmissionCreate { platform: str = "tiktok", post_url: str (1..500), title?: str|None (<=255), creator_handle?: str|None (<=120), views: int = 0 (ge=0), likes: int = 0 (ge=0), notes?: str|None (<=2000) }`
- `WhopSubmissionUpdate` — all optional: platform, post_url, title, creator_handle, views, likes, notes.
- `WhopReasonBody { reason: str|None = None (<=2000) }` (used by reject + clawback)
- `WhopSubmissionOut` — from_attributes; stored fields plus enriched:
  `earnings_estimate: float = 0`, `campaign_name: str|None = None`, `rate_per_1k: float = 0`.
- `WhopDashboardOut { campaigns_active: int, campaigns_total: int, submissions_pending: int, submissions_total: int, views_total: int, paid_out: float, pending_payout: float, approval_rate: float, recent_submissions: list[WhopSubmissionOut], campaigns: list[WhopCampaignOut] }`
- `WhopAnalyticsPoint { date: str (YYYY-MM-DD), views: int, earnings: float }`
- `WhopCampaignStat { campaign_id: int, name: str, submissions: int, views: int, earnings: float }`
- `WhopAnalyticsOut { days: int, views_total: int, earnings_total: float, effective_cpm: float, submissions_total: int, approval_rate: float, series: list[WhopAnalyticsPoint], campaigns: list[WhopCampaignStat] }`
  (`effective_cpm` = earnings_total / views_total * 1000, 0 when no views. earnings here =
  paid_out + pending_payout across the filtered scope; views_total = current views sum.)

### `backend/app/api/v1/endpoints/whop.py` (new)
`router = APIRouter()`; every route takes `current_user: User = Depends(get_current_user)`,
`db: AsyncSession = Depends(get_session)`. Ownership helpers `_owned_campaign`, `_owned_submission`
that 404. Enrichers `_campaign_out(db, campaign)` and `_submission_out(submission, campaign)`.

| Method | Path | Body → Response |
|---|---|---|
| GET | `/dashboard` | → WhopDashboardOut (recent_submissions = last 8 by updated_at desc; campaigns = active ones by views_total desc, max 6) |
| GET | `/campaigns?status=&q=` | → list[WhopCampaignOut], updated_at desc |
| POST | `/campaigns` | WhopCampaignCreate → WhopCampaignOut, 201 |
| GET | `/campaigns/{id}` | → WhopCampaignOut |
| PATCH | `/campaigns/{id}` | WhopCampaignUpdate → WhopCampaignOut |
| DELETE | `/campaigns/{id}` | → Message (cascade deletes submissions + snapshots via FK; delete thumbnail file via storage.delete, ignore errors) |
| POST | `/campaigns/{id}/thumbnail` | multipart `file` (allow .png/.jpg/.jpeg/.webp, reject others 400) → WhopCampaignOut. Save via storage (whop_thumbnail_key), set thumbnail_path. No Celery. |
| POST | `/campaigns/{id}/submissions` | WhopSubmissionCreate → WhopSubmissionOut, 201 (writes snapshot if views>0) |
| GET | `/submissions?status=&campaign_id=&limit=100(le 500)` | → list[WhopSubmissionOut], updated_at desc |
| PATCH | `/submissions/{id}` | WhopSubmissionUpdate → WhopSubmissionOut (snapshot if views changed) |
| POST | `/submissions/{id}/approve` | → WhopSubmissionOut (from pending/rejected → approved; clears rejection_reason) |
| POST | `/submissions/{id}/reject` | WhopReasonBody → WhopSubmissionOut (→ rejected, stores reason) |
| POST | `/submissions/{id}/pay` | → WhopSubmissionOut (only from approved, else 409; sets paid_amount) |
| POST | `/submissions/{id}/clawback` | WhopReasonBody → WhopSubmissionOut (only approved/paid, else 409; sets clawback_requested=True + reason) |
| DELETE | `/submissions/{id}` | → Message |
| GET | `/analytics?days=30(7..365)&campaign_id=` | → WhopAnalyticsOut |

Analytics series algorithm: fetch snapshots for the owner's (optionally one campaign's)
submissions with created_at >= start (UTC, days back). Per submission per day keep the LAST
snapshot's views; daily views delta per submission = that day's views minus the previous known
views value (previous day in range, or the submission's baseline = last snapshot before the range,
else 0); clamp negatives to 0; sum across submissions per day. earnings per day = views_delta /
1000 * campaign rate (capped proportionally is NOT required — use uncapped rate math for the
series; totals use the proper capped values). Fill every date in the range with zeros so the
chart has a continuous axis.

Register in `app/api/v1/router.py`:
`api_router.include_router(whop.router, prefix="/whop", tags=["whop"])` (+ import).

### `backend/alembic/versions/0017_whop.py` (new)
Hand-written, revision `0017_whop`, down_revision `0016_sv_music_presets`, docstring noting
SQLite installs get the tables via app.db_init create_all; this migration is for PostgreSQL.
Three create_table calls mirroring the models exactly; real downgrade dropping in FK order
(snapshots, submissions, campaigns).

### `backend/app/tests/test_whop_api.py` (new)
Follow test_api.py style (client fixture, register throwaway user, Bearer headers). Cover:
campaign CRUD + validation error (bad platform), thumbnail upload (tiny PNG bytes), submission
create/approve/pay math (views=50_000, rate=2.0, max_payout=60 → earnings_estimate == 60.0,
paid_amount == 60.0), reject with reason, clawback flag, dashboard totals, analytics shape
(series covers `days` entries, views_total correct), ownership 404 for another user's campaign.

## Frontend (Next.js) — file plan

House style is MANDATORY: `"use client"` pages, container `mx-auto max-w-6xl space-y-6`,
inline `<h1 className="text-2xl font-bold tracking-tight">` + `<p className="text-muted-foreground">`
header, shadcn ui components from `@/components/ui/*` (NOT `oc-*` classes), lucide icons,
sonner toasts (`toast.success` / `toast.error(err instanceof Error ? err.message : "...")`),
centered `<Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />` loading state,
Card empty states with icon + CTA, Radix Dialog for create/edit, `window.confirm()` for deletes,
`disabled={m.isPending}` + spinning Loader2 on busy buttons, react-query invalidation (NO
optimistic updates), poll intervals: dashboard 6s / detail 5s / submissions 4s.

Visual accents (consistent everywhere): budget/paid-out progress bars are ORANGE
(`bg-amber-500` fill on a `bg-muted` h-1.5 rounded-full track — hand-rolled div, not the
Progress component, since Progress uses primary color); rate pills are BLUE
(`<Badge className="border-transparent bg-blue-500/15 text-blue-500 hover:bg-blue-500/15">$2.00 / 1K</Badge>`).
Submission status → badge variant: pending→outline, approved→success, rejected→destructive,
paid→default; clawback_requested adds an extra `warning` badge "Clawback".

### `frontend/src/lib/types.ts` (append)
```ts
export type WhopCampaignType = "clipping" | "ugc" | "faceless";
export type WhopCampaignStatus = "active" | "paused" | "ended";
export type WhopPlatform = "tiktok" | "instagram" | "youtube" | "x";
export type WhopSubmissionStatus = "pending" | "approved" | "rejected" | "paid";
export interface WhopAssetLink { label: string; url: string }
export interface WhopCampaign {
  id: number; name: string; description: string | null;
  campaign_type: WhopCampaignType; category: string; status: WhopCampaignStatus;
  rate_per_1k: number; budget: number | null; min_payout: number | null; max_payout: number | null;
  platforms: WhopPlatform[]; requirements: string[]; asset_links: WhopAssetLink[];
  whop_url: string | null; ends_at: string | null; created_at: string; updated_at: string;
  thumbnail_url: string | null;
  submissions_total: number; submissions_pending: number; submissions_approved: number;
  submissions_rejected: number; submissions_paid: number;
  views_total: number; paid_out: number; pending_payout: number;
  budget_used_pct: number | null; days_left: number | null;
}
export interface WhopSubmission {
  id: number; campaign_id: number; creator_handle: string | null; platform: WhopPlatform;
  post_url: string; title: string | null; status: WhopSubmissionStatus;
  views: number; likes: number; paid_amount: number;
  rejection_reason: string | null; clawback_requested: boolean; clawback_reason: string | null;
  notes: string | null; created_at: string; updated_at: string;
  earnings_estimate: number; campaign_name: string | null; rate_per_1k: number;
}
export interface WhopDashboard {
  campaigns_active: number; campaigns_total: number;
  submissions_pending: number; submissions_total: number;
  views_total: number; paid_out: number; pending_payout: number; approval_rate: number;
  recent_submissions: WhopSubmission[]; campaigns: WhopCampaign[];
}
export interface WhopAnalyticsPoint { date: string; views: number; earnings: number }
export interface WhopCampaignStat { campaign_id: number; name: string; submissions: number; views: number; earnings: number }
export interface WhopAnalytics {
  days: number; views_total: number; earnings_total: number; effective_cpm: number;
  submissions_total: number; approval_rate: number;
  series: WhopAnalyticsPoint[]; campaigns: WhopCampaignStat[];
}
```

### `frontend/src/lib/utils.ts` (append)
```ts
export function formatMoney(n: number): string        // "$1,234.56" (always 2 decimals)
export function formatCompactNumber(n: number): string // "1.2M" / "87.8K" / "950" (1 decimal, trim .0)
```

### `frontend/src/lib/api.ts` (append to the `api` object, whop-prefixed, matching sv style)
`whopDashboard()`, `whopListCampaigns(params?: { status?: string; q?: string })` (URLSearchParams),
`whopGetCampaign(id)`, `whopCreateCampaign(data: {...WhopCampaignCreate-shaped})`,
`whopUpdateCampaign(id, data)`, `whopDeleteCampaign(id)`,
`whopUploadCampaignThumbnail(id, file: File)` (FormData "file"),
`whopCreateSubmission(campaignId, data)`, `whopListSubmissions(params?: { status?: string; campaign_id?: number })`,
`whopUpdateSubmission(id, data)`, `whopApproveSubmission(id)`, `whopRejectSubmission(id, reason?)`,
`whopPaySubmission(id)`, `whopClawbackSubmission(id, reason?)`, `whopDeleteSubmission(id)`,
`whopAnalytics(params?: { days?: number; campaign_id?: number })`.

### `frontend/src/hooks/use-api.ts` (append)
Query keys: `["whop-dashboard"]`, `["whop-campaigns", params ?? {}]`, `["whop-campaign", id]`,
`["whop-submissions", params ?? {}]`, `["whop-analytics", params ?? {}]`.

Hooks: `useWhopDashboard(poll = false)` (6s), `useWhopCampaigns(params?)`,
`useWhopCampaign(id, poll = false)` (5s, enabled !!id), `useWhopCreateCampaign()`,
`useWhopUpdateCampaign()` ({id, data}), `useWhopDeleteCampaign()`, `useWhopUploadThumbnail()`
({id, file}), `useWhopSubmissions(params?, poll = false)` (4s), `useWhopCreateSubmission()`
({campaignId, data}), plus a shared factory `useWhopSubmissionMutation<TVars>(fn)` that
invalidates `whop-submissions`, `whop-campaigns`, `whop-campaign`, `whop-dashboard`,
`whop-analytics` — used by `useWhopUpdateSubmission` ({id, data}), `useWhopApproveSubmission`,
`useWhopRejectSubmission` ({id, reason?}), `useWhopPaySubmission`, `useWhopClawbackSubmission`
({id, reason?}), `useWhopDeleteSubmission`. Campaign mutations invalidate `whop-campaigns`,
`whop-campaign`, `whop-dashboard` (+ `whop-analytics` for delete). `useWhopAnalytics(params?)`.

### `frontend/src/components/layout/Sidebar.tsx` (edit)
Add a third section AFTER storyvault:
```ts
{
  id: "whop",
  label: "Whop Campaigns",
  items: [
    { href: "/whop/dashboard", label: "Dashboard", icon: LayoutDashboard },
    { href: "/whop/campaigns", label: "Campaigns", icon: Megaphone },
    { href: "/whop/review", label: "Review", icon: ClipboardCheck },
    { href: "/whop/analytics", label: "Analytics", icon: BarChart3 },
  ],
},
```
(import Megaphone, ClipboardCheck, BarChart3 from lucide-react).

### `frontend/src/app/(app)/whop/page.tsx` (new)
Server redirect exactly like storyvault/page.tsx: `redirect("/whop/dashboard")`.

### `frontend/src/components/whop/platform-meta.tsx` (new)
Single source for platform rendering:
```tsx
export const WHOP_PLATFORMS: { value: WhopPlatform; label: string; icon: LucideIcon }[]
// tiktok → Music2, instagram → Instagram, youtube → Youtube, x → Twitter (lucide)
export function PlatformIcons({ platforms, size = 14 }: { platforms: WhopPlatform[]; size?: number })
// row of muted icons with title tooltips
export function platformLabel(p: WhopPlatform): string
```
Also export shared vocab constants:
`WHOP_TYPES: {value,label}[]` (Clipping/UGC/Faceless),
`WHOP_CATEGORIES: {value,label}[]` (personal_brand→"Personal Brand", products, education,
entertainment, music, gaming, other), and
`RatePill({ rate }: { rate: number })` → the blue badge `${rate.toFixed(2)} / 1K` prefixed with $,
and `BudgetBar({ paidOut, budget }: { paidOut: number; budget: number | null })` → the
"$X of $Y paid out … NN%" line + orange bar (shows "$X paid out · Unlimited budget" when budget null).

### `frontend/src/components/whop/campaign-form.tsx` (new)
`CampaignForm({ initial?: WhopCampaign | null, submitLabel: string, submitting: boolean, onSubmit: (value: CampaignFormValue, thumbnail: File | null) => void | Promise<void> })`
where `export interface CampaignFormValue { name: string; description: string; campaign_type: WhopCampaignType; category: string; rate_per_1k: number; budget: number | null; min_payout: number | null; max_payout: number | null; platforms: WhopPlatform[]; requirements: string[]; asset_links: WhopAssetLink[]; whop_url: string; ends_at: string | null }`.
Export `DEFAULT_CAMPAIGN: CampaignFormValue` mirroring backend defaults.
Fields (mirroring the video's create-campaign form, keep it one clean column with `space-y-4`):
Name* (Input), Description (Textarea), Type* (Select from WHOP_TYPES) + Category* (Select) side
by side (`grid grid-cols-2 gap-3`), Reward rate* ($ / 1K views, number Input step 0.25) + Budget
($, empty = unlimited) side by side, Min payout + Max payout side by side, Platforms (toggle
chips using the `border-primary bg-primary/10 text-primary` active pattern with platform icons),
End date (native `<input type="date">` styled via Input), Whop URL (Input, optional),
Requirements (list editor: existing chips with X remove, Input + Add button, Enter adds),
Asset links (rows of label+url Inputs with remove, "Add link" button), Campaign thumbnail
(file input accepting image/*, shows preview `<img>` of the chosen file or `initial.thumbnail_url`;
pass the File to onSubmit — the PAGE handles upload after create/update). Submit button full
width at bottom with busy Loader2. Number inputs: keep local string state, parse on submit;
empty optional numbers → null.

### `frontend/src/components/whop/whop-tour.tsx` (new)
`WhopTour({ open, onOpenChange }: { open: boolean; onOpenChange: (o: boolean) => void })` and
`export const WHOP_TOUR_KEY = "openclip_whop_tour_seen";`
4-step onboarding dialog matching the user's reference screenshots: DialogContent `sm:max-w-lg`,
top illustration area (rounded-lg border bg-muted/40, ~h-44, containing a small hand-built
mock: step1 mini campaign-form mock, step2 mini area-chart mock (tiny inline SVG), step3 mini
submission row with Approve/Reject buttons mock, step4 mini paid row with "Request clawback"
mock — pure divs/svg, muted colors, non-interactive), then 4 segmented progress bars
(`flex gap-2`, each `h-1 flex-1 rounded-full`, filled `bg-amber-500` for steps <= current else
`bg-muted`), step title (`text-lg font-semibold`), one-sentence description
(text-muted-foreground), footer: "Previous" ghost button (hidden on step 1), "N of 4" counter
(text-xs text-muted-foreground), primary "Next" → last step "Get Started". A small link row
"Watch the full walkthrough video" with a Play icon that toggles an inline
`<video src="/whop-tutorial.mp4" controls className="w-full rounded-lg" />` replacing the mock
area. Steps:
1. "Create Your Campaign" — "Set up your reward rate, budget, platforms, and requirements — everything clippers need to start posting for you."
2. "Track Analytics" — "Monitor views, payouts, and effective CPM across all your campaigns in real time."
3. "Review Videos" — "Approve or reject creator submissions to ensure quality content for your brand."
4. "Request a Clawback" — "Flag a paid submission for clawback when a video doesn't meet your requirements."
Closing the dialog (any way) sets `localStorage[WHOP_TOUR_KEY] = "1"`.

### Video asset
Copy `C:\Users\Anton\Downloads\whop.mp4` → `frontend/public/whop-tutorial.mp4` (done by the
foundation agent via PowerShell Copy-Item).

### Pages (each its own agent, new files only)

**`frontend/src/app/(app)/whop/dashboard/page.tsx`** — mirrors storyvault command page.
`useWhopDashboard(true)`. Header "Whop Campaigns" / "Run clipping campaigns, review submissions, and track payouts." with a ghost `HelpCircle` icon button (title "Take the tour") that opens WhopTour. Auto-open tour on first visit (`useEffect`: if `localStorage[WHOP_TOUR_KEY] !== "1"` → open).
Stat cards (grid sm:2 lg:4): Active campaigns (Megaphone), Pending review (ClipboardCheck),
Total views (Eye, formatCompactNumber), Paid out (DollarSign, formatMoney, muted line
`formatMoney(pending_payout) + " pending"`). Quick actions row: "New campaign" → /whop/campaigns
(outline, Plus), "Review submissions" → /whop/review (outline, ClipboardCheck; append
` (${submissions_pending})` when > 0), "Analytics" → /whop/analytics (outline, BarChart3).
Two-column `grid gap-6 lg:grid-cols-2`: "My campaigns" Card (rows: thumbnail 10x10 rounded
(img or Megaphone placeholder), name link → detail, RatePill, BudgetBar (compact), views;
empty state "No campaigns yet — create your first campaign." with CTA link) and
"Recent submissions" Card (rows: title-or-post_url (truncated, external link icon), campaign_name,
status badge (+ clawback warning badge), views + earnings_estimate, formatRelativeTime; empty
state text). Loading: centered Loader2 under header.

**`frontend/src/app/(app)/whop/campaigns/page.tsx`** — mirrors storyvault projects page.
`useWhopCampaigns()` (client-filter by status tab), Tabs: All / Active / Paused / Ended.
Header actions: Dialog (max-h-[88vh] overflow-y-auto sm:max-w-2xl) + "New campaign" trigger
(Plus). On create: `createCampaign.mutateAsync(payload)`; if thumbnail File chosen →
`uploadThumbnail.mutateAsync({ id, file })`; toast, close. Grid `md:grid-cols-2 lg:grid-cols-3`
of campaign cards styled like Whop marketplace cards: CardHeader row = thumbnail 9x9 rounded-lg
(img or gradient placeholder `bg-gradient-to-br from-amber-500/30 to-orange-600/30` with
Megaphone), name (link to detail, truncate), RatePill; description line-clamp-1
text-sm text-muted-foreground; BudgetBar; footer `grid grid-cols-3` with tiny uppercase labels
Type / Platforms / Views and values (type label, PlatformIcons, formatCompactNumber views);
status badge when paused/ended; kebab DropdownMenu: "Open", "Pause"/"Resume" (PATCH status),
"End campaign" (PATCH status ended, confirm()), "Delete" (destructive, confirm()). Empty state
Card: Megaphone icon, "No campaigns yet. Launch your first clipping campaign to start collecting
submissions.", CTA button opens the dialog.

**`frontend/src/app/(app)/whop/campaigns/[id]/page.tsx`** — mirrors the video's campaign detail.
`useParams` → Number, `useWhopCampaign(id, true)`, `useWhopSubmissions({ campaign_id: id }, true)`.
Back link → /whop/campaigns. Header: thumbnail 12x12, h1 name + status Badge
(active→success, paused→warning, ended→outline), description; actions: "Edit" outline (Dialog
with CampaignForm initial, PATCH + optional thumbnail upload), Pause/Resume outline, "New
submission" primary (Dialog: platform Select, post URL Input, title, creator handle, initial
views/likes number Inputs, notes Textarea → useWhopCreateSubmission). If whop_url: small
ExternalLink link "View on Whop". Stats: two stacked blocks in a Card — "PAID OUT" (uppercase
text-xs muted label, `{formatMoney(paid_out)} of {budget ? formatMoney(budget) : "Unlimited"}`
+ orange bar + pct right) and "TIME LEFT" (`{days_left} days left` or "No end date", elapsed bar)
— then a meta row `grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-4` of label-over-value:
REWARD (RatePill), TYPE, MIN PAYOUT, MAX PAYOUT, CATEGORY, PLATFORMS (PlatformIcons) — em dash
when unset. REQUIREMENTS Card: wrap of rounded-full chips (`rounded-full border px-3 py-1
text-xs`); hidden when empty. ASSETS Card: rows with LinkIcon + label + truncated url,
target=_blank; hidden when empty. Submissions Card: rows (`rounded-md border p-3`): platform
icon, title-or-url external link, creator_handle, status badge (+clawback badge), "views"
inline editor (compact Input w-24 defaultValue + check button calling useWhopUpdateSubmission
on change), earnings_estimate (formatMoney) / paid_amount for paid, action buttons per status:
pending → Approve (success-ish outline, Check) + Reject (destructive ghost, X → opens small
reason Dialog with Textarea, optional); approved → "Mark paid" (primary, DollarSign) +
"Clawback" (ghost warning, Undo2 → reason Dialog); paid → "Clawback" if not clawback_requested;
any → kebab or trash Delete with confirm(). Empty state: "No submissions yet. Add the first
clip submitted to this campaign." + CTA opening the submission dialog.

**`frontend/src/app/(app)/whop/review/page.tsx`** — review queue.
Header "Review Videos" / "Approve or reject creator submissions to keep quality high."
`useWhopSubmissions(params, true)` with Tabs: Pending (default) / Approved / Paid / Rejected /
All (status param, undefined for All) + campaign filter Select (from useWhopCampaigns, "All
campaigns" default). Summary chips above list: counts per status (client-derived from the
unfiltered lists is NOT needed — just show current list length in tab labels only when cheap;
keep simple: plain Tabs). Each submission a Card row (list, `space-y-3`): left = platform icon
in muted rounded square, title-or-post_url external link (target _blank), campaign_name +
creator_handle + formatRelativeTime(created_at) muted line, rejection_reason /clawback_reason
shown as text-xs text-destructive/amber when present; middle = views (formatCompactNumber, Eye)
+ inline "update views" editor identical to detail page, earnings (formatMoney
earnings_estimate; for paid show paid_amount with "paid" prefix); right = status badge +
actions identical to the detail page (Approve/Reject/Mark paid/Clawback/Delete). Shared reason
dialog implemented locally (title "Reject submission"/"Request clawback", Textarea, confirm
button destructive/warning). Empty states per tab ("Nothing pending review — you're all caught
up." with CheckCircle2 icon etc.). Loading Loader2.

**`frontend/src/app/(app)/whop/analytics/page.tsx`** — analytics.
Header "Track Analytics" / "Monitor performance and payouts across your campaigns." Controls
row: Select days (Last 7 / 30 / 90 days → 7|30|90, default 30) + Select campaign (All +
useWhopCampaigns list). `useWhopAnalytics({ days, campaign_id })` (+ refetchInterval 15s).
Stat cards (sm:2 lg:4): Views generated (formatCompactNumber), Total payout
(formatMoney earnings_total), Effective CPM (formatMoney effective_cpm, muted "per 1K views"),
Submissions (count, muted `${approval_rate.toFixed(0)}% approval`). Chart Card "Views over
time": hand-rolled responsive SVG area/line chart component `ViewsChart({ series })` defined
in the same file — viewBox 0 0 720 220, no external lib: compute max, map points, `<path>` line
stroke `var(--red)` strokeWidth 2 + gradient fill area (defs linearGradient stopColor
`var(--red)` opacity .25 → 0), x labels ~5 evenly spaced dates (short "MMM D"), y gridlines 4
with formatCompactNumber labels, hover: overlay invisible rects per point showing a
`<title>{date · views views · $earnings}</title>` (native tooltip — sufficient). Empty series
(all zeros) → centered muted "No view activity in this period yet. Views appear as you update
submission counts." Per-campaign Card "Campaign breakdown": simple table (`w-full text-sm`,
muted uppercase text-xs header row, divide-y): Campaign (link to detail) / Submissions / Views
/ Earnings / CPM (earnings/views*1000, "—" when 0 views). Loading Loader2.

## Verification

Backend: `backend\.venv\Scripts\python.exe -m pip install -r backend\requirements-test.txt`
(if pytest missing), then from `backend/`: `.venv\Scripts\python.exe -m pytest app/tests/test_whop_api.py -q`
(and the full suite), `.venv\Scripts\python.exe -m ruff check app`.
Frontend: from `frontend/`: `npm run typecheck`, `npm run lint`, `npm run test`.
Fix until green — do not stop at reporting failures.
