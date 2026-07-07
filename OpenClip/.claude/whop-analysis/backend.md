# OpenClip Backend Architecture Map

Root: `C:/Users/Anton/OneDrive/Desktop/OpenClip/backend` â€” FastAPI + SQLAlchemy 2.0 (typed `Mapped[]` declarative) + Alembic + Celery + Pydantic v2. Python >= 3.10, ruff line-length 110, `known-first-party = ["app"]`. Default stack is fully local: SQLite DB, filesystem Celery broker, local disk media storage.

## 1. `app/` directory structure

```
backend/
  alembic.ini                     # DB URL injected at runtime by env.py; ruff post-write hook
  alembic/
    env.py                        # imports app.models, uses settings.sync_database_uri
    script.py.mako
    versions/0001_initial.py ... 0016_sv_music_presets.py
  pyproject.toml                  # ruff / pytest (asyncio_mode=auto, testpaths=app/tests) / mypy
  app/
    __init__.py                   # __version__
    main.py                       # app factory create_app(), lifespan, static /media mount
    db_init.py                    # SQLite bootstrap: create_all + additive column sync
    api/
      deps.py                     # get_session, get_current_user, RBAC deps
      v1/
        router.py                 # aggregate APIRouter, one include_router per feature
        endpoints/                # one module per feature: auth, users, projects, videos,
                                  # clips, exports, settings, models, bots, presets,
                                  # discovery, publishing, automation, storyvault, ws
    core/
      config.py                   # pydantic-settings Settings singleton `settings`
      database.py                 # Base(DeclarativeBase), async + sync engines/sessions
      security.py                 # bcrypt hashing + JWT create/decode
      events.py                   # progress snapshots (file-based) for WS relay
      logging.py, scheduler.py, net.py
    models/                       # one module per domain; ALL re-exported in models/__init__.py
      mixins.py                   # CreatedAtMixin / TimestampMixin
      enums.py                    # str-Enums + option vocabularies
      user.py, project.py, video.py, clip.py, transcript.py, analysis.py,
      export.py, settings.py, bot.py, trend.py, publishing.py, metrics.py,
      storyvault.py               # all 12 Sv* models in ONE module
    schemas/                      # Pydantic v2; one module per domain, mirrors models
      common.py                   # Message, IDResponse, TaskResponse, Page[T], PaginationParams
      storyvault.py, auth.py, user.py, ... types.py
    services/                     # plain functions/classes, sync + async mixed
      storage.py                  # Storage abstraction + ALL media key builders
      ffmpeg.py, transcription.py, captions.py, export.py, ...
      storyvault/                 # feature sub-package: composer, tts, reddit, scoring,
                                  # scripts, overlays, voice_presets, templates_data, assets/
      discovery/, publishing/     # registry-pattern sub-packages
    workers/
      celery_app.py               # Celery app, queue routing table
      tasks.py, bot_tasks.py, sv_tasks.py, progress.py
    tests/                        # pytest, colocated under app/tests
      conftest.py, test_api.py, test_*.py
```

## 2. App factory & router registration

`app/main.py` uses an **app factory** `create_app()` with a module-level `app = create_app()`:
- FastAPI(docs_url="/api/docs", openapi_url="/api/openapi.json", lifespan=lifespan)
- `app.include_router(api_router, prefix=settings.API_V1_PREFIX)` (`/api/v1`)
- Lifespan: `configure_logging()`; if SQLite â†’ `app.db_init.init_db()` in a thread; seed superuser, system presets, storyvault voice presets; start/stop the asyncio bot scheduler.
- Media mount (local backend only): `app.mount(settings.PUBLIC_MEDIA_URL, StaticFiles(directory=settings.STORAGE_ROOT), name="media")` â†’ `/media/*` serves `./data/storage`.
- `/health` and `/` defined inline.

Routers aggregate in `app/api/v1/router.py` â€” each feature is a module under `app/api/v1/endpoints/` exposing a bare `router = APIRouter()`; registration is one line:
```python
api_router.include_router(storyvault.router, prefix="/storyvault", tags=["storyvault"])
```
Note two styles: features like storyvault/bots get their prefix here; videos/clips/exports declare full paths in-module (`include_router(videos.router, tags=["videos"])` with no prefix).

**Adding a new feature module** = create `app/api/v1/endpoints/<feature>.py` with `router = APIRouter()`, then add the import + one `include_router` line in `router.py`. Nothing in `main.py` changes.

Endpoint module skeleton (convention from `storyvault.py`):
```python
logger = get_logger(__name__)
router = APIRouter()

@router.get("/things", response_model=list[ThingOut])
async def list_things(
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_session),
) -> list[ThingOut]: ...
```
Conventions: async handlers; `response_model=` always set; `status_code=201` on creates; DELETE returns `response_model=Message`; ownership checks via private helpers (`_owned_story`) that `db.get()` then 404 if `owner_id != user.id`; DB writes are explicit `await db.commit(); await db.refresh(obj)`; ORMâ†’schema enrichment via private `_x_out()` helpers that `Out.model_validate(obj)` then set computed URLs via `storage.url()`.

## 3. SQLAlchemy models

- Base: `class Base(DeclarativeBase)` in `app/core/database.py`. Two engines share it: async (`sqlite+aiosqlite` / `postgresql+asyncpg`) for FastAPI, sync (`sqlite` / `postgresql+psycopg`) for Celery + Alembic. SQLite gets WAL + foreign_keys=ON + busy_timeout pragmas via engine events. `get_db()` yields an AsyncSession (commit-on-success/rollback-on-error); `session_scope()` is the sync contextmanager for workers.
- Session deps: `app/api/deps.py: get_session` (async); `expire_on_commit=False`, `autoflush=False` everywhere.
- Timestamps: `app/models/mixins.py` â€” `CreatedAtMixin` (`created_at`) and `TimestampMixin(CreatedAtMixin)` (`+ updated_at`, `onupdate=_utcnow`). Both use client-side Python defaults **and** `server_default=func.now()` (deliberate: avoids MissingGreenlet under the async engine â€” see comment in file). Mixin goes FIRST in MRO: `class SvStory(TimestampMixin, Base)`.
- IDs: `id: Mapped[int] = mapped_column(primary_key=True)` â€” plain int autoincrement PK on every table. FKs: `owner_id: Mapped[int] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), index=True, nullable=False)`; optional refs use `ondelete="SET NULL"` + `default=None, index=True`.
- Naming: class `PascalCase`, `__tablename__` plural snake_case (`users`, `sv_stories`); feature-prefixed tables (`sv_*`) keep a module self-contained. Enum-backed columns store plain strings: `String(32), default=SvStoryStatus.NEW.value` (enums in `app/models/enums.py` all subclass `str, Enum`). JSON blobs typed `Mapped[dict | None] = mapped_column(JSON, default=None)`. Soft delete = `deleted_at: Mapped[datetime | None]`. Status columns are indexed.
- Representative model (`app/models/user.py`):
```python
class User(CreatedAtMixin, Base):
    __tablename__ = "users"
    id: Mapped[int] = mapped_column(primary_key=True)
    email: Mapped[str] = mapped_column(String(320), unique=True, index=True, nullable=False)
    ...
```
- **Registration is mandatory**: every new model must be imported + added to `__all__` in `app/models/__init__.py` â€” that import registers tables on `Base.metadata` for `db_init.create_all`, the test schema fixture, and Alembic autogen.

## 4. Alembic migrations

`alembic/env.py` injects `settings.sync_database_uri`, imports `app.models`, `target_metadata = Base.metadata`, `compare_type=True`. `alembic.ini` has a ruff-format post-write hook; `alembic/versions` is ruff-excluded.

**Critical dual-path convention**: SQLite installs NEVER run Alembic â€” `app/db_init.py:init_db()` does `Base.metadata.create_all()` plus `_sync_added_columns()` (additive `ALTER TABLE ADD COLUMN` for nullable/scalar-default drift) at startup. Alembic migrations exist **for PostgreSQL** and every recent migration docstring says so explicitly. So a new feature needs BOTH the ORM model (SQLite path) and a hand-written migration (Postgres path).

Migrations are hand-written (not autogenerated), named `NNNN_short_slug.py`, with the revision id EQUAL to the filename stem. Linear chain, no branches:

| revision | down_revision |
|---|---|
| `0001_initial` | None |
| `0002_automation` | 0001_initial |
| `0003_reframe_detection_settings` | 0002_automation |
| `0004_storyvault` | 0003_reframe_detection_settings |
| `0005_sv_voice_presets` | 0004_storyvault |
| `0006_sv_publish_jobs` | 0005_sv_voice_presets |
| `0007_sv_templates` | 0006_sv_publish_jobs |
| `0008_sv_voice_preset_builtin` | 0007_sv_templates |
| `0009_sv_video_caption_config` | 0008_sv_voice_preset_builtin |
| `0010_sv_video_template_config` | 0009_sv_video_caption_config |
| `0011_sv_video_intro_plan` | 0010_sv_video_template_config |
| `0012_clip_caption_config` | 0011_sv_video_intro_plan |
| `0013_sv_voice_clone_routing` | 0012_clip_caption_config |
| `0014_sv_video_cancel` | 0013_sv_voice_clone_routing |
| `0015_sv_music` | 0014_sv_video_cancel |
| **`0016_sv_music_presets` â€” CURRENT HEAD** | 0015_sv_music |

A new migration should be `0017_<slug>` with `down_revision = "0016_sv_music_presets"`.

Migration header template (from `alembic/versions/0016_sv_music_presets.py`):
```python
"""Story Vault music presets

Adds the ``sv_music_presets`` table â€” ... SQLite installs
get this via ``app.db_init`` (create_all); this migration is for PostgreSQL.

Revision ID: 0016_sv_music_presets
Revises: 0015_sv_music
Create Date: 2026-06-26 00:00:00
"""
from typing import Sequence, Union
import sqlalchemy as sa
from alembic import op

revision: str = "0016_sv_music_presets"
down_revision: Union[str, None] = "0015_sv_music"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None

def upgrade() -> None:
    op.create_table("sv_music_presets",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("owner_id", sa.Integer(), sa.ForeignKey("users.id", ondelete="CASCADE"), nullable=False, index=True),
        ...,
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
    )

def downgrade() -> None:
    op.drop_table("sv_music_presets")
```
Non-null added columns get `server_default` (e.g. `sa.Column("music_volume", sa.Float(), nullable=False, server_default="0.18")`); real `downgrade()` bodies are always written.

## 5. Pydantic schemas

`app/schemas/<domain>.py`, one module per feature; `schemas/__init__.py` is intentionally empty (import from the module directly). Pydantic v2 conventions:
- Naming: `XxxCreate` / `XxxUpdate` (all-optional fields) / `XxxOut` (+ purpose-named request/response models like `SvDiscoverySearch`, `SvVideoApprove`).
- `Out` schemas: `model_config = ConfigDict(from_attributes=True)`, plain typed fields matching ORM columns, plus **endpoint-enriched** computed fields defaulted to None with a `# Enriched by the endpoint:` comment (e.g. `preview_url`, `thumbnail_url`, `segment_count`) â€” the endpoint does `Out.model_validate(orm_obj)` then assigns them.
- Validation via `Field(ge=..., le=..., min_length=..., max_length=...)`; enum-ish strings stay `str` with a trailing comment of the vocabulary (`# hot|top|new|rising`).
- Shared: `app/schemas/common.py` â€” `Message`, `IDResponse`, `TaskResponse`, generic `Page[T]`, `PaginationParams`.

## 6. Auth / current-user dependency

`app/api/deps.py` + `app/core/security.py`:
- JWT (PyJWT, HS256, `settings.SECRET_KEY`); payload `{sub: str(user.id), type: "access"|"refresh", iat, exp, role}`; bcrypt via passlib.
- `oauth2_scheme = OAuth2PasswordBearer(tokenUrl="api/v1/auth/token")`.
- `get_current_user(token, db)` â†’ decodes, requires `type == "access"`, `db.get(User, id)`, checks `is_active`, else 401. Used as `current_user: User = Depends(get_current_user)` on virtually every endpoint.
- Variants: `get_current_user_flexible` (Bearer header OR `?token=` query â€” for browser download links, e.g. `/storyvault/exports/{id}/download`); `get_current_active_superuser`; `require_role(*roles)` factory (superuser always passes). WebSocket (`ws.py`) authenticates the `?token=` param itself.
- Auth endpoints in `app/api/v1/endpoints/auth.py`: register (first user = admin superuser; also creates `UserSettings` row), login, `/token` (OAuth2 form for Swagger), refresh, `/me`.

## 7. Storyvault feature â€” end-to-end wiring (the template to copy)

- **Models**: `app/models/storyvault.py` â€” 12 classes, all tables prefixed `sv_` (SvStory, SvScript, SvBackground, SvMusic, SvMusicPreset, SvSegment, SvVideo, SvVoicePreset, SvTemplate, SvPublishJob, SvExport, SvProject), re-exported from `app/models/__init__.py`.
- **Schemas**: `app/schemas/storyvault.py` (497 lines) â€” Create/Update/Out per entity + request models.
- **Router**: `app/api/v1/endpoints/storyvault.py` (2392 lines, single `router`) â€” ~65 routes under `/api/v1/storyvault/*` (meta, voices/presets/clone, templates, projects, dashboard, discovery, stories, backgrounds, music(+presets), videos lifecycle, publishing jobs, exports).
- **Registration**: one line in `app/api/v1/router.py`: `include_router(storyvault.router, prefix="/storyvault", tags=["storyvault"])`.
- **Services**: `app/services/storyvault/` sub-package (composer/render, tts + piper_tts + fish_clone, reddit discovery, scoring, scripts, overlays, music_preview, voice_presets + seed data, templates_data, bundled `assets/voice_presets/*.wav`).
- **Workers**: `app/workers/sv_tasks.py` â€” tasks declared `@celery_app.task(name="app.workers.sv_tasks.sv_generate_video_task")` taking only primitive ids, using sync `session_scope()`; routed to queues in `app/workers/celery_app.py` `task_routes` (media/ai/bots) and the module listed in the Celery `include=[...]`. Endpoints queue with `task = sv_generate_video_task.delay(video.id)` then persist `video.celery_task_id = task.id`. Progress flows via `app/workers/progress.py: ProgressTracker` + `app/core/events.publish_progress` â†’ file snapshots polled by the `/ws/{scope}/{scope_id}` websocket (`endpoints/ws.py`). Cooperative cancel via a `cancel_requested` bool column checked at pipeline checkpoints.
- **Migrations**: `0004_storyvault` created the tables; 0005â€“0011 and 0013â€“0016 are incremental sv_* additions.

## 8. Services layer

`app/services/` â€” flat modules of plain functions (no class-per-service ceremony except `Storage` and clients). Domain sub-packages (`discovery/`, `publishing/`) use a base + registry pattern. Endpoints call sync service functions via `run_in_threadpool`; workers call them directly. `app/services/storage.py` is the single media abstraction (see below). LLM access is centralized in `ollama_service.py` (concurrency-gated).

## 9. File uploads & media

- Upload pattern (see `upload_background` in `endpoints/storyvault.py:1569`): validate extension against a module-level allowlist set â†’ insert the DB row first (status `pending`) to get an id â†’ build the storage key from the id (`sv_background_key(bg.id, ext)`) â†’ stream `UploadFile` to `storage.abspath(key)` in 8 MB chunks â†’ `storage.commit(key)` â†’ set `storage_path`, flip status to `queued`, commit â†’ `task.delay(id)` for ffmpeg probing/thumbnailing/conversion in the worker. On write failure, the row is deleted and a 500 raised.
- Storage (`app/services/storage.py`): everything referenced by **relative key**; key-builder functions live at the top of the module (`projects/{pid}/videos/{vid}/source.mp4`, `.../thumbnail.jpg`, `storyvault/backgrounds/{id}/source.mp4`, `storyvault/videos/{id}/preview.mp4`, ...). `storage.abspath(key)` â†’ local working path (S3 download-on-demand); `storage.url(key)` â†’ `"/media/<key>"`; `save_bytes`/`save_file`/`open_write`+`commit`/`delete`/`exists`/`size`. Backends: `local` (default, under `STORAGE_ROOT` = `./data/storage`) or `s3` (lazy boto3, same key layout).
- Serving: local backend mounts StaticFiles at `/media` in `main.py`; the Next.js dev server proxies `/media/*` to the backend. Thumbnails are generated by workers (ffmpeg) into `*_thumb_key` paths and exposed as `thumbnail_url` on Out schemas via `storage.url()`. Downloads that need auth use `FileResponse` + `get_current_user_flexible`.

## 10. Tests

- Location: `app/tests/` (pytest `testpaths = ["app/tests"]`, `asyncio_mode = "auto"`). Flat `test_<topic>.py` naming; most are pure-unit (services), plus API tests (`test_api.py`, `test_automation_api.py`).
- `conftest.py` sets env vars (temp `SQLITE_PATH`, `DATA_DIR`, `STORAGE_ROOT`, `ENVIRONMENT=test`) **before** importing the app; session-scoped autouse `_schema` fixture does `Base.metadata.create_all(sync_engine)` / `drop_all`; `client` fixture yields an `httpx.AsyncClient(transport=ASGITransport(app=app))`; everything DB-dependent skips when no DB reachable (`DB_OK`).
- API test pattern: register a throwaway user via `/api/v1/auth/register`, pass `Authorization: Bearer <token>` headers, exercise CRUD (see `test_api.py`).

## Checklist for a new feature module (matching house style)

1. `app/models/<feature>.py` â€” models on `Base` + mixins, prefixed `__tablename__` if multi-table; register in `app/models/__init__.py` (+`__all__`).
2. `app/schemas/<feature>.py` â€” `Create`/`Update`/`Out` with `ConfigDict(from_attributes=True)` on Out + enriched-URL fields.
3. `app/api/v1/endpoints/<feature>.py` â€” `router = APIRouter()`, `Depends(get_current_user)` + `Depends(get_session)`, ownership helpers, `_x_out` enrichers.
4. Register in `app/api/v1/router.py` with prefix + tag.
5. Media keys (if any) in `app/services/storage.py`; heavy logic in `app/services/<feature>.py` or a sub-package.
6. Celery tasks (if any) in `app/workers/<feature>_tasks.py`, add to `celery_app` `include` + `task_routes`.
7. `alembic/versions/0017_<slug>.py` hand-written, `down_revision="0016_sv_music_presets"`, docstring noting SQLite gets it via `app.db_init` (only nullable/scalar-default columns are auto-added there; anything else needs care).
8. Tests in `app/tests/test_<feature>*.py` using the `client` fixture.
