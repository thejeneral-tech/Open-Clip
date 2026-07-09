"""Sync a user's Whop content-rewards campaigns into the app.

Uses the connected Whop browser session (:mod:`whop_session`) to crawl an experience's
campaigns, read each brief's Google Doc, distil the requirements, and upsert them onto the
user's campaigns — updating existing ones (matched by name) and creating any new ones. Runs
as a background job (the crawl is minutes long, well past any request timeout); progress is
polled via :func:`status`.
"""
from __future__ import annotations

import re
import threading
import time

from sqlalchemy import create_engine, select
from sqlalchemy.orm import Session

from app.core.config import settings
from app.core.logging import get_logger
from app.models.whop import WhopCampaign
from app.services import whop_requirements as wr, whop_session

logger = get_logger(__name__)

_LOCK = threading.Lock()
_state: dict = {
    "running": False, "phase": "idle", "total": 0, "processed": 0,
    "updated": 0, "created": 0, "error": None, "finished_at": 0.0,
}
_thread: threading.Thread | None = None


def _norm(name: str | None) -> str:
    """Normalize a campaign name for matching (drop emoji/punctuation/case/space)."""
    return re.sub(r"[^a-z0-9]+", "", (name or "").lower())


def status() -> dict:
    with _LOCK:
        return dict(_state)


def _set(**kw) -> None:
    with _LOCK:
        _state.update(kw)


def _sync_worker(app_url: str | None, owner_id: int) -> None:
    try:
        _set(running=True, phase="discovering", total=0, processed=0, updated=0, created=0, error=None)
        # A specific experience URL, or auto-discover every content-rewards whop the user joined.
        urls = [app_url] if app_url else whop_session.discover_experiences()
        if not urls:
            _set(running=False, phase="error",
                 error="No campaigns found — is your Whop connection still valid?")
            return

        _set(phase="crawling")
        crawled: list[dict] = []
        for url in urls:
            res = whop_session.crawl_campaigns(url)
            if res:
                crawled.extend(res)
        # Dedupe by name across whops.
        campaigns, seen = [], set()
        for c in crawled:
            key = _norm(c.get("title"))
            if key and key not in seen:
                seen.add(key)
                campaigns.append(c)
        if not campaigns:
            _set(running=False, phase="error",
                 error="Connected, but no campaigns were readable (Whop may have changed).")
            return

        _set(phase="importing", total=len(campaigns))
        engine = create_engine(settings.sync_database_uri)
        updated = created = 0
        try:
            with Session(engine) as db:
                existing = db.execute(
                    select(WhopCampaign).where(WhopCampaign.owner_id == owner_id)
                ).scalars().all()
                by_name = {_norm(c.name): c for c in existing}

                for i, camp in enumerate(campaigns):
                    title = (camp.get("title") or "").strip()
                    docs = camp.get("doc_links") or []
                    if not title or not docs:
                        _set(processed=i + 1)
                        continue
                    # Read the brief doc(s) and distil the rules (public docs → no browser).
                    result = wr.extract_requirements("\n".join(docs), render=False)
                    reqs = result["requirements"]
                    links = result["links"]                      # [{label,url}]
                    if not reqs and not links:
                        _set(processed=i + 1)
                        continue

                    target = by_name.get(_norm(title))
                    if target:
                        if reqs:
                            target.requirements = reqs
                        merged = list(target.asset_links or [])
                        seen = {x.get("url") for x in merged}
                        for lk in links:
                            if lk["url"] not in seen:
                                merged.append(lk)
                                seen.add(lk["url"])
                        target.asset_links = merged
                        updated += 1
                    else:
                        camp_row = WhopCampaign(
                            owner_id=owner_id,
                            name=title[:255],
                            requirements=reqs,
                            asset_links=links,
                            source="whop_sync",
                        )
                        db.add(camp_row)
                        by_name[_norm(title)] = camp_row
                        created += 1
                    _set(processed=i + 1, updated=updated, created=created)
                db.commit()
        finally:
            engine.dispose()

        logger.info("Whop sync done: %d updated, %d created", updated, created)
        _set(running=False, phase="done", updated=updated, created=created, finished_at=time.time())
    except Exception as exc:                    # pragma: no cover - browser/db dependent
        logger.info("Whop sync failed: %s", exc)
        _set(running=False, phase="error", error=str(exc))


def start_sync(app_url: str | None, owner_id: int) -> dict:
    """Kick off a background sync for ``owner_id``. No ``app_url`` → discover all whops."""
    global _thread
    with _LOCK:
        if _state["running"]:
            return dict(_state)
        _state.update(running=True, phase="starting", error=None)
    _thread = threading.Thread(target=_sync_worker, args=(app_url, owner_id), daemon=True)
    _thread.start()
    return status()
