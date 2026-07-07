# OpenClip Frontend Pattern Map (`C:/Users/Anton/OneDrive/Desktop/OpenClip/frontend/src`)

Stack: **Next.js 15.1.3 (App Router) + React 19 + TypeScript + Tailwind 3.4 + shadcn/ui (new-york style, Radix primitives) + TanStack React Query v5 + sonner toasts + lucide-react icons**. All pages are `"use client"` components. Path alias `@/*` -> `src/*` (shadcn `components.json` at `frontend/components.json`).

---

## 1. Storyvault page structure (`src/app/(app)/storyvault/*`)

### Routing / shell
- Route group `(app)` wraps everything in `AppShell` via `src/app/(app)/layout.tsx` (3 lines: `<AppShell>{children}</AppShell>`).
- `src/components/layout/AppShell.tsx`: auth gate (redirects to `/login` when `useAuth()` has no user), desktop sidebar + mobile drawer, theme modal, and `<main className="relative z-10 flex-1 overflow-y-auto">{children}</main>`. **Note: `main` has no padding** â€” pages provide their own container.
- `src/components/layout/Sidebar.tsx`: two nav sections (`OpenClip` and `Story Vault`). Storyvault nav items: `/storyvault/command` (Dashboard), `/storyvault/projects`, `/storyvault/library`, `/storyvault/studio` (Video Studio), `/storyvault/voicelab`, `/storyvault/presets`, `/storyvault/publishing`. Active item styling: `style={{ background: "var(--red)" }}` + `text-[var(--accent-contrast)]`. Section collapse state persisted to localStorage key `openclip_nav_sections`; sidebar rail collapse key `openclip_sidebar_collapsed`.
- `src/app/(app)/storyvault/page.tsx` is a server redirect: `redirect("/storyvault/command")`.

Pages present: `command`, `projects`, `projects/[id]`, `library`, `studio`, `voicelab`, `presets`, `publishing`, `footage` (all `page.tsx` under `src/app/(app)/storyvault/`).

### Page container pattern (used by every storyvault page except studio)
```tsx
<div className="mx-auto max-w-6xl space-y-6">
  <div>
    <h1 className="text-2xl font-bold tracking-tight">Title</h1>
    <p className="text-muted-foreground">Subtitle sentence.</p>
  </div>
  ...sections...
</div>
```
The studio page (`studio/page.tsx` line 396) is the exception â€” full-height workspace: `<div className="flex h-full flex-col gap-3 p-4 lg:p-5">`. Widths vary elsewhere in the app (`max-w-3xl` settings, `max-w-5xl` models/discovery, `max-w-7xl` video/clip detail).

### PageHeader
`src/components/layout/PageHeader.tsx` exists â€” `PageHeader({ title, subtitle?, actions? })` rendering `h1.text-2xl.font-semibold.text-fg` + `p.text-sm.text-muted` + right-aligned actions â€” **but it is not imported anywhere** (grep finds only its own file). All storyvault pages inline the header `div > h1 + p` pattern above instead; header actions are placed via `flex items-start justify-between gap-4` (see projects page lines 141â€“181). If mirroring, follow the inline pattern, or adopt PageHeader deliberately.

### `command/page.tsx` (dashboard) â€” stat cards, quick links, recent list
- Data: `const { data: dashboard, isLoading } = useSvDashboard(true);` (poll=true â†’ 6 s refetch).
- **Loading state**: renders the same header, then a centered spinner:
```tsx
<div className="flex justify-center py-20">
  <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
</div>
```
- **Stat cards**: array of `{ label, value, muted?, icon }` mapped into `Card` inside `grid gap-4 sm:grid-cols-2 lg:grid-cols-4`:
```tsx
<Card key={s.label}>
  <CardContent className="flex items-start justify-between pt-6">
    <div>
      <p className="text-2xl font-bold">{s.value}</p>
      <p className="text-sm text-muted-foreground">{s.label}</p>
      {s.muted && <p className="text-xs text-muted-foreground">{s.muted}</p>}
    </div>
    {s.icon /* <BookOpen className="h-4 w-4 text-muted-foreground" /> */}
  </CardContent>
</Card>
```
- Quick actions: `<Button asChild variant="outline"><Link href="/storyvault/library"><Search className="h-4 w-4" /> Find stories</Link></Button>` in `flex flex-wrap gap-2`.
- Recent videos list inside a `Card`: status badge via a local `statusVariant(status)` switch mapping `completedâ†’default`, `ready_for_reviewâ†’secondary`, `failedâ†’destructive`, else `outline`; active statuses (`queued|processing|rendering`) show `<Progress value={v.progress} className="h-1.5" />` plus `{v.stage ?? "working"} Â· {Math.round(v.progress)}%`; failed shows `<p className="text-xs text-destructive">{v.error}</p>`; timestamps via `formatRelativeTime(v.updated_at)`.
- **Empty state (inline text style)**: `<p className="py-8 text-center text-muted-foreground">No videos yet â€” create one in the Studio.</p>`.

### `projects/page.tsx` â€” card grid, dialog-create, empty state
- Data: `useSvProjects()`, `useSvCreateProject()`, local `const [open, setOpen] = useState(false)` controlling a Radix `Dialog`.
- Header row with `DialogTrigger asChild` primary button (`<Plus className="h-4 w-4" /> New project`); `DialogContent className="max-h-[88vh] overflow-y-auto sm:max-w-2xl"` hosting the shared `ProjectForm` (`@/components/storyvault/project-form`) with props `initial?/submitLabel/submitting/onSubmit`; mutations wrapped in try/catch with `toast.success(...)` / `toast.error(err instanceof Error ? err.message : "...")` from `sonner`.
- **Empty state (card style)**:
```tsx
<Card>
  <CardContent className="flex flex-col items-center gap-3 py-16 text-center">
    <FolderKanban className="h-10 w-10 text-muted-foreground" />
    <p className="text-muted-foreground">No projects yet. ...</p>
    <Button onClick={() => setOpen(true)}><Plus className="h-4 w-4" /> Create your first project</Button>
  </CardContent>
</Card>
```
- Grid: `grid gap-4 md:grid-cols-2 lg:grid-cols-3` of `ProjectCard` (a `Card className="flex flex-col"` with `CardHeader pb-3` title-linked to detail page, `Badge variant="success"` "Auto" pill when `settings.auto_publish`, a `DropdownMenu` kebab (`MoreVertical` icon, `Button variant="ghost" size="icon" className="h-7 w-7"`) whose destructive `DropdownMenuItem className="text-destructive"` uses browser `confirm()` before `deleteProject.mutateAsync`).
- `FlowBar` mini-stat strip: five stages (`Ready/Building/Review/Done/Published`) each a `rounded-md bg-muted/60 px-2 py-1.5 text-center` tile with arrow `â†’` separators.
- Button pending pattern: `disabled={runProject.isPending}` + `{runProject.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Play className="h-4 w-4" />} Run`.

### `projects/[id]/page.tsx` â€” detail page
- `useParams()` â†’ `Number(params.id)`; data via `useSvProject(projectId, true)` (5 s poll), `useSvStories({ project_id: projectId })`, `useSvVideos(undefined, true, projectId)`, mutations `useSvRunProject()`, `useSvUpdateProject()`.
- Back-link pattern: `<Link href="/storyvault/projects" className="mb-2 inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground"><ArrowLeft className="h-4 w-4" /> Projects</Link>`.
- Header actions: `Button variant="outline"` (Edit recipe â†’ opens controlled Dialog with `ProjectForm initial={project}`) + primary Run button with the same isPending Loader2 swap.
- `FlowOverview` stat tiles: `grid grid-cols-2 gap-3 sm:grid-cols-5`, each `rounded-lg border bg-card p-4 text-center` with `text-2xl font-bold` value and `text-xs text-muted-foreground` label.
- "Recipe" summary Card: `CardHeader className="flex-row items-center justify-between space-y-0"` with `CardTitle className="text-base"`+`CardDescription`, content is a wrap of `Badge variant="outline"` facts (`Source: reddit`, `Voice: auto`, etc.).
- Two-column body `grid gap-6 lg:grid-cols-2` of Stories/Videos Cards; row items are plain bordered divs (`rounded-md border p-3`) â€” `StoryRow` (title + score + `Badge variant="secondary"`) and `VideoRow` (title, status badge, conditional `Progress value={video.progress * 100}` â€” note the *100 here vs raw percent on command page).
- Section empty states: `<p className="py-6 text-center text-sm text-muted-foreground">No stories yet. ...</p>`.
- Page loading: bare centered `Loader2` spinner (no header) `if (isLoading || !project)`.

### Other page patterns
- `library/page.tsx` and `publishing/page.tsx` use `Tabs` with icon triggers: `<TabsTrigger value="stories"><BookOpen className="mr-1 h-4 w-4" /> Stories</TabsTrigger>` and `TabsContent className="pt-4"`.
- `publishing/page.tsx` (line 551+) handles OAuth redirect query params in a `useEffect` then `window.history.replaceState` to clean the URL, with sonner toasts.

---

## 2. `src/hooks/use-api.ts` â€” API hook conventions

### Fetcher / client (`src/lib/api.ts`)
- **Base URL**: `const API_BASE = process.env.NEXT_PUBLIC_API_URL || "/api/v1";` (line 53). In dev, `frontend/next.config.js` rewrites `/api/:path*` and `/media/:path*` to `process.env.BACKEND_INTERNAL_URL || "http://localhost:8000"` so the browser stays same-origin.
- **Auth**: bearer tokens in localStorage via `tokenStore` (keys `openclip_access`, `openclip_refresh`, `openclip_email`). `rawFetch` sets `Authorization: Bearer ${tokenStore.access}` and auto `Content-Type: application/json` unless body is `FormData`. `request<T>()` retries once after a transparent `/auth/refresh` on 401, throws `ApiError(status, detail)` (message extracted from JSON `detail`), returns `undefined` for 204/empty bodies. Login uses OAuth2 form endpoint `/auth/token`.
- WebSockets: `wsUrl(scope, id)` â†’ `NEXT_PUBLIC_WS_URL` or `ws(s)://host/api/v1/ws/<scope>/<id>?token=...`.
- All endpoints live on a single exported `api` object; storyvault methods are `sv`-prefixed (`api.svListProjects`, `api.svCreateVideo`, ...) hitting `/storyvault/...` paths (lines 362â€“524). File uploads use `FormData` (`svUploadBackground`, `svUploadMusic`, `svCloneUpload`). Download URL builder embeds token as query param: `svExportDownloadUrl(id)`.

### React-query conventions (`src/app/providers.tsx`)
- One `QueryClient` with `defaultOptions: { queries: { staleTime: 15_000, retry: 1, refetchOnWindowFocus: false } }`.
- Query hooks: `useQuery({ queryKey: [...], queryFn: api.x, enabled: !!id, refetchInterval: poll ? N : false, staleTime? })`. Poll intervals are per-resource: dashboard 6 s, project 5 s, videos/backgrounds/music 4 s, caption previews 3 s, clone models 8 s. Meta/voices use `staleTime: 5 * 60_000`. `keepPreviousData` used only by `useOllamaStatus` (placeholderData) to avoid spinner flash.
- Mutation hooks: `useMutation({ mutationFn, onSuccess: () => qc.invalidateQueries({ queryKey: [...] }) })`; component code calls `mutateAsync` in try/catch + sonner toast; buttons bind `disabled={m.isPending}`.
- Query keys are kebab `sv-*` strings, params appended: `["sv-stories", params]`, `["sv-project", id]`, `["sv-videos", status ?? "all", projectId ?? "all"]`.
- Shared invalidation factory (lines 497â€“508): `useSvVideoMutation<TVars>(fn)` invalidates `sv-videos`, `sv-video`, `sv-dashboard`, `sv-exports` after any video lifecycle mutation.
- Arg-less mutation trick: `useSvVideoMutation((_: void) => api.svClearVideoQueue())` pins TVars to void.

### ALL exported storyvault hooks (use-api.ts lines 242â€“733)
Meta/dashboard: `useSvMeta`, `useSvVoices`, `useSvDashboard(poll)`.
Stories: `useSvStories(params {status,category,q,sort,project_id})`, `useSvDiscoverySearch`, `useSvImportStory`, `useSvUpdateStory`, `useSvDeleteStory`.
Projects: `useSvProjects`, `useSvProject(id, poll)`, `useSvCreateProject`, `useSvUpdateProject` (invalidates `sv-projects` + `sv-project` id), `useSvDeleteProject` (invalidates `sv-projects`, `sv-stories`, `sv-videos`), `useSvRunProject` (invalidates projects/project/stories/videos/dashboard).
Backgrounds: `useSvBackgrounds(poll)`, `useSvUploadBackground`, `useSvImportBackground`, `useSvUpdateBackground`, `useSvDeleteBackground`.
Music: `useSvMusic(poll)`, `useSvUploadMusic`, `useSvImportMusic`, `useSvRenameMusic`, `useSvDeleteMusic`, `useSvMusicPreview` (no invalidation), `useSvMusicPresets`, `useSvCreateMusicPreset`, `useSvUpdateMusicPreset`, `useSvDeleteMusicPreset`.
Videos: `useSvVideos(status?, poll, projectId?)`, `useSvVideo(id, poll)`, `useSvCreateVideo`, `useSvApproveVideo`, `useSvRejectVideo`, `useSvRetryVideo`, `useSvCancelVideo`, `useSvClearVideoQueue`, `useSvDeleteVideo` (all via `useSvVideoMutation`).
Voices: `useSvVoicePresets`, `useSvCreateVoicePreset`, `useSvSetDefaultVoicePreset`, `useSvDeleteVoicePreset`, `useSvVoiceSample` (mutation, no invalidation).
Voice clone: `useSvCloneStatus(poll)`, `useSvCloneUpload`, `useSvCloneTranscribe`, `useSvCloneGenerate`, `useSvCloneModels(poll)`, `useSvSetCloneQuant` (uses `qc.setQueryData(["sv-clone-models"], data)` instead of invalidation).
Captions/templates: `useSvCaptionPreviews(poll)`, `useSvGenerateCaptionPreviews`, `useSvTemplates`, `useSvCreateTemplate`, `useSvUpdateTemplate`, `useSvSetDefaultTemplate`, `useSvDuplicateTemplate`, `useSvDeleteTemplate`.
Publishing/exports: `useSvPublishJobs(poll)`, `useSvPublishVideo` (invalidates `sv-publish-jobs` + `sv-videos`), `useSvRetryPublishJob`, `useSvDeletePublishJob`, `useSvExports(poll)`, `useSvDeleteExport`.
Cross-module hook used by storyvault forms: `useConnectors` (`["connectors"]`).
Types come from `src/lib/types.ts` (Sv* interfaces at lines 405â€“740: `SvStory`, `SvProject`, `SvProjectSettings`, `SvVideo`, `SvVideoStatus`, `SvDashboard`, `SvTemplate`, `SvPublishJob`, `SvExport`, etc.).

---

## 3. `src/components/ui/*` primitives (complete inventory)

All follow shadcn conventions: `React.forwardRef`, `cn()` (clsx + tailwind-merge from `src/lib/utils.ts`), className passthrough, CVA for variants.

| File | Exports | Notes / props |
|---|---|---|
| `button.tsx` | `Button`, `buttonVariants` | CVA variants: `default`, `destructive`, `outline`, `secondary`, `ghost`, `link`; sizes `default (h-9 px-4)`, `sm (h-8 text-xs)`, `lg (h-11)`, `icon (h-9 w-9)`; `asChild` via Radix `Slot`; auto icon sizing `[&_svg]:size-4` |
| `badge.tsx` | `Badge`, `badgeVariants` | variants: `default`, `secondary`, `destructive`, `outline`, **`success`** (`bg-emerald-500/15 text-emerald-500`), **`warning`** (`bg-amber-500/15 text-amber-500`) â€” success/warning are custom additions |
| `card.tsx` | `Card`, `CardHeader`, `CardFooter`, `CardTitle`, `CardDescription`, `CardContent` | Card = `rounded-xl border bg-card shadow-sm`; header `p-6`, content `p-6 pt-0` |
| `dialog.tsx` | `Dialog`, `DialogPortal`, `DialogOverlay`, `DialogTrigger`, `DialogClose`, `DialogContent`, `DialogHeader`, `DialogFooter`, `DialogTitle`, `DialogDescription` | Radix; overlay `bg-black/70 backdrop-blur-sm`; content centered fixed, `max-w-lg` default, built-in X close |
| `dropdown-menu.tsx` | `DropdownMenu`, `DropdownMenuTrigger`, `DropdownMenuContent`, `DropdownMenuItem` (has `inset?`), `DropdownMenuLabel`, `DropdownMenuGroup`, `DropdownMenuSeparator` | Radix; no checkbox/radio items defined |
| `input.tsx` | `Input` | plain `<input>`, `h-9 border-input bg-transparent`, ring-1 focus |
| `textarea.tsx` | `Textarea` | `min-h-[80px]`, same styling |
| `label.tsx` | `Label` | Radix label, `text-sm font-medium` |
| `select.tsx` | `Select`, `SelectGroup`, `SelectLabel`, `SelectValue`, `SelectTrigger`, `SelectContent`, `SelectItem` | Radix; popper position default; check indicator |
| `switch.tsx` | `Switch` | Radix, `data-[state=checked]:bg-primary` |
| `slider.tsx` | `Slider` | Radix; renders a thumb per value (multi-thumb capable) |
| `tabs.tsx` | `Tabs`, `TabsList`, `TabsTrigger`, `TabsContent` | list `bg-secondary rounded-lg p-1`, active trigger `bg-background shadow` |
| `progress.tsx` | `Progress` | Radix; `value` is 0â€“100 percent (`translateX(-${100 - value}%)`) |
| `separator.tsx` | `Separator` | Radix, `orientation` prop |
| `avatar.tsx` | `Avatar`, `AvatarImage`, `AvatarFallback` | fallback `bg-primary/20` |
| `Modal.tsx` | `Modal` | **non-Radix legacy modal** (props `open,onClose,title,children,className,footer`), uses `oc-modal-overlay`/`oc-surface` classes, Escape+backdrop close; used by ThemeModal. Prefer Radix `Dialog` for new work â€” all storyvault dialogs use it |

Helper components outside ui/: `StatusBadge` (`src/components/status-badge.tsx`, maps `JobStatus` â†’ Badge variant + icon, spinning Loader2 for processing), `ScoreRing` (`src/components/score-ring.tsx`, hand-rolled SVG donut, 0â€“100, hardcoded hex color thresholds).

---

## 4. Design system / theming

Two layers coexist and are intentionally bridged:

### A. Odysseus-style CSS variable engine (`src/app/globals.css` + `src/lib/theme/themes.ts` + `src/components/theme/ThemeProvider.tsx`)
Core runtime-swapped vars declared in `:root` (globals.css lines 47â€“81): `--bg`, `--fg`, `--panel`, `--border`, `--red` (the accent â€” despite the name it's green in the default theme), plus derived `--accent-contrast`, `--muted-fg` and `--hover-bg` (color-mix of fg/bg), and per-zone vars: `--user-bubble-bg`, `--ai-bubble-bg`, `--bubble-border`, `--sidebar-bg`, `--brand-color` (= `--red`), `--hamburger-color`, `--input-bg`, `--input-border`, `--send-btn-bg`, `--send-btn-hover`, `--code-bg`, `--code-fg`, `--toggle-active`, `--bg-effect-intensity`, `--bg-effect-size`, `--bg-effect-color` (deliberately unset), `--font-family` (Fira Code default; self-hosted Fira Code + Inter woff2), `--radius: 0.625rem`.
- 16 palettes in `THEMES` (`src/lib/theme/themes.ts`): open-code-default, light, midnight, paper, cyberpunk, retrowave, forest, ocean, ume, copper, terminal, organs, lavender, gpt, claude, cute. Persistence key `openclip-theme`; custom themes key `openclip-custom-themes`.
- No-flash bootstrap script inlined in `src/app/layout.tsx` (applies saved vars to `<html>` pre-paint, adds `bg-pattern-*` + `theme-frosted` body classes on DOMContentLoaded).
- Density classes on `<html>`: `density-compact` (13px) / `density-spacious` (16px); base body font-size 14px.
- Static background pattern classes: `body.bg-pattern-dots`, `body.bg-pattern-synapse` (canvas-animated ones â€” rain, constellations, perlin-flow, petals, sparkles, embers â€” live in `src/components/theme/BackgroundEffects.tsx`).
- **`@layer components` utility classes** (globals.css lines 168â€“239): `.oc-surface` (panel bg + border; frosted-glass target), `.oc-card`, `.oc-input`, `.oc-btn`, `.oc-btn-primary`, `.oc-btn-ghost`, `.theme-swatch` (+`.active`, `.theme-swatch-colors`). Misc helpers: `.oc-modal-overlay`, `input[type=range].oc-range`, `input[type=color].oc-color`. Frosted theme rule targets `.oc-surface/.oc-card/.oc-modal/.oc-dropdown` with translucent color-mix + `backdrop-filter: blur(22px) saturate(170%)`.
- Where each system is used: `oc-*` classes appear in AppShell/Sidebar/Modal/theme UI; **storyvault pages exclusively use the shadcn tokens below**.

### B. shadcn token aliases (`frontend/tailwind.config.ts`)
Every shadcn semantic color maps onto the runtime vars so both systems re-theme together: `bg`â†’`var(--bg)`, `fg`, `panel`, `sidebar`, `brand`â†’`var(--brand-color)`, `border`â†’`var(--border)`, `input`â†’`var(--input-border)`, `ring`â†’`var(--red)`, `background`/`foreground`, `primary` = `var(--red)` (fg `--accent-contrast`), `secondary`/`accent` = `var(--hover-bg)`, `destructive` = `var(--red)` (same as primary!), `muted.DEFAULT`/`muted.foreground` = `var(--muted-fg)`, `popover`/`card` = `var(--panel)`. `fontFamily.theme/mono` = `var(--font-family)`; `borderRadius.lg/md/sm` from `--radius`; keyframes/animations `accordion-down/up`, `fade-in`, `pop-in`; plugin `tailwindcss-animate`; `darkMode: ["class"]`.
Token classes actually used by storyvault pages: `text-muted-foreground`, `text-destructive`, `text-primary`, `bg-card`, `bg-muted/60`, `border`, `hover:text-foreground`, `bg-primary/10`, `border-primary/40`, plus badge's hardcoded `emerald-500`/`amber-500` and utils.ts `scoreColor` thresholds (emerald/amber/orange/rose).

### `src/lib/utils.ts` exports
`cn`, `formatDuration` (clock), `formatDurationLabel` ("12m 50s"), `WORDS_PER_SECOND = 2.45`, `countWords`, `estimateNarrationSeconds`, `formatBytes`, `formatRelativeTime` ("5m ago"), `categoryLabel` (slug â†’ label, acronym-aware), `scoreColor`.

---

## 5. Dialog/modal pattern

Canonical pattern = Radix `Dialog` from `components/ui/dialog.tsx`, two flavors:
1. **Self-contained trigger dialog** (`src/components/add-video-dialog.tsx`): component owns `open` state, `DialogTrigger asChild` wraps a `Button`, `DialogContent > DialogHeader(DialogTitle+DialogDescription)`, body uses `Tabs` + `Label`/`Input` field stacks (`space-y-2` per field, `space-y-4` per section), busy flag disables buttons and shows `Loader2 animate-spin`, success invalidates query keys via `useQueryClient()` directly then closes + resets.
2. **Options dialog with controlled open** (`src/components/process-dialog.tsx`): `ProcessDialog({ videoId, open, onOpenChange })`; `DialogContent className="max-h-[90vh] overflow-y-auto"`; local state object `opts` (`Partial<ProcessOptions>`) mutated field-by-field; controls: `Slider` with label showing live value, toggle-chip buttons for aspect ratios (`border-primary bg-primary/10 text-primary` when active), `Select` for presets/model, custom `ColorRow` (swatch buttons + native color input), `Switch` rows inside `rounded-lg border p-4`; `DialogFooter` with single primary submit that `mutateAsync`s, toasts, closes. It also demonstrates the "seed from default preset until user touches" effect pattern.
Storyvault-specific: projects pages embed the shared `ProjectForm` (`src/components/storyvault/project-form.tsx`, props `{ initial?, submitLabel, submitting, onSubmit }`, exports `DEFAULT_SETTINGS: SvProjectSettings`) inside `DialogContent className="max-h-[88vh] overflow-y-auto sm:max-w-2xl"`.
Legacy alternative: custom `Modal` in `components/ui/Modal.tsx` (oc-* styled) â€” only used by the theme UI.
Destructive confirms use plain `window.confirm()` (no AlertDialog component exists).

## 6. Onboarding / tour

**None exists.** Grep for onboard/tour/walkthrough/joyride/driver across `src` returns nothing; no such package in package.json. The closest affordances are empty-state cards with CTA buttons (projects page) and the AppShell "Loadingâ€¦" pulse gate.

## 7. Charts

**No chart library is installed.** `frontend/package.json` has no recharts/d3/visx/nivo/chart.js â€” the only visual "charts" are hand-rolled: `ScoreRing` (SVG stroke-dasharray donut), Radix `Progress` bars, and the `FlowBar`/`FlowOverview` stat tiles. Exact dependencies (package.json): `@radix-ui/react-avatar ^1.1.2`, `react-dialog ^1.1.4`, `react-dropdown-menu ^2.1.4`, `react-label ^2.1.1`, `react-progress ^1.1.1`, `react-select ^2.1.4`, `react-separator ^1.1.1`, `react-slider ^1.2.2`, `react-slot ^1.1.1`, `react-switch ^1.1.2`, `react-tabs ^1.1.2`, `react-toast ^1.2.4` (unused â€” sonner is the toast system), `react-tooltip ^1.1.6` (no ui/tooltip.tsx wrapper exists), `@tanstack/react-query ^5.62.8`, `class-variance-authority ^0.7.1`, `clsx ^2.1.1`, `lucide-react ^0.469.0`, `next 15.1.3`, `next-themes ^0.4.4` (installed but theming is custom), `react/react-dom ^19.0.0`, `sonner ^1.7.1`, `tailwind-merge ^2.6.0`, `tailwindcss-animate ^1.0.7`, `zod ^3.24.1`, `zustand ^5.0.2` (not seen in storyvault code). Dev: `tailwindcss ^3.4.17`, `typescript ^5.7.2`, `vitest ^2.1.8`, `@testing-library/react ^16.1.0`, `jsdom ^25.0.1`.

---

## Recipe for a new module mirroring storyvault
1. Add nav items to `SECTIONS` in `src/components/layout/Sidebar.tsx` (new section id/label + lucide icons).
2. Add types to `src/lib/types.ts`, prefixed like `Sv*`.
3. Add prefixed methods to the `api` object in `src/lib/api.ts` using `request<T>(path, init)`.
4. Add hooks to `src/hooks/use-api.ts`: queries with kebab `prefix-*` keys, `poll` boolean param â†’ `refetchInterval`, mutations invalidating list+detail+dashboard keys; consider a shared `useXxxMutation` factory like `useSvVideoMutation`.
5. Pages under `src/app/(app)/<module>/...` as `"use client"` with `mx-auto max-w-6xl space-y-6` container, inline h1/p header, `Loader2` centered spinner loading state, Card empty state with icon+CTA, sonner toasts on mutateAsync, Radix Dialog + shared form component for create/edit, `index page.tsx` redirect if you want a default tab.
