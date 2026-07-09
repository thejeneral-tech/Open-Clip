"use client";

import { CheckCircle2, Loader2, LogIn, RefreshCw, Unplug } from "lucide-react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Progress } from "@/components/ui/progress";
import {
  useWhopConnect,
  useWhopConnectConfirm,
  useWhopConnection,
  useWhopDisconnect,
  useWhopSyncStart,
  useWhopSyncStatus,
} from "@/hooks/use-api";

// Connect the app to Whop (one-time login in an app-owned browser) and sync every joined
// content-rewards campaign's requirements + Google Doc into the app — new ones included.
// Auto-discovers all your Whop communities; no URL to paste.
export function WhopSyncPanel() {
  const connection = useWhopConnection(true);
  const connect = useWhopConnect();
  const confirm = useWhopConnectConfirm();
  const disconnect = useWhopDisconnect();
  const startSync = useWhopSyncStart();
  const sync = useWhopSyncStatus(true);

  const connected = connection.data?.connected ?? false;
  const connecting = connection.data?.connecting ?? false;
  const running = sync.data?.running ?? false;

  const onConnect = async () => {
    try {
      await connect.mutateAsync();
      toast.info("A Chrome window opened — log into Whop, then click “I've logged in”.");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Couldn't open the login window");
    }
  };

  const onConfirm = async () => {
    try {
      const res = await confirm.mutateAsync();
      toast[res.connected ? "success" : "error"](
        res.connected ? "Whop connected" : "Didn't detect a login — try again",
      );
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Couldn't confirm login");
    }
  };

  const onSync = async () => {
    try {
      await startSync.mutateAsync(undefined);
      toast.success("Syncing your campaigns from Whop — this runs in the background.");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Couldn't start the sync");
    }
  };

  return (
    <Card>
      <CardHeader className="flex-row items-start justify-between space-y-0">
        <div className="space-y-1.5">
          <CardTitle className="flex items-center gap-2 text-base">
            Sync campaigns from Whop
            {connected && <Badge variant="success">Connected</Badge>}
          </CardTitle>
          <CardDescription>
            Pull every joined campaign&apos;s requirements + brief doc automatically — across all
            your Whop communities, new ones included.
          </CardDescription>
        </div>
        {connected && (
          <Button
            variant="ghost"
            size="sm"
            onClick={() => disconnect.mutate()}
            disabled={disconnect.isPending || running}
            className="text-muted-foreground"
          >
            <Unplug className="h-4 w-4" /> Disconnect
          </Button>
        )}
      </CardHeader>

      <CardContent className="space-y-4">
        {!connected ? (
          <div className="space-y-3">
            <p className="text-sm text-muted-foreground">
              Whop hides campaign briefs behind login, so connect once: a Chrome window opens,
              you sign into Whop, and the app keeps that session to read your campaigns.
            </p>
            {connecting ? (
              <div className="flex flex-wrap items-center gap-3">
                <span className="inline-flex items-center gap-2 text-sm text-muted-foreground">
                  <Loader2 className="h-4 w-4 animate-spin" /> Waiting for you to log in…
                </span>
                <Button onClick={onConfirm} disabled={confirm.isPending}>
                  {confirm.isPending ? (
                    <Loader2 className="h-4 w-4 animate-spin" />
                  ) : (
                    <CheckCircle2 className="h-4 w-4" />
                  )}
                  I&apos;ve logged in
                </Button>
              </div>
            ) : (
              <Button onClick={onConnect} disabled={connect.isPending}>
                {connect.isPending ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : (
                  <LogIn className="h-4 w-4" />
                )}
                Connect Whop account
              </Button>
            )}
          </div>
        ) : (
          <div className="space-y-3">
            <div className="flex flex-wrap items-center gap-3">
              <Button onClick={onSync} disabled={running || startSync.isPending}>
                {running || startSync.isPending ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : (
                  <RefreshCw className="h-4 w-4" />
                )}
                {running ? "Syncing…" : "Sync all campaigns"}
              </Button>
              <span className="text-xs text-muted-foreground">
                Runs in the background — a few minutes for all your communities.
              </span>
            </div>

            {(running || (sync.data && (sync.data.updated || sync.data.created))) && (
              <div className="space-y-1.5 rounded-md border p-3">
                <div className="flex items-center justify-between text-sm">
                  <span className="font-medium capitalize">
                    {running ? sync.data?.phase ?? "working" : "Last sync"}
                  </span>
                  <span className="text-muted-foreground">
                    {running && sync.data?.total
                      ? `${sync.data.processed}/${sync.data.total}`
                      : `${sync.data?.updated ?? 0} updated · ${sync.data?.created ?? 0} added`}
                  </span>
                </div>
                {running && (
                  <Progress
                    value={
                      sync.data?.total
                        ? Math.round((sync.data.processed / sync.data.total) * 100)
                        : 5
                    }
                  />
                )}
                {sync.data?.error && <p className="text-xs text-destructive">{sync.data.error}</p>}
              </div>
            )}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
