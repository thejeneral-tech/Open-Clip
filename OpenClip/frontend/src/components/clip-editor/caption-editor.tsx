"use client";

import { Loader2, Save, Wand2 } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { useUpdateClip } from "@/hooks/use-api";
import { api } from "@/lib/api";
import type { CaptionToken, Clip } from "@/lib/types";
import { cn, formatDuration } from "@/lib/utils";

export function CaptionEditor({ clip }: { clip: Clip }) {
  const update = useUpdateClip();
  const [tokens, setTokens] = useState<CaptionToken[]>(clip.captions ?? []);
  const [dirty, setDirty] = useState(false);

  const toggleEmphasis = (i: number) => {
    setTokens((prev) => prev.map((t, idx) => (idx === i ? { ...t, emphasis: !t.emphasis } : t)));
    setDirty(true);
  };

  const editWord = (i: number) => {
    const current = tokens[i];
    const next = prompt("Edit word", current.word);
    if (next !== null) {
      setTokens((prev) => prev.map((t, idx) => (idx === i ? { ...t, word: next } : t)));
      setDirty(true);
    }
  };

  const save = async () => {
    try {
      await update.mutateAsync({ id: clip.id, data: { captions: tokens } });
      toast.success("Captions saved — re-rendering preview");
      setDirty(false);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Save failed");
    }
  };

  const regenerate = async () => {
    try {
      await api.regenerateClip(clip.id, { regenerate_captions: true });
      toast.success("Regenerating captions…");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed");
    }
  };

  if (!tokens.length) {
    return (
      <div className="space-y-3 text-center text-sm text-muted-foreground">
        <p>No captions generated for this clip.</p>
        <Button variant="secondary" onClick={regenerate}>
          <Wand2 className="h-4 w-4" /> Generate captions
        </Button>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <p className="text-xs text-muted-foreground">
        Click a word to toggle <span className="font-semibold text-primary">emphasis</span>; double-click to edit text.
      </p>
      <div className="flex max-h-72 flex-wrap gap-1.5 overflow-y-auto rounded-lg border p-3">
        {tokens.map((t, i) => (
          <button
            key={i}
            onClick={() => toggleEmphasis(i)}
            onDoubleClick={() => editWord(i)}
            title={`${formatDuration(t.start)} → ${formatDuration(t.end)}`}
            className={cn(
              "rounded px-1.5 py-0.5 text-sm transition-colors",
              t.emphasis ? "bg-primary text-primary-foreground font-bold" : "bg-muted hover:bg-accent",
            )}
          >
            {t.word}
            {t.emoji ? ` ${t.emoji}` : ""}
          </button>
        ))}
      </div>
      <div className="flex gap-2">
        <Button onClick={save} disabled={!dirty || update.isPending}>
          {update.isPending && <Loader2 className="h-4 w-4 animate-spin" />}
          <Save className="h-4 w-4" /> Save & re-render
        </Button>
        <Button variant="outline" onClick={regenerate}>
          <Wand2 className="h-4 w-4" /> AI regenerate
        </Button>
        <div className="ml-auto flex gap-2 text-sm">
          <a className="text-primary hover:underline" href={`/api/v1/clips/${clip.id}/captions.srt`}>SRT</a>
          <a className="text-primary hover:underline" href={`/api/v1/clips/${clip.id}/captions.vtt`}>VTT</a>
        </div>
      </div>
    </div>
  );
}
