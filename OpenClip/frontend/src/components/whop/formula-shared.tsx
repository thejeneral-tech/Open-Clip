"use client";

import {
  Bot,
  Check,
  ChevronDown,
  Clapperboard,
  Copy,
  Download,
  FileText,
  Film,
  FlaskConical,
  Layers,
  ListChecks,
  Loader2,
  Megaphone,
  Repeat,
  ScrollText,
  Sparkles,
  Target,
  Trash2,
  Wand2,
  Zap,
} from "lucide-react";
import { useState, type ReactNode } from "react";
import { toast } from "sonner";
import { ScoreRing } from "@/components/score-ring";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Progress } from "@/components/ui/progress";
import type { WhopCampaign, WhopFormula, WhopFormulaResult } from "@/lib/types";

// Friendly one-liner from a formula's status/stage.
export function formulaStageLabel(f: WhopFormula): string {
  if (f.status === "completed") {
    return f.hook_score ? `Formula ready · hook ${f.hook_score}/10` : "Formula ready";
  }
  if (f.status === "failed") return "Analysis failed";
  switch (f.stage) {
    case "queued":
      return "Queued…";
    case "transcribe":
      return "Transcribing video…";
    case "blueprint":
      return "Analyzing structure & hook…";
    case "playbook":
      return "Building the clip playbook…";
    case "analyze":
      return "Analyzing…";
    default:
      return "Working…";
  }
}

// ------------------------------------------------------------- formula card
export function FormulaCard({
  formula,
  onOpen,
  onRetry,
}: {
  formula: WhopFormula;
  onOpen: (f: WhopFormula) => void;
  onRetry?: (f: WhopFormula) => void;
}) {
  const processing = formula.status === "processing";
  const failed = formula.status === "failed";
  const completed = formula.status === "completed";
  const pct = Math.round((formula.progress || 0) * 100);

  return (
    <Card className="flex flex-col gap-3 p-4">
      <div className="flex items-start gap-3">
        {completed ? (
          <ScoreRing score={(formula.hook_score ?? 0) * 10} size={40} />
        ) : (
          <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-gradient-to-br from-violet-500/25 to-fuchsia-600/25">
            {processing ? (
              <Loader2 className="h-4 w-4 animate-spin text-violet-500" />
            ) : (
              <FlaskConical className="h-4 w-4 text-muted-foreground" />
            )}
          </div>
        )}
        <div className="min-w-0 flex-1">
          <h3 className="truncate text-sm font-medium" title={formula.title ?? undefined}>
            {formula.title || `Source video #${formula.video_id ?? ""}`}
          </h3>
          <p className="truncate text-xs text-muted-foreground">{formulaStageLabel(formula)}</p>
        </div>
      </div>

      {processing && (
        <div className="space-y-1">
          <Progress value={pct} />
          <p className="text-right text-xs text-muted-foreground">{pct}%</p>
        </div>
      )}
      {failed && formula.error && (
        <p className="line-clamp-3 text-xs text-destructive">{formula.error}</p>
      )}

      <div className="mt-auto flex items-center gap-2">
        {completed && (
          <Button size="sm" className="flex-1" onClick={() => onOpen(formula)}>
            <FileText className="h-4 w-4" /> View formula
          </Button>
        )}
        {failed && onRetry && (
          <Button size="sm" variant="outline" className="flex-1" onClick={() => onRetry(formula)}>
            <Repeat className="h-4 w-4" /> Retry
          </Button>
        )}
      </div>
    </Card>
  );
}

// ---------------------------------------------------- inline formula strip
// A slim, horizontal formula readout for the unified results feed — sits right
// under a source video's clips so a video's clips + formula live together.
export function FormulaInline({
  formula,
  onOpen,
  onRetry,
}: {
  formula: WhopFormula;
  onOpen: (f: WhopFormula) => void;
  onRetry?: (f: WhopFormula) => void;
}) {
  const processing = formula.status === "processing";
  const failed = formula.status === "failed";
  const completed = formula.status === "completed";
  const pct = Math.round((formula.progress || 0) * 100);

  return (
    <div className="flex items-center gap-3 rounded-lg border bg-card p-3">
      {completed ? (
        <ScoreRing score={(formula.hook_score ?? 0) * 10} size={36} />
      ) : (
        <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-gradient-to-br from-violet-500/25 to-fuchsia-600/25">
          {processing ? (
            <Loader2 className="h-4 w-4 animate-spin text-violet-500" />
          ) : (
            <FlaskConical className="h-4 w-4 text-muted-foreground" />
          )}
        </div>
      )}
      <div className="min-w-0 flex-1">
        <p className="flex items-center gap-1.5 text-sm font-medium">
          <FlaskConical className="h-3.5 w-3.5 text-violet-500" /> Clip formula
        </p>
        <p className="truncate text-xs text-muted-foreground">{formulaStageLabel(formula)}</p>
        {processing && <Progress value={pct} className="mt-1.5 h-1.5" />}
        {failed && formula.error && (
          <p className="mt-0.5 line-clamp-2 text-xs text-destructive">{formula.error}</p>
        )}
      </div>
      {completed && (
        <Button size="sm" onClick={() => onOpen(formula)}>
          <FileText className="h-4 w-4" /> View formula
        </Button>
      )}
      {failed && onRetry && (
        <Button size="sm" variant="outline" onClick={() => onRetry(formula)}>
          <Repeat className="h-4 w-4" /> Retry
        </Button>
      )}
    </div>
  );
}

// -------------------------------------------------------- report primitives
function Section({
  title,
  icon: Icon,
  defaultOpen = false,
  children,
}: {
  title: string;
  icon: typeof Sparkles;
  defaultOpen?: boolean;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div className="overflow-hidden rounded-lg border">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="flex w-full items-center gap-2 bg-muted/30 px-4 py-2.5 text-left hover:bg-muted/50"
      >
        <Icon className="h-4 w-4 shrink-0 text-muted-foreground" />
        <span className="flex-1 text-sm font-semibold">{title}</span>
        <ChevronDown
          className={`h-4 w-4 shrink-0 text-muted-foreground transition-transform ${
            open ? "rotate-180" : ""
          }`}
        />
      </button>
      {open && <div className="space-y-3 px-4 py-3 text-sm">{children}</div>}
    </div>
  );
}

function Field({ label, value }: { label: string; value?: string }) {
  if (!value) return null;
  return (
    <div className="space-y-0.5">
      <p className="text-xs uppercase tracking-wide text-muted-foreground">{label}</p>
      <p className="text-sm">{value}</p>
    </div>
  );
}

function Chips({ items }: { items: string[] }) {
  if (!items.length) return null;
  return (
    <div className="flex flex-wrap gap-1.5">
      {items.map((t, i) => (
        <span key={`${t}-${i}`} className="rounded-full bg-muted px-2 py-0.5 text-xs text-muted-foreground">
          {t}
        </span>
      ))}
    </div>
  );
}

function Bullets({ items }: { items: string[] }) {
  if (!items.length) return null;
  return (
    <ul className="list-disc space-y-1 pl-5 text-sm text-muted-foreground">
      {items.map((t, i) => (
        <li key={`${i}-${t.slice(0, 12)}`}>{t}</li>
      ))}
    </ul>
  );
}

function Steps({ items }: { items: string[] }) {
  if (!items.length) return <p className="text-sm text-muted-foreground">—</p>;
  return (
    <ol className="space-y-1.5">
      {items.map((t, i) => (
        <li key={`${i}-${t.slice(0, 12)}`} className="flex gap-2 text-sm">
          <span className="mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-muted text-xs font-semibold">
            {i + 1}
          </span>
          <span>{t}</span>
        </li>
      ))}
    </ol>
  );
}

const ACTION_VARIANT: Record<string, "success" | "warning" | "secondary" | "destructive"> = {
  keep: "success",
  shorten: "warning",
  move: "secondary",
  remove: "destructive",
};

const EDITING_LABELS: { key: keyof WhopFormulaResult["editing"]; label: string }[] = [
  { key: "caption_style", label: "Caption style" },
  { key: "font", label: "Font" },
  { key: "size", label: "Size" },
  { key: "placement", label: "Placement" },
  { key: "animation", label: "Animation" },
  { key: "zooms", label: "Zooms" },
  { key: "cuts", label: "Cuts" },
  { key: "sfx", label: "Sound FX" },
  { key: "music", label: "Music" },
  { key: "motion_graphics", label: "Motion graphics" },
  { key: "logo_placement", label: "Logo placement" },
];

// --------------------------------------------------------- markdown export
export function formulaToMarkdown(f: WhopFormula): string {
  const r = f.result;
  if (!r) return `# ${f.title ?? "Clip formula"}\n\n(No analysis yet.)`;
  const L: string[] = [];
  L.push(`# Clip Formula — ${f.title ?? "Source video"}`);
  if (f.hook_score) L.push(`**Hook rating:** ${f.hook_score}/10 · **Framework:** ${r.script.framework}`);

  L.push(`\n## 1. Campaign requirements`);
  const req = r.requirements;
  L.push(`- **Length:** ${req.video_length}`);
  L.push(`- **Platforms:** ${req.platforms.join(", ")}`);
  L.push(`- **Pays:** ${req.rpm} · **Budget:** ${req.budget_remaining}`);
  L.push(`- **Join:** ${req.join_type}`);
  L.push(`- **Captions:** ${req.captions_required}`);
  L.push(`- **CTA:** ${req.cta_required}`);
  L.push(`- **Logo:** ${req.logo_required}`);
  L.push(`- **Hashtags:** ${req.hashtags.join(", ")}`);
  L.push(`- **Tags:** ${req.tags.join(", ")}`);
  L.push(`\n**What counts as valid:**`);
  req.valid_submission.forEach((s) => L.push(`- ${s}`));
  L.push(`\n**Would get rejected:**`);
  req.rejection_reasons.forEach((s) => L.push(`- ${s}`));
  if (req.special_instructions) L.push(`\n_${req.special_instructions}_`);
  L.push(`\n${req.how_requirements_control}`);

  L.push(`\n## 2. Video structure`);
  r.structure.forEach((s) => {
    const time = [s.start, s.end].filter(Boolean).join("–");
    L.push(`\n**${time ? `${time} · ` : ""}${s.label}** — ${s.purpose}`);
    if (s.visual) L.push(`- Visual: ${s.visual}`);
    if (s.narration) L.push(`- Narration: ${s.narration}`);
    if (s.why) L.push(`- Why: ${s.why}`);
    if (s.supports) L.push(`- Supports: ${s.supports}`);
  });

  L.push(`\n## 3. Viral moments to clip`);
  r.viral_moments.forEach((m) => {
    const time = [m.start, m.end].filter(Boolean).join("–");
    L.push(`\n**#${m.rank ?? "?"} ${time}${m.strength ? ` · ${m.strength}/100` : ""}**`);
    L.push(`- Hook: ${m.hook_line}`);
    if (m.caption_title) L.push(`- Caption: ${m.caption_title}`);
    L.push(`- Why: ${m.why_viral}`);
    if (m.best_platform) L.push(`- Best on: ${m.best_platform}${m.needs_context ? " · needs context" : ""}`);
  });

  L.push(`\n## 4. Hook (rated ${r.hook.rating}/10)`);
  L.push(r.hook.why_it_stops_scroll);
  if (r.hook.triggers.length) L.push(`- Triggers: ${r.hook.triggers.join(", ")}`);
  r.hook.best_hook_lines.forEach((h) => L.push(`- Hook line: ${h}`));

  L.push(`\n## 5. Script (${r.script.framework})`);
  r.script.sentences.forEach((s) => {
    L.push(`- "${s.text}" — ${s.purpose} [${s.serves ?? ""}] → ${s.action ?? "keep"}`);
  });

  L.push(`\n## 6. Visual timeline (${r.visual_timeline.change_frequency ?? ""})`);
  r.visual_timeline.changes.forEach((c) => L.push(`- ${c.time ? `${c.time}: ` : ""}${c.visual}`));

  L.push(`\n## 7. Editing`);
  EDITING_LABELS.forEach(({ key, label }) => {
    const v = r.editing[key];
    if (v) L.push(`- **${label}:** ${v}`);
  });
  if (r.editing.retention_notes) L.push(`\n${r.editing.retention_notes}`);

  L.push(`\n## 8. Retention (${r.retention.avg_seconds_between_changes ?? ""})`);
  r.retention.techniques.forEach((t) => L.push(`- ${t}`));

  L.push(`\n## 9. Campaign integration`);
  L.push(`- Blend: ${r.campaign_integration.blend_type} (${r.campaign_integration.feels_natural ? "feels natural" : "feels forced"})`);
  if (r.campaign_integration.notes) L.push(`- ${r.campaign_integration.notes}`);

  L.push(`\n## 10. Background footage`);
  L.push(`- Type: ${r.background_footage.footage_type} (${r.background_footage.must_match ? "must match campaign" : "flexible"})`);
  if (r.background_footage.notes) L.push(`- ${r.background_footage.notes}`);

  L.push(`\n## 11. Recreation plan (CapCut / Opus)`);
  r.recreation_plan.forEach((s, i) => L.push(`${i + 1}. ${s}`));

  L.push(`\n## 12. AI automation workflow`);
  r.automation_workflow.forEach((s, i) => L.push(`${i + 1}. ${s}`));

  L.push(`\n## 13. Submission checklist`);
  r.checklist.forEach((c) => L.push(`- [ ] ${c.label}${c.required ? "" : " (optional)"}`));

  L.push(`\n## 14. Reusable template`);
  L.push("```\n" + r.template + "\n```");

  return L.join("\n");
}

// --------------------------------------------------------------- the report
function FormulaReport({ result }: { result: WhopFormulaResult }) {
  const req = result.requirements;
  return (
    <div className="space-y-3">
      {/* 1 · Campaign requirements */}
      <Section title="Campaign requirements" icon={Megaphone} defaultOpen>
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
          <Field label="Length" value={req.video_length} />
          <Field label="Platforms" value={req.platforms.join(", ")} />
          <Field label="Pays" value={req.rpm} />
          <Field label="Budget" value={req.budget_remaining} />
          <Field label="Join type" value={req.join_type} />
          <Field label="Captions" value={req.captions_required} />
          <Field label="CTA" value={req.cta_required} />
          <Field label="Logo" value={req.logo_required} />
        </div>
        <div className="space-y-1.5">
          <p className="text-xs uppercase tracking-wide text-muted-foreground">Hashtags & tags</p>
          <Chips items={[...req.hashtags, ...req.tags]} />
        </div>
        <div className="grid gap-3 sm:grid-cols-2">
          <div className="space-y-1">
            <p className="text-xs font-semibold text-emerald-500">✓ What counts as valid</p>
            <Bullets items={req.valid_submission} />
          </div>
          <div className="space-y-1">
            <p className="text-xs font-semibold text-rose-500">✗ Would get rejected</p>
            <Bullets items={req.rejection_reasons} />
          </div>
        </div>
        {req.special_instructions && (
          <p className="rounded-md bg-muted/50 p-3 text-sm text-muted-foreground">
            {req.special_instructions}
          </p>
        )}
        <p className="text-sm text-muted-foreground">{req.how_requirements_control}</p>
      </Section>

      {/* 2 · Structure */}
      <Section title="Video structure" icon={Layers} defaultOpen>
        <div className="space-y-3">
          {result.structure.map((s, i) => {
            const time = [s.start, s.end].filter(Boolean).join("–");
            return (
              <div key={i} className="rounded-md border-l-2 border-primary/40 pl-3">
                <div className="flex flex-wrap items-center gap-2">
                  {time && (
                    <span className="rounded bg-muted px-1.5 py-0.5 font-mono text-xs">{time}</span>
                  )}
                  <span className="font-medium">{s.label}</span>
                </div>
                <p className="text-sm text-muted-foreground">{s.purpose}</p>
                <div className="mt-1 space-y-0.5 text-xs text-muted-foreground">
                  {s.visual && <p>👁 {s.visual}</p>}
                  {s.narration && <p>🎙 {s.narration}</p>}
                  {s.why && <p>💡 {s.why}</p>}
                  {s.supports && <p>🎯 {s.supports}</p>}
                </div>
              </div>
            );
          })}
          {result.structure.length === 0 && <p className="text-muted-foreground">—</p>}
        </div>
      </Section>

      {/* 3 · Viral moments */}
      <Section title="Viral moments to clip" icon={Target} defaultOpen>
        <div className="space-y-3">
          {result.viral_moments.map((m, i) => {
            const time = [m.start, m.end].filter(Boolean).join("–");
            return (
              <div key={i} className="flex gap-3 rounded-md border p-3">
                <ScoreRing score={m.strength ?? 0} size={40} />
                <div className="min-w-0 flex-1 space-y-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="text-sm font-semibold">#{m.rank ?? i + 1}</span>
                    {time && (
                      <span className="rounded bg-muted px-1.5 py-0.5 font-mono text-xs">{time}</span>
                    )}
                    {m.best_platform && <Badge variant="outline">{m.best_platform}</Badge>}
                    {m.needs_context && <Badge variant="warning">needs context</Badge>}
                  </div>
                  <p className="text-sm font-medium">“{m.hook_line}”</p>
                  {m.caption_title && (
                    <p className="text-xs text-muted-foreground">Caption: {m.caption_title}</p>
                  )}
                  <p className="text-sm text-muted-foreground">{m.why_viral}</p>
                </div>
              </div>
            );
          })}
          {result.viral_moments.length === 0 && <p className="text-muted-foreground">—</p>}
        </div>
      </Section>

      {/* 4 · Hook */}
      <Section title="Hook breakdown" icon={Zap}>
        <div className="flex gap-4">
          <div className="shrink-0 text-center">
            <ScoreRing score={result.hook.rating * 10} size={56} />
            <p className="mt-1 text-xs text-muted-foreground">{result.hook.rating}/10</p>
          </div>
          <div className="flex-1 space-y-2">
            <p className="text-sm">{result.hook.why_it_stops_scroll}</p>
            <Chips items={result.hook.triggers} />
            {result.hook.best_hook_lines.length > 0 && (
              <div className="space-y-1">
                <p className="text-xs uppercase tracking-wide text-muted-foreground">Reusable hook lines</p>
                <Bullets items={result.hook.best_hook_lines} />
              </div>
            )}
          </div>
        </div>
      </Section>

      {/* 5 · Script */}
      <Section title="Script & psychology" icon={ScrollText}>
        <Badge variant="secondary">{result.script.framework}</Badge>
        <div className="space-y-2">
          {result.script.sentences.map((s, i) => (
            <div key={i} className="rounded-md border p-2.5">
              <div className="flex items-start justify-between gap-2">
                <p className="text-sm">“{s.text}”</p>
                <Badge variant={ACTION_VARIANT[s.action ?? "keep"] ?? "secondary"} className="shrink-0 capitalize">
                  {s.action ?? "keep"}
                </Badge>
              </div>
              <p className="text-xs text-muted-foreground">
                {s.purpose}
                {s.serves ? ` · builds ${s.serves}` : ""}
              </p>
            </div>
          ))}
          {result.script.sentences.length === 0 && <p className="text-muted-foreground">—</p>}
        </div>
      </Section>

      {/* 6 · Visual timeline */}
      <Section title="Visual timeline" icon={Film}>
        <p className="text-sm text-muted-foreground">
          Change frequency: {result.visual_timeline.change_frequency}
        </p>
        <ul className="space-y-1 text-sm">
          {result.visual_timeline.changes.map((c, i) => (
            <li key={i} className="flex gap-2">
              {c.time && (
                <span className="rounded bg-muted px-1.5 py-0.5 font-mono text-xs">{c.time}</span>
              )}
              <span>{c.visual}</span>
            </li>
          ))}
        </ul>
      </Section>

      {/* 7 · Editing */}
      <Section title="Editing breakdown" icon={Clapperboard}>
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
          {EDITING_LABELS.map(({ key, label }) => (
            <Field key={key} label={label} value={result.editing[key]} />
          ))}
        </div>
        {result.editing.retention_notes && (
          <p className="text-sm text-muted-foreground">{result.editing.retention_notes}</p>
        )}
      </Section>

      {/* 8 · Retention */}
      <Section title="Retention techniques" icon={Sparkles}>
        <p className="text-sm text-muted-foreground">
          Avg change: {result.retention.avg_seconds_between_changes}
        </p>
        <Chips items={result.retention.techniques} />
      </Section>

      {/* 9 · Campaign integration */}
      <Section title="Campaign integration" icon={Megaphone}>
        <div className="flex flex-wrap items-center gap-2">
          <Badge variant="outline">{result.campaign_integration.blend_type}</Badge>
          <Badge variant={result.campaign_integration.feels_natural ? "success" : "warning"}>
            {result.campaign_integration.feels_natural ? "feels natural" : "feels forced"}
          </Badge>
        </div>
        <p className="text-sm text-muted-foreground">{result.campaign_integration.notes}</p>
      </Section>

      {/* 10 · Background footage */}
      <Section title="Background footage" icon={Film}>
        <div className="flex flex-wrap items-center gap-2">
          <Badge variant="outline">{result.background_footage.footage_type}</Badge>
          <Badge variant={result.background_footage.must_match ? "warning" : "secondary"}>
            {result.background_footage.must_match ? "must match campaign" : "flexible"}
          </Badge>
        </div>
        <p className="text-sm text-muted-foreground">{result.background_footage.notes}</p>
      </Section>

      {/* 11 · Recreation plan */}
      <Section title="Recreation plan (CapCut / Opus)" icon={Wand2}>
        <Steps items={result.recreation_plan} />
      </Section>

      {/* 12 · Automation workflow */}
      <Section title="AI automation workflow" icon={Bot}>
        <Steps items={result.automation_workflow} />
      </Section>

      {/* 13 · Submission checklist */}
      <Section title="Submission checklist" icon={ListChecks}>
        <ul className="space-y-1.5">
          {result.checklist.map((c, i) => (
            <li key={i} className="flex items-start gap-2 text-sm">
              <span className="mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center rounded border">
                <Check className="h-3 w-3 text-muted-foreground" />
              </span>
              <span>
                {c.label}
                {!c.required && <span className="text-xs text-muted-foreground"> (optional)</span>}
              </span>
            </li>
          ))}
        </ul>
      </Section>

      {/* 14 · Template */}
      <Section title="Reusable template" icon={Repeat}>
        <pre className="overflow-x-auto whitespace-pre-wrap rounded-md bg-muted/50 p-3 text-xs leading-relaxed">
          {result.template}
        </pre>
      </Section>
    </div>
  );
}

// -------------------------------------------------------- report modal shell
export function FormulaReportModal({
  formula,
  campaign,
  open,
  onOpenChange,
  onDelete,
}: {
  formula: WhopFormula | null;
  campaign: WhopCampaign;
  open: boolean;
  onOpenChange: (o: boolean) => void;
  onDelete?: (f: WhopFormula) => void;
}) {
  const result = formula?.result ?? null;

  const copy = async () => {
    if (!formula) return;
    try {
      await navigator.clipboard.writeText(formulaToMarkdown(formula));
      toast.success("Formula copied to clipboard");
    } catch {
      toast.error("Couldn't copy to clipboard");
    }
  };

  const download = () => {
    if (!formula) return;
    const blob = new Blob([formulaToMarkdown(formula)], { type: "text/markdown" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `clip-formula-${formula.id}.md`;
    a.click();
    URL.revokeObjectURL(url);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="flex max-h-[88vh] flex-col sm:max-w-3xl">
        <DialogHeader>
          <DialogTitle className="line-clamp-1">
            {formula?.title || "Clip formula"}
          </DialogTitle>
          <DialogDescription>
            Reverse-engineered formula for {campaign.name} — repeat it to make more winning clips.
          </DialogDescription>
        </DialogHeader>

        {/* Action strip */}
        <div className="flex flex-wrap items-center gap-2">
          {formula?.hook_score != null && (
            <Badge variant="secondary" className="gap-1">
              <Zap className="h-3 w-3" /> Hook {formula.hook_score}/10
            </Badge>
          )}
          {result && <Badge variant="outline">{result.script.framework}</Badge>}
          <div className="ml-auto flex gap-2">
            <Button size="sm" variant="secondary" onClick={copy} disabled={!result}>
              <Copy className="h-4 w-4" /> Copy
            </Button>
            <Button size="sm" variant="secondary" onClick={download} disabled={!result}>
              <Download className="h-4 w-4" /> .md
            </Button>
            {formula && onDelete && (
              <Button size="sm" variant="ghost" onClick={() => onDelete(formula)}>
                <Trash2 className="h-4 w-4" />
              </Button>
            )}
          </div>
        </div>

        <div className="-mx-6 flex-1 overflow-y-auto px-6">
          {result ? (
            <FormulaReport result={result} />
          ) : (
            <p className="py-10 text-center text-sm text-muted-foreground">
              This formula has no analysis yet.
            </p>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
