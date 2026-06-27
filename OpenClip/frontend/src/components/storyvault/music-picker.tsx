"use client";

import { Loader2, Play, Save } from "lucide-react";
import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Slider } from "@/components/ui/slider";
import {
  useSvCreateMusicPreset,
  useSvMusic,
  useSvMusicPresets,
  useSvMusicPreview,
} from "@/hooks/use-api";

function truncate(text: string, max = 32): string {
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

export interface MusicSelection {
  musicId: number | null;
  volume: number;
}

/**
 * Controlled music control shared by the Studio and Project form: pick a saved
 * preset or a raw track, set the volume, hear a "Test" sample of how it sits
 * under the narration, and save the current track + volume as a named preset.
 * The canonical value is always (musicId, volume); a chosen preset just fills
 * those two in (and is remembered only for the dropdown's display).
 */
export function MusicPicker({
  musicId,
  volume,
  onChange,
}: {
  musicId: number | null;
  volume: number;
  onChange: (next: MusicSelection) => void;
}) {
  const { data: tracks = [] } = useSvMusic();
  const { data: presets = [] } = useSvMusicPresets();
  const preview = useSvMusicPreview();
  const createPreset = useSvCreateMusicPreset();

  const readyTracks = tracks.filter((t) => t.status === "completed");
  const audioRef = useRef<HTMLAudioElement | null>(null);

  // Which preset is showing as selected (display only — output is musicId/volume).
  const [presetSel, setPresetSel] = useState<number | null>(null);
  // Drop the preset label if the track/volume no longer matches it (e.g. the
  // value was changed from outside, like loading a project's saved settings).
  useEffect(() => {
    if (presetSel == null) return;
    const p = presets.find((pr) => pr.id === presetSel);
    if (!p || p.music_id !== musicId) setPresetSel(null);
  }, [musicId, presets, presetSel]);

  const selValue =
    presetSel != null ? `preset:${presetSel}` : musicId != null ? `track:${musicId}` : "none";

  const onSelect = (val: string) => {
    if (val === "none") {
      setPresetSel(null);
      onChange({ musicId: null, volume });
      return;
    }
    if (val.startsWith("preset:")) {
      const id = Number(val.slice(7));
      const p = presets.find((pr) => pr.id === id);
      setPresetSel(id);
      onChange({ musicId: p?.music_id ?? null, volume: p?.volume ?? volume });
      return;
    }
    setPresetSel(null);
    onChange({ musicId: Number(val.slice(6)), volume });
  };

  const onTest = async () => {
    if (musicId == null) return;
    try {
      const res = await preview.mutateAsync({ music_id: musicId, volume });
      const el = audioRef.current;
      if (el) {
        el.src = res.media_url;
        await el.play();
      }
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Couldn't render the preview");
    }
  };

  const onSavePreset = async () => {
    if (musicId == null) return;
    const name = prompt("Name this music preset")?.trim();
    if (!name) return;
    try {
      const p = await createPreset.mutateAsync({ name, music_id: musicId, volume });
      setPresetSel(p.id);
      toast.success(`Saved preset “${name}”`);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to save preset");
    }
  };

  return (
    <div className="space-y-2">
      <Label>Music</Label>
      <Select value={selValue} onValueChange={onSelect}>
        <SelectTrigger>
          <SelectValue placeholder="No music" />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="none">No music</SelectItem>
          {presets.length > 0 && (
            <SelectGroup>
              <SelectLabel>Saved presets</SelectLabel>
              {presets.map((p) => (
                <SelectItem key={`preset-${p.id}`} value={`preset:${p.id}`}>
                  {truncate(p.name)} · {Math.round(p.volume * 100)}%
                </SelectItem>
              ))}
            </SelectGroup>
          )}
          <SelectGroup>
            <SelectLabel>Tracks</SelectLabel>
            {readyTracks.map((t) => (
              <SelectItem key={`track-${t.id}`} value={`track:${t.id}`}>
                {truncate(t.original_filename || `Track #${t.id}`)}
              </SelectItem>
            ))}
          </SelectGroup>
        </SelectContent>
      </Select>

      {readyTracks.length === 0 && presets.length === 0 && (
        <p className="text-xs text-muted-foreground">
          No music yet — import tracks in the{" "}
          <Link href="/storyvault/library" className="underline">
            Library
          </Link>
          .
        </p>
      )}

      {musicId != null && (
        <div className="space-y-2 rounded-md border bg-muted/20 p-3">
          <div className="flex items-center justify-between">
            <Label className="text-xs">Volume</Label>
            <span className="text-xs text-muted-foreground">{Math.round(volume * 100)}%</span>
          </div>
          <Slider
            value={[volume]}
            min={0}
            max={1}
            step={0.01}
            onValueChange={([v]) => onChange({ musicId, volume: v })}
          />
          <div className="flex flex-wrap items-center gap-2">
            <Button type="button" variant="outline" size="sm" onClick={onTest} disabled={preview.isPending}>
              {preview.isPending ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <Play className="h-4 w-4" />
              )}
              Test
            </Button>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={onSavePreset}
              disabled={createPreset.isPending}
            >
              {createPreset.isPending ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <Save className="h-4 w-4" />
              )}
              Save as preset
            </Button>
          </div>
          <p className="text-xs text-muted-foreground">
            Test plays a sample of the music under narration at this level, looped to fill the video.
          </p>
          {/* eslint-disable-next-line jsx-a11y/media-has-caption */}
          <audio ref={audioRef} className="hidden" />
        </div>
      )}
    </div>
  );
}
