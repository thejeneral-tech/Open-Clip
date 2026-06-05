import type { Filters, FlowNode, NodeHealth } from '@/types';

/** Health levels that count as "needs attention" for the broken-only filter. */
const ATTENTION = new Set(['missing-input', 'missing-output', 'broken-chain', 'needs-review']);

/**
 * Single source of truth for whether a node passes the active filters.
 * Used by both the canvas (to hide nodes) and the search panel (to count).
 */
export function nodeMatchesFilters(
  node: FlowNode,
  filters: Filters,
  activeSpace: string,
  health?: NodeHealth,
): boolean {
  const d = node.data;

  if (activeSpace !== 'all' && d.space !== activeSpace) return false;

  const q = filters.search.trim().toLowerCase();
  if (q) {
    const haystack = [d.title, d.description, d.notes, d.code, d.tags.join(' ')]
      .join(' ')
      .toLowerCase();
    if (!haystack.includes(q)) return false;
  }

  if (filters.statuses.length && !filters.statuses.includes(d.status)) return false;
  if (filters.kinds.length && !filters.kinds.includes(d.kind)) return false;
  if (filters.tags.length && !d.tags.some((t) => filters.tags.includes(t))) return false;
  if (filters.brokenOnly && !(health && ATTENTION.has(health.level))) return false;
  if (filters.unfinishedOnly && d.status === 'done') return false;

  return true;
}
