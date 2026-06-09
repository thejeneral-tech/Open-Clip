"use client";

import { Bot as BotIcon, Loader2, MoreVertical, Pause, Play, Plus, Square, Trash2, Zap } from "lucide-react";
import Link from "next/link";
import { useState } from "react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger,
} from "@/components/ui/dialog";
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { api } from "@/lib/api";
import { useBots, useCreateBot, useDeleteBot, usePresets } from "@/hooks/use-api";
import type { Bot, BotStatus } from "@/lib/types";
import { formatRelativeTime } from "@/lib/utils";

const STATUS_COLOR: Record<BotStatus, string> = {
  active: "bg-emerald-500/15 text-emerald-600 dark:text-emerald-400",
  running: "bg-blue-500/15 text-blue-600 dark:text-blue-400",
  paused: "bg-amber-500/15 text-amber-600 dark:text-amber-400",
  stopped: "bg-muted text-muted-foreground",
  error: "bg-destructive/15 text-destructive",
};

const APPROVAL_LABEL: Record<string, string> = {
  manual: "Manual review",
  semi_auto: "Semi-automatic",
  autonomous: "Autonomous",
};

function BotActions({ bot }: { bot: Bot }) {
  const del = useDeleteBot();
  const act = async (fn: () => Promise<unknown>, msg: string) => {
    try {
      await fn();
      toast.success(msg);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Action failed");
    }
  };
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" size="icon" className="h-7 w-7">
          <MoreVertical className="h-4 w-4" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <DropdownMenuItem onClick={() => act(() => api.botAction(bot.id, "start"), "Bot started")}>
          <Play className="h-4 w-4" /> Start
        </DropdownMenuItem>
        <DropdownMenuItem onClick={() => act(() => api.runBot(bot.id), "Run queued")}>
          <Zap className="h-4 w-4" /> Run now
        </DropdownMenuItem>
        <DropdownMenuItem onClick={() => act(() => api.botAction(bot.id, "pause"), "Bot paused")}>
          <Pause className="h-4 w-4" /> Pause
        </DropdownMenuItem>
        <DropdownMenuItem onClick={() => act(() => api.botAction(bot.id, "stop"), "Bot stopped")}>
          <Square className="h-4 w-4" /> Stop
        </DropdownMenuItem>
        <DropdownMenuItem onClick={() => act(() => api.cloneBot(bot.id), "Bot cloned")}>
          Clone
        </DropdownMenuItem>
        <DropdownMenuItem
          className="text-destructive"
          onClick={async () => {
            if (confirm(`Delete bot "${bot.name}"?`)) {
              await del.mutateAsync(bot.id);
              toast.success("Bot deleted");
            }
          }}
        >
          <Trash2 className="h-4 w-4" /> Delete
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

export default function BotsPage() {
  const { data: bots = [], isLoading } = useBots(true);
  const { data: presets = [] } = usePresets();
  const createBot = useCreateBot();
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [presetKey, setPresetKey] = useState("AI_NEWS");
  const [approval, setApproval] = useState("manual");
  const [interval, setIntervalMin] = useState("360");

  const onCreate = async (e: React.FormEvent) => {
    e.preventDefault();
    try {
      await createBot.mutateAsync({
        name,
        description: description || undefined,
        preset_key: presetKey,
        approval_mode: approval as Bot["approval_mode"],
        schedule_config: { interval_minutes: Number(interval) },
      });
      toast.success("Bot created");
      setOpen(false);
      setName("");
      setDescription("");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to create bot");
    }
  };

  return (
    <div className="mx-auto max-w-6xl space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">Bots</h1>
          <p className="text-muted-foreground">
            Autonomous discovery → clipping → publishing workers. All AI runs locally via Ollama.
          </p>
        </div>
        <Dialog open={open} onOpenChange={setOpen}>
          <DialogTrigger asChild>
            <Button>
              <Plus className="h-4 w-4" /> New bot
            </Button>
          </DialogTrigger>
          <DialogContent>
            <form onSubmit={onCreate}>
              <DialogHeader>
                <DialogTitle>Create bot</DialogTitle>
                <DialogDescription>Seed it from a preset, then fine-tune later.</DialogDescription>
              </DialogHeader>
              <div className="space-y-4 py-4">
                <div className="space-y-2">
                  <Label htmlFor="name">Name</Label>
                  <Input id="name" value={name} onChange={(e) => setName(e.target.value)}
                         placeholder="AI News Clipper" required />
                </div>
                <div className="space-y-2">
                  <Label>Preset</Label>
                  <Select value={presetKey} onValueChange={setPresetKey}>
                    <SelectTrigger><SelectValue /></SelectTrigger>
                    <SelectContent>
                      {presets.map((p) => (
                        <SelectItem key={`${p.id}-${p.key}`} value={p.key}>
                          {p.name}{p.is_system ? "" : " (custom)"}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                <div className="grid grid-cols-2 gap-3">
                  <div className="space-y-2">
                    <Label>Approval mode</Label>
                    <Select value={approval} onValueChange={setApproval}>
                      <SelectTrigger><SelectValue /></SelectTrigger>
                      <SelectContent>
                        <SelectItem value="manual">Manual review</SelectItem>
                        <SelectItem value="semi_auto">Semi-automatic</SelectItem>
                        <SelectItem value="autonomous">Autonomous</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="interval">Run every (min)</Label>
                    <Input id="interval" type="number" min={5} value={interval}
                           onChange={(e) => setIntervalMin(e.target.value)} />
                  </div>
                </div>
                <div className="space-y-2">
                  <Label htmlFor="desc">Description</Label>
                  <Textarea id="desc" value={description}
                            onChange={(e) => setDescription(e.target.value)} placeholder="Optional" />
                </div>
              </div>
              <DialogFooter>
                <Button type="submit" disabled={createBot.isPending}>
                  {createBot.isPending && <Loader2 className="h-4 w-4 animate-spin" />}
                  Create
                </Button>
              </DialogFooter>
            </form>
          </DialogContent>
        </Dialog>
      </div>

      {isLoading ? (
        <div className="flex justify-center py-20">
          <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
        </div>
      ) : bots.length === 0 ? (
        <Card>
          <CardContent className="flex flex-col items-center gap-3 py-16 text-center">
            <BotIcon className="h-10 w-10 text-muted-foreground" />
            <p className="text-muted-foreground">No bots yet.</p>
            <Button onClick={() => setOpen(true)}>
              <Plus className="h-4 w-4" /> Create your first bot
            </Button>
          </CardContent>
        </Card>
      ) : (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {bots.map((b) => (
            <Card key={b.id} className="group relative transition-shadow hover:shadow-md">
              <CardHeader>
                <div className="flex items-start justify-between">
                  <CardTitle className="line-clamp-1">
                    <Link href={`/bots/${b.id}`} className="hover:text-primary">{b.name}</Link>
                  </CardTitle>
                  <BotActions bot={b} />
                </div>
                <div className="flex flex-wrap items-center gap-2 pt-1">
                  <Badge variant="secondary" className={STATUS_COLOR[b.status]}>{b.status}</Badge>
                  <Badge variant="outline">{b.bot_type}</Badge>
                  <span className="text-xs text-muted-foreground">{APPROVAL_LABEL[b.approval_mode]}</span>
                </div>
                <CardDescription className="line-clamp-2 min-h-[2.5rem] pt-1">
                  {b.description || "No description"}
                </CardDescription>
              </CardHeader>
              <CardContent>
                <Link href={`/bots/${b.id}`}>
                  <div className="flex items-center justify-between text-sm text-muted-foreground">
                    <span>{b.source_count} sources · {b.stats?.clips_created ?? 0} clips</span>
                    <span>
                      {b.last_run_at ? `ran ${formatRelativeTime(b.last_run_at)}` : "never run"}
                    </span>
                  </div>
                </Link>
              </CardContent>
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}
