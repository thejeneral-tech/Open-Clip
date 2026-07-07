"use client";

import { Check, Music2, Play, Undo2, X } from "lucide-react";
import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from "@/components/ui/dialog";
import { cn } from "@/lib/utils";

// First-visit flag — any close path marks the tour as seen.
export const WHOP_TOUR_KEY = "openclip_whop_tour_seen";

const STEPS: { title: string; description: string }[] = [
  {
    title: "Create Your Campaign",
    description:
      "Set up your reward rate, budget, platforms, and requirements — everything clippers need to start posting for you.",
  },
  {
    title: "Track Analytics",
    description:
      "Monitor views, payouts, and effective CPM across all your campaigns in real time.",
  },
  {
    title: "Review Videos",
    description:
      "Approve or reject creator submissions to ensure quality content for your brand.",
  },
  {
    title: "Request a Clawback",
    description:
      "Flag a paid submission for clawback when a video doesn't meet your requirements.",
  },
];

// --- Step illustrations: tiny hand-built mocks, muted + theme-aware, non-interactive ---

function FormMock() {
  return (
    <div className="w-60 space-y-2 rounded-lg border bg-background p-3 shadow-sm">
      <div className="h-2 w-20 rounded bg-muted-foreground/30" />
      <div className="h-6 rounded-md border bg-muted/60" />
      <div className="grid grid-cols-2 gap-2">
        <div className="h-6 rounded-md border bg-muted/60" />
        <div className="h-6 rounded-md border bg-muted/60" />
      </div>
      <div className="flex items-center gap-2">
        <span className="rounded-md bg-blue-500/15 px-2 py-0.5 text-[10px] font-semibold text-blue-500">
          $2.00 / 1K
        </span>
        <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-muted">
          <div className="h-full w-2/3 rounded-full bg-amber-500" />
        </div>
      </div>
      <div className="flex h-6 items-center justify-center rounded-md bg-primary/85 text-[10px] font-medium text-primary-foreground">
        Launch campaign
      </div>
    </div>
  );
}

function ChartMock() {
  return (
    <div className="w-64 rounded-lg border bg-background p-3 shadow-sm">
      <div className="mb-2 flex items-center justify-between">
        <div className="h-2 w-20 rounded bg-muted-foreground/30" />
        <div className="h-2 w-10 rounded bg-muted-foreground/20" />
      </div>
      <svg viewBox="0 0 240 90" className="h-24 w-full text-primary" role="presentation">
        <defs>
          <linearGradient id="whop-tour-area" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="currentColor" stopOpacity="0.25" />
            <stop offset="100%" stopColor="currentColor" stopOpacity="0" />
          </linearGradient>
        </defs>
        <g className="text-muted-foreground" stroke="currentColor" strokeOpacity="0.15">
          <line x1="0" x2="240" y1="22" y2="22" />
          <line x1="0" x2="240" y1="44" y2="44" />
          <line x1="0" x2="240" y1="66" y2="66" />
        </g>
        <path
          d="M0 78 L34 70 L68 74 L102 56 L136 60 L170 38 L204 30 L240 14 L240 90 L0 90 Z"
          fill="url(#whop-tour-area)"
        />
        <path
          d="M0 78 L34 70 L68 74 L102 56 L136 60 L170 38 L204 30 L240 14"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
    </div>
  );
}

function ReviewMock() {
  return (
    <div className="w-64 rounded-lg border bg-background p-3 shadow-sm">
      <div className="flex items-center gap-2">
        <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md bg-muted">
          <Music2 className="h-4 w-4 text-muted-foreground" />
        </div>
        <div className="min-w-0 flex-1 space-y-1.5">
          <div className="h-2 w-28 rounded bg-muted-foreground/30" />
          <div className="h-2 w-16 rounded bg-muted-foreground/20" />
        </div>
        <span className="rounded-md border px-1.5 py-0.5 text-[10px] text-muted-foreground">
          Pending
        </span>
      </div>
      <div className="mt-3 flex justify-end gap-2">
        <span className="inline-flex items-center gap-1 rounded-md bg-emerald-500/15 px-2 py-1 text-[10px] font-medium text-emerald-500">
          <Check className="h-3 w-3" /> Approve
        </span>
        <span className="inline-flex items-center gap-1 rounded-md bg-destructive/15 px-2 py-1 text-[10px] font-medium text-destructive">
          <X className="h-3 w-3" /> Reject
        </span>
      </div>
    </div>
  );
}

function ClawbackMock() {
  return (
    <div className="w-64 space-y-2 rounded-lg border bg-background p-3 shadow-sm">
      <div className="flex items-center gap-2">
        <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md bg-muted">
          <Music2 className="h-4 w-4 text-muted-foreground" />
        </div>
        <div className="min-w-0 flex-1 space-y-1.5">
          <div className="h-2 w-24 rounded bg-muted-foreground/30" />
          <div className="h-2 w-14 rounded bg-muted-foreground/20" />
        </div>
        <span className="rounded-md bg-primary/15 px-1.5 py-0.5 text-[10px] font-semibold text-primary">
          $54.00 paid
        </span>
      </div>
      <div className="flex justify-end">
        <span className="inline-flex items-center gap-1 rounded-md bg-amber-500/15 px-2 py-1 text-[10px] font-medium text-amber-500">
          <Undo2 className="h-3 w-3" /> Request clawback
        </span>
      </div>
    </div>
  );
}

export function WhopTour({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
}) {
  const [step, setStep] = useState(1);
  const [showVideo, setShowVideo] = useState(false);

  // Fresh start every time the tour is opened.
  useEffect(() => {
    if (open) {
      setStep(1);
      setShowVideo(false);
    }
  }, [open]);

  // Wrapper so ANY close path (Escape, backdrop, X, Get Started) marks the tour seen.
  const handleOpenChange = (o: boolean) => {
    if (!o) {
      try {
        window.localStorage.setItem(WHOP_TOUR_KEY, "1");
      } catch {
        // localStorage unavailable — nothing to persist.
      }
    }
    onOpenChange(o);
  };

  const current = STEPS[step - 1];

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="sm:max-w-lg">
        {showVideo ? (
          <video src="/whop-tutorial.mp4" controls className="w-full rounded-lg" />
        ) : (
          <div
            aria-hidden
            className="pointer-events-none flex h-44 select-none items-center justify-center overflow-hidden rounded-lg border bg-muted/40 p-4"
          >
            {step === 1 && <FormMock />}
            {step === 2 && <ChartMock />}
            {step === 3 && <ReviewMock />}
            {step === 4 && <ClawbackMock />}
          </div>
        )}

        <div className="flex gap-2">
          {STEPS.map((s, i) => (
            <div
              key={s.title}
              className={cn("h-1 flex-1 rounded-full", i + 1 <= step ? "bg-amber-500" : "bg-muted")}
            />
          ))}
        </div>

        <div className="space-y-1.5">
          <DialogTitle className="text-lg font-semibold">{current.title}</DialogTitle>
          <DialogDescription>{current.description}</DialogDescription>
        </div>

        <button
          type="button"
          onClick={() => setShowVideo((v) => !v)}
          className="inline-flex w-fit items-center gap-1.5 text-sm text-muted-foreground transition-colors hover:text-foreground"
        >
          <Play className="h-4 w-4" /> Watch the full walkthrough video
        </button>

        <div className="flex items-center justify-between gap-2">
          <div className="flex-1">
            {step > 1 && (
              <Button variant="ghost" onClick={() => setStep((s) => Math.max(1, s - 1))}>
                Previous
              </Button>
            )}
          </div>
          <span className="text-xs text-muted-foreground">
            {step} of {STEPS.length}
          </span>
          <div className="flex flex-1 justify-end">
            {step < STEPS.length ? (
              <Button onClick={() => setStep((s) => s + 1)}>Next</Button>
            ) : (
              <Button onClick={() => handleOpenChange(false)}>Get Started</Button>
            )}
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
