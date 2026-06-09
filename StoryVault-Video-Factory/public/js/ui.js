/* DOM builder + reusable UI components (cards, pills, modals, toasts, fields). */
(function () {
  // Tiny hyperscript: el('div.cls#id', {attrs}, [children])
  function el(tag, attrs, children) {
    let m = tag.match(/^([a-z0-9]+)?(.*)$/i);
    const name = m[1] || 'div';
    const node = document.createElement(name);
    const rest = m[2] || '';
    const idM = rest.match(/#([\w-]+)/); if (idM) node.id = idM[1];
    const cls = (rest.match(/\.([\w-]+)/g) || []).map((c) => c.slice(1)); if (cls.length) node.className = cls.join(' ');
    if (attrs && (Array.isArray(attrs) || attrs instanceof Node || typeof attrs === 'string')) { children = attrs; attrs = null; }
    if (attrs) for (const k in attrs) {
      const v = attrs[k];
      if (v == null || v === false) continue;
      if (k === 'class') node.className += ' ' + v;
      else if (k === 'html') node.innerHTML = v;
      else if (k === 'style' && typeof v === 'object') { for (const sk in v) { if (sk.charCodeAt(0) === 45 && sk.charCodeAt(1) === 45) node.style.setProperty(sk, v[sk]); else node.style[sk] = v[sk]; } } // '--' custom props need setProperty
      else if (k.startsWith('on') && typeof v === 'function') node.addEventListener(k.slice(2).toLowerCase(), v);
      else if (k === 'value') node.value = v;
      else if (k === 'checked' || k === 'disabled' || k === 'selected') { if (v) node.setAttribute(k, k); node[k] = !!v; }
      else node.setAttribute(k, v);
    }
    append(node, children);
    return node;
  }
  function append(node, children) {
    if (children == null) return;
    if (Array.isArray(children)) children.forEach((c) => append(node, c));
    else if (children instanceof Node) node.appendChild(children);
    else node.appendChild(document.createTextNode(String(children)));
  }
  function clear(node) { while (node.firstChild) node.removeChild(node.firstChild); return node; }
  function esc(s) { const d = document.createElement('div'); d.textContent = s == null ? '' : String(s); return d.innerHTML; }

  // Components ---------------------------------------------------------------
  function btn(label, opts = {}) {
    return el('button.btn' + (opts.cls ? '.' + opts.cls : ''), { onclick: opts.onClick, disabled: opts.disabled, title: opts.title }, label);
  }
  function pill(text, kind) { return el('span.pill' + (kind ? '.' + kind : ''), text); }
  function tag(text) { return el('span.tag', text); }

  function field(labelText, control) { return el('label.field', [el('span', labelText), control]); }
  function input(opts = {}) { return el('input', { type: opts.type || 'text', value: opts.value || '', placeholder: opts.placeholder || '', min: opts.min, max: opts.max, step: opts.step, oninput: opts.onInput, id: opts.id }); }
  function textarea(opts = {}) { return el('textarea', { placeholder: opts.placeholder || '', oninput: opts.onInput, id: opts.id, rows: opts.rows || 4 }, opts.value || ''); }
  function select(options, opts = {}) {
    const s = el('select', { onchange: opts.onChange, id: opts.id });
    (options || []).forEach((o) => {
      const val = typeof o === 'object' ? (o.id != null ? o.id : o.value) : o;
      const lbl = typeof o === 'object' ? (o.label || o.name || val) : o;
      const op = el('option', { value: val }, lbl);
      if (String(val) === String(opts.value)) op.selected = true;
      s.appendChild(op);
    });
    return s;
  }
  function checkbox(labelText, checked, onChange, id) {
    return el('label.check', [el('input', { type: 'checkbox', checked: !!checked, onchange: (e) => onChange && onChange(e.target.checked), id }), el('span', labelText)]);
  }
  function toggle(labelText, checked, onChange, id) {
    const input = el('input', { type: 'checkbox', checked: !!checked, onchange: (e) => onChange && onChange(e.target.checked), id });
    return el('label.switch', [input, el('span.track'), labelText ? el('span', labelText) : null]);
  }
  // Collapsible <details> section.
  function collapse(summaryText, children, open) {
    return el('details.collapse', { open: open ? 'open' : null }, [el('summary', summaryText), el('div', children)]);
  }
  function ministat(value, label) { return el('div.ministat', [el('div.v', String(value)), el('div.l', label)]); }

  function scoreColor(v) {
    v = Math.round(v || 0);
    if (v >= 90) return '#22c55e';   // exceptional — green
    if (v >= 80) return '#38bdf8';   // strong — sky
    if (v >= 70) return '#8b8bff';   // usable — accent
    if (v >= 60) return '#eab308';   // weak — yellow
    return '#ef4444';                // reject — red
  }
  function scoreRing(value) {
    const c = scoreColor(value);
    return el('div.score', { style: { '--p': value, '--c': c } }, el('span', { style: { color: c } }, String(Math.round(value))));
  }
  function bar(label, value) {
    return el('div.bar', [el('span.lbl', label), el('div.track', el('div.fill', { style: { width: value + '%' } })), el('span', { style: { width: '26px', color: 'var(--muted)' } }, String(Math.round(value)))]);
  }

  function statTile(value, label, ico) {
    return el('div.stat', [ico ? el('span.ico', ico) : null, el('div.v', String(value)), el('div.l', label)]);
  }

  function empty(icon, title, sub) { return el('div.empty', [el('div.big', icon), el('h3', title), sub ? el('div.muted', sub) : null]); }

  function spinner(text) { return el('div.loading', text || 'Loading…'); }

  // Toast --------------------------------------------------------------------
  function toast(message, kind = '', ms = 3800) {
    const t = el('div.toast' + (kind ? '.' + kind : ''), message);
    document.getElementById('toasts').appendChild(t);
    setTimeout(() => { t.style.opacity = '0'; t.style.transition = 'opacity .3s'; setTimeout(() => t.remove(), 300); }, ms);
  }

  // Modal --------------------------------------------------------------------
  function modal(title, bodyNodes, opts = {}) {
    const root = document.getElementById('modalRoot');
    const close = () => clear(root);
    const bg = el('div.modal-bg', { onclick: (e) => { if (e.target === bg && opts.dismissable !== false) close(); } }, [
      el('div.modal', { style: opts.width ? { maxWidth: opts.width } : null }, [
        el('div.modal-head', [el('strong', title), el('button.icon-btn', { onclick: close }, '✕')]),
        el('div.modal-body', Array.isArray(bodyNodes) ? bodyNodes : [bodyNodes]),
      ]),
    ]);
    clear(root); root.appendChild(bg);
    return { close };
  }

  function confirmModal(title, message, onYes, yesLabel) {
    const m = modal(title, [
      el('p', message),
      el('div.row.tight', { style: { justifyContent: 'flex-end', marginTop: '12px' } }, [
        btn('Cancel', { cls: 'ghost', onClick: () => m.close() }),
        btn(yesLabel || 'Confirm', { cls: 'danger', onClick: () => { m.close(); onYes(); } }),
      ]),
    ], { width: '440px' });
    return m;
  }

  function fmtDuration(s) { s = Math.round(s || 0); const m = Math.floor(s / 60); const sec = s % 60; return m ? `${m}m ${sec}s` : `${sec}s`; }
  function fmtBytes(b) { if (!b) return '0 B'; const u = ['B', 'KB', 'MB', 'GB']; let i = 0; while (b >= 1024 && i < 3) { b /= 1024; i++; } return b.toFixed(i ? 1 : 0) + ' ' + u[i]; }
  function ago(iso) {
    const d = (Date.now() - new Date(iso).getTime()) / 1000;
    if (d < 60) return 'just now'; if (d < 3600) return Math.floor(d / 60) + 'm ago';
    if (d < 86400) return Math.floor(d / 3600) + 'h ago'; return Math.floor(d / 86400) + 'd ago';
  }

  window.UI = { el, clear, esc, append, btn, pill, tag, field, input, textarea, select, checkbox, toggle, collapse, ministat, scoreRing, scoreColor, bar, statTile, empty, spinner, toast, modal, confirmModal, fmtDuration, fmtBytes, ago };
})();
