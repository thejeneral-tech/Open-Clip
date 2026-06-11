"use client";

import { Clapperboard, Loader2, RefreshCw, Sparkles } from "lucide-react";
import Link from "next/link";
import { useEffect, useRef } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { useSvCaptionPreviews, useSvGenerateCaptionPreviews } from "@/hooks/use-api";

const STYLE_INFO: Record<string, { label: string; blurb: string }> = {
  hormozi: {
    label: "Hormozi",
    blurb: "Huge bold uppercase, center-screen, green pops on key words — maximum retention.",
  },
  modern_tiktok: {
    label: "Modern TikTok",
    blurb: "Clean bold lines near the bottom with the active word flashing TikTok pink.",
  },
  minimal: {
    label: "Minimal",
    blurb: "Quiet, thin captions that stay out of the way — lets the footage breathe.",
  },
  gaming: {
    label: "Gaming",
    blurb: "Chunky uppercase with a heavy purple outline and neon green highlights.",
  },
  podcast: {
    label: "Podcast",
    blurb: "Comfortable sentence-case with warm gold emphasis — built for longer stories.",
  },
};

export default function PresetsPage() {
  const { data: previews = [], isLoading } = useSvCaptionPreviews(true);
  const generate = useSvGenerateCaptionPreviews();
  const kicked = useRef(false);

  const missing = previews.filter((p) => !p.media_url).length;

  // First visit: previews aren't rendered yet — kick the worker once.
  useEffect(() => {
    if (kicked.current || isLoading || previews.length === 0 || missing === 0) return;
    kicked.current = true;
    generate.mutate(false, {
      onError: (err) =>
        toast.error(err instanceof Error ? err.message : "Could not start preview rendering"),
    });
  }, [isLoading, previews.length, missing, generate]);

  const onRegenerate = async () => {
    try {
      await generate.mutateAsync(true);
      toast.success("Re-rendering all caption previews");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to start rendering");
    }
  };

  return (
    <div className="mx-auto max-w-6xl space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">Presets</h1>
          <p className="text-muted-foreground">
            Real rendered samples — exactly what your clip&apos;s captions will look and sound like.
          </p>
        </div>
        <Button variant="outline" onClick={onRegenerate} disabled={generate.isPending}>
          {generate.isPending ? (
            <Loader2 className="h-4 w-4 animate-spin" />
          ) : (
            <RefreshCw className="h-4 w-4" />
          )}
          Regenerate previews
        </Button>
      </div>

      {isLoading ? (
        <div className="flex justify-center py-20">
          <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
        </div>
      ) : previews.length === 0 ? (
        <Card>
          <CardContent className="flex flex-col items-center gap-3 py-16 text-center">
            <Sparkles className="h-10 w-10 text-muted-foreground" />
            <p className="text-muted-foreground">No caption styles available.</p>
          </CardContent>
        </Card>
      ) : (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {previews.map((p) => {
            const info = STYLE_INFO[p.style] ?? { label: p.style, blurb: "" };
            return (
              <Card key={p.style}>
                <CardHeader>
                  <CardTitle className="flex items-center justify-between text-base">
                    {info.label}
                  </CardTitle>
                  <CardDescription className="min-h-[2.5rem]">{info.blurb}</CardDescription>
                </CardHeader>
                <CardContent className="space-y-3">
                  {p.media_url ? (
                    // eslint-disable-next-line jsx-a11y/media-has-caption
                    <video
                      src={p.media_url}
                      controls
                      loop
                      preload="metadata"
                      className="aspect-[9/16] max-h-80 w-full rounded-md bg-black object-contain"
                    />
                  ) : (
                    <div className="flex aspect-[9/16] max-h-80 w-full flex-col items-center justify-center gap-2 rounded-md bg-muted/40">
                      <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
                      <p className="text-xs text-muted-foreground">Rendering preview…</p>
                    </div>
                  )}
                  <Button asChild variant="outline" className="w-full">
                    <Link href={`/storyvault/studio?caption=${p.style}`}>
                      <Clapperboard className="h-4 w-4" /> Use in Studio
                    </Link>
                  </Button>
                </CardContent>
              </Card>
            );
          })}
        </div>
      )}
    </div>
  );
}
