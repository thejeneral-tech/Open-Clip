/* All application pages. Each PAGES[x](view, param) renders into the view node. */
window.PAGES = window.PAGES || {};
(function () {
  const PAGES = window.PAGES;
  const { el, clear, btn, pill, tag, field, input, textarea, select, checkbox, toggle, collapse, ministat, scoreRing, statTile, empty, toast, modal, fmtDuration, fmtBytes, ago } = UI;
  const meta = () => App.meta || {};

  function pageHead(title, sub, actions) {
    return el('div.page-head', [
      el('div', [el('h2', title), sub ? el('div.sub', sub) : null]),
      actions ? el('div.btn-group', actions) : null,
    ]);
  }
  function warnPills(warnings) {
    return (warnings || []).map((w) => pill(w, 'warn'));
  }

  // ---- Shared story card (spec §6) ----------------------------------------
  function scoreBars(s) {
    return el('div.bars', [
      UI.bar('Popularity', s.score_popularity), UI.bar('Engagement', s.score_engagement),
      UI.bar('Quality', s.score_quality), UI.bar('Video', s.score_video),
    ]);
  }
  const SCORE_LABEL_CLS = { Exceptional: 'ok', Strong: 'ok', Usable: 'info', Weak: 'warn', Reject: 'err' };
  function scoreLabelPill(s) {
    return s.score_label ? pill(s.score_label + ' · ' + Math.round(s.score_overall), SCORE_LABEL_CLS[s.score_label] || 'accent') : null;
  }
  function provenancePill(prov) {
    if (!prov) return null;
    const cls = prov === 'verified' ? 'ok' : (prov === 'estimated' ? 'warn' : 'err');
    return pill(prov, cls);
  }
  // Full score-explanation breakdown (transparent 0–100, 8 categories).
  function scoreBreakdown(s) {
    const bd = Array.isArray(s.score_breakdown) ? s.score_breakdown : [];
    if (!bd.length) return el('div.muted.tiny', 'No breakdown available.');
    return el('div', [
      el('div.spread', [el('strong', 'StoryVault Score: ' + Math.round(s.score_overall)), scoreLabelPill(s)]),
      el('div.col', { style: { gap: '6px', marginTop: '10px' } }, bd.map((b) => el('div', [
        el('div.spread', [
          el('span', [b.label, b.provenance ? el('span', { style: { marginLeft: '6px' } }, provenancePill(b.provenance)) : null]),
          el('strong', `${b.score} / ${b.max}`),
        ]),
        el('div.bar', el('div.track', el('div.fill', { style: { width: Math.round((b.score / b.max) * 100) + '%' } }))),
        b.detail ? el('div.tiny.muted', b.detail) : null,
      ]))),
    ]);
  }

  function storyCard(s, opts = {}) {
    const dup = s.duplicate_of ? pill('Possible duplicate ' + Math.round((s.duplicate_score || 0) * 100) + '%', 'warn') : null;
    const card = el('div.card.hover.story-card', [
      el('div.head', [
        scoreRing(s.score_overall),
        el('div.grow', [
          el('div.title', s.title),
          el('div.meta', [
            tag(s.community || s.source_type), tag(s.category || '—'),
            s.author ? UI.el('span', '✍ ' + s.author) : null,
            UI.el('span', '▲ ' + (s.upvotes || 0)), UI.el('span', '💬 ' + (s.num_comments || 0)),
            UI.el('span', '⏱ ~' + fmtDuration(s.est_video_seconds)),
          ]),
        ]),
      ]),
      el('div.row.tight', [scoreLabelPill(s), dup, ...warnPills(s.warnings), s.status && s.status !== 'new' ? pill(s.status, s.status === 'excluded' ? 'err' : 'info') : null].filter(Boolean)),
      el('div.preview', s.preview || (s.body || '').slice(0, 240)),
      scoreBars(s),
      s.score_reasons && s.score_reasons.length ? el('div.tiny.muted', '✓ ' + s.score_reasons.slice(0, 2).join(' · ')) : null,
      el('div.tiny', { style: { marginTop: '2px' }, onclick: () => scoreModal(s) }, [el('a', { style: { cursor: 'pointer', color: 'var(--accent)' } }, 'Why this score?')]),
      el('div.card-actions', [
        btn('👁 Review', { cls: 'sm', onClick: () => storyDetail(s.id) }),
        btn('✦ Create Video', { cls: 'sm primary', onClick: () => createVideoModal(s.id) }),
        btn('🧠 Analyze', { cls: 'sm ghost', onClick: () => analyzeModal(s.id) }),
        btn('💾 Save', { cls: 'sm ghost', onClick: async () => { await API.post(`/stories/${s.id}/status`, { status: 'saved' }); toast('Saved', 'ok'); } }),
        btn('🚫 Exclude', { cls: 'sm ghost', onClick: async () => { await API.post(`/stories/${s.id}/status`, { status: 'excluded' }); toast('Excluded'); card.style.opacity = .5; } }),
        s.url ? el('a.btn.sm.ghost', { href: s.url, target: '_blank' }, '🔗 Open Source') : null,
      ]),
      opts.selectable ? el('label.check', { style: { marginTop: '4px' } }, [el('input', { type: 'checkbox', onchange: (e) => opts.onSelect(s.id, e.target.checked) }), el('span', 'Select')]) : null,
    ]);
    return card;
  }

  async function scoreModal(s) {
    const full = (s.score_breakdown && s.score_breakdown.length) ? s : await API.get('/stories/' + s.id);
    modal('StoryVault score explanation', [
      scoreBreakdown(full),
      el('div.tiny.muted.mt', 'Engagement uses real platform metrics where available; values are labelled verified / estimated / unavailable and never fabricated. A score near 100 requires every category to be near-perfect.'),
    ], { width: '580px' });
  }

  async function analyzeModal(id) {
    const a = await API.post(`/stories/${id}/analyze`, {});
    const rows = [
      ['Main character', a.mainCharacter], ['Other people', (a.otherPeople || []).join(', ') || '—'],
      ['Relationship', a.relationship], ['Conflict', a.conflict], ['Twist', a.twist || '—'],
      ['Ending', a.ending], ['Audience question', a.audienceQuestion],
      ['Has update', a.hasUpdate ? 'Yes' : 'No'], ['Has dialogue', a.hasDialogue ? 'Yes' : 'No'],
      ['Est. duration', fmtDuration(a.estimatedDurationSeconds)],
    ];
    modal('🧠 Story Analysis', [
      el('table', el('tbody', rows.map(([k, v]) => el('tr', [el('td', { style: { color: 'var(--muted)', width: '160px' } }, k), el('td', String(v))])))),
      a.keyEvents && a.keyEvents.length ? el('div.mt', [el('strong', 'Key events'), el('ul', a.keyEvents.map((e) => el('li', e)))]) : null,
      a.warnings && a.warnings.length ? el('div.mt', [el('strong', 'Content warnings: '), ...warnPills(a.warnings)]) : null,
      a.namesToAnonymize && a.namesToAnonymize.length ? el('div.mt.tiny.muted', 'Names to anonymize: ' + a.namesToAnonymize.join(', ')) : null,
    ]);
  }

  async function storyDetail(id) {
    const s = await API.get('/stories/' + id);
    modal('📖 ' + s.title, [
      el('div.row.tight', [tag(s.community), tag(s.category), scoreLabelPill(s), ...warnPills(s.warnings)].filter(Boolean)),
      el('div.mt.panel', scoreBreakdown(s)),
      el('div.mt.panel', { style: { whiteSpace: 'pre-wrap', maxHeight: '320px', overflow: 'auto' } }, s.body),
      el('div.row.mt', [
        btn('✦ Create Video', { cls: 'primary', onClick: () => createVideoModal(s.id) }),
        btn('✓ Approve', { cls: 'ok', onClick: async () => { await API.post(`/stories/${id}/status`, { status: 'approved' }); toast('Approved', 'ok'); } }),
        s.url ? el('a.btn.ghost', { href: s.url, target: '_blank' }, '🔗 Source') : null,
      ]),
    ], { width: '760px' });
  }

  // ---- Create-video settings modal (used from story cards + composer) ------
  function createVideoModal(storyId) {
    const m = meta();
    const defTpl = (m.templates || []).find((t) => t.isDefault) || (m.templates || [])[0] || {};
    const st = {
      durationSeconds: (App.prefs && App.prefs.targetVideoLength) || 60,
      hookStyle: 'conflict', voice: (App.prefs && App.prefs.preferredVoice) || (m.voices && m.voices[0] && m.voices[0].name),
      speed: 1.0, captionStyle: (App.prefs && App.prefs.preferredCaptionStyle) || 'bold',
      narrationStyle: 'Calm storyteller', backgroundCategory: (App.prefs && App.prefs.preferredBackground) || 'Minecraft parkour',
      templateId: defTpl.id, dramaLevel: 3, safeMode: false,
    };
    const body = el('div.form-grid', [
      field('Template', select((m.templates || []).map((t) => ({ id: t.id, label: t.name + (t.isDefault ? ' ★' : '') })), { value: st.templateId, onChange: (e) => st.templateId = e.target.value })),
      field('Duration', select(m.scriptDurations.map((d) => ({ id: d, label: d + 's' })), { value: st.durationSeconds, onChange: (e) => st.durationSeconds = +e.target.value })),
      field('Hook style', select(m.hookStyles, { value: st.hookStyle, onChange: (e) => st.hookStyle = e.target.value })),
      field('Voice', select((m.voices || []).map((v) => v.name), { value: st.voice, onChange: (e) => st.voice = e.target.value })),
      field('Narration style', select(m.narrationStyles, { value: st.narrationStyle, onChange: (e) => st.narrationStyle = e.target.value })),
      field('Background type', select(m.gameplayCategories || m.backgroundTypes, { value: st.backgroundCategory, onChange: (e) => st.backgroundCategory = e.target.value })),
      field('Speed', input({ type: 'number', value: st.speed, step: '0.05', min: '0.7', max: '1.4', onInput: (e) => st.speed = +e.target.value })),
      field('Drama level (1-5)', input({ type: 'number', value: st.dramaLevel, min: '1', max: '5', onInput: (e) => st.dramaLevel = +e.target.value })),
    ]);
    const status = el('div.mt.muted');
    const m2 = modal('✦ Create Video', [
      body,
      el('div.mt', checkbox('Safe mode (censor profanity)', st.safeMode, (v) => st.safeMode = v)),
      status,
      el('div.row.mt', { style: { justifyContent: 'flex-end' } }, [
        btn('Cancel', { cls: 'ghost', onClick: () => m2.close() }),
        btn('Generate preview', {
          cls: 'primary', onClick: async (ev) => {
            ev.target.disabled = true; status.textContent = 'Generating script → narration → captions → footage → preview…';
            try {
              const bundle = await API.post('/videos', { storyId, ...st });
              m2.close(); toast('Preview ready — sent to Review Queue', 'ok');
              location.hash = '#/review';
            } catch (e) { status.innerHTML = ''; status.appendChild(pill(e.message, 'err')); ev.target.disabled = false; }
          },
        }),
      ]),
    ], { width: '680px' });
  }

  // ===================== DASHBOARD (§24) =====================
  PAGES.dashboard = async function (view) {
    const d = await API.get('/dashboard');
    clear(view);
    view.append(
      pageHead('Dashboard', 'Discover → rank → script → narrate → footage → captions → preview → render → export', [
        btn('🔍 Find Stories', { cls: 'primary', onClick: () => App.go('discovery') }),
        btn('⚙️ Batch Studio', { onClick: () => App.go('batch') }),
      ]),
      el('div.grid.stats', [
        statTile(d.storiesDiscovered, 'Stories discovered', '🔍'),
        statTile(d.storiesSaved, 'Stories saved', '💾'),
        statTile(d.videosCreated, 'Videos created', '🎬'),
        statTile(d.videosApproved, 'Videos approved', '✅'),
        statTile(d.videosExported, 'Videos exported', '📤'),
        statTile(d.duplicatesPrevented, 'Duplicates prevented', '🛡️'),
        statTile(d.segmentReusePercent + '%', 'Segment reuse', '♻️'),
        statTile(d.failedTasks, 'Failed tasks', '⚠️'),
        statTile(d.storageUsed, 'Storage used', '💽'),
      ]),
      el('div.grid.two.mt', [
        el('div.panel', [
          el('div.section-title', '🏆 Insights'),
          infoRow('Most successful category', d.mostSuccessfulCategory),
          infoRow('Most successful length', d.mostSuccessfulLength),
          infoRow('Most-used background', d.mostUsedBackground),
          infoRow('History tracked', (d.historyTracked.stories) + ' stories, ' + d.historyTracked.videos + ' videos'),
        ]),
        el('div.panel', [
          el('div.section-title', '📤 Recent exports'),
          (d.recentExports && d.recentExports.length) ? el('div.col', d.recentExports.map((e) => el('div.spread', [
            el('div', [el('div', e.title || 'Untitled'), el('div.tiny.muted', e.platform + ' · ' + e.width + '×' + e.height + ' · ' + fmtDuration(e.duration))]),
            el('a.btn.sm.ghost', { href: '/api/exports/' + e.id + '/download' }, '⬇'),
          ]))) : empty('📭', 'No exports yet', 'Approve a video in the Review Queue to export it.'),
        ]),
      ]),
    );
  };
  function infoRow(k, v) { return el('div.spread', { style: { padding: '7px 0', borderBottom: '1px solid var(--border)' } }, [el('span.muted', k), el('strong', String(v))]); }

  // ===================== STORY DISCOVERY (§3) =====================
  PAGES.discovery = async function (view) {
    const m = meta();
    const state = {
      source: 'reddit', communities: ['AmItheAsshole'], keyword: '', categories: [], dateRange: 'month',
      minUpvotes: 0, minComments: 0, minLength: 0, maxLength: 0, minScore: 0, sort: 'engaging', limit: 25,
      pastedText: '', urls: '', feedUrls: '',
    };
    clear(view);
    const resultsBox = el('div.grid.cards.mt');
    const selected = new Set();

    const communitiesInput = input({ value: state.communities.join(', '), placeholder: 'AmItheAsshole, ProRevenge…', onInput: (e) => state.communities = e.target.value.split(',').map((x) => x.trim()).filter(Boolean) });
    const catChips = el('div.row.tight', m.categories.map((c) => {
      const chip = el('div.chip', { onclick: () => { chip.classList.toggle('on'); const i = state.categories.indexOf(c); if (i >= 0) state.categories.splice(i, 1); else state.categories.push(c); } }, c);
      return chip;
    }));

    const sourceSpecific = el('div.mt');
    function renderSourceSpecific() {
      clear(sourceSpecific);
      if (state.source === 'reddit' || state.source === 'multiple') sourceSpecific.append(field('Communities', communitiesInput));
      if (state.source === 'pasted' || state.source === 'quora_url' || state.source === 'website')
        sourceSpecific.append(field('Paste story text (separate multiple with a line of ---)', textarea({ value: state.pastedText, rows: 6, onInput: (e) => state.pastedText = e.target.value })));
      if (state.source === 'reddit_url' || state.source === 'multiple')
        sourceSpecific.append(field('Reddit post URLs (one per line)', textarea({ value: state.urls, rows: 3, onInput: (e) => state.urls = e.target.value })));
      if (state.source === 'quora') {
        sourceSpecific.append(field('Quora question URLs (one per line)', textarea({ value: state.urls, rows: 3, placeholder: 'https://www.quora.com/…', onInput: (e) => state.urls = e.target.value })));
        sourceSpecific.append(el('div.small.muted.mt', 'Reads the public Quora page (no login). If Quora blocks it, switch Source to “Pasted text” and paste the question + answer.'));
      }
      if (state.source === 'rss' || state.source === 'multiple')
        sourceSpecific.append(field('RSS feed URLs (one per line)', textarea({ value: state.feedUrls, rows: 2, onInput: (e) => state.feedUrls = e.target.value })));
    }
    renderSourceSpecific();

    async function runSearch(extra) {
      clear(resultsBox); resultsBox.append(UI.spinner('Searching…'));
      const payload = Object.assign({}, state, {
        urls: state.urls.split(/\n/).map((x) => x.trim()).filter(Boolean),
        feedUrls: state.feedUrls.split(/\n/).map((x) => x.trim()).filter(Boolean),
      }, extra || {});
      try {
        const r = await API.post('/discovery/search', payload);
        clear(resultsBox);
        if (r.errors && r.errors.length) r.errors.forEach((er) => toast(er, 'warn', 6000));
        if (!r.stories.length) { resultsBox.append(empty('🔍', 'No stories found', 'Try different communities, lower filters, or paste a story directly.')); return; }
        toast(`${r.stories.length} stories selected · ${r.duplicates} duplicates flagged`, 'ok');
        r.stories.forEach((s) => resultsBox.append(storyCard(s, { selectable: true, onSelect: (id, on) => on ? selected.add(id) : selected.delete(id) })));
      } catch (e) { clear(resultsBox); resultsBox.append(empty('⚠️', 'Search failed', e.message)); }
    }

    view.append(
      pageHead('Story Finder', 'Find, rank and pull stories from Reddit, Quora, files, RSS or pasted text.'),
      el('div.panel', [
        el('div.form-grid', [
          field('Source', select([
            { id: 'reddit', label: 'Reddit communities' }, { id: 'reddit_url', label: 'Reddit post URLs' },
            { id: 'quora', label: 'Quora question URLs' }, { id: 'pasted', label: 'Pasted text (Reddit/Quora/any)' },
            { id: 'rss', label: 'RSS feeds' }, { id: 'website', label: 'Website (paste)' }, { id: 'multiple', label: 'Multiple sources' },
          ], { value: state.source, onChange: (e) => { state.source = e.target.value; renderSourceSpecific(); } })),
          field('Search keyword', input({ value: state.keyword, placeholder: 'optional', onInput: (e) => state.keyword = e.target.value })),
          field('Sort order', select(m.sortOptions, { value: state.sort, onChange: (e) => state.sort = e.target.value })),
          field('Date range', select(['hour', 'day', 'week', 'month', 'year', 'all'], { value: state.dateRange, onChange: (e) => state.dateRange = e.target.value })),
          field('Number of results', input({ type: 'number', value: state.limit, min: '1', max: '100', onInput: (e) => state.limit = +e.target.value })),
          field('Min upvotes', input({ type: 'number', value: state.minUpvotes, onInput: (e) => state.minUpvotes = +e.target.value })),
          field('Min comments', input({ type: 'number', value: state.minComments, onInput: (e) => state.minComments = +e.target.value })),
          field('Min length (chars)', input({ type: 'number', value: state.minLength, onInput: (e) => state.minLength = +e.target.value })),
          field('Max length (chars)', input({ type: 'number', value: state.maxLength, onInput: (e) => state.maxLength = +e.target.value })),
          field('Min overall score', input({ type: 'number', value: state.minScore, min: '0', max: '100', onInput: (e) => state.minScore = +e.target.value })),
        ]),
        sourceSpecific,
        el('div.mt', [el('div.small.muted.mb', 'Categories (optional filter)'), catChips]),
        el('div.btn-group.mt', [
          btn('🔍 Search Stories', { cls: 'primary', onClick: () => runSearch() }),
          btn('⚡ Find Trending', { onClick: () => runSearch({ sort: 'engaging', dateRange: 'day' }) }),
          btn('🎲 Find Related', { onClick: () => runSearch({ sort: 'hidden_gems' }) }),
          btn('↻ Search Again', { cls: 'ghost', onClick: () => runSearch() }),
        ]),
      ]),
      el('div.panel.mt', [
        el('div.spread', [el('strong', 'Bulk actions'), el('div.btn-group', [
          btn('Approve selected', { cls: 'sm ok', onClick: () => bulk('approve') }),
          btn('Save selected', { cls: 'sm', onClick: () => bulk('save') }),
          btn('Exclude selected', { cls: 'sm danger', onClick: () => bulk('exclude') }),
          btn('Create videos', { cls: 'sm primary', onClick: () => createBatchFromSelected() }),
          el('a.btn.sm.ghost', { href: '/api/stories/export/csv' }, 'Export CSV'),
        ])]),
      ]),
      resultsBox,
    );

    async function bulk(action) {
      if (!selected.size) return toast('Select some stories first', 'warn');
      await API.post('/stories/bulk', { ids: [...selected], action });
      toast(`${action} applied to ${selected.size} stories`, 'ok');
    }
    function createBatchFromSelected() {
      if (!selected.size) return toast('Select stories first', 'warn');
      sessionStorage.setItem('batchStoryIds', JSON.stringify([...selected]));
      App.go('batch');
    }
  };

  // ===================== STORY LIBRARY (§6) =====================
  PAGES.library = async function (view) {
    const m = meta();
    const filters = { status: '', category: '', search: '' };
    clear(view);
    const grid = el('div.grid.cards.mt');
    async function load() {
      clear(grid); grid.append(UI.spinner());
      const stories = await API.get('/stories?' + new URLSearchParams(Object.fromEntries(Object.entries(filters).filter(([, v]) => v))).toString());
      clear(grid);
      if (!stories.length) { grid.append(empty('📚', 'No saved stories', 'Discover and save stories first.')); return; }
      stories.forEach((s) => grid.append(storyCard(s)));
    }
    view.append(
      pageHead('📚 Story Library', 'Every discovered story, ranked and filterable.'),
      el('div.panel', el('div.form-grid', [
        field('Status', select([{ id: '', label: 'All' }, 'new', 'saved', 'approved', 'used', 'excluded'], { onChange: (e) => { filters.status = e.target.value; load(); } })),
        field('Category', select([{ id: '', label: 'All' }].concat(m.categories), { onChange: (e) => { filters.category = e.target.value; load(); } })),
        field('Search', input({ placeholder: 'title or text…', onInput: (e) => { filters.search = e.target.value; clearTimeout(filters._t); filters._t = setTimeout(load, 350); } })),
      ])),
      grid,
    );
    load();
  };

  // ===================== BACKGROUND LIBRARY (§10) =====================
  PAGES.backgrounds = async function (view) {
    const m = meta();
    clear(view);
    const grid = el('div.grid.cards.mt');
    let uploadCategory = 'Minecraft parkour';

    async function load() {
      clear(grid); grid.append(UI.spinner());
      const list = await API.get('/backgrounds');
      clear(grid);
      if (!list.length) { grid.append(empty('🎮', 'No background footage', 'Upload MP4 files (Minecraft parkour, nature, driving…) to get started.')); return; }
      list.forEach((bg) => grid.append(backgroundCard(bg, load)));
    }

    const drop = el('div.dropzone', [el('div', { style: { fontSize: '30px' } }, '⬆️'), el('div', 'Drag & drop MP4 files here, or click to choose'), el('div.tiny.muted.mt', 'Originals are never modified. Multiple files & folders supported.')]);
    const fileInput = el('input', { type: 'file', accept: 'video/mp4,video/quicktime,video/x-matroska,.mp4,.mov,.mkv,.webm', multiple: true, style: { display: 'none' }, onchange: (e) => uploadFiles(e.target.files) });
    drop.onclick = () => fileInput.click();
    drop.ondragover = (e) => { e.preventDefault(); drop.classList.add('drag'); };
    drop.ondragleave = () => drop.classList.remove('drag');
    drop.ondrop = (e) => { e.preventDefault(); drop.classList.remove('drag'); uploadFiles(e.dataTransfer.files); };

    const progressBox = el('div.mt');
    async function uploadFiles(files) {
      if (!files || !files.length) return;
      const fd = new FormData();
      fd.append('category', uploadCategory);
      [...files].forEach((f) => fd.append('files', f));
      clear(progressBox);
      const pb = el('div.progress', el('div.fill', { style: { width: '0%' } }));
      progressBox.append(el('div.small.muted.mb', `Uploading ${files.length} file(s)…`), pb);
      try {
        const r = await API.uploadProgress('/backgrounds/upload', fd, (p) => { pb.firstChild.style.width = Math.round(p * 100) + '%'; });
        clear(progressBox);
        const okCount = r.uploaded.filter((u) => !u.error).length;
        toast(`Uploaded ${okCount}/${r.uploaded.length} file(s)`, 'ok');
        r.uploaded.filter((u) => u.error).forEach((u) => toast(`${u.file}: ${u.error}`, 'err', 6000));
        load();
      } catch (e) { clear(progressBox); toast('Upload failed: ' + e.message, 'err'); }
    }

    // --- Import gameplay from a YouTube URL ---
    let ytUrl = '';
    const ytInput = input({ placeholder: 'https://www.youtube.com/watch?v=…  (or youtu.be / shorts)', onInput: (e) => ytUrl = e.target.value });
    const ytBtn = btn('⬇ Import from YouTube', { cls: 'primary', onClick: importYouTube });
    const STAGE_LABEL = { starting: 'Connecting to YouTube…', downloading: 'Downloading', merging: 'Merging audio + video…', processing: 'Processing…', registering: 'Reading video metadata…', segmenting: 'Splitting into reusable segments…' };
    async function importYouTube() {
      const url = (ytUrl || '').trim();
      if (!url) return toast('Paste a YouTube video URL first', 'warn');
      ytBtn.disabled = true;
      clear(progressBox);
      const fill = el('div.fill', { style: { width: '0%' } });
      const pb = el('div.progress', fill);
      const label = el('div.small.muted.mb', 'Starting…');
      const cancelBtn = btn('✕ Cancel', { cls: 'sm danger', onClick: async () => { cancelBtn.disabled = true; try { await API.post('/backgrounds/import/youtube/' + importId + '/cancel', {}); } catch { /* already finished */ } } });
      progressBox.append(label, el('div.row.tight', { style: { gap: '8px', alignItems: 'center' } }, [el('div', { style: { flex: '1' } }, pb), cancelBtn]));
      let off = null;
      const finish = () => { if (off) { App.off('progress', off); off = null; } ytBtn.disabled = false; };
      off = App.on('progress', (p) => {
        if (p.channel !== 'youtube' || p.importId !== importId) return;
        if (p.stage === 'done') {
          finish(); clear(progressBox);
          toast('Imported "' + (p.name || 'video') + '" as ' + uploadCategory, 'ok');
          ytInput.value = ''; ytUrl = '';
          load();
          return;
        }
        if (p.stage === 'cancelled') { finish(); clear(progressBox); toast('YouTube import cancelled', 'warn'); return; }
        if (p.stage === 'error') { finish(); clear(progressBox); toast('YouTube import failed: ' + p.error, 'err', 10000); return; }
        if (!pb.isConnected) return; // user navigated away — import keeps running in the background
        if (typeof p.percent === 'number') fill.style.width = Math.round(p.percent) + '%';
        let txt = STAGE_LABEL[p.stage] || 'Working…';
        if (p.stage === 'downloading') {
          txt = `Downloading ${typeof p.percent === 'number' ? Math.round(p.percent) + '%' : ''}`;
          if (p.size) txt += ` of ${p.size}`;
          if (p.speed) txt += ` · ${p.speed}`;
          if (p.eta) txt += ` · ETA ${p.eta}`;
        } else if (p.stage === 'segmenting' || p.stage === 'merging' || p.stage === 'processing' || p.stage === 'registering') {
          fill.style.width = '100%';
        }
        label.textContent = txt;
      });
      let importId;
      try {
        const r = await API.post('/backgrounds/import/youtube', { url, category: uploadCategory, autoSegment: true });
        importId = r.importId;
        label.textContent = 'Starting… (large gameplay videos can take a few minutes)';
      } catch (e) { finish(); clear(progressBox); toast('YouTube import failed: ' + e.message, 'err', 9000); }
    }

    view.append(
      pageHead('Footage Library', 'Upload and manage gameplay. Videos are split into reusable, deduplicated segments.'),
      el('div.panel', [
        field('Upload category', select(m.backgroundTypes, { value: uploadCategory, onChange: (e) => uploadCategory = e.target.value })),
        el('div.mt', drop), fileInput,
        field('Or import gameplay from a YouTube URL', el('div.row.tight', { style: { gap: '8px', alignItems: 'stretch' } }, [
          el('div', { style: { flex: '1' } }, ytInput), ytBtn,
        ])),
        el('div.tiny.muted', 'Downloads the public video (≤1080p) as reusable footage, then auto-segments it. Honors YouTube restrictions — private, members-only and age-gated videos can’t be imported.'),
        progressBox,
      ]),
      grid,
    );
    load();
  };

  function backgroundCard(bg, reload) {
    const used = bg.times_used ? pill('used ' + bg.times_used + '×', 'info') : null;
    return el('div.card.hover', [
      bg.thumbnail_url ? el('img.thumb', { src: bg.thumbnail_url }) : el('div.thumb'),
      el('div.spread.mt', [el('strong', bg.original_name), bg.favorite ? pill('★', 'warn') : null]),
      el('div.meta.tiny.muted', { style: { display: 'flex', gap: '8px', flexWrap: 'wrap', marginTop: '4px' } }, [
        UI.el('span', bg.width + '×' + bg.height), UI.el('span', Math.round(bg.fps) + 'fps'),
        UI.el('span', fmtDuration(bg.duration)), UI.el('span', fmtBytes(bg.size_bytes)), UI.el('span', 'Q' + Math.round(bg.quality_score)),
      ]),
      el('div.row.tight.mt', [tag(bg.category), bg.analyzed ? pill('segmented', 'ok') : pill('not segmented', 'warn'), used].filter(Boolean)),
      el('div.card-actions.mt', [
        btn('✂ Create Segments', { cls: 'sm primary', onClick: () => createSegments(bg, reload) }),
        btn('🎞 Edit', { cls: 'sm', onClick: () => App.go('segments/b/' + bg.id) }),
        btn(bg.favorite ? '★ Unfav' : '☆ Favorite', { cls: 'sm ghost', onClick: async () => { await API.patch('/backgrounds/' + bg.id, { favorite: !bg.favorite }); reload(); } }),
        btn('🏷 Tags', { cls: 'sm ghost', onClick: () => tagModal(bg, reload) }),
        btn('🗑', { cls: 'sm danger', onClick: () => UI.confirmModal('Delete background', 'Delete "' + bg.original_name + '" and its segments? The original file will be removed.', async () => { await API.del('/backgrounds/' + bg.id); toast('Deleted'); reload(); }, 'Delete') }),
      ]),
    ]);
  }
  function tagModal(bg, reload) {
    let tags = (bg.tags || []).join(', ');
    let name = bg.original_name;
    const m = modal('🏷 Edit ' + bg.original_name, [
      field('Name', input({ value: name, onInput: (e) => name = e.target.value })),
      field('Tags (comma separated)', input({ value: tags, onInput: (e) => tags = e.target.value })),
      field('Category', select(meta().backgroundTypes, { value: bg.category, onChange: (e) => bg._cat = e.target.value })),
      el('div.row.mt', { style: { justifyContent: 'flex-end' } }, [btn('Save', { cls: 'primary', onClick: async () => { await API.patch('/backgrounds/' + bg.id, { original_name: name, tags: tags.split(',').map((t) => t.trim()).filter(Boolean), category: bg._cat || bg.category }); m.close(); toast('Saved', 'ok'); reload(); } })]),
    ], { width: '520px' });
  }
  async function createSegments(bg, reload) {
    const lengths = meta().segmentLengths.map((l) => ({ id: l, label: l + 's' })).concat([{ id: 'auto', label: 'Automatic' }]);
    let len = 'auto';
    const status = el('div.mt.muted');
    const m = modal('✂ Create Segments — ' + bg.original_name, [
      el('p.muted', 'Detects black screens, menus, loading and frozen sections and splits the rest into reusable clips.'),
      field('Segment length', select(lengths, { value: len, onChange: (e) => len = e.target.value })),
      status,
      el('div.row.mt', { style: { justifyContent: 'flex-end' } }, [btn('Analyze & Split', {
        cls: 'primary', onClick: async (ev) => {
          ev.target.disabled = true; status.textContent = 'Analyzing footage… this may take a moment for long videos.';
          try { const segs = await API.post('/backgrounds/' + bg.id + '/segments', { segmentLength: len }); m.close(); toast(`Created ${segs.length} segments`, 'ok'); reload && reload(); }
          catch (e) { status.innerHTML = ''; status.appendChild(pill(e.message, 'err')); ev.target.disabled = false; }
        },
      })]),
    ], { width: '560px' });
  }

  // ===================== SEGMENT EDITOR (§12) =====================
  PAGES.segments = async function (view, param) {
    const backgrounds = await API.get('/backgrounds');
    clear(view);
    if (!backgrounds.length) { view.append(pageHead('✂️ Segment Editor'), empty('🎮', 'No footage', 'Upload background videos first.')); return; }
    // param may be 'b/<id>' via App.go('segments/b/<id>') → location.hash '#/segments/b/<id>'
    let currentId = (location.hash.split('/')[3]) || backgrounds[0].id;
    const wrap = el('div.grid.two');
    view.append(pageHead('✂️ Segment Editor', 'Trim, split, tag and rate segments. Mark unusable sections to exclude them.'),
      el('div.panel', field('Background', select(backgrounds.map((b) => ({ id: b.id, label: b.original_name })), { value: currentId, onChange: (e) => { currentId = e.target.value; renderEditor(); } }))),
      wrap);
    const player = el('video', { controls: true, style: { width: '100%', borderRadius: '10px', background: '#000', maxHeight: '420px' } });
    const segBox = el('div.col');

    async function renderEditor() {
      clear(wrap);
      const bg = await API.get('/backgrounds/' + currentId);
      player.src = bg.file_url;
      const segs = bg.segments || [];
      clear(segBox);
      segBox.append(el('div.spread', [el('strong', segs.length + ' segments'), btn('✂ Re-create segments', { cls: 'sm', onClick: () => createSegments(bg, renderEditor) })]));
      if (!segs.length) segBox.append(empty('✂️', 'No segments yet', 'Click "Create Segments".'));
      segs.forEach((s) => segBox.append(segmentRow(s, bg, renderEditor, player)));
      wrap.append(
        el('div.panel', [el('div.section-title', '▶ ' + bg.original_name), player, el('div.row.tight.mt', [
          btn('➕ Add segment at playhead', { cls: 'sm', onClick: async () => { const start = player.currentTime || 0; const end = Math.min(bg.duration, start + 10); await API.post('/segments', { backgroundId: bg.id, start, end }); toast('Segment added', 'ok'); renderEditor(); } }),
        ])]),
        el('div.panel', [el('div.section-title', '🎞 Segments'), segBox]),
      );
    }
    renderEditor();
  };

  function segmentRow(s, bg, reload, player) {
    const tags = (s.tags || []).map(tag);
    return el('div.card', [
      el('div.spread', [
        el('div', [el('strong', s.name), el('div.tiny.muted', fmtDuration(s.duration) + ' · ' + s.start_sec + 's→' + s.end_sec + 's · Q' + Math.round(s.quality_score))]),
        s.usable ? pill('usable', 'ok') : pill('unusable', 'err'),
      ]),
      tags.length ? el('div.row.tight.mt', tags) : null,
      el('div.card-actions.mt', [
        btn('▶ Loop', { cls: 'sm ghost', onClick: () => { if (player) { player.currentTime = s.start_sec; player.play(); const stop = () => { if (player.currentTime >= s.end_sec) { player.currentTime = s.start_sec; } }; player._loopH && player.removeEventListener('timeupdate', player._loopH); player._loopH = stop; player.addEventListener('timeupdate', stop); } } }),
        btn('✂ Split', { cls: 'sm', onClick: async () => { const at = (s.start_sec + s.end_sec) / 2; await API.post('/segments/' + s.id + '/split', { at }); toast('Split', 'ok'); reload(); } }),
        btn(s.usable ? '🚫 Mark unusable' : '✓ Mark good', { cls: 'sm', onClick: async () => { await API.patch('/segments/' + s.id, { usable: !s.usable }); reload(); } }),
        btn('🗑', { cls: 'sm danger', onClick: async () => { await API.del('/segments/' + s.id); reload(); } }),
      ]),
    ]);
  }

  // ===================== VIDEO COMPOSER (§13) =====================
  PAGES.composer = async function (view) {
    const stories = await API.get('/stories?limit=100');
    clear(view);
    view.append(pageHead('Video Studio', 'Assemble a single story into a 9:16 video. Footage auto-fills the narration.'));
    if (!stories.length) { view.append(empty('📚', 'No stories', 'Discover or import stories first.')); return; }

    let storyId = stories[0].id;
    const leftPick = el('div.panel', field('Story', select(stories.map((s) => ({ id: s.id, label: s.title.slice(0, 60) })), { value: storyId, onChange: (e) => storyId = e.target.value })));
    const stage = el('div.preview-stage', empty('🎬', 'No preview yet', 'Choose settings and generate.'));
    const rightInfo = el('div.panel', el('div.muted', 'Segment plan & export appear here after generating.'));

    const m = meta();
    const st = { durationSeconds: 60, hookStyle: 'conflict', voice: m.voices && m.voices[0] && m.voices[0].name, captionStyle: 'bold', narrationStyle: 'Calm storyteller', backgroundCategory: 'Minecraft parkour', speed: 1, dramaLevel: 3, safeMode: false };
    let currentVideoId = null;

    const settings = el('div.panel', [
      el('div.section-title', '⚙ Settings'),
      el('div.col', [
        field('Duration', select(m.scriptDurations.map((d) => ({ id: d, label: d + 's' })), { value: st.durationSeconds, onChange: (e) => st.durationSeconds = +e.target.value })),
        field('Hook style', select(m.hookStyles, { value: st.hookStyle, onChange: (e) => st.hookStyle = e.target.value })),
        field('Voice', select((m.voices || []).map((v) => v.name), { value: st.voice, onChange: (e) => st.voice = e.target.value })),
        field('Caption style', select(m.captionStyles, { value: st.captionStyle, onChange: (e) => st.captionStyle = e.target.value })),
        field('Background type', select(m.backgroundTypes, { value: st.backgroundCategory, onChange: (e) => st.backgroundCategory = e.target.value })),
        checkbox('Safe mode (censor profanity)', st.safeMode, (v) => st.safeMode = v),
      ]),
      btn('✦ Generate Preview', { cls: 'primary block mt', onClick: generate }),
    ]);

    async function generate(ev) {
      ev.target.disabled = true; clear(stage); stage.append(UI.spinner('Generating preview…'));
      try {
        const bundle = await API.post('/videos', { storyId, ...st });
        currentVideoId = bundle.video.id;
        renderPreview(bundle);
      } catch (e) { clear(stage); stage.append(empty('⚠️', 'Generation failed', e.message)); }
      finally { ev.target.disabled = false; }
    }
    function renderPreview(bundle) {
      clear(stage);
      stage.append(el('video', { src: bundle.video.preview_url, controls: true, autoplay: true, loop: true }));
      clear(rightInfo);
      rightInfo.append(
        el('div.section-title', '🎞 Scene list'),
        el('div.col', bundle.segmentTimestamps.map((sg, i) => el('div.spread', { style: { padding: '6px 0', borderBottom: '1px solid var(--border)' } }, [el('span.tiny', (i + 1) + '. ' + sg.name), el('span.tiny.muted', fmtDuration(sg.duration))]))),
        el('div.section-title.mt', '🔊 Audio'),
        el('div.tiny.muted', 'Voice: ' + bundle.narration.voice + ' · ' + fmtDuration(bundle.narration.duration)),
        el('div.section-title.mt', '📤 Export'),
        el('div.btn-group', [
          btn('🎲 Variation', { cls: 'sm', onClick: () => makeVariation(bundle.video.id) }),
          btn('✅ Send to Review', { cls: 'sm', onClick: () => App.go('review') }),
          btn('⬇ Render & Export', { cls: 'sm primary', onClick: async (e2) => { e2.target.disabled = true; toast('Rendering…'); try { const r = await API.post('/videos/' + bundle.video.id + '/render', { preset: 'tiktok' }); toast('Exported!', 'ok'); App.go('exports'); } catch (er) { toast(er.message, 'err'); e2.target.disabled = false; } } }),
        ]),
      );
    }
    async function makeVariation(id) {
      clear(stage); stage.append(UI.spinner('Creating a different variation…'));
      try { const b = await API.post('/videos/' + id + '/variation', { option: 'Completely new variation' }); renderPreview(b); toast('New variation ready', 'ok'); }
      catch (e) { clear(stage); stage.append(empty('⚠️', 'Variation failed', e.message)); }
    }

    view.append(el('div.composer', [el('div.col', [leftPick, settings]), el('div.col', [stage]), el('div.col', [rightInfo])]));
  };

  // ===================== BATCH STUDIO (§17) =====================
  PAGES.batch = async function (view) {
    const m = meta();
    clear(view);
    const preIds = JSON.parse(sessionStorage.getItem('batchStoryIds') || 'null');
    sessionStorage.removeItem('batchStoryIds');
    const cfg = { count: 10, category: '', duration: 60, background: 'Minecraft parkour', captionStyle: 'bold', source: 'reddit', communities: ['AmItheAsshole'], discover: false };

    const listBox = el('div.col.mt');
    async function loadBatches() {
      const batches = await API.get('/batch');
      clear(listBox);
      if (!batches.length) { listBox.append(empty('⚙️', 'No batches yet', 'Configure one above and run it.')); return; }
      batches.forEach((b) => listBox.append(batchRow(b)));
    }

    view.append(
      pageHead('Batch Factory', 'Find/pick N stories → script → narration → footage → captions → preview. Stops before export for your approval.', []),
      el('div.panel', [
        el('div.form-grid', [
          field('Number of stories', input({ type: 'number', value: cfg.count, min: '1', max: '50', onInput: (e) => cfg.count = +e.target.value })),
          field('Category', select([{ id: '', label: 'Any' }].concat(m.categories), { value: cfg.category, onChange: (e) => cfg.category = e.target.value })),
          field('Duration', select(m.scriptDurations.map((d) => ({ id: d, label: d + 's' })), { value: cfg.duration, onChange: (e) => cfg.duration = +e.target.value })),
          field('Background', select(m.backgroundTypes, { value: cfg.background, onChange: (e) => cfg.background = e.target.value })),
          field('Caption style', select(m.captionStyles, { value: cfg.captionStyle, onChange: (e) => cfg.captionStyle = e.target.value })),
        ]),
        el('div.mt', checkbox('Discover fresh stories first (otherwise pick best from library)', cfg.discover, (v) => cfg.discover = v)),
        preIds ? el('div.mt', pill(preIds.length + ' stories selected from Discovery will be used', 'accent')) : null,
        el('div.btn-group.mt', [
          btn('▶ Create & Run Batch', { cls: 'primary', onClick: createRun }),
        ]),
      ]),
      el('h3.mt', 'Batches'), listBox,
    );

    async function createRun(ev) {
      ev.target.disabled = true;
      try {
        const payload = Object.assign({}, cfg, preIds ? { storyIds: preIds } : {});
        const b = await API.post('/batch', payload);
        await API.post('/batch/' + b.id + '/run', {});
        toast('Batch started', 'ok');
        loadBatches();
        watchBatch(b.id);
      } catch (e) { toast(e.message, 'err'); }
      finally { ev.target.disabled = false; }
    }

    function batchRow(b) {
      const prog = el('div.progress', el('div.fill', { style: { width: (b.total ? Math.round((b.completed / b.total) * 100) : 0) + '%' } }));
      return el('div.card', { 'data-batch': b.id }, [
        el('div.spread', [el('strong', b.name), pill(b.status, b.status === 'Ready for review' ? 'ok' : (b.status === 'Failed' ? 'err' : 'info'))]),
        el('div.tiny.muted.mt', b.total + ' items · ' + b.completed + ' ready · ' + b.failed + ' failed'),
        el('div.mt', prog),
        el('div.btn-group.mt', [
          btn('Open', { cls: 'sm', onClick: () => batchDetail(b.id) }),
          btn('⏸ Pause', { cls: 'sm ghost', onClick: () => API.post('/batch/' + b.id + '/pause', {}).then(loadBatches) }),
          btn('▶ Resume', { cls: 'sm ghost', onClick: () => API.post('/batch/' + b.id + '/resume', {}).then(() => watchBatch(b.id)) }),
          ['Ready for review', 'Cancelled', 'Failed'].includes(b.status) ? null
            : btn('■ Stop', { cls: 'sm danger', onClick: () => { if (confirm('Stop this batch? Unfinished items will be cancelled.')) API.post('/batch/' + b.id + '/stop', {}).then(loadBatches); } }),
          btn('✅ Review', { cls: 'sm', onClick: () => App.go('review') }),
        ].filter(Boolean)),
      ]);
    }
    function watchBatch(id) { const h = App.on('progress', (p) => { if (p.channel === 'batch' && p.batchId === id) loadBatches(); }); setTimeout(() => App.off('progress', h), 600000); }

    async function batchDetail(id) {
      const b = await API.get('/batch/' + id);
      modal('⚙️ ' + b.name, [
        el('div.col', b.items.map((it) => el('div.spread', { style: { padding: '8px 0', borderBottom: '1px solid var(--border)' } }, [
          el('div', [el('div', '#' + (it.position + 1) + ' ' + (it.story_id || '')), el('tiny.muted', it.stage_detail || '')]),
          el('div.row.tight', [
            pill(it.status, it.status === 'Ready for review' ? 'ok' : (it.status === 'Failed' ? 'err' : 'info')),
            it.status === 'Failed' ? btn('Retry', { cls: 'sm', onClick: () => API.post('/batch/items/' + it.id + '/retry', {}) }) : null,
            it.video_id ? btn('Review', { cls: 'sm', onClick: () => { App.go('review'); } }) : null,
          ]),
        ]))),
      ], { width: '700px' });
    }

    loadBatches();
    if (preIds) toast(preIds.length + ' stories ready for batch', 'ok');
  };

  // ===================== REVIEW QUEUE (§18) =====================
  PAGES.review = async function (view) {
    clear(view);
    const grid = el('div.grid.cards.mt');
    const cards = [];           // { el, approve, reject, edit } per video, for keyboard nav
    let cur = -1;
    function focusCard(i) {
      if (!cards.length) return;
      cur = Math.max(0, Math.min(cards.length - 1, i));
      cards.forEach((c, idx) => c.el.classList.toggle('kb-focus', idx === cur));
      cards[cur].el.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }
    async function load() {
      clear(grid); grid.append(UI.spinner());
      const q = await API.get('/review/queue');
      clear(grid); cards.length = 0; cur = -1;
      if (!q.length) { grid.append(empty('✅', 'Nothing to review', 'Generate videos in the Composer or Batch Studio.')); return; }
      q.forEach((b) => {
        const card = reviewCard(b, load);
        grid.append(card);
        const clickByText = (t) => { const btnEl = [...card.querySelectorAll('button')].find((x) => x.textContent.includes(t)); if (btnEl) btnEl.click(); };
        cards.push({ el: card, approve: () => clickByText('Approve'), reject: () => clickByText('Reject'), edit: () => clickByText('Edit Script') });
      });
      focusCard(0);
    }
    // Keyboard shortcuts (spec §18): Space play/pause · A approve · R reject · E edit · N/P next/prev.
    function onKey(e) {
      if (!grid.isConnected) { document.removeEventListener('keydown', onKey); return; } // auto-cleanup on navigation
      if (/^(input|textarea|select)$/i.test((document.activeElement && document.activeElement.tagName) || '')) return;
      const k = e.key.toLowerCase();
      if (k === 'n' || e.key === 'ArrowDown') { focusCard(cur + 1); e.preventDefault(); }
      else if (k === 'p' || e.key === 'ArrowUp') { focusCard(cur - 1); e.preventDefault(); }
      else if (cur >= 0 && cards[cur]) {
        if (e.key === ' ') { const vid = cards[cur].el.querySelector('video'); if (vid) { vid.paused ? vid.play() : vid.pause(); } e.preventDefault(); }
        else if (k === 'a') { cards[cur].approve(); e.preventDefault(); }
        else if (k === 'r') { cards[cur].reject(); e.preventDefault(); }
        else if (k === 'e') { cards[cur].edit(); e.preventDefault(); }
      }
    }
    document.addEventListener('keydown', onKey);
    view.append(
      pageHead('✅ Review Queue', 'Approve each video before it is exported. Nothing is published automatically.'),
      el('div.small.muted.mb', 'Shortcuts: N/P or ↑/↓ select · Space play/pause · A approve · R reject · E edit script'),
      grid,
    );
    load();
  };

  function reviewCard(b, reload) {
    const v = b.video;
    const dupWarn = v.duplicate_score > 0.6 ? pill('Possible duplicate ' + Math.round(v.duplicate_score * 100) + '%', 'warn') : null;
    return el('div.card', [
      v.preview_url ? el('video.thumb.v', { src: v.preview_url, controls: true, style: { width: '100%', maxHeight: '360px', aspectRatio: '9/16' } }) : el('div.thumb.v', empty('🎬', 'No preview')),
      el('div.spread.mt', [el('strong', v.title), pill(v.status, v.status === 'failed' ? 'err' : 'info')]),
      el('div.row.tight.mt', [tag(v.caption_style), tag(v.voice), pill(fmtDuration(v.duration), 'accent'), dupWarn, ...warnPills(v.warnings)].filter(Boolean)),
      b.script ? el('div.preview.mt', { style: { maxHeight: '70px', overflow: 'auto' } }, b.script.full_text) : null,
      el('div.tiny.muted.mt', '🎞 ' + (b.backgrounds || []).map((x) => x.original_name).join(', ')),
      v.error ? pill(v.error, 'err') : null,
      el('div.card-actions.mt', [
        btn('✓ Approve & Export', { cls: 'sm ok', onClick: async (e) => { e.target.disabled = true; toast('Rendering…'); try { await API.post('/review/' + v.id + '/approve', { preset: 'tiktok' }); toast('Exported!', 'ok'); reload(); } catch (er) { toast(er.message, 'err'); e.target.disabled = false; } } }),
        btn('↻ Regenerate', { cls: 'sm', onClick: () => regenMenu(v.id, reload) }),
        btn('✎ Edit Script', { cls: 'sm ghost', onClick: () => editScript(b, reload) }),
        btn('🎮 Background', { cls: 'sm ghost', onClick: () => regen(v.id, 'background', {}, reload) }),
        btn('🎙 Voice', { cls: 'sm ghost', onClick: () => regen(v.id, 'voice', {}, reload) }),
        btn('💬 Captions', { cls: 'sm ghost', onClick: () => regen(v.id, 'captions', {}, reload) }),
        btn('🚫 Reject', { cls: 'sm danger', onClick: async () => { await API.post('/review/' + v.id + '/reject', {}); toast('Rejected'); reload(); } }),
      ]),
    ]);
  }
  function regenMenu(id, reload) {
    modal('↻ Regenerate component', el('div.btn-group', [
      btn('New script angle', { onClick: () => { close(); regen(id, 'script', { modifier: 'another_angle' }, reload); } }),
      btn('Different voice', { onClick: () => { close(); regen(id, 'voice', {}, reload); } }),
      btn('Different captions', { onClick: () => { close(); regen(id, 'captions', {}, reload); } }),
      btn('Different background', { onClick: () => { close(); regen(id, 'background', {}, reload); } }),
    ]));
    function close() { UI.clear(document.getElementById('modalRoot')); }
  }
  async function regen(id, component, opts, reload) {
    toast('Regenerating ' + component + '…');
    try { await API.post('/review/' + id + '/regenerate', Object.assign({ component }, opts)); toast(component + ' regenerated', 'ok'); reload(); }
    catch (e) { toast(e.message, 'err'); }
  }
  function editScript(b, reload) {
    let txt = b.script ? b.script.full_text : '';
    const m = modal('✎ Edit Script', [
      textarea({ value: txt, rows: 10, onInput: (e) => txt = e.target.value }),
      el('div.row.mt', { style: { justifyContent: 'flex-end' } }, [btn('Save & Rebuild', { cls: 'primary', onClick: async () => { m.close(); toast('Rebuilding…'); try { await API.post('/review/' + b.video.id + '/edit-script', { fullText: txt }); toast('Rebuilt', 'ok'); reload(); } catch (e) { toast(e.message, 'err'); } } })]),
    ], { width: '700px' });
  }

  // ===================== EXPORTS (§19) =====================
  PAGES.exports = async function (view) {
    const list = await API.get('/exports');
    clear(view);
    view.append(pageHead('📤 Exports', 'Finished, approved videos ready to download and publish manually.'));
    if (!list.length) { view.append(empty('📤', 'No exports yet', 'Approve videos in the Review Queue.')); return; }
    view.append(el('div.grid.cards', list.map((e) => el('div.card', [
      e.render_url ? el('video.thumb.v', { src: e.render_url, controls: true, style: { width: '100%', maxHeight: '340px', aspectRatio: '9/16' } }) : el('div.thumb.v'),
      el('div.spread.mt', [el('strong', e.title || 'Video'), pill(e.platform, 'accent')]),
      el('div.tiny.muted.mt', e.width + '×' + e.height + ' · ' + fmtDuration(e.duration) + ' · ' + fmtBytes(e.size_bytes) + ' · ' + ago(e.created_at)),
      el('div.card-actions.mt', [el('a.btn.sm.primary', { href: '/api/exports/' + e.id + '/download' }, '⬇ Download'), el('a.btn.sm.ghost', { href: e.render_url, target: '_blank' }, '▶ Open')]),
    ]))));
  };

  // ===================== PREFERENCES (§4) =====================
  PAGES.preferences = async function (view) {
    const m = meta();
    const p = await API.get('/preferences');
    clear(view);
    const get = (k, d) => (p[k] != null ? p[k] : d);
    const draft = Object.assign({}, p);
    function catChips(key) {
      return el('div.row.tight', m.categories.map((c) => {
        const on = (draft[key] || []).includes(c);
        const chip = el('div.chip' + (on ? '.on' : ''), { onclick: () => { const arr = draft[key] = draft[key] || []; const i = arr.indexOf(c); if (i >= 0) arr.splice(i, 1); else arr.push(c); chip.classList.toggle('on'); } }, c);
        return chip;
      }));
    }
    view.append(
      pageHead('🎛️ Preferences', 'Applied to every discovery and generation request.', [btn('💾 Save Preferences', { cls: 'primary', onClick: save })]),
      el('div.grid.two', [
        el('div.panel', [el('div.section-title', '✅ Preferred categories'), catChips('preferredCategories')]),
        el('div.panel', [el('div.section-title', '🚫 Blocked categories'), catChips('blockedCategories')]),
      ]),
      el('div.panel.mt', [el('div.section-title', '🎬 Generation defaults'), el('div.form-grid', [
        field('Target video length', select(m.scriptDurations.map((d) => ({ id: d, label: d + 's' })), { value: get('targetVideoLength', 60), onChange: (e) => draft.targetVideoLength = +e.target.value })),
        field('Preferred voice', select((m.voices || []).map((v) => v.name), { value: get('preferredVoice'), onChange: (e) => draft.preferredVoice = e.target.value })),
        field('Preferred background', select(m.backgroundTypes, { value: get('preferredBackground'), onChange: (e) => draft.preferredBackground = e.target.value })),
        field('Preferred caption style', select(m.captionStyles, { value: get('preferredCaptionStyle'), onChange: (e) => draft.preferredCaptionStyle = e.target.value })),
        field('Desired emotion', select(['any', 'shocking', 'satisfying', 'emotional', 'funny', 'suspenseful'], { value: get('desiredEmotion', 'any'), onChange: (e) => draft.desiredEmotion = e.target.value })),
        field('Story ending preference', select(m.endingPreferences, { value: get('endingPreference'), onChange: (e) => draft.endingPreference = e.target.value })),
        field('Min engagement score', input({ type: 'number', value: get('minEngagement', 0), min: '0', max: '100', onInput: (e) => draft.minEngagement = +e.target.value })),
        field('Profanity', select([{ id: 'allow', label: 'Allow' }, { id: 'censor', label: 'Censor' }], { value: get('profanity', 'allow'), onChange: (e) => draft.profanity = e.target.value })),
        field('Violence sensitivity', select(['low', 'medium', 'high'], { value: get('violenceSensitivity', 'medium'), onChange: (e) => draft.violenceSensitivity = e.target.value })),
        field('Repetition tolerance', select(['low', 'medium', 'high'], { value: get('repetitionTolerance', 'low'), onChange: (e) => draft.repetitionTolerance = e.target.value })),
      ]),
      el('div.mt', checkbox('Adult-topic filter (block sexual content)', get('adultTopicFilter', true), (v) => draft.adultTopicFilter = v)),
      ]),
    );
    async function save() { await API.put('/preferences', draft); App.prefs = draft; toast('Preferences saved', 'ok'); }
  };

  // ===================== SYSTEM STATUS (§26) =====================
  PAGES.system = async function (view) {
    clear(view);
    const grid = el('div.grid.stats.mt');
    async function load() {
      clear(grid); grid.append(UI.spinner());
      const s = await API.get('/system/status');
      clear(grid);
      const items = [['Database', s.database], ['FFmpeg', s.ffmpeg], ['FFprobe', s.ffprobe], ['TTS engine', s.tts], ['AI provider', s.aiProvider], ['Reddit', s.reddit], ['Storage', s.storage], ['Render worker', s.renderWorker], ['Background library', s.backgroundLibrary]];
      items.forEach(([name, st]) => {
        const cls = st.status === 'Ready' ? 'ok' : (st.status === 'Loading' ? 'loading' : (['Missing', 'Limited', 'Degraded'].includes(st.status) ? 'warn' : 'err'));
        grid.append(el('div.card', [el('div.spread', [el('strong', name), el('span.dot.' + cls)]), el('div.small.mt', pill(st.status, cls === 'loading' ? 'info' : cls)), el('div.tiny.muted.mt', st.detail || '')]));
      });
    }
    view.append(
      pageHead('System Health', 'Health of every subsystem.', [
        btn('🔄 Test All', { cls: 'primary', onClick: load }),
        btn('🔌 Reconnect', { onClick: () => API.post('/system/test', {}).then(load) }),
        btn('📜 Open Logs', { onClick: () => document.getElementById('logPanel').classList.remove('hidden') }),
        btn('♻ Resume Failed Jobs', { onClick: async () => { const r = await API.post('/system/resume-failed', {}); toast('Resumed ' + r.resumed + ' job(s)', 'ok'); } }),
      ]),
      grid,
    );
    load();
  };

  // ===================== COMMAND CENTER =====================
  const RUN_PRESETS = {
    '10 Test Videos': { count: 10, discover: true, communities: 'AmItheAsshole', duration: 60 },
    '100 Minecraft AITA Videos': { count: 100, category: 'AITA', background: 'Minecraft parkour', discover: true, communities: 'AmItheAsshole' },
    '100 Mixed Reddit & Quora': { count: 100, discover: true, communities: 'AmItheAsshole, tifu, ProRevenge' },
    '500 Mixed Gameplay Videos': { count: 500, discover: true, communities: 'AmItheAsshole, tifu, relationship_advice' },
    'Daily Production': { count: 50, discover: true, communities: 'AmItheAsshole, tifu' },
  };

  PAGES.command = async function (view) {
    const m = meta();
    clear(view);
    const defTpl = (m.templates || []).find((t) => t.isDefault) || (m.templates || [])[0] || {};
    const cfg = {
      count: 10, category: '', duration: 60, background: (m.gameplayCategories || [])[0] || 'Minecraft parkour',
      captionStyle: 'bold', templateId: (App.prefs && App.prefs.templateId) || defTpl.id,
      voice: (App.prefs && App.prefs.preferredVoice) || (m.voices && m.voices[0] && m.voices[0].name),
      discover: true, communities: 'AmItheAsshole', minScore: 60, stopForReview: true, workers: 1,
    };

    const runPanel = el('div.panel');
    function renderRun() {
      clear(runPanel);
      runPanel.append(
        el('div.spread', [el('div.section-title', '🚀 New Production Run'),
          select(['— Preset —'].concat(Object.keys(RUN_PRESETS)), { onChange: (e) => { const p = RUN_PRESETS[e.target.value]; if (p) { Object.assign(cfg, p); renderRun(); } } })]),
        el('div.form-grid', [
          field('Number of videos', input({ type: 'number', value: cfg.count, min: '1', max: '1000', onInput: (e) => cfg.count = +e.target.value })),
          field('Template', select((m.templates || []).map((t) => ({ id: t.id, label: t.name })), { value: cfg.templateId, onChange: (e) => cfg.templateId = e.target.value })),
          field('Category', select([{ id: '', label: 'Any' }].concat(m.categories), { value: cfg.category, onChange: (e) => cfg.category = e.target.value })),
          field('Target duration', select(m.scriptDurations.map((d) => ({ id: d, label: d + 's' })), { value: cfg.duration, onChange: (e) => cfg.duration = +e.target.value })),
          field('Gameplay', select(m.gameplayCategories || m.backgroundTypes, { value: cfg.background, onChange: (e) => cfg.background = e.target.value })),
          field('Voice', select((m.voices || []).map((v) => v.name), { value: cfg.voice, onChange: (e) => cfg.voice = e.target.value })),
          field('Min quality score', input({ type: 'number', value: cfg.minScore, min: '0', max: '100', onInput: (e) => cfg.minScore = +e.target.value })),
          field('Reddit communities', input({ value: cfg.communities, placeholder: 'AmItheAsshole, tifu…', onInput: (e) => cfg.communities = e.target.value })),
        ]),
        el('div.row.tight.mt', [
          toggle('Discover fresh stories', cfg.discover, (v) => cfg.discover = v),
          toggle('Stop for review', cfg.stopForReview, (v) => cfg.stopForReview = v),
        ]),
        collapse('Advanced', el('div.form-grid', [
          field('Worker count', input({ type: 'number', value: cfg.workers, min: '1', max: '8', onInput: (e) => cfg.workers = +e.target.value })),
          field('Caption preset', select(m.captionStyles, { value: cfg.captionStyle, onChange: (e) => cfg.captionStyle = e.target.value })),
        ])),
        el('div.btn-group.mt', [
          btn('▶ Start Run', { cls: 'primary', onClick: startRun }),
          btn('🧪 Dry Run', { onClick: () => modal('Dry Run — resolved config', el('pre', { style: { whiteSpace: 'pre-wrap' } }, JSON.stringify(buildBatchCfg(), null, 2)), { width: '560px' }) }),
          btn('💾 Save as Preset', { cls: 'ghost', onClick: () => { const name = prompt('Preset name'); if (name) { RUN_PRESETS[name] = { ...cfg }; toast('Preset saved (this session)', 'ok'); renderRun(); } } }),
        ]),
        el('div.tiny.muted.mt', cfg.workers > 1 ? 'Note: multi-worker rendering arrives in the persistent job system (Phase 5); runs currently process one video at a time.' : ''),
      );
    }
    function buildBatchCfg() {
      return {
        name: `Run ${new Date().toISOString().slice(0, 16).replace('T', ' ')}`,
        count: cfg.count, category: cfg.category || null, duration: cfg.duration, background: cfg.background,
        captionStyle: cfg.captionStyle, templateId: cfg.templateId, voice: cfg.voice,
        discover: cfg.discover, communities: cfg.communities.split(',').map((x) => x.trim()).filter(Boolean), source: 'reddit',
      };
    }
    async function startRun(ev) {
      ev.target.disabled = true;
      try {
        const b = await API.post('/batch', buildBatchCfg());
        await API.post('/batch/' + b.id + '/run', {});
        toast('Production run started', 'ok'); App.go('batch');
      } catch (e) { toast(e.message, 'err'); ev.target.disabled = false; }
    }
    renderRun();

    const statsBox = el('div.grid.mini.mt');
    const pipeBox = el('div.panel.mt');
    async function loadStats() {
      try {
        const d = await API.get('/dashboard');
        const p = d.pipeline || {}, r = d.resources || {}, t = d.throughput || {};
        clear(statsBox);
        [
          [p.discovered, 'Stories found'], [p.accepted, 'Accepted'], [p.rejected, 'Rejected'],
          [p.scriptsReady, 'Scripts ready'], [p.narrationsReady, 'Narrations'], [p.captionsReady, 'Captions'],
          [p.queued, 'Queued'], [p.rendering, 'Rendering'], [p.review, 'Waiting review'],
          [p.exported, 'Exported'], [p.failed, 'Failed'], [p.completedToday, 'Done today'],
          [t.measuredVideosPerHour || '—', 'Videos / hr (measured)'], [t.avgRenderSeconds ? t.avgRenderSeconds + 's' : '—', 'Avg render'],
          [r.ramUsedPct != null ? r.ramUsedPct + '%' : '—', 'RAM used'], [r.cpus || '—', 'CPU cores'],
          [r.activeWorkers, 'Active workers'], [r.storageFree || '—', 'Disk free'],
        ].forEach(([v, l]) => statsBox.append(ministat(v == null ? 0 : v, l)));

        clear(pipeBox);
        pipeBox.append(el('div.section-title', '🛠 Live pipeline'));
        const stages = [
          ['Discover', p.discovered, 'discovery'], ['Score', p.scored, 'library'], ['Script', p.scriptsReady, 'library'],
          ['Narrate', p.narrationsReady, 'review'], ['Captions', p.captionsReady, 'review'], ['Footage', '·', 'backgrounds'],
          ['Compose', p.queued, 'batch'], ['Render', p.rendering, 'jobs'], ['Validate', '·', 'review'],
          ['Review', p.review, 'review'], ['Export', p.exported, 'exports'],
        ];
        const strip = el('div.pipeline');
        stages.forEach(([name, n, target], i) => {
          const busy = (name === 'Render' && p.rendering > 0) || (name === 'Compose' && p.queued > 0);
          strip.append(el('div.pl-stage' + (busy ? '.busy' : ''), { onclick: () => App.go(target) }, [el('div.n', String(n)), el('div.s', name)]));
          if (i < stages.length - 1) strip.append(el('span.pl-arrow', '→'));
        });
        pipeBox.append(strip);
        if (t.note) pipeBox.append(el('div.tiny.muted.mt', t.note));
      } catch (e) { /* ignore */ }
    }
    loadStats();
    // Live refresh while this page is active (throttled).
    let last = 0;
    const h = App.on('activity', () => { const now = Date.now(); if (location.hash.startsWith('#/command') && now - last > 1500) { last = now; loadStats(); } });
    App.on('progress', () => { if (location.hash.startsWith('#/command')) loadStats(); });

    view.append(
      pageHead('Command Center', 'Configure a production run, then watch the live pipeline.', [btn('↻ Refresh', { cls: 'ghost', onClick: loadStats })]),
      runPanel, statsBox, pipeBox,
    );
  };
  PAGES.dashboard = PAGES.command; // alias for old links

  // ===================== TEMPLATES =====================
  PAGES.templates = async function (view) {
    clear(view);
    const grid = el('div.grid.cards.mt');
    const activeId = (App.prefs && App.prefs.templateId) || null;
    async function load() {
      clear(grid); grid.append(UI.spinner());
      const list = await API.get('/templates');
      clear(grid);
      list.forEach((t) => grid.append(templateCard(t, activeId, load)));
    }
    view.append(
      pageHead('Templates', 'Reusable video layouts. The default drives every new video. ★ = active default.', [
        btn('＋ New Template', { cls: 'primary', onClick: async () => { const name = prompt('Template name', 'My Template'); if (!name) return; const base = (await API.get('/templates')).find((x) => x.isDefault); const t = await API.post('/templates', { name, data: base }); toast('Created', 'ok'); editTemplate(t, load); } }),
      ]),
      grid,
    );
    load();
  };
  function templateCard(t, activeId, reload) {
    const isActive = (activeId && activeId === t.id) || (!activeId && t.isDefault);
    return el('div.card', [
      el('div.spread', [el('strong', t.name), isActive ? pill('Default ★', 'ok') : (t.builtin ? pill('Built-in', 'info') : pill('Custom', 'accent'))]),
      el('div.tiny.muted.mt', `Card ${t.topicCard?.minSeconds || '–'}–${t.topicCard?.maxSeconds || '–'}s · Author ${t.authorIntro?.enabled === false ? 'off' : 'on'} · Caption ${t.captions?.size || '–'}px · ${t.canvas?.width || 1080}×${t.canvas?.height || 1920} @${t.canvas?.fps || 30}fps`),
      el('div.row.tight.mt', [
        t.topicCard?.enabled !== false ? tag('Topic card') : null,
        t.authorIntro?.enabled !== false ? tag('Author intro') : null,
        t.captions?.enabled !== false ? tag('Captions') : null,
        (t.audio?.musicVolume ? null : tag('No music')),
      ].filter(Boolean)),
      el('div.card-actions.mt', [
        btn(isActive ? '★ Default' : 'Set Default', { cls: isActive ? 'sm ok' : 'sm', disabled: isActive, onClick: async () => { await API.put('/preferences', { ...App.prefs, templateId: t.id }); App.prefs = await API.get('/preferences'); toast('Default template set', 'ok'); reload(); } }),
        btn('✎ Edit', { cls: 'sm', onClick: () => editTemplate(t, reload) }),
        btn('⧉ Duplicate', { cls: 'sm ghost', onClick: async () => { await API.post('/templates/' + t.id + '/duplicate', {}); toast('Duplicated', 'ok'); reload(); } }),
        t.builtin ? null : btn('🗑', { cls: 'sm danger', onClick: () => UI.confirmModal('Delete template', `Delete "${t.name}"?`, async () => { await API.del('/templates/' + t.id); toast('Deleted'); reload(); }, 'Delete') }),
      ].filter(Boolean)),
    ]);
  }
  function editTemplate(t, reload) {
    const d = JSON.parse(JSON.stringify(t));
    d.topicCard = d.topicCard || {}; d.authorIntro = d.authorIntro || {}; d.captions = d.captions || {}; d.audio = d.audio || {};
    const m = modal('✎ ' + t.name, [
      el('div.form-grid', [
        field('Name', input({ value: d.name, onInput: (e) => d.name = e.target.value })),
        field('Topic card min (s)', input({ type: 'number', step: '0.1', value: d.topicCard.minSeconds, onInput: (e) => d.topicCard.minSeconds = +e.target.value })),
        field('Topic card max (s)', input({ type: 'number', step: '0.1', value: d.topicCard.maxSeconds, onInput: (e) => d.topicCard.maxSeconds = +e.target.value })),
        field('Author outline', input({ type: 'number', value: d.authorIntro.outline, onInput: (e) => d.authorIntro.outline = +e.target.value })),
        field('Caption size', input({ type: 'number', value: d.captions.size, onInput: (e) => d.captions.size = +e.target.value })),
        field('Caption words/cue', input({ type: 'number', value: d.captions.maxWords, onInput: (e) => d.captions.maxWords = +e.target.value })),
        field('Caption margin (px from bottom)', input({ type: 'number', value: d.captions.marginV, onInput: (e) => d.captions.marginV = +e.target.value })),
      ]),
      el('div.row.tight.mt', [
        toggle('Topic card', d.topicCard.enabled !== false, (v) => d.topicCard.enabled = v),
        toggle('Author intro', d.authorIntro.enabled !== false, (v) => d.authorIntro.enabled = v),
        toggle('Background music', !!d.audio.musicVolume, (v) => d.audio.musicVolume = v ? 0.12 : 0),
      ]),
      el('div.row.mt', { style: { justifyContent: 'flex-end' } }, [
        btn('Cancel', { cls: 'ghost', onClick: () => m.close() }),
        btn('Save', { cls: 'primary', onClick: async () => { await API.put('/templates/' + t.id, d); m.close(); toast('Saved', 'ok'); reload && reload(); } }),
      ]),
    ], { width: '680px' });
  }

  // ===================== ACCOUNTS =====================
  PAGES.accounts = async function (view) {
    clear(view);
    const [accts, sys] = await Promise.all([API.get('/accounts').catch(() => []), API.get('/system/status').catch(() => ({}))]);
    const reddit = accts.find((a) => a.platform === 'reddit');
    const quora = accts.find((a) => a.platform === 'quora');
    const sysReddit = sys.reddit || {};
    const creds = { clientId: '', clientSecret: '' };
    const rStatusMap = { connected: 'Connected', configured: 'Configured (untested)', error: 'Error' };
    const redditStatus = reddit ? (rStatusMap[reddit.status] || reddit.status) : (sysReddit.status || 'Limited');
    const redditCls = /connected/i.test(redditStatus) ? 'ok' : (/error/i.test(redditStatus) ? 'err' : 'warn');
    view.append(
      pageHead('Accounts', 'Connect Reddit and Quora. Secrets are encrypted at rest and never logged.'),
      el('div.grid.two', [
        el('div.panel', [
          el('div.spread', [el('div.section-title', '🟠 Reddit'), pill(redditStatus, redditCls)]),
          el('div.small.muted', (reddit && reddit.lastError) || sysReddit.detail || ''),
          reddit && reddit.hasSecret ? el('div.tiny.muted.mt', '🔒 Credentials saved (encrypted). ' + (reddit.lastOkAt ? 'Last verified ' + ago(reddit.lastOkAt) : 'Not yet verified.')) : null,
          el('div.form-grid.mt', [
            field('Client ID', input({ placeholder: reddit && reddit.hasSecret ? '•••••• (saved — re-enter to change)' : 'from reddit.com/prefs/apps', onInput: (e) => creds.clientId = e.target.value })),
            field('Client secret', input({ type: 'password', placeholder: reddit && reddit.hasSecret ? '•••••• (saved)' : 'stored encrypted', onInput: (e) => creds.clientSecret = e.target.value })),
          ]),
          el('div.btn-group.mt', [
            btn('Save & Test', { cls: 'primary', onClick: async (e) => { if (!creds.clientId || !creds.clientSecret) return toast('Enter client ID and secret', 'warn'); e.target.disabled = true; try { await API.post('/accounts/reddit/connect', creds); const r = await API.post('/accounts/reddit/test', {}); toast('Reddit: ' + r.detail, r.ok ? 'ok' : 'warn'); App.go('accounts'); } catch (er) { toast(er.message, 'err'); e.target.disabled = false; } } }),
            btn('Test', { onClick: async () => { const r = await API.post('/accounts/reddit/test', {}); toast('Reddit: ' + r.detail, r.ok ? 'ok' : 'warn'); App.go('accounts'); } }),
            reddit && reddit.hasSecret ? btn('Disconnect', { cls: 'danger', onClick: async () => { await API.post('/accounts/reddit/disconnect', {}); toast('Disconnected'); App.go('accounts'); } }) : null,
          ].filter(Boolean)),
          el('div.tiny.muted.mt', 'Create a "script" app at reddit.com/prefs/apps. Anonymous mode works but is rate‑limited. Env vars REDDIT_CLIENT_ID/SECRET take precedence if set.'),
        ]),
        el('div.panel', [
          el('div.spread', [el('div.section-title', '🔵 Quora'), pill(quora ? 'Connected' : 'Manual import', quora ? 'ok' : 'info')]),
          el('div.small.muted', 'Quora has no open official story API. Manual import always works:'),
          el('ul.small.muted', [el('li', 'Paste a Quora question + answer text'), el('li', 'Paste a Quora question URL'), el('li', 'Import a .txt / .csv export')]),
          el('div.tiny.muted.mt', 'Browser‑assisted/cookie session import (where permitted) is planned; StoryVault never collects passwords or bypasses CAPTCHAs.'),
          el('div.btn-group.mt', [
            btn('Enable manual import', { cls: 'primary', onClick: async () => { await API.post('/accounts/quora/connect', {}); toast('Quora manual import enabled', 'ok'); App.go('accounts'); } }),
            btn('Open Quora Import', { onClick: () => App.go('discovery') }),
          ]),
        ]),
      ]),
    );
  };

  // ===================== JOB MONITOR =====================
  PAGES.jobs = async function (view) {
    clear(view);
    const wrap = el('div.col.mt');
    async function load() {
      clear(wrap); wrap.append(UI.spinner());
      const [batches, vids] = await Promise.all([API.get('/batch'), API.get('/videos')]);
      clear(wrap);
      const byStatus = {};
      vids.forEach((v) => { byStatus[v.status] = (byStatus[v.status] || 0) + 1; });
      wrap.append(el('div.grid.mini', Object.entries(byStatus).map(([k, n]) => ministat(n, k))));
      wrap.append(el('div.section-title.mt', '⚙ Batches'));
      if (!batches.length) wrap.append(empty('⚙️', 'No batches', 'Start a run from the Command Center.'));
      batches.forEach((b) => {
        const pct = b.total ? Math.round((b.completed / b.total) * 100) : 0;
        wrap.append(el('div.card', [
          el('div.spread', [el('strong', b.name), pill(b.status, b.status === 'Ready for review' ? 'ok' : (b.status === 'Failed' ? 'err' : 'info'))]),
          el('div.tiny.muted.mt', `${b.total} items · ${b.completed} ready · ${b.failed} failed · ${pct}%`),
          el('div.progress.mt', el('div.fill', { style: { width: pct + '%' } })),
          el('div.btn-group.mt', [
            btn('Open', { cls: 'sm', onClick: () => App.go('batch') }),
            btn('Resume', { cls: 'sm ghost', onClick: () => API.post('/batch/' + b.id + '/resume', {}).then(load) }),
            btn('Review', { cls: 'sm', onClick: () => App.go('review') }),
          ]),
        ]));
      });
    }
    view.append(pageHead('Job Monitor', 'Batches, video states and render activity.', [btn('↻ Refresh', { cls: 'ghost', onClick: load })]), wrap);
    load();
  };

  // ===================== LOGS =====================
  PAGES.logs = async function (view) {
    clear(view);
    const filters = { level: '', q: '' };
    const listBox = el('div.panel.mt', { style: { fontFamily: 'ui-monospace, Menlo, Consolas, monospace', fontSize: '12px', maxHeight: '70vh', overflow: 'auto' } });
    async function load() {
      clear(listBox); listBox.append(UI.spinner());
      const rows = await API.get('/system/logs?limit=400');
      clear(listBox);
      const filtered = rows.filter((r) => (!filters.level || r.level === filters.level) && (!filters.q || (r.message || '').toLowerCase().includes(filters.q.toLowerCase())));
      if (!filtered.length) { listBox.append(empty('📜', 'No matching log lines')); return; }
      filtered.forEach((r) => listBox.append(el('div.log-line ' + (r.level || 'info'), [el('span.tag', '[' + (r.tag || '·') + '] '), el('span.tiny.muted', (r.created_at || '').slice(11, 19) + ' '), document.createTextNode(r.message || '')])));
    }
    view.append(
      pageHead('Logs', 'Searchable activity log.', [btn('↻ Refresh', { cls: 'ghost', onClick: load })]),
      el('div.panel', el('div.form-grid', [
        field('Severity', select([{ id: '', label: 'All' }, 'info', 'success', 'warn', 'error'], { onChange: (e) => { filters.level = e.target.value; load(); } })),
        field('Search', input({ placeholder: 'message text…', onInput: (e) => { filters.q = e.target.value; clearTimeout(filters._t); filters._t = setTimeout(load, 250); } })),
      ])),
      listBox,
    );
    load();
  };

})();
