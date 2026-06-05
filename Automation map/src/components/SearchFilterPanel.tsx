import { useMemo, useState } from 'react';
import { ChevronDown, ChevronUp, Filter, Search, X } from 'lucide-react';
import type { NodeKind, NodeStatus } from '@/types';
import { useStore } from '@/store/useStore';
import {
  KIND_META,
  KIND_ORDER,
  STATUS_META,
  STATUS_ORDER,
} from '@/lib/nodeRegistry';
import { validateWorkflow } from '@/lib/validation';
import { nodeMatchesFilters } from '@/lib/filtering';
import { cn } from '@/lib/cn';

/* ------------------------------------------------------------------ */
/* Small toggle switch                                                 */
/* ------------------------------------------------------------------ */

interface SwitchProps {
  checked: boolean;
  onChange: (value: boolean) => void;
  label: string;
}

function Switch({ checked, onChange, label }: SwitchProps) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      onClick={() => onChange(!checked)}
      className="group flex w-full items-center justify-between gap-3 rounded-lg px-1 py-1 text-left text-[13px] text-ink transition-colors hover:bg-white/5"
    >
      <span className={cn(checked ? 'text-ink' : 'text-muted')}>{label}</span>
      <span
        className={cn(
          'relative inline-flex h-[18px] w-8 shrink-0 items-center rounded-full border transition-colors',
          checked
            ? 'border-brand bg-brand/80'
            : 'border-line bg-surface2',
        )}
      >
        <span
          className={cn(
            'inline-block h-3 w-3 rounded-full bg-white shadow-sm transition-transform',
            checked ? 'translate-x-[15px]' : 'translate-x-[3px]',
          )}
        />
      </span>
    </button>
  );
}

/* ------------------------------------------------------------------ */
/* Panel                                                               */
/* ------------------------------------------------------------------ */

export function SearchFilterPanel() {
  const nodes = useStore((s) => s.nodes);
  const edges = useStore((s) => s.edges);
  const filters = useStore((s) => s.filters);
  const activeSpace = useStore((s) => s.activeSpace);
  const setFilters = useStore((s) => s.setFilters);
  const resetFilters = useStore((s) => s.resetFilters);
  const setUi = useStore((s) => s.setUi);

  const [collapsed, setCollapsed] = useState(false);

  /* health map drives the "broken only" filter; recompute with the graph */
  const health = useMemo(() => validateWorkflow(nodes, edges), [nodes, edges]);

  /* unique, sorted set of every tag used across all nodes */
  const allTags = useMemo(() => {
    const set = new Set<string>();
    for (const node of nodes) {
      for (const tag of node.data.tags) {
        const trimmed = tag.trim();
        if (trimmed) set.add(trimmed);
      }
    }
    return Array.from(set).sort((a, b) => a.localeCompare(b));
  }, [nodes]);

  /* X of Y nodes passing the active filters */
  const matchCount = useMemo(
    () =>
      nodes.reduce(
        (count, node) =>
          nodeMatchesFilters(node, filters, activeSpace, health[node.id])
            ? count + 1
            : count,
        0,
      ),
    [nodes, filters, activeSpace, health],
  );

  /* how many filter facets are currently narrowing the result */
  const activeCount = useMemo(() => {
    let n = 0;
    if (filters.search.trim()) n += 1;
    n += filters.statuses.length;
    n += filters.kinds.length;
    n += filters.tags.length;
    if (filters.brokenOnly) n += 1;
    if (filters.unfinishedOnly) n += 1;
    return n;
  }, [filters]);

  const hasActiveFilters = activeCount > 0;

  const toggleStatus = (status: NodeStatus) => {
    const next = filters.statuses.includes(status)
      ? filters.statuses.filter((s) => s !== status)
      : [...filters.statuses, status];
    setFilters({ statuses: next });
  };

  const toggleKind = (kind: NodeKind) => {
    const next = filters.kinds.includes(kind)
      ? filters.kinds.filter((k) => k !== kind)
      : [...filters.kinds, kind];
    setFilters({ kinds: next });
  };

  const toggleTag = (tag: string) => {
    const next = filters.tags.includes(tag)
      ? filters.tags.filter((t) => t !== tag)
      : [...filters.tags, tag];
    setFilters({ tags: next });
  };

  const close = () => setUi({ showSearch: false });

  /* ------------------------------ collapsed ------------------------------ */
  if (collapsed) {
    return (
      <div className="panel animate-fade-in absolute left-4 top-4 z-20 w-[300px] p-2">
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => setCollapsed(false)}
            className="flex min-w-0 flex-1 items-center gap-2 rounded-lg px-2 py-1 text-left text-sm text-ink transition-colors hover:bg-white/5"
            title="Expand search & filters"
          >
            <Search size={15} className="shrink-0 text-muted" />
            <span className="truncate">
              Filters
              {activeCount > 0 && (
                <span className="text-muted"> ({activeCount} active)</span>
              )}
            </span>
            <ChevronDown size={15} className="ml-auto shrink-0 text-muted" />
          </button>
          <button
            type="button"
            onClick={close}
            className="icon-btn shrink-0"
            title="Hide panel"
            aria-label="Hide search panel"
          >
            <X size={15} />
          </button>
        </div>
      </div>
    );
  }

  /* ------------------------------ expanded ------------------------------- */
  return (
    <div className="panel animate-fade-in absolute left-4 top-4 z-20 flex max-h-[calc(100vh-2rem)] w-[300px] flex-col">
      {/* header */}
      <div className="flex items-center gap-2 border-b border-line px-3 py-2.5">
        <Filter size={15} className="shrink-0 text-brand-glow" />
        <span className="text-sm font-semibold text-ink">Search &amp; filters</span>
        {activeCount > 0 && (
          <span
            className="chip ml-1 bg-brand/15 text-brand-glow"
            title={`${activeCount} active ${activeCount === 1 ? 'filter' : 'filters'}`}
          >
            {activeCount}
          </span>
        )}
        <div className="ml-auto flex items-center gap-0.5">
          <button
            type="button"
            onClick={() => setCollapsed(true)}
            className="icon-btn"
            title="Collapse"
            aria-label="Collapse panel"
          >
            <ChevronUp size={15} />
          </button>
          <button
            type="button"
            onClick={close}
            className="icon-btn"
            title="Hide panel"
            aria-label="Hide search panel"
          >
            <X size={15} />
          </button>
        </div>
      </div>

      {/* body */}
      <div className="flex flex-col gap-4 overflow-y-auto px-3 py-3">
        {/* search */}
        <div className="relative">
          <Search
            size={15}
            className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-muted"
          />
          <input
            type="text"
            value={filters.search}
            onChange={(e) => setFilters({ search: e.target.value })}
            placeholder="Search nodes…"
            className="input pl-9 pr-9"
            aria-label="Search nodes"
          />
          {filters.search && (
            <button
              type="button"
              onClick={() => setFilters({ search: '' })}
              className="absolute right-2 top-1/2 flex h-6 w-6 -translate-y-1/2 items-center justify-center rounded-md text-muted transition-colors hover:bg-white/5 hover:text-ink"
              title="Clear search"
              aria-label="Clear search"
            >
              <X size={14} />
            </button>
          )}
        </div>

        {/* status */}
        <section className="flex flex-col gap-2">
          <h3 className="label">Status</h3>
          <div className="flex flex-wrap gap-1.5">
            {STATUS_ORDER.map((status) => {
              const meta = STATUS_META[status];
              const on = filters.statuses.includes(status);
              return (
                <button
                  key={status}
                  type="button"
                  onClick={() => toggleStatus(status)}
                  aria-pressed={on}
                  className={cn(
                    'chip border transition-colors',
                    on
                      ? 'border-transparent'
                      : 'border-line text-muted hover:text-ink hover:border-line/80',
                  )}
                  style={
                    on
                      ? { backgroundColor: meta.color + '22', color: meta.color }
                      : undefined
                  }
                >
                  <span
                    className="h-2 w-2 rounded-full"
                    style={{ backgroundColor: meta.color }}
                  />
                  {meta.label}
                </button>
              );
            })}
          </div>
        </section>

        {/* type / kind */}
        <section className="flex flex-col gap-2">
          <h3 className="label">Type</h3>
          <div className="flex flex-wrap gap-1.5">
            {KIND_ORDER.map((kind) => {
              const meta = KIND_META[kind];
              const Icon = meta.icon;
              const on = filters.kinds.includes(kind);
              return (
                <button
                  key={kind}
                  type="button"
                  onClick={() => toggleKind(kind)}
                  aria-pressed={on}
                  title={meta.hint}
                  className={cn(
                    'chip border transition-colors',
                    on
                      ? 'border-transparent'
                      : 'border-line text-muted hover:text-ink hover:border-line/80',
                  )}
                  style={
                    on
                      ? { backgroundColor: meta.color + '22', color: meta.color }
                      : undefined
                  }
                >
                  <Icon size={12} style={on ? { color: meta.color } : undefined} />
                  {meta.label}
                </button>
              );
            })}
          </div>
        </section>

        {/* tags (only when some exist) */}
        {allTags.length > 0 && (
          <section className="flex flex-col gap-2">
            <h3 className="label">Tags</h3>
            <div className="flex flex-wrap gap-1.5">
              {allTags.map((tag) => {
                const on = filters.tags.includes(tag);
                return (
                  <button
                    key={tag}
                    type="button"
                    onClick={() => toggleTag(tag)}
                    aria-pressed={on}
                    className={cn(
                      'chip border transition-colors',
                      on
                        ? 'border-brand/60 bg-brand/15 text-brand-glow'
                        : 'border-line text-muted hover:text-ink hover:border-line/80',
                    )}
                  >
                    #{tag}
                  </button>
                );
              })}
            </div>
          </section>
        )}

        {/* boolean switches */}
        <section className="flex flex-col gap-1">
          <h3 className="label mb-1">Quick filters</h3>
          <Switch
            checked={filters.brokenOnly}
            onChange={(v) => setFilters({ brokenOnly: v })}
            label="Only broken connections"
          />
          <Switch
            checked={filters.unfinishedOnly}
            onChange={(v) => setFilters({ unfinishedOnly: v })}
            label="Only unfinished tasks"
          />
        </section>
      </div>

      {/* footer */}
      <div className="flex items-center justify-between gap-2 border-t border-line px-3 py-2.5">
        <span className="text-[12px] text-muted">
          <span className="font-semibold text-ink">{matchCount}</span> of{' '}
          {nodes.length} node{nodes.length === 1 ? '' : 's'}
        </span>
        {hasActiveFilters && (
          <button
            type="button"
            onClick={resetFilters}
            className="btn btn-ghost px-2 py-1 text-[12px]"
          >
            <X size={13} />
            Clear all
          </button>
        )}
      </div>
    </div>
  );
}
