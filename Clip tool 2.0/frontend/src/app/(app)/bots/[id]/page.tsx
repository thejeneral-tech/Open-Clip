"use client";

import {
  ArrowLeft, Brain, Loader2, Pause, Play, Plus, Square, Trash2, Zap,
} from "lucide-react";
import Link from "next/link";
import { useParams } from "next/navigation";
import { useState } from "react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  useBot, useBotAnalytics, useBotRuns, useSources, useTrendItems,
} from "@/hooks/use-api";
import { api } from "@/lib/api";
import type { SourcePlatform } from "@/lib/types";
import { formatRelativeTime } from "@/lib/utils";
import { useQueryClient } from "@tanstack/react-query";

const PLATFORMS: SourcePlatform[] = ["youtube", "rss", "reddit", "tiktok", "instagram", "x", "custom"];

function JsonCard({ title, data }: { title: string; data: unknown }) {
  return (
    <Card>
      <CardHeader className="pb-2"><CardTitle className="text-sm">{title}</CardTitle></CardHeader>
      <CardContent>
        <pre className="max-h-64 overflow-auto rounded-md bg-muted/50 p-3 text-xs">
          {JSON.stringify(data, null, 2)}
        </pre>
      </CardContent>
    </Card>
  );
}

function SourcesTab({ botId }: { botId: number }) {
  const qc = useQueryClient();
  const { data: sources = [] } = useSources(botId);
  const [platform, setPlatform] = useState<SourcePlatform>("rss");
  const [name, setName] = useState("");
  const [identifier, setIdentifier] = useState("");
  const [listMode, setListMode] = useState("allow");
  const refresh = () => qc.invalidateQueries({ queryKey: ["sources", botId] });

  const add = async (e: React.FormEvent) => {
    e.preventDefault();
    try {
      await api.addSource(botId, { platform, name, identifier, list_mode: listMode as "allow" | "deny" });
      toast.success("Source added");
      setName(""); setIdentifier("");
      refresh();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed");
    }
  };

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader className="pb-2"><CardTitle className="text-sm">Add source</CardTitle></CardHeader>
        <CardContent>
          <form onSubmit={add} className="grid gap-3 sm:grid-cols-[140px_1fr_1fr_120px_auto] sm:items-end">
            <div className="space-y-1">
              <Label className="text-xs">Platform</Label>
              <Select value={platform} onValueChange={(v) => setPlatform(v as SourcePlatform)}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  {PLATFORMS.map((p) => <SelectItem key={p} value={p}>{p}</SelectItem>)}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1">
              <Label className="text-xs">Name</Label>
              <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="My feed" required />
            </div>
            <div className="space-y-1">
              <Label className="text-xs">Identifier</Label>
              <Input value={identifier} onChange={(e) => setIdentifier(e.target.value)}
                     placeholder="URL / @handle / subreddit / query" required />
            </div>
            <div className="space-y-1">
              <Label className="text-xs">Mode</Label>
              <Select value={listMode} onValueChange={setListMode}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="allow">Allow</SelectItem>
                  <SelectItem value="deny">Deny</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <Button type="submit"><Plus className="h-4 w-4" /> Add</Button>
          </form>
        </CardContent>
      </Card>

      {sources.length === 0 ? (
        <p className="text-sm text-muted-foreground">No sources yet. Add one above.</p>
      ) : (
        <div className="space-y-2">
          {sources.map((s) => (
            <div key={s.id} className="flex items-center justify-between rounded-lg border p-3">
              <div className="min-w-0">
                <div className="flex items-center gap-2">
                  <Badge variant="outline">{s.platform}</Badge>
                  <span className="font-medium">{s.name}</span>
                  <Badge variant={s.list_mode === "deny" ? "destructive" : "secondary"}>{s.list_mode}</Badge>
                </div>
                <p className="truncate text-xs text-muted-foreground">{s.identifier}</p>
              </div>
              <div className="flex items-center gap-3">
                <Switch
                  checked={s.enabled}
                  onCheckedChange={async (v) => {
                    await api.updateSource(botId, s.id, { enabled: v });
                    refresh();
                  }}
                />
                <Button variant="ghost" size="icon" className="h-7 w-7 text-destructive"
                        onClick={async () => { await api.deleteSource(botId, s.id); refresh(); }}>
                  <Trash2 className="h-4 w-4" />
                </Button>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function DiscoveryTab({ botId }: { botId: number }) {
  const qc = useQueryClient();
  const { data: items = [] } = useTrendItems(botId, undefined, true);
  const refresh = () => qc.invalidateQueries({ queryKey: ["trend-items", botId] });
  if (items.length === 0) return <p className="text-sm text-muted-foreground">No discovered items yet — run the bot.</p>;
  return (
    <div className="space-y-2">
      {items.map((it) => (
        <div key={it.id} className="flex items-center justify-between gap-3 rounded-lg border p-3">
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <Badge variant="outline">{it.platform}</Badge>
              <Badge>{it.trend_score.toFixed(0)}</Badge>
              <Badge variant="secondary">{it.status}</Badge>
            </div>
            <a href={it.url} target="_blank" rel="noreferrer" className="block truncate text-sm hover:text-primary">
              {it.title || it.url}
            </a>
            {it.reason && <p className="truncate text-xs text-muted-foreground">{it.reason}</p>}
          </div>
          <div className="flex shrink-0 gap-2">
            <Button size="sm" variant="outline"
                    onClick={async () => { await api.approveItem(it.id); refresh(); toast.success("Approved"); }}>
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
  );
}

function RunsTab({ botId }: { botId: number }) {
  const { data: runs = [] } = useBotRuns(botId, true);
  if (runs.length === 0) return <p className="text-sm text-muted-foreground">No runs yet.</p>;
  return (
    <div className="space-y-3">
      {runs.map((r) => (
        <Card key={r.id}>
          <CardHeader className="pb-2">
            <div className="flex items-center justify-between">
              <CardTitle className="text-sm">
                Run #{r.id} · <span className="text-muted-foreground">{r.trigger}</span>
              </CardTitle>
              <Badge variant={r.status === "failed" ? "destructive" : "secondary"}>{r.status}</Badge>
            </div>
          </CardHeader>
          <CardContent className="space-y-2">
            <div className="flex flex-wrap gap-3 text-xs text-muted-foreground">
              {Object.entries(r.stats || {}).map(([k, v]) => (
                <span key={k}>{k}: <b className="text-foreground">{v}</b></span>
              ))}
            </div>
            {r.error && <p className="text-xs text-destructive">{r.error}</p>}
            <div className="space-y-1">
              {(r.events || []).slice(-6).map((e, i) => (
                <p key={i} className="text-xs text-muted-foreground">
                  {formatRelativeTime(e.ts)} — {e.message}
                </p>
              ))}
            </div>
          </CardContent>
        </Card>
      ))}
    </div>
  );
}

function AnalyticsTab({ botId }: { botId: number }) {
  const { data } = useBotAnalytics(botId);
  const insights = (data?.insights ?? {}) as Record<string, unknown>;
  const recs = (insights.recommendations as string[]) ?? [];
  return (
    <div className="space-y-4">
      {recs.length > 0 && (
        <Card>
          <CardHeader className="pb-2"><CardTitle className="text-sm">Recommendations</CardTitle></CardHeader>
          <CardContent>
            <ul className="list-disc space-y-1 pl-5 text-sm">
              {recs.map((r, i) => <li key={i}>{r}</li>)}
            </ul>
            {typeof insights.summary === "string" && (
              <p className="mt-3 text-sm text-muted-foreground">{insights.summary}</p>
            )}
          </CardContent>
        </Card>
      )}
      <JsonCard title="Performance summary" data={data?.summary ?? {}} />
    </div>
  );
}

export default function BotDetailPage() {
  const params = useParams();
  const botId = Number(params.id);
  const { data: bot, isLoading } = useBot(botId, true);
  const qc = useQueryClient();

  const refreshBot = () => qc.invalidateQueries({ queryKey: ["bot", botId] });
  const act = async (fn: () => Promise<unknown>, msg: string) => {
    try { await fn(); toast.success(msg); refreshBot(); }
    catch (e) { toast.error(e instanceof Error ? e.message : "Failed"); }
  };

  if (isLoading || !bot) {
    return <div className="flex justify-center py-20"><Loader2 className="h-6 w-6 animate-spin text-muted-foreground" /></div>;
  }

  return (
    <div className="mx-auto max-w-5xl space-y-6">
      <div>
        <Link href="/bots" className="mb-2 inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground">
          <ArrowLeft className="h-4 w-4" /> Bots
        </Link>
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h1 className="text-2xl font-bold tracking-tight">{bot.name}</h1>
            <div className="flex items-center gap-2 pt-1">
              <Badge variant="secondary">{bot.status}</Badge>
              <Badge variant="outline">{bot.bot_type}</Badge>
              <span className="text-sm text-muted-foreground">
                {bot.next_run_at ? `next run ${formatRelativeTime(bot.next_run_at)}` : "not scheduled"}
              </span>
            </div>
          </div>
          <div className="flex gap-2">
            <Button size="sm" onClick={() => act(() => api.runBot(botId), "Run queued")}>
              <Zap className="h-4 w-4" /> Run now
            </Button>
            {bot.status === "active" ? (
              <Button size="sm" variant="outline" onClick={() => act(() => api.botAction(botId, "pause"), "Paused")}>
                <Pause className="h-4 w-4" /> Pause
              </Button>
            ) : (
              <Button size="sm" variant="outline" onClick={() => act(() => api.botAction(botId, "start"), "Started")}>
                <Play className="h-4 w-4" /> Start
              </Button>
            )}
            <Button size="sm" variant="outline" onClick={() => act(() => api.botAction(botId, "stop"), "Stopped")}>
              <Square className="h-4 w-4" /> Stop
            </Button>
            <Button size="sm" variant="ghost" onClick={() => act(() => api.improveBot(botId), "Learning queued")}>
              <Brain className="h-4 w-4" /> Improve
            </Button>
          </div>
        </div>
        {bot.last_error && <p className="mt-2 text-sm text-destructive">{bot.last_error}</p>}
      </div>

      <Tabs defaultValue="overview">
        <TabsList>
          <TabsTrigger value="overview">Overview</TabsTrigger>
          <TabsTrigger value="sources">Sources ({bot.source_count})</TabsTrigger>
          <TabsTrigger value="discovery">Discovery</TabsTrigger>
          <TabsTrigger value="runs">Runs</TabsTrigger>
          <TabsTrigger value="analytics">Analytics</TabsTrigger>
        </TabsList>

        <TabsContent value="overview" className="space-y-4 pt-4">
          <Card>
            <CardHeader className="pb-2"><CardTitle className="text-sm">Behaviour</CardTitle></CardHeader>
            <CardContent className="grid gap-4 sm:grid-cols-2">
              <div className="space-y-1">
                <Label className="text-xs">Approval mode</Label>
                <Select value={bot.approval_mode}
                        onValueChange={(v) => act(() => api.updateBot(botId, { approval_mode: v }), "Updated")}>
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="manual">Manual review</SelectItem>
                    <SelectItem value="semi_auto">Semi-automatic</SelectItem>
                    <SelectItem value="autonomous">Autonomous</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-1">
                <Label className="text-xs">Run interval (minutes)</Label>
                <Input type="number" min={5}
                       defaultValue={Number(bot.schedule_config?.interval_minutes ?? 360)}
                       onBlur={(e) => act(
                         () => api.updateBot(botId, { schedule_config: { ...bot.schedule_config, interval_minutes: Number(e.target.value) } }),
                         "Schedule updated",
                       )} />
              </div>
              <div className="sm:col-span-2 flex flex-wrap gap-3 text-xs text-muted-foreground">
                {Object.entries(bot.stats || {}).map(([k, v]) => (
                  <span key={k}>{k}: <b className="text-foreground">{v}</b></span>
                ))}
              </div>
            </CardContent>
          </Card>
          <div className="grid gap-4 md:grid-cols-2">
            <JsonCard title="Discovery" data={bot.discovery_config} />
            <JsonCard title="Filters" data={bot.filter_config} />
            <JsonCard title="Scoring" data={bot.scoring_config} />
            <JsonCard title="Clipping" data={bot.clipping_config} />
            <JsonCard title="Publishing" data={bot.publishing_config} />
            <JsonCard title="Model assignments" data={bot.model_assignments} />
          </div>
        </TabsContent>

        <TabsContent value="sources" className="pt-4"><SourcesTab botId={botId} /></TabsContent>
        <TabsContent value="discovery" className="pt-4"><DiscoveryTab botId={botId} /></TabsContent>
        <TabsContent value="runs" className="pt-4"><RunsTab botId={botId} /></TabsContent>
        <TabsContent value="analytics" className="pt-4"><AnalyticsTab botId={botId} /></TabsContent>
      </Tabs>
    </div>
  );
}
