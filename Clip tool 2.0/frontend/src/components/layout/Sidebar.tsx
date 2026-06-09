"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import {
  Bot,
  Clapperboard,
  Compass,
  Cpu,
  LayoutDashboard,
  LogOut,
  Palette,
  Scissors,
  Send,
  Settings,
  Video,
} from "lucide-react";
import { cn } from "@/lib/utils";

interface NavItem {
  href: string;
  label: string;
  icon: React.ComponentType<{ size?: number; className?: string }>;
  soon?: boolean;
}

const NAV: NavItem[] = [
  { href: "/", label: "Dashboard", icon: LayoutDashboard },
  { href: "/videos", label: "Videos", icon: Video },
  { href: "/clips", label: "Clips", icon: Scissors, soon: true },
  { href: "/bots", label: "Bots", icon: Bot, soon: true },
  { href: "/discovery", label: "Discovery", icon: Compass, soon: true },
  { href: "/publishing", label: "Publishing", icon: Send, soon: true },
  { href: "/models", label: "Models & GPU", icon: Cpu, soon: true },
  { href: "/settings", label: "Settings", icon: Settings, soon: true },
];

export function Sidebar({
  onOpenTheme,
  onLogout,
  userEmail,
  onNavigate,
}: {
  onOpenTheme: () => void;
  onLogout: () => void;
  userEmail?: string;
  onNavigate?: () => void;
}) {
  const pathname = usePathname();

  return (
    <aside className="oc-surface flex h-full w-60 shrink-0 flex-col" style={{ background: "var(--sidebar-bg)" }}>
      {/* Brand */}
      <div className="flex items-center gap-2.5 px-4 py-4">
        <span className="grid h-8 w-8 place-items-center rounded-lg" style={{ background: "var(--brand-color)" }}>
          <Clapperboard size={18} className="text-[var(--accent-contrast)]" />
        </span>
        <div className="leading-tight">
          <div className="text-sm font-semibold text-fg">OpenClip</div>
          <div className="text-[10px] uppercase tracking-widest text-muted">Clip Studio</div>
        </div>
      </div>

      {/* Nav */}
      <nav className="flex-1 space-y-0.5 overflow-y-auto px-2.5 py-2">
        {NAV.map((item) => {
          const active = item.href === "/" ? pathname === "/" : pathname.startsWith(item.href);
          const Icon = item.icon;
          if (item.soon) {
            return (
              <div
                key={item.href}
                className="flex cursor-not-allowed items-center gap-3 rounded-lg px-3 py-2 text-sm text-muted opacity-60"
                title="Coming soon"
              >
                <Icon size={17} />
                <span>{item.label}</span>
                <span className="ml-auto rounded bg-[var(--hover-bg)] px-1.5 py-0.5 text-[9px] uppercase tracking-wide">
                  soon
                </span>
              </div>
            );
          }
          return (
            <Link
              key={item.href}
              href={item.href}
              onClick={onNavigate}
              className={cn(
                "flex items-center gap-3 rounded-lg px-3 py-2 text-sm transition",
                active
                  ? "font-medium text-[var(--accent-contrast)]"
                  : "text-fg hover:bg-[var(--hover-bg)]",
              )}
              style={active ? { background: "var(--red)" } : undefined}
            >
              <Icon size={17} />
              <span>{item.label}</span>
            </Link>
          );
        })}
      </nav>

      {/* Footer */}
      <div className="space-y-1 border-t border-border p-2.5">
        <button
          type="button"
          onClick={onOpenTheme}
          className="flex w-full items-center gap-3 rounded-lg px-3 py-2 text-sm text-fg transition hover:bg-[var(--hover-bg)]"
        >
          <Palette size={17} />
          <span>Themes</span>
        </button>
        <div className="flex items-center gap-2 rounded-lg px-3 py-2">
          <span className="grid h-7 w-7 shrink-0 place-items-center rounded-full text-xs font-semibold" style={{ background: "var(--hover-bg)" }}>
            {(userEmail || "?").charAt(0).toUpperCase()}
          </span>
          <span className="min-w-0 flex-1 truncate text-xs text-muted" title={userEmail}>
            {userEmail || "Not signed in"}
          </span>
          <button
            type="button"
            onClick={onLogout}
            title="Sign out"
            className="rounded p-1 text-muted transition hover:bg-[var(--hover-bg)] hover:text-[var(--red)]"
          >
            <LogOut size={15} />
          </button>
        </div>
      </div>
    </aside>
  );
}
