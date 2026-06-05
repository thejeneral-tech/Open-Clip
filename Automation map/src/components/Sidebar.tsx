import { useEffect, useMemo, useRef, useState } from 'react';
import { Plus, X, Layers, Check } from 'lucide-react';
import { useStore } from '@/store/useStore';
import { KIND_META, KIND_ORDER } from '@/lib/nodeRegistry';
import { cn } from '@/lib/cn';
import type { NodeKind } from '@/types';

export function Sidebar() {
  const spaces = useStore((s) => s.spaces);
  const nodes = useStore((s) => s.nodes);
  const activeSpace = useStore((s) => s.activeSpace);

  const setActiveSpace = useStore((s) => s.setActiveSpace);
  const addSpace = useStore((s) => s.addSpace);
  const renameSpace = useStore((s) => s.renameSpace);
  const deleteSpace = useStore((s) => s.deleteSpace);
  const addNode = useStore((s) => s.addNode);

  /* Per-space node counts (recomputed only when nodes change). */
  const countsBySpace = useMemo(() => {
    const map = new Map<string, number>();
    for (const n of nodes) {
      map.set(n.data.space, (map.get(n.data.space) ?? 0) + 1);
    }
    return map;
  }, [nodes]);

  /* ---- create-space inline input ---- */
  const [creating, setCreating] = useState(false);
  const [draftName, setDraftName] = useState('');
  const createRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (creating) createRef.current?.focus();
  }, [creating]);

  const cancelCreate = () => {
    setCreating(false);
    setDraftName('');
  };

  const commitCreate = () => {
    const value = draftName.trim();
    if (value) addSpace(value);
    cancelCreate();
  };

  /* ---- inline rename ---- */
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState('');
  const renameRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (renamingId) {
      renameRef.current?.focus();
      renameRef.current?.select();
    }
  }, [renamingId]);

  const startRename = (id: string, current: string) => {
    setRenamingId(id);
    setRenameValue(current);
  };

  const commitRename = () => {
    if (!renamingId) return;
    const value = renameValue.trim();
    if (value) renameSpace(renamingId, value);
    setRenamingId(null);
    setRenameValue('');
  };

  const cancelRename = () => {
    setRenamingId(null);
    setRenameValue('');
  };

  const handleDeleteSpace = (id: string, name: string) => {
    if (window.confirm(`Delete space "${name}"? Its nodes move to another space.`)) {
      deleteSpace(id);
    }
  };

  const handleDragStart = (e: React.DragEvent<HTMLButtonElement>, kind: NodeKind) => {
    e.dataTransfer.setData('application/cfc-kind', kind);
    e.dataTransfer.effectAllowed = 'move';
  };

  return (
    <aside className="flex h-full w-64 shrink-0 flex-col border-r border-line bg-surface">
      {/* ---------------- Spaces ---------------- */}
      <div className="flex min-h-0 flex-col border-b border-line">
        <div className="flex items-center justify-between px-3 pt-3 pb-2">
          <span className="label">Spaces</span>
          <button
            type="button"
            className="icon-btn h-6 w-6"
            title="New space"
            aria-label="New space"
            onClick={() => (creating ? cancelCreate() : setCreating(true))}
          >
            <Plus size={14} />
          </button>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-2">
          {creating && (
            <div className="animate-fade-in px-1 pb-1">
              <input
                ref={createRef}
                className="input py-1.5 text-[13px]"
                placeholder="Space name…"
                value={draftName}
                onChange={(e) => setDraftName(e.target.value)}
                onBlur={commitCreate}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    e.preventDefault();
                    commitCreate();
                  } else if (e.key === 'Escape') {
                    e.preventDefault();
                    cancelCreate();
                  }
                }}
              />
            </div>
          )}

          {/* All nodes */}
          <button
            type="button"
            onClick={() => setActiveSpace('all')}
            className={cn(
              'group relative flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-[13px] transition-colors',
              activeSpace === 'all'
                ? 'bg-white/5 text-ink'
                : 'text-muted hover:bg-white/5 hover:text-ink',
            )}
          >
            {activeSpace === 'all' && (
              <span className="absolute inset-y-1 left-0 w-0.5 rounded-full bg-brand" />
            )}
            <Layers size={14} className="shrink-0 text-muted" />
            <span className="flex-1 truncate font-medium">All nodes</span>
            <span className="shrink-0 text-[11px] tabular-nums text-muted">{nodes.length}</span>
          </button>

          {/* One row per space */}
          {spaces.map((space) => {
            const isActive = activeSpace === space.id;
            const count = countsBySpace.get(space.id) ?? 0;
            const isRenaming = renamingId === space.id;

            return (
              <div
                key={space.id}
                className={cn(
                  'group relative flex items-center gap-2 rounded-lg px-2 py-1.5 text-[13px] transition-colors',
                  isActive ? 'bg-white/5 text-ink' : 'text-muted hover:bg-white/5 hover:text-ink',
                )}
              >
                {isActive && (
                  <span className="absolute inset-y-1 left-0 w-0.5 rounded-full bg-brand" />
                )}
                <span
                  className="h-2.5 w-2.5 shrink-0 rounded-full ring-1 ring-inset ring-white/10"
                  style={{ backgroundColor: space.color }}
                />

                {isRenaming ? (
                  <input
                    ref={renameRef}
                    className="input flex-1 px-2 py-1 text-[13px]"
                    value={renameValue}
                    onChange={(e) => setRenameValue(e.target.value)}
                    onBlur={commitRename}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') {
                        e.preventDefault();
                        commitRename();
                      } else if (e.key === 'Escape') {
                        e.preventDefault();
                        cancelRename();
                      }
                    }}
                  />
                ) : (
                  <>
                    <button
                      type="button"
                      onClick={() => setActiveSpace(space.id)}
                      onDoubleClick={() => startRename(space.id, space.name)}
                      title={space.name}
                      className="flex-1 truncate text-left font-medium"
                    >
                      {space.name}
                    </button>
                    <span className="shrink-0 text-[11px] tabular-nums text-muted group-hover:hidden">
                      {count}
                    </span>
                    <button
                      type="button"
                      onClick={() => handleDeleteSpace(space.id, space.name)}
                      title="Delete space"
                      aria-label={`Delete ${space.name}`}
                      className="hidden h-5 w-5 shrink-0 items-center justify-center rounded text-muted hover:bg-white/10 hover:text-ink group-hover:flex"
                    >
                      <X size={13} />
                    </button>
                  </>
                )}
              </div>
            );
          })}
        </div>
      </div>

      {/* ---------------- Nodes palette ---------------- */}
      <div className="flex min-h-0 flex-1 flex-col">
        <div className="flex items-center justify-between px-3 pt-3 pb-2">
          <span className="label">Nodes</span>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-2">
          <div className="grid grid-cols-2 gap-1.5">
            {KIND_ORDER.map((kind) => {
              const meta = KIND_META[kind];
              const Icon = meta.icon;
              return (
                <button
                  key={kind}
                  type="button"
                  draggable
                  onDragStart={(e) => handleDragStart(e, kind)}
                  onClick={() => addNode(kind)}
                  title={meta.hint}
                  className="group flex cursor-grab items-center gap-2 rounded-lg border border-line bg-surface2/60 px-2 py-2 text-left text-[12px] text-ink transition-colors hover:border-brand/50 hover:bg-white/5 active:cursor-grabbing"
                >
                  <span
                    className="flex h-6 w-6 shrink-0 items-center justify-center rounded-md ring-1 ring-inset ring-white/5"
                    style={{ backgroundColor: meta.color + '22', color: meta.color }}
                  >
                    <Icon size={14} />
                  </span>
                  <span className="min-w-0 flex-1 truncate font-medium leading-tight">
                    {meta.label}
                  </span>
                </button>
              );
            })}
          </div>

          <p className="mt-2 flex items-center gap-1 px-1 text-[11px] leading-snug text-muted">
            <Check size={11} className="shrink-0" />
            Drag onto the canvas or click to add
          </p>
        </div>
      </div>
    </aside>
  );
}
