import { useMemo, useState } from 'react';
import {
  Activity,
  AlertTriangle,
  CheckCircle2,
  ChevronRight,
  ChevronUp,
  X,
} from 'lucide-react';
import type { HealthLevel } from '@/types';
import { useStore } from '@/store/useStore';
import { summarizeWorkflow, validateWorkflow } from '@/lib/validation';
import { HEALTH_META, HEALTH_ORDER } from '@/lib/nodeRegistry';
import { cn } from '@/lib/cn';

/** Health levels that represent a node the user still needs to deal with. */
const ATTENTION_LEVELS: HealthLevel[] = [
  'missing-input',
  'missing-output',
  'broken-chain',
  'needs-review',
];

/** Short, scannable labels for the per-node attention list. */
const SHORT_LABEL: Record<HealthLevel, string> = {
  ready: 'Ready',
  connected: 'Connected',
  'needs-review': 'Needs review',
  'missing-input': 'Missing input',
  'missing-output': 'Missing output',
  'broken-chain': 'Broken chain',
};

const MAX_VISIBLE = 8;

interface AttentionNode {
  id: string;
  title: string;
  level: HealthLevel;
}

/** A small filled dot tinted with a health colour. */
function HealthDot({ color }: { color: string }) {
  return (
    <span
      className="h-2 w-2 shrink-0 rounded-full"
      style={{ backgroundColor: color, boxShadow: `0 0 6px ${color}66` }}
    />
  );
}

export function HealthPanel() {
  const nodes = useStore((s) => s.nodes);
  const edges = useStore((s) => s.edges);
  const setSelectedNode = useStore((s) => s.setSelectedNode);
  const setUi = useStore((s) => s.setUi);

  const [collapsed, setCollapsed] = useState(false);

  const health = useMemo(() => validateWorkflow(nodes, edges), [nodes, edges]);
  const summary = useMemo(
    () => summarizeWorkflow(nodes, edges, health),
    [nodes, edges, health],
  );

  /** Nodes the user should look at, in canvas order. */
  const attention = useMemo<AttentionNode[]>(() => {
    const out: AttentionNode[] = [];
    for (const node of nodes) {
      const level = health[node.id]?.level;
      if (level && ATTENTION_LEVELS.includes(level)) {
        out.push({
          id: node.id,
          title: node.data.title.trim() || 'Untitled node',
          level,
        });
      }
    }
    return out;
  }, [nodes, health]);

  const attentionCount = ATTENTION_LEVELS.reduce(
    (sum, level) => sum + summary.counts[level],
    0,
  );

  const ready = summary.readyToBuild;
  const isEmpty = summary.total === 0;

  /* ----- one-line headline state shared by pill + expanded header ----- */
  const headlineColor = ready
    ? HEALTH_META.ready.color
    : attentionCount > 0
      ? HEALTH_META['needs-review'].color
      : HEALTH_META.connected.color;

  let headlineText: string;
  if (isEmpty) {
    headlineText = 'No nodes yet';
  } else if (ready) {
    headlineText = 'Ready to build';
  } else if (attentionCount > 0) {
    headlineText = `${attentionCount} ${attentionCount === 1 ? 'issue' : 'issues'}`;
  } else {
    headlineText = 'In progress';
  }

  /* -------------------------------- collapsed pill ------------------------ */
  if (collapsed) {
    const PillIcon = ready ? CheckCircle2 : attentionCount > 0 ? AlertTriangle : Activity;
    return (
      <button
        type="button"
        onClick={() => setCollapsed(false)}
        title="Show connection health"
        className="panel animate-fade-in absolute bottom-4 left-4 z-20 flex items-center gap-2 px-3 py-2 text-sm font-medium text-ink hover:bg-white/5"
      >
        <PillIcon size={15} style={{ color: headlineColor }} />
        <span style={{ color: ready ? headlineColor : undefined }}>{headlineText}</span>
        <ChevronUp size={14} className="text-muted" />
      </button>
    );
  }

  /* -------------------------------- expanded panel ------------------------ */
  const HeadIcon = ready ? CheckCircle2 : AlertTriangle;
  const breakdown = HEALTH_ORDER.filter((level) => summary.counts[level] > 0);
  const visible = attention.slice(0, MAX_VISIBLE);
  const overflow = attention.length - visible.length;

  return (
    <section className="panel animate-fade-in absolute bottom-4 left-4 z-20 flex w-[300px] flex-col">
      {/* header */}
      <header className="flex items-center gap-2 border-b border-line px-3 py-2.5">
        <Activity size={15} className="text-brand" />
        <span className="text-sm font-semibold text-ink">Connection health</span>
        <div className="ml-auto flex items-center gap-1">
          <button
            type="button"
            onClick={() => setCollapsed(true)}
            title="Collapse"
            className="icon-btn h-7 w-7"
          >
            <ChevronUp size={15} />
          </button>
          <button
            type="button"
            onClick={() => setUi({ showHealth: false })}
            title="Hide panel"
            className="icon-btn h-7 w-7"
          >
            <X size={15} />
          </button>
        </div>
      </header>

      <div className="flex flex-col gap-3 px-3 py-3">
        {/* headline */}
        <div className="flex items-center gap-2">
          <HeadIcon size={18} style={{ color: headlineColor }} />
          <div className="min-w-0">
            {ready ? (
              <p className="text-sm font-semibold" style={{ color: headlineColor }}>
                Ready to build
              </p>
            ) : (
              <p className="text-sm font-semibold text-ink">
                {isEmpty
                  ? 'No nodes yet'
                  : attentionCount > 0
                    ? `${attentionCount} ${attentionCount === 1 ? 'node needs' : 'nodes need'} attention`
                    : 'Workflow in progress'}
              </p>
            )}
            <p className="text-[11px] text-muted">
              {summary.total} {summary.total === 1 ? 'node' : 'nodes'} on canvas
            </p>
          </div>
        </div>

        {/* breakdown */}
        {breakdown.length > 0 && (
          <div className="flex flex-col gap-1">
            {breakdown.map((level) => (
              <div key={level} className="flex items-center gap-2 text-[12px]">
                <HealthDot color={HEALTH_META[level].color} />
                <span className="text-muted">{HEALTH_META[level].label}</span>
                <span className="ml-auto font-semibold tabular-nums text-ink">
                  {summary.counts[level]}
                </span>
              </div>
            ))}
          </div>
        )}

        {/* global issues */}
        {summary.globalIssues.length > 0 && (
          <div className="flex flex-col gap-1.5 rounded-lg border border-line bg-surface2/60 p-2.5">
            {summary.globalIssues.map((issue) => (
              <div key={issue} className="flex items-start gap-2 text-[12px] text-ink">
                <AlertTriangle
                  size={13}
                  className="mt-0.5 shrink-0"
                  style={{ color: HEALTH_META['needs-review'].color }}
                />
                <span className="leading-snug">{issue}</span>
              </div>
            ))}
          </div>
        )}

        {/* needs-attention list */}
        {attention.length > 0 && (
          <div className="flex flex-col gap-1">
            <p className="label">Needs attention</p>
            <ul className="flex flex-col gap-0.5">
              {visible.map((item) => (
                <li key={item.id}>
                  <button
                    type="button"
                    onClick={() => setSelectedNode(item.id)}
                    title={`Jump to ${item.title}`}
                    className={cn(
                      'group flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left',
                      'transition-colors hover:bg-white/5',
                    )}
                  >
                    <HealthDot color={HEALTH_META[item.level].color} />
                    <span className="min-w-0 flex-1 truncate text-[12px] text-ink">
                      {item.title}
                    </span>
                    <span
                      className="shrink-0 text-[10px] font-medium"
                      style={{ color: HEALTH_META[item.level].color }}
                    >
                      {SHORT_LABEL[item.level]}
                    </span>
                    <ChevronRight
                      size={13}
                      className="shrink-0 text-muted opacity-0 transition-opacity group-hover:opacity-100"
                    />
                  </button>
                </li>
              ))}
            </ul>
            {overflow > 0 && (
              <p className="px-2 pt-0.5 text-[11px] text-muted">+{overflow} more</p>
            )}
          </div>
        )}
      </div>
    </section>
  );
}
