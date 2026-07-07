# OpenClip feature-slice anatomy â€” template for a "whop campaigns" module

**Recommendation: copy the Story Vault "projects" slice.** The main `projects` feature is a minimal CRUD (no edit dialog wired, no settings blob, no action endpoint). The storyvault projects slice has everything a campaigns module needs: full CRUD + a "run" action, a JSON settings recipe, server-enriched stat counts, a polled detail page, shared create/edit form, and delete-with-unfiling. Both are documented below; storyvault is the richer template.

## 1. The layer stack (identical for every slice)

```
app/(app)/storyvault/projects/page.tsx        (list page, "use client")
app/(app)/storyvault/projects/[id]/page.tsx   (detail page)
        â”‚  imports hooks
frontend/src/hooks/use-api.ts                 (TanStack Query wrappers, query keys, invalidation)
        â”‚  calls api.*
frontend/src/lib/api.ts                       (typed fetch client: bearer token, auto-refresh on 401, JSON/FormData)
frontend/src/lib/types.ts                     (TS interfaces mirroring pydantic *Out schemas)
        â”‚  fetch("/api/v1/â€¦")  â€” Next dev rewrite proxies to backend
frontend/next.config.js                       ({source:"/api/:path*", destination:"http://localhost:8000/api/:path*"}; same for /media)
        â”‚
backend/app/api/v1/router.py                  (include_router(storyvault.router, prefix="/storyvault"))
backend/app/api/v1/endpoints/storyvault.py    (route functions + `_owned_*` guards + `_*_out` enrichers)
backend/app/schemas/storyvault.py             (pydantic Create/Update/Out/Settings models)
backend/app/models/storyvault.py              (SQLAlchemy models; TimestampMixin from models/mixins.py)
backend/app/models/enums.py                   (str-Enums; DB stores .value strings)
backend/app/workers/sv_tasks.py               (Celery tasks for async work)
backend/app/services/storage.py               (relative media keys â†’ /media/<key> URLs)
```

Every endpoint takes `current_user: User = Depends(get_current_user)` and `db: AsyncSession = Depends(get_session)` and scopes queries by `owner_id == current_user.id`. Ownership check is a tiny helper that 404s (never 403s):

```python
async def _owned_project(db: AsyncSession, project_id: int, user: User) -> SvProject:
    project = await db.get(SvProject, project_id)
    if not project or project.owner_id != user.id:
        raise HTTPException(status_code=404, detail="Project not found")
    return project
```

## 2. URL patterns

All under `API_BASE = process.env.NEXT_PUBLIC_API_URL || "/api/v1"`.

Storyvault projects (in `backend/app/api/v1/endpoints/storyvault.py`, mounted at `/storyvault`):

| Method | Path | Response | Notes |
|---|---|---|---|
| GET | `/api/v1/storyvault/projects` | `list[SvProjectOut]` | ordered `updated_at.desc()` |
| POST | `/api/v1/storyvault/projects` | `SvProjectOut`, **201** | body `SvProjectCreate` |
| GET | `/api/v1/storyvault/projects/{id}` | `SvProjectOut` | |
| PATCH | `/api/v1/storyvault/projects/{id}` | `SvProjectOut` | partial `SvProjectUpdate` |
| DELETE | `/api/v1/storyvault/projects/{id}` | `Message {detail}` | unfiles children (sets project_id NULL), then deletes |
| POST | `/api/v1/storyvault/projects/{id}/run` | `SvProjectRunResult` | verb-as-subresource action pattern |

Main projects (`endpoints/projects.py`, prefix `/projects`): `GET/POST ""`, `GET/PATCH/DELETE "/{project_id}"` â€” same shape, simpler. Child resources hang off the parent: `GET /projects/{id}/videos`, `POST /projects/{id}/videos/upload`, `POST /projects/{id}/videos/youtube`; then flat by id: `GET /videos/{id}`, `DELETE /videos/{id}`.

Conventions: **PATCH not PUT** for partial edits; **POST 201** for creates; actions are `POST /{id}/<verb>` returning the updated entity or a result object; DELETE returns `Message` (`schemas/common.py: class Message(BaseModel): detail: str`).

## 3. Request/response JSON shapes

`schemas/storyvault.py` lines 398â€“476:

```python
class SvProjectSettings(BaseModel):
    """The reusable 'auto-workflow' recipe stored on a project."""
    story_source: str = "reddit"                       # reddit|manual
    communities: list[str] = Field(default_factory=list, max_length=20)
    ...
    videos_per_run: int = Field(default=3, ge=1, le=25)
    auto_publish: bool = False
    no_duplicates: bool = False

class SvProjectCreate(BaseModel):
    name: str = Field(min_length=1, max_length=255)
    description: str | None = Field(default=None, max_length=2000)
    settings: SvProjectSettings = Field(default_factory=SvProjectSettings)

class SvProjectUpdate(BaseModel):          # all-optional partial patch
    name: str | None = Field(default=None, min_length=1, max_length=255)
    description: str | None = Field(default=None, max_length=2000)
    settings: SvProjectSettings | None = None

class SvProjectOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)
    id: int
    name: str
    description: str | None = None
    settings: SvProjectSettings
    created_at: datetime
    updated_at: datetime
    # Enriched by the endpoint â€” the project's pipeline at a glance.
    stories_total: int = 0
    stories_ready: int = 0
    videos_total: int = 0
    videos_in_pipeline: int = 0
    videos_in_review: int = 0
    videos_completed: int = 0
    videos_published: int = 0

class SvProjectRunResult(BaseModel):
    stories_added: int
    videos_queued: int
    detail: str            # human sentence, shown verbatim in a toast
```

Key pattern: **`*Out` = `from_attributes=True` model + extra "enriched" fields defaulted to 0/None**, filled by a `_project_out(db, project)` helper that runs the count queries (`storyvault.py` lines 212â€“239). The mirror TS interface lives in `frontend/src/lib/types.ts` (`SvProject`, `SvProjectSettings`, `SvProjectRunResult`, lines 435â€“482). The model stores the whole recipe as a JSON column so knobs can grow without a migration (`models/storyvault.py` lines 376â€“398):

```python
class SvProject(TimestampMixin, Base):
    __tablename__ = "sv_projects"
    id: Mapped[int] = mapped_column(primary_key=True)
    owner_id: Mapped[int] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), index=True, nullable=False)
    name: Mapped[str] = mapped_column(String(255), nullable=False)
    description: Mapped[str | None] = mapped_column(Text, default=None)
    settings: Mapped[dict] = mapped_column(JSON, default=dict, nullable=False)
```

`TimestampMixin` (`models/mixins.py`) gives `created_at`/`updated_at` with **client-side Python defaults** (`default=_utcnow, onupdate=_utcnow`) plus `server_default` â€” deliberately, to avoid async-engine `MissingGreenlet` on expired columns. Children reference the parent with `ForeignKey("sv_projects.id", ondelete="SET NULL"), index=True` (see `SvStory.project_id`, `SvVideo.project_id`).

## 4. Pagination approach

**There is none â€” and that is the house style.** Every list endpoint returns a plain JSON array. `schemas/common.py` defines `Page[T]`/`PaginationParams` but nothing uses them (grep confirms zero usages). The closest thing is the stories list, which does **query-param filtering + a hard limit**, not paging (`storyvault.py` 1480â€“1510): `GET /storyvault/stories?status=&category=&q=&sort=score|newest|upvotes|longest&project_id=&limit=100 (le=500)`. The frontend builds those with `URLSearchParams` in `api.svListStories`. A campaigns list should do the same: filters + `limit`, ordered `updated_at.desc()`.

## 5. Status enums

`backend/app/models/enums.py` â€” every enum is `class X(str, Enum)`; **columns store `.value` strings** (`String(32)`, indexed), not native DB enums:

- `SvStoryStatus`: `new | saved | approved | used | excluded`
- `SvVideoStatus`: `queued | processing | ready_for_review | approved | rendering | completed | rejected | failed | cancelled`
- `JobStatus` (generic async jobs, uploads): `pending | queued | processing | completed | failed`
- `PublishStatus`, `BotStatus`, etc. for other slices.

The endpoint module groups them into working sets: `_READY_STORY_STATUSES = (NEW, SAVED, APPROVED)`, `_PIPELINE_VIDEO_STATUSES = (QUEUED, PROCESSING, RENDERING)`. PATCH validates free-string statuses against the enum: `if payload.status not in {s.value for s in SvStoryStatus}: raise HTTPException(422, ...)`. Frontend mirrors as TS union types (`SvVideoStatus` in types.ts) and maps status â†’ badge variant (see `statusVariant()` in `storyvault/command/page.tsx` lines 24â€“35, and `video.status === "failed" ? "destructive" : "secondary"` in the project detail page).

## 6. Create / edit / delete dialogs

Pattern (see `storyvault/projects/page.tsx` and `[id]/page.tsx`):

- **Create**: controlled `Dialog` (`const [open, setOpen] = useState(false)`) with `DialogTrigger asChild` around the "New project" `Button`; the shared **`ProjectForm`** component (`frontend/src/components/storyvault/project-form.tsx`) is used for both create and edit â€” it takes `initial?: SvProject | null`, `submitLabel`, `submitting`, `onSubmit(value)`. It exports `DEFAULT_SETTINGS` mirroring the backend pydantic defaults ("Mirrors backend SvProjectSettings defaults so a fresh form is already valid").
- On submit: `await createProject.mutateAsync({...}); toast.success("Project created"); setOpen(false);` wrapped in try/catch with `toast.error(err instanceof Error ? err.message : "Failed â€¦")` (sonner toasts everywhere).
- **Edit**: lives on the detail page â€” `const [editing, setEditing] = useState(false)`; same `<ProjectForm initial={project} submitLabel="Save changes" â€¦>` inside a second Dialog; submit calls `updateProject.mutateAsync({ id, data })`.
- **Delete**: a `DropdownMenu` (MoreVertical icon) with a destructive item that uses plain `confirm()` â€” no custom confirm dialog: `if (confirm(\`Delete "${p.name}"? â€¦\`)) { await deleteProject.mutateAsync(p.id); toast.success("Project deleted"); }`.
- Busy states: `mutation.isPending` disables the button and swaps in `<Loader2 className="animate-spin" />`.
- The simpler main-projects create dialog (`app/(app)/projects/page.tsx` lines 38â€“88) is a raw `<form onSubmit>` with `Input`/`Textarea` state â€” fine for 2-field creates.

## 7. Cache strategy: invalidation, not optimistic updates

**No optimistic updates anywhere.** The codebase is invalidate-on-success only:

```ts
export function useSvUpdateProject() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (vars: { id: number; data: â€¦ }) => api.svUpdateProject(vars.id, vars.data),
    onSuccess: (_d, vars) => {
      qc.invalidateQueries({ queryKey: ["sv-projects"] });        // list
      qc.invalidateQueries({ queryKey: ["sv-project", vars.id] }); // detail
    },
  });
}
```

Conventions:
- Query keys: `["sv-projects"]` list, `["sv-project", id]` detail, `["sv-stories", params]` filtered lists. Cross-entity mutations invalidate every affected key â€” `useSvRunProject` invalidates 5 keys (projects, project, stories, videos, dashboard); `useSvDeleteProject` invalidates projects + stories + videos (children were unfiled).
- Shared mutation factory when many mutations invalidate the same set: `useSvVideoMutation<TVars>(fn)` (use-api.ts lines 497â€“508).
- Freshness comes from **polling**: `refetchInterval: poll ? 5000 : false` on queries whose data moves (detail page passes `poll=true`); `staleTime` for near-static data (meta/voices 5 min, presets 30 s); `placeholderData: keepPreviousData` to avoid spinner flash (ollama status); one `qc.setQueryData` direct write (`useSvSetCloneQuant`).
- Component-level invalidation is also allowed for one-off calls: `AddVideoDialog` calls `api.uploadVideo` directly and then `qc.invalidateQueries({queryKey:["videos", projectId]})` itself.

## 8. Detail page fetch-by-id

```ts
const params = useParams();                 // next/navigation
const projectId = Number(params.id);
const { data: project, isLoading } = useSvProject(projectId, true);   // poll=5s
const { data: stories = [] } = useSvStories({ project_id: projectId });
const { data: videos = [] } = useSvVideos(undefined, true, projectId); // poll=4s
```

with `useQuery({ queryKey: ["sv-project", id], queryFn: () => api.svGetProject(id), enabled: !!id, refetchInterval: poll ? 5000 : false })`. Guard render: `if (isLoading || !project) return <centered Loader2 />`. Back-link at top (`<Link href="/storyvault/projects"><ArrowLeft/> Projects</Link>`). Sibling lists are separate queries filtered by parent id â€” the detail response does not embed children, only counts.

## 9. File upload round trip (video + thumbnail)

**Frontend** (`lib/api.ts`): build `FormData`; the `rawFetch` helper only sets `Content-Type: application/json` when the body is *not* FormData (browser sets the multipart boundary):

```ts
uploadVideo: (projectId: number, file: File, title?: string) => {
  const form = new FormData();
  form.append("file", file);
  if (title) form.append("title", title);
  return request<Video>(`/projects/${projectId}/videos/upload`, { method: "POST", body: form });
},
```

**Backend** (`endpoints/videos.py` lines 76â€“127): `file: UploadFile = File(...)`, `title: str | None = Form(None)`. Sequence: validate extension â†’ create DB row first (`status="pending", stage="uploading"`) â†’ `await db.flush()` to get the id â†’ derive storage key `video_source_key(project_id, video.id, ext)` â†’ stream chunks (`while chunk := await file.read(_CHUNK)`) to `storage.open_write(key)` enforcing `MAX_UPLOAD_SIZE_MB` (413 on overflow) â†’ `storage.commit(key)` â†’ set `storage_path`, `status="queued"`, commit â†’ `ingest_upload_task.delay(video.id)` and store `celery_task_id` â†’ return `VideoOut`. The storyvault variant (`upload_background`, storyvault.py 1569â€“1607) is the same shape and deletes the row on write failure.

**Thumbnail**: the Celery worker (`workers/tasks.py`, `_probe_and_thumbnail`) probes with ffmpeg, extracts a frame, saves under a storage key, sets `video.thumbnail_path`. The endpoint's `_to_out` enricher converts key â†’ URL: `out.thumbnail_path = storage.url(video.thumbnail_path)` which produces `/media/<key>`; FastAPI serves `/media`, and Next rewrites `/media/:path*` to the backend, so `<img src>` just works. **Storage rule: DB stores relative keys; only `*Out` enrichers emit URLs.**

**Client after upload**: toast "Upload started â€” ingestingâ€¦", invalidate `["videos", projectId]`, and the list polls (`useVideos(projectId, true)` â†’ 4 s) until `status` leaves `queued/processing`. Download links that open in a new tab pass auth as `?token=` query (`exportDownloadUrl`).

## 10. Dashboard composition

Two patterns exist:

1. **Client-side aggregation** â€” main `app/(app)/dashboard/page.tsx`: single `useProjects()` call; stats derived in the component (`projects.reduce((s,p)=>s+p.video_count,0)`); stat cards are a mapped `{label, value, icon}` array over `Card`; "Recent projects" is `projects.slice(0, 6)` in a `divide-y` list of `Link`s. No dedicated endpoint.
2. **Dedicated dashboard endpoint** (better model for campaigns) â€” `app/(app)/storyvault/command/page.tsx` + `GET /storyvault/dashboard` (`storyvault.py` 1304â€“1352). Backend returns `SvDashboardOut`: 8 scalar counts (each a `select(func.count(...))` with status filters) plus `recent_videos: list[SvVideoOut]` = last 8 by `updated_at.desc()` joined to story titles. Frontend: `useSvDashboard(true)` polls every 6 s; stat cards from a mapped array; recent list shows title + status `Badge` + `formatRelativeTime(v.updated_at)`, an inline `Progress` bar for active statuses, and the error line for failed ones.

## 11. One full round trip, end to end (create project)

**Hook** â€” `frontend/src/hooks/use-api.ts` lines 281â€“287:
```ts
export function useSvCreateProject() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (data: Parameters<typeof api.svCreateProject>[0]) => api.svCreateProject(data),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["sv-projects"] }),
  });
}
```

**API client** â€” `frontend/src/lib/api.ts` lines 369â€“370:
```ts
svCreateProject: (data: { name: string; description?: string; settings?: Partial<SvProjectSettings> }) =>
  request<SvProject>("/storyvault/projects", { method: "POST", body: JSON.stringify(data) }),
```
(`request` adds `Authorization: Bearer <token>`, retries once after `/auth/refresh` on 401, throws `ApiError(status, detail)` parsed from FastAPI's `{detail}`.)

**Page usage** â€” `storyvault/projects/page.tsx` lines 165â€“177:
```ts
await createProject.mutateAsync({ name: value.name, description: value.description || undefined, settings: value.settings });
toast.success("Project created");
setOpen(false);
```

**Router function** â€” `backend/app/api/v1/endpoints/storyvault.py` lines 1125â€“1141:
```python
@router.post("/projects", response_model=SvProjectOut, status_code=201)
async def create_project(
    payload: SvProjectCreate,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_session),
) -> SvProjectOut:
    await _validate_project_settings(db, current_user, payload.settings)  # 404 if referenced assets aren't owned
    project = SvProject(
        owner_id=current_user.id,
        name=payload.name.strip()[:255],
        description=(payload.description or None),
        settings=payload.settings.model_dump(),
    )
    db.add(project)
    await db.commit()
    await db.refresh(project)
    return await _project_out(db, project)   # model_validate + count enrichment
```

**Schemas**: `SvProjectCreate` in, `SvProjectOut` out (section 3 above). **Model**: `SvProject` (section 3). Wire JSON out looks like `{"id":1,"name":"â€¦","description":null,"settings":{â€¦24 keysâ€¦},"created_at":"â€¦","updated_at":"â€¦","stories_total":0,â€¦,"videos_published":0}`.

## 12. Checklist to clone for "whop campaigns"

1. `backend/app/models/whop.py` (or extend a module): `WhopCampaign(TimestampMixin, Base)` with `owner_id` FK CASCADE + indexed, `name String(255)`, `description Text`, `settings JSON` for the recipe, `status String(32)` if campaigns have a lifecycle; register the model in `app/models/__init__.py` and add an alembic migration.
2. `backend/app/models/enums.py`: `class WhopCampaignStatus(str, Enum)` storing `.value` strings.
3. `backend/app/schemas/whop.py`: `WhopCampaignSettings` (all defaults), `WhopCampaignCreate`, `WhopCampaignUpdate` (all-optional), `WhopCampaignOut` (`from_attributes=True` + enriched count fields defaulted), `WhopCampaignRunResult` if there's a run action; reuse `Message` from `schemas/common.py`.
4. `backend/app/api/v1/endpoints/whop.py`: `router = APIRouter()`, `_owned_campaign`, `_campaign_out` enricher, the six routes (list/create/get/patch/delete/run) exactly as in section 2; register in `api/v1/router.py` with `prefix="/whop"`.
5. `frontend/src/lib/types.ts`: `WhopCampaign`, `WhopCampaignSettings`, `WhopCampaignRunResult` interfaces.
6. `frontend/src/lib/api.ts`: `whopListCampaigns/whopGetCampaign/whopCreateCampaign/whopUpdateCampaign/whopDeleteCampaign/whopRunCampaign` methods.
7. `frontend/src/hooks/use-api.ts`: `useWhopCampaigns`, `useWhopCampaign(id, poll)`, `useCreate/Update/Delete/RunWhopCampaign` with `["whop-campaigns"]` / `["whop-campaign", id]` keys and the invalidation sets from section 7.
8. `frontend/src/components/whop/campaign-form.tsx`: shared form with exported `DEFAULT_SETTINGS` mirroring the pydantic defaults.
9. `frontend/src/app/(app)/whop/campaigns/page.tsx` + `[id]/page.tsx`: copy the storyvault projects pages; add a nav entry in `frontend/src/components/layout` (sidebar).
10. If campaigns upload assets: copy the `upload_background` endpoint shape (row-first, stream to `storage.abspath(key)`, `storage.commit`, Celery task, `storage.url` in the Out enricher) and the FormData client method.
