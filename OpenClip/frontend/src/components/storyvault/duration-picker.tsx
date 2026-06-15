"use client";

import { Input } from "@/components/ui/input";
import { cn, formatDurationLabel } from "@/lib/utils";

// Mirrors the backend limits (enums.SV_DURATION_MIN / SV_DURATION_MAX and the
// ge/le on SvVideoCreate.duration_target). Keep these in sync.
export const MIN_DURATION = 15;
export const MAX_DURATION = 1800; // 30 minutes

// Quick-pick presets shown as chips — short-form through long-form.
const PRESETS = [30, 60, 90, 180, 300, 600, 900, 1200, 1800];

const clampDuration = (n: number) =>
  Math.max(MIN_DURATION, Math.min(MAX_DURATION, Math.round(n) || 0));

/**
 * Duration selector with quick-pick chips plus a minutes/seconds custom entry,
 * so the user can grab a common length (10/20/30 min) or dial in any increment
 * (e.g. 12m 50s). `value` and the `onChange` argument are whole seconds.
 */
export function DurationPicker({
  value,
  onChange,
  disabled,
}: {
  value: number;
  onChange: (seconds: number) => void;
  disabled?: boolean;
}) {
  const mins = Math.floor(value / 60);
  const secs = value % 60;
  const maxMins = Math.floor(MAX_DURATION / 60);

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap gap-1.5">
        {PRESETS.map((p) => (
          <button
            key={p}
            type="button"
            disabled={disabled}
            onClick={() => onChange(clampDuration(p))}
            className={cn(
              "rounded-full border px-2.5 py-1 text-xs transition-colors disabled:opacity-50",
              value === p
                ? "border-primary bg-primary/10 font-medium text-primary"
                : "border-input text-muted-foreground hover:text-foreground",
            )}
          >
            {formatDurationLabel(p)}
          </button>
        ))}
      </div>
      <div className="flex items-center gap-2">
        <div className="flex items-center gap-1">
          <Input
            type="number"
            min={0}
            max={maxMins}
            disabled={disabled}
            value={mins}
            onChange={(e) => onChange(clampDuration((Number(e.target.value) || 0) * 60 + secs))}
            className="w-16"
            aria-label="Minutes"
          />
          <span className="text-xs text-muted-foreground">min</span>
        </div>
        <div className="flex items-center gap-1">
          <Input
            type="number"
            min={0}
            max={59}
            disabled={disabled}
            value={secs}
            onChange={(e) =>
              onChange(clampDuration(mins * 60 + Math.min(59, Math.max(0, Number(e.target.value) || 0))))
            }
            className="w-16"
            aria-label="Seconds"
          />
          <span className="text-xs text-muted-foreground">sec</span>
        </div>
        <span className="ml-auto text-xs text-muted-foreground">= {formatDurationLabel(value)}</span>
      </div>
    </div>
  );
}
