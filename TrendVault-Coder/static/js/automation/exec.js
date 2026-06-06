/**
 * Automation Map — client-side execution controller.
 *
 * Drives single-node runs (Phase 2) and, later, full-graph runs. Streams the
 * backend SSE envelope into the store's runtime state, batching token deltas
 * (~100ms) so the canvas/inspector repaint a few times per second instead of
 * once per token. Stop is wired through an AbortController per node.
 */

import * as store from './store.js';
import * as api from './api.js';

const _controllers = new Map(); // nodeId -> AbortController
const _buffers = new Map();     // nodeId -> { reasoning, output, logs, timer }

export function isNodeRunning(id) { return _controllers.has(id); }

function _queueDelta(id, field, text) {
  if (!text) return;
  let b = _buffers.get(id);
  if (!b) { b = { reasoning: '', output: '', logs: '', timer: null }; _buffers.set(id, b); }
  b[field] += text;
  if (!b.timer) b.timer = setTimeout(() => _flush(id), 100);
}

function _flush(id) {
  const b = _buffers.get(id);
  if (!b) return;
  if (b.timer) { clearTimeout(b.timer); b.timer = null; }
  const patch = {};
  for (const f of ['reasoning', 'output', 'logs']) {
    if (b[f]) { patch[f] = b[f]; b[f] = ''; }
  }
  if (Object.keys(patch).length) store.appendNodeRuntimeBatch(id, patch);
}

/** Outputs of immediate upstream nodes, keyed by source node id. */
function collectInputs(id) {
  const st = store.getState();
  const inputs = {};
  for (const e of st.edges) {
    if (e.target !== id) continue;
    const rt = st.runtime[e.source];
    if (rt && rt.output) inputs[e.source] = rt.output;
  }
  return inputs;
}

function handleEvent(id, ev) {
  switch (ev && ev.type) {
    case 'node_status': {
      _flush(id);
      const patch = { status: ev.status };
      if (ev.error) patch.error = ev.error;
      if (ev.run_id || ev.runId) patch.runId = ev.run_id || ev.runId;
      if (ev.model) patch.model = ev.model;
      if (ev.status === 'success' && typeof ev.output === 'string') patch.output = ev.output;
      store.setNodeRuntime(id, patch);
      break;
    }
    case 'reasoning': _queueDelta(id, 'reasoning', ev.delta || ''); break;
    case 'output': _queueDelta(id, 'output', ev.delta || ''); break;
    case 'log': _queueDelta(id, 'logs', ev.data || ''); break;
    case 'usage': store.setNodeRuntime(id, { usage: ev.data }); break;
    case 'file': store.setNodeRuntime(id, { lastFile: ev.rel_path }); break;
    case 'done': _flush(id); break;
    default: break;
  }
}

/** Run a single node. Resolves when the stream ends. */
export async function runNode(node, { inputs } = {}) {
  const id = node.id;
  if (_controllers.has(id)) return;
  const ctrl = new AbortController();
  _controllers.set(id, ctrl);
  _buffers.delete(id);
  store.setNodeRuntime(id, { status: 'running', reasoning: '', output: '', logs: '', error: null, usage: null });
  store.setActiveRun({ status: 'running', nodeId: id });

  try {
    await api.streamRun({
      path: '/api/automation/run-node',
      signal: ctrl.signal,
      body: {
        workflow_id: store.getState().activeBoardId,
        node,
        inputs: inputs || collectInputs(id),
        model: node.data?.model || '',
        endpoint_id: node.data?.endpointId || '',
      },
      onEvent: (ev) => handleEvent(id, ev),
    });
  } catch (e) {
    _flush(id);
    if (ctrl.signal.aborted) {
      store.setNodeRuntime(id, { status: 'cancelled' });
    } else {
      const msg = (e && (e.body?.detail?.message || e.message)) || String(e);
      store.setNodeRuntime(id, { status: 'failed', error: msg });
    }
  } finally {
    _flush(id);
    _controllers.delete(id);
    // If the stream ended without a terminal status, settle it.
    const rt = store.getNodeRuntime(id);
    if (rt && rt.status === 'running') store.setNodeRuntime(id, { status: 'success' });
    if (store.getState().activeRun?.nodeId === id) store.setActiveRun(null);
  }
}

export function stopNode(id) {
  const c = _controllers.get(id);
  if (c) c.abort();
}

export async function retryNode(node) {
  store.clearNodeRuntime(node.id);
  await runNode(node);
}

/** Reset a node's execution state (stops it first if it's still running). */
export function resetNode(id) {
  const c = _controllers.get(id);
  if (c) c.abort();
  _buffers.delete(id);
  store.clearNodeRuntime(id);
}

/* ------------------------------------------------------------------ */
/* Full-graph run (n8n-style: nodes execute in topological order)      */
/* ------------------------------------------------------------------ */

let _wfController = null;
let _wfToken = null;

export function isWorkflowRunning() { return !!_wfController; }

function handleWorkflowEvent(ev) {
  if (!ev) return;
  if (ev.type === 'run_token') { _wfToken = ev.token; return; }
  if (ev.type === 'workflow_status') {
    if (ev.status === 'running') {
      store.setActiveRun({ status: 'running', mode: 'graph', token: _wfToken });
    } else {
      store.setActiveRun({ status: ev.status, mode: 'graph', error: ev.error || null, cycleNodes: ev.cycle_nodes || null });
    }
    return;
  }
  if (ev.type === 'done') {
    for (const id of Object.keys(store.getState().runtime)) _flush(id);
    return;
  }
  if (ev.node_id) handleEvent(ev.node_id, ev);
}

/** Run the whole graph. Seeds every node 'waiting', then the server drives
 *  status transitions in topological order. */
export async function runWorkflow() {
  if (_wfController) return;
  const st = store.getState();
  const doc = { nodes: st.nodes, edges: st.edges, spaces: st.spaces };
  const waiting = {};
  for (const n of st.nodes) waiting[n.id] = { status: 'waiting', reasoning: '', output: '', logs: '', error: null };
  store.setRuntimeAll(waiting);
  _wfController = new AbortController();
  _wfToken = null;
  store.setActiveRun({ status: 'running', mode: 'graph' });
  try {
    await api.streamRun({
      path: '/api/automation/run-workflow',
      signal: _wfController.signal,
      body: { workflow_id: st.activeBoardId, doc },
      onEvent: handleWorkflowEvent,
    });
  } catch (e) {
    if (!(_wfController && _wfController.signal.aborted)) {
      store.setActiveRun({ status: 'failed', mode: 'graph', error: (e && (e.body?.detail?.message || e.message)) || String(e) });
    }
  } finally {
    for (const id of Object.keys(store.getState().runtime)) _flush(id);
    const aborted = _wfController && _wfController.signal.aborted;
    _wfController = null;
    const ar = store.getState().activeRun;
    if (aborted) store.setActiveRun({ status: 'cancelled', mode: 'graph' });
    else if (ar && ar.status === 'running') store.setActiveRun({ status: 'success', mode: 'graph' });
    _wfToken = null;
  }
}

export async function stopWorkflow() {
  if (_wfController) _wfController.abort();
  if (_wfToken) { try { await api.postJSON('/api/automation/cancel', { run_token: _wfToken }); } catch { /* ignore */ } }
}

/** Retry the whole workflow after a failure. The engine re-runs from the top;
 *  nodes that already succeeded simply pass their cached output through again,
 *  so this effectively resumes from the first failed node. */
export async function retryWorkflow() {
  if (_wfController) return;
  await runWorkflow();
}
