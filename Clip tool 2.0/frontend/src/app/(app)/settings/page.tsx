"use client";

import { useQueryClient } from "@tanstack/react-query";
import { Download, Loader2, RefreshCw, Save, Trash2 } from "lucide-react";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Progress } from "@/components/ui/progress";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useModels, useSettings } from "@/hooks/use-api";
import { api } from "@/lib/api";
import type { UserSettings } from "@/lib/types";

const WHISPER_MODELS = ["tiny", "base", "small", "medium", "large-v3"];
const CAPTION_STYLES = ["hormozi", "modern_tiktok", "minimal", "gaming", "podcast"];

// Curated starting points (approx. on-disk sizes). Users can also type any
// Ollama model name. Nothing is installed unless the user chooses to.
const SUGGESTED_MODELS = [
  { name: "qwen3:8b", note: "≈5 GB · default & ranking" },
  { name: "qwen3:4b", note: "≈2.5 GB · lighter LLM" },
  { name: "llama3.2:3b", note: "≈2 GB · fast LLM" },
  { name: "llava:7b", note: "≈4.7 GB · vision" },
  { name: "gemma3:4b", note: "≈3.3 GB · vision" },
];

const humanSize = (n?: number | null) => (n ? `${(n / 1024 ** 3).toFixed(1)} GB` : "");

export default function SettingsPage() {
  const qc = useQueryClient();
  const { data: settings, isLoading } = useSettings();
  const { data: models = [], refetch, isFetching } = useModels();
  const [form, setForm] = useState<Partial<UserSettings>>({});
  const [saving, setSaving] = useState(false);

  const [pulling, setPulling] = useState<string | null>(null);
  const [pullPct, setPullPct] = useState(0);
  const [pullStatus, setPullStatus] = useState("");
  const [customModel, setCustomModel] = useState("");
  const [removing, setRemoving] = useState<string | null>(null);

  useEffect(() => {
    if (settings) setForm(settings);
  }, [settings]);

  const installModel = async (name: string) => {
    const trimmed = name.trim();
    if (!trimmed || pulling) return;
    setPulling(trimmed);
    setPullPct(0);
    setPullStatus("starting…");
    try {
      await api.pullModel(trimmed, (e) => {
        if (e.error) throw new Error(e.error);
        if (e.status) setPullStatus(e.status);
        if (e.total && typeof e.completed === "number") {
          setPullPct(Math.min(100, Math.round((e.completed / e.total) * 100)));
        }
      });
      toast.success(`Installed ${trimmed}`);
      setCustomModel("");
      refetch();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Install failed");
    } finally {
      setPulling(null);
      setPullPct(0);
      setPullStatus("");
    }
  };

  const removeModel = async (name: string) => {
    setRemoving(name);
    try {
      await api.deleteModel(name);
      toast.success(`Removed ${name}`);
      refetch();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Remove failed");
    } finally {
      setRemoving(null);
    }
  };

  const set = <K extends keyof UserSettings>(key: K, value: UserSettings[K]) =>
    setForm((f) => ({ ...f, [key]: value }));

  const save = async () => {
    setSaving(true);
    try {
      await api.updateSettings(form);
      qc.invalidateQueries({ queryKey: ["settings"] });
      toast.success("Settings saved");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Save failed");
    } finally {
      setSaving(false);
    }
  };

  if (isLoading || !form) {
    return (
      <div className="flex justify-center py-20">
        <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
      </div>
    );
  }

  const modelOptions = models.length
    ? models.map((m) => m.name)
    : [form.default_model, form.ranking_model, form.vision_model].filter(Boolean) as string[];

  const ModelSelect = ({ field, label }: { field: keyof UserSettings; label: string }) => (
    <div className="space-y-1.5">
      <Label>{label}</Label>
      <Select value={form[field] as string} onValueChange={(v) => set(field, v as never)}>
        <SelectTrigger><SelectValue placeholder="Select a model" /></SelectTrigger>
        <SelectContent>
          {Array.from(new Set(modelOptions)).map((m) => (
            <SelectItem key={m} value={m}>{m}</SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );

  return (
    <div className="mx-auto max-w-3xl space-y-6">
      <div>
        <h1 className="text-2xl font-bold tracking-tight">Settings</h1>
        <p className="text-muted-foreground">Choose your local models and clip defaults.</p>
      </div>

      <Card>
        <CardHeader className="flex flex-row items-center justify-between">
          <div>
            <CardTitle>AI models (Ollama)</CardTitle>
            <CardDescription>
              {models.length
                ? `${models.length} model${models.length === 1 ? "" : "s"} installed`
                : "No models installed yet — install one below"}
            </CardDescription>
          </div>
          <Button variant="outline" size="sm" onClick={() => refetch()} disabled={isFetching}>
            <RefreshCw className={`h-4 w-4 ${isFetching ? "animate-spin" : ""}`} /> Refresh
          </Button>
        </CardHeader>
        <CardContent className="space-y-5">
          {/* Which installed model each role uses */}
          <div className="grid gap-4 sm:grid-cols-2">
            <ModelSelect field="default_model" label="Default model (detection & content)" />
            <ModelSelect field="ranking_model" label="Ranking model" />
            <ModelSelect field="vision_model" label="Vision model" />
            <div className="space-y-1.5">
              <Label>Whisper model</Label>
              <Select value={form.whisper_model} onValueChange={(v) => set("whisper_model", v)}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  {WHISPER_MODELS.map((m) => (
                    <SelectItem key={m} value={m}>{m}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <p className="text-xs text-muted-foreground">Downloaded automatically on first use.</p>
            </div>
          </div>

          {/* Installed models, with remove buttons */}
          {models.length > 0 && (
            <div className="space-y-2">
              <Label>Installed models</Label>
              <div className="divide-y rounded-md border">
                {models.map((m) => (
                  <div key={m.name} className="flex items-center justify-between px-3 py-2 text-sm">
                    <div className="min-w-0 truncate">
                      <span className="font-medium">{m.name}</span>
                      {humanSize(m.size) && (
                        <span className="ml-2 text-muted-foreground">{humanSize(m.size)}</span>
                      )}
                    </div>
                    <Button
                      variant="ghost"
                      size="sm"
                      className="text-muted-foreground hover:text-destructive"
                      disabled={removing === m.name || pulling !== null}
                      onClick={() => removeModel(m.name)}
                      title={`Remove ${m.name}`}
                    >
                      {removing === m.name ? (
                        <Loader2 className="h-4 w-4 animate-spin" />
                      ) : (
                        <Trash2 className="h-4 w-4" />
                      )}
                    </Button>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Install a model */}
          <div className="space-y-3">
            <div>
              <Label>Install a model</Label>
              <p className="text-xs text-muted-foreground">
                Models download from Ollama on demand — pick what fits your disk. Nothing is installed automatically.
              </p>
            </div>

            {pulling ? (
              <div className="space-y-2 rounded-md border p-3">
                <div className="flex items-center justify-between text-sm">
                  <span className="font-medium">Installing {pulling}…</span>
                  <span className="text-muted-foreground">{pullPct}%</span>
                </div>
                <Progress value={pullPct} />
                <p className="truncate text-xs text-muted-foreground">{pullStatus}</p>
              </div>
            ) : (
              <>
                <div className="flex flex-wrap gap-2">
                  {SUGGESTED_MODELS.map((s) => {
                    const installed = models.some((m) => m.name === s.name);
                    return (
                      <Button
                        key={s.name}
                        type="button"
                        variant="outline"
                        size="sm"
                        disabled={installed}
                        onClick={() => installModel(s.name)}
                        title={s.note}
                      >
                        {!installed && <Download className="h-3.5 w-3.5" />}
                        {s.name}
                        <span className="ml-1 text-xs text-muted-foreground">
                          {installed ? "installed" : s.note}
                        </span>
                      </Button>
                    );
                  })}
                </div>
                <div className="flex gap-2">
                  <Input
                    placeholder="or type any Ollama model, e.g. mistral:7b"
                    value={customModel}
                    onChange={(e) => setCustomModel(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") {
                        e.preventDefault();
                        installModel(customModel);
                      }
                    }}
                  />
                  <Button type="button" onClick={() => installModel(customModel)} disabled={!customModel.trim()}>
                    <Download className="h-4 w-4" /> Install
                  </Button>
                </div>
              </>
            )}
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Clip defaults</CardTitle>
          <CardDescription>Applied to new processing jobs.</CardDescription>
        </CardHeader>
        <CardContent className="grid gap-4 sm:grid-cols-2">
          <div className="space-y-1.5">
            <Label>Target clip count</Label>
            <Input type="number" min={1} max={50} value={form.target_clip_count ?? 12} onChange={(e) => set("target_clip_count", Number(e.target.value))} />
          </div>
          <div className="space-y-1.5">
            <Label>Caption style</Label>
            <Select value={form.default_caption_style} onValueChange={(v) => set("default_caption_style", v as never)}>
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>
                {CAPTION_STYLES.map((s) => (
                  <SelectItem key={s} value={s}>{s}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1.5">
            <Label>Min clip length (s)</Label>
            <Input type="number" value={form.min_clip_seconds ?? 8} onChange={(e) => set("min_clip_seconds", Number(e.target.value))} />
          </div>
          <div className="space-y-1.5">
            <Label>Max clip length (s)</Label>
            <Input type="number" value={form.max_clip_seconds ?? 90} onChange={(e) => set("max_clip_seconds", Number(e.target.value))} />
          </div>
          <div className="space-y-1.5">
            <Label>Default aspect ratio</Label>
            <Select value={form.default_aspect_ratio} onValueChange={(v) => set("default_aspect_ratio", v as never)}>
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>
                {(["9:16", "1:1", "4:5", "16:9"]).map((a) => (
                  <SelectItem key={a} value={a}>{a}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1.5">
            <Label>Default export resolution</Label>
            <Select value={form.default_export_resolution} onValueChange={(v) => set("default_export_resolution", v as never)}>
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>
                {(["720p", "1080p", "1440p", "4k"]).map((r) => (
                  <SelectItem key={r} value={r}>{r}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </CardContent>
      </Card>

      <Button onClick={save} disabled={saving}>
        {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />}
        Save settings
      </Button>
    </div>
  );
}
