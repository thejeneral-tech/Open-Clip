"use client";

import { keepPreviousData, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
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
    // Keep showing the last status while a refetch is in flight so navigating
    // back to the dashboard (or each poll) never flashes the full-page spinner.
    placeholderData: keepPreviousData,
  });
}

export function useSetGpuProcessSuspended() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (vars: { pid: number; suspended: boolean }) =>
      api.setGpuProcessSuspended(vars.pid, vars.suspended),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["ollama-status"] }),
  });
}

export function useTerminateGpuProcess() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (pid: number) => api.terminateGpuProcess(pid),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["ollama-status"] }),
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

export function useSvStories(
  params: { status?: string; category?: string; q?: string; sort?: string; project_id?: number } = {},
) {
  return useQuery({
    queryKey: ["sv-stories", params],
    queryFn: () => api.svListStories(params),
  });
}

// ---------------------------------------------- story vault: projects
export function useSvProjects() {
  return useQuery({ queryKey: ["sv-projects"], queryFn: api.svListProjects });
}

export function useSvProject(id: number, poll = false) {
  return useQuery({
    queryKey: ["sv-project", id],
    queryFn: () => api.svGetProject(id),
    enabled: !!id,
    refetchInterval: poll ? 5000 : false,
  });
}

export function useSvCreateProject() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (data: Parameters<typeof api.svCreateProject>[0]) => api.svCreateProject(data),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["sv-projects"] }),
  });
}

export function useSvUpdateProject() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (vars: { id: number; data: Parameters<typeof api.svUpdateProject>[1] }) =>
      api.svUpdateProject(vars.id, vars.data),
    onSuccess: (_d, vars) => {
      qc.invalidateQueries({ queryKey: ["sv-projects"] });
      qc.invalidateQueries({ queryKey: ["sv-project", vars.id] });
    },
  });
}

export function useSvDeleteProject() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: number) => api.svDeleteProject(id),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["sv-projects"] });
      qc.invalidateQueries({ queryKey: ["sv-stories"] });
      qc.invalidateQueries({ queryKey: ["sv-videos"] });
    },
  });
}

export function useSvRunProject() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: number) => api.svRunProject(id),
    onSuccess: (_d, id) => {
      qc.invalidateQueries({ queryKey: ["sv-projects"] });
      qc.invalidateQueries({ queryKey: ["sv-project", id] });
      qc.invalidateQueries({ queryKey: ["sv-stories"] });
      qc.invalidateQueries({ queryKey: ["sv-videos"] });
      qc.invalidateQueries({ queryKey: ["sv-dashboard"] });
    },
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

export function useSvImportBackground() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (vars: { url: string; category?: string }) =>
      api.svImportBackground(vars.url, vars.category),
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

export function useSvMusic(poll = false) {
  return useQuery({
    queryKey: ["sv-music"],
    queryFn: api.svListMusic,
    refetchInterval: poll ? 4000 : false,
  });
}

export function useSvUploadMusic() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (file: File) => api.svUploadMusic(file),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["sv-music"] }),
  });
}

export function useSvImportMusic() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (url: string) => api.svImportMusic(url),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["sv-music"] }),
  });
}

export function useSvRenameMusic() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (vars: { id: number; name: string }) => api.svRenameMusic(vars.id, vars.name),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["sv-music"] }),
  });
}

export function useSvDeleteMusic() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: number) => api.svDeleteMusic(id),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["sv-music"] }),
  });
}

export function useSvMusicPreview() {
  return useMutation({
    mutationFn: (vars: { music_id: number; volume: number }) =>
      api.svMusicPreview(vars.music_id, vars.volume),
  });
}

export function useSvMusicPresets() {
  return useQuery({ queryKey: ["sv-music-presets"], queryFn: api.svListMusicPresets });
}

export function useSvCreateMusicPreset() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (data: { name: string; music_id: number; volume: number }) =>
      api.svCreateMusicPreset(data),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["sv-music-presets"] }),
  });
}

export function useSvUpdateMusicPreset() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (vars: { id: number; data: { name?: string; music_id?: number; volume?: number } }) =>
      api.svUpdateMusicPreset(vars.id, vars.data),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["sv-music-presets"] }),
  });
}

export function useSvDeleteMusicPreset() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: number) => api.svDeleteMusicPreset(id),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["sv-music-presets"] }),
  });
}

export function useSvVideos(status?: string, poll = false, projectId?: number) {
  return useQuery({
    queryKey: ["sv-videos", status ?? "all", projectId ?? "all"],
    queryFn: () => api.svListVideos(status, projectId),
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

export function useSvCancelVideo() {
  return useSvVideoMutation((id: number) => api.svCancelVideo(id));
}

export function useSvClearVideoQueue() {
  // `_: void` pins TVars to void so the mutation is callable with no argument.
  return useSvVideoMutation((_: void) => api.svClearVideoQueue());
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

// ---- voice cloning (Fish Speech S2) ----
export function useSvCloneStatus(poll = false) {
  return useQuery({
    queryKey: ["sv-clone-status"],
    queryFn: api.svCloneStatus,
    refetchInterval: poll ? 5000 : false,
    staleTime: 4000,
  });
}

export function useSvCloneUpload() {
  return useMutation({ mutationFn: (file: File) => api.svCloneUpload(file) });
}

export function useSvCloneTranscribe() {
  return useMutation({ mutationFn: (referenceId: string) => api.svCloneTranscribe(referenceId) });
}

export function useSvCloneGenerate() {
  return useMutation({
    mutationFn: (data: { text: string; reference_id?: string | null; prompt_text?: string }) =>
      api.svCloneGenerate(data),
  });
}

export function useSvCloneModels(poll = false) {
  return useQuery({
    queryKey: ["sv-clone-models"],
    queryFn: api.svCloneModels,
    refetchInterval: poll ? 8000 : false,
  });
}

export function useSvSetCloneQuant() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (quant: string) => api.svSetCloneQuant(quant),
    onSuccess: (data) => qc.setQueryData(["sv-clone-models"], data),
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

export function useSvTemplates() {
  return useQuery({ queryKey: ["sv-templates"], queryFn: api.svListTemplates });
}

export function useSvCreateTemplate() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (data: { name: string; data?: Record<string, unknown> }) =>
      api.svCreateTemplate(data),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["sv-templates"] }),
  });
}

export function useSvUpdateTemplate() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, data }: { id: number; data: { name?: string; data?: Record<string, unknown> } }) =>
      api.svUpdateTemplate(id, data),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["sv-templates"] }),
  });
}

export function useSvSetDefaultTemplate() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: number) => api.svSetDefaultTemplate(id),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["sv-templates"] }),
  });
}

export function useSvDuplicateTemplate() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: number) => api.svDuplicateTemplate(id),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["sv-templates"] }),
  });
}

export function useSvDeleteTemplate() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: number) => api.svDeleteTemplate(id),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["sv-templates"] }),
  });
}

export function useSvPublishJobs(poll = false) {
  return useQuery({
    queryKey: ["sv-publish-jobs"],
    queryFn: api.svListPublishJobs,
    refetchInterval: poll ? 4000 : false,
  });
}

export function useSvPublishVideo() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (vars: {
      videoId: number;
      data: { connector_ids: number[]; title?: string; description?: string; privacy?: string };
    }) => api.svPublishVideo(vars.videoId, vars.data),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["sv-publish-jobs"] });
      qc.invalidateQueries({ queryKey: ["sv-videos"] });
    },
  });
}

export function useSvRetryPublishJob() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: number) => api.svRetryPublishJob(id),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["sv-publish-jobs"] }),
  });
}

export function useSvDeletePublishJob() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: number) => api.svDeletePublishJob(id),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["sv-publish-jobs"] }),
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

// ------------------------------------------------------------ whop campaigns
export function useWhopDashboard(poll = false) {
  return useQuery({
    queryKey: ["whop-dashboard"],
    queryFn: api.whopDashboard,
    refetchInterval: poll ? 6000 : false,
  });
}

export function useWhopCampaigns(params?: { status?: string; q?: string }, poll = false) {
  return useQuery({
    queryKey: ["whop-campaigns", params ?? {}],
    queryFn: () => api.whopListCampaigns(params),
    refetchInterval: poll ? 5000 : false,
  });
}

export function useWhopCampaign(id: number, poll = false) {
  return useQuery({
    queryKey: ["whop-campaign", id],
    queryFn: () => api.whopGetCampaign(id),
    enabled: !!id,
    refetchInterval: poll ? 5000 : false,
  });
}

export function useWhopCreateCampaign() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (data: Parameters<typeof api.whopCreateCampaign>[0]) => api.whopCreateCampaign(data),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["whop-campaigns"] });
      qc.invalidateQueries({ queryKey: ["whop-campaign"] });
      qc.invalidateQueries({ queryKey: ["whop-dashboard"] });
    },
  });
}

export function useWhopUpdateCampaign() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (vars: { id: number; data: Parameters<typeof api.whopUpdateCampaign>[1] }) =>
      api.whopUpdateCampaign(vars.id, vars.data),
    onSuccess: (_d, vars) => {
      qc.invalidateQueries({ queryKey: ["whop-campaigns"] });
      qc.invalidateQueries({ queryKey: ["whop-campaign", vars.id] });
      qc.invalidateQueries({ queryKey: ["whop-dashboard"] });
    },
  });
}

export function useWhopDeleteCampaign() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: number) => api.whopDeleteCampaign(id),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["whop-campaigns"] });
      qc.invalidateQueries({ queryKey: ["whop-campaign"] });
      qc.invalidateQueries({ queryKey: ["whop-dashboard"] });
      qc.invalidateQueries({ queryKey: ["whop-analytics"] });
    },
  });
}

export function useWhopUploadThumbnail() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (vars: { id: number; file: File }) =>
      api.whopUploadCampaignThumbnail(vars.id, vars.file),
    onSuccess: (_d, vars) => {
      qc.invalidateQueries({ queryKey: ["whop-campaigns"] });
      qc.invalidateQueries({ queryKey: ["whop-campaign", vars.id] });
      qc.invalidateQueries({ queryKey: ["whop-dashboard"] });
    },
  });
}

export function useWhopEnsureStudio() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (campaignId: number) => api.whopEnsureStudio(campaignId),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["whop-campaign"] }),
  });
}

// ---- whop clip formulas (Studio "Analyze video → reusable formula") ----
export function useWhopFormulas(campaignId: number, poll = false) {
  return useQuery({
    queryKey: ["whop-formulas", campaignId],
    queryFn: () => api.whopListFormulas(campaignId),
    enabled: !!campaignId,
    // Poll when asked, and also self-continue while any formula is still
    // processing — so the unified feed updates without a local flag racing it.
    refetchInterval: (query) =>
      poll || query.state.data?.some((f) => f.status === "processing") ? 3000 : false,
  });
}

export function useWhopCreateFormula() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (vars: { campaignId: number; videoId: number }) =>
      api.whopCreateFormula(vars.campaignId, vars.videoId),
    onSuccess: (_d, vars) =>
      qc.invalidateQueries({ queryKey: ["whop-formulas", vars.campaignId] }),
  });
}

export function useWhopDeleteFormula() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: number) => api.whopDeleteFormula(id),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["whop-formulas"] }),
  });
}

// Auto-find source videos that correlate to a campaign — a mutation because it
// runs on demand (searches YouTube), not on mount.
export function useWhopFindVideos() {
  return useMutation({
    mutationFn: (vars: {
      campaignId: number;
      limit?: number;
      channel?: string;
      strictChannel?: boolean;
      filters?: string[];
    }) =>
      api.whopFindVideos(vars.campaignId, {
        limit: vars.limit,
        channel: vars.channel,
        strictChannel: vars.strictChannel,
        filters: vars.filters,
      }),
  });
}

// Deepen the Auto Finder Score for specific candidates (Stage 3 enrichment) —
// a mutation because it runs on demand and can take ~30-90s for a full batch.
export function useWhopScoreVideos() {
  return useMutation({
    mutationFn: (vars: {
      campaignId: number;
      urls: string[];
      stage?: number;
      prevScores?: Record<string, number>;
    }) =>
      api.whopScoreVideos(vars.campaignId, vars.urls, {
        stage: vars.stage,
        prevScores: vars.prevScores,
      }),
  });
}

// Campaign Copilot: one LLM synthesis over the ranked candidates → a strategy.
export function useWhopStrategy() {
  return useMutation({
    mutationFn: (vars: {
      campaignId: number;
      videos: Array<{
        url: string;
        title: string;
        score: number;
        duration?: number | null;
        projected_low?: number | null;
        projected_high?: number | null;
        reasons?: string[];
      }>;
    }) => api.whopStrategy(vars.campaignId, vars.videos),
  });
}

// ---- whop publishing ----
export function useWhopReadyClips(campaignId: number | null, poll = false) {
  return useQuery({
    queryKey: ["whop-ready-clips", campaignId],
    queryFn: () => api.whopReadyClips(campaignId as number),
    enabled: !!campaignId,
    refetchInterval: poll ? 4000 : false,
  });
}

export function useWhopPublishClip() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (vars: { campaignId: number; clipId: number; connectorId: number }) =>
      api.whopPublishClip(vars.campaignId, vars.clipId, vars.connectorId),
    onSuccess: (_d, vars) =>
      qc.invalidateQueries({ queryKey: ["whop-ready-clips", vars.campaignId] }),
  });
}

// On-demand scrape of a pasted whop.com link (title/description/cover) — a
// mutation because the form fires it when the URL changes, not on mount.
export function useWhopUrlPreview() {
  return useMutation({
    mutationFn: (url: string) => api.whopUrlPreview(url),
  });
}

// Distill requirement bullets from a campaign's description (following any linked
// Google Doc / brief) via the local model — fired on demand from the campaign form.
export function useWhopExtractRequirements() {
  return useMutation({
    mutationFn: (body: { text?: string; description?: string; whop_url?: string }) =>
      api.whopExtractRequirements(body),
  });
}

// ---- Whop account connection + campaign sync ----
export function useWhopConnection(poll = false) {
  return useQuery({
    queryKey: ["whop-connection"],
    queryFn: () => api.whopConnection(),
    refetchInterval: poll ? 2000 : false,
  });
}

export function useWhopConnect() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => api.whopConnect(),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["whop-connection"] }),
  });
}

export function useWhopConnectConfirm() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => api.whopConnectConfirm(),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["whop-connection"] }),
  });
}

export function useWhopDisconnect() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => api.whopDisconnect(),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["whop-connection"] }),
  });
}

export function useWhopSyncStart() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (appUrl?: string) => api.whopSyncStart(appUrl),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["whop-sync"] }),
  });
}

// Poll sync progress while a sync is running; refetch campaigns when it finishes.
export function useWhopSyncStatus(poll = false) {
  const qc = useQueryClient();
  return useQuery({
    queryKey: ["whop-sync"],
    queryFn: async () => {
      const s = await api.whopSyncStatus();
      if (!s.running && (s.updated || s.created)) {
        qc.invalidateQueries({ queryKey: ["whop-campaigns"] });
        qc.invalidateQueries({ queryKey: ["whop-dashboard"] });
      }
      return s;
    },
    refetchInterval: poll ? 2500 : false,
  });
}

// Bulk upsert/rescan: re-import a scraped marketplace file (upsert + reconcile).
export function useWhopImportCampaigns() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: Parameters<typeof api.whopImportCampaigns>[0]) =>
      api.whopImportCampaigns(body),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["whop-campaigns"] });
      qc.invalidateQueries({ queryKey: ["whop-dashboard"] });
    },
  });
}

// One-click rescan: the backend scrapes Whop's marketplace + upserts/reconciles.
export function useWhopRescan() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => api.whopRescan(),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["whop-campaigns"] });
      qc.invalidateQueries({ queryKey: ["whop-dashboard"] });
    },
  });
}

export function useWhopSubmissions(
  params?: { status?: string; campaign_id?: number; connector_id?: number },
  poll = false,
) {
  return useQuery({
    queryKey: ["whop-submissions", params ?? {}],
    queryFn: () => api.whopListSubmissions(params),
    refetchInterval: poll ? 4000 : false,
  });
}

// Every submission mutation moves money/views totals, so invalidate the whole
// whop surface (lists, campaign detail, dashboard, analytics) — mirrors
// useSvVideoMutation above.
function useWhopSubmissionMutation<TVars>(fn: (vars: TVars) => Promise<unknown>) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: fn,
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["whop-submissions"] });
      qc.invalidateQueries({ queryKey: ["whop-campaigns"] });
      qc.invalidateQueries({ queryKey: ["whop-campaign"] });
      qc.invalidateQueries({ queryKey: ["whop-dashboard"] });
      qc.invalidateQueries({ queryKey: ["whop-analytics"] });
      qc.invalidateQueries({ queryKey: ["whop-channels"] });
      qc.invalidateQueries({ queryKey: ["whop-channel-campaigns"] });
    },
  });
}

export function useWhopCreateSubmission() {
  return useWhopSubmissionMutation(
    (vars: { campaignId: number; data: Parameters<typeof api.whopCreateSubmission>[1] }) =>
      api.whopCreateSubmission(vars.campaignId, vars.data),
  );
}

export function useWhopUpdateSubmission() {
  return useWhopSubmissionMutation(
    (vars: { id: number; data: Parameters<typeof api.whopUpdateSubmission>[1] }) =>
      api.whopUpdateSubmission(vars.id, vars.data),
  );
}

export function useWhopApproveSubmission() {
  return useWhopSubmissionMutation((id: number) => api.whopApproveSubmission(id));
}

export function useWhopRejectSubmission() {
  return useWhopSubmissionMutation((vars: { id: number; reason?: string }) =>
    api.whopRejectSubmission(vars.id, vars.reason),
  );
}

export function useWhopPaySubmission() {
  return useWhopSubmissionMutation((id: number) => api.whopPaySubmission(id));
}

export function useWhopClawbackSubmission() {
  return useWhopSubmissionMutation((vars: { id: number; reason?: string }) =>
    api.whopClawbackSubmission(vars.id, vars.reason),
  );
}

export function useWhopDeleteSubmission() {
  return useWhopSubmissionMutation((id: number) => api.whopDeleteSubmission(id));
}

export function useWhopAnalytics(params?: { days?: number; campaign_id?: number }) {
  return useQuery({
    queryKey: ["whop-analytics", params ?? {}],
    queryFn: () => api.whopAnalytics(params),
    // Analytics moves slowly; keep the chart fresh without hammering the API.
    refetchInterval: 15_000,
  });
}

// ---- whop channels (review section) ----
export function useWhopChannels(poll = false) {
  return useQuery({
    queryKey: ["whop-channels"],
    queryFn: api.whopChannels,
    refetchInterval: poll ? 6000 : false,
  });
}

export function useWhopChannelCampaigns(connectorId: number | null) {
  return useQuery({
    queryKey: ["whop-channel-campaigns", connectorId],
    queryFn: () => api.whopChannelCampaigns(connectorId as number),
    enabled: connectorId != null,
  });
}

function useWhopChannelMutation<TVars>(fn: (vars: TVars) => Promise<unknown>) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: fn,
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["whop-channels"] });
      qc.invalidateQueries({ queryKey: ["whop-channel-campaigns"] });
      qc.invalidateQueries({ queryKey: ["whop-submissions"] });
    },
  });
}

export function useWhopLinkCampaign() {
  return useWhopChannelMutation((vars: { connectorId: number; campaignId: number }) =>
    api.whopLinkCampaign(vars.connectorId, vars.campaignId),
  );
}

export function useWhopUnlinkCampaign() {
  return useWhopChannelMutation((vars: { connectorId: number; campaignId: number }) =>
    api.whopUnlinkCampaign(vars.connectorId, vars.campaignId),
  );
}
