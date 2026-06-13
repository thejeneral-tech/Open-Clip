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
  reframe_hq_detection: boolean;
  reframe_face_zoom: boolean;
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

export interface GpuProcess {
  pid: number;
  name: string;
  command: string;
  used_vram_bytes: number;
  suspended: boolean;
  can_control: boolean;
}

export interface OllamaStatus {
  ollama_up: boolean;
  base_url: string;
  max_concurrency: number;
  loaded_models: { name: string | null; size: number | null; size_vram: number | null }[];
  loaded_vram_bytes: number;
  gpus: GpuInfo[];
  gpu_processes: GpuProcess[];
}

export interface BotAnalytics {
  bot_id: number;
  summary: Record<string, unknown>;
  insights: Record<string, unknown>;
}

// ------------------------------------------------------------- story vault
export type SvStoryStatus = "new" | "saved" | "approved" | "used" | "excluded";
export type SvVideoStatus =
  | "queued"
  | "processing"
  | "ready_for_review"
  | "approved"
  | "rendering"
  | "completed"
  | "rejected"
  | "failed";

export interface SvStory {
  id: number;
  source: string;
  source_url: string | null;
  community: string | null;
  author: string | null;
  title: string;
  body: string;
  category: string | null;
  upvotes: number;
  num_comments: number;
  score: number;
  score_breakdown: Record<string, number> | null;
  status: SvStoryStatus;
  project_id: number | null;
  created_at: string;
}

export interface SvProjectSettings {
  story_source: string; // reddit|manual
  communities: string[];
  discovery_sort: string;
  discovery_time_window: string;
  min_upvotes: number;
  min_length: number;
  duration_target: number;
  hook_style: string;
  narration_style: string;
  drama_level: number;
  voice: string | null;
  speed: number;
  caption_style: string;
  background_category: string | null;
  background_id: number | null;
  template_id: number | null;
  script_engine: string;
  publish_connector_ids: number[];
  privacy: string;
  videos_per_run: number;
  auto_publish: boolean;
  no_duplicates: boolean;
}

export interface SvProject {
  id: number;
  name: string;
  description: string | null;
  settings: SvProjectSettings;
  created_at: string;
  updated_at: string;
  stories_total: number;
  stories_ready: number;
  videos_total: number;
  videos_in_pipeline: number;
  videos_in_review: number;
  videos_completed: number;
  videos_published: number;
}

export interface SvProjectRunResult {
  stories_added: number;
  videos_queued: number;
  detail: string;
}

export interface SvDiscoveryResult {
  fetched: number;
  added: number;
  duplicates: number;
  stories: SvStory[];
}

export interface SvScript {
  id: number;
  story_id: number;
  full_text: string;
  hook: string | null;
  duration_target: number;
  hook_style: string;
  narration_style: string;
  drama_level: number;
  word_count: number;
  generator: string | null;
  created_at: string;
}

export interface SvBackground {
  id: number;
  original_filename: string | null;
  category: string | null;
  duration_seconds: number | null;
  width: number | null;
  height: number | null;
  size_bytes: number | null;
  status: string;
  error: string | null;
  created_at: string;
  thumbnail_url: string | null;
  segment_count: number;
}

export interface SvVideoCreate {
  story_id: number;
  duration_target: number;
  hook_style: string;
  narration_style?: string;
  drama_level?: number;
  voice?: string | null;
  speed?: number;
  caption_style: string;
  background_category?: string | null;
  background_id?: number | null;
  script_engine: string;
  template_id?: number | null;
  project_id?: number | null;
}

export interface SvVideo {
  id: number;
  story_id: number;
  script_id: number | null;
  title: string | null;
  duration_target: number;
  hook_style: string;
  narration_style: string;
  drama_level: number;
  voice: string | null;
  speed: number;
  caption_style: string;
  background_category: string | null;
  background_id: number | null;
  script_engine: string;
  project_id: number | null;
  narration_duration: number | null;
  status: SvVideoStatus;
  stage: string | null;
  progress: number;
  error: string | null;
  reject_reason: string | null;
  created_at: string;
  updated_at: string;
  preview_url: string | null;
  render_url: string | null;
  script_text: string | null;
  story_title: string | null;
}

export interface SvExport {
  id: number;
  sv_video_id: number;
  platform: string;
  title: string | null;
  size_bytes: number | null;
  duration_seconds: number | null;
  width: number | null;
  height: number | null;
  created_at: string;
  media_url: string | null;
}

export interface SvVoice {
  name: string;
  culture: string | null;
  gender: string | null;
}

export interface SvVoicePreset {
  id: number;
  name: string;
  voice: string;
  speed: number;
  is_default: boolean;
  engine?: string; // "sapi" | "fish-clone"
  preview_url?: string | null; // saved audition clip, if any
  created_at: string;
}

export interface SvVoiceSample {
  media_url: string;
  duration: number;
}

export interface SvCloneStatus {
  reachable: boolean;
  url: string;
}

export interface SvCloneUpload {
  reference_id: string;
  filename: string;
}

export interface SvCloneTranscribe {
  ok: boolean;
  transcript: string;
  note: string | null;
}

export interface SvCloneGenerate {
  media_url: string;
  duration: number;
  bytes: number;
}

export interface SvCloneModels {
  quants: string[];
  quant: string;
  default_quant: string;
  model_dir: string;
  present: string[];
  reachable: boolean;
  url: string;
}

export interface SvCaptionPreview {
  style: string;
  media_url: string | null;
}

// The full render-config blob a template carries. All fields optional — the
// preview/summary read defensively and fall back to the reference defaults.
export interface SvTemplateData {
  key?: string;
  name?: string;
  canvas?: { width?: number; height?: number; fps?: number };
  safe?: { top?: number; bottom?: number; side?: number };
  gameplay?: { mode?: string; cropProfile?: string; audioVolume?: number };
  audio?: { narrationVolume?: number; gameplayVolume?: number; musicVolume?: number; sfxVolume?: number };
  branding?: { enabled?: boolean; position?: string; text?: string };
  topicCard?: {
    enabled?: boolean; minSeconds?: number; maxSeconds?: number;
    centerY?: number; width?: number; radius?: number; titleSize?: number;
    metaSize?: number; avatar?: boolean; fade?: number;
  };
  authorIntro?: {
    enabled?: boolean; minSeconds?: number; maxSeconds?: number;
    prefixReddit?: string; prefixQuora?: string;
    maxSize?: number; minSize?: number; outline?: number; fade?: number; popScale?: number;
  };
  captions?: {
    enabled?: boolean; style?: string; size?: number; outline?: number;
    marginV?: number; centerY?: number; maxWords?: number; maxChars?: number;
    highlight?: string; primary?: string; font?: string;
  };
  transition?: { type?: string; seconds?: number };
  export?: Record<string, unknown>;
}

export interface SvTemplate {
  id: number;
  name: string;
  builtin: boolean;
  is_default: boolean;
  data: SvTemplateData;
  created_at: string;
}

export interface SvPublishJob {
  id: number;
  sv_video_id: number;
  connector_id: number | null;
  platform: string;
  status: string;
  title: string | null;
  published_at: string | null;
  external_url: string | null;
  error: string | null;
  created_at: string;
  video_title: string | null;
  channel_name: string | null;
}

export interface SvDashboard {
  stories_total: number;
  stories_new: number;
  stories_approved: number;
  backgrounds_ready: number;
  segments_total: number;
  videos_in_pipeline: number;
  videos_in_review: number;
  exports_total: number;
  recent_videos: SvVideo[];
}

export interface SvMeta {
  hook_styles: string[];
  narration_styles: string[];
  durations: number[];
  categories: string[];
  background_categories: string[];
  caption_styles: string[];
  platforms: string[];
}
