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
  FolderKanban,
  LayoutDashboard,
  LogOut,
  Mic,
  Minus,
  Palette,
  PanelLeftClose,
  PanelLeftOpen,
  Plus,
  Send,
  Settings,
  Sparkles,
  Type,
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
      { href: "/presets", label: "Presets", icon: Type },
      { href: "/publishing", label: "Publishing", icon: Send },
    ],
  },
  {
    id: "storyvault",
    label: "Story Vault",
    items: [
      { href: "/storyvault/command", label: "Dashboard", icon: LayoutDashboard },
      { href: "/storyvault/projects", label: "Projects", icon: FolderKanban },
      { href: "/storyvault/library", label: "Library", icon: BookOpen },
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
  collapsed = false,
  onToggleCollapse,
}: {
  onOpenTheme: () => void;
  onLogout: () => void;
  userEmail?: string;
  onNavigate?: () => void;
  /** Icon-rail mode — labels and section headers hide, items keep tooltips. */
  collapsed?: boolean;
  onToggleCollapse?: () => void;
}) {
  const pathname = usePathname();
  // Section collapse state hydrates from localStorage after mount (SSR has no storage).
  const [sectionsCollapsed, setSectionsCollapsed] = useState<Record<string, boolean>>({});
  useEffect(() => {
    setSectionsCollapsed(loadCollapsed());
  }, []);

  const toggleSection = (id: string) => {
    setSectionsCollapsed((prev) => {
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
    <aside
      className={cn(
        "oc-surface flex h-full shrink-0 flex-col transition-[width] duration-200",
        collapsed ? "w-[68px]" : "w-60",
      )}
      style={{ background: "var(--sidebar-bg)" }}
    >
      {/* Brand */}
      <div className={cn("flex items-center gap-2.5 px-4 py-4", collapsed && "flex-col gap-2 px-2")}>
        <span className="grid h-8 w-8 shrink-0 place-items-center rounded-lg" style={{ background: "var(--brand-color)" }}>
          <Clapperboard size={18} className="text-[var(--accent-contrast)]" />
        </span>
        {!collapsed && (
          <div className="min-w-0 flex-1 leading-tight">
            <div className="text-sm font-semibold text-fg">OpenClip</div>
            <div className="text-[10px] uppercase tracking-widest text-muted">Clip Studio</div>
          </div>
        )}
        {onToggleCollapse && (
          <button
            type="button"
            onClick={onToggleCollapse}
            title={collapsed ? "Expand sidebar" : "Collapse sidebar"}
            aria-label={collapsed ? "Expand sidebar" : "Collapse sidebar"}
            className="rounded-lg p-1.5 text-muted transition hover:bg-[var(--hover-bg)] hover:text-fg"
          >
            {collapsed ? <PanelLeftOpen size={16} /> : <PanelLeftClose size={16} />}
          </button>
        )}
      </div>

      {/* Nav */}
      <nav className={cn("flex-1 space-y-1 overflow-y-auto py-2", collapsed ? "px-2" : "px-2.5")}>
        {SECTIONS.map((section, index) => {
          const isCollapsed = !collapsed && !!sectionsCollapsed[section.id];
          const sectionActive = section.items.some((item) =>
            item.href === "/" ? pathname === "/" : pathname.startsWith(item.href),
          );
          return (
            <div key={section.id}>
              {collapsed ? (
                index > 0 && <div className="mx-2 my-2 border-t border-border" />
              ) : (
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
              )}
              {!isCollapsed && (
                <div className="space-y-0.5 pb-1.5">
                  {section.items.map((item) => {
                    const active = item.href === "/" ? pathname === "/" : pathname.startsWith(item.href);
                    const Icon = item.icon;
                    if (item.soon) {
                      return (
                        <div
                          key={item.href}
                          className={cn(
                            "flex cursor-not-allowed items-center gap-3 rounded-lg px-3 py-2 text-sm text-muted opacity-60",
                            collapsed && "justify-center px-0",
                          )}
                          title={collapsed ? `${item.label} — coming soon` : "Coming soon"}
                        >
                          <Icon size={17} />
                          {!collapsed && (
                            <>
                              <span>{item.label}</span>
                              <span className="ml-auto rounded bg-[var(--hover-bg)] px-1.5 py-0.5 text-[9px] uppercase tracking-wide">
                                soon
                              </span>
                            </>
                          )}
                        </div>
                      );
                    }
                    return (
                      <Link
                        key={item.href}
                        href={item.href}
                        onClick={onNavigate}
                        title={collapsed ? `${section.label} · ${item.label}` : undefined}
                        className={cn(
                          "flex items-center gap-3 rounded-lg px-3 py-2 text-sm transition",
                          collapsed && "justify-center px-0",
                          active
                            ? "font-medium text-[var(--accent-contrast)]"
                            : "text-fg hover:bg-[var(--hover-bg)]",
                        )}
                        style={active ? { background: "var(--red)" } : undefined}
                      >
                        <Icon size={17} />
                        {!collapsed && <span>{item.label}</span>}
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
      <div className={cn("space-y-1 border-t border-border", collapsed ? "p-2" : "p-2.5")}>
        {BOTTOM_ITEMS.map((item) => {
          const active = pathname.startsWith(item.href);
          const Icon = item.icon;
          return (
            <Link
              key={item.href}
              href={item.href}
              onClick={onNavigate}
              title={collapsed ? item.label : undefined}
              className={cn(
                "flex items-center gap-3 rounded-lg px-3 py-2 text-sm transition",
                collapsed && "justify-center px-0",
                active
                  ? "font-medium text-[var(--accent-contrast)]"
                  : "text-fg hover:bg-[var(--hover-bg)]",
              )}
              style={active ? { background: "var(--red)" } : undefined}
            >
              <Icon size={17} />
              {!collapsed && <span>{item.label}</span>}
            </Link>
          );
        })}
        <button
          type="button"
          onClick={onOpenTheme}
          title={collapsed ? "Themes" : undefined}
          className={cn(
            "flex w-full items-center gap-3 rounded-lg px-3 py-2 text-sm text-fg transition hover:bg-[var(--hover-bg)]",
            collapsed && "justify-center px-0",
          )}
        >
          <Palette size={17} />
          {!collapsed && <span>Themes</span>}
        </button>
        <div className={cn("flex items-center gap-2 rounded-lg px-3 py-2", collapsed && "flex-col gap-1.5 px-0")}>
          <span
            className="grid h-7 w-7 shrink-0 place-items-center rounded-full text-xs font-semibold"
            style={{ background: "var(--hover-bg)" }}
            title={collapsed ? userEmail : undefined}
          >
            {(userEmail || "?").charAt(0).toUpperCase()}
          </span>
          {!collapsed && (
            <span className="min-w-0 flex-1 truncate text-xs text-muted" title={userEmail}>
              {userEmail || "Not signed in"}
            </span>
          )}
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
