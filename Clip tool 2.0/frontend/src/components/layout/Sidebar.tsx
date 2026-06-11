"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import {
  BookOpen,
  Bot,
  Clapperboard,
  Compass,
  Cpu,
  Film,
  FolderKanban,
  LayoutDashboard,
  LogOut,
  Mic,
  Minus,
  Palette,
  Plus,
  Send,
  Settings,
  Sparkles,
} from "lucide-react";
import { cn } from "@/lib/utils";

interface NavItem {
  href: string;
  label: string;
  icon: React.ComponentType<{ size?: number; className?: string }>;
  soon?: boolean;
}

interface NavSection {
  id: string;
  label: string;
  items: NavItem[];
}

const SECTIONS: NavSection[] = [
  {
    id: "openclip",
    label: "OpenClip",
    items: [
      { href: "/dashboard", label: "Dashboard", icon: LayoutDashboard },
      { href: "/projects", label: "Projects", icon: FolderKanban },
      { href: "/bots", label: "Bots", icon: Bot },
      { href: "/discovery", label: "Discovery", icon: Compass },
      { href: "/publishing", label: "Publishing", icon: Send },
    ],
  },
  {
    id: "storyvault",
    label: "Story Vault",
    items: [
      { href: "/storyvault/command", label: "Dashboard", icon: LayoutDashboard },
      { href: "/storyvault/library", label: "Story Library", icon: BookOpen },
      { href: "/storyvault/footage", label: "Footage Library", icon: Film },
      { href: "/storyvault/studio", label: "Video Studio", icon: Clapperboard },
      { href: "/storyvault/voicelab", label: "Voice Lab", icon: Mic },
      { href: "/storyvault/presets", label: "Presets", icon: Sparkles },
      { href: "/storyvault/publishing", label: "Publishing", icon: Send },
    ],
  },
];

const BOTTOM_ITEMS: NavItem[] = [
  { href: "/models", label: "Models & GPU", icon: Cpu },
  { href: "/settings", label: "Settings", icon: Settings },
];

const COLLAPSE_KEY = "openclip_nav_sections";

function loadCollapsed(): Record<string, boolean> {
  try {
    return JSON.parse(localStorage.getItem(COLLAPSE_KEY) || "{}");
  } catch {
    return {};
  }
}

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
  // Collapse state hydrates from localStorage after mount (SSR has no storage).
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});
  useEffect(() => {
    setCollapsed(loadCollapsed());
  }, []);

  const toggleSection = (id: string) => {
    setCollapsed((prev) => {
      const next = { ...prev, [id]: !prev[id] };
      try {
        localStorage.setItem(COLLAPSE_KEY, JSON.stringify(next));
      } catch {
        /* storage unavailable */
      }
      return next;
    });
  };

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
      <nav className="flex-1 space-y-1 overflow-y-auto px-2.5 py-2">
        {SECTIONS.map((section) => {
          const isCollapsed = !!collapsed[section.id];
          const sectionActive = section.items.some((item) =>
            item.href === "/" ? pathname === "/" : pathname.startsWith(item.href),
          );
          return (
            <div key={section.id}>
              <button
                type="button"
                onClick={() => toggleSection(section.id)}
                aria-expanded={!isCollapsed}
                className={cn(
                  "flex w-full items-center justify-between rounded-lg px-3 py-1.5 text-[11px] font-semibold uppercase tracking-widest transition hover:bg-[var(--hover-bg)]",
                  sectionActive && isCollapsed ? "text-fg" : "text-muted",
                )}
                title={isCollapsed ? `Expand ${section.label}` : `Collapse ${section.label}`}
              >
                <span>{section.label}</span>
                {isCollapsed ? <Plus size={13} /> : <Minus size={13} />}
              </button>
              {!isCollapsed && (
                <div className="space-y-0.5 pb-1.5">
                  {section.items.map((item) => {
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
                </div>
              )}
            </div>
          );
        })}
      </nav>

      {/* Footer */}
      <div className="space-y-1 border-t border-border p-2.5">
        {BOTTOM_ITEMS.map((item) => {
          const active = pathname.startsWith(item.href);
          const Icon = item.icon;
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
