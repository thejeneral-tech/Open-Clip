"use client";

import { Loader2, TrendingUp } from "lucide-react";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useBots, useTrendItems } from "@/hooks/use-api";
import { api } from "@/lib/api";
import { useQueryClient } from "@tanstack/react-query";

export default function DiscoveryPage() {
  const { data: bots = [] } = useBots();
  const [botId, setBotId] = useState<number | null>(null);
  const [status, setStatus] = useState<string>("all");
  const qc = useQueryClient();

  useEffect(() => {
    if (botId === null && bots.length) setBotId(bots[0].id);
  }, [bots, botId]);

  const { data: items = [], isLoading } = useTrendItems(
    botId ?? 0,
    status === "all" ? undefined : status,
    true,
  );
  const refresh = () => qc.invalidateQueries({ queryKey: ["trend-items", botId] });

  return (
    <div className="mx-auto max-w-5xl space-y-6">
      <div>
        <h1 className="text-2xl font-bold tracking-tight">Discovery feed</h1>
        <p className="text-muted-foreground">Trending content found, scored, and ranked locally.</p>
      </div>

      <div className="flex flex-wrap gap-3">
        <Select value={botId ? String(botId) : ""} onValueChange={(v) => setBotId(Number(v))}>
          <SelectTrigger className="w-64"><SelectValue placeholder="Select a bot" /></SelectTrigger>
          <SelectContent>
            {bots.map((b) => <SelectItem key={b.id} value={String(b.id)}>{b.name}</SelectItem>)}
          </SelectContent>
        </Select>
        <Select value={status} onValueChange={setStatus}>
          <SelectTrigger className="w-48"><SelectValue /></SelectTrigger>
          <SelectContent>
            {["all", "discovered", "scored", "approved", "rejected", "ingested", "processed", "published"].map((s) => (
              <SelectItem key={s} value={s}>{s}</SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      {!botId ? (
        <Card><CardContent className="py-16 text-center text-muted-foreground">
          Create a bot to start discovering content.
        </CardContent></Card>
      ) : isLoading ? (
        <div className="flex justify-center py-20"><Loader2 className="h-6 w-6 animate-spin text-muted-foreground" /></div>
      ) : items.length === 0 ? (
        <Card><CardContent className="flex flex-col items-center gap-3 py-16 text-center">
          <TrendingUp className="h-10 w-10 text-muted-foreground" />
          <p className="text-muted-foreground">Nothing discovered yet — add sources and run the bot.</p>
        </CardContent></Card>
      ) : (
        <div className="space-y-2">
          {items.map((it) => (
            <div key={it.id} className="flex items-center justify-between gap-4 rounded-lg border p-3">
              <div className="flex min-w-0 items-center gap-3">
                <div className="flex h-12 w-12 shrink-0 items-center justify-center rounded-md bg-primary/10 text-sm font-bold text-primary">
                  {it.trend_score.toFixed(0)}
                </div>
                <div className="min-w-0">
                  <div className="flex items-center gap-2">
                    <Badge variant="outline">{it.platform}</Badge>
                    <Badge variant="secondary">{it.status}</Badge>
                    {it.metrics?.views ? <span className="text-xs text-muted-foreground">{Number(it.metrics.views).toLocaleString()} views</span> : null}
                  </div>
                  <a href={it.url} target="_blank" rel="noreferrer" className="block truncate text-sm font-medium hover:text-primary">
                    {it.title || it.url}
                  </a>
                  {it.reason && <p className="truncate text-xs text-muted-foreground">{it.reason}</p>}
                </div>
              </div>
              <div className="flex shrink-0 gap-2">
                <Button size="sm" variant="outline"
                        onClick={async () => { await api.approveItem(it.id); refresh(); toast.success("Approved — will ingest on next run"); }}>
                  Approve
                </Button>
                <Button size="sm" variant="ghost"
                        onClick={async () => { await api.rejectItem(it.id); refresh(); }}>
                  Reject
                </Button>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
