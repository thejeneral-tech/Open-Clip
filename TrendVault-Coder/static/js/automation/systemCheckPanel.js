/**
 * Automation Map — Full System Check report panel.
 *
 * A modal overlay that runs systemCheck.runSystemCheck() and renders the
 * results live: a progress bar, Passed / Failed / Warning / Fix-needed tallies,
 * and a grouped, expandable list with error details + suggested fixes. Mounted
 * once into the app root (like the command palette) and shown via open().
 */

import { el, clear, icon } from './dom.js';
import { copyToClipboard } from './io.js';
import { toast } from './toast.js';
import { runSystemCheck, summarize, formatReport } from './systemCheck.js';

const STATUS = {
  pass: { ico: 'check', color: '#22c55e', label: 'PASS' },
  fail: { ico: 'x', color: '#ef4444', label: 'FAIL' },
  warn: { ico: 'alertTriangle', color: '#f59e0b', label: 'WARN' },
  skip: { ico: 'activity', color: '#8b93a7', label: 'SKIP' },
};

export function createSystemCheckPanel() {
  let running = false;
  let results = [];
  let lastSummary = null;
  const catSections = new Map();

  /* ---- summary chips ---- */
  const chip = (key, label, color) => {
    const value = el('span', { class: 'am-sc-chip-val', text: '0' });
    const root = el('div', { class: 'am-sc-chip', dataset: { k: key }, style: { borderColor: color + '55' } },
      el('span', { class: 'am-sc-chip-dot', style: { background: color } }),
      el('span', { class: 'am-sc-chip-label', text: label }), value);
    return { root, value };
  };
  const cPass = chip('pass', 'Passed', '#22c55e');
  const cFail = chip('fail', 'Failed', '#ef4444');
  const cWarn = chip('warn', 'Warning', '#f59e0b');
  const cFix = chip('fix', 'Fix needed', '#38bdf8');
  const summaryRow = el('div', { class: 'am-sc-summary' }, cPass.root, cFail.root, cWarn.root, cFix.root);

  /* ---- progress ---- */
  const barFill = el('div', { class: 'am-empty-bar-fill' });
  const bar = el('div', { class: 'am-empty-bar' }, barFill);
  const progressLabel = el('div', { class: 'am-sc-progress-label', text: 'Idle' });
  const progress = el('div', { class: 'am-sc-progress' }, progressLabel, bar);

  /* ---- banner + list ---- */
  const banner = el('div', { class: 'am-sc-banner', style: 'display:none' });
  const listEl = el('div', { class: 'am-sc-list' });

  /* ---- footer ---- */
  const runBtn = el('button', { class: 'am-btn am-btn-primary', onclick: () => run() }, el('span', { html: icon('activity', 15) }), 'Run again');
  const copyBtn = el('button', { class: 'am-btn am-btn-outline', disabled: true, onclick: doCopy }, el('span', { html: icon('copy', 15) }), 'Copy report');
  const closeBtn = el('button', { class: 'am-btn am-btn-ghost', onclick: () => close() }, 'Close');
  const footer = el('div', { class: 'am-sc-foot' }, runBtn, copyBtn, el('span', { style: 'flex:1' }), closeBtn);

  const headClose = el('button', { class: 'am-icon-btn', title: 'Close', onclick: () => close(), html: icon('x', 16) });
  const panel = el('div', { class: 'am-sc-panel', onmousedown: (e) => e.stopPropagation() },
    el('div', { class: 'am-sc-head' },
      el('div', { class: 'am-export-title' },
        el('span', { class: 'am-accent-ico', html: icon('activity', 17) }),
        el('div', null,
          el('h2', { text: 'Full System Check' }),
          el('p', { class: 'am-sc-sub', text: 'Tests every feature against the live app and backend.' }))),
      headClose),
    summaryRow, progress, banner, listEl, footer);

  const overlay = el('div', {
    class: 'am-modal-overlay am-sc-overlay', style: 'display:none',
    onmousedown: (e) => { if (e.target === overlay && !running) close(); },
  }, panel);

  /* ------------------------------------------------------------------ */

  function setProgress(frac, label, isError) {
    barFill.style.width = Math.round((frac || 0) * 100) + '%';
    barFill.classList.toggle('error', !!isError);
    progressLabel.textContent = label;
  }

  function renderSummary(s) {
    cPass.value.textContent = String(s.pass);
    cFail.value.textContent = String(s.fail);
    cWarn.value.textContent = String(s.warn);
    cFix.value.textContent = String(s.fixNeeded);
  }

  function sectionFor(category) {
    if (catSections.has(category)) return catSections.get(category);
    const body = el('div', { class: 'am-sc-cat-body' });
    const section = el('div', { class: 'am-sc-cat' },
      el('div', { class: 'am-sc-cat-head', text: category }), body);
    listEl.appendChild(section);
    catSections.set(category, body);
    return body;
  }

  function appendRow(r) {
    const meta = STATUS[r.status] || STATUS.skip;
    const row = el('div', { class: 'am-sc-row', dataset: { status: r.status } },
      el('span', { class: 'am-sc-ico', style: { color: meta.color }, html: icon(meta.ico, 15) }),
      el('div', { class: 'am-sc-main' },
        el('div', { class: 'am-sc-rowhead' },
          el('span', { class: 'am-sc-label', text: r.label }),
          el('span', { class: 'am-sc-tag', style: { color: meta.color, borderColor: meta.color + '55', background: meta.color + '1a' }, text: meta.label })),
        r.detail ? el('div', { class: 'am-sc-detail', text: r.detail }) : null,
        (r.fix && (r.status === 'fail' || r.status === 'warn'))
          ? el('div', { class: 'am-sc-fix' }, el('span', { class: 'am-sc-fix-ico', html: icon('wand', 12) }), el('span', { text: 'Fix: ' + r.fix }))
          : null));
    sectionFor(r.category).appendChild(row);
  }

  function showBanner(s) {
    banner.style.display = '';
    const allGood = s.fail === 0 && s.warn === 0;
    const color = s.fail > 0 ? '#ef4444' : s.warn > 0 ? '#f59e0b' : '#22c55e';
    const ico = s.fail > 0 ? 'alertTriangle' : s.warn > 0 ? 'alertTriangle' : 'checkCircle';
    const msg = s.fail > 0
      ? `${s.fail} feature${s.fail === 1 ? '' : 's'} failing — see the Fix hints below.`
      : s.warn > 0
        ? `Everything core works. ${s.warn} item${s.warn === 1 ? '' : 's'} need attention (usually a model, server or admin login).`
        : 'All features passed. The app is fully functional.';
    clear(banner);
    banner.style.borderColor = color + '55';
    banner.style.background = color + '14';
    banner.append(
      el('span', { class: 'am-sc-banner-ico', style: { color }, html: icon(ico, 16) }),
      el('span', { class: 'am-sc-banner-text', style: { color }, text: msg }));
  }

  async function run() {
    if (running) return;
    running = true;
    results = [];
    lastSummary = null;
    catSections.clear();
    clear(listEl);
    banner.style.display = 'none';
    renderSummary({ pass: 0, fail: 0, warn: 0, fixNeeded: 0 });
    setProgress(0.04, 'Starting…');
    runBtn.disabled = true; copyBtn.disabled = true; headClose.disabled = true; closeBtn.disabled = true;

    const onResult = (r) => { results.push(r); appendRow(r); renderSummary(summarize(results)); };
    const onProgress = ({ done, total, label }) => setProgress(total ? Math.max(0.04, done / total) : 0.04, `${done} / ${total} — ${label}`);

    try {
      const out = await runSystemCheck({ onResult, onProgress });
      results = out.results; lastSummary = out.summary;
      renderSummary(out.summary);
      setProgress(1, `Done — ${out.summary.pass}/${out.summary.total} passed`);
      showBanner(out.summary);
      toast(`System check complete: ${out.summary.pass} passed, ${out.summary.fail} failed, ${out.summary.warn} warning(s).`,
        { type: out.summary.fail ? 'error' : out.summary.warn ? 'warning' : 'success' });
    } catch (e) {
      setProgress(1, 'Crashed', true);
      toast('System check crashed: ' + ((e && e.message) || e), { type: 'error' });
    } finally {
      running = false;
      runBtn.disabled = false; copyBtn.disabled = false; headClose.disabled = false; closeBtn.disabled = false;
    }
  }

  async function doCopy() {
    if (!results.length) return;
    const text = formatReport(results, lastSummary || summarize(results));
    const ok = await copyToClipboard(text);
    toast(ok ? 'Report copied to clipboard.' : 'Could not copy report.', { type: ok ? 'success' : 'error' });
  }

  function open() {
    overlay.style.display = 'flex';
    run();
  }
  function close() {
    if (running) { toast('System check is still running…', { type: 'info' }); return; }
    overlay.style.display = 'none';
  }

  return { el: overlay, open, close, isRunning: () => running };
}
