// Personal Assistant — sidebar entry, settings modal, and chat-header extras.
//
// The Assistant is just a specially-flagged CrewMember whose pinned Session
// lives alongside normal chats. The sidebar button resolves the per-user
// singleton via /api/assistant/session and hands it to selectSession() so we
// reuse the full existing chat render path.

import uiModule from './ui.js';
import { selectSession } from './sessions.js';
import { sortModelIds } from './modelSort.js';

const API = '/api/assistant';

let _cachedSettings = null;   // most recent GET /api/assistant/settings payload
let _modalEl = null;

async function _fetchJSON(url, opts = {}) {
  const res = await fetch(url, { credentials: 'same-origin', ...opts });
  if (!res.ok) throw new Error(`${url} → ${res.status}`);
  return res.json();
}

export async function openAssistantChat() {
  try {
    const info = await _fetchJSON(`${API}/session`);
    if (!info?.session_id) {
      uiModule.showToast('Assistant session unavailable');
      return;
    }
    await selectSession(info.session_id);
    // Refresh settings cache so the header buttons / gear act on fresh data.
    _cachedSettings = null;
  } catch (e) {
    console.error('openAssistantChat failed:', e);
    uiModule.showToast('Could not open assistant');
  }
}

async function _getSettings(force = false) {
  if (!force && _cachedSettings) return _cachedSettings;
  _cachedSettings = await _fetchJSON(`${API}/settings`);
  return _cachedSettings;
}

async function _saveSettings(payload) {
  const res = await fetch(`${API}/settings`, {
    method: 'PATCH',
    credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  if (!res.ok) throw new Error(`PATCH ${API}/settings → ${res.status}`);
  _cachedSettings = await res.json();
  return _cachedSettings;
}

async function _listTimezones() {
  try {
    const { timezones } = await _fetchJSON(`${API}/available-timezones`);
    return timezones || ['UTC'];
  } catch {
    return ['UTC'];
  }
}

async function _runCheckInNow(taskId) {
  try {
    await fetch(`${API}/run/${encodeURIComponent(taskId)}`, {
      method: 'POST',
      credentials: 'same-origin',
    });
    uiModule.showToast('Check-in running…');
  } catch (e) {
    console.error(e);
    uiModule.showToast('Could not run check-in');
  }
}

// ── Settings modal ─────────────────────────────────────────────────────────

function _closeModal() {
  if (_modalEl) {
    _modalEl.classList.add('hidden');
    _modalEl.style.display = '';
  }
}

function _ensureModalEl() {
  if (_modalEl) return _modalEl;
  const modal = document.createElement('div');
  modal.id = 'assistant-settings-modal';
  modal.className = 'modal hidden';
  modal.innerHTML = `
    <div class="modal-content" style="max-width:640px;width:96%;">
      <div class="modal-header">
        <h4>
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="vertical-align:-2px;margin-right:6px;"><circle cx="12" cy="8" r="4"/><path d="M4 21a8 8 0 0 1 16 0"/></svg>
          Assistant settings
        </h4>
        <button class="close-btn" id="assistant-settings-close">✖</button>
      </div>
      <div class="modal-body" id="assistant-settings-body">
        <div class="hwfit-loading">Loading…</div>
      </div>
    </div>`;
  document.body.appendChild(modal);
  modal.querySelector('#assistant-settings-close').addEventListener('click', _closeModal);
  modal.addEventListener('click', (e) => {
    if (e.target === modal) _closeModal();
  });
  _modalEl = modal;
  return modal;
}

function _esc(s) {
  return (s || '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

// Tool groups for the tool selector UI
const TOOL_GROUPS = {
  'Email': ['list_emails', 'read_email', 'send_email', 'reply_to_email', 'archive_email', 'delete_email', 'mark_email_read'],
  'Calendar & Notes': ['manage_calendar', 'manage_notes', 'manage_tasks'],
  'Knowledge': ['web_search', 'read_file', 'manage_memory', 'manage_rag', 'search_chats'],
  'Code': ['bash', 'python', 'write_file'],
  'Documents': ['create_document', 'edit_document', 'update_document', 'suggest_document'],
  'AI & Models': ['chat_with_model', 'second_opinion', 'ask_teacher', 'pipeline', 'list_models', 'generate_image'],
  'System': ['manage_session', 'manage_endpoints', 'manage_mcp', 'manage_settings', 'manage_skills', 'manage_webhooks', 'manage_tokens', 'manage_documents', 'create_session', 'list_sessions', 'send_to_session', 'ui_control'],
};

async function _fetchEndpoints() {
  try {
    const eps = await _fetchJSON('/api/model-endpoints');
    return Array.isArray(eps) ? eps : [];
  } catch { return []; }
}

function _renderSettingsBody(body, data, tzList) {
  const crew = data.crew || {};
  const checkIns = data.check_ins || [];
  const enabledTools = new Set(crew.enabled_tools || []);
  const tzOptions = tzList.map((z) =>
    `<option value="${_esc(z)}"${z === crew.timezone ? ' selected' : ''}>${_esc(z)}</option>`
  ).join('');
  const checkInsHTML = checkIns.map((c) => `
    <div class="assistant-checkin-row" data-task-id="${_esc(c.id)}">
      <div class="assistant-checkin-head">
        <input type="checkbox" class="assistant-checkin-enabled" ${c.enabled ? 'checked' : ''} title="Enable this check-in" />
        <input type="text" class="assistant-checkin-name" value="${_esc(c.name)}" placeholder="Name" />
        <input type="time" class="assistant-checkin-time" value="${_esc(c.scheduled_time || '')}" />
        <button type="button" class="assistant-checkin-run" title="Run now">Run now</button>
      </div>
      <textarea class="assistant-checkin-prompt" rows="3" placeholder="Prompt for this check-in">${_esc(c.prompt || '')}</textarea>
      <div class="assistant-checkin-meta">
        ${c.next_run ? `next run: ${_esc(c.next_run)}` : ''}
        ${c.last_run ? ` · last run: ${_esc(c.last_run)}` : ''}
        ${typeof c.run_count === 'number' ? ` · ${c.run_count} runs` : ''}
      </div>
    </div>`).join('');

  // Tool selector grouped by category
  let toolsHTML = '';
  for (const [group, tools] of Object.entries(TOOL_GROUPS)) {
    toolsHTML += `<div class="assistant-tool-group"><span class="assistant-tool-group-label">${_esc(group)}</span>`;
    for (const t of tools) {
      const checked = enabledTools.has(t) ? ' checked' : '';
      const label = t.replace(/_/g, ' ');
      toolsHTML += `<label class="assistant-tool-item"><input type="checkbox" class="assistant-tool-cb" value="${_esc(t)}"${checked} /><span>${_esc(label)}</span></label>`;
    }
    toolsHTML += '</div>';
  }

  body.innerHTML = `
    <div class="assistant-settings-form">
      <label class="assistant-field">
        <span>Name</span>
        <input type="text" id="assistant-name" value="${_esc(crew.name)}" placeholder="Assistant" />
      </label>
      <div class="assistant-field">
        <span style="display:flex;align-items:center;gap:8px;">Personality
          <select id="assistant-character-pick" style="font-size:11px;padding:1px 6px;border:1px solid var(--border);border-radius:3px;background:var(--bg);color:var(--fg);max-width:180px;">
            <option value="">-- pick from persona --</option>
          </select>
        </span>
        <textarea id="assistant-personality" rows="6" placeholder="Describe the assistant's personality, tone, and behavior...">${_esc(crew.personality || '')}</textarea>
      </div>
      <div class="assistant-field-row">
        <label class="assistant-field">
          <span>Timezone</span>
          <select id="assistant-timezone">
            <option value=""${!crew.timezone ? ' selected' : ''}>(default -- UTC)</option>
            ${tzOptions}
          </select>
        </label>
      </div>
      <div class="assistant-field-row">
        <label class="assistant-field" style="flex:1;">
          <span>Model endpoint</span>
          <select id="assistant-endpoint" style="width:100%;">
            <option value="">(loading...)</option>
          </select>
        </label>
        <label class="assistant-field" style="flex:1;">
          <span>Model</span>
          <select id="assistant-model" style="width:100%;">
            <option value="${_esc(crew.model || '')}">${_esc(crew.model || '(default)')}</option>
          </select>
        </label>
      </div>
      <div class="assistant-field">
        <span style="display:flex;align-items:center;gap:8px;">Tools
          <button type="button" id="assistant-tools-all" class="assistant-tools-toggle" style="font-size:10px;opacity:0.5;cursor:pointer;background:none;border:1px solid var(--border);border-radius:3px;padding:1px 6px;">all</button>
          <button type="button" id="assistant-tools-none" class="assistant-tools-toggle" style="font-size:10px;opacity:0.5;cursor:pointer;background:none;border:1px solid var(--border);border-radius:3px;padding:1px 6px;">none</button>
        </span>
        <div class="assistant-tools-grid" id="assistant-tools-grid">
          ${toolsHTML}
        </div>
      </div>
      <div class="assistant-checkins">
        <h5>Daily check-ins</h5>
        ${checkInsHTML || '<div style="opacity:0.6;">No check-ins configured.</div>'}
      </div>
      <div class="assistant-settings-actions">
        <button type="button" class="cal-btn" id="assistant-settings-cancel">Cancel</button>
        <button type="button" class="cal-btn cal-btn-primary" id="assistant-settings-save">Save</button>
      </div>
    </div>
  `;

  // ── Populate model/endpoint dropdowns ──
  const epSelect = body.querySelector('#assistant-endpoint');
  const modelSelect = body.querySelector('#assistant-model');
  _fetchEndpoints().then(endpoints => {
    let epHTML = '<option value="">(use session default)</option>';
    for (const ep of endpoints) {
      if (!ep.is_enabled) continue;
      const url = ep.base_url || '';
      const name = ep.name || url;
      const sel = (crew.endpoint_url && url.includes(crew.endpoint_url.replace('/v1', '').replace(/\/$/, ''))) ? ' selected' : '';
      epHTML += `<option value="${_esc(url)}"${sel}>${_esc(name)}</option>`;
    }
    epSelect.innerHTML = epHTML;
    // When endpoint changes, load its models
    epSelect.addEventListener('change', async () => {
      const url = epSelect.value;
      if (!url) { modelSelect.innerHTML = '<option value="">(default)</option>'; return; }
      const ep = endpoints.find(e => e.base_url === url);
      if (!ep) return;
      modelSelect.innerHTML = '<option value="">loading...</option>';
      try {
        const models = await _fetchJSON(`/api/model-endpoints/${ep.id}/models`);
        let mHTML = '';
        const modelIds = (models.models || models || []).map(m => typeof m === 'string' ? m : (m.id || m.name || '')).filter(Boolean);
        for (const mid of sortModelIds(modelIds)) {
          const sel = mid === crew.model ? ' selected' : '';
          mHTML += `<option value="${_esc(mid)}"${sel}>${_esc(mid.split('/').pop())}</option>`;
        }
        modelSelect.innerHTML = mHTML || '<option value="">(no models)</option>';
      } catch { modelSelect.innerHTML = '<option value="">(failed)</option>'; }
    });
    // Trigger initial model load if endpoint is pre-selected
    if (epSelect.value) epSelect.dispatchEvent(new Event('change'));
  });

  // ── Tool toggle buttons ──
  body.querySelector('#assistant-tools-all')?.addEventListener('click', () => {
    body.querySelectorAll('.assistant-tool-cb').forEach(cb => { cb.checked = true; });
  });
  body.querySelector('#assistant-tools-none')?.addEventListener('click', () => {
    body.querySelectorAll('.assistant-tool-cb').forEach(cb => { cb.checked = false; });
  });

  // ── Character picker — populate from presets + templates ──
  const charPick = body.querySelector('#assistant-character-pick');
  const personalityEl = body.querySelector('#assistant-personality');
  if (charPick && personalityEl) {
    (async () => {
      try {
        const [presetsRaw, templates] = await Promise.all([
          _fetchJSON('/api/presets').catch(() => ({})),
          _fetchJSON('/api/presets/templates').catch(() => []),
        ]);
        // Presets API returns a dict keyed by preset ID, not an array
        const allPresets = [];
        if (presetsRaw && typeof presetsRaw === 'object' && !Array.isArray(presetsRaw)) {
          for (const [key, val] of Object.entries(presetsRaw)) {
            if (val && typeof val === 'object' && val.system_prompt) {
              allPresets.push({ ...val, _key: key });
            }
          }
        } else if (Array.isArray(presetsRaw)) {
          allPresets.push(...presetsRaw);
        }
        const allTemplates = Array.isArray(templates) ? templates : [];
        let opts = '<option value="">-- pick from persona --</option>';
        if (allPresets.length) {
          opts += '<optgroup label="Presets">';
          for (const p of allPresets) {
            if (!p.system_prompt) continue;
            const name = p.character_name || p.name || p._key || 'Unnamed';
            opts += `<option value="preset:${_esc(p._key || p.name || '')}">${_esc(name)}</option>`;
          }
          opts += '</optgroup>';
        }
        if (allTemplates.length) {
          opts += '<optgroup label="Personas">';
          for (const t of allTemplates) {
            if (!t.system_prompt && !t.personality) continue;
            const name = t.character_name || t.name || 'Unnamed';
            opts += `<option value="template:${_esc(t.id || t.name || '')}">${_esc(name)}</option>`;
          }
          opts += '</optgroup>';
        }
        charPick.innerHTML = opts;
        charPick._presets = allPresets;
        charPick._templates = allTemplates;
      } catch {}
    })();
    charPick.addEventListener('change', () => {
      const val = charPick.value;
      if (!val) return;
      const [type, id] = val.split(':', 2);
      let prompt = '';
      let name = '';
      if (type === 'preset') {
        const p = (charPick._presets || []).find(x => (x._key || x.name || x.id) === id);
        if (p) { prompt = p.system_prompt || p.personality || ''; name = p.character_name || p.name || p._key || ''; }
      } else if (type === 'template') {
        const t = (charPick._templates || []).find(x => (x.id || x.name) === id);
        if (t) { prompt = t.system_prompt || t.personality || ''; name = t.character_name || t.name || ''; }
      }
      if (prompt) personalityEl.value = prompt;
      const nameEl = body.querySelector('#assistant-name');
      if (name && nameEl) nameEl.value = name;
      charPick.selectedIndex = 0;
    });
  }

  // ── Event wiring ──
  body.querySelector('#assistant-settings-cancel').addEventListener('click', _closeModal);
  body.querySelector('#assistant-settings-save').addEventListener('click', async () => {
    const selectedTools = [];
    body.querySelectorAll('.assistant-tool-cb:checked').forEach(cb => selectedTools.push(cb.value));
    const payload = {
      name: body.querySelector('#assistant-name').value.trim(),
      personality: body.querySelector('#assistant-personality').value,
      timezone: body.querySelector('#assistant-timezone').value || null,
      model: body.querySelector('#assistant-model').value || null,
      endpoint_url: body.querySelector('#assistant-endpoint').value || null,
      enabled_tools: selectedTools,
      check_ins: Array.from(body.querySelectorAll('.assistant-checkin-row')).map((row) => ({
        id: row.dataset.taskId,
        name: row.querySelector('.assistant-checkin-name').value.trim(),
        scheduled_time: row.querySelector('.assistant-checkin-time').value,
        prompt: row.querySelector('.assistant-checkin-prompt').value,
        enabled: row.querySelector('.assistant-checkin-enabled').checked,
      })),
    };
    try {
      await _saveSettings(payload);
      uiModule.showToast('Assistant settings saved');
      _closeModal();
    } catch (e) {
      console.error(e);
      uiModule.showToast('Save failed');
    }
  });
  body.querySelectorAll('.assistant-checkin-run').forEach((btn) => {
    btn.addEventListener('click', async (e) => {
      e.stopPropagation();
      const row = btn.closest('.assistant-checkin-row');
      if (!row?.dataset.taskId) return;
      const taskId = row.dataset.taskId;
      btn.disabled = true;
      btn.textContent = 'Running...';
      await _runCheckInNow(taskId);
      _closeModal();
      // Poll until done, then navigate to assistant chat
      const sid = _cachedSettings?.crew?.session_id;
      const _poll = setInterval(async () => {
        try {
          const res = await fetch(`${API}/run-status/${encodeURIComponent(taskId)}`, { credentials: 'same-origin' });
          if (!res.ok) return;
          const data = await res.json();
          if (data.status === 'done' || data.status === 'error') {
            clearInterval(_poll);
            // Hard navigate to force full reload of the session
            if (sid) {
              window.location.href = window.location.pathname + '#' + sid;
              window.location.reload();
            }
          }
        } catch {}
      }, 2000);
      setTimeout(() => clearInterval(_poll), 90000);
    });
  });
}

export async function openAssistantSettings() {
  const modal = _ensureModalEl();
  modal.classList.remove('hidden');
  modal.style.display = 'flex';
  const body = modal.querySelector('#assistant-settings-body');
  body.innerHTML = '<div class="hwfit-loading">Loading…</div>';
  try {
    const [data, tzList] = await Promise.all([_getSettings(true), _listTimezones()]);
    _renderSettingsBody(body, data, tzList);
  } catch (e) {
    console.error(e);
    body.innerHTML = '<div style="padding:12px;opacity:0.6;">Could not load assistant settings.</div>';
  }
}

// Sidebar wiring removed — Assistant chat + settings now live as
// Activity / Settings tabs inside the Tasks modal (see tasks.js). The
// exports below are still used by tasks.js to surface those views.

// ── Agent working-directory chip (assistant chat header) ───────────────────

function _wdIcon(name) {
  const p = {
    monitor: '<rect x="2" y="3" width="20" height="14" rx="2"/><path d="M8 21h8M12 17v4"/>',
    folder:  '<path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/>',
    branch:  '<circle cx="6" cy="6" r="2.5"/><circle cx="6" cy="18" r="2.5"/><circle cx="18" cy="8" r="2.5"/><path d="M6 8.5v7M18 10.5c0 3.5-3.5 3-8 4"/>',
    layers:  '<path d="M12 3l9 5-9 5-9-5 9-5z"/><path d="M3 13l9 5 9-5"/>',
    chevron: '<path d="M6 15l6-6 6 6"/>',
    check:   '<path d="M20 6 9 17l-5-5"/>',
    gear:    '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/>',
    plus:    '<path d="M12 5v14M5 12h14"/>',
    ssh:     '<rect x="2" y="4" width="20" height="16" rx="2"/><path d="m6 9 3 3-3 3M13 15h5"/>',
  }[name] || '';
  return `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${p}</svg>`;
}

async function _fetchWorkingDir() {
  try { return await _fetchJSON(`${API}/working-dir`); } catch { return null; }
}

function _renderWdBar(bar, wd) {
  bar._wd = wd;
  const locName = _esc((wd && wd.location) || 'Local');
  const locBtn = `<button type="button" class="agent-wd-loc" title="Choose where the agent runs">${_wdIcon('monitor')}<span>${locName}</span>${_wdIcon('chevron')}</button>`;
  if (!wd) { bar.innerHTML = locBtn; return; }
  const missing = wd.exists ? '' : ' agent-wd-missing';
  const label = wd.is_default ? `${_esc(wd.name)} · default` : _esc(wd.name);
  const chips = [`<span class="agent-wd-chip agent-wd-folder${missing}">${_wdIcon('folder')}<span class="agent-wd-name">${label}</span></span>`];
  if (wd.is_git && wd.git_branch) chips.push(`<span class="agent-wd-chip agent-wd-branch">${_wdIcon('branch')}${_esc(wd.git_branch)}</span>`);
  if (wd.is_worktree) chips.push(`<span class="agent-wd-chip agent-wd-flag">${_wdIcon('layers')}worktree</span>`);
  bar.innerHTML = locBtn + `<button type="button" class="agent-wd-path" title="Change the working directory">${chips.join('')}</button>`;
}

// Location dropdown (the "Local" button) — modelled on an environment picker.
// Local is the real, working environment; SSH/remote are not wired yet.
function _openLocationMenu(bar) {
  document.querySelector('.agent-wd-menu')?.remove();
  const locBtn = bar.querySelector('.agent-wd-loc');
  if (!locBtn) return;
  const menu = document.createElement('div');
  menu.className = 'agent-wd-menu';
  menu.innerHTML = `
    <button type="button" class="agent-wd-menu-item is-active" data-act="local">
      ${_wdIcon('monitor')}<span class="agent-wd-menu-name">Local</span>
      <span class="agent-wd-menu-spacer"></span>
      <span class="agent-wd-menu-check">${_wdIcon('check')}</span>
      <span class="agent-wd-menu-gear" data-act="settings" title="Set working directory">${_wdIcon('gear')}</span>
    </button>
    <div class="agent-wd-menu-sub">Runs on this machine</div>
    <div class="agent-wd-menu-sep"></div>
    <div class="agent-wd-menu-label">SSH</div>
    <button type="button" class="agent-wd-menu-item agent-wd-menu-add" data-act="add-ssh">
      ${_wdIcon('plus')}<span class="agent-wd-menu-name">Add SSH host…</span>
    </button>`;
  document.body.appendChild(menu);
  // Opens upward — the bar sits just above the composer at the bottom.
  const r = locBtn.getBoundingClientRect();
  const mw = menu.offsetWidth, mh = menu.offsetHeight;
  const left = Math.max(8, Math.min(r.left + window.scrollX, window.innerWidth - mw - 8));
  menu.style.left = `${Math.round(left)}px`;
  menu.style.top = `${Math.round(r.top + window.scrollY - mh - 6)}px`;
  const close = () => { document.removeEventListener('mousedown', onDoc, true); menu.remove(); };
  const onDoc = (e) => { if (!menu.contains(e.target) && !locBtn.contains(e.target)) close(); };
  document.addEventListener('mousedown', onDoc, true);
  menu.addEventListener('click', (e) => {
    const act = e.target.closest('[data-act]')?.dataset.act;
    if (act === 'settings') { close(); _openWorkingDirEditor(bar); }
    else if (act === 'add-ssh') { close(); uiModule.showToast('Remote / SSH execution isn’t available yet — the agent runs on this machine.'); }
    else { close(); }
  });
}

function _openWorkingDirEditor(bar) {
  document.querySelector('.agent-wd-editor')?.remove();
  const wd = bar._wd || {};
  const pop = document.createElement('div');
  pop.className = 'agent-wd-editor';
  pop.innerHTML = `
    <div class="agent-wd-editor-title">Agent working directory</div>
    <div class="agent-wd-editor-help">The agent creates files and runs shell commands here. Leave blank to use the default <code>data/</code> workspace. Use an absolute path.</div>
    <input type="text" class="agent-wd-editor-input" spellcheck="false" autocomplete="off"
           placeholder="C:\\path\\to\\project   or   /home/you/project"
           value="${_esc(wd.configured_path || '')}" />
    <div class="agent-wd-editor-status"></div>
    <div class="agent-wd-editor-actions">
      <button type="button" class="cal-btn agent-wd-reset">Reset to default</button>
      <span style="flex:1"></span>
      <button type="button" class="cal-btn agent-wd-cancel">Cancel</button>
      <button type="button" class="cal-btn cal-btn-primary agent-wd-save">Set</button>
    </div>`;
  document.body.appendChild(pop);
  const r = bar.getBoundingClientRect();
  const w = pop.offsetWidth || 460;
  const ph = pop.offsetHeight || 150;
  pop.style.top = `${Math.round(r.top + window.scrollY - ph - 6)}px`;  // open upward
  pop.style.left = `${Math.round(Math.max(8, Math.min(r.left + window.scrollX, window.innerWidth - w - 8)))}px`;

  const input = pop.querySelector('.agent-wd-editor-input');
  const statusEl = pop.querySelector('.agent-wd-editor-status');
  input.focus(); input.select();

  const close = () => { document.removeEventListener('mousedown', onDoc, true); pop.remove(); };
  const onDoc = (e) => { if (!pop.contains(e.target) && !bar.contains(e.target)) close(); };
  document.addEventListener('mousedown', onDoc, true);

  const save = async (path) => {
    statusEl.textContent = 'Saving…';
    try {
      const res = await fetch(`${API}/working-dir`, {
        method: 'POST', credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ path }),
      });
      if (res.status === 403) { statusEl.textContent = 'Admin only — ask an admin to change this.'; return; }
      if (!res.ok) {
        let msg = `Error ${res.status}`;
        try { const j = await res.json(); if (j.detail) msg = j.detail; } catch {}
        statusEl.textContent = msg; return;
      }
      _renderWdBar(bar, await res.json());
      uiModule.showToast('Working directory updated');
      close();
    } catch { statusEl.textContent = 'Save failed'; }
  };

  pop.querySelector('.agent-wd-cancel').addEventListener('click', close);
  pop.querySelector('.agent-wd-save').addEventListener('click', () => save(input.value.trim()));
  pop.querySelector('.agent-wd-reset').addEventListener('click', () => save(''));
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); save(input.value.trim()); }
    else if (e.key === 'Escape') { e.preventDefault(); close(); }
  });
}

async function _mountWorkingDirBar(retries = 0) {
  // Mount the working-directory bar right above the message composer
  // ("Message TrendVault AI …"). It's a sibling directly before
  // .chat-input-bar and shares the composer's width/centering so the chips
  // line up with the input in every layout state.
  if (document.getElementById('agent-wd-bar')) return;
  const inputBar = document.querySelector('.chat-input-bar');
  if (!inputBar || !inputBar.parentNode) {
    if (retries < 30) setTimeout(() => _mountWorkingDirBar(retries + 1), 250);
    return;
  }
  const strip = document.createElement('div');
  strip.className = 'agent-wd-strip';
  const bar = document.createElement('div');
  bar.id = 'agent-wd-bar';
  bar.className = 'agent-wd-bar';
  bar.title = 'Agent working directory — where it creates files and runs commands. Click to change.';
  bar.innerHTML = `<button type="button" class="agent-wd-loc">${_wdIcon('monitor')}<span>Local</span>${_wdIcon('chevron')}</button>`;
  bar.addEventListener('click', (e) => {
    if (e.target.closest('.agent-wd-loc')) _openLocationMenu(bar);
    else if (e.target.closest('.agent-wd-path')) _openWorkingDirEditor(bar);
  });
  strip.appendChild(bar);
  inputBar.insertAdjacentElement('beforebegin', strip);
  _renderWdBar(bar, await _fetchWorkingDir());
}

// ── Chat-header affordances when the assistant session is active ───────────

async function _ensureHeaderAffordances(sessionId) {
  try {
    const settings = await _getSettings();
    if (settings?.crew?.session_id !== sessionId) return;
  } catch {
    return;
  }
  const headerRight = document.querySelector('.chat-header-right, #chat-header .actions, .chat-header');
  if (!headerRight) return;
  if (headerRight.querySelector('#assistant-header-gear')) return;
  const gear = document.createElement('button');
  gear.id = 'assistant-header-gear';
  gear.type = 'button';
  gear.title = 'Assistant settings';
  gear.className = 'chat-header-btn';
  gear.innerHTML = '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg>';
  gear.addEventListener('click', openAssistantSettings);
  headerRight.appendChild(gear);
}

// Run a short polling check after session loads so we can add the gear button
// once the chat header DOM is in place. Fire-and-forget.
function _watchForAssistantActivation() {
  let retries = 0;
  const interval = setInterval(async () => {
    retries += 1;
    const activeSessionId = window.sessionModule?.getActiveSession?.()?.id
      || document.body.dataset.activeSessionId
      || null;
    if (activeSessionId) {
      await _ensureHeaderAffordances(activeSessionId);
    }
    if (retries > 120) clearInterval(interval); // ~2 minutes
  }, 1000);
}

// ── Boot ───────────────────────────────────────────────────────────────────

function _boot() {
  _watchForAssistantActivation();
  _mountWorkingDirBar();
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', _boot);
} else {
  _boot();
}

const assistantModule = {
  openAssistantChat,
  openAssistantSettings,
};

export default assistantModule;
