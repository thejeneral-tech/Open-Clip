"use client";

import { useCallback, useEffect, useState } from "react";
import { useParams } from "next/navigation";
import { BookOpen, RefreshCw } from "lucide-react";

const SV_BASE = process.env.NEXT_PUBLIC_STORYVAULT_URL || "http://127.0.0.1:4400";

// Hash routes of the embedded StoryVault SPA; anything else falls back to command.
const SV_PAGES = new Set([
  "command",
  "library",
  "backgrounds",
  "templates",
  "presets",
  "composer",
  "batch",
  "review",
  "exports",
  "voiceLab",
  "voicePresets",
  "jobs",
  "accounts",
  "preferences",
  "system",
  "logs",
]);

type Status = "checking" | "online" | "offline";

export default function StoryVaultPage() {
  const params = useParams<{ page: string }>();
  const raw = Array.isArray(params.page) ? params.page[0] : params.page;
  const page = SV_PAGES.has(raw) ? raw : "command";

  const [status, setStatus] = useState<Status>("checking");

  const check = useCallback(() => {
    setStatus("checking");
    // no-cors: we only care whether the server answers at all.
    fetch(`${SV_BASE}/api/auth/status`, { mode: "no-cors", cache: "no-store" })
      .then(() => setStatus("online"))
      .catch(() => setStatus("offline"));
  }, []);

  useEffect(() => {
    check();
  }, [check]);

  if (status !== "online") {
    return (
      <div className="grid h-full place-items-center p-6">
        <div className="oc-surface max-w-md rounded-xl border border-border p-8 text-center">
          <span
            className="mx-auto mb-4 grid h-12 w-12 place-items-center rounded-xl"
            style={{ background: "var(--brand-color)" }}
          >
            <BookOpen size={22} className="text-[var(--accent-contrast)]" />
          </span>
          <h2 className="text-lg font-semibold text-fg">Story Vault</h2>
          {status === "checking" ? (
            <p className="mt-2 animate-pulse text-sm text-muted">Connecting to Story Vault…</p>
          ) : (
            <>
              <p className="mt-2 text-sm text-muted">
                The Story Vault server is not reachable at{" "}
                <code className="rounded bg-[var(--hover-bg)] px-1.5 py-0.5 text-xs">{SV_BASE}</code>.
                Start it from the OpenClip launcher (<code className="rounded bg-[var(--hover-bg)] px-1.5 py-0.5 text-xs">python launch.py up</code>)
                or run <code className="rounded bg-[var(--hover-bg)] px-1.5 py-0.5 text-xs">npm start</code> in the
                StoryVault-Video-Factory folder.
              </p>
              <button
                type="button"
                onClick={check}
                className="oc-btn mt-5 inline-flex items-center gap-2 rounded-lg px-4 py-2 text-sm font-medium text-[var(--accent-contrast)]"
                style={{ background: "var(--red)" }}
              >
                <RefreshCw size={15} />
                Retry
              </button>
            </>
          )}
        </div>
      </div>
    );
  }

  return (
    <iframe
      src={`${SV_BASE}/?embed=1#/${page}`}
      title="Story Vault"
      className="block h-full w-full border-0"
      allow="clipboard-read; clipboard-write; fullscreen"
    />
  );
}
