"use client";

import { Loader2, Plus, Send, Trash2 } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { useConnectors, usePublishingJobs } from "@/hooks/use-api";
import { api } from "@/lib/api";
import type { SourcePlatform } from "@/lib/types";
import { formatRelativeTime } from "@/lib/utils";
import { useQueryClient } from "@tanstack/react-query";

const STATUS_VARIANT: Record<string, "secondary" | "destructive" | "outline" | "default"> = {
  published: "default",
  failed: "destructive",
  awaiting_approval: "outline",
};

function QueueTab() {
  const qc = useQueryClient();
  const { data: jobs = [], isLoading } = usePublishingJobs(undefined, undefined, true);
  const refresh = () => qc.invalidateQueries({ queryKey: ["pub-jobs"] });
  const act = async (fn: () => Promise<unknown>, msg: string) => {
    try { await fn(); toast.success(msg); refresh(); }
    catch (e) { toast.error(e instanceof Error ? e.message : "Failed"); }
  };

  if (isLoading) return <div className="flex justify-center py-16"><Loader2 className="h-6 w-6 animate-spin text-muted-foreground" /></div>;
  if (jobs.length === 0) return <p className="py-8 text-center text-sm text-muted-foreground">No publishing jobs yet.</p>;

  return (
    <div className="space-y-2">
      {jobs.map((j) => (
        <div key={j.id} className="flex items-center justify-between gap-4 rounded-lg border p-3">
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <Badge variant="outline">{j.platform}</Badge>
              <Badge variant={STATUS_VARIANT[j.status] ?? "secondary"}>{j.status.replace("_", " ")}</Badge>
              {j.scheduled_at && <span className="text-xs text-muted-foreground">scheduled {formatRelativeTime(j.scheduled_at)}</span>}
            </div>
            <p className="truncate text-sm font-medium">{j.title || `Clip #${j.clip_id}`}</p>
            {j.external_url && <a href={j.external_url} target="_blank" rel="noreferrer" className="truncate text-xs text-primary">{j.external_url}</a>}
            {j.error && <p className="truncate text-xs text-destructive">{j.error}</p>}
          </div>
          <div className="flex shrink-0 gap-2">
            {(j.status === "awaiting_approval" || j.status === "scheduled" || j.status === "pending") && (
              <Button size="sm" onClick={() => act(() => api.approveJob(j.id), "Publishing")}>Publish</Button>
            )}
            {j.status === "failed" && (
              <Button size="sm" variant="outline" onClick={() => act(() => api.retryJob(j.id), "Retrying")}>Retry</Button>
            )}
            {j.status !== "published" && j.status !== "cancelled" && (
              <Button size="sm" variant="ghost" onClick={() => act(() => api.cancelJob(j.id), "Cancelled")}>Cancel</Button>
            )}
          </div>
        </div>
      ))}
    </div>
  );
}

function ConnectorsTab() {
  const qc = useQueryClient();
  const { data: connectors = [] } = useConnectors();
  const [open, setOpen] = useState(false);
  const [platform, setPlatform] = useState<SourcePlatform>("youtube");
  const [name, setName] = useState("");
  const [token, setToken] = useState("");
  const refresh = () => qc.invalidateQueries({ queryKey: ["connectors"] });

  const create = async (e: React.FormEvent) => {
    e.preventDefault();
    try {
      await api.createConnector({
        platform, name,
        credentials: token ? { access_token: token } : {},
      });
      toast.success("Connector added");
      setOpen(false); setName(""); setToken("");
      refresh();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed");
    }
  };

  return (
    <div className="space-y-4">
      <div className="flex justify-end">
        <Dialog open={open} onOpenChange={setOpen}>
          <DialogTrigger asChild><Button><Plus className="h-4 w-4" /> Add connector</Button></DialogTrigger>
          <DialogContent>
            <form onSubmit={create}>
              <DialogHeader>
                <DialogTitle>Add publishing connector</DialogTitle>
                <DialogDescription>
                  Connect a destination account. Use <b>manual</b> for a download-and-post queue (no credentials needed).
                </DialogDescription>
              </DialogHeader>
              <div className="space-y-4 py-4">
                <div className="space-y-2">
                  <Label>Platform</Label>
                  <Select value={platform} onValueChange={(v) => setPlatform(v as SourcePlatform)}>
                    <SelectTrigger><SelectValue /></SelectTrigger>
                    <SelectContent>
                      {(["youtube", "tiktok", "instagram", "x", "manual"] as string[]).map((p) => (
                        <SelectItem key={p} value={p}>{p}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                <div className="space-y-2">
                  <Label>Name</Label>
                  <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="My channel" required />
                </div>
                <div className="space-y-2">
                  <Label>OAuth access token (optional)</Label>
                  <Input value={token} onChange={(e) => setToken(e.target.value)} placeholder="ya29.…" />
                </div>
              </div>
              <DialogFooter><Button type="submit">Add</Button></DialogFooter>
            </form>
          </DialogContent>
        </Dialog>
      </div>
      {connectors.length === 0 ? (
        <p className="py-8 text-center text-sm text-muted-foreground">No connectors. The manual queue is always available.</p>
      ) : (
        <div className="space-y-2">
          {connectors.map((c) => (
            <div key={c.id} className="flex items-center justify-between rounded-lg border p-3">
              <div className="flex items-center gap-2">
                <Badge variant="outline">{c.platform}</Badge>
                <span className="font-medium">{c.name}</span>
                <Badge variant={c.status === "connected" ? "default" : "secondary"}>{c.status}</Badge>
              </div>
              <Button variant="ghost" size="icon" className="h-7 w-7 text-destructive"
                      onClick={async () => { await api.deleteConnector(c.id); refresh(); }}>
                <Trash2 className="h-4 w-4" />
              </Button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

export default function PublishingPage() {
  return (
    <div className="mx-auto max-w-5xl space-y-6">
      <div>
        <h1 className="text-2xl font-bold tracking-tight">Publishing</h1>
        <p className="text-muted-foreground">Review the publish queue and manage destination connectors.</p>
      </div>
      <Tabs defaultValue="queue">
        <TabsList>
          <TabsTrigger value="queue"><Send className="mr-1 h-4 w-4" /> Queue</TabsTrigger>
          <TabsTrigger value="connectors">Connectors</TabsTrigger>
        </TabsList>
        <TabsContent value="queue" className="pt-4"><QueueTab /></TabsContent>
        <TabsContent value="connectors" className="pt-4"><ConnectorsTab /></TabsContent>
      </Tabs>
    </div>
  );
}
