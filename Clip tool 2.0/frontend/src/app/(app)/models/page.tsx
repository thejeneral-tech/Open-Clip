"use client";

import { Cpu, HardDrive, Loader2, Server } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Progress } from "@/components/ui/progress";
import { useModels, useOllamaStatus } from "@/hooks/use-api";

function gb(bytes: number | null | undefined): string {
  if (!bytes) return "0 GB";
  return `${(bytes / 1024 ** 3).toFixed(1)} GB`;
}

export default function ModelsPage() {
  const { data: status, isLoading } = useOllamaStatus(true);
  const { data: models = [] } = useModels();

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
