/**
 * Automation Map — context-aware node suggestions.
 *
 * Pure logic (no DOM) that looks at the current graph and recommends the best
 * node types to add next, each with a human reason. Used by the toolbar's
 * "Add node" menu (recommended section) and the empty-state.
 *
 * Heuristics (mirrors the product spec):
 *   • Empty canvas       → Input/Feature, AI Agent, File, Output (+ load sample)
 *   • Agent w/o output   → Output (documentation), File
 *   • Code w/o test      → Test
 *   • API present        → Database, Env (auth), Test, Documentation
 *   • Feature w/o agent  → AI Agent
 *   • Always falls back to sensible generic next steps.
 */

import { KIND_META } from './registry.js';

const OUTPUT_KINDS = new Set(['documentation', 'file', 'folder']);
const CODE_KINDS = new Set(['function', 'file']);

/** Build a downstream-reachability tester from the edge list. */
function downstreamIndex(nodes, edges) {
  const out = new Map();
  for (const e of edges) {
    if (!out.has(e.source)) out.set(e.source, []);
    out.get(e.source).push(e.target);
  }
  const byId = new Map(nodes.map((n) => [n.id, n]));
  return function hasDownstreamKind(startId, kindSet) {
    const stack = [...(out.get(startId) || [])];
    const seen = new Set();
    while (stack.length) {
      const id = stack.pop();
      if (seen.has(id)) continue;
      seen.add(id);
      const n = byId.get(id);
      if (n && kindSet.has(n.data.kind)) return true;
      for (const t of out.get(id) || []) stack.push(t);
    }
    return false;
  };
}

/**
 * @returns {{recommendations: {kind:string, reason:string}[],
 *            suggestSample: boolean, empty: boolean, disconnected: number}}
 */
export function recommendNodes(nodes, edges) {
  nodes = nodes || [];
  edges = edges || [];
  const recs = [];
  const seen = new Set();
  const add = (kind, reason) => {
    if (KIND_META[kind] && !seen.has(kind)) { seen.add(kind); recs.push({ kind, reason }); }
  };

  const kinds = new Set(nodes.map((n) => n.data.kind));
  const has = (k) => kinds.has(k);

  if (nodes.length === 0) {
    add('feature', 'Start by describing the goal or input.');
    add('agent', 'Add an AI Agent to do the work.');
    add('file', 'Add a File the agent will produce.');
    add('documentation', 'Capture the final output.');
    return { recommendations: recs, suggestSample: true, empty: true, disconnected: 0 };
  }

  const hasDownstreamKind = downstreamIndex(nodes, edges);

  // Agent with nowhere to send its result.
  if (nodes.some((n) => n.data.kind === 'agent' && !hasDownstreamKind(n.id, OUTPUT_KINDS))) {
    add('documentation', 'An AI Agent has no output — add one to collect its result.');
    add('file', 'Save the agent output as a File.');
  }

  // Code without a test.
  if (nodes.some((n) => CODE_KINDS.has(n.data.kind)) && !has('test')) {
    add('test', 'You have code but no Test — add one to verify it.');
  }

  // API node implies a data store, secrets, tests and docs.
  if (has('api')) {
    add('database', 'APIs usually read or write a Database.');
    add('env', 'Keep the API key/secret in an Env variable.');
    add('test', 'Add a Test for the endpoint.');
    add('documentation', 'Document the API contract.');
  }

  // Feature described but nothing building it yet.
  if (has('feature') && !has('agent')) {
    add('agent', 'Add an AI Agent to implement the feature.');
  }

  // Generic, always-useful next steps to fill out the menu.
  add('agent', 'Add an AI Agent step.');
  add('function', 'Add a Function / logic step.');
  add('test', 'Add a Test step.');
  add('terminal', 'Add a Terminal command.');
  add('file', 'Add a File.');

  const connectedIds = new Set(edges.flatMap((e) => [e.source, e.target]));
  const disconnected = nodes.filter((n) => !connectedIds.has(n.id)).length;

  return { recommendations: recs.slice(0, 6), suggestSample: false, empty: false, disconnected };
}
