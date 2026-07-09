"use client";

import { Check, ExternalLink, Link as LinkIcon, Loader2, Sparkles } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { useWhopExtractRequirements } from "@/hooks/use-api";
import type { WhopAssetLink } from "@/lib/types";

// Paste a campaign's brief — the full rules text, or a Google Doc / link we follow —
// and pull out the posting requirements AND any document links to save. The parent
// decides what to do via onApply(requirements, links, replace): replace=true overwrites
// the current requirements list (a rescan); links are always merged in, never replaced.
export function RequirementsImportDialog({
  open,
  onOpenChange,
  onApply,
  existing = [],
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  onApply: (
    requirements: string[],
    links: WhopAssetLink[],
    replace: boolean,
  ) => void | Promise<void>;
  existing?: string[];
}) {
  const extractReq = useWhopExtractRequirements();
  const [text, setText] = useState("");
  const [found, setFound] = useState<string[] | null>(null);
  const [foundLinks, setFoundLinks] = useState<WhopAssetLink[]>([]);
  const [replace, setReplace] = useState(false);
  const [applying, setApplying] = useState(false);

  const reset = () => {
    setText("");
    setFound(null);
    setFoundLinks([]);
    setReplace(false);
  };

  const close = (next: boolean) => {
    if (!next) reset();
    onOpenChange(next);
  };

  const onExtract = async () => {
    const brief = text.trim();
    if (!brief) {
      toast.error("Paste the brief text or a Google Doc link first");
      return;
    }
    try {
      const res = await extractReq.mutateAsync({ text: brief });
      setFound(res.requirements);
      setFoundLinks(res.links);
      if (res.requirements.length === 0 && res.links.length === 0) {
        toast.info("Couldn't find requirements — try pasting the full brief text");
      } else if (res.documents.length) {
        toast.success("Read the linked doc");
      }
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Couldn't read that brief");
    }
  };

  const fresh = (found ?? []).filter((r) => !existing.includes(r));
  const toApply = replace ? (found ?? []) : fresh;
  const canApply = toApply.length > 0 || foundLinks.length > 0;

  const applyLabel =
    toApply.length > 0
      ? replace
        ? `Replace with ${toApply.length}`
        : `Add ${toApply.length} requirement${toApply.length === 1 ? "" : "s"}`
      : `Save ${foundLinks.length} link${foundLinks.length === 1 ? "" : "s"}`;

  const onConfirm = async () => {
    if (!canApply) return;
    setApplying(true);
    try {
      await onApply(toApply, foundLinks, replace);
      close(false);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Couldn't save requirements");
    } finally {
      setApplying(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={close}>
      <DialogContent className="max-h-[88vh] overflow-y-auto sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Import requirements from a brief</DialogTitle>
          <DialogDescription>
            Paste the campaign&apos;s brief — the full rules text, or the Google Doc link the
            creator shared. We pull out the posting rules and save any linked docs.
          </DialogDescription>
        </DialogHeader>

        <Textarea
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder="Paste the Google Doc link or the full brief text…"
          className="min-h-40"
        />
        <Button
          type="button"
          onClick={onExtract}
          disabled={extractReq.isPending || !text.trim()}
        >
          {extractReq.isPending ? (
            <Loader2 className="h-4 w-4 animate-spin" />
          ) : (
            <Sparkles className="h-4 w-4" />
          )}
          {found === null ? "Extract requirements" : "Re-extract"}
        </Button>

        {foundLinks.length > 0 && (
          <div className="space-y-2">
            <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
              Linked document{foundLinks.length === 1 ? "" : "s"} — saved as clickable links
            </p>
            <div className="flex flex-col gap-1.5">
              {foundLinks.map((l) => (
                <a
                  key={l.url}
                  href={l.url}
                  target="_blank"
                  rel="noreferrer"
                  className="flex items-center gap-2 rounded-md border p-2 text-sm transition-colors hover:bg-accent"
                >
                  <LinkIcon className="h-4 w-4 shrink-0 text-muted-foreground" />
                  <span className="shrink-0 font-medium">{l.label}</span>
                  <span className="truncate text-muted-foreground">{l.url}</span>
                  <ExternalLink className="ml-auto h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                </a>
              ))}
            </div>
          </div>
        )}

        {found !== null &&
          (found.length === 0 ? (
            foundLinks.length === 0 && (
              <p className="text-sm text-muted-foreground">
                No requirements found. If you pasted a link, make sure the doc is shared
                (&quot;anyone with the link&quot;) — or paste the brief text directly.
              </p>
            )
          ) : (
            <div className="space-y-3">
              <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                Found {found.length} requirement{found.length === 1 ? "" : "s"} · {fresh.length} new
              </p>
              <div className="flex flex-wrap gap-2">
                {found.map((r) => {
                  const isNew = !existing.includes(r);
                  return (
                    <span
                      key={r}
                      className={`inline-flex items-center gap-1.5 rounded-full border px-3 py-1 text-xs ${
                        isNew ? "" : "opacity-50"
                      }`}
                    >
                      <Check className="h-3 w-3 shrink-0 text-emerald-500" />
                      {r}
                    </span>
                  );
                })}
              </div>
              {existing.length > 0 && (
                <div className="flex items-center gap-2">
                  <Switch id="replace-req" checked={replace} onCheckedChange={setReplace} />
                  <Label htmlFor="replace-req" className="text-sm font-normal">
                    Replace the {existing.length} current requirement
                    {existing.length === 1 ? "" : "s"} instead of adding
                  </Label>
                </div>
              )}
            </div>
          ))}

        <DialogFooter>
          <Button variant="outline" onClick={() => close(false)}>
            Cancel
          </Button>
          <Button onClick={onConfirm} disabled={!canApply || applying}>
            {applying && <Loader2 className="h-4 w-4 animate-spin" />}
            {applyLabel}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
