// Mirror of the backend Pydantic schemas.

export type JobStatus =
  | "pending"
  | "queued"
  | "processing"
  | "completed"
  | "failed"
  | "cancelled";

export type AspectRatio = "9:16" | "1:1" | "4:5" | "16:9";
export type CaptionStyle = "hormozi" | "modern_tiktok" | "minimal" | "gaming" | "podcast";
export type ExportFormat = "mp4" | "mov";
export type ExportResolution = "720p" | "1080p" | "1440p" | "4k";
export type UserRole = "admin" | "editor" | "viewer";

export interface User {
  id: number;
  email: string;
  full_name: string | null;
  role: UserRole;
  is_active: boolean;
  is_superuser: boolean;
  created_at: string;
}

export interface Token {
  access_token: string;
  refresh_token: string;
  token_type: string;
}

export interface Project {
  id: number;
  owner_id: number;
  name: string;
  description: string | null;
  created_at: string;
  updated_at: string;
  video_count: number;
  clip_count: number;
}

export interface Video {
  id: number;
  project_id: number;
  source: "upload" | "youtube" | "local";
  source_url: string | null;
  original_filename: string | null;
  title: string | null;
  language: string | null;
  duration_seconds: number | null;
  width: number | null;
  height: number | null;
  fps: number | null;
  size_bytes: number | null;
  thumbnail_path: string | null;
  status: JobStatus;
  stage: string | null;
  progress: number;
  error: string | null;
  created_at: string;
  updated_at: string;
  clip_count: number;
}

export interface ScoreBreakdown {
  hook_strength?: number;
  emotional_intensity?: number;
  curiosity_gap?: number;
  retention_likelihood?: number;
  platform_suitability?: number;
  overall_score?: number;
  confidence?: number;
  explanation?: string;
}

export interface CaptionToken {
  word: string;
  start: number;
  end: number;
  emphasis?: boolean;
  emoji?: string | null;
}

export interface BrollSuggestion {
  start: number;
  end: number;
  search_terms: string[];
  scene_description: string;
  sd_prompt?: string;
}

export interface Clip {
  id: number;
  video_id: number;
  order_index: number;
  start_time: number;
  end_time: number;
  duration: number;
  title: string | null;
  reasoning: string | null;
  transcript_text: string | null;
  description: string | null;
  viral_score: number;
  ranking_score: number;
  confidence: number;
  score_breakdown: ScoreBreakdown;
  aspect_ratio: AspectRatio;
  caption_style: CaptionStyle;
  title_variations: string[];
  hashtags: string[];
  keywords: string[];
  broll_suggestions: BrollSuggestion[];
  captions: CaptionToken[];
  reframe_data: Record<string, unknown>;
  preview_path: string | null;
  thumbnail_path: string | null;
  status: JobStatus;
  progress: number;
  error: string | null;
  created_at: string;
  updated_at: string;
}

export interface Export {
  id: number;
  clip_id: number;
  format: ExportFormat;
  resolution: ExportResolution;
  aspect_ratio: AspectRatio;
  burn_captions: boolean;
  storage_path: string | null;
  size_bytes: number | null;
  width: number | null;
  height: number | null;
  duration_seconds: number | null;
  status: JobStatus;
  progress: number;
  error: string | null;
  created_at: string;
}

export interface TranscriptSegment {
  id: number;
  start: number;
  end: number;
  text: string;
  speaker: string | null;
  words: { word: string; start: number; end: number; probability?: number }[];
}

export interface Transcript {
  id: number;
  video_id: number;
  language: string | null;
  engine: string | null;
  model: string | null;
  full_text: string;
  word_count: number;
  num_speakers: number;
  duration_seconds: number | null;
  segments: TranscriptSegment[];
}

export interface UserSettings {
  default_model: string;
  ranking_model: string;
  vision_model: string;
  whisper_model: string;
  target_clip_count: number;
  min_clip_seconds: number;
  max_clip_seconds: number;
  default_aspect_ratio: AspectRatio;
  default_caption_style: CaptionStyle;
  default_export_format: ExportFormat;
  default_export_resolution: ExportResolution;
  preferences: Record<string, unknown>;
}

export interface OllamaModel {
  name: string;
  size: number | null;
  parameter_size: string | null;
  family: string | null;
  modified_at: string | null;
}

export interface ProcessOptions {
  target_clip_count: number;
  min_clip_seconds: number;
  max_clip_seconds: number;
  aspect_ratios: AspectRatio[];
  caption_style: CaptionStyle;
  language?: string | null;
  generate_titles: boolean;
  generate_descriptions: boolean;
  generate_broll: boolean;
  enable_reframe: boolean;
  enable_captions: boolean;
  model?: string | null;
}

export interface ProgressEvent {
  scope: string;
  scope_id: string;
  stage: string;
  progress: number;
  status: JobStatus;
  message: string | null;
  data: Record<string, unknown>;
  ts: number;
}

// ======================= Multi-bot content automation =======================

export type BotStatus = "active" | "paused" | "stopped" | "error" | "running";
export type ApprovalMode = "manual" | "semi_auto" | "autonomous";
export type SourcePlatform =
  | "youtube" | "tiktok" | "instagram" | "x" | "reddit" | "rss" | "news" | "custom";
export type SourceListMode = "allow" | "deny";

export interface Bot {
  id: number;
  owner_id: number;
  project_id: number | null;
  name: string;
  description: string | null;
  bot_type: string;
  preset_key: string;
  status: BotStatus;
  approval_mode: ApprovalMode;
  model_assignments: Record<string, string>;
  discovery_config: Record<string, unknown>;
  filter_config: Record<string, unknown>;
  scoring_config: Record<string, unknown>;
  clipping_config: Record<string, unknown>;
  publishing_config: Record<string, unknown>;
  schedule_config: Record<string, unknown>;
  stats: Record<string, number>;
  insights: Record<string, unknown>;
  last_run_at: string | null;
  next_run_at: string | null;
  last_error: string | null;
  created_at: string;
  updated_at: string;
  source_count: number;
}

export interface BotRun {
  id: number;
  bot_id: number;
  status: string;
  stage: string | null;
  trigger: string;
  progress: number;
  stats: Record<string, number>;
  events: { ts: string; message: string; [k: string]: unknown }[];
  error: string | null;
  started_at: string | null;
  finished_at: string | null;
  created_at: string;
}

export interface Preset {
  id: number | null;
  owner_id: number | null;
  key: string;
  name: string;
  description: string | null;
  version: number;
  is_system: boolean;
  based_on: string | null;
  config: Record<string, unknown>;
}

export interface TrendSource {
  id: number;
  bot_id: number | null;
  platform: SourcePlatform;
  name: string;
  identifier: string;
  list_mode: SourceListMode;
  enabled: boolean;
  config: Record<string, unknown>;
  last_polled_at: string | null;
  last_error: string | null;
  created_at: string;
}

export interface TrendItem {
  id: number;
  bot_id: number;
  source_id: number | null;
  video_id: number | null;
  platform: string;
  external_id: string;
  url: string;
  title: string | null;
  author: string | null;
  description: string | null;
  thumbnail_url: string | null;
  language: string | null;
  duration_seconds: number | null;
  published_at: string | null;
  metrics: Record<string, number>;
  score_breakdown: Record<string, unknown>;
  trend_score: number;
  status: string;
  reason: string | null;
  created_at: string;
}

export type PublishPlatform = "youtube" | "tiktok" | "instagram" | "x" | "facebook" | "manual";

export interface ChannelConfig {
  channel_id?: string;
  channel_title?: string;
  channel_thumbnail?: string | null;
  privacy?: "public" | "unlisted" | "private";
  made_for_kids?: boolean;
  [k: string]: unknown;
}

export interface Connector {
  id: number;
  owner_id: number;
  bot_id: number | null;
  platform: PublishPlatform;
  name: string;
  status: string;
  config: ChannelConfig;
  has_credentials: boolean;
  last_error: string | null;
  created_at: string;
}

export interface YouTubeStatus {
  configured: boolean;
  redirect_uri: string;
}

export interface PublishingJob {
  id: number;
  bot_id: number | null;
  clip_id: number;
  connector_id: number | null;
  platform: string;
  status: string;
  scheduled_at: string | null;
  published_at: string | null;
  title: string | null;
  description: string | null;
  payload: Record<string, unknown>;
  external_post_id: string | null;
  external_url: string | null;
  analytics: Record<string, unknown>;
  retries: number;
  error: string | null;
  created_at: string;
}

export interface GpuInfo {
  index: number;
  name: string;
  memory_total_mb: number;
  memory_used_mb: number;
  memory_free_mb: number;
  utilization_pct: number;
  temperature_c: number;
}

export interface OllamaStatus {
  ollama_up: boolean;
  base_url: string;
  max_concurrency: number;
  loaded_models: { name: string | null; size: number | null; size_vram: number | null }[];
  loaded_vram_bytes: number;
  gpus: GpuInfo[];
}

export interface BotAnalytics {
  bot_id: number;
  summary: Record<string, unknown>;
  insights: Record<string, unknown>;
}
