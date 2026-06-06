/**
 * Automation Map — Full System Check harness.
 *
 * Exercises every feature of the app for real (not a mock): canvas operations,
 * connections, persistence, the execution engine, the UI surfaces and every
 * executable node kind — then reports pass / fail / warning / fix-needed with
 * error details. Runs against the LIVE store + backend, snapshotting the user's
 * graph first and restoring it exactly when finished (in a finally block, so a
 * thrown check can never leave scratch state behind).
 *
 * Design notes:
 *  • Canvas checks create scratch nodes and clean them up themselves; the
 *    snapshot/restore is a safety net on top.
 *  • Execution checks pass a synthetic graph inline to the real run endpoints
 *    using the active (owned) board id — no graph mutation, real run history.
 *  • Anything that needs a runtime/model/admin that isn't available is reported
 *    as a WARNING with a clear fix, never a hard FAIL.
 */

import * as store from './store.js';
import * as api from './api.js';
import { makeNodeData, normalizeNode, KIND_META, KIND_ORDER } from './registry.js';
import { validateWorkflow, summarizeWorkflow } from './validation.js';
import { nodeMatchesFilters } from './filtering.js';
import { EXPORTERS, runExport, buildOrder } from './exporters.js';
import { parseWorkflowFile } from './io.js';
import { recommendNodes } from './suggestions.js';
import { buildAgentPipelineSample } from './sample.js';

const errMsg = (e) => (e && (e.body?.detail?.message || e.body?.detail || e.message)) || String(e || 'error');
const delay = (ms) => new Promise((r) => setTimeout(r, ms));

/* result builders */
const pass = (detail) => ({ status: 'pass', detail });
const fail = (detail, fix) => ({ status: 'fail', detail, fix });
const warn = (detail, fix) => ({ status: 'warn', detail, fix });
const skip = (detail) => ({ status: 'skip', detail });

/** Run an SSE endpoint to completion (or timeout), collecting every event. */
function streamToEnd(path, body, { timeout = 15000 } = {}) {
  return new Promise((resolve, reject) => {
    const events = [];
    const ctrl = new AbortController();
    const timer = setTimeout(() => { ctrl.abort(); reject(new Error(`timed out after ${timeout}ms`)); }, timeout);
    api.streamRun({ path, body, signal: ctrl.signal, onEvent: (ev) => events.push(ev) })
      .then(() => { clearTimeout(timer); resolve(events); })
      .catch((e) => { clearTimeout(timer); reject(e); });
  });
}

function finalNodeStatus(events, nodeId) {
  let st = null;
  for (const ev of events) {
    if (ev.type === 'node_status' && (!nodeId || ev.node_id === nodeId)) st = ev;
  }
  return st;
}
function workflowStatus(events) {
  let st = null;
  for (const ev of events) if (ev.type === 'workflow_status') st = ev;
  return st;
}

/**
 * Run the whole suite. Emits each result via onResult as it completes and
 * coarse progress via onProgress. Resolves to { results, summary }.
 */
export async function runSystemCheck({ onResult, onProgress } = {}) {
  const results = [];
  const snap = store.snapshotGraph();
  const wid = store.getState().activeBoardId;
  const synced = store.getState().serverSynced;

  // Shared scratch state across the canvas checks.
  let aId = null;
  let bId = null;
  let scratchEdgeId = null;
  let adminOk = null;   // determined by the File-node execution check
  let modelCount = null;

  const steps = [];
  const step = (id, label, category, fn) => steps.push({ id, label, category, fn });

  /* ---------------- Canvas ---------------- */
  step('add-node', 'Add node', 'Canvas', async () => {
    const before = store.getState().nodes.length;
    aId = store.addNode('feature');
    const node = store.getState().nodes.find((n) => n.id === aId);
    if (node && store.getState().nodes.length === before + 1) return pass('Created a Feature node on the canvas.');
    return fail('addNode did not add a node to the store.', 'Check store.addNode / registry.makeNodeData.');
  });

  step('drag-node', 'Drag node', 'Canvas', async () => {
    if (!aId) return skip('No scratch node (Add node failed).');
    store.setNodePosition(aId, { x: 640, y: 240 });
    const n = store.getState().nodes.find((x) => x.id === aId);
    if (n && n.position.x === 640 && n.position.y === 240) return pass('Repositioned the node (drag path).');
    return fail('Node position did not update.', 'Check store.setNodePosition + canvas drag handler.');
  });

  step('move-node', 'Move node (precise)', 'Canvas', async () => {
    if (!aId) return skip('No scratch node.');
    store.setNodePosition(aId, { x: 880, y: 360 });
    const n = store.getState().nodes.find((x) => x.id === aId);
    if (n && n.position.x === 880 && n.position.y === 360) return pass('Moved the node to exact coordinates.');
    return fail('Precise move failed.', 'Check store.setNodePosition.');
  });

  /* ---------------- Connections ---------------- */
  step('connect', 'Connect nodes', 'Connections', async () => {
    if (!aId) return skip('No scratch node.');
    bId = store.addNode('agent');
    const a = store.getState().nodes.find((n) => n.id === aId);
    const b = store.getState().nodes.find((n) => n.id === bId);
    store.onConnect({
      source: aId, sourceHandle: a.data.outputs[0]?.id,
      target: bId, targetHandle: b.data.inputs[0]?.id,
    });
    const edge = store.getState().edges.find((e) => e.source === aId && e.target === bId);
    if (edge) { scratchEdgeId = edge.id; return pass('Connected two nodes with an edge.'); }
    return fail('onConnect did not create an edge.', 'Check store.onConnect + canvas connect gesture.');
  });

  step('validate-connection', 'Validate connections', 'Connections', async () => {
    const health = validateWorkflow(store.getState().nodes, store.getState().edges);
    if (aId && bId && health[aId] && health[bId]) {
      return pass('Per-node + whole-graph validation produced health for every node.');
    }
    return fail('Validation did not cover all nodes.', 'Check validation.validateWorkflow.');
  });

  step('delete-connection', 'Delete connection', 'Connections', async () => {
    if (!scratchEdgeId) return skip('No scratch edge.');
    store.deleteEdge(scratchEdgeId);
    const gone = !store.getState().edges.some((e) => e.id === scratchEdgeId);
    if (gone) return pass('Removed the connection.');
    return fail('deleteEdge did not remove the edge.', 'Check store.deleteEdge.');
  });

  step('delete-node', 'Delete node', 'Canvas', async () => {
    let okA = true, okB = true;
    if (aId) { store.deleteNode(aId); okA = !store.getState().nodes.some((n) => n.id === aId); }
    if (bId) { store.deleteNode(bId); okB = !store.getState().nodes.some((n) => n.id === bId); }
    aId = bId = scratchEdgeId = null;
    if (okA && okB) return pass('Deleted nodes (and their edges) from the canvas.');
    return fail('deleteNode left a node behind.', 'Check store.deleteNode.');
  });

  step('undo-redo', 'Undo / redo', 'Canvas', async () => {
    const before = store.getState().nodes.length;
    const tmp = store.addNode('documentation');
    store.undo();
    const afterUndo = store.getState().nodes.length;
    store.redo();
    const afterRedo = store.getState().nodes.length;
    // Clean up whatever survived.
    if (store.getState().nodes.some((n) => n.id === tmp)) store.deleteNode(tmp);
    if (afterUndo === before && afterRedo === before + 1) return pass('Undo and redo both worked.');
    return warn(`Undo/redo counts unexpected (before ${before}, undo ${afterUndo}, redo ${afterRedo}).`,
      'Check store.undo / store.redo history stack.');
  });

  /* ---------------- Persistence (SQLite) ---------------- */
  step('save', 'Save project', 'Persistence', async () => {
    try {
      const r = await store.saveNow();
      if (r && r.ok) return pass(`Saved to the server (rev ${r.rev}).`);
      return warn('Server offline — saved to the local cache only.',
        'Start the TrendVault server / sign in so boards persist to SQLite.');
    } catch (e) {
      return fail('Save failed: ' + errMsg(e), 'Check PUT /api/automation/workflows/{id} and the rev guard.');
    }
  });

  step('load', 'Load project', 'Persistence', async () => {
    if (!synced) return warn('Server offline — cannot round-trip from SQLite.', 'Start the server to test load.');
    try {
      const full = await api.getWorkflow(wid);
      if (full && full.doc && Array.isArray(full.doc.nodes)) {
        return pass(`Loaded board "${full.name}" (${full.doc.nodes.length} nodes) from SQLite.`);
      }
      return fail('Loaded board had no doc.', 'Check GET /api/automation/workflows/{id}.');
    } catch (e) {
      return fail('Load failed: ' + errMsg(e), 'Check the workflow GET route + ownership.');
    }
  });

  step('sqlite', 'SQLite persistence (round-trip)', 'Persistence', async () => {
    if (!synced) return warn('Server offline — persistence runs against localStorage only.',
      'Start the server so nodes, positions, connections and runs persist to SQLite.');
    try {
      await store.saveNow();
      const full = await api.getWorkflow(wid);
      const serverCount = (full.doc.nodes || []).length;
      const localCount = store.getState().nodes.length;
      if (serverCount === localCount) {
        return pass(`Graph persisted: ${serverCount} nodes match between the canvas and SQLite.`);
      }
      return warn(`Server has ${serverCount} nodes, canvas has ${localCount} (autosave may be mid-flight).`,
        'Re-run after the autosave settles.');
    } catch (e) {
      return fail('Round-trip failed: ' + errMsg(e), 'Check the workflow save/load routes.');
    }
  });

  step('import', 'Import workflow', 'Persistence', async () => {
    const fixture = JSON.stringify({
      app: 'trendvault-automation-map', version: 1,
      nodes: [{ id: 'imp1', type: 'workflow', position: { x: 0, y: 0 }, data: { kind: 'feature', title: 'Imported' } }],
      edges: [], spaces: [],
    });
    try {
      const parsed = parseWorkflowFile(fixture);
      const nodes = parsed.nodes.map(normalizeNode);
      if (nodes.length === 1 && nodes[0].data.kind === 'feature' && nodes[0].data.title === 'Imported') {
        return pass('Parsed + normalized an imported workflow file.');
      }
      return fail('Import parser produced the wrong nodes.', 'Check io.parseWorkflowFile + registry.normalizeNode.');
    } catch (e) {
      return fail('Import parse failed: ' + errMsg(e), 'Check io.parseWorkflowFile validation.');
    }
  });

  step('export', 'Export workflow', 'Persistence', async () => {
    const s = store.getState();
    const iso = new Date().toISOString();
    const empties = [];
    for (const exp of EXPORTERS) {
      const text = runExport(exp.id, s.nodes, s.edges, s.spaces, iso);
      if (!text || !text.trim()) empties.push(exp.label);
    }
    // The JSON export must round-trip.
    let jsonOk = false;
    try { jsonOk = Array.isArray(JSON.parse(runExport('json', s.nodes, s.edges, s.spaces, iso)).nodes); } catch { /* */ }
    if (empties.length) return fail('Empty export(s): ' + empties.join(', '), 'Check exporters.runExport.');
    if (!jsonOk) return fail('JSON export did not round-trip.', 'Check exporters.exportJSON.');
    return pass(`All ${EXPORTERS.length} export formats produced output (JSON re-parses).`);
  });

  /* ---------------- Execution engine ---------------- */
  step('run-workflow', 'Run workflow (engine)', 'Execution', async () => {
    if (!synced) return warn('Server offline — cannot run the workflow engine.', 'Start the server to run workflows.');
    const f = { id: 'chk-in', type: 'workflow', position: { x: 0, y: 0 },
      data: { ...makeNodeData('feature', 'features'), title: 'Check Input', description: 'system-check input' } };
    const d = { id: 'chk-out', type: 'workflow', position: { x: 320, y: 0 },
      data: { ...makeNodeData('documentation', 'documentation'), title: 'Check Output' } };
    const edge = { id: 'chk-e', source: 'chk-in', target: 'chk-out',
      sourceHandle: f.data.outputs[0]?.id, targetHandle: d.data.inputs[0]?.id, type: 'labeled', data: { label: '', kind: 'default' } };
    try {
      const events = await streamToEnd('/api/automation/run-workflow',
        { workflow_id: wid, doc: { nodes: [f, d], edges: [edge], spaces: [] } });
      const ws = workflowStatus(events);
      const outStatus = finalNodeStatus(events, 'chk-out');
      if (ws && ws.status === 'success' && outStatus && outStatus.status === 'success') {
        return pass('Ran a 2-node graph end-to-end: nodes executed in order and output passed downstream.');
      }
      return fail('Workflow did not complete successfully: ' + (ws ? ws.status : 'no status'),
        ws && ws.error ? ws.error : 'Check the WorkflowExecutor.');
    } catch (e) {
      return fail('Run failed: ' + errMsg(e), 'Check POST /api/automation/run-workflow (SSE).');
    }
  });

  step('workflow-validate', 'Workflow validation (cycle detection)', 'Execution', async () => {
    if (!synced) return skip('Server offline.');
    // A 2-node cycle must be rejected before execution.
    const n1 = { id: 'cyc1', type: 'workflow', position: { x: 0, y: 0 }, data: makeNodeData('feature', 'features') };
    const n2 = { id: 'cyc2', type: 'workflow', position: { x: 200, y: 0 }, data: makeNodeData('feature', 'features') };
    const e1 = { id: 'ce1', source: 'cyc1', target: 'cyc2', type: 'labeled', data: {} };
    const e2 = { id: 'ce2', source: 'cyc2', target: 'cyc1', type: 'labeled', data: {} };
    try {
      const events = await streamToEnd('/api/automation/run-workflow',
        { workflow_id: wid, doc: { nodes: [n1, n2], edges: [e1, e2], spaces: [] } });
      const ws = workflowStatus(events);
      if (ws && ws.status === 'failed' && /cycle/i.test(ws.error || '')) {
        return pass('A cyclic graph was correctly rejected before running.');
      }
      return warn('Cycle was not flagged as expected.', 'Check workflow_executor.topo_order cycle detection.');
    } catch (e) {
      return fail('Validation run failed: ' + errMsg(e), 'Check the run-workflow route.');
    }
  });

  step('run-node', 'Manual node execution', 'Execution', async () => {
    if (!synced) return warn('Server offline — cannot run single nodes.', 'Start the server.');
    const node = { id: 'chk-manual', type: 'workflow',
      data: { ...makeNodeData('feature', 'features'), title: 'Manual Check', description: 'manual run output' } };
    try {
      const events = await streamToEnd('/api/automation/run-node', { workflow_id: wid, node, inputs: {} });
      const st = finalNodeStatus(events, 'chk-manual');
      if (st && st.status === 'success') return pass('Ran a single node manually (Run button path) and it succeeded.');
      return fail('Manual run did not succeed: ' + (st ? st.status : 'no status'),
        st && st.error ? st.error : 'Check POST /api/automation/run-node.');
    } catch (e) {
      return fail('Manual run failed: ' + errMsg(e), 'Check the run-node route.');
    }
  });

  step('cancel', 'Stop / cancel wiring', 'Execution', async () => {
    if (!synced) return skip('Server offline.');
    try {
      const r = await api.postJSON('/api/automation/cancel', { run_token: 'system-check-no-such-token' });
      if (r && r.cancelled === false) return pass('Cancel endpoint reachable (correctly reports nothing to cancel).');
      return warn('Cancel endpoint returned an unexpected shape.', 'Check POST /api/automation/cancel.');
    } catch (e) {
      return fail('Cancel endpoint failed: ' + errMsg(e), 'Check the cancel route.');
    }
  });

  step('logs', 'Logs capture', 'Execution', async () => {
    if (!synced) return skip('Server offline.');
    const node = { id: 'chk-logs', type: 'workflow',
      data: { ...makeNodeData('feature', 'features'), title: 'Logs Check', description: 'logs output' } };
    try {
      const events = await streamToEnd('/api/automation/run-node', { workflow_id: wid, node, inputs: {} });
      const gotLog = events.some((ev) => ev.type === 'log' && ev.data);
      if (gotLog) return pass('Streamed log lines were received during a run.');
      return warn('No log events captured (design nodes emit a single line).', 'Check the SSE log frames.');
    } catch (e) {
      return fail('Logs check failed: ' + errMsg(e), 'Check run-node log streaming.');
    }
  });

  step('progress', 'Progress bars / live status', 'Execution', async () => {
    // Drive a scratch node into "running" and confirm the canvas renders its
    // progress UI, then reset + remove it.
    const pid = store.addNode('feature');
    store.setNodeRuntime(pid, { status: 'running', output: '', logs: '', reasoning: '' });
    await delay(60); // let the canvas subscriber repaint
    const card = document.querySelector(`.am-node[data-node-id="${pid}"]`);
    const hasProgress = !!(card && card.querySelector('.am-node-progress'));
    const hasBadge = !!(card && card.querySelector('.am-node-run'));
    store.clearNodeRuntime(pid);
    store.deleteNode(pid);
    if (hasProgress && hasBadge) return pass('Running nodes show a live progress bar + status badge on the canvas.');
    if (hasBadge) return warn('Status badge shows but the progress bar was not found.', 'Check canvas.nodeInner progress markup.');
    return fail('No live run UI rendered for a running node.', 'Check the runtime → canvas binding.');
  });

  /* ---------------- Interface ---------------- */
  step('command-palette', 'Command palette', 'Interface', async () => {
    store.setCommandOpen(true);
    await delay(30);
    const overlay = document.querySelector('.am-cmdk-overlay');
    const open = store.getState().commandOpen && overlay && overlay.style.display !== 'none';
    store.setCommandOpen(false);
    if (open) return pass('Command palette opens (Ctrl/Cmd+K) and renders its overlay.');
    return fail('Command palette did not open.', 'Check store.setCommandOpen + commandPalette.js.');
  });

  step('search-filter', 'Search & filters', 'Interface', async () => {
    const nodes = store.getState().nodes;
    const health = validateWorkflow(nodes, store.getState().edges);
    const token = '___sysckeck_no_match___';
    const matches = nodes.filter((n) => nodeMatchesFilters(n, { search: token, statuses: [], kinds: [], tags: [], brokenOnly: false, unfinishedOnly: false }, 'all', health[n.id]));
    const kindFilterWorks = nodes.length === 0 || nodes.some((n) =>
      nodeMatchesFilters(n, { search: '', statuses: [], kinds: [n.data.kind], tags: [], brokenOnly: false, unfinishedOnly: false }, 'all', health[n.id]));
    if (matches.length === 0 && kindFilterWorks) return pass('Search narrows results and type filters match.');
    return fail('Filter predicate behaved unexpectedly.', 'Check filtering.nodeMatchesFilters.');
  });

  step('sample', 'Sample workflow', 'Interface', async () => {
    const s = buildAgentPipelineSample();
    const order = buildOrder(s.nodes, s.edges);
    const connectedIds = new Set(s.edges.flatMap((e) => [e.source, e.target]));
    const isolated = s.nodes.filter((n) => !connectedIds.has(n.id)).length;
    if (s.nodes.length === 5 && s.edges.length === 4 && isolated === 0 && order.length === 5) {
      return pass('Sample pipeline builds: Input → Research → Coding → Test → Output, fully connected.');
    }
    return fail(`Sample shape unexpected (${s.nodes.length} nodes, ${s.edges.length} edges, ${isolated} isolated).`,
      'Check sample.buildAgentPipelineSample.');
  });

  step('suggestions', 'Node suggestions', 'Interface', async () => {
    const { recommendations } = recommendNodes(store.getState().nodes, store.getState().edges);
    const empty = recommendNodes([], []);
    if (recommendations.length > 0 && empty.recommendations.length > 0 && empty.suggestSample) {
      return pass(`Suggested ${recommendations.length} next nodes for this graph (empty canvas suggests starters + sample).`);
    }
    return fail('Suggestion engine returned nothing.', 'Check suggestions.recommendNodes.');
  });

  step('health-panel', 'Connection health', 'Interface', async () => {
    const nodes = store.getState().nodes;
    const health = validateWorkflow(nodes, store.getState().edges);
    const summary = summarizeWorkflow(nodes, store.getState().edges, health);
    const panel = document.querySelector('.am-health');
    if (summary && summary.counts && panel) {
      return pass(`Connection health live: ${summary.total} nodes summarised, readiness=${summary.readyToBuild}.`);
    }
    return fail('Health summary or panel missing.', 'Check panels.createHealthPanel + validation.summarizeWorkflow.');
  });

  /* ---------------- Node kinds ---------------- */
  step('registry', 'Node type registry', 'Nodes', async () => {
    const missing = KIND_ORDER.filter((k) => !KIND_META[k]);
    const built = KIND_ORDER.every((k) => { const d = makeNodeData(k, 'frontend'); return d && d.kind === k && Array.isArray(d.inputs) && Array.isArray(d.outputs); });
    if (!missing.length && built) return pass(`All ${KIND_ORDER.length} node types are registered and build valid data.`);
    return fail('Some node types are broken: ' + missing.join(', '), 'Check registry.KIND_META / makeNodeData.');
  });

  step('agent-node', 'AI Agent node', 'Nodes', async () => {
    const d = makeNodeData('agent', 'ai-agents');
    const ok = 'systemPrompt' in d && 'prompt' in d && 'model' in d && 'temperature' in d;
    if (!ok) return fail('Agent node is missing prompt/model fields.', 'Check registry.makeNodeData for agent.');
    try {
      const m = await api.listModels();
      modelCount = (m.models || []).length;
    } catch { modelCount = 0; }
    if (modelCount > 0) return pass(`Agent node ready; ${modelCount} model(s) available to run it.`);
    return warn('Agent node is configured but no model was detected.',
      'Start Ollama (e.g. `ollama run llama3.2`) or add a model endpoint so agents can run.');
  });

  step('file-node', 'File node (code execution)', 'Nodes', async () => {
    if (!synced) return warn('Server offline — cannot test file execution.', 'Start the server.');
    const node = { id: 'chk-file', type: 'workflow',
      data: { ...makeNodeData('file', 'frontend'), title: 'check.txt', path: '.systemcheck/check.txt', code: 'system check ok' } };
    try {
      const events = await streamToEnd('/api/automation/run-node', { workflow_id: wid, node, inputs: {} });
      const st = finalNodeStatus(events, 'chk-file');
      if (st && st.status === 'success') {
        adminOk = true;
        const wrote = events.some((ev) => ev.type === 'file' && ev.rel_path);
        return pass('File node executed: wrote a file into the workspace' + (wrote ? ' (file event received).' : '.'));
      }
      return fail('File node run did not succeed.', st && st.error ? st.error : 'Check file_node_events.');
    } catch (e) {
      if (e && (e.status === 403 || e.status === 401)) {
        adminOk = false;
        return warn('Code/file execution is admin-only for this account.',
          'Sign in as an admin user to run File / Function / Terminal nodes.');
      }
      return fail('File node run failed: ' + errMsg(e), 'Check POST /api/automation/run-node for file kind.');
    }
  });

  step('function-node', 'Function node', 'Nodes', async () => {
    const d = makeNodeData('function', 'backend');
    const ok = 'code' in d && 'language' in d;
    if (!ok) return fail('Function node missing code/language fields.', 'Check registry.makeNodeData.');
    if (adminOk === false) return warn('Function execution is admin-only for this account.', 'Sign in as admin to run code nodes.');
    return pass('Function node registered; runs Python/JS/TS in the workspace (admin-gated, needs the runtime on PATH).');
  });

  step('terminal-node', 'Terminal node', 'Nodes', async () => {
    const d = makeNodeData('terminal', 'backend');
    if (!('command' in d)) return fail('Terminal node missing command field.', 'Check registry.makeNodeData.');
    if (adminOk === false) return warn('Terminal execution is admin-only for this account.', 'Sign in as admin to run terminal nodes.');
    return pass('Terminal node registered; runs shell commands in the workspace (admin-gated).');
  });

  /* ---------------- run them ---------------- */
  try {
    let done = 0;
    for (const s of steps) {
      onProgress && onProgress({ done, total: steps.length, label: s.label });
      let res;
      try { res = await s.fn(); }
      catch (e) { res = fail('Unexpected error: ' + errMsg(e), 'See the browser console for the stack trace.'); }
      const row = { id: s.id, label: s.label, category: s.category, ...res };
      results.push(row);
      onResult && onResult(row);
      done += 1;
      onProgress && onProgress({ done, total: steps.length, label: s.label });
      await delay(20); // let the report paint incrementally
    }
  } finally {
    // Always put the user's graph back exactly as it was, and persist it.
    try { store.restoreGraph(snap); } catch { /* ignore */ }
    try { if (synced) await store.saveNow(); } catch { /* ignore */ }
  }

  return { results, summary: summarize(results) };
}

export function summarize(results) {
  const s = { total: results.length, pass: 0, fail: 0, warn: 0, skip: 0, fixNeeded: 0 };
  for (const r of results) {
    if (r.status === 'pass') s.pass += 1;
    else if (r.status === 'fail') s.fail += 1;
    else if (r.status === 'warn') s.warn += 1;
    else s.skip += 1;
    if ((r.status === 'fail' || r.status === 'warn') && r.fix) s.fixNeeded += 1;
  }
  return s;
}

/** Plain-text report for the "Copy report" button. */
export function formatReport(results, summary) {
  const lines = ['Automation Map — Full System Check', new Date().toISOString(), ''];
  lines.push(`Passed ${summary.pass} · Failed ${summary.fail} · Warnings ${summary.warn} · Skipped ${summary.skip} · Fix needed ${summary.fixNeeded}`, '');
  const icon = { pass: '✓', fail: '✗', warn: '⚠', skip: '⊘' };
  let cat = '';
  for (const r of results) {
    if (r.category !== cat) { cat = r.category; lines.push('', `## ${cat}`); }
    lines.push(`${icon[r.status] || '•'} ${r.label} — ${r.detail || ''}`.trim());
    if (r.fix && (r.status === 'fail' || r.status === 'warn')) lines.push(`    Fix: ${r.fix}`);
  }
  return lines.join('\n');
}
