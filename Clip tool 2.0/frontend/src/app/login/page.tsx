"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Clapperboard, Loader2, Palette } from "lucide-react";
import { api, ApiError } from "@/lib/api";
import { ThemeModal } from "@/components/theme/ThemeModal";

export default function LoginPage() {
  const router = useRouter();
  const [email, setEmail] = useState("admin@openclip.local");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [themeOpen, setThemeOpen] = useState(false);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setLoading(true);
    try {
      await api.login(email.trim(), password);
      router.replace("/");
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Login failed");
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="relative z-10 grid min-h-screen place-items-center p-4">
      <button
        type="button"
        onClick={() => setThemeOpen(true)}
        className="oc-btn oc-btn-ghost absolute right-4 top-4 h-9 w-9 !p-0"
        aria-label="Themes"
        title="Themes"
      >
        <Palette size={18} />
      </button>

      <div className="oc-surface w-full max-w-sm rounded-2xl p-7 shadow-2xl animate-pop-in">
        <div className="mb-6 flex flex-col items-center text-center">
          <span className="mb-3 grid h-12 w-12 place-items-center rounded-xl" style={{ background: "var(--brand-color)" }}>
            <Clapperboard size={24} className="text-[var(--accent-contrast)]" />
          </span>
          <h1 className="text-xl font-semibold text-fg">Welcome to OpenClip</h1>
          <p className="mt-1 text-sm text-muted">Sign in to your clip studio</p>
        </div>

        <form onSubmit={submit} className="space-y-3">
          <label className="flex flex-col gap-1">
            <span className="text-xs font-medium text-muted">Email</span>
            <input
              type="email"
              className="oc-input w-full"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              autoComplete="username"
              required
            />
          </label>
          <label className="flex flex-col gap-1">
            <span className="text-xs font-medium text-muted">Password</span>
            <input
              type="password"
              className="oc-input w-full"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              autoComplete="current-password"
              placeholder="••••••••"
              required
            />
          </label>

          {error && (
            <p className="rounded-md border border-[var(--red)] bg-[color-mix(in_srgb,var(--red)_12%,transparent)] px-3 py-2 text-xs text-[var(--red)]">
              {error}
            </p>
          )}

          <button type="submit" className="oc-btn oc-btn-primary w-full" disabled={loading}>
            {loading ? <Loader2 size={16} className="animate-spin" /> : null}
            {loading ? "Signing in…" : "Sign in"}
          </button>
        </form>

        <p className="mt-5 text-center text-[11px] text-muted">
          First boot seeds <span className="font-mono text-fg">admin@openclip.local</span> / <span className="font-mono text-fg">changeme</span>
        </p>
      </div>

      <ThemeModal open={themeOpen} onClose={() => setThemeOpen(false)} />
    </div>
  );
}
