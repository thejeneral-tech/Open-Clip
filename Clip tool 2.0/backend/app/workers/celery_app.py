"""Celery application & queue configuration.

Redis-free by default: messages are passed through a **filesystem** broker
(plain files under ``DATA_DIR/celery``) and task results land in a SQLite file.
Nothing extra needs to be installed or running — just the worker process.
"""
from __future__ import annotations

import os

from celery import Celery

from app.core.config import settings

# The filesystem transport exchanges messages as files in these folders.
_broker_in = os.path.join(settings.celery_broker_dir, "in")
_broker_processed = os.path.join(settings.celery_broker_dir, "processed")
for _d in (_broker_in, _broker_processed):
    os.makedirs(_d, exist_ok=True)

celery_app = Celery(
    "openclip",
    broker=settings.CELERY_BROKER_URL,
    backend=settings.celery_result_backend,
    include=["app.workers.tasks", "app.workers.bot_tasks", "app.workers.sv_tasks"],
)

celery_app.conf.update(
    task_serializer="json",
    result_serializer="json",
    accept_content=["json"],
    timezone="UTC",
    enable_utc=True,
    task_track_started=True,
    task_acks_late=True,
    worker_prefetch_multiplier=1,
    result_expires=60 * 60 * 24,
    broker_connection_retry_on_startup=True,
    # Filesystem broker: poll the message folders for new tasks.
    broker_transport_options={
        "data_folder_in": _broker_in,
        "data_folder_out": _broker_in,
        "processed_folder": _broker_processed,
        "store_processed": True,
    },
    task_default_queue="default",
    task_routes={
        "app.workers.tasks.ingest_*": {"queue": "media"},
        "app.workers.tasks.process_video_task": {"queue": "ai"},
        "app.workers.tasks.regenerate_clip_task": {"queue": "ai"},
        "app.workers.tasks.render_preview_task": {"queue": "media"},
        "app.workers.tasks.export_clip_task": {"queue": "media"},
        # Story Vault: footage ingest is I/O-bound media work; the generation
        # pipeline (LLM + TTS + render) rides the ai queue.
        "app.workers.sv_tasks.sv_ingest_background_task": {"queue": "media"},
        "app.workers.sv_tasks.sv_generate_video_task": {"queue": "ai"},
        "app.workers.sv_tasks.sv_render_video_task": {"queue": "media"},
        # Autonomous bot orchestration runs on its own queue so a long cycle
        # never starves interactive clip jobs.
        "app.workers.bot_tasks.run_bot_cycle": {"queue": "bots"},
        "app.workers.bot_tasks.bot_finalize_item": {"queue": "bots"},
        "app.workers.bot_tasks.publish_clip_job": {"queue": "bots"},
        "app.workers.bot_tasks.bot_self_improve": {"queue": "bots"},
    },
)
