"use client";

import { useEffect, useRef, useState } from "react";
import { wsUrl } from "@/lib/api";
import type { ProgressEvent } from "@/lib/types";

/**
 * Subscribe to live progress for an entity over WebSocket.
 * `enabled` lets callers pause the connection (e.g. when a job is finished).
 */
export function useProgress(scope: "video" | "clip" | "export", id: number | null, enabled = true) {
  const [event, setEvent] = useState<ProgressEvent | null>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const retryRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (!id || !enabled) return;
    let closed = false;

    const connect = () => {
      const ws = new WebSocket(wsUrl(scope, id));
      wsRef.current = ws;

      ws.onmessage = (msg) => {
        try {
          const payload = JSON.parse(msg.data);
          if (payload?.type === "ping") return;
          setEvent(payload as ProgressEvent);
        } catch {
          /* ignore malformed frames */
        }
      };
      ws.onclose = () => {
        if (!closed) retryRef.current = setTimeout(connect, 3000);
      };
      ws.onerror = () => ws.close();
    };

    connect();
    return () => {
      closed = true;
      if (retryRef.current) clearTimeout(retryRef.current);
      wsRef.current?.close();
    };
  }, [scope, id, enabled]);

  return event;
}
