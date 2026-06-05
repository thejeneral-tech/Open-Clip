import { useEffect, useRef, useState } from 'react';
import { Check, ChevronDown, Copy, FolderKanban, Plus, Trash2 } from 'lucide-react';
import { useStore } from '@/store/useStore';
import { cn } from '@/lib/cn';

export function BoardSwitcher() {
  const boards = useStore((s) => s.boards);
  const activeBoardId = useStore((s) => s.activeBoardId);
  const switchBoard = useStore((s) => s.switchBoard);
  const createBoard = useStore((s) => s.createBoard);
  const renameBoard = useStore((s) => s.renameBoard);
  const duplicateBoard = useStore((s) => s.duplicateBoard);
  const deleteBoard = useStore((s) => s.deleteBoard);

  const [open, setOpen] = useState(false);
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [draft, setDraft] = useState('');
  const [creating, setCreating] = useState(false);
  const [newName, setNewName] = useState('');
  const containerRef = useRef<HTMLDivElement>(null);

  const active = boards.find((b) => b.id === activeBoardId) ?? boards[0];

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

  useEffect(() => {
    if (!open) {
      setRenamingId(null);
      setCreating(false);
      setNewName('');
    }
  }, [open]);

  const startRename = (id: string, name: string) => {
    setRenamingId(id);
    setDraft(name);
  };
  const commitRename = () => {
    if (renamingId) renameBoard(renamingId, draft);
    setRenamingId(null);
  };
  const commitCreate = () => {
    const name = newName.trim();
    if (name) createBoard(name);
    setNewName('');
    setCreating(false);
    setOpen(false);
  };

  return (
    <div ref={containerRef} className="relative">
      <button
        type="button"
        className="btn btn-ghost max-w-[220px]"
        onClick={() => setOpen((v) => !v)}
        aria-haspopup="menu"
        aria-expanded={open}
        title="Switch project board"
      >
        <FolderKanban size={15} className="shrink-0 text-brand-glow" />
        <span className="min-w-0 truncate">{active?.name ?? 'Board'}</span>
        <ChevronDown size={14} className="shrink-0 text-muted" />
      </button>

      {open && (
        <div
          role="menu"
          className="panel animate-fade-in absolute left-0 top-[calc(100%+8px)] z-40 w-72 overflow-hidden p-1.5"
        >
          <div className="label px-2.5 pb-1 pt-1.5">Project boards</div>
          <div className="max-h-[50vh] overflow-y-auto">
            {boards.map((b) => {
              const isActive = b.id === activeBoardId;
              return (
                <div
                  key={b.id}
                  className={cn(
                    'group flex items-center gap-2 rounded-lg px-2.5 py-2 text-sm',
                    isActive ? 'bg-white/5' : 'hover:bg-white/5',
                  )}
                >
                  <Check
                    size={14}
                    className={cn('shrink-0', isActive ? 'text-brand' : 'opacity-0')}
                  />
                  {renamingId === b.id ? (
                    <input
                      autoFocus
                      value={draft}
                      onChange={(e) => setDraft(e.target.value)}
                      onBlur={commitRename}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') commitRename();
                        if (e.key === 'Escape') setRenamingId(null);
                      }}
                      className="input h-7 flex-1 px-2 py-0.5 text-sm"
                    />
                  ) : (
                    <button
                      type="button"
                      className="min-w-0 flex-1 truncate text-left text-ink"
                      onClick={() => {
                        switchBoard(b.id);
                        setOpen(false);
                      }}
                      onDoubleClick={() => startRename(b.id, b.name)}
                      title="Click to open · double-click to rename"
                    >
                      {b.name}
                      <span className="ml-1.5 text-[11px] text-muted">{b.nodes.length}</span>
                    </button>
                  )}
                  {renamingId !== b.id && (
                    <div className="flex shrink-0 items-center opacity-0 transition-opacity group-hover:opacity-100">
                      <button
                        type="button"
                        className="icon-btn h-6 w-6"
                        title="Duplicate board"
                        onClick={() => duplicateBoard(b.id)}
                      >
                        <Copy size={13} />
                      </button>
                      <button
                        type="button"
                        className="icon-btn h-6 w-6 hover:text-red-400"
                        title="Delete board"
                        disabled={boards.length <= 1}
                        onClick={() => {
                          if (window.confirm(`Delete board "${b.name}"? This cannot be undone.`)) {
                            deleteBoard(b.id);
                          }
                        }}
                      >
                        <Trash2 size={13} />
                      </button>
                    </div>
                  )}
                </div>
              );
            })}
          </div>

          <div className="mt-1 border-t border-line pt-1.5">
            {creating ? (
              <input
                autoFocus
                value={newName}
                onChange={(e) => setNewName(e.target.value)}
                onBlur={commitCreate}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') commitCreate();
                  if (e.key === 'Escape') {
                    setCreating(false);
                    setNewName('');
                  }
                }}
                placeholder="New board name…"
                className="input h-8"
              />
            ) : (
              <button
                type="button"
                className="flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-sm text-muted transition-colors hover:bg-white/5 hover:text-ink"
                onClick={() => setCreating(true)}
              >
                <Plus size={15} />
                New board
              </button>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
