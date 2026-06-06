/**
 * Automation Map — backend API client.
 *
 * Thin fetch/SSE wrappers around the /api/automation/* endpoints plus the
 * shared /api/models + /api/default-chat discovery routes. Keeps all network
 * concerns in one place so the store / inspector / toolbar stay UI-only.
 *
 * Convention mirrors the rest of the app: same-origin credentials, JSON
 * bodies, and `API_BASE = window.location.origin`.
 */

const API_BASE = window.location.origin;

/** An Error carrying the HTTP status + parsed body (for 409 conflict, etc.). */
export class ApiError extends Error {
  constructor(status, body, message) {
    super(message || (body && (body.detail?.message || body.detail || body.error)) || `HTTP ${status}`);
    this.name = 'ApiError';
    this.status = status;
    this.body = body;
  }
}

async function parseBody(res) {
  const ct = res.headers.get('content-type') || '';
  if (ct.includes('application/json')) {
    try { return await res.json(); } catch { return null; }
  }
  try { return await res.text(); } catch { return null; }
}

async function request(method, path, body) {
  const opts = { method, credentials: 'same-origin', headers: {} };
  if (body !== undefined) {
    opts.headers['Content-Type'] = 'application/json';
    opts.body = JSON.stringify(body);
  }
  const res = await fetch(`${API_BASE}${path}`, opts);
  const data = await parseBody(res);
  if (!res.ok) throw new ApiError(res.status, data);
  return data;
}

export const getJSON = (path) => request('GET', path);
export const postJSON = (path, body) => request('POST', path, body ?? {});
export const putJSON = (path, body) => request('PUT', path, body ?? {});
export const delJSON = (path) => request('DELETE', path);

/* ------------------------------------------------------------------ */
/* Workflow CRUD                                                       */
/* ------------------------------------------------------------------ */

export const listWorkflows = () =>
  getJSON('/api/automation/workflows').then((r) => r.workflows || []);

export const getWorkflow = (id) =>
  getJSON(`/api/automation/workflows/${encodeURIComponent(id)}`);

export const createWorkflow = ({ name, doc }) =>
  postJSON('/api/automation/workflows', { name, doc });

/** Autosave / save. Sends the last-seen `rev`; a stale rev throws ApiError(409). */
export const saveWorkflow = (id, { name, doc, rev }) =>
  putJSON(`/api/automation/workflows/${encodeURIComponent(id)}`, { name, doc, rev });

export const deleteWorkflow = (id) =>
  delJSON(`/api/automation/workflows/${encodeURIComponent(id)}`);

export const exportWorkflow = (id) =>
  getJSON(`/api/automation/workflows/${encodeURIComponent(id)}/export`);

export const importWorkflow = (file) =>
  postJSON('/api/automation/workflows/import', file);

/* ------------------------------------------------------------------ */
/* Run history + workspace files                                       */
/* ------------------------------------------------------------------ */

export const listRuns = (workflowId) =>
  getJSON(`/api/automation/workflows/${encodeURIComponent(workflowId)}/runs`).then((r) => r.runs || []);

export const getRun = (runId) =>
  getJSON(`/api/automation/runs/${encodeURIComponent(runId)}`);

export const listFiles = (workflowId) =>
  getJSON(`/api/automation/workflows/${encodeURIComponent(workflowId)}/files`).then((r) => r.files || []);

export const getFileContent = (workflowId, relPath) =>
  getJSON(`/api/automation/workflows/${encodeURIComponent(workflowId)}/file?path=${encodeURIComponent(relPath)}`);

/* ------------------------------------------------------------------ */
/* Model discovery (Agent node dropdown)                               */
/* ------------------------------------------------------------------ */

let _modelCache = null;

/**
 * Installed models across configured endpoints + the local Ollama instance,
 * plus the resolved default (DeepSeek-R1 when present). Served by the backend
 * so the dropdown is populated even before the user configures an endpoint.
 * Shape: { models: [{id, endpointId, endpointUrl, label, offline}], default: {...}|null }
 */
export async function listModels({ force = false } = {}) {
  if (_modelCache && !force) return _modelCache;
  const res = await getJSON('/api/automation/models').catch(() => ({ models: [], default: null }));
  _modelCache = { models: res.models || [], default: res.default || null };
  return _modelCache;
}

export function clearModelCache() { _modelCache = null; }

/* ------------------------------------------------------------------ */
/* SSE streaming (run-node / run-workflow)                             */
/* ------------------------------------------------------------------ */

/**
 * POST `body` to `path` and consume the Server-Sent-Events response, calling
 * `onEvent(evt)` for each parsed `data:` JSON payload. Resolves when the
 * stream ends ([DONE] or socket close). Pass an AbortController `signal` to
 * stop early (Stop button). Mirrors the reader loop used by chat.js.
 */
export async function streamRun({ path, body, onEvent, signal }) {
  const res = await fetch(`${API_BASE}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    credentials: 'same-origin',
    body: JSON.stringify(body || {}),
    signal,
  });
  if (!res.ok || !res.body) {
    const data = await parseBody(res);
    throw new ApiError(res.status, data);
  }
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = '';
  let evt = null;
  try {
    while (true) {
      let chunk;
      try {
        chunk = await reader.read();
      } catch (e) {
        if (signal && signal.aborted) break;
        throw e;
      }
      if (chunk.done) break;
      buf += dec.decode(chunk.value, { stream: true });
      let nl;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl).replace(/\r$/, '');
        buf = buf.slice(nl + 1);
        if (line === '') { evt = null; continue; }
        if (line.startsWith('event:')) { evt = line.slice(6).trim(); continue; }
        if (line.startsWith('data:')) {
          const raw = line.slice(5).trim();
          if (raw === '[DONE]') { onEvent({ type: 'done' }); return; }
          let payload;
          try { payload = JSON.parse(raw); } catch { payload = { raw }; }
          if (evt === 'error') {
            onEvent({ type: 'node_status', status: 'failed', error: payload.error || payload.text || raw });
          } else {
            onEvent(payload);
          }
        }
      }
    }
  } finally {
    try { reader.releaseLock(); } catch { /* ignore */ }
  }
  onEvent({ type: 'done' });
}
