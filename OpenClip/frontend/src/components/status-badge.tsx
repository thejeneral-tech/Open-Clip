import { CheckCircle2, Clock, Loader2, XCircle } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import type { JobStatus } from "@/lib/types";
import { cn } from "@/lib/utils";

const MAP: Record<JobStatus, { label: string; variant: "default" | "secondary" | "destructive" | "success" | "warning"; spin?: boolean; Icon: typeof Clock }> = {
  pending: { label: "Pending", variant: "secondary", Icon: Clock },
  queued: { label: "Queued", variant: "warning", Icon: Clock },
  processing: { label: "Processing", variant: "warning", spin: true, Icon: Loader2 },
  completed: { label: "Ready", variant: "success", Icon: CheckCircle2 },
  failed: { label: "Failed", variant: "destructive", Icon: XCircle },
  cancelled: { label: "Cancelled", variant: "secondary", Icon: XCircle },
};

export function StatusBadge({ status, className }: { status: JobStatus; className?: string }) {
  const { label, variant, spin, Icon } = MAP[status] ?? MAP.pending;
  return (
    <Badge variant={variant} className={cn("gap-1", className)}>
      <Icon className={cn("h-3 w-3", spin && "animate-spin")} />
      {label}
    </Badge>
  );
}
