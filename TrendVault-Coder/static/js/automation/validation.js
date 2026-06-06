/**
 * Automation Map — workflow validation (ported from lib/validation.ts).
 * Pure functions: per-node health, whole-graph health map, and a summary.
 */

import { HEALTH_ORDER, KIND_META } from './registry.js';

function incomingCount(nodeId, edges) {
  return edges.filter((e) => e.target === nodeId).length;
}
function outgoingCount(nodeId, edges) {
  return edges.filter((e) => e.source === nodeId).length;
}

/** All node ids reachable by walking edges backwards from `nodeId`. */
export function getPredecessors(nodeId, edges) {
  const result = new Set();
  const stack = [nodeId];
  while (stack.length) {
    const current = stack.pop();
    for (const edge of edges) {
      if (edge.target === current && !result.has(edge.source)) {
        result.add(edge.source);
        stack.push(edge.source);
      }
    }
  }
  return result;
}

/** Inspect a single node → { level, issues }. Pure. */
export function validateNode(node, nodes, edges) {
  const data = node.data || {};
  const meta = KIND_META[data.kind] || KIND_META.feature;
  const incoming = incomingCount(node.id, edges);
  const outgoing = outgoingCount(node.id, edges);
  const issues = [];

  /* content checks (kind specific) — tolerate partial data defensively */
  if (data.kind === 'api' && !(data.url || '').trim()) issues.push('API node is missing a URL.');
  if (data.kind === 'database') {
    if (!(data.schema || '').trim()) issues.push('Database node has no schema info.');
    if (!data.hasCredentials) issues.push('Database node is missing credentials.');
  }
  if (data.kind === 'agent' && !(data.prompt || '').trim()) issues.push('AI agent node has no prompt.');
  if (data.kind === 'terminal' && !(data.command || '').trim()) issues.push('Terminal node has no command.');
  if (data.kind === 'env' && !(data.envVars || '').trim()) issues.push('Environment node has no variables defined.');
  if (data.kind === 'deployment') {
    const predecessors = getPredecessors(node.id, edges);
    const hasUpstreamTest = nodes.some((n) => predecessors.has(n.id) && n.data.kind === 'test');
    if (!hasUpstreamTest) issues.push('Deployment has no Test step before it.');
  }

  /* structural checks */
  const missingInput = meta.requiresInput && incoming === 0;
  const missingOutput = meta.requiresOutput && outgoing === 0;
  const isolated = incoming === 0 && outgoing === 0;
  if (missingInput) issues.push('This node has no input connection.');
  if (missingOutput) issues.push('This node has no output connection.');

  /* derive a single headline level */
  let level;
  if (isolated && (meta.requiresInput || meta.requiresOutput)) {
    level = 'broken-chain';
  } else if (issues.some((i) => !i.includes('input') && !i.includes('output'))) {
    level = 'needs-review';
  } else if (missingInput) {
    level = 'missing-input';
  } else if (missingOutput) {
    level = 'missing-output';
  } else if (data.status === 'done') {
    level = 'ready';
  } else if (incoming > 0 || outgoing > 0) {
    level = 'connected';
  } else {
    level = 'ready';
  }

  return { level, issues };
}

/** Validate every node → { [id]: NodeHealth }. */
export function validateWorkflow(nodes, edges) {
  const map = {};
  for (const node of nodes) map[node.id] = validateNode(node, nodes, edges);
  return map;
}

const HEALTHY_LEVELS = ['ready', 'connected'];

export function summarizeWorkflow(nodes, edges, healthMap) {
  const counts = HEALTH_ORDER.reduce((acc, level) => ({ ...acc, [level]: 0 }), {});
  for (const node of nodes) {
    const h = healthMap[node.id];
    if (h) counts[h.level] += 1;
  }

  const globalIssues = [];
  const hasDeployment = nodes.some((n) => n.data.kind === 'deployment');
  const hasTest = nodes.some((n) => n.data.kind === 'test');
  if (hasDeployment && !hasTest) globalIssues.push('Workflow deploys but contains no Test node anywhere.');
  if (nodes.length > 1 && edges.length === 0) globalIssues.push('Nodes exist but nothing is connected yet.');

  const readyToBuild =
    nodes.length > 0 &&
    globalIssues.length === 0 &&
    nodes.every((n) => HEALTHY_LEVELS.includes(healthMap[n.id]?.level ?? 'ready'));

  return { total: nodes.length, counts, globalIssues, readyToBuild };
}
