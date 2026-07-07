"use client";

import { Check, ExternalLink, Loader2, Plus, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import {
  WHOP_CATEGORIES,
  WHOP_PLATFORMS,
  WHOP_TYPES,
} from "@/components/whop/platform-meta";
import { useWhopUrlPreview } from "@/hooks/use-api";
import type {
  WhopAssetLink,
  WhopCampaign,
  WhopCampaignType,
  WhopPlatform,
} from "@/lib/types";
import { cn } from "@/lib/utils";

// og:image content-type → an extension the thumbnail endpoint accepts.
function imageExt(type: string): string | null {
  if (type === "image/png") return "png";
  if (type === "image/jpeg" || type === "image/jpg") return "jpg";
  if (type === "image/webp") return "webp";
  return null;
}

// Add a scheme so a bare "whop.com/..." paste still opens.
function withScheme(url: string): string {
  return /^https?:\/\//i.test(url) ? url : `https://${url}`;
}

export interface CampaignFormValue {
  name: string;
  description: string;
  campaign_type: WhopCampaignType;
  category: string;
  rate_per_1k: number;
  budget: number | null;
  min_payout: number | null;
  max_payout: number | null;
  platforms: WhopPlatform[];
  requirements: string[];
  asset_links: WhopAssetLink[];
  whop_url: string;
  ends_at: string | null;
}

// Mirrors backend WhopCampaignCreate defaults so a fresh form is already valid.
export const DEFAULT_CAMPAIGN: CampaignFormValue = {
  name: "",
  description: "",
  campaign_type: "clipping",
  category: "personal_brand",
  rate_per_1k: 1.0,
  budget: null,
  min_payout: null,
  max_payout: null,
  platforms: [],
  requirements: [],
  asset_links: [],
  whop_url: "",
  ends_at: null,
};

// Optional number inputs keep local string state; empty → null on submit.
function parseOptionalNumber(text: string): number | null {
  const trimmed = text.trim();
  if (!trimmed) return null;
  const n = Number(trimmed);
  return Number.isFinite(n) ? n : null;
}

function numberText(n: number | null | undefined): string {
  return n == null ? "" : String(n);
}

export function CampaignForm({
  initial,
  submitLabel,
  submitting,
  onSubmit,
  onChange,
  hideBusinessFields,
}: {
  initial?: WhopCampaign | null;
  submitLabel: string;
  submitting: boolean;
  onSubmit: (value: CampaignFormValue, thumbnail: File | null) => void | Promise<void>;
  // Fired with the live form value on every edit — lets a parent render a
  // reactive panel (e.g. payout math) without waiting for Save.
  onChange?: (value: CampaignFormValue) => void;
  // Hide category/budget/min/max inputs (e.g. when a payout panel shows them).
  // The values are still tracked and saved.
  hideBusinessFields?: boolean;
}) {
  const [name, setName] = useState(initial?.name ?? "");
  const [description, setDescription] = useState(initial?.description ?? "");
  const [campaignType, setCampaignType] = useState<WhopCampaignType>(
    initial?.campaign_type ?? DEFAULT_CAMPAIGN.campaign_type,
  );
  const [category, setCategory] = useState(initial?.category ?? DEFAULT_CAMPAIGN.category);
  const [rateText, setRateText] = useState(
    numberText(initial?.rate_per_1k ?? DEFAULT_CAMPAIGN.rate_per_1k),
  );
  const [budgetText, setBudgetText] = useState(numberText(initial?.budget));
  const [minPayoutText, setMinPayoutText] = useState(numberText(initial?.min_payout));
  const [maxPayoutText, setMaxPayoutText] = useState(numberText(initial?.max_payout));
  const [platforms, setPlatforms] = useState<WhopPlatform[]>(initial?.platforms ?? []);
  const [endsAt, setEndsAt] = useState(initial?.ends_at ? initial.ends_at.slice(0, 10) : "");
  const [whopUrl, setWhopUrl] = useState(initial?.whop_url ?? "");
  const [requirements, setRequirements] = useState<string[]>(initial?.requirements ?? []);
  const [requirementDraft, setRequirementDraft] = useState("");
  const [assetLinks, setAssetLinks] = useState<WhopAssetLink[]>(initial?.asset_links ?? []);
  const [thumbnail, setThumbnail] = useState<File | null>(null);
  const [preview, setPreview] = useState<string | null>(initial?.thumbnail_url ?? null);

  // Report live values to a parent (ref-held so a fresh inline onChange can't
  // loop the effect). Fires on every field edit; thumbnail is handled separately.
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;
  useEffect(() => {
    onChangeRef.current?.({
      name: name.trim(),
      description,
      campaign_type: campaignType,
      category,
      rate_per_1k: parseOptionalNumber(rateText) ?? DEFAULT_CAMPAIGN.rate_per_1k,
      budget: parseOptionalNumber(budgetText),
      min_payout: parseOptionalNumber(minPayoutText),
      max_payout: parseOptionalNumber(maxPayoutText),
      platforms,
      requirements,
      asset_links: assetLinks,
      whop_url: whopUrl.trim(),
      ends_at: endsAt ? endsAt : null,
    });
  }, [
    name, description, campaignType, category, rateText, budgetText, minPayoutText,
    maxPayoutText, platforms, requirements, assetLinks, whopUrl, endsAt,
  ]);

  const togglePlatform = (p: WhopPlatform) =>
    setPlatforms((prev) => (prev.includes(p) ? prev.filter((x) => x !== p) : [...prev, p]));

  const addRequirement = (text: string) => {
    const req = text.trim();
    if (!req) return;
    setRequirements((prev) => (prev.includes(req) ? prev : [...prev, req]));
    setRequirementDraft("");
  };

  const removeRequirement = (req: string) =>
    setRequirements((prev) => prev.filter((r) => r !== req));

  const setLink = (index: number, key: keyof WhopAssetLink, value: string) =>
    setAssetLinks((prev) => prev.map((l, i) => (i === index ? { ...l, [key]: value } : l)));

  const removeLink = (index: number) =>
    setAssetLinks((prev) => prev.filter((_, i) => i !== index));

  const handleThumbnail = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0] ?? null;
    if (preview?.startsWith("blob:")) URL.revokeObjectURL(preview);
    setThumbnail(file);
    setPreview(file ? URL.createObjectURL(file) : initial?.thumbnail_url ?? null);
  };

  // Whop link preview: debounce-fetch metadata whenever a whop.com URL is typed.
  const {
    mutate: fetchWhopPreview,
    reset: resetWhopPreview,
    data: whopPreview,
    isPending: whopPreviewLoading,
    isError: whopPreviewError,
  } = useWhopUrlPreview();

  useEffect(() => {
    const url = whopUrl.trim();
    if (!/whop\.com/i.test(url)) {
      resetWhopPreview();
      return;
    }
    const timer = setTimeout(() => fetchWhopPreview(url), 600);
    return () => clearTimeout(timer);
  }, [whopUrl, fetchWhopPreview, resetWhopPreview]);

  // Auto-import: the effect below reads the live form values without re-running
  // on every keystroke, so it fills only fields the user hasn't already set.
  const latestFormRef = useRef({ name, description, thumbnail, preview });
  latestFormRef.current = { name, description, thumbnail, preview };
  const importedUrlRef = useRef<string | null>(initial?.whop_url ?? null);

  // As soon as a Whop link resolves, pull its details into the campaign — no click
  // needed. Empty fields only, once per URL, so it never clobbers your own edits.
  useEffect(() => {
    const p = whopPreview;
    if (!p || importedUrlRef.current === p.url) return;
    importedUrlRef.current = p.url;

    const cur = latestFormRef.current;
    let imported = false;
    if (!cur.name.trim() && p.title) {
      setName(p.title);
      imported = true;
    }
    if (!cur.description.trim() && p.description) {
      setDescription(p.description);
      imported = true;
    }
    // Only auto-set a cover when the campaign has no thumbnail at all (never
    // replace an existing one — e.g. when editing).
    if (p.image && !cur.thumbnail && !cur.preview) {
      imported = true;
      void (async () => {
        try {
          const res = await fetch(p.image as string);
          const blob = res.ok ? await res.blob() : null;
          const ext = blob && imageExt(blob.type);
          if (blob && ext) {
            const file = new File([blob], `whop-cover.${ext}`, { type: blob.type });
            setThumbnail(file);
            setPreview(URL.createObjectURL(file));
          }
        } catch {
          // Cross-origin cover fetch can fail — title/description still import.
        }
      })();
    }
    if (imported) toast.success("Imported details from the Whop link");
  }, [whopPreview]);

  const whopHref = whopUrl.trim() ? withScheme(whopUrl.trim()) : null;

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    // Keep a requirement the user typed but never confirmed with Add/Enter.
    const draft = requirementDraft.trim();
    const allRequirements =
      draft && !requirements.includes(draft) ? [...requirements, draft] : requirements;
    const links = assetLinks
      .filter((l) => l.url.trim() !== "")
      .map((l) => ({ label: l.label.trim() || "Link", url: l.url.trim() }));
    void onSubmit(
      {
        name: name.trim(),
        description,
        campaign_type: campaignType,
        category,
        rate_per_1k: parseOptionalNumber(rateText) ?? DEFAULT_CAMPAIGN.rate_per_1k,
        budget: parseOptionalNumber(budgetText),
        min_payout: parseOptionalNumber(minPayoutText),
        max_payout: parseOptionalNumber(maxPayoutText),
        platforms,
        requirements: allRequirements,
        asset_links: links,
        whop_url: whopUrl.trim(),
        ends_at: endsAt ? endsAt : null,
      },
      thumbnail,
    );
  };

  // The Whop link importer — the hero of the "find a campaign" flow.
  const whopImporter = (
    <div className="space-y-2">
      <Label htmlFor="wc-whopurl">Whop campaign link</Label>
      <div className="flex gap-2">
        <Input
          id="wc-whopurl"
          value={whopUrl}
          onChange={(e) => setWhopUrl(e.target.value)}
          placeholder="Paste a whop.com campaign link…"
        />
        <Button
          type="button"
          variant="outline"
          size="icon"
          disabled={!whopHref}
          onClick={() => whopHref && window.open(whopHref, "_blank", "noopener,noreferrer")}
          title="Open on Whop"
          aria-label="Open on Whop"
        >
          <ExternalLink className="h-4 w-4" />
        </Button>
      </div>
      <p className="text-xs text-muted-foreground">
        Paste a link and the name, description, and cover fill in automatically.
      </p>

      {whopPreviewLoading && (
        <div className="flex items-center gap-2 text-xs text-muted-foreground">
          <Loader2 className="h-3.5 w-3.5 animate-spin" /> Finding the campaign…
        </div>
      )}
      {whopPreviewError && !whopPreviewLoading && /whop\.com/i.test(whopUrl) && (
        <p className="text-xs text-destructive">
          Couldn&apos;t load that Whop page — check the link is public and correct.
        </p>
      )}
      {whopPreview && !whopPreviewLoading && (
        <div className="flex gap-3 rounded-lg border p-3">
          {whopPreview.image && (
            <img
              src={whopPreview.image}
              alt=""
              className="h-16 w-16 shrink-0 rounded-md border object-cover"
            />
          )}
          <div className="min-w-0 flex-1 space-y-1">
            <p className="truncate text-sm font-medium">
              {whopPreview.title || whopPreview.url}
            </p>
            {whopPreview.description && (
              <p className="line-clamp-2 text-xs text-muted-foreground">
                {whopPreview.description}
              </p>
            )}
            <div className="flex items-center justify-between gap-2 pt-1">
              <span className="inline-flex items-center gap-1 text-xs text-emerald-500">
                <Check className="h-3.5 w-3.5" /> Auto-filled — edit anything below
              </span>
              <Button
                type="button"
                size="sm"
                variant="ghost"
                onClick={() => window.open(whopPreview.url, "_blank", "noopener,noreferrer")}
              >
                Open <ExternalLink className="h-3.5 w-3.5" />
              </Button>
            </div>
          </div>
        </div>
      )}
    </div>
  );

  // Advanced fields — always shown in the full (edit) form, collapsed in compact.
  const advancedFields = (
    <>
      <div className="space-y-2">
        <Label htmlFor="wc-desc">Description</Label>
        <Textarea
          id="wc-desc"
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          placeholder="Optional — what this campaign is about"
        />
      </div>

      {/* Category / budget / payouts — hidden in contexts that show them elsewhere
          (e.g. the workspace's live Payout Math panel). Values are still kept and
          saved; only the inputs are hidden. */}
      {!hideBusinessFields && (
        <>
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-2">
              <Label>Category</Label>
              <Select value={category} onValueChange={setCategory}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {WHOP_CATEGORIES.map((c) => (
                    <SelectItem key={c.value} value={c.value}>
                      {c.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-2">
              <Label htmlFor="wc-budget">Budget ($)</Label>
              <Input
                id="wc-budget"
                type="number"
                min={0}
                step="any"
                value={budgetText}
                onChange={(e) => setBudgetText(e.target.value)}
                placeholder="Unlimited"
              />
            </div>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-2">
              <Label htmlFor="wc-minpay">Min payout ($)</Label>
              <Input
                id="wc-minpay"
                type="number"
                min={0}
                step="any"
                value={minPayoutText}
                onChange={(e) => setMinPayoutText(e.target.value)}
                placeholder="None"
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="wc-maxpay">Max payout ($)</Label>
              <Input
                id="wc-maxpay"
                type="number"
                min={0}
                step="any"
                value={maxPayoutText}
                onChange={(e) => setMaxPayoutText(e.target.value)}
                placeholder="No cap"
              />
            </div>
          </div>
        </>
      )}

      <div className="space-y-2">
        <Label htmlFor="wc-ends">End date</Label>
        <Input
          id="wc-ends"
          type="date"
          value={endsAt}
          onChange={(e) => setEndsAt(e.target.value)}
        />
        <p className="text-xs text-muted-foreground">Leave empty for an open-ended campaign.</p>
      </div>

      <div className="space-y-2">
        <Label htmlFor="wc-req">Requirements</Label>
        {requirements.length > 0 && (
          <div className="flex flex-wrap gap-2">
            {requirements.map((req) => (
              <span
                key={req}
                className="inline-flex items-center gap-1.5 rounded-full border px-3 py-1 text-xs"
              >
                {req}
                <button
                  type="button"
                  onClick={() => removeRequirement(req)}
                  aria-label={`Remove requirement: ${req}`}
                  className="text-muted-foreground transition-colors hover:text-foreground"
                >
                  <X className="h-3 w-3" />
                </button>
              </span>
            ))}
          </div>
        )}
        <div className="flex gap-2">
          <Input
            id="wc-req"
            value={requirementDraft}
            onChange={(e) => setRequirementDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                addRequirement(requirementDraft);
              }
            }}
            placeholder="Must include my handle in the caption"
          />
          <Button type="button" variant="outline" onClick={() => addRequirement(requirementDraft)}>
            <Plus className="h-4 w-4" /> Add
          </Button>
        </div>
      </div>

      <div className="space-y-2">
        <Label>Asset links</Label>
        {assetLinks.map((link, i) => (
          <div key={i} className="flex gap-2">
            <Input
              value={link.label}
              onChange={(e) => setLink(i, "label", e.target.value)}
              placeholder="Label"
              className="w-36"
            />
            <Input
              value={link.url}
              onChange={(e) => setLink(i, "url", e.target.value)}
              placeholder="https://drive.google.com/..."
            />
            <Button
              type="button"
              variant="ghost"
              size="icon"
              onClick={() => removeLink(i)}
              aria-label="Remove link"
            >
              <X className="h-4 w-4" />
            </Button>
          </div>
        ))}
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={() => setAssetLinks((prev) => [...prev, { label: "", url: "" }])}
        >
          <Plus className="h-4 w-4" /> Add link
        </Button>
      </div>

      <div className="space-y-2">
        <Label htmlFor="wc-thumb">Campaign thumbnail</Label>
        <div className="flex items-center gap-3">
          {preview && (
            <img
              src={preview}
              alt="Campaign thumbnail preview"
              className="h-16 w-16 shrink-0 rounded-lg border object-cover"
            />
          )}
          <Input id="wc-thumb" type="file" accept="image/*" onChange={handleThumbnail} />
        </div>
      </div>
    </>
  );

  return (
    <form onSubmit={handleSubmit} className="space-y-4">
      {whopImporter}

      <div className="space-y-2">
        <Label htmlFor="wc-name">Campaign name</Label>
        <Input
          id="wc-name"
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="Clip my podcast — July"
          required
        />
      </div>

      <div className="grid grid-cols-2 gap-3">
        <div className="space-y-2">
          <Label>Type</Label>
          <Select value={campaignType} onValueChange={(v) => setCampaignType(v as WhopCampaignType)}>
            <SelectTrigger>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {WHOP_TYPES.map((t) => (
                <SelectItem key={t.value} value={t.value}>
                  {t.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="space-y-2">
          <Label htmlFor="wc-rate">Reward ($ / 1K views)</Label>
          <Input
            id="wc-rate"
            type="number"
            min={0.01}
            step="any"
            value={rateText}
            onChange={(e) => setRateText(e.target.value)}
            required
          />
        </div>
      </div>

      <div className="space-y-2">
        <Label>Platforms</Label>
        <div className="flex flex-wrap gap-2">
          {WHOP_PLATFORMS.map((p) => {
            const Icon = p.icon;
            const active = platforms.includes(p.value);
            return (
              <button
                key={p.value}
                type="button"
                onClick={() => togglePlatform(p.value)}
                className={cn(
                  "inline-flex items-center gap-1.5 rounded-md border px-3 py-1.5 text-sm transition-colors",
                  active ? "border-primary bg-primary/10 text-primary" : "border-input hover:bg-accent",
                )}
              >
                <Icon className="h-3.5 w-3.5" /> {p.label}
              </button>
            );
          })}
        </div>
      </div>

      {advancedFields}

      <Button type="submit" className="w-full" disabled={submitting}>
        {submitting && <Loader2 className="h-4 w-4 animate-spin" />}
        {submitLabel}
      </Button>
    </form>
  );
}
