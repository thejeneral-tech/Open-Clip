"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { useQuery } from "@tanstack/react-query";
import { Menu, X } from "lucide-react";
import { api } from "@/lib/api";
import { clearTokens, getUserEmail, isAuthed } from "@/lib/auth";
import { Sidebar } from "./Sidebar";
import { ThemeModal } from "@/components/theme/ThemeModal";
import { cn } from "@/lib/utils";

export function AppShell({ children }: { children: React.ReactNode }) {
  const router = useRouter();
  const [ready, setReady] = useState(false);
  const [themeOpen, setThemeOpen] = useState(false);
  const [mobileOpen, setMobileOpen] = useState(false);

  // Auth gate — bounce to /login when there's no token.
  useEffect(() => {
    if (!isAuthed()) {
      router.replace("/login");
      return;
    }
    setReady(true);
  }, [router]);

  const { data: user } = useQuery({
    queryKey: ["me"],
    queryFn: api.me,
    enabled: ready,
    retry: false,
  });

  // Prefer the live /auth/me email; fall back to the remembered login email
  // (the seeded `.local` admin makes /auth/me 500 on the backend).
  const displayEmail = user?.email ?? getUserEmail() ?? undefined;

  const logout = () => {
    clearTokens();
    router.replace("/login");
  };

  if (!ready) {
    return (
      <div className="grid h-screen place-items-center text-muted">
        <span className="animate-pulse text-sm">Loading…</span>
      </div>
    );
  }

  return (
    <div className="flex h-screen overflow-hidden">
      {/* Desktop sidebar */}
      <div className="hidden md:flex">
        <Sidebar onOpenTheme={() => setThemeOpen(true)} onLogout={logout} userEmail={displayEmail} />
      </div>

      {/* Mobile sidebar drawer */}
      <div
        className={cn(
          "fixed inset-0 z-40 md:hidden",
          mobileOpen ? "pointer-events-auto" : "pointer-events-none",
        )}
      >
        <div
          className={cn(
            "absolute inset-0 bg-black/50 transition-opacity",
            mobileOpen ? "opacity-100" : "opacity-0",
          )}
          onClick={() => setMobileOpen(false)}
        />
        <div
          className={cn(
            "absolute left-0 top-0 h-full transition-transform",
            mobileOpen ? "translate-x-0" : "-translate-x-full",
          )}
        >
          <Sidebar
            onOpenTheme={() => {
              setThemeOpen(true);
              setMobileOpen(false);
            }}
            onLogout={logout}
            userEmail={displayEmail}
            onNavigate={() => setMobileOpen(false)}
          />
        </div>
      </div>

      {/* Main column */}
      <div className="flex min-w-0 flex-1 flex-col">
        {/* Mobile top bar */}
        <div className="flex items-center gap-2 border-b border-border px-4 py-2.5 md:hidden">
          <button
            type="button"
            className="oc-btn oc-btn-ghost h-9 w-9 !p-0"
            onClick={() => setMobileOpen((s) => !s)}
            aria-label="Menu"
          >
            {mobileOpen ? <X size={18} /> : <Menu size={18} />}
          </button>
          <span className="text-sm font-semibold">OpenClip</span>
        </div>

        <main className="relative z-10 flex-1 overflow-y-auto">{children}</main>
      </div>

      <ThemeModal open={themeOpen} onClose={() => setThemeOpen(false)} />
    </div>
  );
}
