import { useEffect, useMemo, useRef, useState } from 'react';
import type { KeyboardEvent, ReactNode } from 'react';
import { useReactFlow } from '@xyflow/react';
import {
  Activity,
  CornerDownLeft,
  Download,
  Grid3x3,
  Map as MapIcon,
  Maximize,
  Redo2,
  RotateCcw,
  Search,
  Sparkles,
  Undo2,
  Wand2,
} from 'lucide-react';
import { useStore } from '@/store/useStore';
import { KIND_META, KIND_ORDER } from '@/lib/nodeRegistry';
import { cn } from '@/lib/cn';

interface Cmd {
  id: string;
  label: string;
  group: string;
  icon: ReactNode;
  keywords?: string;
  run: () => void;
}

export function CommandPalette() {
  const open = useStore((s) => s.commandOpen);
  const setOpen = useStore((s) => s.setCommandOpen);
  const nodes = useStore((s) => s.nodes);
  const ui = useStore((s) => s.ui);
  const addNode = useStore((s) => s.addNode);
  const setSelectedNode = useStore((s) => s.setSelectedNode);
  const tidyLayout = useStore((s) => s.tidyLayout);
  const undo = useStore((s) => s.undo);
  const redo = useStore((s) => s.redo);
  const setUi = useStore((s) => s.setUi);
  const loadSample = useStore((s) => s.loadSample);
  const resetWorkflow = useStore((s) => s.resetWorkflow);
  const setExportOpen = useStore((s) => s.setExportOpen);

  const { fitView, setCenter } = useReactFlow();
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  const commands = useMemo<Cmd[]>(() => {
    const dismiss = () => setOpen(false);
    const list: Cmd[] = [
      {
        id: 'tidy',
        label: 'Auto-layout (tidy up)',
        group: 'Actions',
        icon: <Wand2 size={15} />,
        keywords: 'arrange layout organize align',
        run: () => {
          tidyLayout();
          window.setTimeout(() => fitView({ padding: 0.25, maxZoom: 1, duration: 400 }), 0);
          dismiss();
        },
      },
      {
        id: 'fit',
        label: 'Fit view',
        group: 'Actions',
        icon: <Maximize size={15} />,
        keywords: 'zoom center frame',
        run: () => {
          fitView({ padding: 0.25, maxZoom: 1, duration: 400 });
          dismiss();
        },
      },
      { id: 'undo', label: 'Undo', group: 'Actions', icon: <Undo2 size={15} />, run: () => { undo(); dismiss(); } },
      { id: 'redo', label: 'Redo', group: 'Actions', icon: <Redo2 size={15} />, run: () => { redo(); dismiss(); } },
      {
        id: 'search',
        label: `${ui.showSearch ? 'Hide' : 'Show'} search & filters`,
        group: 'Actions',
        icon: <Search size={15} />,
        run: () => { setUi({ showSearch: !ui.showSearch }); dismiss(); },
      },
      {
        id: 'health',
        label: `${ui.showHealth ? 'Hide' : 'Show'} connection health`,
        group: 'Actions',
        icon: <Activity size={15} />,
        run: () => { setUi({ showHealth: !ui.showHealth }); dismiss(); },
      },
      {
        id: 'minimap',
        label: `${ui.showMiniMap ? 'Hide' : 'Show'} mini map`,
        group: 'Actions',
        icon: <MapIcon size={15} />,
        run: () => { setUi({ showMiniMap: !ui.showMiniMap }); dismiss(); },
      },
      {
        id: 'snap',
        label: `${ui.snapToGrid ? 'Disable' : 'Enable'} snap to grid`,
        group: 'Actions',
        icon: <Grid3x3 size={15} />,
        run: () => { setUi({ snapToGrid: !ui.snapToGrid }); dismiss(); },
      },
      {
        id: 'export',
        label: 'Export workflow…',
        group: 'Actions',
        icon: <Download size={15} />,
        keywords: 'claude cursor json markdown checklist prompt',
        run: () => { setExportOpen(true); dismiss(); },
      },
      {
        id: 'sample',
        label: 'Load sample workflow',
        group: 'Actions',
        icon: <Sparkles size={15} />,
        run: () => { loadSample(); dismiss(); },
      },
      {
        id: 'reset',
        label: 'Reset workflow…',
        group: 'Actions',
        icon: <RotateCcw size={15} />,
        run: () => {
          if (window.confirm('Clear the entire workflow? This cannot be undone.')) resetWorkflow();
          dismiss();
        },
      },
    ];

    KIND_ORDER.forEach((kind) => {
      const meta = KIND_META[kind];
      const Icon = meta.icon;
      list.push({
        id: 'add-' + kind,
        label: 'Add ' + meta.label,
        group: 'Create node',
        icon: <Icon size={15} style={{ color: meta.color }} />,
        keywords: 'new create ' + kind,
        run: () => { addNode(kind); dismiss(); },
      });
    });

    nodes.forEach((n) => {
      const meta = KIND_META[n.data.kind];
      const Icon = meta.icon;
      list.push({
        id: 'go-' + n.id,
        label: 'Go to: ' + (n.data.title || meta.label),
        group: 'Navigate',
        icon: <Icon size={15} style={{ color: meta.color }} />,
        keywords: meta.label + ' ' + n.data.tags.join(' '),
        run: () => {
          setSelectedNode(n.id);
          setCenter(n.position.x + 124, n.position.y + 70, { zoom: 1.1, duration: 500 });
          dismiss();
        },
      });
    });

    return list;
  }, [
    nodes, ui, addNode, setSelectedNode, tidyLayout, undo, redo, setUi,
    loadSample, resetWorkflow, setExportOpen, fitView, setCenter, setOpen,
  ]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return commands;
    return commands.filter((c) =>
      `${c.label} ${c.group} ${c.keywords ?? ''}`.toLowerCase().includes(q),
    );
  }, [commands, query]);

  useEffect(() => {
    if (open) {
      setQuery('');
      setActive(0);
      requestAnimationFrame(() => inputRef.current?.focus());
    }
  }, [open]);

  useEffect(() => setActive(0), [query]);

  useEffect(() => {
    const el = listRef.current?.querySelector(`[data-idx="${active}"]`) as HTMLElement | null;
    el?.scrollIntoView({ block: 'nearest' });
  }, [active]);

  if (!open) return null;

  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setActive((a) => Math.min(a + 1, filtered.length - 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setActive((a) => Math.max(a - 1, 0));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      filtered[active]?.run();
    } else if (e.key === 'Escape') {
      e.preventDefault();
      setOpen(false);
    }
  };

  return (
    <div
      className="fixed inset-0 z-[60] flex items-start justify-center bg-black/60 p-4 pt-[12vh] backdrop-blur-sm"
      onMouseDown={() => setOpen(false)}
    >
      <div
        className="panel animate-fade-in flex w-full max-w-xl flex-col overflow-hidden"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="flex items-center gap-2 border-b border-line px-3">
          <Search size={16} className="shrink-0 text-muted" />
          <input
            ref={inputRef}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={onKeyDown}
            placeholder="Type a command or search nodes…"
            className="w-full bg-transparent py-3 text-sm text-ink outline-none placeholder:text-muted/60"
          />
          <kbd className="hidden rounded border border-line px-1.5 py-0.5 text-[10px] text-muted sm:block">ESC</kbd>
        </div>

        <div ref={listRef} className="max-h-[50vh] overflow-y-auto p-1.5">
          {filtered.length === 0 && (
            <div className="px-3 py-8 text-center text-sm text-muted">No matches.</div>
          )}
          {filtered.map((c, i) => {
            const showGroup = i === 0 || filtered[i - 1].group !== c.group;
            return (
              <div key={c.id}>
                {showGroup && <div className="label px-2.5 pb-1 pt-2">{c.group}</div>}
                <button
                  type="button"
                  data-idx={i}
                  onMouseEnter={() => setActive(i)}
                  onClick={() => c.run()}
                  className={cn(
                    'flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-left text-sm transition-colors',
                    i === active ? 'bg-brand/15' : 'hover:bg-white/5',
                  )}
                >
                  <span className="flex h-6 w-6 shrink-0 items-center justify-center text-muted">
                    {c.icon}
                  </span>
                  <span className="min-w-0 flex-1 truncate text-ink">{c.label}</span>
                  {i === active && <CornerDownLeft size={13} className="shrink-0 text-muted" />}
                </button>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
