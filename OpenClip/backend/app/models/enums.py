"""Enumerations and a couple of small lookup tables shared by the ORM models,
the Pydantic schemas, and the services.

Every enum subclasses ``str`` so its ``.value`` is what gets persisted (all model
columns store the string value, not the enum) and the Pydantic ``*Out`` schemas
coerce the stored string straight back into the enum via ``from_attributes``.
"""
from __future__ import annotations

from enum import Enum


class UserRole(str, Enum):
    ADMIN = "admin"
    EDITOR = "editor"
    VIEWER = "viewer"


class JobStatus(str, Enum):
    """Lifecycle of any async job (video / clip / export)."""

    PENDING = "pending"
    QUEUED = "queued"
    PROCESSING = "processing"
    COMPLETED = "completed"
    FAILED = "failed"


class VideoSource(str, Enum):
    UPLOAD = "upload"
    YOUTUBE = "youtube"


class AspectRatio(str, Enum):
    VERTICAL = "9:16"
    SQUARE = "1:1"
    HORIZONTAL = "16:9"
    PORTRAIT = "4:5"


class CaptionStyle(str, Enum):
    HORMOZI = "hormozi"
    MODERN_TIKTOK = "modern_tiktok"
    MINIMAL = "minimal"
    GAMING = "gaming"
    PODCAST = "podcast"


class ExportFormat(str, Enum):
    MP4 = "mp4"
    MOV = "mov"
    WEBM = "webm"


class ExportResolution(str, Enum):
    P480 = "480p"
    P720 = "720p"
    P1080 = "1080p"
    P1440 = "1440p"
    P2160 = "2160p"


# --------------------------------------------------------------- story vault
class SvStoryStatus(str, Enum):
    """Editorial lifecycle of a discovered story."""

    NEW = "new"
    SAVED = "saved"
    APPROVED = "approved"
    USED = "used"
    EXCLUDED = "excluded"


class SvVideoStatus(str, Enum):
    """Story-video pipeline lifecycle (preview → human review → final render)."""

    QUEUED = "queued"
    PROCESSING = "processing"
    READY_FOR_REVIEW = "ready_for_review"
    APPROVED = "approved"
    RENDERING = "rendering"
    COMPLETED = "completed"
    REJECTED = "rejected"
    FAILED = "failed"
    # User stopped the job (via the studio's Stop / Clear-queue controls) before
    # it finished. Terminal — the partial render is discarded; can be deleted.
    CANCELLED = "cancelled"


# Story Vault option vocabularies (mirrored in the frontend forms).
SV_HOOK_STYLES = ["conflict", "craziest", "question", "quote", "reveal", "calm", "suspense", "funny"]
SV_NARRATION_STYLES = ["calm", "dramatic", "suspenseful", "funny", "serious", "confessional", "documentary"]
# Quick-pick durations (seconds) offered in the UI. Spans short-form clips
# through long-form 10/20/30-minute videos; the picker also accepts any custom
# value between SV_DURATION_MIN and SV_DURATION_MAX.
SV_DURATIONS = [30, 60, 90, 180, 300, 600, 900, 1200, 1800]
SV_DURATION_MIN = 15      # seconds — floor for any video
SV_DURATION_MAX = 1800    # seconds — 30-minute ceiling
SV_CATEGORIES = [
    "AITA", "Relationships", "Revenge", "Scary", "Confessions", "Workplace",
    "Family", "Money", "School", "Wholesome", "Mystery", "Other",
]
SV_BACKGROUND_CATEGORIES = [
    "minecraft-parkour", "subway-surfers", "gta-ramps", "temple-run",
    "rocket-league", "satisfying", "asmr-cooking", "nature", "driving",
    "slime", "soap-cutting", "other",
]
SV_PLATFORMS = ["tiktok", "shorts", "reels"]


# --------------------------------------------------------------- automation
class BotStatus(str, Enum):
    STOPPED = "stopped"
    ACTIVE = "active"
    PAUSED = "paused"
    RUNNING = "running"
    ERROR = "error"


class ApprovalMode(str, Enum):
    """How far a bot may act without a human in the loop."""

    MANUAL = "manual"
    SEMI_AUTO = "semi_auto"
    AUTONOMOUS = "autonomous"


class BotRunTrigger(str, Enum):
    MANUAL = "manual"
    SCHEDULE = "schedule"


class SourcePlatform(str, Enum):
    """Platforms used by both discovery sources and publishing connectors."""

    YOUTUBE = "youtube"
    RSS = "rss"
    REDDIT = "reddit"
    TIKTOK = "tiktok"
    INSTAGRAM = "instagram"
    X = "x"
    MANUAL = "manual"


class SourceListMode(str, Enum):
    ALLOW = "allow"
    DENY = "deny"


class TrendItemStatus(str, Enum):
    DISCOVERED = "discovered"
    REJECTED = "rejected"
    SCORED = "scored"
    APPROVED = "approved"
    INGESTING = "ingesting"
    PROCESSED = "processed"
    FAILED = "failed"
    PUBLISHED = "published"


class PublishStatus(str, Enum):
    PENDING = "pending"
    QUEUED = "queued"
    SCHEDULED = "scheduled"
    AWAITING_APPROVAL = "awaiting_approval"
    PUBLISHING = "publishing"
    PUBLISHED = "published"
    CANCELLED = "cancelled"
    FAILED = "failed"


class ConnectorStatus(str, Enum):
    CONNECTED = "connected"
    DISCONNECTED = "disconnected"
    ERROR = "error"


# ------------------------------------------------------------ whop campaigns
class WhopCampaignStatus(str, Enum):
    """Lifecycle of a clipping/UGC reward campaign."""

    ACTIVE = "active"
    PAUSED = "paused"
    ENDED = "ended"


class WhopCampaignType(str, Enum):
    """What kind of content the campaign pays for."""

    CLIPPING = "clipping"
    UGC = "ugc"
    FACELESS = "faceless"


class WhopSubmissionStatus(str, Enum):
    """Review lifecycle of a creator submission."""

    PENDING = "pending"
    APPROVED = "approved"
    REJECTED = "rejected"
    PAID = "paid"


# Whop campaign option vocabularies (mirrored in the frontend forms).
WHOP_CATEGORIES = [
    "personal_brand", "products", "education", "entertainment", "music", "gaming", "other",
]
WHOP_PLATFORMS = ["tiktok", "instagram", "youtube", "x"]


# Aspect ratio string -> integer (width, height) ratio. Drives output sizing in
# the export/reframe pipeline (see ``app.services.export.output_dimensions``).
ASPECT_DIMENSIONS: dict[str, tuple[int, int]] = {
    AspectRatio.VERTICAL.value: (9, 16),
    AspectRatio.SQUARE.value: (1, 1),
    AspectRatio.HORIZONTAL.value: (16, 9),
    AspectRatio.PORTRAIT.value: (4, 5),
}

# Quality target -> pixel size of the base (short) side.
RESOLUTION_HEIGHTS: dict[str, int] = {
    ExportResolution.P480.value: 480,
    ExportResolution.P720.value: 720,
    ExportResolution.P1080.value: 1080,
    ExportResolution.P1440.value: 1440,
    ExportResolution.P2160.value: 2160,
}
