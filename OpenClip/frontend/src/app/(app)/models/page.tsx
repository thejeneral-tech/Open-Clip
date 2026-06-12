"use client";

import { Activity, Cpu, HardDrive, Loader2, Mic, Server, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Progress } from "@/components/ui/progress";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import {
  useModels,
  useOllamaStatus,
  useSetGpuProcessSuspended,
  useSvCloneModels,
  useSvSetCloneQuant,
  useTerminateGpuProcess,
} from "@/hooks/use-api";
import { formatBytes } from "@/lib/utils";

function gb(bytes: number | null | undefined): string {
  if (!bytes) return "0 GB";
  return `${(bytes / 1024 ** 3).toFixed(1)} GB`;
}

export default function ModelsPage() {
  const { data: status, isLoading } = useOllamaStatus(true);
  const { data: models = [] } = useModels();
  const { data: fish } = useSvCloneModels(true);
  const setQuant = useSvSetCloneQuant();
  const suspend = useSetGpuProcessSuspended();
  const terminate = useTerminateGpuProcess();

  const handleQuant = (q: string) => {
    setQuant.mutate(q, {
      onSuccess: () => toast.success(`Fish Speech quant set to ${q}`),
      onError: (err) => toast.error(err instanceof Error ? err.message : "Could not set quant"),
    });
  };

  // Toggle off = suspend (freeze) the process; toggle on = resume it. Reversible.
  const handleSuspendToggle = (pid: number, name: string, on: boolean) => {
    suspend.mutate(
      { pid, suspended: !on },
      {
        onSuccess: () => toast.success(`${on ? "Resumed" : "Paused"} ${name} (PID ${pid})`),
        onError: (err) =>
          toast.error(err instanceof Error ? err.message : `Could not ${on ? "resume" : "pause"} process`),
      },
    );
  };

  const handleKill = (pid: number, name: string) => {
    if (!window.confirm(`Force-terminate "${name}" (PID ${pid})? This kills the process — unsaved work in it is lost.`)) {
      return;
    }
    terminate.mutate(pid, {
      onSuccess: () => toast.success(`Terminated ${name} (PID ${pid})`),
      onError: (err) => toast.error(err instanceof Error ? err.message : "Could not terminate process"),
    });
  };

  return (
    <div className="mx-auto max-w-5xl space-y-6">
      <div>
        <h1 className="text-2xl font-bold tracking-tight">Models &amp; GPU</h1>
        <p className="text-muted-foreground">
          Centralized Ollama service status. Every AI request — discovery, scoring, clipping,
          titles, metadata — routes through here, on your hardware.
        </p>
      </div>

      {isLoading ? (
        <div className="flex justify-center py-20"><Loader2 className="h-6 w-6 animate-spin text-muted-foreground" /></div>
      ) : (
        <>
          <div className="grid gap-4 sm:grid-cols-3">
            <Card>
              <CardHeader className="pb-2"><CardTitle className="flex items-center gap-2 text-sm"><Server className="h-4 w-4" /> Ollama</CardTitle></CardHeader>
              <CardContent>
                <div className="flex items-center gap-2">
                  <span className={`h-2.5 w-2.5 rounded-full ${status?.ollama_up ? "bg-emerald-500" : "bg-destructive"}`} />
                  <span className="font-medium">{status?.ollama_up ? "Online" : "Offline"}</span>
                </div>
                <p className="mt-1 truncate text-xs text-muted-foreground">{status?.base_url}</p>
              </CardContent>
            </Card>
            <Card>
              <CardHeader className="pb-2"><CardTitle className="flex items-center gap-2 text-sm"><Cpu className="h-4 w-4" /> Concurrency</CardTitle></CardHeader>
              <CardContent>
                <p className="text-2xl font-bold">{status?.max_concurrency ?? "—"}</p>
                <p className="text-xs text-muted-foreground">max simultaneous generations / worker</p>
              </CardContent>
            </Card>
            <Card>
              <CardHeader className="pb-2"><CardTitle className="flex items-center gap-2 text-sm"><HardDrive className="h-4 w-4" /> Loaded VRAM</CardTitle></CardHeader>
              <CardContent>
                <p className="text-2xl font-bold">{gb(status?.loaded_vram_bytes)}</p>
                <p className="text-xs text-muted-foreground">{status?.loaded_models.length ?? 0} model(s) resident</p>
              </CardContent>
            </Card>
          </div>

          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="flex items-center gap-2 text-sm">
                <Mic className="h-4 w-4" /> Fish Speech S2 · Voice cloning
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="flex items-center gap-2">
                <span className={`h-2.5 w-2.5 rounded-full ${fish?.reachable ? "bg-emerald-500" : "bg-destructive"}`} />
                <span className="font-medium">{fish?.reachable ? "Server online" : "Server offline"}</span>
                <span className="truncate text-xs text-muted-foreground">{fish?.url}</span>
              </div>

              <div className="flex flex-wrap items-center gap-3">
                <span className="text-sm text-muted-foreground">Model quant</span>
                <Select value={fish?.quant} onValueChange={handleQuant} disabled={!fish || setQuant.isPending}>
                  <SelectTrigger className="w-48">
                    <SelectValue placeholder="Select quant" />
                  </SelectTrigger>
                  <SelectContent>
                    {(fish?.quants ?? []).map((q) => (
                      <SelectItem key={q} value={q}>
                        {q}
                        {q === fish?.default_quant ? " (default)" : ""}
                        {fish?.present.includes(q) ? " · downloaded" : ""}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                {setQuant.isPending && <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />}
              </div>

              <div className="flex flex-wrap gap-1.5">
                {(fish?.quants ?? []).map((q) => (
                  <Badge
                    key={q}
                    variant={fish?.present.includes(q) ? "secondary" : "outline"}
                    className={q === fish?.quant ? "ring-1 ring-primary" : undefined}
                  >
                    {q}
                    {fish?.present.includes(q) ? " ✓" : ""}
                  </Badge>
                ))}
              </div>

              <p className="text-xs text-muted-foreground">
                {fish?.present.length
                  ? `${fish.present.length} of ${fish.quants.length} quants downloaded`
                  : "No GGUF quants found in the model folder"}
                {fish?.model_dir ? ` · ${fish.model_dir}` : ""}
              </p>
            </CardContent>
          </Card>

          <Card>
            <CardHeader className="pb-2"><CardTitle className="text-sm">GPUs</CardTitle></CardHeader>
            <CardContent>
              {!status?.gpus.length ? (
                <p className="text-sm text-muted-foreground">No NVIDIA GPU detected (CPU mode, or nvidia-smi unavailable).</p>
              ) : (
                <div className="space-y-4">
                  {status.gpus.map((g) => (
                    <div key={g.index} className="space-y-1">
                      <div className="flex items-center justify-between text-sm">
                        <span className="font-medium">GPU {g.index} · {g.name}</span>
                        <span className="text-muted-foreground">{g.utilization_pct}% · {g.temperature_c}°C</span>
                      </div>
                      <Progress value={(g.memory_used_mb / Math.max(1, g.memory_total_mb)) * 100} />
                      <p className="text-xs text-muted-foreground">
                        {(g.memory_used_mb / 1024).toFixed(1)} / {(g.memory_total_mb / 1024).toFixed(1)} GB VRAM
                      </p>
                    </div>
                  ))}
                </div>
              )}
            </CardContent>
          </Card>

          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="flex items-center gap-2 text-sm">
                <Activity className="h-4 w-4" /> Running processes (VRAM)
              </CardTitle>
            </CardHeader>
            <CardContent>
              {!status?.gpu_processes?.length ? (
                <p className="text-sm text-muted-foreground">
                  None of Open-Clip&apos;s services are running right now.
                </p>
              ) : (
                <div className="space-y-2">
                  <p className="text-xs text-muted-foreground">
                    Open-Clip&apos;s own services — the API server, the background worker (which runs
                    Whisper transcription and diarization in-process), the web frontend, and the model
                    servers it drives (Ollama for LLM/embeddings, Fish Speech for voice) — plus any
                    helper program it&apos;s running right now (ffmpeg, yt-dlp and other subprocesses,
                    which come and go with each job), with the GPU memory each is using (a dash means
                    CPU only). Toggle one{" "}
                    <span className="font-medium">off to pause it</span> (freezes the whole service so it
                    stops working) and back <span className="font-medium">on to resume</span> — or use the
                    trash button to terminate it. The API server runs this page, so it stays locked.
                  </p>
                  {status.gpu_processes.map((p) => {
                    const toggling = suspend.isPending && suspend.variables?.pid === p.pid;
                    const killing = terminate.isPending && terminate.variables === p.pid;
                    const busy = toggling || killing;
                    return (
                      <div
                        key={p.pid}
                        className={`flex items-center justify-between gap-3 rounded-md border px-3 py-2 text-sm ${
                          p.suspended ? "border-amber-500/40 bg-amber-500/5" : ""
                        }`}
                      >
                        <div className="min-w-0">
                          <div className="flex items-center gap-2">
                            <span className="font-medium">{p.name}</span>
                            <Badge variant="secondary">PID {p.pid}</Badge>
                            {p.suspended && (
                              <Badge className="bg-amber-500/15 text-amber-600 dark:text-amber-400">Paused</Badge>
                            )}
                            {!p.can_control && (
                              <Badge variant="outline" className="text-muted-foreground">Protected</Badge>
                            )}
                          </div>
                          <p className="truncate text-xs text-muted-foreground" title={p.command || undefined}>
                            {p.command || "—"}
                          </p>
                        </div>
                        <div className="flex shrink-0 items-center gap-3">
                          <span className="w-16 text-right font-mono text-xs text-muted-foreground">
                            {formatBytes(p.used_vram_bytes)}
                          </span>
                          {busy ? (
                            <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
                          ) : (
                            <Switch
                              checked={!p.suspended}
                              disabled={!p.can_control || suspend.isPending}
                              onCheckedChange={(on) => handleSuspendToggle(p.pid, p.name, on)}
                              aria-label={`${p.suspended ? "Resume" : "Pause"} ${p.name}`}
                            />
                          )}
                          <Button
                            variant="ghost"
                            size="icon"
                            className="h-7 w-7 shrink-0 text-destructive hover:text-destructive"
                            disabled={!p.can_control || busy}
                            onClick={() => handleKill(p.pid, p.name)}
                            aria-label={`Terminate ${p.name}`}
                          >
                            <Trash2 className="h-4 w-4" />
                          </Button>
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
            </CardContent>
          </Card>

          <Card>
            <CardHeader className="pb-2"><CardTitle className="text-sm">Loaded models (live)</CardTitle></CardHeader>
            <CardContent>
              {!status?.loaded_models.length ? (
                <p className="text-sm text-muted-foreground">No models currently resident.</p>
              ) : (
                <div className="flex flex-wrap gap-2">
                  {status.loaded_models.map((m, i) => (
                    <Badge key={i} variant="secondary">{m.name} · {gb(m.size_vram)} VRAM</Badge>
                  ))}
                </div>
              )}
            </CardContent>
          </Card>

          <Card>
            <CardHeader className="pb-2"><CardTitle className="text-sm">Installed models</CardTitle></CardHeader>
            <CardContent>
              {models.length === 0 ? (
                <p className="text-sm text-muted-foreground">No models installed — pull some under Settings → AI models.</p>
              ) : (
                <div className="space-y-2">
                  {models.map((m) => (
                    <div key={m.name} className="flex items-center justify-between rounded-md border px-3 py-2 text-sm">
                      <span className="font-medium">{m.name}</span>
                      <span className="text-xs text-muted-foreground">
                        {m.parameter_size ?? ""} {m.family ? `· ${m.family}` : ""} · {gb(m.size)}
                      </span>
                    </div>
                  ))}
                </div>
              )}
            </CardContent>
          </Card>
        </>
      )}
    </div>
  );
}
