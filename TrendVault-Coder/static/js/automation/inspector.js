/**
 * Automation Map — node inspector (ported from Inspector.tsx).
 * Right-side panel to edit every field of the selected node. Rebuilds on
 * selection change; while a field is focused it leaves the form alone so
 * typing never loses focus/caret.
 */

import * as store from './store.js';
import { el, clear, cx, icon, nanoid } from './dom.js';
import { KIND_META, KIND_ORDER, STATUS_META, STATUS_ORDER, HEALTH_META } from './registry.js';
import { validateNode } from './validation.js';

const GOOD = '#22c55e';

export function createInspector(api = {}) {
  const root = el('aside', { class: 'am-inspector', style: 'display:none' });
  let currentId = null;
  let editing = false;

  root.addEventListener('focusin', () => { editing = true; });
  root.addEventListener('focusout', () => { editing = false; });

  function nodeTitle(n) { return n.data.title.trim() || `Untitled ${KIND_META[n.data.kind].label}`; }

  function section(title, ...kids) {
    return el('section', { class: 'am-insp-section' }, el('h3', { class: 'am-label', text: title }), ...kids);
  }

  function textField(node, key, opts = {}) {
    const tag = opts.textarea ? 'textarea' : 'input';
    const node$ = el(tag, {
      class: cx('am-input', opts.mono && 'am-mono', opts.cls),
      placeholder: opts.placeholder || '',
      ...(opts.rows ? { rows: opts.rows } : {}),
      ...(opts.spellcheck === false ? { spellcheck: 'false' } : {}),
      oninput: (e) => store.updateNodeData(node.id, { [key]: e.target.value }),
    });
    node$.value = node.data[key] || '';
    return node$;
  }

  function build() {
    clear(root);
    const node = store.selectedNode();
    if (!node) { root.style.display = 'none'; currentId = null; return; }
    root.style.display = '';
    currentId = node.id;

    const data = node.data;
    const meta = KIND_META[data.kind];
    const status = STATUS_META[data.status];
    const health = validateNode(node, store.getState().nodes, store.getState().edges);
    const hMeta = HEALTH_META[health.level];

    /* header */
    root.appendChild(el('header', { class: 'am-insp-head' },
      el('span', { class: 'am-insp-kico', style: { background: meta.color + '22', color: meta.color }, html: icon(meta.icon, 18) }),
      el('div', { class: 'am-insp-htext' },
        el('div', { class: 'am-insp-kind', text: meta.label }),
        el('div', { class: 'am-insp-status', style: { color: status.color } }, el('span', { html: icon(status.icon, 13) }), el('span', { text: status.label })),
      ),
      el('div', { class: 'am-insp-actions' },
        el('button', { class: 'am-icon-btn', title: 'Duplicate node', onclick: () => store.duplicateNode(node.id), html: icon('copy', 16) }),
        el('button', { class: 'am-icon-btn danger', title: 'Delete node', onclick: () => store.deleteNode(node.id), html: icon('trash', 16) }),
        el('button', { class: 'am-icon-btn', title: 'Close', onclick: () => store.setSelectedNode(null), html: icon('x', 16) }),
      ),
    ));

    const body = el('div', { class: 'am-insp-body' });
    root.appendChild(body);

    /* title */
    const titleSec = el('section', { class: 'am-insp-section am-insp-title' },
      el('label', { class: 'am-label', text: 'Title' }), textField(node, 'title', { placeholder: 'Node title' }));
    body.appendChild(titleSec);

    /* type & space */
    const kindSel = el('select', { class: 'am-input', onchange: (e) => store.updateNodeData(node.id, { kind: e.target.value }) },
      ...KIND_ORDER.map((k) => el('option', { value: k, ...(k === data.kind ? { selected: true } : {}) }, KIND_META[k].label)));
    const spaceSel = el('select', { class: 'am-input', onchange: (e) => store.updateNodeData(node.id, { space: e.target.value }) },
      ...store.getState().spaces.map((s) => el('option', { value: s.id, ...(s.id === data.space ? { selected: true } : {}) }, s.name)));
    body.appendChild(section('Type & Space',
      el('div', { class: 'am-insp-stack' },
        el('div', null, el('label', { class: 'am-sublabel', text: 'Type' }), kindSel),
        el('div', null, el('label', { class: 'am-sublabel', text: 'Space' }), spaceSel),
      )));

    /* status pills */
    const statusWrap = el('div', { class: 'am-pills' });
    for (const st of STATUS_ORDER) {
      const m = STATUS_META[st];
      const active = data.status === st;
      statusWrap.appendChild(el('button', {
        class: cx('am-chip am-pill', active && 'active'),
        style: active ? { background: m.color + '22', color: m.color, borderColor: m.color + '66' } : null,
        onclick: () => store.updateNodeData(node.id, { status: st }),
      }, el('span', { html: icon(m.icon, 12) }), m.label));
    }
    body.appendChild(section('Status', statusWrap));

    /* description */
    body.appendChild(section('Description', textField(node, 'description', { textarea: true, rows: 3, placeholder: 'What is this node for?', cls: 'am-ta' })));

    /* tags */
    const tagsWrap = el('div', { class: 'am-tags am-insp-tags' });
    for (const tag of data.tags) {
      tagsWrap.appendChild(el('span', { class: 'am-chip am-tag' }, tag,
        el('button', { class: 'am-tag-x', title: `Remove ${tag}`, onclick: () => store.updateNodeData(node.id, { tags: data.tags.filter((t) => t !== tag) }), html: icon('x', 11) })));
    }
    const tagInput = el('input', {
      class: 'am-input', placeholder: 'Add a tag, press Enter',
      onkeydown: (e) => {
        if (e.key !== 'Enter') return;
        e.preventDefault();
        const v = tagInput.value.trim();
        if (v && !data.tags.includes(v)) store.updateNodeData(node.id, { tags: [...data.tags, v] });
        tagInput.value = '';
        refocus(() => root.querySelector('.am-insp-tagadd'));
      },
    });
    tagInput.classList.add('am-insp-tagadd');
    body.appendChild(section('Tags', data.tags.length ? tagsWrap : null, tagInput));

    /* kind-specific */
    if (data.kind === 'api') body.appendChild(section('Endpoint', textField(node, 'url', { mono: true, placeholder: 'https://api.example.com/v1/resource' })));
    if (data.kind === 'database') {
      const cb = el('input', { type: 'checkbox', class: 'am-check', onchange: (e) => store.updateNodeData(node.id, { hasCredentials: e.target.checked }) });
      cb.checked = !!data.hasCredentials;
      body.appendChild(section('Data store',
        textField(node, 'schema', { textarea: true, rows: 3, mono: true, placeholder: 'users(id, email, created_at)…', cls: 'am-ta' }),
        el('label', { class: 'am-checkrow' }, cb, 'Has credentials')));
    }
    if (data.kind === 'agent') body.appendChild(section('Prompt', textField(node, 'prompt', { textarea: true, rows: 4, mono: true, placeholder: 'You are a helpful assistant that…', cls: 'am-ta' })));
    if (data.kind === 'terminal') body.appendChild(section('Command', textField(node, 'command', { mono: true, placeholder: 'npm run build' })));
    if (data.kind === 'env') body.appendChild(section('Environment variables', textField(node, 'envVars', { textarea: true, rows: 3, mono: true, placeholder: 'API_KEY=…\nDATABASE_URL=…', cls: 'am-ta' })));

    /* code + notes */
    body.appendChild(section('Code', textField(node, 'code', { textarea: true, rows: 5, mono: true, spellcheck: false, placeholder: '// snippet, pseudocode or signature', cls: 'am-ta' })));
    body.appendChild(section('Notes', textField(node, 'notes', { textarea: true, rows: 3, placeholder: 'Anything else worth remembering…', cls: 'am-ta' })));

    /* checklist */
    const checkWrap = el('div', { class: 'am-checklist' });
    for (const c of data.checklist) {
      const box = el('input', { type: 'checkbox', class: 'am-check', onchange: () => store.updateNodeData(node.id, { checklist: data.checklist.map((x) => x.id === c.id ? { ...x, done: !x.done } : x) }) });
      box.checked = c.done;
      const txt = el('input', {
        class: cx('am-check-text', c.done && 'done'), value: c.text,
        oninput: (e) => store.updateNodeData(node.id, { checklist: data.checklist.map((x) => x.id === c.id ? { ...x, text: e.target.value } : x) }),
      });
      checkWrap.appendChild(el('div', { class: 'am-check-row' }, box, txt,
        el('button', { class: 'am-row-x', title: 'Remove item', onclick: () => store.updateNodeData(node.id, { checklist: data.checklist.filter((x) => x.id !== c.id) }), html: icon('x', 14) })));
    }
    const checkInput = el('input', {
      class: 'am-input am-checkadd', placeholder: 'Add item',
      onkeydown: (e) => {
        if (e.key !== 'Enter') return;
        e.preventDefault();
        const v = checkInput.value.trim();
        if (v) store.updateNodeData(node.id, { checklist: [...data.checklist, { id: nanoid(6), text: v, done: false }] });
        checkInput.value = '';
        refocus(() => root.querySelector('.am-checkadd'));
      },
    });
    const checkAdd = el('button', { class: 'am-icon-btn am-bordered', title: 'Add item', onclick: () => {
      const v = checkInput.value.trim();
      if (v) store.updateNodeData(node.id, { checklist: [...data.checklist, { id: nanoid(6), text: v, done: false }] });
      checkInput.value = '';
    }, html: icon('plus', 16) });
    const doneCount = data.checklist.filter((c) => c.done).length;
    body.appendChild(section('Checklist',
      data.checklist.length ? checkWrap : null,
      el('div', { class: 'am-inline-add' }, checkInput, checkAdd),
      data.checklist.length ? el('p', { class: 'am-muted-note', text: `${doneCount}/${data.checklist.length} done` }) : null,
    ));

    /* links */
    const linkLabel = el('input', { class: 'am-input', placeholder: 'Label (e.g. Figma spec)' });
    const linkUrl = el('input', { class: 'am-input am-mono', placeholder: 'https://…' });
    const addLink = () => {
      const lbl = linkLabel.value.trim(), url = linkUrl.value.trim();
      if (!lbl && !url) return;
      store.updateNodeData(node.id, { links: [...data.links, { id: nanoid(6), label: lbl || url, url }] });
      linkLabel.value = ''; linkUrl.value = '';
    };
    linkLabel.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); addLink(); } });
    linkUrl.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); addLink(); } });
    const linksWrap = el('div', { class: 'am-links' });
    for (const link of data.links) {
      linksWrap.appendChild(el('div', { class: 'am-link-row' },
        el('div', { class: 'am-link-main' },
          el('div', { class: 'am-link-label', text: link.label || link.url || 'Untitled link' }),
          link.url ? el('div', { class: 'am-link-url', text: link.url }) : null),
        link.url ? el('a', { class: 'am-icon-btn am-sm', href: link.url, target: '_blank', rel: 'noreferrer', title: 'Open link', html: icon('externalLink', 14) }) : null,
        el('button', { class: 'am-row-x', title: 'Remove link', onclick: () => store.updateNodeData(node.id, { links: data.links.filter((l) => l.id !== link.id) }), html: icon('x', 14) }),
      ));
    }
    body.appendChild(section('Links',
      data.links.length ? linksWrap : null,
      el('div', { class: 'am-link-add' }, linkLabel, el('div', { class: 'am-inline-add' }, linkUrl, el('button', { class: 'am-icon-btn am-bordered', title: 'Add link', onclick: addLink, html: icon('plus', 16) }))),
    ));

    /* connected nodes */
    const byId = new Map(store.getState().nodes.map((n) => [n.id, n]));
    const incoming = [], outgoing = [];
    for (const e of store.getState().edges) {
      if (e.target === node.id && byId.get(e.source)) incoming.push(byId.get(e.source));
      if (e.source === node.id && byId.get(e.target)) outgoing.push(byId.get(e.target));
    }
    const connWrap = el('div', { class: 'am-conns' });
    const connBtn = (n, dir) => el('button', {
      class: 'am-conn-row', onclick: () => { store.setSelectedNode(n.id); api.focusNode?.(n.id); },
    }, el('span', { class: 'am-conn-arrow', html: icon(dir === 'in' ? 'arrowLeft' : 'arrowRight', 14) }), el('span', { class: 'am-conn-name', text: nodeTitle(n) }));
    incoming.forEach((n) => connWrap.appendChild(connBtn(n, 'in')));
    outgoing.forEach((n) => connWrap.appendChild(connBtn(n, 'out')));
    body.appendChild(section('Connected nodes',
      incoming.length + outgoing.length === 0 ? el('p', { class: 'am-muted-note', text: 'Not connected yet' }) : connWrap));

    /* health */
    const healthSec = section('Health',
      el('span', { class: 'am-chip', style: { background: hMeta.color + '22', color: hMeta.color }, text: hMeta.label }));
    if (health.issues.length) {
      const ul = el('ul', { class: 'am-issues' });
      for (const issue of health.issues) {
        ul.appendChild(el('li', null, el('span', { class: 'am-issue-ico', style: { color: hMeta.color }, html: icon('alertTriangle', 13) }), el('span', { text: issue })));
      }
      healthSec.appendChild(ul);
    } else {
      healthSec.appendChild(el('div', { class: 'am-good', style: { color: GOOD } }, el('span', { html: icon('checkCircle', 14) }), 'Looks good'));
    }
    body.appendChild(healthSec);
  }

  function refocus(getEl) {
    requestAnimationFrame(() => { const e = getEl(); if (e) e.focus(); });
  }

  const unsub = store.subscribe(() => {
    const sel = store.getState().selectedNodeId;
    if (sel !== currentId) { editing = false; build(); }
    else if (!editing) build();
  });
  build();

  return { el: root, destroy() { unsub(); } };
}
