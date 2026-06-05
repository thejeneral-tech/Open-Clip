/**
 * Automation Map — TrendVault tool entry module.
 *
 * Builds the tool modal, mounts the vanilla canvas app (toolbar + palette +
 * canvas + inspector + panels + command palette), registers with the shared
 * modalManager (open / minimize / restore / close + dock chip), and scopes the
 * app's keyboard shortcuts to when the window is visible.
 *
 * Public API (default export): { openAutomationMap, closeAutomationMap,
 * isAutomationMapOpen }. Wired to #tool-automation-btn from app.js, mirroring
 * the calendar / gallery tool pattern.
 */

import * as Modals from './modalManager.js';
import { makeWindowDraggable } from './windowDrag.js';
import { icon } from './automation/dom.js';
import * as store from './automation/store.js';
import { createCanvas } from './automation/canvas.js';
import { createToolbar } from './automation/toolbar.js';
import { createPalette } from './automation/palette.js';
import { createInspector } from './automation/inspector.js';
import { createHealthPanel, createSearchPanel } from './automation/panels.js';
import { createCommandPalette } from './automation/commandPalette.js';
import { openContextMenu } from './automation/contextMenu.js';

const MODAL_ID = 'automation-map-modal';
const HEADER_ICON =
  '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="vertical-align:-2px;margin-right:6px"><rect width="8" height="8" x="3" y="3" rx="2"/><path d="M7 11v4a2 2 0 0 0 2 2h4"/><rect width="8" height="8" x="13" y="13" rx="2"/></svg>';

let _modal = null;
let _mounted = false;
let _open = false;
let _api = null; // canvas api { fitView, focusNode }
const _parts = [];

/* ------------------------------------------------------------------ */
/* Modal shell                                                         */
/* ------------------------------------------------------------------ */

function getModal() {
  if (_modal) return _modal;
  _modal = document.createElement('div');
  _modal.id = MODAL_ID;
  _modal.className = 'modal am-modal';
  _modal.style.display = 'none';
  _modal.innerHTML = `
    <div class="modal-content am-modal-content">
      <div class="modal-header">
        <h4>${HEADER_ICON}Automation Map</h4>
        <button class="close-btn" id="am-close" aria-label="Close Automation Map">✖</button>
      </div>
      <div class="modal-body am-modal-body" id="am-modal-body"></div>
    </div>`;
  document.body.appendChild(_modal);
  _modal.querySelector('#am-close').addEventListener('click', closeAutomationMap);

  // Draggable window chrome (no fullscreen-snap callbacks — matches calendar).
  const content = _modal.querySelector('.modal-content');
  const header = _modal.querySelector('.modal-header');
  if (content && header) makeWindowDraggable(_modal, { content, header });
  return _modal;
}

/** Build the app once and insert it into the modal body. */
function mountApp() {
  if (_mounted) return;
  const body = _modal.querySelector('#am-modal-body');

  const canvas = createCanvas();
  _api = { fitView: canvas.fitView, focusNode: canvas.focusNode };
  canvas.setContextMenuHandler((menu) => openContextMenu(menu, _api));

  const toolbar = createToolbar(_api);
  const palette = createPalette();
  const inspector = createInspector(_api);
  const health = createHealthPanel(_api);
  const search = createSearchPanel();
  const cmd = createCommandPalette(_api);

  const canvasWrap = document.createElement('div');
  canvasWrap.className = 'am-canvas-wrap';
  canvasWrap.append(canvas.el, search.el, health.el, inspector.el);

  const appBody = document.createElement('div');
  appBody.className = 'am-body';
  appBody.append(palette.el, canvasWrap);

  const root = document.createElement('div');
  root.className = 'am-root';
  root.append(toolbar.el, appBody, cmd.el);

  body.appendChild(root);
  _parts.push(canvas, toolbar, palette, inspector, health, search, cmd);
  _mounted = true;

  bindShortcuts();
}

/* ------------------------------------------------------------------ */
/* Keyboard shortcuts (scoped to when the window is visible)           */
/* ------------------------------------------------------------------ */

let _keysBound = false;
function isVisible() {
  return _open && _modal && !_modal.classList.contains('hidden') &&
    !_modal.classList.contains('modal-minimized') && _modal.style.display !== 'none';
}
function isTyping(t) {
  return !!t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable);
}
function onKeyDown(e) {
  if (!isVisible()) return;
  const meta = e.metaKey || e.ctrlKey;
  const key = e.key.toLowerCase();

  if (meta && key === 'k') {
    e.preventDefault(); e.stopPropagation();
    store.setCommandOpen(!store.getState().commandOpen);
    return;
  }
  if (meta && key === 'z') {
    if (isTyping(e.target)) return; // let inputs keep native undo/redo
    e.preventDefault(); e.stopPropagation();
    if (e.shiftKey) store.redo(); else store.undo();
    return;
  }
  if (meta && key === 'y') {
    if (isTyping(e.target)) return;
    e.preventDefault(); e.stopPropagation();
    store.redo();
    return;
  }
  if ((e.key === 'Delete' || e.key === 'Backspace') && !isTyping(e.target)) {
    const sel = store.getState().selectedNodeId;
    if (sel) { e.preventDefault(); e.stopPropagation(); store.deleteNode(sel); }
  }
}
function bindShortcuts() {
  if (_keysBound) return;
  // Capture phase so the app's Ctrl+K wins over TrendVault's global shortcuts
  // while the window is open (gated on visibility).
  document.addEventListener('keydown', onKeyDown, true);
  _keysBound = true;
}

/* ------------------------------------------------------------------ */
/* Open / close                                                        */
/* ------------------------------------------------------------------ */

export function openAutomationMap() {
  if (_open) return;
  if (Modals.isMinimized(MODAL_ID)) { Modals.restore(MODAL_ID); _open = true; _api?.fitView?.({ padding: 0.25, maxZoom: 1 }); return; }

  const modal = getModal();
  modal.classList.remove('hidden', 'modal-minimized');
  const content = modal.querySelector('.modal-content');
  if (content) { content.style.transform = ''; content.style.transition = ''; content.style.opacity = ''; }
  modal.style.display = 'flex';
  _open = true;

  mountApp();

  Modals.register(MODAL_ID, {
    sidebarBtnId: 'tool-automation-btn',
    railBtnId: 'rail-automation',
    label: 'Automation',
    icon: HEADER_ICON,
    closeFn: () => doClose(),
    restoreFn: () => { _open = true; _parts.find((p) => p.onShown)?.onShown?.(); },
  });

  // Let layout settle (modal just became visible) before measuring + fitting.
  requestAnimationFrame(() => _parts.forEach((p) => p.onShown && p.onShown()));
}

function doClose() {
  _open = false;
  if (_modal) { _modal.style.display = 'none'; _modal.classList.add('hidden'); }
}

export function closeAutomationMap() {
  if (!_open && !Modals.isMinimized(MODAL_ID)) return;
  if (Modals.isRegistered(MODAL_ID)) Modals.close(MODAL_ID);
  else doClose();
}

export function isAutomationMapOpen() {
  if (Modals.isMinimized(MODAL_ID)) return false;
  return _open;
}

const automationMapModule = { openAutomationMap, closeAutomationMap, isAutomationMapOpen };
export default automationMapModule;
