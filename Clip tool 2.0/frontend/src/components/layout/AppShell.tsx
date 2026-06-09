"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { Menu, X } from "lucide-react";
import { useAuth } from "@/lib/auth";
import { Sidebar } from "./Sidebar";
import { ThemeModal } from "@/components/theme/ThemeModal";
import { cn } from "@/lib/utils";

export function AppShell({ children }: { children: React.ReactNode }) {
  const router = useRouter();
  const { user, loading, logout: authLogout } = useAuth();
  const [themeOpen, setThemeOpen] = useState(false);
  const [mobileOpen, setMobileOpen] = useState(false);

  // Auth gate — bounce to /login once we know there's no authenticated user.
  useEffect(() => {
    if (!loading && !user) router.replace("/login");
  }, [loading, user, router]);

  const displayEmail = user?.email ?? undefined;

  const logout = () => {
    authLogout();
    router.replace("/login");
  };

  if (loading || !user) {
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
