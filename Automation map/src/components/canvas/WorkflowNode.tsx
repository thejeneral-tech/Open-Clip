import { Handle, Position, type NodeProps } from '@xyflow/react';
import type { FlowNode, NodeData, NodeHealth, Port } from '@/types';
import { HEALTH_META, KIND_META, STATUS_META } from '@/lib/nodeRegistry';
import { cn } from '@/lib/cn';

/** Border tint for a port handle based on its edge semantics. */
function handleColor(kind: Port['kind']): string {
  if (kind === 'success') return '#22c55e';
  if (kind === 'error') return '#ef4444';
  return '#4b5573';
}

/** Evenly distribute N handles down the vertical edge of the card. */
function handleTop(index: number, count: number): string {
  return `${((index + 1) / (count + 1)) * 100}%`;
}

/** A short, kind-specific hint to surface the most useful field at a glance. */
function kindHint(data: NodeData): string | null {
  switch (data.kind) {
    case 'api':
      return data.url.trim() || null;
    case 'terminal':
      return data.command.trim() || null;
    case 'database':
      return data.schema.trim() ? data.schema.trim() : data.hasCredentials ? 'credentials set' : null;
    case 'agent':
      return data.prompt.trim() || null;
    case 'env':
      return data.envVars.trim() ? data.envVars.split('\n')[0].trim() : null;
    default:
      return null;
  }
}

export function WorkflowNode({ data, selected }: NodeProps<FlowNode>) {
  const node = data as NodeData;
  const kindMeta = KIND_META[node.kind];
  const statusMeta = STATUS_META[node.status];
  const KindIcon = kindMeta.icon;

  const health = node.health as NodeHealth | undefined;
  const healthMeta = health ? HEALTH_META[health.level] : null;
  const healthColor = healthMeta?.color ?? '#8b93a7';
  const healthLabel = healthMeta?.label ?? 'Unverified';
  const healthTitle = health?.issues.length ? health.issues.join('\n') : healthLabel;

  const tags = node.tags;
  const visibleTags = tags.slice(0, 3);
  const overflowTags = tags.length - visibleTags.length;

  const hint = kindHint(node);
  const hasBody = Boolean(node.description.trim()) || tags.length > 0 || Boolean(hint);

  return (
    <div
      className={cn(
        'cfc-node relative w-[248px] overflow-visible rounded-xl border border-line bg-surface text-ink shadow-lg transition-colors',
        selected && 'border-brand',
      )}
    >
      {/* Top accent bar in the node-kind color */}
      <div
        className="absolute inset-x-0 top-0 h-[3px] rounded-t-xl"
        style={{ backgroundColor: kindMeta.color }}
      />

      {/* Input handles (left) */}
      {node.inputs.map((port, i) => (
        <Handle
          key={port.id}
          id={port.id}
          type="target"
          position={Position.Left}
          title={port.label}
          style={{ top: handleTop(i, node.inputs.length), borderColor: handleColor(port.kind) }}
        />
      ))}

      {/* Output handles (right) */}
      {node.outputs.map((port, i) => (
        <Handle
          key={port.id}
          id={port.id}
          type="source"
          position={Position.Right}
          title={port.label}
          style={{ top: handleTop(i, node.outputs.length), borderColor: handleColor(port.kind) }}
        />
      ))}

      <div className="px-3 pb-2.5 pt-3">
        {/* Header */}
        <div className="flex items-center gap-2.5">
          <div
            className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg"
            style={{ backgroundColor: kindMeta.color + '2e', color: kindMeta.color }}
          >
            <KindIcon size={15} />
          </div>
          <div className="min-w-0 flex-1">
            <div className="truncate text-sm font-medium leading-tight text-ink" title={node.title}>
              {node.title || `New ${kindMeta.label}`}
            </div>
            <div className="truncate text-[10px] uppercase tracking-wide text-muted">
              {kindMeta.label}
            </div>
          </div>
          <span
            className="h-2.5 w-2.5 shrink-0 rounded-full"
            style={{ backgroundColor: statusMeta.color, boxShadow: `0 0 8px ${statusMeta.color}66` }}
            title={statusMeta.label}
          />
        </div>

        {/* Body */}
        {hasBody && (
          <div className="mt-2 space-y-2">
            {node.description.trim() && (
              <p className="line-clamp-2 text-xs leading-snug text-muted">{node.description}</p>
            )}

            {tags.length > 0 && (
              <div className="flex flex-wrap items-center gap-1">
                {visibleTags.map((tag) => (
                  <span
                    key={tag}
                    className="chip bg-surface2 text-muted"
                    style={{ borderColor: '#232a3b' }}
                  >
                    {tag}
                  </span>
                ))}
                {overflowTags > 0 && (
                  <span className="chip bg-surface2 text-muted">+{overflowTags}</span>
                )}
              </div>
            )}

            {hint && (
              <div
                className="truncate rounded-md bg-surface2 px-2 py-1 font-mono text-[10px] text-muted"
                title={hint}
              >
                {hint}
              </div>
            )}
          </div>
        )}

        {/* Footer: health pill */}
        <div className="mt-2.5 flex items-center gap-1.5" title={healthTitle}>
          <span className="h-1.5 w-1.5 rounded-full" style={{ backgroundColor: healthColor }} />
          <span className="text-[10px] font-medium" style={{ color: healthColor }}>
            {healthLabel}
          </span>
        </div>
      </div>
    </div>
  );
}
