// Typed API client with bearer-token auth and transparent token refresh.
import type {
  Bot,
  BotAnalytics,
  BotRun,
  Clip,
  Connector,
  Export,
  ExportFormat,
  ExportResolution,
  OllamaModel,
  OllamaStatus,
  Preset,
  ProcessOptions,
  Project,
  PublishingJob,
  SvBackground,
  SvCaptionPreview,
  SvDashboard,
  SvDiscoveryResult,
  SvExport,
  SvMeta,
  SvMusic,
  SvMusicPreset,
  SvMusicPreview,
  SvProject,
  SvProjectRunResult,
  SvProjectSettings,
  SvPublishJob,
  SvScript,
  SvStory,
  SvTemplate,
  SvCloneGenerate,
  SvCloneModels,
  SvCloneStatus,
  SvCloneTranscribe,
  SvCloneUpload,
  SvVideo,
  SvVideoCreate,
  SvVoice,
  SvVoicePreset,
  SvVoiceSample,
  Token,
  Transcript,
  TrendItem,
  TrendSource,
  User,
  UserSettings,
  Video,
  YouTubeStatus,
} from "./types";

const API_BASE = process.env.NEXT_PUBLIC_API_URL || "/api/v1";

const ACCESS_KEY = "openclip_access";
const REFRESH_KEY = "openclip_refresh";
const EMAIL_KEY = "openclip_email";

export const tokenStore = {
  get access() {
    return typeof window === "undefined" ? null : localStorage.getItem(ACCESS_KEY);
  },
  get refresh() {
    return typeof window === "undefined" ? null : localStorage.getItem(REFRESH_KEY);
  },
  // Remembered login email — used as a fallback identity when /auth/me is
  // unavailable (the seeded `.local` admin makes that endpoint 500).
  get email() {
    return typeof window === "undefined" ? null : localStorage.getItem(EMAIL_KEY);
  },
  setEmail(email: string) {
    localStorage.setItem(EMAIL_KEY, email);
  },
  set(tokens: Token) {
    localStorage.setItem(ACCESS_KEY, tokens.access_token);
    localStorage.setItem(REFRESH_KEY, tokens.refresh_token);
  },
  clear() {
    localStorage.removeItem(ACCESS_KEY);
    localStorage.removeItem(REFRESH_KEY);
    localStorage.removeItem(EMAIL_KEY);
  },
};

export class ApiError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

async function rawFetch(path: string, init: RequestInit, auth = true): Promise<Response> {
  const headers = new Headers(init.headers);
  if (!(init.body instanceof FormData) && init.body) {
    headers.set("Content-Type", "application/json");
  }
  if (auth && tokenStore.access) {
    headers.set("Authorization", `Bearer ${tokenStore.access}`);
  }
  return fetch(`${API_BASE}${path}`, { ...init, headers });
}

async function tryRefresh(): Promise<boolean> {
  const refresh = tokenStore.refresh;
  if (!refresh) return false;
  const res = await rawFetch(
    "/auth/refresh",
    { method: "POST", body: JSON.stringify({ refresh_token: refresh }) },
    false,
  );
  if (!res.ok) return false;
  tokenStore.set((await res.json()) as Token);
  return true;
}

async function request<T>(path: string, init: RequestInit = {}, auth = true): Promise<T> {
  let res = await rawFetch(path, init, auth);
  if (res.status === 401 && auth && (await tryRefresh())) {
    res = await rawFetch(path, init, auth);
  }
  if (!res.ok) {
    let detail = res.statusText;
    try {
      const body = await res.json();
      detail = body.detail ?? JSON.stringify(body);
    } catch {
      /* non-JSON error */
    }
    if (res.status === 401 && typeof window !== "undefined") {
      tokenStore.clear();
    }
    throw new ApiError(res.status, typeof detail === "string" ? detail : "Request failed");
  }
  if (res.status === 204) return undefined as T;
  const text = await res.text();
  return text ? (JSON.parse(text) as T) : (undefined as T);
}

export interface PullEvent {
  status?: string;
  error?: string;
  digest?: string;
  total?: number;
  completed?: number;
}

export function wsUrl(scope: string, id: number): string {
  const token = tokenStore.access ?? "";
  let base = process.env.NEXT_PUBLIC_WS_URL;
  if (!base && typeof window !== "undefined") {
    const proto = window.location.protocol === "https:" ? "wss" : "ws";
    base = `${proto}://${window.location.host}/api/v1/ws`;
  }
  return `${base}/${scope}/${id}?token=${encodeURIComponent(token)}`;
}

export const api = {
  // ---- auth ----
  // Use the OAuth2 form endpoint rather than /auth/login: the JSON endpoint
  // validates `email` as a strict EmailStr, which rejects reserved TLDs like the
  // seeded `admin@openclip.local`. The form endpoint takes a plain `username`.
  login: async (email: string, password: string): Promise<Token> => {
    const form = new URLSearchParams({ username: email, password });
    const res = await fetch(`${API_BASE}/auth/token`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: form.toString(),
    });
    if (!res.ok) {
      let detail = "Login failed";
      try {
        detail = (await res.json()).detail ?? detail;
      } catch {
        /* non-JSON error body */
      }
      throw new ApiError(res.status, typeof detail === "string" ? detail : "Login failed");
    }
    return (await res.json()) as Token;
  },
  register: (email: string, password: string, full_name?: string) =>
    request<Token>("/auth/register", { method: "POST", body: JSON.stringify({ email, password, full_name }) }, false),
  me: () => request<User>("/auth/me"),

  // ---- projects ----
  listProjects: () => request<Project[]>("/projects"),
  getProject: (id: number) => request<Project>(`/projects/${id}`),
  createProject: (name: string, description?: string) =>
    request<Project>("/projects", { method: "POST", body: JSON.stringify({ name, description }) }),
  updateProject: (id: number, data: Partial<Pick<Project, "name" | "description">>) =>
    request<Project>(`/projects/${id}`, { method: "PATCH", body: JSON.stringify(data) }),
  deleteProject: (id: number) => request<void>(`/projects/${id}`, { method: "DELETE" }),

  // ---- videos ----
  listVideos: (projectId: number) => request<Video[]>(`/projects/${projectId}/videos`),
  getVideo: (id: number) => request<Video>(`/videos/${id}`),
  videoStatus: (id: number) => request<Video & { live: unknown }>(`/videos/${id}/status`),
  uploadVideo: (projectId: number, file: File, title?: string) => {
    const form = new FormData();
    form.append("file", file);
    if (title) form.append("title", title);
    return request<Video>(`/projects/${projectId}/videos/upload`, { method: "POST", body: form });
  },
  importYouTube: (projectId: number, url: string, title?: string) =>
    request<Video>(`/projects/${projectId}/videos/youtube`, {
      method: "POST",
      body: JSON.stringify({ url, title }),
    }),
  processVideo: (id: number, options: Partial<ProcessOptions>) =>
    request<{ task_id: string }>(`/videos/${id}/process`, { method: "POST", body: JSON.stringify(options) }),
  getTranscript: (id: number) => request<Transcript>(`/videos/${id}/transcript`),
  deleteVideo: (id: number) => request<void>(`/videos/${id}`, { method: "DELETE" }),

  // ---- clips ----
  listClips: (videoId: number, sort: "score" | "time" = "score") =>
    request<Clip[]>(`/videos/${videoId}/clips?sort=${sort}`),
  getClip: (id: number) => request<Clip>(`/clips/${id}`),
  updateClip: (id: number, data: Partial<Clip>) =>
    request<Clip>(`/clips/${id}`, { method: "PATCH", body: JSON.stringify(data) }),
  renderClip: (id: number) => request<{ task_id: string }>(`/clips/${id}/render`, { method: "POST" }),
  regenerateClip: (id: number, opts: Record<string, boolean>) =>
    request<{ task_id: string }>(`/clips/${id}/regenerate`, { method: "POST", body: JSON.stringify(opts) }),
  deleteClip: (id: number) => request<void>(`/clips/${id}`, { method: "DELETE" }),

  // ---- exports ----
  listExports: (clipId: number) => request<Export[]>(`/clips/${clipId}/exports`),
  createExport: (
    clipId: number,
    data: { format: ExportFormat; resolution: ExportResolution; aspect_ratio: string; burn_captions: boolean },
  ) => request<Export>(`/clips/${clipId}/exports`, { method: "POST", body: JSON.stringify(data) }),
  getExport: (id: number) => request<Export>(`/exports/${id}`),
  exportDownloadUrl: (id: number) => {
    // Opened as a plain link, so pass auth via ?token= (the endpoint accepts it).
    const token = tokenStore.access ?? "";
    return `${API_BASE}/exports/${id}/download?token=${encodeURIComponent(token)}`;
  },

  // ---- settings / models ----
  getSettings: () => request<UserSettings>("/settings"),
  updateSettings: (data: Partial<UserSettings>) =>
    request<UserSettings>("/settings", { method: "PATCH", body: JSON.stringify(data) }),
  listModels: () => request<OllamaModel[]>("/models"),
  deleteModel: (name: string) =>
    request<{ deleted: string }>(`/models/${encodeURIComponent(name)}`, { method: "DELETE" }),
  // Install a model, streaming Ollama's download progress to `onEvent`.
  pullModel: async (name: string, onEvent: (e: PullEvent) => void): Promise<void> => {
    const res = await rawFetch("/models/pull", { method: "POST", body: JSON.stringify({ name }) });
    if (!res.ok || !res.body) {
      let detail = `Install failed (${res.status})`;
      try {
        const body = await res.json();
        if (typeof body.detail === "string") detail = body.detail;
      } catch {
        /* non-JSON */
      }
      throw new ApiError(res.status, detail);
    }
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buf = "";
    const flush = (line: string) => {
      const s = line.trim();
      if (!s) return;
      let evt: PullEvent;
      try {
        evt = JSON.parse(s) as PullEvent;
      } catch {
        return;
      }
      onEvent(evt); // may throw to abort (e.g. on an error event)
    };
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      let nl: number;
      while ((nl = buf.indexOf("\n")) >= 0) {
        flush(buf.slice(0, nl));
        buf = buf.slice(nl + 1);
      }
    }
    flush(buf);
  },

  // ---- bots ----
  listBots: () => request<Bot[]>("/bots"),
  getBot: (id: number) => request<Bot>(`/bots/${id}`),
  createBot: (data: Partial<Bot> & { preset_key?: string; preset_id?: number; config_overrides?: Record<string, unknown> }) =>
    request<Bot>("/bots", { method: "POST", body: JSON.stringify(data) }),
  updateBot: (id: number, data: Record<string, unknown>) =>
    request<Bot>(`/bots/${id}`, { method: "PATCH", body: JSON.stringify(data) }),
  deleteBot: (id: number) => request<void>(`/bots/${id}`, { method: "DELETE" }),
  cloneBot: (id: number) => request<Bot>(`/bots/${id}/clone`, { method: "POST" }),
  exportBot: (id: number) => request<Record<string, unknown>>(`/bots/${id}/export`),
  importBot: (data: Record<string, unknown>) =>
    request<Bot>("/bots/import", { method: "POST", body: JSON.stringify(data) }),
  botAction: (id: number, action: "start" | "pause" | "resume" | "stop") =>
    request<Bot>(`/bots/${id}/${action}`, { method: "POST" }),
  runBot: (id: number) => request<{ task_id: string }>(`/bots/${id}/run`, { method: "POST" }),
  improveBot: (id: number) => request<{ task_id: string }>(`/bots/${id}/improve`, { method: "POST" }),
  listRuns: (id: number) => request<BotRun[]>(`/bots/${id}/runs`),
  botAnalytics: (id: number) => request<BotAnalytics>(`/automation/bots/${id}/analytics`),

  // ---- sources ----
  listSources: (botId: number) => request<TrendSource[]>(`/bots/${botId}/sources`),
  addSource: (botId: number, data: Partial<TrendSource>) =>
    request<TrendSource>(`/bots/${botId}/sources`, { method: "POST", body: JSON.stringify(data) }),
  updateSource: (botId: number, sourceId: number, data: Partial<TrendSource>) =>
    request<TrendSource>(`/bots/${botId}/sources/${sourceId}`, { method: "PATCH", body: JSON.stringify(data) }),
  deleteSource: (botId: number, sourceId: number) =>
    request<void>(`/bots/${botId}/sources/${sourceId}`, { method: "DELETE" }),

  // ---- presets ----
  listPresets: () => request<Preset[]>("/presets"),
  createPreset: (data: Partial<Preset>) =>
    request<Preset>("/presets", { method: "POST", body: JSON.stringify(data) }),
  updatePreset: (id: number, data: Record<string, unknown>) =>
    request<Preset>(`/presets/${id}`, { method: "PATCH", body: JSON.stringify(data) }),
  deletePreset: (id: number) => request<void>(`/presets/${id}`, { method: "DELETE" }),
  duplicatePreset: (id: number) => request<Preset>(`/presets/${id}/duplicate`, { method: "POST" }),

  // ---- discovery ----
  listPlatforms: () => request<{ platforms: string[] }>("/discovery/platforms"),
  listTrendItems: (botId: number, status?: string, sort: "score" | "time" = "score") =>
    request<TrendItem[]>(`/discovery/bots/${botId}/items?sort=${sort}${status ? `&status=${status}` : ""}`),
  approveItem: (id: number) => request<TrendItem>(`/discovery/items/${id}/approve`, { method: "POST" }),
  rejectItem: (id: number) => request<TrendItem>(`/discovery/items/${id}/reject`, { method: "POST" }),
  deleteItem: (id: number) => request<void>(`/discovery/items/${id}`, { method: "DELETE" }),

  // ---- publishing ----
  listConnectors: () => request<Connector[]>("/publishing/connectors"),
  createConnector: (data: Partial<Connector> & { credentials?: Record<string, unknown> }) =>
    request<Connector>("/publishing/connectors", { method: "POST", body: JSON.stringify(data) }),
  updateConnector: (id: number, data: { name?: string; config?: Record<string, unknown>; bot_id?: number | null }) =>
    request<Connector>(`/publishing/connectors/${id}`, { method: "PATCH", body: JSON.stringify(data) }),
  assignConnector: (id: number, botId: number | null) =>
    request<Connector>(`/publishing/connectors/${id}/assign`, { method: "POST", body: JSON.stringify({ bot_id: botId }) }),
  deleteConnector: (id: number) => request<void>(`/publishing/connectors/${id}`, { method: "DELETE" }),
  youtubeStatus: () => request<YouTubeStatus>("/publishing/youtube/status"),
  youtubeAuthUrl: (data: { bot_id?: number | null; name?: string }) =>
    request<{ auth_url: string }>("/publishing/youtube/auth-url", { method: "POST", body: JSON.stringify(data) }),
  listJobs: (botId?: number, status?: string) => {
    const q = new URLSearchParams();
    if (botId) q.set("bot_id", String(botId));
    if (status) q.set("status", status);
    return request<PublishingJob[]>(`/publishing/jobs?${q.toString()}`);
  },
  approveJob: (id: number) => request<{ task_id: string }>(`/publishing/jobs/${id}/approve`, { method: "POST" }),
  retryJob: (id: number) => request<{ task_id: string }>(`/publishing/jobs/${id}/retry`, { method: "POST" }),
  cancelJob: (id: number) => request<PublishingJob>(`/publishing/jobs/${id}/cancel`, { method: "POST" }),

  // ---- automation status ----
  ollamaStatus: () => request<OllamaStatus>("/automation/ollama/status"),
  setGpuProcessSuspended: (pid: number, suspended: boolean) =>
    request<{ pid: number; suspended: boolean }>(`/automation/gpu/processes/${pid}/suspend`, {
      method: "POST",
      body: JSON.stringify({ suspended }),
    }),
  terminateGpuProcess: (pid: number) =>
    request<{ terminated: number }>(`/automation/gpu/processes/${pid}`, { method: "DELETE" }),

  // ---- story vault ----
  svMeta: () => request<SvMeta>("/storyvault/meta"),
  svVoices: () => request<SvVoice[]>("/storyvault/voices"),
  svDashboard: () => request<SvDashboard>("/storyvault/dashboard"),
  // ---- story vault: projects (auto-workflow folders) ----
  svListProjects: () => request<SvProject[]>("/storyvault/projects"),
  svGetProject: (id: number) => request<SvProject>(`/storyvault/projects/${id}`),
  svCreateProject: (data: { name: string; description?: string; settings?: Partial<SvProjectSettings> }) =>
    request<SvProject>("/storyvault/projects", { method: "POST", body: JSON.stringify(data) }),
  svUpdateProject: (
    id: number,
    data: { name?: string; description?: string; settings?: Partial<SvProjectSettings> },
  ) => request<SvProject>(`/storyvault/projects/${id}`, { method: "PATCH", body: JSON.stringify(data) }),
  svDeleteProject: (id: number) => request<void>(`/storyvault/projects/${id}`, { method: "DELETE" }),
  svRunProject: (id: number) =>
    request<SvProjectRunResult>(`/storyvault/projects/${id}/run`, { method: "POST" }),
  svDiscoverySearch: (data: {
    communities: string[];
    sort?: string;
    time_window?: string;
    limit?: number;
    min_upvotes?: number;
    min_length?: number;
  }) => request<SvDiscoveryResult>("/storyvault/discovery/search", { method: "POST", body: JSON.stringify(data) }),
  svImportStory: (data: { title: string; body: string; category?: string; source_url?: string }) =>
    request<SvStory>("/storyvault/stories/import", { method: "POST", body: JSON.stringify(data) }),
  svListStories: (
    params: { status?: string; category?: string; q?: string; sort?: string; project_id?: number } = {},
  ) => {
    const q = new URLSearchParams();
    if (params.status) q.set("status", params.status);
    if (params.category) q.set("category", params.category);
    if (params.q) q.set("q", params.q);
    if (params.sort) q.set("sort", params.sort);
    if (params.project_id != null) q.set("project_id", String(params.project_id));
    return request<SvStory[]>(`/storyvault/stories?${q.toString()}`);
  },
  svGetStory: (id: number) => request<SvStory>(`/storyvault/stories/${id}`),
  svUpdateStory: (id: number, data: { status?: string; category?: string }) =>
    request<SvStory>(`/storyvault/stories/${id}`, { method: "PATCH", body: JSON.stringify(data) }),
  svDeleteStory: (id: number) => request<void>(`/storyvault/stories/${id}`, { method: "DELETE" }),
  svListScripts: (storyId: number) => request<SvScript[]>(`/storyvault/stories/${storyId}/scripts`),
  svUploadBackground: (file: File, category?: string) => {
    const form = new FormData();
    form.append("file", file);
    if (category) form.append("category", category);
    return request<SvBackground>("/storyvault/backgrounds/upload", { method: "POST", body: form });
  },
  svImportBackground: (url: string, category?: string) =>
    request<SvBackground>("/storyvault/backgrounds/import", {
      method: "POST",
      body: JSON.stringify({ url, category: category || undefined }),
    }),
  svListBackgrounds: () => request<SvBackground[]>("/storyvault/backgrounds"),
  svUpdateBackground: (id: number, data: { category?: string }) =>
    request<SvBackground>(`/storyvault/backgrounds/${id}`, { method: "PATCH", body: JSON.stringify(data) }),
  svDeleteBackground: (id: number) => request<void>(`/storyvault/backgrounds/${id}`, { method: "DELETE" }),
  svListMusic: () => request<SvMusic[]>("/storyvault/music"),
  svUploadMusic: (file: File) => {
    const form = new FormData();
    form.append("file", file);
    return request<SvMusic>("/storyvault/music/upload", { method: "POST", body: form });
  },
  svImportMusic: (url: string) =>
    request<SvMusic>("/storyvault/music/import", { method: "POST", body: JSON.stringify({ url }) }),
  svRenameMusic: (id: number, name: string) =>
    request<SvMusic>(`/storyvault/music/${id}`, { method: "PATCH", body: JSON.stringify({ name }) }),
  svDeleteMusic: (id: number) => request<void>(`/storyvault/music/${id}`, { method: "DELETE" }),
  svMusicPreview: (music_id: number, volume: number) =>
    request<SvMusicPreview>("/storyvault/music/preview", {
      method: "POST",
      body: JSON.stringify({ music_id, volume }),
    }),
  svListMusicPresets: () => request<SvMusicPreset[]>("/storyvault/music/presets"),
  svCreateMusicPreset: (data: { name: string; music_id: number; volume: number }) =>
    request<SvMusicPreset>("/storyvault/music/presets", { method: "POST", body: JSON.stringify(data) }),
  svUpdateMusicPreset: (id: number, data: { name?: string; music_id?: number; volume?: number }) =>
    request<SvMusicPreset>(`/storyvault/music/presets/${id}`, { method: "PATCH", body: JSON.stringify(data) }),
  svDeleteMusicPreset: (id: number) =>
    request<void>(`/storyvault/music/presets/${id}`, { method: "DELETE" }),
  svCreateVideo: (data: SvVideoCreate) =>
    request<SvVideo>("/storyvault/videos", { method: "POST", body: JSON.stringify(data) }),
  svListVideos: (status?: string, projectId?: number) => {
    const q = new URLSearchParams();
    if (status) q.set("status", status);
    if (projectId != null) q.set("project_id", String(projectId));
    const qs = q.toString();
    return request<SvVideo[]>(`/storyvault/videos${qs ? `?${qs}` : ""}`);
  },
  svGetVideo: (id: number) => request<SvVideo>(`/storyvault/videos/${id}`),
  svApproveVideo: (id: number, platform: string) =>
    request<SvVideo>(`/storyvault/videos/${id}/approve`, { method: "POST", body: JSON.stringify({ platform }) }),
  svRejectVideo: (id: number, reason?: string) =>
    request<SvVideo>(`/storyvault/videos/${id}/reject`, { method: "POST", body: JSON.stringify({ reason }) }),
  svRetryVideo: (id: number) => request<SvVideo>(`/storyvault/videos/${id}/retry`, { method: "POST" }),
  svCancelVideo: (id: number) => request<SvVideo>(`/storyvault/videos/${id}/cancel`, { method: "POST" }),
  svClearVideoQueue: () => request<{ detail: string }>(`/storyvault/videos/clear-queue`, { method: "POST" }),
  svDeleteVideo: (id: number) => request<void>(`/storyvault/videos/${id}`, { method: "DELETE" }),
  svVoiceSample: (data: { text?: string; voice?: string | null; speed?: number }) =>
    request<SvVoiceSample>("/storyvault/voices/sample", { method: "POST", body: JSON.stringify(data) }),
  svListVoicePresets: () => request<SvVoicePreset[]>("/storyvault/voices/presets"),
  svCreateVoicePreset: (data: { name: string; voice: string; speed: number }) =>
    request<SvVoicePreset>("/storyvault/voices/presets", { method: "POST", body: JSON.stringify(data) }),
  svUpdateVoicePreset: (id: number, data: { name?: string; voice?: string; speed?: number }) =>
    request<SvVoicePreset>(`/storyvault/voices/presets/${id}`, { method: "PATCH", body: JSON.stringify(data) }),
  svSetDefaultVoicePreset: (id: number) =>
    request<SvVoicePreset>(`/storyvault/voices/presets/${id}/default`, { method: "POST" }),
  svDeleteVoicePreset: (id: number) =>
    request<void>(`/storyvault/voices/presets/${id}`, { method: "DELETE" }),
  // ---- voice cloning (Fish Speech S2) ----
  svCloneStatus: () => request<SvCloneStatus>("/storyvault/voices/clone/status"),
  svCloneUpload: (file: File) => {
    const form = new FormData();
    form.append("file", file);
    return request<SvCloneUpload>("/storyvault/voices/clone/upload", { method: "POST", body: form });
  },
  svCloneTranscribe: (reference_id: string) =>
    request<SvCloneTranscribe>("/storyvault/voices/clone/transcribe", {
      method: "POST",
      body: JSON.stringify({ reference_id }),
    }),
  svCloneGenerate: (data: { text: string; reference_id?: string | null; prompt_text?: string }) =>
    request<SvCloneGenerate>("/storyvault/voices/clone/generate", {
      method: "POST",
      body: JSON.stringify(data),
    }),
  svCloneModels: () => request<SvCloneModels>("/storyvault/voices/clone/models"),
  svSetCloneQuant: (quant: string) =>
    request<SvCloneModels>("/storyvault/voices/clone/models", {
      method: "POST",
      body: JSON.stringify({ quant }),
    }),
  svCaptionPreviews: () => request<SvCaptionPreview[]>("/storyvault/presets/caption-previews"),
  svGenerateCaptionPreviews: (force = false) =>
    request<{ detail: string }>(`/storyvault/presets/caption-previews/generate?force=${force}`, { method: "POST" }),
  svListTemplates: () => request<SvTemplate[]>("/storyvault/templates"),
  svCreateTemplate: (data: { name: string; data?: Record<string, unknown> }) =>
    request<SvTemplate>("/storyvault/templates", { method: "POST", body: JSON.stringify(data) }),
  svUpdateTemplate: (id: number, data: { name?: string; data?: Record<string, unknown> }) =>
    request<SvTemplate>(`/storyvault/templates/${id}`, { method: "PATCH", body: JSON.stringify(data) }),
  svSetDefaultTemplate: (id: number) =>
    request<SvTemplate>(`/storyvault/templates/${id}/default`, { method: "POST" }),
  svDuplicateTemplate: (id: number) =>
    request<SvTemplate>(`/storyvault/templates/${id}/duplicate`, { method: "POST" }),
  svDeleteTemplate: (id: number) =>
    request<void>(`/storyvault/templates/${id}`, { method: "DELETE" }),
  svPublishVideo: (
    videoId: number,
    data: { connector_ids: number[]; title?: string; description?: string; privacy?: string },
  ) =>
    request<SvPublishJob[]>(`/storyvault/videos/${videoId}/publish`, {
      method: "POST",
      body: JSON.stringify(data),
    }),
  svListPublishJobs: () => request<SvPublishJob[]>("/storyvault/publishing/jobs"),
  svRetryPublishJob: (id: number) =>
    request<SvPublishJob>(`/storyvault/publishing/jobs/${id}/retry`, { method: "POST" }),
  svDeletePublishJob: (id: number) =>
    request<void>(`/storyvault/publishing/jobs/${id}`, { method: "DELETE" }),
  svListExports: () => request<SvExport[]>("/storyvault/exports"),
  svDeleteExport: (id: number) => request<void>(`/storyvault/exports/${id}`, { method: "DELETE" }),
  svExportDownloadUrl: (id: number) =>
    `${API_BASE}/storyvault/exports/${id}/download?token=${encodeURIComponent(tokenStore.access ?? "")}`,
};
