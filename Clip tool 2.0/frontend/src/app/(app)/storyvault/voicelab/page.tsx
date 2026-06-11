"use client";

import { Loader2, Mic, Play, Save, Star, Trash2 } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Slider } from "@/components/ui/slider";
import { Textarea } from "@/components/ui/textarea";
import {
  useSvCreateVoicePreset,
  useSvDeleteVoicePreset,
  useSvSetDefaultVoicePreset,
  useSvVoicePresets,
  useSvVoices,
  useSvVoiceSample,
} from "@/hooks/use-api";

const DEFAULT_TEXT = "Hi! This is a Story Vault voice test. Stories sound better out loud.";

export default function VoiceLabPage() {
  const { data: voices = [], isLoading: voicesLoading } = useSvVoices();
  const { data: presets = [], isLoading: presetsLoading } = useSvVoicePresets();
  const createPreset = useSvCreateVoicePreset();
  const setDefault = useSvSetDefaultVoicePreset();
  const deletePreset = useSvDeleteVoicePreset();
  const sample = useSvVoiceSample();

  const [text, setText] = useState(DEFAULT_TEXT);
  const [voice, setVoice] = useState<string>("");
  const [speed, setSpeed] = useState(1.0);
  const [sampleUrl, setSampleUrl] = useState<string | null>(null);
  const [presetName, setPresetName] = useState("");

  const selectedVoice = voice || voices[0]?.name || "";

  const onSample = async () => {
    if (!selectedVoice) return;
    try {
      const res = await sample.mutateAsync({ text, voice: selectedVoice, speed });
      // Cache-bust so the <audio> element reloads even when the URL repeats.
      setSampleUrl(`${res.media_url}?t=${Date.now()}`);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Synthesis failed");
    }
  };

  const onSavePreset = async () => {
    if (!selectedVoice) return;
    const name = presetName.trim() || `${selectedVoice.replace("Microsoft ", "").replace(" Desktop", "")} ×${speed.toFixed(2)}`;
    try {
      await createPreset.mutateAsync({ name, voice: selectedVoice, speed });
      toast.success(`Preset "${name}" saved`);
      setPresetName("");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not save preset");
    }
  };

  return (
    <div className="mx-auto max-w-6xl space-y-6">
      <div>
        <h1 className="text-2xl font-bold tracking-tight">Voice Lab</h1>
        <p className="text-muted-foreground">
          Audition narration voices, tune the pace, and save presets — the default preset is used
          when a video&apos;s voice is set to Auto.
        </p>
      </div>

      <div className="grid gap-6 lg:grid-cols-[1fr_380px]">
        {/* Test bench */}
        <Card>
          <CardHeader>
            <CardTitle>Test bench</CardTitle>
            <CardDescription>Type a line, pick a voice, and listen.</CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="sample-text">Sample text</Label>
              <Textarea
                id="sample-text"
                rows={3}
                maxLength={400}
                value={text}
                onChange={(e) => setText(e.target.value)}
              />
            </div>
            <div className="grid gap-4 sm:grid-cols-2">
              <div className="space-y-2">
                <Label>Voice</Label>
                <Select value={selectedVoice} onValueChange={setVoice}>
                  <SelectTrigger>
                    <SelectValue placeholder={voicesLoading ? "Loading voices…" : "Pick a voice"} />
                  </SelectTrigger>
                  <SelectContent>
                    {voices.map((v) => (
                      <SelectItem key={v.name} value={v.name}>
                        {v.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-2">
                <Label>Speed ×{speed.toFixed(2)}</Label>
                <Slider
                  min={0.7}
                  max={1.4}
                  step={0.05}
                  value={[speed]}
                  onValueChange={([v]) => setSpeed(v)}
                />
              </div>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <Button onClick={onSample} disabled={!selectedVoice || sample.isPending}>
                {sample.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Play className="h-4 w-4" />}
                Generate sample
              </Button>
              {sampleUrl && (
                // eslint-disable-next-line jsx-a11y/media-has-caption
                <audio key={sampleUrl} src={sampleUrl} controls autoPlay className="h-9 min-w-0 flex-1" />
              )}
            </div>
            <div className="flex flex-wrap items-end gap-2 border-t border-border pt-4">
              <div className="min-w-48 flex-1 space-y-2">
                <Label htmlFor="preset-name">Save current voice + speed as preset</Label>
                <Input
                  id="preset-name"
                  placeholder="Preset name (optional)"
                  value={presetName}
                  onChange={(e) => setPresetName(e.target.value)}
                />
              </div>
              <Button variant="outline" onClick={onSavePreset} disabled={!selectedVoice || createPreset.isPending}>
                {createPreset.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />}
                Save preset
              </Button>
            </div>
          </CardContent>
        </Card>

        {/* Presets + installed voices */}
        <div className="space-y-6">
          <Card>
            <CardHeader>
              <CardTitle>Voice presets</CardTitle>
              <CardDescription>The ★ preset narrates videos created with voice = Auto.</CardDescription>
            </CardHeader>
            <CardContent className="space-y-2">
              {presetsLoading ? (
                <div className="flex justify-center py-6">
                  <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
                </div>
              ) : presets.length === 0 ? (
                <p className="py-4 text-center text-sm text-muted-foreground">
                  No presets yet — save one from the test bench.
                </p>
              ) : (
                presets.map((p) => (
                  <div key={p.id} className="flex items-center gap-2 rounded-md border border-border p-2.5">
                    <button
                      type="button"
                      title={p.is_default ? "Default preset" : "Make default"}
                      onClick={async () => {
                        if (p.is_default) return;
                        try {
                          await setDefault.mutateAsync(p.id);
                          toast.success(`"${p.name}" is now the default voice`);
                        } catch (err) {
                          toast.error(err instanceof Error ? err.message : "Failed");
                        }
                      }}
                      className="shrink-0"
                    >
                      <Star
                        className={
                          p.is_default
                            ? "h-4 w-4 fill-yellow-400 text-yellow-400"
                            : "h-4 w-4 text-muted-foreground hover:text-yellow-400"
                        }
                      />
                    </button>
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-sm font-medium">{p.name}</p>
                      <p className="truncate text-xs text-muted-foreground">
                        {p.voice} · ×{p.speed.toFixed(2)}
                      </p>
                    </div>
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-7 w-7 shrink-0"
                      title="Listen"
                      onClick={async () => {
                        try {
                          const res = await sample.mutateAsync({ voice: p.voice, speed: p.speed });
                          setSampleUrl(`${res.media_url}?t=${Date.now()}`);
                        } catch (err) {
                          toast.error(err instanceof Error ? err.message : "Synthesis failed");
                        }
                      }}
                    >
                      <Play className="h-4 w-4" />
                    </Button>
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-7 w-7 shrink-0 text-muted-foreground hover:text-destructive"
                      title="Delete"
                      onClick={async () => {
                        if (!confirm(`Delete preset "${p.name}"?`)) return;
                        try {
                          await deletePreset.mutateAsync(p.id);
                          toast.success("Preset deleted");
                        } catch (err) {
                          toast.error(err instanceof Error ? err.message : "Failed");
                        }
                      }}
                    >
                      <Trash2 className="h-4 w-4" />
                    </Button>
                  </div>
                ))
              )}
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>Installed voices</CardTitle>
              <CardDescription>Windows SAPI voices found on this machine.</CardDescription>
            </CardHeader>
            <CardContent className="space-y-2">
              {voicesLoading ? (
                <div className="flex justify-center py-6">
                  <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
                </div>
              ) : voices.length === 0 ? (
                <p className="py-4 text-center text-sm text-muted-foreground">
                  No SAPI voices found — narration needs Windows speech voices installed.
                </p>
              ) : (
                voices.map((v) => (
                  <div key={v.name} className="flex items-center gap-2 rounded-md border border-border p-2.5">
                    <Mic className="h-4 w-4 shrink-0 text-muted-foreground" />
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-sm font-medium">{v.name}</p>
                      <p className="text-xs text-muted-foreground">
                        {[v.culture, v.gender].filter(Boolean).join(" · ") || "—"}
                      </p>
                    </div>
                    {selectedVoice === v.name && <Badge variant="secondary">selected</Badge>}
                    <Button
                      variant="outline"
                      size="sm"
                      className="shrink-0"
                      onClick={() => setVoice(v.name)}
                    >
                      Use
                    </Button>
                  </div>
                ))
              )}
            </CardContent>
          </Card>
        </div>
      </div>
    </div>
  );
}
