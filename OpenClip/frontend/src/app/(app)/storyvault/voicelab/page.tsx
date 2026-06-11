"use client";

import { AlertTriangle, Download, Loader2, Mic, Play, Plus, Star, Trash2, X } from "lucide-react";
import { useRef, useState } from "react";
import { toast } from "sonner";
import {
  useSvCloneGenerate,
  useSvCloneStatus,
  useSvCloneTranscribe,
  useSvCloneUpload,
  useSvCreateVoicePreset,
  useSvDeleteVoicePreset,
  useSvSetDefaultVoicePreset,
  useSvVoicePresets,
  useSvVoices,
  useSvVoiceSample,
} from "@/hooks/use-api";
import type { SvVoicePreset } from "@/lib/types";

// Themed via the app's Odysseus tokens (bg-card / text-primary / border / …) so
// this page re-themes with the rest of Clip Tool 2.0 instead of being a fixed
// blue island.
const LABEL = "font-mono text-[11px] font-bold uppercase tracking-[0.16em] text-primary";
const CARD = "rounded-xl border bg-card text-card-foreground shadow-sm p-5";
const TEXTAREA =
  "w-full resize-y rounded-lg border bg-background px-3.5 py-3 font-mono text-[13px] leading-relaxed text-foreground placeholder:text-muted-foreground outline-none transition focus:border-primary focus:ring-2 focus:ring-ring/40";

const ACCEPT = ".wav,.mp3,.mp4,.flac,.m4a,.ogg,audio/*";

interface CloneOutput {
  media_url: string;
  duration: number;
  bytes: number;
}

function fmtBytes(n: number): string {
  if (!n) return "0 B";
  const u = ["B", "KB", "MB", "GB"];
  const i = Math.floor(Math.log(n) / Math.log(1024));
  return `${(n / 1024 ** i).toFixed(i ? 1 : 0)} ${u[i]}`;
}

function StepBadge({ n }: { n: number }) {
  return (
    <span className="flex h-6 w-6 items-center justify-center rounded-full bg-primary text-[12px] font-bold text-primary-foreground">
      {n}
    </span>
  );
}

// --------------------------------------------------------------- saved presets
const PRESET_BTN =
  "inline-flex items-center gap-1.5 rounded-md border bg-background px-3 py-1.5 font-mono text-[11px] font-bold text-primary transition hover:bg-accent disabled:opacity-50";

function isClonedVoice(preset: SvVoicePreset): boolean {
  // Prefer the explicit engine; fall back to sniffing the voice string for
  // older rows created before the engine column existed.
  if (preset.engine) return preset.engine !== "sapi";
  return /clone|fish/i.test(preset.voice);
}

function PresetBadge({ preset }: { preset: SvVoicePreset }) {
  let cls: string;
  let label: string;
  if (preset.is_default) {
    cls = "border-emerald-500/40 bg-emerald-500/10 text-emerald-400";
    label = "Default ★";
  } else if (isClonedVoice(preset)) {
    cls = "border-primary/40 bg-primary/10 text-primary";
    label = "Cloned";
  } else {
    cls = "border-border bg-background text-muted-foreground";
    label = "SAPI";
  }
  return (
    <span
      className={`shrink-0 rounded-full border px-2.5 py-0.5 font-mono text-[10px] font-bold uppercase tracking-[0.12em] ${cls}`}
    >
      {label}
    </span>
  );
}

function PresetCard({
  preset,
  previewing,
  busy,
  onPreview,
  onSetDefault,
  onDelete,
}: {
  preset: SvVoicePreset;
  previewing: boolean;
  busy: boolean;
  onPreview: () => void;
  onSetDefault: () => void;
  onDelete: () => void;
}) {
  return (
    <div className="rounded-xl border bg-card p-4 shadow-sm">
      <div className="mb-1.5 flex items-start justify-between gap-2">
        <div className="flex min-w-0 items-center gap-1.5 font-mono text-[12px] font-bold uppercase tracking-[0.08em] text-foreground">
          <span aria-hidden>🎙️</span>
          <span className="truncate">{preset.name}</span>
        </div>
        <PresetBadge preset={preset} />
      </div>
      <div className="mb-3 font-mono text-[11px] text-muted-foreground">
        {preset.voice || preset.engine} · speed {preset.speed}
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <button
          type="button"
          onClick={onPreview}
          disabled={previewing}
          className="inline-flex items-center gap-1.5 rounded-md bg-primary px-3 py-1.5 font-mono text-[11px] font-bold text-primary-foreground transition hover:bg-primary/90 disabled:opacity-60"
        >
          {previewing ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Play className="h-3 w-3 fill-current" />}
          Preview
        </button>
        <button
          type="button"
          onClick={onSetDefault}
          disabled={preset.is_default || busy}
          title={preset.is_default ? "This is the default voice" : "Set as default"}
          className={PRESET_BTN}
        >
          <Star className={`h-3.5 w-3.5 ${preset.is_default ? "fill-current" : ""}`} />
          {preset.is_default ? "" : "Set Default"}
        </button>
        <button
          type="button"
          onClick={onDelete}
          disabled={busy}
          title="Delete preset"
          className="inline-flex items-center justify-center rounded-md border border-[#5a2a2a] bg-background px-2.5 py-1.5 text-[#e06c75] transition hover:bg-[#241010] disabled:opacity-50"
        >
          <Trash2 className="h-3.5 w-3.5" />
        </button>
      </div>
    </div>
  );
}

function SapiVoiceModal({ onClose }: { onClose: () => void }) {
  const { data: voices = [] } = useSvVoices();
  const createMut = useSvCreateVoicePreset();
  const [name, setName] = useState("");
  const [voice, setVoice] = useState("");
  const [speed, setSpeed] = useState("1");

  async function save() {
    const trimmed = name.trim();
    if (!trimmed) {
      toast.error("Give the preset a name");
      return;
    }
    if (!voice) {
      toast.error("Pick a voice");
      return;
    }
    try {
      await createMut.mutateAsync({ name: trimmed, voice, speed: Number(speed) });
      toast.success("Preset saved");
      onClose();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Could not save preset");
    }
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4"
      onClick={onClose}
    >
      <div
        className="w-full max-w-[420px] rounded-xl border bg-card p-5 shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mb-4 flex items-center justify-between">
          <span className={LABEL}>New SAPI Voice Preset</span>
          <button type="button" onClick={onClose} className="text-muted-foreground hover:text-foreground">
            <X className="h-4 w-4" />
          </button>
        </div>
        <div className="space-y-3">
          <div>
            <label className="mb-1 block font-mono text-[11px] text-muted-foreground">Name</label>
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="e.g. TikTok Adam Voice"
              className="w-full rounded-lg border bg-background px-3 py-2 font-mono text-[13px] text-foreground outline-none focus:border-primary focus:ring-2 focus:ring-ring/40"
            />
          </div>
          <div>
            <label className="mb-1 block font-mono text-[11px] text-muted-foreground">Voice</label>
            <select
              value={voice}
              onChange={(e) => setVoice(e.target.value)}
              className="w-full rounded-lg border bg-background px-3 py-2 font-mono text-[13px] text-foreground outline-none focus:border-primary focus:ring-2 focus:ring-ring/40"
            >
              <option value="" disabled>
                {voices.length ? "Choose a system voice…" : "No SAPI voices found"}
              </option>
              {voices.map((v) => (
                <option key={v.name} value={v.name}>
                  {v.name}
                  {v.gender ? ` · ${v.gender}` : ""}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label className="mb-1 block font-mono text-[11px] text-muted-foreground">Speed</label>
            <select
              value={speed}
              onChange={(e) => setSpeed(e.target.value)}
              className="w-full rounded-lg border bg-background px-3 py-2 font-mono text-[13px] text-foreground outline-none focus:border-primary focus:ring-2 focus:ring-ring/40"
            >
              {["0.7", "0.8", "0.9", "1", "1.1", "1.2", "1.3", "1.4"].map((s) => (
                <option key={s} value={s}>
                  {s}×
                </option>
              ))}
            </select>
          </div>
        </div>
        <div className="mt-5 flex justify-end gap-2">
          <button type="button" onClick={onClose} className={PRESET_BTN}>
            Cancel
          </button>
          <button
            type="button"
            onClick={() => void save()}
            disabled={createMut.isPending}
            className="inline-flex items-center gap-2 rounded-md bg-primary px-4 py-2 font-mono text-[12px] font-bold text-primary-foreground transition hover:bg-primary/90 disabled:opacity-60"
          >
            {createMut.isPending ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Plus className="h-3.5 w-3.5" />}
            Save preset
          </button>
        </div>
      </div>
    </div>
  );
}

function SavedPresets() {
  const { data: presets = [], isLoading } = useSvVoicePresets();
  const sampleMut = useSvVoiceSample();
  const setDefaultMut = useSvSetDefaultVoicePreset();
  const deleteMut = useSvDeleteVoicePreset();
  const [previewingId, setPreviewingId] = useState<number | null>(null);
  const [showModal, setShowModal] = useState(false);
  const audioRef = useRef<HTMLAudioElement>(null);

  async function preview(p: SvVoicePreset) {
    // Imported/cloned presets ship a saved audition clip — play it directly
    // (they have no SAPI voice to re-synthesize from). SAPI presets synthesize
    // a fresh sample on demand (cached server-side by voice+speed+text).
    if (p.preview_url) {
      if (audioRef.current) {
        audioRef.current.src = p.preview_url;
        try {
          await audioRef.current.play();
        } catch (e) {
          toast.error(e instanceof Error ? e.message : "Preview failed");
        }
      }
      return;
    }
    setPreviewingId(p.id);
    try {
      const r = await sampleMut.mutateAsync({ voice: p.voice, speed: p.speed });
      if (audioRef.current && r.media_url) {
        audioRef.current.src = r.media_url;
        await audioRef.current.play();
      }
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Preview failed");
    } finally {
      setPreviewingId(null);
    }
  }

  async function setDefault(p: SvVoicePreset) {
    try {
      await setDefaultMut.mutateAsync(p.id);
      toast.success(`“${p.name}” is now the default voice`);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Could not set default");
    }
  }

  async function remove(p: SvVoicePreset) {
    if (!window.confirm(`Delete preset “${p.name}”?`)) return;
    try {
      await deleteMut.mutateAsync(p.id);
      toast.success("Preset deleted");
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Could not delete preset");
    }
  }

  const busy = setDefaultMut.isPending || deleteMut.isPending;

  return (
    <div className={CARD}>
      <div className="mb-4 flex items-center justify-between gap-3">
        <span className={LABEL}>📋 Saved Presets</span>
        <button type="button" onClick={() => setShowModal(true)} className={PRESET_BTN}>
          <Plus className="h-3.5 w-3.5" />
          SAPI voice
        </button>
      </div>

      {isLoading ? (
        <div className="flex items-center gap-2 font-mono text-[12px] text-muted-foreground">
          <Loader2 className="h-4 w-4 animate-spin text-primary" />
          Loading presets…
        </div>
      ) : presets.length === 0 ? (
        <div className="font-mono text-[12px] text-muted-foreground">
          No saved presets yet — add a SAPI voice, or clone one below.
        </div>
      ) : (
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {presets.map((p) => (
            <PresetCard
              key={p.id}
              preset={p}
              previewing={previewingId === p.id}
              busy={busy}
              onPreview={() => void preview(p)}
              onSetDefault={() => void setDefault(p)}
              onDelete={() => void remove(p)}
            />
          ))}
        </div>
      )}

      {/* eslint-disable-next-line jsx-a11y/media-has-caption */}
      <audio ref={audioRef} className="hidden" />
      {showModal && <SapiVoiceModal onClose={() => setShowModal(false)} />}
    </div>
  );
}

export default function VoiceLabPage() {
  const { data: status } = useSvCloneStatus(true);
  const uploadMut = useSvCloneUpload();
  const transcribeMut = useSvCloneTranscribe();
  const generateMut = useSvCloneGenerate();

  const [fileName, setFileName] = useState<string | null>(null);
  const [referenceId, setReferenceId] = useState<string | null>(null);
  const [transcript, setTranscript] = useState("");
  const [genText, setGenText] = useState("");
  const [output, setOutput] = useState<CloneOutput | null>(null);
  const [dragging, setDragging] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  async function handleFile(f: File | undefined) {
    if (!f) return;
    setOutput(null);
    setFileName(f.name);
    setReferenceId(null);
    try {
      const r = await uploadMut.mutateAsync(f);
      setReferenceId(r.reference_id);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Upload failed");
      setFileName(null);
    }
  }

  async function autoTranscribe() {
    if (!referenceId) {
      toast.error(uploadMut.isPending ? "Wait for the upload to finish" : "Choose an audio file first");
      return;
    }
    try {
      const r = await transcribeMut.mutateAsync(referenceId);
      if (r.ok && r.transcript) {
        setTranscript(r.transcript);
        toast.success(`Transcribed ~${r.transcript.split(/\s+/).filter(Boolean).length} words`);
      } else {
        toast(r.note || "Transcription unavailable — type the transcript by hand.");
      }
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Transcription failed");
    }
  }

  async function generate() {
    if (!genText.trim()) {
      toast.error("Enter the text you want spoken");
      return;
    }
    if (referenceId && !transcript.trim()) {
      toast.error("Add the transcript of your sample (or click Auto-transcribe) — the engine needs the words spoken in the clip.");
      return;
    }
    setOutput(null);
    try {
      const r = await generateMut.mutateAsync({
        text: genText,
        reference_id: referenceId ?? undefined,
        prompt_text: transcript,
      });
      setOutput(r);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Generation failed");
    }
  }

  return (
    <div className="mx-auto max-w-[860px] space-y-5 font-mono">
      <div>
        <h1 className="font-mono text-xl font-bold tracking-tight text-foreground">Voice Lab</h1>
        <p className="font-mono text-[12px] text-muted-foreground">
          Clone a voice from a short sample, then generate speech in that voice.
        </p>
      </div>

      {status && !status.reachable && (
        <div className="flex items-center gap-2 rounded-lg border border-[#5a3a2a] bg-[#241410] px-4 py-2.5 font-mono text-[12px] text-[#e0a878]">
          <AlertTriangle className="h-4 w-4 shrink-0" />
          Fish Speech server offline at {status.url} — start it in the StoryVault launcher (Fish Speech → Start
          Server) to generate audio.
        </div>
      )}

      {/* Saved presets */}
      <SavedPresets />

      {/* 1 — Upload Voice Sample */}
      <div className={CARD}>
        <div className="mb-4 flex items-center gap-2.5">
          <StepBadge n={1} />
          <span className={LABEL}>Upload Voice Sample</span>
        </div>

        <button
          type="button"
          onClick={() => inputRef.current?.click()}
          onDragOver={(e) => {
            e.preventDefault();
            setDragging(true);
          }}
          onDragLeave={() => setDragging(false)}
          onDrop={(e) => {
            e.preventDefault();
            setDragging(false);
            void handleFile(e.dataTransfer.files[0]);
          }}
          className={`flex w-full flex-col items-center justify-center gap-1.5 rounded-lg border-2 border-dashed px-6 py-9 text-center transition ${
            dragging ? "border-primary bg-accent" : "border-border bg-background hover:border-primary hover:bg-accent"
          }`}
        >
          {uploadMut.isPending ? (
            <Loader2 className="h-5 w-5 animate-spin text-primary" />
          ) : (
            <Mic className="h-5 w-5 text-primary" />
          )}
          <span className="text-[15px] font-bold text-primary">Drop an audio file here, or click to browse</span>
          <span className="text-[11px] text-muted-foreground">WAV · MP3 · MP4 · FLAC · 5–30 s of clear speech</span>
          <span className={`mt-1 text-[11px] ${referenceId ? "text-primary" : "text-muted-foreground"}`}>
            {uploadMut.isPending
              ? `Uploading & converting ${fileName ?? ""}…`
              : referenceId && fileName
                ? `✓ ${fileName}`
                : "No file selected"}
          </span>
        </button>
        <input
          ref={inputRef}
          type="file"
          accept={ACCEPT}
          className="hidden"
          onChange={(e) => void handleFile(e.target.files?.[0])}
        />

        <div className="mb-2 mt-5 flex items-center justify-between gap-3">
          <span className={LABEL}>Transcript — the words spoken in your sample (required to clone)</span>
          <button
            type="button"
            onClick={() => void autoTranscribe()}
            disabled={transcribeMut.isPending}
            className="inline-flex shrink-0 items-center gap-1.5 rounded-md border bg-background px-3 py-1.5 font-mono text-[11px] font-bold text-primary transition hover:bg-accent disabled:opacity-50"
          >
            {transcribeMut.isPending ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <span>✨</span>}
            Auto-transcribe
          </button>
        </div>
        <textarea
          className={TEXTAREA}
          rows={3}
          value={transcript}
          onChange={(e) => setTranscript(e.target.value)}
          placeholder="Type the exact words spoken in your uploaded clip. Required to clone — the engine matches your voice against these words."
        />
      </div>

      {/* 2 — Enter Text */}
      <div className={CARD}>
        <div className="mb-4 flex items-center gap-2.5">
          <StepBadge n={2} />
          <span className={LABEL}>Enter Text</span>
        </div>
        <textarea
          className={TEXTAREA}
          rows={4}
          value={genText}
          onChange={(e) => setGenText(e.target.value)}
          placeholder="Type the words you want spoken in the uploaded voice…  Aim for 20+ characters for best results."
        />
        <div className="mt-2 text-right font-mono text-[11px] text-muted-foreground">{genText.length} characters</div>
        <div className="mt-3">
          <button
            type="button"
            onClick={() => void generate()}
            disabled={generateMut.isPending}
            className="inline-flex items-center gap-2 rounded-md bg-primary px-5 py-2.5 font-mono text-[13px] font-bold text-primary-foreground shadow transition hover:bg-primary/90 disabled:opacity-60"
          >
            {generateMut.isPending ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <Play className="h-3.5 w-3.5 fill-current" />
            )}
            Generate Speech
          </button>
        </div>
      </div>

      {/* 3 — Output */}
      <div className={CARD}>
        <div className="mb-4 flex items-center gap-2.5">
          <StepBadge n={3} />
          <span className={LABEL}>Output</span>
        </div>
        {generateMut.isPending ? (
          <div className="flex items-center gap-2 font-mono text-[12px] text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin text-primary" />
            Generating… (first run can take ~30 s on CPU)
          </div>
        ) : output ? (
          <div className="space-y-3">
            {/* eslint-disable-next-line jsx-a11y/media-has-caption */}
            <audio key={output.media_url} src={output.media_url} controls autoPlay className="w-full" />
            <div className="flex flex-wrap items-center gap-3 font-mono text-[11px] text-muted-foreground">
              <span>Time {output.duration.toFixed(1)} s</span>
              <span>Size {fmtBytes(output.bytes)}</span>
              <a
                href={output.media_url}
                download="voice.wav"
                className="inline-flex items-center gap-1.5 rounded-md border bg-background px-2.5 py-1 font-bold text-primary transition hover:bg-accent"
              >
                <Download className="h-3.5 w-3.5" />
                Download WAV
              </a>
            </div>
          </div>
        ) : (
          <div className="font-mono text-[12px] text-muted-foreground">Generated audio will appear here.</div>
        )}
      </div>
    </div>
  );
}
