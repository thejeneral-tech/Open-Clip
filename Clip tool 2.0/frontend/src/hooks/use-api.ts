"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "@/lib/api";
import type { ProcessOptions } from "@/lib/types";

// ---------------------------------------------------------------- projects
export function useProjects() {
  return useQuery({ queryKey: ["projects"], queryFn: api.listProjects });
}

export function useProject(id: number) {
  return useQuery({ queryKey: ["project", id], queryFn: () => api.getProject(id), enabled: !!id });
}

export function useCreateProject() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (vars: { name: string; description?: string }) =>
      api.createProject(vars.name, vars.description),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["projects"] }),
  });
}

export function useDeleteProject() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: number) => api.deleteProject(id),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["projects"] }),
  });
}

// ------------------------------------------------------------------ videos
export function useVideos(projectId: number, poll = false) {
  return useQuery({
    queryKey: ["videos", projectId],
    queryFn: () => api.listVideos(projectId),
    enabled: !!projectId,
    refetchInterval: poll ? 4000 : false,
  });
}

export function useVideo(id: number, poll = false) {
  return useQuery({
    queryKey: ["video", id],
    queryFn: () => api.getVideo(id),
    enabled: !!id,
    refetchInterval: poll ? 4000 : false,
  });
}

export function useProcessVideo() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (vars: { id: number; options: Partial<ProcessOptions> }) =>
      api.processVideo(vars.id, vars.options),
    onSuccess: (_d, vars) => {
      qc.invalidateQueries({ queryKey: ["video", vars.id] });
      qc.invalidateQueries({ queryKey: ["clips", vars.id] });
    },
  });
}

export function useDeleteVideo(projectId: number) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: number) => api.deleteVideo(id),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["videos", projectId] }),
  });
}

// ------------------------------------------------------------------- clips
export function useClips(videoId: number, sort: "score" | "time" = "score", poll = false) {
  return useQuery({
    queryKey: ["clips", videoId, sort],
    queryFn: () => api.listClips(videoId, sort),
    enabled: !!videoId,
    refetchInterval: poll ? 5000 : false,
  });
}

export function useClip(id: number) {
  return useQuery({ queryKey: ["clip", id], queryFn: () => api.getClip(id), enabled: !!id });
}

export function useUpdateClip() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (vars: { id: number; data: Record<string, unknown> }) =>
      api.updateClip(vars.id, vars.data as never),
    onSuccess: (clip) => {
      qc.invalidateQueries({ queryKey: ["clip", clip.id] });
      qc.invalidateQueries({ queryKey: ["clips", clip.video_id] });
    },
  });
}

// ----------------------------------------------------------------- exports
export function useExports(clipId: number, poll = false) {
  return useQuery({
    queryKey: ["exports", clipId],
    queryFn: () => api.listExports(clipId),
    enabled: !!clipId,
    refetchInterval: poll ? 3000 : false,
  });
}

// ---------------------------------------------------------- settings/models
export function useSettings() {
  return useQuery({ queryKey: ["settings"], queryFn: api.getSettings });
}

export function useModels() {
  return useQuery({ queryKey: ["models"], queryFn: api.listModels, staleTime: 60_000 });
}

// --------------------------------------------------------------------- bots
export function useBots(poll = false) {
  return useQuery({
    queryKey: ["bots"],
    queryFn: api.listBots,
    refetchInterval: poll ? 5000 : false,
  });
}

export function useBot(id: number, poll = false) {
  return useQuery({
    queryKey: ["bot", id],
    queryFn: () => api.getBot(id),
    enabled: !!id,
    refetchInterval: poll ? 5000 : false,
  });
}

export function useCreateBot() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (data: Parameters<typeof api.createBot>[0]) => api.createBot(data),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["bots"] }),
  });
}

export function useBotAction(id: number) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (action: "start" | "pause" | "resume" | "stop") => api.botAction(id, action),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["bots"] });
      qc.invalidateQueries({ queryKey: ["bot", id] });
    },
  });
}

export function useDeleteBot() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: number) => api.deleteBot(id),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["bots"] }),
  });
}

export function useBotRuns(id: number, poll = false) {
  return useQuery({
    queryKey: ["bot-runs", id],
    queryFn: () => api.listRuns(id),
    enabled: !!id,
    refetchInterval: poll ? 4000 : false,
  });
}

export function useBotAnalytics(id: number) {
  return useQuery({ queryKey: ["bot-analytics", id], queryFn: () => api.botAnalytics(id), enabled: !!id });
}

// ------------------------------------------------------------------ sources
export function useSources(botId: number) {
  return useQuery({ queryKey: ["sources", botId], queryFn: () => api.listSources(botId), enabled: !!botId });
}

// ------------------------------------------------------------------ presets
export function usePresets() {
  return useQuery({ queryKey: ["presets"], queryFn: api.listPresets, staleTime: 30_000 });
}

// ---------------------------------------------------------------- discovery
export function useTrendItems(botId: number, status?: string, poll = false) {
  return useQuery({
    queryKey: ["trend-items", botId, status],
    queryFn: () => api.listTrendItems(botId, status),
    enabled: !!botId,
    refetchInterval: poll ? 6000 : false,
  });
}

// --------------------------------------------------------------- publishing
export function useConnectors() {
  return useQuery({ queryKey: ["connectors"], queryFn: api.listConnectors });
}

export function useYouTubeStatus() {
  return useQuery({ queryKey: ["youtube-status"], queryFn: api.youtubeStatus, staleTime: 60_000 });
}

export function usePublishingJobs(botId?: number, status?: string, poll = false) {
  return useQuery({
    queryKey: ["pub-jobs", botId, status],
    queryFn: () => api.listJobs(botId, status),
    refetchInterval: poll ? 5000 : false,
  });
}

// ---------------------------------------------------------- automation status
export function useOllamaStatus(poll = false) {
  return useQuery({
    queryKey: ["ollama-status"],
    queryFn: api.ollamaStatus,
    refetchInterval: poll ? 5000 : false,
  });
}

// -------------------------------------------------------------- story vault
export function useSvMeta() {
  return useQuery({ queryKey: ["sv-meta"], queryFn: api.svMeta, staleTime: 5 * 60_000 });
}

export function useSvVoices() {
  return useQuery({ queryKey: ["sv-voices"], queryFn: api.svVoices, staleTime: 5 * 60_000 });
}

export function useSvDashboard(poll = false) {
  return useQuery({
    queryKey: ["sv-dashboard"],
    queryFn: api.svDashboard,
    refetchInterval: poll ? 6000 : false,
  });
}

export function useSvStories(params: { status?: string; category?: string; q?: string; sort?: string } = {}) {
  return useQuery({
    queryKey: ["sv-stories", params],
    queryFn: () => api.svListStories(params),
  });
}

export function useSvDiscoverySearch() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (data: Parameters<typeof api.svDiscoverySearch>[0]) => api.svDiscoverySearch(data),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["sv-stories"] }),
  });
}

export function useSvImportStory() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (data: Parameters<typeof api.svImportStory>[0]) => api.svImportStory(data),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["sv-stories"] }),
  });
}

export function useSvUpdateStory() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (vars: { id: number; data: { status?: string; category?: string } }) =>
      api.svUpdateStory(vars.id, vars.data),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["sv-stories"] }),
  });
}

export function useSvDeleteStory() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: number) => api.svDeleteStory(id),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["sv-stories"] }),
  });
}

export function useSvBackgrounds(poll = false) {
  return useQuery({
    queryKey: ["sv-backgrounds"],
    queryFn: api.svListBackgrounds,
    refetchInterval: poll ? 4000 : false,
  });
}

export function useSvUploadBackground() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (vars: { file: File; category?: string }) =>
      api.svUploadBackground(vars.file, vars.category),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["sv-backgrounds"] }),
  });
}

export function useSvUpdateBackground() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (vars: { id: number; data: { category?: string } }) =>
      api.svUpdateBackground(vars.id, vars.data),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["sv-backgrounds"] }),
  });
}

export function useSvDeleteBackground() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: number) => api.svDeleteBackground(id),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["sv-backgrounds"] }),
  });
}

export function useSvVideos(status?: string, poll = false) {
  return useQuery({
    queryKey: ["sv-videos", status ?? "all"],
    queryFn: () => api.svListVideos(status),
    refetchInterval: poll ? 4000 : false,
  });
}

export function useSvVideo(id: number, poll = false) {
  return useQuery({
    queryKey: ["sv-video", id],
    queryFn: () => api.svGetVideo(id),
    enabled: !!id,
    refetchInterval: poll ? 4000 : false,
  });
}

function useSvVideoMutation<TVars>(fn: (vars: TVars) => Promise<unknown>) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: fn,
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["sv-videos"] });
      qc.invalidateQueries({ queryKey: ["sv-video"] });
      qc.invalidateQueries({ queryKey: ["sv-dashboard"] });
      qc.invalidateQueries({ queryKey: ["sv-exports"] });
    },
  });
}

export function useSvCreateVideo() {
  return useSvVideoMutation((data: Parameters<typeof api.svCreateVideo>[0]) => api.svCreateVideo(data));
}

export function useSvApproveVideo() {
  return useSvVideoMutation((vars: { id: number; platform: string }) =>
    api.svApproveVideo(vars.id, vars.platform),
  );
}

export function useSvRejectVideo() {
  return useSvVideoMutation((vars: { id: number; reason?: string }) =>
    api.svRejectVideo(vars.id, vars.reason),
  );
}

export function useSvRetryVideo() {
  return useSvVideoMutation((id: number) => api.svRetryVideo(id));
}

export function useSvDeleteVideo() {
  return useSvVideoMutation((id: number) => api.svDeleteVideo(id));
}

export function useSvVoicePresets() {
  return useQuery({ queryKey: ["sv-voice-presets"], queryFn: api.svListVoicePresets });
}

export function useSvCreateVoicePreset() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (data: { name: string; voice: string; speed: number }) => api.svCreateVoicePreset(data),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["sv-voice-presets"] }),
  });
}

export function useSvSetDefaultVoicePreset() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: number) => api.svSetDefaultVoicePreset(id),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["sv-voice-presets"] }),
  });
}

export function useSvDeleteVoicePreset() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: number) => api.svDeleteVoicePreset(id),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["sv-voice-presets"] }),
  });
}

export function useSvVoiceSample() {
  return useMutation({
    mutationFn: (data: { text?: string; voice?: string | null; speed?: number }) =>
      api.svVoiceSample(data),
  });
}

export function useSvCaptionPreviews(poll = false) {
  return useQuery({
    queryKey: ["sv-caption-previews"],
    queryFn: api.svCaptionPreviews,
    refetchInterval: poll ? 3000 : false,
  });
}

export function useSvGenerateCaptionPreviews() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (force: boolean) => api.svGenerateCaptionPreviews(force),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["sv-caption-previews"] }),
  });
}

export function useSvExports(poll = false) {
  return useQuery({
    queryKey: ["sv-exports"],
    queryFn: api.svListExports,
    refetchInterval: poll ? 6000 : false,
  });
}

export function useSvDeleteExport() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: number) => api.svDeleteExport(id),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["sv-exports"] }),
  });
}
