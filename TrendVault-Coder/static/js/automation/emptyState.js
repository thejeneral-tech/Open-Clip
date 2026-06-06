/**
 * Automation Map — interactive "Start your workflow" empty state.
 *
 * Real, functional buttons (no mockup): create a Feature node at the canvas
 * centre, load a runnable multi-agent sample, or open the command palette.
 * Each action shows a progress bar, drives loading/disabled/success button
 * states, persists to SQLite via store.saveNow(), and raises toasts (incl.
 * error handling when a save fails).
 *
 * Visibility: shown when the canvas is empty OR while an action is in flight
 * (so the progress bar survives the moment the first node is added and the
 * panel would otherwise auto-hide).
 */

import * as store from './store.js';
import { el, clear, icon } from './dom.js';
import { toast } from './toast.js';

const delay = (ms) => new Promise((r) => setTimeout(r, ms));
const errMsg = (e) => (e && (e.body?.detail?.message || e.message)) || String(e || 'Unknown error');

export function createEmptyState(api = {}) {
  let empty = true;
  let busy = false;

  /* progress bar + step checklist (hidden until an action runs) */
  const barFill = el('div', { class: 'am-empty-bar-fill' });
  const bar = el('div', { class: 'am-empty-bar' }, barFill);
  const progressLabel = el('div', { class: 'am-empty-progress-label' });
  const steps = el('ol', { class: 'am-empty-steps' });
  const progress = el('div', { class: 'am-empty-progress', style: 'display:none' }, progressLabel, bar, steps);

  const addBtn = el('button', { class: 'am-btn am-btn-primary am-empty-btn', onclick: onAddFeature },
    el('span', { class: 'am-btn-ico', html: icon('feature', 15) }), el('span', { class: 'am-btn-text', text: 'Add a Feature node' }));
  const sampleBtn = el('button', { class: 'am-btn am-btn-outline am-empty-btn', onclick: onLoadSample },
    el('span', { class: 'am-btn-ico', html: icon('workflow', 15) }), el('span', { class: 'am-btn-text', text: 'Load the sample workflow' }));
  const cmdBtn = el('button', { class: 'am-btn am-btn-ghost am-empty-btn', onclick: () => store.setCommandOpen(true) },
    el('span', { class: 'am-btn-ico', html: icon('command', 14) }), el('span', { class: 'am-btn-text', text: 'Open command palette' }));

  const card = el('div', { class: 'am-empty-card' },
    el('div', { class: 'am-empty-icon', html: icon('workflow', 26) }),
    el('h2', { text: 'Start your workflow' }),
    el('p', { text: 'Map out agents, files, APIs, prompts and deploy steps — then connect them and run the whole thing.' }),
    el('div', { class: 'am-empty-actions' }, addBtn, sampleBtn, cmdBtn),
    progress,
    el('p', { class: 'am-empty-tip', text: 'Tip: drag node types from the left sidebar onto the canvas.' }),
  );
  const root = el('div', { class: 'am-empty', style: 'display:none' }, card);

  const allBtns = [addBtn, sampleBtn, cmdBtn];

  function sync() { root.style.display = (empty || busy) ? '' : 'none'; }

  function setStage(label, frac, isError) {
    progressLabel.textContent = label;
    barFill.style.width = Math.round((frac || 0) * 100) + '%';
    barFill.classList.toggle('error', !!isError);
  }

  function showSteps(list) {
    clear(steps);
    if (!list) { steps.style.display = 'none'; return; }
    steps.style.display = '';
    list.forEach((label, i) => {
      steps.appendChild(el('li', { class: 'am-empty-step', dataset: { i: String(i) } },
        el('span', { class: 'am-empty-step-dot' }), el('span', { text: label })));
    });
  }
  function markStep(i, state) {
    const li = steps.querySelector(`.am-empty-step[data-i="${i}"]`);
    if (li) { li.classList.remove('active', 'done', 'error'); if (state) li.classList.add(state); }
  }

  function startBusy(activeBtn) {
    busy = true;
    allBtns.forEach((b) => { b.disabled = true; b.classList.remove('is-success', 'is-error'); });
    activeBtn.classList.add('is-loading');
    progress.style.display = '';
    setStage('Starting…', 0.05, false);
    sync();
  }
  function endBusy() {
    busy = false;
    allBtns.forEach((b) => { b.disabled = false; b.classList.remove('is-loading'); });
    progress.style.display = 'none';
    showSteps(null);
    sync();
  }
  function succeed(btn) { btn.classList.remove('is-loading'); btn.classList.add('is-success'); }
  function center() { try { return api.worldCenter ? api.worldCenter() : undefined; } catch { return undefined; } }

  /* ---- actions ---- */

  async function onAddFeature() {
    if (busy) return;
    startBusy(addBtn);
    showSteps(null);
    setStage('Creating node…', 0.34);
    toast('Creating Feature node…', { type: 'loading' });
    await delay(280);
    let id;
    try {
      id = store.addNode('feature', center());
      store.setSelectedNode(id); // open the inspector / right panel
    } catch (e) {
      setStage('Failed', 1, true);
      addBtn.classList.add('is-error');
      toast('Could not create node: ' + errMsg(e), { type: 'error' });
      await delay(500); endBusy(); return;
    }
    setStage('Saving…', 0.7);
    try {
      const res = await store.saveNow();
      setStage('Ready', 1);
      succeed(addBtn);
      toast(res && res.offline ? 'Feature node created (saved locally)' : 'Feature node ready', { type: 'success' });
    } catch (e) {
      setStage('Save failed', 1, true);
      toast('Node created, but saving to the project failed: ' + errMsg(e), { type: 'error' });
    }
    await delay(450);
    endBusy();
  }

  async function onLoadSample() {
    if (busy) return;
    startBusy(sampleBtn);
    const labels = ['Input node', 'Research Agent', 'Coding Agent', 'Test Agent', 'Output node', 'Connecting nodes', 'Saving to project'];
    showSteps(labels);
    markStep(0, 'active');
    setStage('Building sample workflow…', 0.06);
    toast('Building sample workflow…', { type: 'loading' });
    try {
      store.loadSample(); // adds the full pipeline at once (panel stays up via busy)
    } catch (e) {
      setStage('Failed', 1, true);
      sampleBtn.classList.add('is-error');
      toast('Could not load sample: ' + errMsg(e), { type: 'error' });
      await delay(500); endBusy(); return;
    }
    for (let i = 0; i < labels.length - 1; i++) {
      markStep(i, 'done');
      markStep(i + 1, 'active');
      setStage(labels[i + 1] + '…', (i + 1) / labels.length);
      await delay(220);
    }
    try {
      const res = await store.saveNow();
      markStep(labels.length - 1, 'done');
      setStage('Ready', 1);
      succeed(sampleBtn);
      toast(res && res.offline ? 'Sample workflow loaded (saved locally)' : 'Sample workflow ready', { type: 'success' });
    } catch (e) {
      markStep(labels.length - 1, 'error');
      setStage('Save failed', 1, true);
      toast('Sample loaded, but saving failed: ' + errMsg(e), { type: 'error' });
    }
    try { api.fitView && api.fitView({ padding: 0.25, maxZoom: 1 }); } catch { /* ignore */ }
    await delay(500);
    endBusy();
  }

  sync();
  return {
    el: root,
    setEmpty(b) { empty = !!b; sync(); },
  };
}
