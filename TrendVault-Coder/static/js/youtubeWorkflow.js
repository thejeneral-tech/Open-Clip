/**
 * YouTube Workflow Builder — TrendVault tool entry module.
 *
 * Turns a YouTube video (transcript / metadata / notes / comments / frame
 * descriptions) into a detailed "remake this on my server" prompt — reliably,
 * even for very long transcripts, by chunking + retrying against a local Ollama
 * model and falling back to an offline emergency template.
 *
 * UI: a draggable tool modal (registered with modalManager, mirroring the
 * Automation Map / Calendar pattern) laid out as a responsive two-column grid:
 *   left  = video card · metadata · chapters · tags · history
 *   right = progress flow · manual step buttons · tabs (transcript / comments /
 *           frames / summaries / workflow map / final output) · export
 *
 * Backend: routes/yt_workflow_routes.py  (GET/POST /api/yt-workflow/*).
 * Public API (default export): openYoutubeWorkflow / closeYoutubeWorkflow /
 * isYoutubeWorkflowOpen. Wired to #tool-ytworkflow-btn from app.js.
 */

import * as Modals from './modalManager.js';
import { makeWindowDraggable } from './windowDrag.js';

const MODAL_ID = 'youtube-workflow-modal';
const API = '/api/yt-workflow';
const HEADER_ICON =
  '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="vertical-align:-2px;margin-right:6px"><path d="M2.5 17a24.12 24.12 0 0 1 0-10 2 2 0 0 1 1.4-1.4 49.56 49.56 0 0 1 16.2 0A2 2 0 0 1 21.5 7a24.12 24.12 0 0 1 0 10 2 2 0 0 1-1.4 1.4 49.55 49.55 0 0 1-16.2 0A2 2 0 0 1 2.5 17"/><path d="m10 15 5-3-5-3z"/></svg>';

/* The n8n-style flow nodes — ids match the SSE step ids from /run. */
const NODES = [
  { id: 'health',    label: 'Check Ollama' },
  { id: 'models',    label: 'Load Models' },
  { id: 'extract',   label: 'Clean Transcript' },
  { id: 'chunk',     label: 'Chunk Transcript' },
  { id: 'summarize', label: 'Summarize Chunks' },
  { id: 'map',       label: 'Extract Steps' },
  { id: 'final',     label: 'Generate Prompt' },
  { id: 'save',      label: 'Save Output' },
  { id: 'export',    label: 'Export' },
];

/* The 8 manual step buttons. `node` links a button to a flow node for status. */
const MANUAL_BTNS = [
  { id: 'check',     label: 'Check Ollama',      node: 'health' },
  { id: 'models',    label: 'Load Models',       node: 'models' },
  { id: 'clean',     label: 'Clean Transcript',  node: 'extract' },
  { id: 'chunk',     label: 'Chunk Transcript',  node: 'chunk' },
  { id: 'summarize', label: 'Summarize Chunks',  node: 'summarize' },
  { id: 'generate',  label: 'Generate Workflow Prompt', node: 'final' },
  { id: 'retry',     label: 'Retry With Smaller Chunks', node: 'summarize' },
  { id: 'export',    label: 'Export Prompt',     node: 'export' },
];

const TABS = [
  { id: 'transcript', label: 'Transcript' },
  { id: 'comments',   label: 'Comments' },
  { id: 'frames',     label: 'Frames' },
  { id: 'summaries',  label: 'Summaries' },
  { id: 'map',        label: 'Workflow Map' },
  { id: 'final',      label: 'Final Output' },
];

let _modal = null;
let _mounted = false;
let _open = false;
let _busy = false;

/* ------------------------------------------------------------------ */
/* State                                                               */
/* ------------------------------------------------------------------ */

const state = {
  url: '',
  model: 'deepseek-r1:8b',
  models: [],
  health: null,
  source: null,     // CleanSource.to_dict()
  extras: null,     // { thumbnail, comments, segments, transcript_error, ... }
  chunks: [],
  summaries: [],
  merged: '',
  workflowMap: '',
  finalOutput: '',
  emergency: false,
  diag: null,
  activeTab: 'transcript',
};

/* ------------------------------------------------------------------ */
/* Small helpers                                                       */
/* ------------------------------------------------------------------ */

const $ = (sel) => _modal && _modal.querySelector(sel);
function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
function fmtDuration(sec) {
  if (!sec && sec !== 0) return '';
  sec = Math.round(sec);
  const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = sec % 60;
  return (h ? `${h}:${String(m).padStart(2, '0')}` : `${m}`) + `:${String(s).padStart(2, '0')}`;
}

function log(msg, level = 'info') {
  const box = $('#ytw-log');
  if (!box) return;
  const line = document.createElement('div');
  line.className = `ytw-log-line ytw-log-${level}`;
  const t = new Date().toLocaleTimeString();
  line.textContent = `[${t}] ${msg}`;
  box.appendChild(line);
  box.scrollTop = box.scrollHeight;
}

function toast(msg, level = 'info') {
  log(msg, level);
  try { window.showToast?.(msg, level); } catch (_) {}
}

/** Update a flow node's status: idle | running | done | error | skipped. */
function setNode(id, status, pct) {
  const node = $(`#ytw-node-${id}`);
  if (!node) return;
  node.dataset.status = status;
  const bar = node.querySelector('.ytw-node-bar > span');
  if (bar && typeof pct === 'number') bar.style.width = `${Math.max(0, Math.min(100, pct))}%`;
  if (bar && status === 'done') bar.style.width = '100%';
  if (bar && (status === 'idle' || status === 'error' || status === 'skipped') && pct == null) {
    bar.style.width = status === 'error' ? '100%' : '0%';
  }
}

/** Update a manual button's status pill + progress bar; also mirrors its node. */
function setBtn(id, status, pct) {
  const wrap = $(`#ytw-btn-${id}`);
  if (!wrap) return;
  wrap.dataset.status = status;
  const bar = wrap.querySelector('.ytw-btn-bar > span');
  if (bar) {
    if (typeof pct === 'number') bar.style.width = `${Math.max(0, Math.min(100, pct))}%`;
    else if (status === 'done') bar.style.width = '100%';
    else if (status === 'running') bar.style.width = bar.style.width || '8%';
    else if (status === 'idle') bar.style.width = '0%';
  }
  const pill = wrap.querySelector('.ytw-btn-status');
  if (pill) pill.textContent = { idle: '', running: '…', done: '✓', error: '✗', skipped: '–' }[status] || '';
  const cfg = MANUAL_BTNS.find((b) => b.id === id);
  if (cfg && cfg.node) setNode(cfg.node, status, pct);
}

function setAllIdle() {
  NODES.forEach((n) => setNode(n.id, 'idle'));
  MANUAL_BTNS.forEach((b) => setBtn(b.id, 'idle'));
}

function lockButtons(lock) {
  _busy = lock;
  _modal.querySelectorAll('.ytw-btn, #ytw-run-all, #ytw-fetch').forEach((b) => { b.disabled = lock; });
}

/* ------------------------------------------------------------------ */
/* SSE + fetch                                                         */
/* ------------------------------------------------------------------ */

async function getJSON(path) {
  const r = await fetch(API + path, { credentials: 'same-origin' });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return r.json();
}
async function postJSON(path, body) {
  const r = await fetch(API + path, {
    method: 'POST', credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return r.json();
}
async function streamSSE(path, body, onEvent) {
  const res = await fetch(API + path, {
    method: 'POST', credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
  if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`);
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let idx;
    while ((idx = buf.indexOf('\n\n')) >= 0) {
      const frame = buf.slice(0, idx); buf = buf.slice(idx + 2);
      const line = frame.split('\n').find((l) => l.startsWith('data: '));
      if (!line) continue;
      const data = line.slice(6);
      if (data === '[DONE]') return;
      let ev; try { ev = JSON.parse(data); } catch (_) { continue; }
      onEvent(ev);
    }
  }
}

/* ------------------------------------------------------------------ */
/* Rendering: video card, chapters, tags, history, tabs               */
/* ------------------------------------------------------------------ */

function renderVideoCard() {
  const card = $('#ytw-video-card');
  if (!card) return;
  const m = (state.source && state.source.meta) || {};
  const ex = state.extras || {};
  if (!m.title && !ex.thumbnail && !state.url) {
    card.innerHTML = `<div class="ytw-muted ytw-card-empty">Paste a YouTube URL and click <b>Fetch</b>, or paste a transcript below and use the step buttons.</div>`;
    return;
  }
  const thumb = ex.thumbnail
    ? `<img class="ytw-thumb" src="${esc(ex.thumbnail)}" alt="thumbnail" referrerpolicy="no-referrer">`
    : '';
  const meta = [];
  if (m.channel) meta.push(esc(m.channel));
  if (m.duration) meta.push(fmtDuration(m.duration));
  card.innerHTML = `
    ${thumb}
    <div class="ytw-video-title">${esc(m.title || 'Untitled video')}</div>
    ${meta.length ? `<div class="ytw-video-meta">${meta.join(' · ')}</div>` : ''}
    ${m.url ? `<a class="ytw-video-link" href="${esc(m.url)}" target="_blank" rel="noreferrer">Open on YouTube ↗</a>` : ''}
    <div class="ytw-video-stats">
      <span>${(state.source?.char_count || 0).toLocaleString()} chars</span>
      <span>~${(state.source?.token_estimate || 0).toLocaleString()} tokens</span>
      ${ex.transcript_error ? `<span class="ytw-warn" title="${esc(ex.transcript_error)}">no transcript</span>` : ''}
    </div>`;
}

function renderChapters() {
  const box = $('#ytw-chapters');
  if (!box) return;
  const ch = (state.source && state.source.meta && state.source.meta.chapters) || [];
  if (!ch.length) { box.innerHTML = ''; return; }
  box.innerHTML = `<div class="ytw-side-h">Chapters</div>` +
    ch.slice(0, 40).map((c) => `<div class="ytw-chapter">${esc(c)}</div>`).join('');
}

function renderTags() {
  const box = $('#ytw-tags');
  if (!box) return;
  const tags = (state.source && state.source.meta && state.source.meta.tags) || [];
  if (!tags.length) { box.innerHTML = ''; return; }
  box.innerHTML = `<div class="ytw-side-h">Tags</div><div class="ytw-tag-row">` +
    tags.slice(0, 20).map((t) => `<span class="ytw-tag">${esc(t)}</span>`).join('') + `</div>`;
}

async function loadHistory() {
  const box = $('#ytw-history');
  if (!box) return;
  try {
    const { items } = await getJSON('/history');
    if (!items || !items.length) { box.innerHTML = `<div class="ytw-side-h">History</div><div class="ytw-muted">No saved prompts yet.</div>`; return; }
    box.innerHTML = `<div class="ytw-side-h">History</div>` + items.map((it) => `
      <div class="ytw-hist" data-id="${esc(it.id)}" title="${esc(it.preview || '')}">
        <div class="ytw-hist-title">${esc(it.title || it.video_id || 'Untitled')}${it.emergency ? ' <span class="ytw-warn">⚠</span>' : ''}</div>
        <div class="ytw-hist-meta">${esc((it.created_at || '').slice(0, 10))} · ${esc(it.model_used || '')}</div>
      </div>`).join('');
    box.querySelectorAll('.ytw-hist').forEach((row) => {
      row.addEventListener('click', () => loadHistoryItem(row.dataset.id));
    });
  } catch (e) {
    box.innerHTML = `<div class="ytw-side-h">History</div><div class="ytw-muted">Could not load history.</div>`;
  }
}

async function loadHistoryItem(id) {
  try {
    const it = await getJSON(`/prompt/${encodeURIComponent(id)}`);
    state.finalOutput = it.final_output || '';
    state.emergency = !!it.emergency;
    state.activeTab = 'final';
    renderTabs();
    setActiveTab('final');
    toast(`Loaded saved prompt: ${it.title || id}`);
  } catch (e) { toast('Could not load saved prompt.', 'error'); }
}

function tabContent(id) {
  const ex = state.extras || {};
  if (id === 'transcript') {
    const t = state.source?.sections?.Transcript || state.source?.sections?.Description || '';
    return t ? `<pre class="ytw-pre">${esc(t)}</pre>` : `<div class="ytw-muted">No transcript yet. Fetch a URL or paste one, then Clean Transcript.</div>`;
  }
  if (id === 'comments') {
    const cs = ex.comments || [];
    if (!cs.length) return `<div class="ytw-muted">No comments fetched.</div>`;
    return cs.map((c) => `<div class="ytw-comment"><b>@${esc(c.author || 'user')}</b> ${c.likes ? `<span class="ytw-muted">▲${esc(c.likes)}</span>` : ''}<div>${esc(c.text || '')}</div></div>`).join('');
  }
  if (id === 'frames') {
    const f = state.source?.sections?.['Frame descriptions'] || '';
    return f ? `<pre class="ytw-pre">${esc(f)}</pre>` : `<div class="ytw-muted">No frame descriptions. Add them in the Notes/Frames box.</div>`;
  }
  if (id === 'summaries') {
    if (!state.summaries.length) return `<div class="ytw-muted">No summaries yet. Run Summarize Chunks.</div>`;
    return state.summaries.map((s, i) => `<div class="ytw-summary"><div class="ytw-side-h">Excerpt ${i + 1}</div><pre class="ytw-pre">${esc(s)}</pre></div>`).join('');
  }
  if (id === 'map') {
    return state.workflowMap ? `<pre class="ytw-pre">${esc(state.workflowMap)}</pre>` : `<div class="ytw-muted">No workflow map yet. Run Generate.</div>`;
  }
  if (id === 'final') {
    if (!state.finalOutput) return `<div class="ytw-muted">No final prompt yet. Run Generate Workflow Prompt or the full builder.</div>`;
    const banner = state.emergency
      ? `<div class="ytw-emergency">⚠ Emergency template — built from the transcript without the model. Free RAM or pick a smaller model for a richer result.</div>` : '';
    return `${banner}<div class="ytw-final-actions"><button class="ytw-mini" id="ytw-copy-final">Copy</button><button class="ytw-mini" id="ytw-export-final">Export .md</button></div><pre class="ytw-pre ytw-final">${esc(state.finalOutput)}</pre>`;
  }
  return '';
}

function renderTabs() {
  const body = $('#ytw-tab-body');
  if (!body) return;
  body.innerHTML = tabContent(state.activeTab);
  // counts
  TABS.forEach((t) => {
    const btn = $(`#ytw-tab-${t.id}`);
    if (!btn) return;
    let n = 0;
    if (t.id === 'comments') n = (state.extras?.comments || []).length;
    if (t.id === 'summaries') n = state.summaries.length;
    const badge = btn.querySelector('.ytw-tab-badge');
    if (badge) badge.textContent = n ? String(n) : '';
  });
  // wire final-tab actions
  $('#ytw-copy-final')?.addEventListener('click', () => {
    navigator.clipboard?.writeText(state.finalOutput).then(() => toast('Copied final prompt.'));
  });
  $('#ytw-export-final')?.addEventListener('click', exportPrompt);
}

function setActiveTab(id) {
  state.activeTab = id;
  TABS.forEach((t) => $(`#ytw-tab-${t.id}`)?.classList.toggle('active', t.id === id));
  renderTabs();
}

/* ------------------------------------------------------------------ */
/* Actions                                                             */
/* ------------------------------------------------------------------ */

function currentModel() {
  const sel = $('#ytw-model');
  return (sel && sel.value) || state.model || 'deepseek-r1:8b';
}
function numCtx() {
  const v = parseInt($('#ytw-ctx')?.value, 10);
  return Number.isFinite(v) ? v : 8192;
}
function chunkChars() {
  const v = parseInt($('#ytw-chunk-size')?.value, 10);
  return Number.isFinite(v) ? v : 7000;
}

function applyHealth(h) {
  state.health = h;
  state.models = h.models || [];
  const sel = $('#ytw-model');
  if (sel) {
    const want = sel.value || h.resolved_model || h.selected_model || 'deepseek-r1:8b';
    sel.innerHTML = (state.models.length ? state.models : [want]).map((m) =>
      `<option value="${esc(m)}"${m === want ? ' selected' : ''}>${esc(m)}</option>`).join('');
  }
  const status = $('#ytw-health');
  if (status) {
    if (!h.reachable) status.innerHTML = `<span class="ytw-dot err"></span> Ollama unreachable at ${esc(h.base || '')}`;
    else if (!h.running) status.innerHTML = `<span class="ytw-dot err"></span> ${esc(h.error || 'Ollama not running')}`;
    else status.innerHTML = `<span class="ytw-dot ok"></span> Ollama running · ${state.models.length} model(s)`;
  }
  const warn = $('#ytw-fit-warning');
  if (warn) {
    warn.style.display = h.fit_warning ? 'block' : 'none';
    warn.textContent = h.fit_warning || '';
  }
}

async function checkOllama() {
  setBtn('check', 'running', 30);
  try {
    const h = await getJSON(`/health?model=${encodeURIComponent(currentModel())}`);
    applyHealth(h);
    if (!h.running) { setBtn('check', 'error'); toast(h.error || 'Ollama not running', 'error'); return false; }
    if (h.fit_warning) toast(h.fit_warning, 'warn');
    setBtn('check', 'done');
    setBtn('models', 'done');
    log(`Ollama OK at ${h.base} — models: ${(h.models || []).join(', ') || 'none'}`);
    return true;
  } catch (e) { setBtn('check', 'error'); toast('Health check failed: ' + e.message, 'error'); return false; }
}

async function loadModels() {
  setBtn('models', 'running', 40);
  try {
    const h = await getJSON(`/health?model=${encodeURIComponent(currentModel())}`);
    applyHealth(h);
    setBtn('models', h.models?.length ? 'done' : 'error');
    log(`Loaded ${h.models?.length || 0} model(s).`);
  } catch (e) { setBtn('models', 'error'); toast('Load models failed: ' + e.message, 'error'); }
}

function extractBody() {
  return {
    url: state.url || $('#ytw-url')?.value?.trim() || '',
    transcript: $('#ytw-transcript-in')?.value?.trim() || '',
    title: $('#ytw-title-in')?.value?.trim() || '',
    notes: $('#ytw-notes-in')?.value?.trim() || '',
    frames: ($('#ytw-frames-in')?.value?.trim() || '').split('\n').map((s) => s.trim()).filter(Boolean),
    include_comments: $('#ytw-incl-comments')?.checked ?? true,
    include_metadata: true,
  };
}

async function cleanTranscript() {
  setBtn('clean', 'running', 25);
  try {
    const data = await postJSON('/extract', extractBody());
    state.source = { meta: data.meta, sections: data.sections, signals: data.signals,
                     source_text: data.source_text, char_count: data.char_count, token_estimate: data.token_estimate };
    state.extras = data.extras || {};
    renderVideoCard(); renderChapters(); renderTags();
    setActiveTab('transcript');
    setBtn('clean', data.source_text ? 'done' : 'error');
    if (data.extras?.transcript_error) toast('Transcript: ' + data.extras.transcript_error, 'warn');
    log(`Clean source: ${data.char_count} chars (~${data.token_estimate} tokens). Tools: ${(data.signals?.tools || []).join(', ') || '—'}`);
    return !!data.source_text;
  } catch (e) { setBtn('clean', 'error'); toast('Clean transcript failed: ' + e.message, 'error'); return false; }
}

async function chunkTranscript() {
  if (!state.source?.source_text) { const ok = await cleanTranscript(); if (!ok) return false; }
  setBtn('chunk', 'running', 50);
  try {
    const data = await postJSON('/chunk', { text: state.source.source_text, max_chars: chunkChars() });
    state.chunks = data.chunks || [];
    setBtn('chunk', 'done');
    log(`Chunked into ${data.count} piece(s) (max ${data.max_chars} chars). Sizes: ${(data.sizes || []).join(', ')}`);
    return true;
  } catch (e) { setBtn('chunk', 'error'); toast('Chunk failed: ' + e.message, 'error'); return false; }
}

async function summarizeChunks() {
  if (!state.chunks.length) { const ok = await chunkTranscript(); if (!ok) return false; }
  setBtn('summarize', 'running', 5);
  state.summaries = [];
  try {
    await streamSSE('/summarize', { chunks: state.chunks, model: currentModel(), num_ctx: numCtx() }, (ev) => {
      if (ev.type === 'step' && ev.id === 'summarize') {
        if (typeof ev.progress === 'number') setBtn('summarize', 'running', ev.progress);
        if (ev.detail?.chunk) log(`Summarizing chunk ${ev.detail.chunk}/${ev.detail.total}…`);
      } else if (ev.type === 'log') { log(ev.message, ev.level || 'info'); }
      else if (ev.type === 'error') { toast(ev.message, 'error'); }
      else if (ev.type === 'result') {
        state.summaries = ev.summaries || [];
        state.merged = ev.merged || '';
        state.diag = ev.diag || null;
      }
    });
    setBtn('summarize', state.summaries.length ? 'done' : 'error');
    renderTabs();
    log(`Summarized ${state.summaries.length} chunk(s).`);
    return state.summaries.length > 0;
  } catch (e) { setBtn('summarize', 'error'); toast('Summarize failed: ' + e.message, 'error'); return false; }
}

async function generatePrompt() {
  if (!state.merged && !state.summaries.length) { const ok = await summarizeChunks(); if (!ok && !state.summaries.length) { /* still try */ } }
  setBtn('generate', 'running', 10);
  setNode('map', 'running');
  try {
    await streamSSE('/generate', {
      merged: state.merged, summaries: state.summaries, source: extractBodyForSource(),
      model: currentModel(), num_ctx: numCtx(),
    }, (ev) => {
      if (ev.type === 'step') {
        if (ev.id === 'map') setNode('map', ev.status);
        if (ev.id === 'final') setNode('final', ev.status);
        if (ev.status === 'running') setBtn('generate', 'running', ev.id === 'final' ? 70 : 40);
      } else if (ev.type === 'log') { log(ev.message, ev.level || 'info'); }
      else if (ev.type === 'result') {
        state.workflowMap = ev.workflow_map || '';
        state.finalOutput = ev.final_output || '';
        state.emergency = !!ev.emergency;
        state.diag = ev.diag || null;
        if (ev.message) log(ev.message, ev.emergency ? 'warn' : 'info');
      }
    });
    setBtn('generate', state.finalOutput ? 'done' : 'error');
    setActiveTab('final');
    log(state.emergency ? 'Generated (emergency template).' : 'Generated final workflow prompt.');
    return true;
  } catch (e) { setBtn('generate', 'error'); toast('Generate failed: ' + e.message, 'error'); return false; }
}

function extractBodyForSource() {
  // The source payload the backend needs to rebuild CleanSource (for meta +
  // emergency fallback) during /generate.
  if (state.source) {
    return {
      url: state.source.meta?.url, video_id: state.source.meta?.video_id,
      title: state.source.meta?.title, channel: state.source.meta?.channel,
      description: state.source.sections?.Description,
      chapters: state.source.meta?.chapters, tags: state.source.meta?.tags,
      transcript: state.source.sections?.Transcript,
      notes: state.source.sections?.['Video notes'],
    };
  }
  return extractBody();
}

async function retrySmaller() {
  setBtn('retry', 'running', 10);
  const sizeInput = $('#ytw-chunk-size');
  const cur = chunkChars();
  const smaller = Math.max(3500, Math.round(cur * 0.6));
  if (sizeInput) sizeInput.value = String(smaller);
  log(`Retrying with smaller chunks: ${cur} → ${smaller} chars.`);
  try {
    state.chunks = []; state.summaries = []; state.merged = '';
    const ok = await chunkTranscript();
    if (!ok) { setBtn('retry', 'error'); return; }
    await summarizeChunks();
    await generatePrompt();
    setBtn('retry', state.finalOutput ? 'done' : 'error');
  } catch (e) { setBtn('retry', 'error'); toast('Retry failed: ' + e.message, 'error'); }
}

function exportPrompt() {
  if (!state.finalOutput) { toast('Nothing to export yet.', 'warn'); return; }
  setBtn('export', 'running', 50);
  const title = (state.source?.meta?.title || 'workflow-remake-prompt')
    .toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'workflow-remake-prompt';
  const blob = new Blob([state.finalOutput], { type: 'text/markdown' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `${title}.md`;
  document.body.appendChild(a); a.click();
  setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 0);
  setNode('export', 'done'); setBtn('export', 'done');
  log(`Exported ${title}.md`);
}

/* The single automated n8n-style flow. */
async function runFull() {
  if (_busy) return;
  state.url = $('#ytw-url')?.value?.trim() || '';
  lockButtons(true);
  setAllIdle();
  $('#ytw-run-all').disabled = true;
  log('▶ Running full video workflow prompt builder…');
  try {
    const body = {
      ...extractBody(),
      model: currentModel(), num_ctx: numCtx(), max_chunk_chars: chunkChars(), save: true,
    };
    await streamSSE('/run', body, (ev) => {
      if (ev.type === 'step') {
        setNode(ev.id, ev.status, ev.progress);
        const b = MANUAL_BTNS.find((x) => x.node === ev.id);
        if (b) setBtn(b.id, ev.status, ev.progress);
        if (ev.status === 'error' && ev.detail?.error) log(`${ev.id}: ${ev.detail.error}`, 'warn');
      } else if (ev.type === 'output' && ev.key === 'source') {
        const v = ev.value || {};
        state.source = v;
        state.extras = ev.extras || {};
        renderVideoCard(); renderChapters(); renderTags(); renderTabs();
      } else if (ev.type === 'log') {
        log(ev.message, ev.level || 'info');
      } else if (ev.type === 'done') {
        state.finalOutput = ev.final_output || '';
        state.summaries = ev.summaries || state.summaries;
        state.emergency = !!ev.emergency;
        state.diag = ev.diag || null;
        setNode('export', 'idle');
        if (ev.message) log(ev.message, ev.emergency ? 'warn' : 'info');
        setActiveTab('final');
        loadHistory();
        toast(ev.emergency ? 'Done (emergency template). See Final Output.' : 'Done! Final prompt ready.', ev.emergency ? 'warn' : 'info');
      } else if (ev.type === 'error') {
        toast(ev.message, 'error');
      }
    });
  } catch (e) {
    toast('Run failed: ' + e.message, 'error');
  } finally {
    lockButtons(false);
    $('#ytw-run-all').disabled = false;
  }
}

async function fetchVideo() {
  state.url = $('#ytw-url')?.value?.trim() || '';
  if (!state.url) { toast('Paste a YouTube URL first.', 'warn'); return; }
  $('#ytw-fetch').disabled = true;
  try { await cleanTranscript(); } finally { $('#ytw-fetch').disabled = false; }
}

const ACTIONS = {
  check: checkOllama, models: loadModels, clean: cleanTranscript, chunk: chunkTranscript,
  summarize: summarizeChunks, generate: generatePrompt, retry: retrySmaller, export: exportPrompt,
};

async function runManual(id) {
  if (_busy && id !== 'export') return;
  if (id !== 'export' && id !== 'check' && id !== 'models') lockButtons(true);
  try { await ACTIONS[id]?.(); } finally { if (_busy) lockButtons(false); }
}

/* ------------------------------------------------------------------ */
/* DOM build                                                           */
/* ------------------------------------------------------------------ */

function buildBody() {
  const nodesHTML = NODES.map((n, i) => `
    <div class="ytw-node" id="ytw-node-${n.id}" data-status="idle">
      <div class="ytw-node-dot"></div>
      <div class="ytw-node-label">${esc(n.label)}</div>
      <div class="ytw-node-bar"><span></span></div>
    </div>${i < NODES.length - 1 ? '<div class="ytw-node-arrow">→</div>' : ''}`).join('');

  const btnsHTML = MANUAL_BTNS.map((b) => `
    <div class="ytw-btn-wrap" id="ytw-btn-${b.id}" data-status="idle">
      <button class="ytw-btn" data-action="${b.id}">${esc(b.label)} <span class="ytw-btn-status"></span></button>
      <div class="ytw-btn-bar"><span></span></div>
    </div>`).join('');

  const tabsHTML = TABS.map((t) => `
    <button class="ytw-tab" id="ytw-tab-${t.id}" data-tab="${t.id}">${esc(t.label)} <span class="ytw-tab-badge"></span></button>`).join('');

  return `
  <div class="youtube-analysis-page ytw-page">
    <aside class="video-sidebar ytw-sidebar">
      <div class="ytw-card" id="ytw-video-card"></div>
      <div class="ytw-side-section" id="ytw-chapters"></div>
      <div class="ytw-side-section" id="ytw-tags"></div>
      <div class="ytw-side-section" id="ytw-history"></div>
    </aside>

    <main class="analysis-main ytw-main">
      <div class="ytw-toolbar">
        <input type="text" id="ytw-url" class="ytw-input" placeholder="https://www.youtube.com/watch?v=…">
        <button id="ytw-fetch" class="ytw-secondary">Fetch</button>
        <select id="ytw-model" class="ytw-input ytw-model" title="Ollama model"></select>
        <label class="ytw-ctx-lbl">ctx <input type="number" id="ytw-ctx" class="ytw-num" value="8192" min="2048" max="131072" step="1024"></label>
        <label class="ytw-ctx-lbl">chunk <input type="number" id="ytw-chunk-size" class="ytw-num" value="7000" min="3500" max="16000" step="500"></label>
        <button id="ytw-run-all" class="ytw-primary">▶ Run Full Video Workflow Prompt Builder</button>
      </div>

      <div class="ytw-health-row">
        <span id="ytw-health"><span class="ytw-dot"></span> Not checked</span>
        <label class="ytw-check"><input type="checkbox" id="ytw-incl-comments" checked> include comments</label>
      </div>
      <div class="ytw-fit-warning" id="ytw-fit-warning" style="display:none"></div>

      <div class="ytw-flow" id="ytw-flow">${nodesHTML}</div>

      <div class="ytw-inputs">
        <input type="text" id="ytw-title-in" class="ytw-input" placeholder="Title (optional — auto-filled from URL)">
        <div class="ytw-input-grid">
          <textarea id="ytw-transcript-in" class="ytw-textarea" placeholder="Or paste a transcript / summary here…"></textarea>
          <textarea id="ytw-notes-in" class="ytw-textarea" placeholder="Video notes (optional)…"></textarea>
          <textarea id="ytw-frames-in" class="ytw-textarea" placeholder="Frame descriptions, one per line (optional)…"></textarea>
        </div>
      </div>

      <div class="ytw-buttons">${btnsHTML}</div>

      <div class="results-panel ytw-results">
        <div class="ytw-tabs">${tabsHTML}</div>
        <div class="ytw-tab-body" id="ytw-tab-body"></div>
      </div>

      <div class="ytw-log-wrap">
        <div class="ytw-side-h">Logs <button class="ytw-mini" id="ytw-clear-log">clear</button></div>
        <div class="ytw-log" id="ytw-log"></div>
      </div>
    </main>
  </div>`;
}

function wire() {
  $('#ytw-run-all')?.addEventListener('click', runFull);
  $('#ytw-fetch')?.addEventListener('click', fetchVideo);
  $('#ytw-url')?.addEventListener('keydown', (e) => { if (e.key === 'Enter') fetchVideo(); });
  $('#ytw-model')?.addEventListener('change', (e) => { state.model = e.target.value; });
  $('#ytw-clear-log')?.addEventListener('click', () => { const b = $('#ytw-log'); if (b) b.innerHTML = ''; });
  _modal.querySelectorAll('.ytw-btn').forEach((b) =>
    b.addEventListener('click', () => runManual(b.dataset.action)));
  _modal.querySelectorAll('.ytw-tab').forEach((b) =>
    b.addEventListener('click', () => setActiveTab(b.dataset.tab)));
}

/* ------------------------------------------------------------------ */
/* Modal shell                                                         */
/* ------------------------------------------------------------------ */

function getModal() {
  if (_modal) return _modal;
  _modal = document.createElement('div');
  _modal.id = MODAL_ID;
  _modal.className = 'modal ytw-modal';
  _modal.style.display = 'none';
  _modal.innerHTML = `
    <div class="modal-content ytw-modal-content">
      <div class="modal-header">
        <h4>${HEADER_ICON}YouTube Workflow Builder</h4>
        <button class="close-btn" id="ytw-close" aria-label="Close YouTube Workflow Builder">✖</button>
      </div>
      <div class="modal-body ytw-modal-body" id="ytw-modal-body"></div>
    </div>`;
  document.body.appendChild(_modal);
  _modal.querySelector('#ytw-close').addEventListener('click', closeYoutubeWorkflow);
  const content = _modal.querySelector('.modal-content');
  const header = _modal.querySelector('.modal-header');
  if (content && header) makeWindowDraggable(_modal, { content, header });
  return _modal;
}

function mountApp() {
  if (_mounted) return;
  const body = _modal.querySelector('#ytw-modal-body');
  body.innerHTML = buildBody();
  wire();
  renderVideoCard();
  setActiveTab('transcript');
  loadHistory();
  // Auto health check on first open so the model picker + fit warning populate.
  checkOllama().catch(() => {});
  _mounted = true;
}

/* ------------------------------------------------------------------ */
/* Open / close                                                        */
/* ------------------------------------------------------------------ */

export function openYoutubeWorkflow() {
  if (_open) return;
  if (Modals.isMinimized(MODAL_ID)) { Modals.restore(MODAL_ID); _open = true; return; }

  const modal = getModal();
  modal.classList.remove('hidden', 'modal-minimized');
  const content = modal.querySelector('.modal-content');
  if (content) { content.style.transform = ''; content.style.transition = ''; content.style.opacity = ''; }
  modal.style.display = 'flex';
  _open = true;

  mountApp();

  Modals.register(MODAL_ID, {
    sidebarBtnId: 'tool-ytworkflow-btn',
    label: 'YT Workflow',
    icon: HEADER_ICON,
    closeFn: () => doClose(),
    restoreFn: () => { _open = true; },
  });
}

function doClose() {
  _open = false;
  if (_modal) { _modal.style.display = 'none'; _modal.classList.add('hidden'); }
}

export function closeYoutubeWorkflow() {
  if (!_open && !Modals.isMinimized(MODAL_ID)) return;
  if (Modals.isRegistered(MODAL_ID)) Modals.close(MODAL_ID);
  else doClose();
}

export function isYoutubeWorkflowOpen() {
  if (Modals.isMinimized(MODAL_ID)) return false;
  return _open;
}

const youtubeWorkflowModule = { openYoutubeWorkflow, closeYoutubeWorkflow, isYoutubeWorkflowOpen };
export default youtubeWorkflowModule;
