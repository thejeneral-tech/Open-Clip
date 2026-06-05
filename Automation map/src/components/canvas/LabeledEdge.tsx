import { useEffect, useRef, useState } from 'react';
import {
  BaseEdge,
  EdgeLabelRenderer,
  getBezierPath,
  type EdgeProps,
} from '@xyflow/react';
import { Check, Trash2 } from 'lucide-react';
import type { EdgeKind, FlowEdge } from '@/types';
import { useStore } from '@/store/useStore';
import { cn } from '@/lib/cn';

const COLOR: Record<EdgeKind, string> = {
  default: '#22d3ee',
  success: '#22c55e',
  error: '#ef4444',
};

const KINDS: { kind: EdgeKind; label: string }[] = [
  { kind: 'default', label: 'Default' },
  { kind: 'success', label: 'Success path' },
  { kind: 'error', label: 'Error path' },
];

export function LabeledEdge({
  id,
  sourceX,
  sourceY,
  targetX,
  targetY,
  sourcePosition,
  targetPosition,
  markerEnd,
  data,
  selected,
}: EdgeProps<FlowEdge>) {
  const [edgePath, labelX, labelY] = getBezierPath({
    sourceX,
    sourceY,
    sourcePosition,
    targetX,
    targetY,
    targetPosition,
  });

  const updateEdgeData = useStore((s) => s.updateEdgeData);
  const deleteEdge = useStore((s) => s.deleteEdge);

  const kind: EdgeKind = data?.kind ?? 'default';
  const label = data?.label ?? '';

  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(label);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (editing) {
      setDraft(label);
      requestAnimationFrame(() => inputRef.current?.select());
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editing]);

  useEffect(() => {
    if (!selected && editing) setEditing(false);
  }, [selected, editing]);

  const commit = () => {
    updateEdgeData(id, { label: draft.trim() });
    setEditing(false);
  };

  const showPill = editing || !!label.trim() || !!selected;
  if (!showPill) {
    return <BaseEdge id={id} path={edgePath} markerEnd={markerEnd} />;
  }

  return (
    <>
      <BaseEdge id={id} path={edgePath} markerEnd={markerEnd} />
      <EdgeLabelRenderer>
        <div
          className="nodrag nopan absolute flex flex-col items-center gap-1"
          style={{
            transform: `translate(-50%, -50%) translate(${labelX}px, ${labelY}px)`,
            pointerEvents: 'all',
          }}
        >
          {editing ? (
            <input
              ref={inputRef}
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onBlur={commit}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault();
                  commit();
                } else if (e.key === 'Escape') {
                  setEditing(false);
                }
              }}
              placeholder="label"
              className="w-28 rounded-full border border-brand/70 bg-surface2 px-2 py-0.5 text-center text-[10px] font-semibold text-ink outline-none"
            />
          ) : (
            <button
              type="button"
              onDoubleClick={() => setEditing(true)}
              className={cn(
                'rounded-full border bg-surface2 px-2 py-0.5 text-[10px] font-semibold transition-colors',
                selected ? 'border-brand/60' : 'border-line',
                !label.trim() && 'italic opacity-60',
              )}
              style={{ color: COLOR[kind] }}
              title="Double-click to rename"
            >
              {label.trim() || 'label'}
            </button>
          )}

          {selected && !editing && (
            <div className="panel animate-fade-in flex items-center gap-1 p-1">
              {KINDS.map((k) => (
                <button
                  key={k.kind}
                  type="button"
                  title={k.label}
                  onClick={() => updateEdgeData(id, { kind: k.kind })}
                  className="flex h-5 w-5 items-center justify-center rounded-md hover:bg-white/10"
                  style={{ color: COLOR[k.kind] }}
                >
                  {kind === k.kind ? (
                    <Check size={12} />
                  ) : (
                    <span className="h-2.5 w-2.5 rounded-full" style={{ background: COLOR[k.kind] }} />
                  )}
                </button>
              ))}
              <div className="mx-0.5 h-4 w-px bg-line" />
              <button
                type="button"
                title="Delete connection"
                onClick={() => deleteEdge(id)}
                className="flex h-5 w-5 items-center justify-center rounded-md text-muted hover:bg-white/10 hover:text-red-400"
              >
                <Trash2 size={12} />
              </button>
            </div>
          )}
        </div>
      </EdgeLabelRenderer>
    </>
  );
}
