import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useReactFlow } from '@xyflow/react';
import {
  Activity,
  Boxes,
  Check,
  Command,
  Copy,
  Download,
  FileUp,
  Grid3x3,
  Map as MapIcon,
  Maximize,
  Plus,
  Redo2,
  RotateCcw,
  Search,
  Sparkles,
  Undo2,
  Wand2,
  X,
} from 'lucide-react';
import { useStore } from '@/store/useStore';
import { KIND_META, KIND_ORDER } from '@/lib/nodeRegistry';
import { EXPORTERS, runExport, type ExportFormat } from '@/lib/exporters';
import {
  copyToClipboard,
  parseWorkflowFile,
  readTextFile,
  triggerDownload,
} from '@/lib/storage';
import { cn } from '@/lib/cn';
import { BoardSwitcher } from '@/components/BoardSwitcher';

/* ------------------------------------------------------------------ */
/* Add-node dropdown                                                   */
/* ------------------------------------------------------------------ */

function AddNodeMenu() {
  const addNode = useStore((s) => s.addNode);
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;

    const onPointerDown = (e: MouseEvent) => {
      if (!containerRef.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };

    document.addEventListener('mousedown', onPointerDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('mousedown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [open]);

  const handlePick = useCallback(
    (kind: (typeof KIND_ORDER)[number]) => {
      addNode(kind);
      setOpen(false);
    },
    [addNode],
  );

  return (
    <div ref={containerRef} className="relative">
      <button
        type="button"
        className="btn btn-primary"
        onClick={() => setOpen((v) => !v)}
        aria-haspopup="menu"
        aria-expanded={open}
      >
        <Plus size={16} />
        Add node
      </button>

      {open && (
        <div
          role="menu"
          className="panel animate-fade-in absolute left-0 top-[calc(100%+8px)] z-40 max-h-[70vh] w-60 overflow-y-auto p-1.5"
        >
          {KIND_ORDER.map((kind) => {
            const meta = KIND_META[kind];
            const Icon = meta.icon;
            return (
              <button
                key={kind}
                type="button"
                role="menuitem"
                className="flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-left text-sm text-ink transition-colors hover:bg-white/5"
                onClick={() => handlePick(kind)}
              >
                <span
                  className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md"
                  style={{ backgroundColor: meta.color + '22', color: meta.color }}
                >
                  <Icon size={15} />
                </span>
                <span className="min-w-0 flex-1 truncate">{meta.label}</span>
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Export dialog                                                       */
/* ------------------------------------------------------------------ */

function ExportDialog() {
  const nodes = useStore((s) => s.nodes);
  const edges = useStore((s) => s.edges);
  const spaces = useStore((s) => s.spaces);
  const onClose = useStore((s) => s.setExportOpen);
  const close = useCallback(() => onClose(false), [onClose]);

  const [format, setFormat] = useState<ExportFormat>('claude');
  const [copied, setCopied] = useState(false);

  const descriptor = useMemo(
    () => EXPORTERS.find((e) => e.id === format) ?? EXPORTERS[0],
    [format],
  );

  const text = useMemo(
    () => runExport(format, nodes, edges, spaces, new Date().toISOString()),
    [format, nodes, edges, spaces],
  );

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') close();
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [close]);

  // Reset the transient "Copied!" state whenever the format (and thus text) changes.
  useEffect(() => {
    setCopied(false);
  }, [format]);

  const handleCopy = useCallback(async () => {
    const ok = await copyToClipboard(text);
    if (ok) {
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1600);
    }
  }, [text]);

  const handleDownload = useCallback(() => {
    triggerDownload(
      'codeflow-workflow.' + descriptor.extension,
      text,
      descriptor.id === 'json' ? 'application/json' : 'text/markdown',
    );
  }, [descriptor, text]);

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4 backdrop-blur-sm"
      onMouseDown={close}
      role="dialog"
      aria-modal="true"
      aria-label="Export workflow"
    >
      <div
        className="panel animate-fade-in flex max-h-[90vh] w-full max-w-2xl flex-col p-5"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between gap-3">
          <div className="flex items-center gap-2">
            <Download size={16} className="text-brand" />
            <h2 className="text-base font-semibold text-ink">Export workflow</h2>
          </div>
          <button
            type="button"
            className="icon-btn"
            onClick={close}
            title="Close"
            aria-label="Close"
          >
            <X size={16} />
          </button>
        </div>

        <div className="mt-4 flex flex-wrap gap-1.5">
          {EXPORTERS.map((exp) => (
            <button
              key={exp.id}
              type="button"
              className={cn(
                'btn',
                format === exp.id ? 'btn-primary' : 'btn-ghost',
              )}
              aria-pressed={format === exp.id}
              onClick={() => setFormat(exp.id)}
            >
              {exp.label}
            </button>
          ))}
        </div>

        <p className="mt-3 text-sm text-muted">{descriptor.description}</p>

        <textarea
          readOnly
          value={text}
          spellCheck={false}
          className="input mt-3 h-80 resize-none font-mono text-xs leading-relaxed"
          onFocus={(e) => e.currentTarget.select()}
        />

        <div className="mt-4 flex items-center justify-end gap-2">
          <button type="button" className="btn btn-outline" onClick={handleCopy}>
            {copied ? <Check size={15} /> : <Copy size={15} />}
            {copied ? 'Copied!' : 'Copy'}
          </button>
          <button type="button" className="btn btn-primary" onClick={handleDownload}>
            <Download size={15} />
            Download
          </button>
        </div>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Toolbar                                                             */
/* ------------------------------------------------------------------ */

export function Toolbar() {
  const nodeCount = useStore((s) => s.nodes.length);
  const snapToGrid = useStore((s) => s.ui.snapToGrid);
  const showMiniMap = useStore((s) => s.ui.showMiniMap);
  const showSearch = useStore((s) => s.ui.showSearch);
  const showHealth = useStore((s) => s.ui.showHealth);
  const setUi = useStore((s) => s.setUi);
  const loadSample = useStore((s) => s.loadSample);
  const resetWorkflow = useStore((s) => s.resetWorkflow);
  const importWorkflow = useStore((s) => s.importWorkflow);
  const undo = useStore((s) => s.undo);
  const redo = useStore((s) => s.redo);
  const tidyLayout = useStore((s) => s.tidyLayout);
  const canUndo = useStore((s) => s.past.length > 0);
  const canRedo = useStore((s) => s.future.length > 0);
  const exportOpen = useStore((s) => s.exportOpen);
  const setExportOpen = useStore((s) => s.setExportOpen);
  const setCommandOpen = useStore((s) => s.setCommandOpen);

  const { fitView } = useReactFlow();
  const fileInputRef = useRef<HTMLInputElement>(null);

  const handleTidy = useCallback(() => {
    tidyLayout();
    window.setTimeout(() => fitView({ padding: 0.25, duration: 400, maxZoom: 1 }), 0);
  }, [tidyLayout, fitView]);

  const handleReset = useCallback(() => {
    if (window.confirm('Clear the entire workflow? This cannot be undone.')) {
      resetWorkflow();
    }
  }, [resetWorkflow]);

  const handleImportClick = useCallback(() => {
    fileInputRef.current?.click();
  }, []);

  const handleImportFile = useCallback(
    async (e: React.ChangeEvent<HTMLInputElement>) => {
      const input = e.currentTarget;
      const file = input.files?.[0];
      if (!file) return;
      try {
        const raw = await readTextFile(file);
        const workflow = parseWorkflowFile(raw);
        importWorkflow(workflow);
      } catch (err) {
        window.alert(
          'Could not import workflow: ' +
            (err instanceof Error ? err.message : 'Unknown error.'),
        );
      } finally {
        input.value = '';
      }
    },
    [importWorkflow],
  );

  return (
    <header className="z-30 flex h-14 shrink-0 items-center justify-between gap-3 border-b border-line bg-surface px-4">
      {/* Left: brand + board switcher */}
      <div className="flex min-w-0 items-center gap-2">
        <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-gradient-to-br from-brand to-brand-600 shadow-glow">
          <Boxes size={18} className="text-white" />
        </div>
        <div className="hidden leading-tight lg:block">
          <div className="font-semibold text-ink">CodeFlow Canvas</div>
          <div className="text-[11px] text-muted">
            {nodeCount} {nodeCount === 1 ? 'node' : 'nodes'}
          </div>
        </div>
        <div className="mx-1 hidden h-6 w-px bg-line sm:block" />
        <BoardSwitcher />
      </div>

      {/* Center: add node + command palette */}
      <div className="flex items-center gap-2">
        <AddNodeMenu />
        <button
          type="button"
          className="btn btn-outline"
          title="Command palette (Ctrl/Cmd+K)"
          onClick={() => setCommandOpen(true)}
        >
          <Command size={15} />
          <span className="hidden md:inline">Commands</span>
        </button>
      </div>

      {/* Right: tools */}
      <div className="flex items-center gap-1">
        <ToggleButton
          active={snapToGrid}
          title="Snap to grid"
          onClick={() => setUi({ snapToGrid: !snapToGrid })}
        >
          <Grid3x3 size={16} />
        </ToggleButton>
        <ToggleButton
          active={showMiniMap}
          title="Mini map"
          onClick={() => setUi({ showMiniMap: !showMiniMap })}
        >
          <MapIcon size={16} />
        </ToggleButton>
        <ToggleButton
          active={showSearch}
          title="Search & filters"
          onClick={() => setUi({ showSearch: !showSearch })}
        >
          <Search size={16} />
        </ToggleButton>
        <ToggleButton
          active={showHealth}
          title="Health panel"
          onClick={() => setUi({ showHealth: !showHealth })}
        >
          <Activity size={16} />
        </ToggleButton>
        <button
          type="button"
          className="icon-btn"
          title="Fit view"
          onClick={() => fitView({ padding: 0.2, duration: 300, maxZoom: 1 })}
        >
          <Maximize size={16} />
        </button>
        <button
          type="button"
          className="icon-btn"
          title="Auto-layout (tidy up)"
          onClick={handleTidy}
        >
          <Wand2 size={16} />
        </button>

        <div className="mx-1.5 h-6 w-px bg-line" />

        <button
          type="button"
          className="icon-btn"
          title="Undo (Ctrl/Cmd+Z)"
          disabled={!canUndo}
          onClick={() => undo()}
        >
          <Undo2 size={16} />
        </button>
        <button
          type="button"
          className="icon-btn"
          title="Redo (Ctrl/Cmd+Shift+Z)"
          disabled={!canRedo}
          onClick={() => redo()}
        >
          <Redo2 size={16} />
        </button>

        <div className="mx-1.5 h-6 w-px bg-line" />

        <button
          type="button"
          className="btn btn-ghost"
          title="Load the sample workflow"
          onClick={() => loadSample()}
        >
          <Sparkles size={15} />
          Sample
        </button>
        <button
          type="button"
          className="btn btn-ghost"
          title="Clear the workflow"
          onClick={handleReset}
        >
          <RotateCcw size={15} />
          Reset
        </button>
        <button
          type="button"
          className="btn btn-outline"
          title="Import a workflow JSON file"
          onClick={handleImportClick}
        >
          <FileUp size={15} />
          Import
        </button>
        <button
          type="button"
          className="btn btn-primary"
          title="Export the workflow"
          onClick={() => setExportOpen(true)}
        >
          <Download size={15} />
          Export
        </button>

        <div
          className="ml-2 hidden items-center gap-1.5 text-[11px] font-medium text-muted sm:flex"
          title="Saved automatically to this browser"
        >
          <Check size={13} className="text-emerald-400" />
          Saved
        </div>

        <input
          ref={fileInputRef}
          type="file"
          accept=".json,application/json"
          className="hidden"
          onChange={handleImportFile}
        />
      </div>

      {exportOpen && <ExportDialog />}
    </header>
  );
}

/* ------------------------------------------------------------------ */
/* Small toggle icon-button                                            */
/* ------------------------------------------------------------------ */

function ToggleButton({
  active,
  title,
  onClick,
  children,
}: {
  active: boolean;
  title: string;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      title={title}
      aria-label={title}
      aria-pressed={active}
      onClick={onClick}
      className={cn('icon-btn', active && 'bg-brand/15 text-brand hover:bg-brand/20 hover:text-brand')}
    >
      {children}
    </button>
  );
}
