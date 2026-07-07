# OpenClip project survey

## 1. How `launch.py` starts the stack

`C:\Users\Anton\OneDrive\Desktop\OpenClip\launch.py` is a stdlib-only supervisor (no Docker). It manages detached processes via pid files in `data/run/` and logs in `data/logs/` (`start_service`/`stop_service`).

**Ports (constants at top of launch.py):**
- API: `8000` (`API_PORT`) â€” uvicorn binds `127.0.0.1`
- Frontend: `3000` (`WEB_PORT`) â€” Next.js dev server
- Ollama: `11434`
- Fish Speech (s2.cpp TTS server): `8080` (`FISH_PORT`, matches backend `FISH_TTS_URL`)

**Commands spawned by `python launch.py up` (`cmd_up`):**
- api: `backend/.venv/Scripts/python -m uvicorn app.main:app --host 127.0.0.1 --port 8000` (cwd=`backend`)
- worker: `backend/.venv/Scripts/python -m celery -A app.workers.celery_app worker --loglevel=info -Q default,media,ai,bots` plus `--pool=solo` on Windows (`--concurrency=$WORKER_CONCURRENCY` elsewhere); cwd=`backend`
- frontend: `npm run dev` (or `npm run start` with `--prod`, which runs `next build` first); cwd=`frontend`, env gets `BACKEND_INTERNAL_URL=http://localhost:8000`, `NEXT_PUBLIC_WS_URL` (default `ws://localhost:8000/api/v1/ws`), `PORT=3000`
- ollama: `ollama serve` if installed and not already reachable
- fish: `models/s2.cpp/build/s2(.exe) --server --host 127.0.0.1 --port 8080 --model models/s2-pro-gguf/s2-pro-q4_k_m.gguf ...` (optional, `FISH_AUTOSTART=1`)

**Env handling:** `ensure_env()` copies root `.env.example` â†’ `.env` (injecting a fresh `SECRET_KEY`). `child_env()` merges OS env + parsed root `.env` into every child process. `write_frontend_env()` writes `frontend/.env.local` with `BACKEND_INTERNAL_URL` and `NEXT_PUBLIC_WS_URL`.

**Startup sequence in `cmd_up`:** ensure .env + frontend .env.local â†’ run setup if needed â†’ **`python -m app.db_init`** (cwd=backend) â†’ ensure Ollama â†’ warn if ffmpeg missing â†’ start api/worker/frontend â†’ wait for `http://127.0.0.1:8000/health` and `http://127.0.0.1:3000` â†’ start Fish server â†’ open browser. Default login `admin@openclip.local / changeme`.

`python launch.py setup` creates `backend/.venv` (Python 3.10â€“3.12 required), `pip install -r requirements.txt`, `npm install`, runs `python -m app.db_init`, then optionally fetches/builds Fish Speech and Piper.

## 2. Registered routers (backend/app/main.py + app/api/v1/router.py)

`app.main:create_app()` includes `api_router` at prefix `settings.API_V1_PREFIX` = **`/api/v1`**. Routers in `backend/app/api/v1/router.py`:

| Router | Prefix (under /api/v1) | Tags |
|---|---|---|
| auth | `/auth` | auth |
| users | `/users` | users |
| projects | `/projects` | projects |
| videos | *(none â€” paths defined in module: `/projects/{id}/videos*`, `/videos/{id}*`)* | videos |
| clips | *(none â€” `/videos/{id}/clips`, `/clips/{id}*`)* | clips |
| exports | *(none â€” `/exports/{id}`, `/exports/{id}/download`)* | exports |
| settings | `/settings` | settings |
| models | `/models` | models |
| bots | `/bots` | bots |
| presets | `/presets` | presets |
| discovery | `/discovery` | discovery |
| publishing | `/publishing` | publishing |
| automation | `/automation` | automation |
| storyvault | `/storyvault` | storyvault |
| ws | *(none â€” websocket at `/ws/{scope}/{scope_id}`, i.e. `/api/v1/ws/video|clip|export/{id}?token=jwt`)* | ws |

Also in main.py: `/health` (plain, not under /api/v1), `/` â†’ redirect to `/api/docs` (docs at `/api/docs`, redoc `/api/redoc`, openapi `/api/openapi.json`), and a StaticFiles mount at `PUBLIC_MEDIA_URL` (`/media`) serving `STORAGE_ROOT` when `STORAGE_BACKEND=local`.

## 3. Frontend API base URL

`frontend/src/hooks/use-api.ts` contains only React Query hooks; it imports the client from `@/lib/api`. The base URL lives in `frontend/src/lib/api.ts`:

```ts
const API_BASE = process.env.NEXT_PUBLIC_API_URL || "/api/v1";
```

Relative `/api/v1` works because `frontend/next.config.js` rewrites proxy `/api/:path*` and `/media/:path*` to `BACKEND_INTERNAL_URL` (default `http://localhost:8000`) â€” set by launch.py in `frontend/.env.local`. The WebSocket bypasses the proxy and uses `NEXT_PUBLIC_WS_URL`.

## 4. .env.example

There is **no `backend/.env.example`** â€” config lives at the repo root: `C:\Users\Anton\OneDrive\Desktop\OpenClip\.env.example` (a real `.env` already exists too). Key settings (parsed by pydantic-settings in `backend/app/core/config.py`): `API_V1_PREFIX=/api/v1`, `BACKEND_CORS_ORIGINS=http://localhost:3000,http://localhost:8000`, `SECRET_KEY`, `FIRST_SUPERUSER_EMAIL/PASSWORD`, `DATA_DIR=./data`, `DB_BACKEND=sqlite`, `SQLITE_PATH=./data/openclip.db`, `CELERY_BROKER_URL=filesystem://`, `CELERY_RESULT_BACKEND=` (blank â†’ `./data/celery_results.db`), `STORAGE_BACKEND=local` / `STORAGE_ROOT=./data/storage` / `PUBLIC_MEDIA_URL=/media`, Ollama, Fish, Piper, Whisper, ffmpeg, reframe, and limit knobs. Relative paths resolve against the repo root regardless of cwd (`_resolve` in config.py).

## 5. backend/control

`backend/control/` is **runtime junk, not source**: it holds kombu filesystem-transport exchange registry files (`default.exchange`, `media.exchange`, `ai.exchange`, `bots.exchange`, `celery.pidbox.exchange`) created by the Celery filesystem broker. Kombu's default `control_folder` is the relative dir `control`, and the worker runs with cwd=`backend`, so the files land there. The actual message queue is `data/celery/in` + `data/celery/processed` (see `backend/app/workers/celery_app.py` `broker_transport_options`). You can ignore this directory (it would be a candidate for .gitignore, but the project isn't a git repo).

## 6. Database sessions / engine

`backend/app/core/database.py` builds **two engines over one DB** from `settings` in `config.py`:
- Async: `sqlite+aiosqlite:///<SQLITE_PATH>` for FastAPI (`AsyncSessionLocal`, `get_db` dependency: commit on success / rollback on exception).
- Sync: `sqlite:///<SQLITE_PATH>` for Celery + Alembic (`SyncSessionLocal`, `session_scope()` context manager).
- Backend selectable via `DB_BACKEND=sqlite|postgres` (postgres uses `postgresql+asyncpg://` / `postgresql+psycopg://` with pool sizing). Default and current config: **SQLite**.
- SQLite pragmas on every connection: `journal_mode=WAL`, `foreign_keys=ON`, `busy_timeout=10000`, `synchronous=NORMAL` (API readers + worker writer concurrency).

**DB file:** `C:\Users\Anton\OneDrive\Desktop\OpenClip\data\openclip.db` (exists, with -wal/-shm siblings). Celery results in `data\celery_results.db`.

## 7. Migrations at launch

**launch.py does NOT run `alembic upgrade`.** Both `setup` and `up` run `python -m app.db_init` (backend/app/db_init.py), and the API lifespan also calls `init_db()` when SQLite. That does `Base.metadata.create_all(sync_engine)` plus `_sync_added_columns()` (additive ALTER TABLE for new nullable/scalar-defaulted ORM columns). Alembic (`backend/alembic/`, 16 versions up to `0016_sv_music_presets.py`; URL injected from settings in `alembic/env.py`) is only intended for the Postgres path, run manually: `cd backend && alembic upgrade head`.

## 8. Tests & verification commands

**Backend (pytest):** configured in `backend/pyproject.toml` `[tool.pytest.ini_options]`: `asyncio_mode = "auto"`, `testpaths = ["app/tests"]` (~20 test files; `conftest.py` spins up an isolated temp SQLite via env vars set before importing the app â€” never touches `data/openclip.db`). Note: pytest and ruff are **not currently installed** in `backend/.venv` (requirements.txt has no test deps); install `requirements-dev.txt` (full) or the lighter `requirements-test.txt` first.

Exact commands (PowerShell, from repo root):
```powershell
# one-time: install test tooling into the venv
backend\.venv\Scripts\python.exe -m pip install -r backend\requirements-test.txt

# backend tests
cd backend; .venv\Scripts\python.exe -m pytest -q

# backend lint (matches Makefile `lint`)
cd backend; .venv\Scripts\python.exe -m ruff check app
```
(Makefile equivalents: `make test`, `make lint`, `make fmt`.)

**Frontend (frontend/package.json scripts):**
```powershell
cd frontend
npm run lint        # next lint
npm run typecheck   # tsc --noEmit
npm run test        # vitest run (jsdom, setup src/test/setup.ts, "@" -> ./src)
npm run build       # next build â€” typescript.ignoreBuildErrors=false so tsc gates the build; eslint ignored during builds
```

**Full-stack smoke:** `python launch.py up` then check `http://127.0.0.1:8000/health` and `http://localhost:3000`; `python launch.py status` / `logs [api|worker|frontend|ollama|fish]` / `down`.
