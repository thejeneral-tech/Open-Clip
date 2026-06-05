import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { useReactFlow, type XYPosition } from '@xyflow/react';
import { Copy, Maximize, PanelRight, Trash2, Wand2 } from 'lucide-react';
import { useStore } from '@/store/useStore';
import { KIND_META, KIND_ORDER, STATUS_META, STATUS_ORDER } from '@/lib/nodeRegistry';
import type { EdgeKind } from '@/types';
import { cn } from '@/lib/cn';

export type CanvasMenu =
  | { type: 'pane'; x: number; y: number; flow: XYPosition }
  | { type: 'node'; x: number; y: number; id: string }
  | { type: 'edge'; x: number; y: number; id: string };

const EDGE_KINDS: { kind: EdgeKind; label: string; color: string }[] = [
  { kind: 'default', label: 'Default', color: '#22d3ee' },
  { kind: 'success', label: 'Success', color: '#22c55e' },
  { kind: 'error', label: 'Error', color: '#ef4444' },
];

function Item({
  icon,
  label,
  danger,
  onClick,
}: {
  icon?: ReactNode;
  label: string;
  danger?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        'flex w-full items-center gap-2.5 rounded-lg px-2.5 py-1.5 text-left text-sm transition-colors',
        danger ? 'text-red-400 hover:bg-red-500/10' : 'text-ink hover:bg-white/5',
      )}
    >
      {icon && <span className="flex h-4 w-4 items-center justify-center text-muted">{icon}</span>}
      <span className="flex-1 truncate">{label}</span>
    </button>
  );
}

export function CanvasContextMenu({ menu, onClose }: { menu: CanvasMenu; onClose: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ left: menu.x, top: menu.y });

  const nodes = useStore((s) => s.nodes);
  const addNode = useStore((s) => s.addNode);
  const tidyLayout = useStore((s) => s.tidyLayout);
  const setSelectedNode = useStore((s) => s.setSelectedNode);
  const duplicateNode = useStore((s) => s.duplicateNode);
  const deleteNode = useStore((s) => s.deleteNode);
  const updateNodeData = useStore((s) => s.updateNodeData);
  const updateEdgeData = useStore((s) => s.updateEdgeData);
  const deleteEdge = useStore((s) => s.deleteEdge);
  const { fitView } = useReactFlow();

  // Keep the menu inside the viewport.
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    let left = menu.x;
    let top = menu.y;
    if (left + r.width > window.innerWidth - 8) left = window.innerWidth - r.width - 8;
    if (top + r.height > window.innerHeight - 8) top = window.innerHeight - r.height - 8;
    setPos({ left: Math.max(8, left), top: Math.max(8, top) });
  }, [menu]);

  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) onClose();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    window.addEventListener('resize', onClose);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
      window.removeEventListener('resize', onClose);
    };
  }, [onClose]);

  const node = menu.type === 'node' ? nodes.find((n) => n.id === menu.id) : undefined;

  return (
    <div
      ref={ref}
      className="panel animate-fade-in fixed z-50 w-56 p-1.5"
      style={{ left: pos.left, top: pos.top }}
      onContextMenu={(e) => e.preventDefault()}
    >
      {menu.type === 'pane' && (
        <>
          <div className="label px-2.5 pb-1 pt-1">Add a node here</div>
          <div className="max-h-60 overflow-y-auto">
            {KIND_ORDER.map((kind) => {
              const m = KIND_META[kind];
              const Icon = m.icon;
              return (
                <button
                  key={kind}
                  type="button"
                  onClick={() => {
                    addNode(kind, menu.flow);
                    onClose();
                  }}
                  className="flex w-full items-center gap-2.5 rounded-lg px-2.5 py-1.5 text-left text-sm text-ink hover:bg-white/5"
                >
                  <span
                    className="flex h-5 w-5 items-center justify-center rounded"
                    style={{ background: m.color + '22', color: m.color }}
                  >
                    <Icon size={13} />
                  </span>
                  <span className="flex-1 truncate">{m.label}</span>
                </button>
              );
            })}
          </div>
          <div className="my-1 border-t border-line" />
          <Item
            icon={<Wand2 size={14} />}
            label="Tidy up layout"
            onClick={() => {
              tidyLayout();
              window.setTimeout(() => fitView({ padding: 0.25, maxZoom: 1, duration: 400 }), 0);
              onClose();
            }}
          />
          <Item
            icon={<Maximize size={14} />}
            label="Fit view"
            onClick={() => {
              fitView({ padding: 0.25, maxZoom: 1, duration: 400 });
              onClose();
            }}
          />
        </>
      )}

      {menu.type === 'node' && node && (
        <>
          <div className="truncate px-2.5 pb-1 pt-1 text-xs font-semibold text-ink">
            {node.data.title || KIND_META[node.data.kind].label}
          </div>
          <Item
            icon={<PanelRight size={14} />}
            label="Open in inspector"
            onClick={() => {
              setSelectedNode(menu.id);
              onClose();
            }}
          />
          <Item
            icon={<Copy size={14} />}
            label="Duplicate"
            onClick={() => {
              duplicateNode(menu.id);
              onClose();
            }}
          />
          <div className="label px-2.5 pb-1 pt-2">Set status</div>
          <div className="flex flex-wrap gap-1 px-2 pb-1">
            {STATUS_ORDER.map((st) => {
              const m = STATUS_META[st];
              const on = node.data.status === st;
              return (
                <button
                  key={st}
                  type="button"
                  title={m.label}
                  onClick={() => {
                    updateNodeData(menu.id, { status: st });
                    onClose();
                  }}
                  className="flex h-6 items-center gap-1 rounded-full px-2 text-[10px] font-medium"
                  style={{ background: m.color + (on ? '33' : '1a'), color: m.color }}
                >
                  <span className="h-1.5 w-1.5 rounded-full" style={{ background: m.color }} />
                  {m.label}
                </button>
              );
            })}
          </div>
          <div className="my-1 border-t border-line" />
          <Item
            icon={<Trash2 size={14} />}
            label="Delete node"
            danger
            onClick={() => {
              deleteNode(menu.id);
              onClose();
            }}
          />
        </>
      )}

      {menu.type === 'edge' && (
        <>
          <div className="px-2.5 pb-1 pt-1 text-xs font-semibold text-ink">Connection</div>
          <div className="label px-2.5 pb-1 pt-1">Path type</div>
          <div className="flex gap-1 px-2 pb-1">
            {EDGE_KINDS.map((k) => (
              <button
                key={k.kind}
                type="button"
                onClick={() => {
                  updateEdgeData(menu.id, { kind: k.kind });
                  onClose();
                }}
                className="flex flex-1 items-center justify-center gap-1 rounded-md py-1 text-[10px] font-medium hover:bg-white/5"
                style={{ color: k.color }}
              >
                <span className="h-2 w-2 rounded-full" style={{ background: k.color }} />
                {k.label}
              </button>
            ))}
          </div>
          <div className="px-2.5 pb-1 text-[11px] text-muted">Double-click the line to rename it.</div>
          <div className="my-1 border-t border-line" />
          <Item
            icon={<Trash2 size={14} />}
            label="Delete connection"
            danger
            onClick={() => {
              deleteEdge(menu.id);
              onClose();
            }}
          />
        </>
      )}
    </div>
  );
}
