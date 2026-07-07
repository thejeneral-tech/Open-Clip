# Campaign Studio Integration Design Report

## 1. Data Linking: Video → Whop Campaign

**Recommendation: Nullable FK approach (lowest risk, matches house conventions)**

**Option Analysis:**
- **Option A: Nullable `whop_campaign_id` FK on `videos` table** ✓ RECOMMENDED
  - Pros: Single query join, minimal schema change, matches existing VideoSource/status patterns
  - Cons: One video per campaign
  - Risk: LOW
  
- **Option B: Separate link table `video_campaign_links`**
  - Pros: Many-to-many support
  - Cons: Extra joins, overengineering (no stated multi-campaign reuse requirement)
  - Risk: MEDIUM
  
- **Option C: Reuse existing `project_id` concept**
  - Pros: No new column
  - Cons: Video → Project → Campaign requires semantic coupling, breaks OpenClip's existing project model
  - Risk: MEDIUM-HIGH

**Concrete Change (Option A):**

File: `backend/app/models/video.py` (after line 23)
```
whop_campaign_id: Mapped[int | None] = mapped_column(
    ForeignKey("whop_campaigns.id", ondelete="SET NULL"), index=True, nullable=True, default=None
)
```

Rationale:
- `ondelete="SET NULL"`: Matches house convention (TimestampMixin pattern); if campaign deleted, video remains orphaned but undamaged
- `index=True`: Fast queries for "list videos in this campaign"
- `nullable=True`: Additive, SQLite db_init auto-adds, backward compatible
- No changes needed to Project model—videos still belong to projects AND optionally to a campaign

Migration: Create `backend/alembic/versions/[new_revision].py` with:
```
op.add_column('videos', sa.Column('whop_campaign_id', sa.Integer, sa.ForeignKey('whop_campaigns.id', ondelete='SET NULL'), nullable=True))
op.create_index('ix_videos_whop_campaign_id', 'videos', ['whop_campaign_id'])
```

## 2. Submission-from-Clip: Prefilling WhopSubmission

**Available Prefill Fields from Clip/Export:**

From `Clip` (models/clip.py):
- `clip.title` → `WhopSubmission.title` (String, ≤255 chars; clip.title is String(512))
- `clip.description` → Could extend WhopSubmission with description_source
- Platform: Not directly on Clip; platform must be selected by user in UI

From `Export` (models/export.py):
- `export.storage_path` → `WhopSubmission.post_url` (temporary local playable URL, see below)
- NOT available: creator_handle, views, likes (submit fresh user input)

From `Video` (models/video.py):
- `video.thumbnail_path` → Use as submission thumbnail preview in UI
- NOT on submission schema directly

**Concrete Prefill Strategy:**

When user clicks "Submit to Campaign" from clip detail/export:

1. **title**: Auto-fill from `clip.title` (users expect this)
2. **post_url**: Generate a temporary local playable URL
   - Pattern: `/api/v1/exports/{export_id}/download` (see endpoints/exports.py lines 44-63)
   - This is a browser-downloadable link with temporary storage
   - User edits post_url to final platform URL (TikTok/Instagram/etc)
   - Mark with tooltip: "Placeholder — replace with your posted video URL"

3. **Views/likes**: Leave at 0 (user updates later from platform analytics)

4. **creator_handle**: Empty (user enters their handle)

**UX Pattern in whop/studio or submission create dialog:**
```
Pre-filled from clip:
├─ Title: [clip.title] (editable)
├─ Platform: [Select—required] (not auto-filled)
├─ Post URL: /api/v1/exports/{export_id}/download (edit before submit)
├─ Creator handle: [empty—user fills]
├─ Views: 0 (user updates)
└─ Notes: [optional]
```

**Risk**: If user submits with the local `/api/v1/exports` URL, the submission won't match a real platform URL. Mitigate with UI validation: warn if post_url doesn't contain `tiktok.com`, `instagram.com`, `youtube.com`, or `x.com` before submitting. Or accept the local URL as draft state and require edit before "publish".

## 3. Embed Feasibility: Whop Campaign Preview in iframe

**Finding: Most Whop pages have X-Frame-Options headers (embed blocked)**

Why: Whop.com marketplace pages use X-Frame-Options: SAMEORIGIN to prevent framing by competitors.

**Recommendation: Rich Campaign Preview Card + External Link (Approach B is safest)**

### Approach A (Attempted): Iframe with Fallback
```tsx
<div>
  <iframe src={campaign.whop_url} sandbox="allow-same-origin allow-popups" />
  {/* Fallback if blocked: */}
  <p>Unable to load preview. <a href={campaign.whop_url} target="_blank">Open on Whop</a></p>
</div>
```
Downside: CSP header likely blocks this; next.config.js has no explicit CSP, so browser default applies. Any x-frame-options header from whop.com wins, and iframe silently fails.

### Approach B (Recommended): Rich Campaign Preview Card
No iframe attempt. Instead, show a "campaign card" with:
- Thumbnail image (campaign.thumbnail_url)
- Campaign name (h3 link)
- Rate pill (RatePill component: "$X.XX / 1K" blue badge)
- Budget bar (BudgetBar component: orange progress)
- Platform icons (PlatformIcons from whop/platform-meta.tsx)
- Requirements (wrapped chip list)
- Prominent button: "Open on Whop" → external link (target="_blank")

This is already designed in the DESIGN.md (campaigns/[id]/page.tsx line 387: "If whop_url: small ExternalLink").

**next.config.js Review:**
Current file (lines 1-18) has NO CSP headers, no X-Frame-Options, no sandbox policies. This means:
- No explicit CSP blocking iframes
- But Whop.com's X-Frame-Options: SAMEORIGIN on their responses blocks cross-origin framing
- Fallback link always works

**Concrete Minimal Change:**

In any page showing campaign detail or preview card:
```tsx
{campaign.whop_url && (
  <a href={campaign.whop_url} target="_blank" rel="noopener noreferrer"
     className="inline-flex items-center gap-2 text-blue-600 hover:underline">
    Open on Whop <ExternalLink size={14} />
  </a>
)}
```

For ambitious future enhancement: Attempt iframe with graceful fallback
```tsx
const [iframeBlocked, setIframeBlocked] = useState(false);
useEffect(() => {
  const timer = setTimeout(() => setIframeBlocked(true), 2000);
  return () => clearTimeout(timer);
}, []);

return (
  <>
    {!iframeBlocked && campaign.whop_url && (
      <iframe 
        src={campaign.whop_url}
        style={{ opacity: 0.5 }} // Hint it may not load
        onError={() => setIframeBlocked(true)}
        onLoad={() => clearTimeout(...)}
      />
    )}
    {iframeBlocked && (
      <div className="rounded border bg-muted p-4">
        <p className="text-sm text-muted-foreground">
          Preview not available. {/* X-Frame-Options blocks embedding */}
        </p>
        <a href={campaign.whop_url} target="_blank" ...>Open on Whop</a>
      </div>
    )}
  </>
);
```

But keep it simple: just the external link is sufficient and less surprising to users.

## 4. Sidebar / Nav: Where Should "Studio" Live?

**Current Sidebar Structure** (components/layout/Sidebar.tsx, lines 44-80):
- SECTIONS[0] = "openclip" (Dashboard, Projects, Bots, etc.)
- SECTIONS[1] = "storyvault" (Dashboard, Projects, Library, **Video Studio**, Voice Lab, Presets, Publishing)
- SECTIONS[2] = "whop" (Dashboard, Campaigns, Review, Analytics)

**Observation:**
The Whop section is ALREADY in Sidebar.tsx and fully populated. The Sidebar already lists:
- /whop/dashboard
- /whop/campaigns
- /whop/review
- /whop/analytics

**New Feature: Campaign Studio (Clip → Submission workflow)**

This is a TRANSITION page: user finishes editing a clip in OpenClip, exports it, then submits to a Whop campaign.

**Recommendation: Add "Studio" as a 5th item in the Whop section**

File: `components/layout/Sidebar.tsx` (lines 73-78, after Review item):
```tsx
{
  id: "whop",
  label: "Whop Campaigns",
  items: [
    { href: "/whop/dashboard", label: "Dashboard", icon: LayoutDashboard },
    { href: "/whop/campaigns", label: "Campaigns", icon: Megaphone },
    { href: "/whop/review", label: "Review", icon: ClipboardCheck },
    { href: "/whop/analytics", label: "Analytics", icon: BarChart3 },
    { href: "/whop/studio", label: "Studio", icon: Clapperboard }, // NEW
  ],
},
```

Import: `Clapperboard` is already imported (line 11).

**Alternative: No Sidebar Item**
Keep Studio discovery minimal—users find it via:
1. OpenClip projects page → clip detail → Export view → "Submit to Campaign" button
2. OR /whop/campaigns detail → "New submission" button → modal/dialog

If Studio is just a form wrapper (not a major section), skip the Sidebar entry. But given that DESIGN.md specifies separate page routes (/whop/studio), adding a nav item improves discoverability.

**File to Create:**
`frontend/src/app/(app)/whop/studio/page.tsx` (new page)
- Matches pattern: /storyvault/studio (line 64 in Sidebar)
- Layout: Campaign picker → clip picker → submission form prefilled

## Summary: Key Files & Changes

### Backend

1. **models/video.py**: Add `whop_campaign_id` FK column (1 line)
2. **alembic/versions/[new].py**: Migration for PostgreSQL compatibility
3. **No changes** to endpoints/whop.py or schemas/whop.py (Whop stack is complete)

### Frontend

1. **components/layout/Sidebar.tsx**: Add Studio nav item (1 item in whop section)
2. **app/(app)/whop/studio/page.tsx**: New page (full form, clip+campaign selector, prefill logic)
3. **lib/api.ts**: If creating submissions programmatically, uses existing whopCreateSubmission hook
4. **hooks/use-api.ts**: Already has all Whop hooks; Studio page reuses them

### Risk Flags

1. **Whop Campaign ID Null State**: If video.whop_campaign_id is NULL, the video is in OpenClip only. UI must gracefully handle "no campaign assigned". Queries must filter WHERE whop_campaign_id IS NOT NULL.

2. **Post URL Placeholder**: If user submits with /api/v1/exports URL instead of final platform URL, the Whop dashboard will show a non-functional link. Add validation or education.

3. **No Iframe Support**: Users expecting Whop preview embeds will see only external link. This is acceptable (most SaaS do this).

4. **Export Download Expiry**: The /api/v1/exports/{id}/download endpoint returns the file or redirects to S3. If S3, the URL is permanent; if local storage, ensure cleanup policy is clear.

5. **Agent Coordination**: Multiple agents building Whop pages must sync on WHOP_PLATFORMS enum (backend/app/models/enums.py line 208: [\"tiktok\", \"instagram\", \"youtube\", \"x\"]).

## Data Flow Diagram: OpenClip → Campaign Studio → Whop

```
User in OpenClip:
  Projects → Video → Clips → Export (mp4 file)
    │
    └─→ "Submit to Campaign" button
          │
          ├─→ Prefill from Clip:
          │   ├─ title (from clip.title)
          │   ├─ thumbnail (from video/clip thumbnail_path)
          │   └─ post_url (local /api/v1/exports/{id}/download)
          │
          └─→ Campaign Studio Form
                ├─ Select campaign (filtered by campaign.whop_campaign_id = video.whop_campaign_id OR new)
                ├─ Edit post_url → final TikTok/Insta/YouTube/X URL
                ├─ Enter platform, views, creator handle
                └─ Submit WhopSubmission
                      │
                      └─→ Whop Review Page (/whop/review)
                            ├─ Approve / Reject
                            └─ Pay (set earnings_estimate, record snapshot)
```

Final Submission stored in whop_submissions table with:
- campaign_id (FK to whop_campaigns)
- post_url (final platform URL, NOT the export file)
- title (prefilled from clip, editable)
- views/likes (user-entered, updateable)
- status (pending → approved → paid)
"

## Reusable
- whopDashboard
- whopListCampaigns
- whopGetCampaign
- whopCreateSubmission
- whopListSubmissions
- whopApproveSubmission
- whopRejectSubmission
- whopPaySubmission
- useWhopDashboard
- useWhopCampaigns
- useWhopCampaign
- useWhopCreateSubmission
- useWhopSubmissions
- useWhopSubmissionMutation
- useWhopAnalytics
- WhopCampaign
- WhopSubmission
- WhopSubmissionCreate
- PlatformIcons
- RatePill
- BudgetBar
- CampaignForm
- _earnings_estimate
- _owned_campaign
- _owned_submission
- _campaign_out
- _submission_out
- storage.url
- whop_thumbnail_key

## Gaps
- No explicit prefill validation for post_url placeholder (export link vs real platform URL) — add UI warning or validation rule before submit
- Export storage path/S3 cleanup policy unclear — ensure whop_submissions.post_url doesn't link to temporary files that may be deleted
- No explicit mechanism to link an existing video to a campaign after creation — add a 'Assign to Campaign' button on video detail or campaign dashboard
- Clipboard/copy-to-clipboard for prefilled export URL not mentioned — UX would benefit from 'Copy playable link' button for user reference
- No bulk submission from multiple clips — Studio supports one clip → one submission; campaign dashboard can create submissions manually, but no batch workflow

## Key files
- backend/app/models/video.py
- backend/app/models/whop.py
- backend/app/models/project.py
- backend/app/api/v1/endpoints/whop.py
- backend/app/schemas/whop.py
- backend/app/models/clip.py
- backend/app/models/export.py
- backend/app/models/enums.py
- frontend/src/components/layout/Sidebar.tsx
- frontend/next.config.js