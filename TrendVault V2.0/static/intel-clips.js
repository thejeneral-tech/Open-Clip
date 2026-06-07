"use strict";
// Topic -> Clips workflow. Reuses the globals defined in app.js: $, $$, api,
// post, toast, escapeHtml, fmtNum, fmtTime.
(function () {
  const CLIP = {
    candidates: [], viewCands: [], runId: null, runPoll: null, currentPresetId: null,
    presets: [], lastClipsSig: "", busy: false,
    searchJobId: null, activeJobId: null, searchPoll: null, searchActive: false,
    searchAppend: false, resumeJob: null,
  };

  // form id <-> config key
  const F = {
    source_type: "cSourceType", topic: "cTopic", channel_url: "cChannel", video_url: "cVideo",
    keywords: "cKeywords", excluded_keywords: "cExcluded", num_videos: "cNumVideos",
    num_clips: "cNumClips", min_len: "cMinLen", max_len: "cMaxLen", clip_style: "cClipStyle",
    caption_style: "cCaptionStyle", framing: "cFraming", aspect_ratio: "cAspect",
    sort_method: "cSort", recency: "cRecency", min_views: "cMinViews",
    search_scope: "cSearchScope", result_limit: "cResultsCount", video_type: "cVideoType",
    max_duration_min: "cMaxDurationMin", language: "cLanguage",
  };
  const INTS = ["num_videos", "num_clips", "min_len", "max_len", "min_views",
    "result_limit", "max_duration_min"];

  function readCfg() {
    const c = {};
    for (const k in F) { const el = $("#" + F[k]); if (el) c[k] = el.value; }
    INTS.forEach((k) => (c[k] = parseInt(c[k], 10) || 0));
    const a = $("#cAutoSelect"); c.auto_select = a ? a.checked : true;
    return c;
  }
  function writeCfg(c) {
    for (const k in F) { const el = $("#" + F[k]); if (el && c[k] != null) el.value = c[k]; }
    const a = $("#cAutoSelect"); if (a && c.auto_select != null) a.checked = !!c.auto_select;
    updateSource();
    updateAutoBtn();
  }
  function syncScope() {
    const map = { topic: "youtube", channel: "channel", video: "video" };
    const st = $("#cSourceType").value, sc = $("#cSearchScope");
    if (sc && st !== "preset" && map[st]) sc.value = map[st];
  }
  function syncSourceFromScope() {
    const sc = $("#cSearchScope").value, cur = $("#cSourceType").value;
    if (sc === "channel" && cur !== "channel") $("#cSourceType").value = "channel";
    else if (sc === "video" && cur !== "video") $("#cSourceType").value = "video";
    else if ((sc === "youtube" || sc === "youtube_web") && (cur === "channel" || cur === "video"))
      $("#cSourceType").value = "topic";
    updateSource();
  }

  // ---- source type --------------------------------------------------
  function updateSource() {
    const st = $("#cSourceType").value;
    $$(".src-input").forEach((d) => (d.hidden = d.dataset.src !== st));
    $("#refineRow").hidden = st !== "topic";
  }
  function updateAutoBtn() {
    const n = parseInt($("#cNumClips").value, 10) || 10;
    $("#btnAutoCreate").textContent = `⚡ AUTO CREATE ${n} CLIP${n === 1 ? "" : "S"}`;
  }

  // ---- topic refinement ---------------------------------------------
  async function refine() {
    const topic = $("#cTopic").value.trim();
    if (!topic) { toast("Enter a topic first.", true); return; }
    const box = $("#suggestions");
    box.innerHTML = '<span class="muted">Suggesting…</span>';
    try {
      const { suggestions } = await post("/api/intel/refine", { topic });
      renderSuggestions(suggestions || []);
    } catch (e) { box.innerHTML = ""; toast(e.message, true); }
  }
  function renderSuggestions(list) {
    const box = $("#suggestions");
    if (!list.length) { box.innerHTML = '<span class="muted">No suggestions.</span>'; return; }
    box.innerHTML = list.map((s) => `<span class="chip">${escapeHtml(s)}</span>`).join("");
    $$("#suggestions .chip").forEach((ch) => (ch.onclick = () => {
      $("#cTopic").value = ch.textContent;
      ch.classList.add("picked");
    }));
  }

  // ---- presets ------------------------------------------------------
  async function loadPresets() {
    try { CLIP.presets = await api("/api/intel/presets"); } catch (_) { CLIP.presets = []; }
    const pick = $("#cPresetPick");
    pick.innerHTML = '<option value="">— saved presets —</option>' +
      CLIP.presets.map((p) => `<option value="${p.id}">${escapeHtml(p.name)}</option>`).join("");
    if (CLIP.currentPresetId) pick.value = String(CLIP.currentPresetId);
  }
  function selectedPreset() {
    return CLIP.presets.find((p) => String(p.id) === String(CLIP.currentPresetId));
  }
  function loadPresetIntoForm(p) {
    if (!p) return;
    CLIP.currentPresetId = p.id;
    writeCfg(p.config || {});
    $("#cPresetName").value = p.name || "";
    $("#cPresetPick").value = String(p.id);
    toast(`Loaded preset “${p.name}”.`);
  }
  async function presetCreate() {
    const name = ($("#cPresetName").value || "").trim();
    if (!name) { toast("Give the preset a name first.", true); return; }
    try {
      const p = await post("/api/intel/presets", { name, config: readCfg() });
      CLIP.currentPresetId = p.id;
      await loadPresets();
      toast(`Created preset “${p.name}”.`);
    } catch (e) { toast(e.message, true); }
  }
  async function presetUpdate() {
    if (!CLIP.currentPresetId) { toast("Select a preset to update (or use Create).", true); return; }
    const name = ($("#cPresetName").value || "").trim() || selectedPreset()?.name;
    try {
      const r = await fetch(`/api/intel/presets/${CLIP.currentPresetId}`, {
        method: "PUT", headers: { "content-type": "application/json" },
        body: JSON.stringify({ name, config: readCfg() }),
      });
      if (!r.ok) throw new Error((await r.json()).detail || "Update failed");
      await loadPresets();
      toast("Preset updated.");
    } catch (e) { toast(e.message, true); }
  }
  async function presetSave() {
    if (CLIP.currentPresetId) return presetUpdate();
    return presetCreate();
  }
  async function presetDuplicate() {
    if (!CLIP.currentPresetId) { toast("Select a preset to duplicate.", true); return; }
    try {
      const p = await post(`/api/intel/presets/${CLIP.currentPresetId}/duplicate`, {});
      CLIP.currentPresetId = p.id;
      await loadPresets();
      $("#cPresetName").value = p.name;
      toast(`Duplicated → “${p.name}”.`);
    } catch (e) { toast(e.message, true); }
  }
  async function presetDelete() {
    if (!CLIP.currentPresetId) { toast("Select a preset to delete.", true); return; }
    if (!confirm("Delete this preset?")) return;
    try {
      await fetch(`/api/intel/presets/${CLIP.currentPresetId}`, { method: "DELETE" });
      CLIP.currentPresetId = null;
      $("#cPresetName").value = "";
      await loadPresets();
      toast("Preset deleted.");
    } catch (e) { toast(e.message, true); }
  }

  // ---- Smart Video Searcher -----------------------------------------
  function setBusy(b) {
    CLIP.busy = b;
    $$("#view-clips button").forEach((el) => {
      if (el.closest(".clip-card") || el.closest(".cand") || el.closest("#searchProgress")
        || el.closest("#resumeBanner") || el.closest(".review-toolbar")
        || el.closest(".review-filters") || el.closest(".review-actions")) return;
      el.disabled = b;
    });
  }
  function sourceError(cfg) {
    const sc = cfg.search_scope;
    if (sc === "channel" && !cfg.channel_url.trim() && !cfg.topic.trim())
      return "Enter a YouTube channel (URL, @handle, ID or name).";
    if (sc === "video" && !cfg.video_url.trim()) return "Enter a YouTube video URL.";
    if ((sc === "youtube" || sc === "youtube_web") && !cfg.topic.trim())
      return "Enter a topic to search for.";
    if (cfg.source_type === "preset") return "Pick a saved preset in the Preset bar first.";
    return null;
  }

  const SEARCH_BTN = {
    idle: "🔍 Search & Review First", starting: "⏳ Starting Search…",
    searching: "🔎 Searching…", ranking: "📊 Ranking Results…",
    done: "✅ Review Results", error: "⚠ Search Failed",
  };
  function setSearchBtn(state) {
    const b = $("#btnSearchReview");
    if (b) b.textContent = SEARCH_BTN[state] || SEARCH_BTN.idle;
  }

  function resetSearchProgress() {
    $("#searchProgress").hidden = false;
    $("#searchProgressFill").style.width = "0%";
    $("#searchProgressPct").textContent = "0%";
    $("#searchProgressTitle").textContent = "Starting search…";
    $("#searchCounters").innerHTML = "";
    $("#searchLog").textContent = "";
    $("#btnSearchRetry").hidden = true;
    $("#btnSearchCancel").hidden = false;
  }

  const SEARCH_PHASE = { discover: "Searching YouTube…", analyzing: "Analyzing videos…", complete: "Done" };
  function renderSearchStatus(job) {
    const pct = job.progress || 0;
    $("#searchProgressFill").style.width = pct + "%";
    $("#searchProgressPct").textContent = pct + "%";
    const titles = {
      queued: "Queued…", searching: SEARCH_PHASE[job.currentStep] || "Searching…",
      ranking: "Ranking results…", done: "Search complete", error: "Search failed",
      cancelled: "Search cancelled",
    };
    $("#searchProgressTitle").textContent = titles[job.status] || "Working…";
    const counters = [
      ["Searches", `${job.searchesCompleted || 0}/${job.searchesPlanned || 0}`],
      ["Found", job.resultsFound || 0],
      ["Analyzed", job.resultsAnalyzed || 0],
      ["Duplicates removed", job.duplicatesRemoved || 0],
      ["Errors", job.errors || 0],
      ["Elapsed", Math.round(job.elapsed || 0) + "s"],
    ];
    $("#searchCounters").innerHTML = counters.map(([k, v]) => `<span class="counter"><b>${v}</b> ${k}</span>`).join("");
    const logEl = $("#searchLog");
    logEl.textContent = (job.logs || []).join("\n");
    logEl.scrollTop = logEl.scrollHeight;
  }

  function onSearchReviewClick() {
    if (CLIP.searchActive) { toast("A search is already running."); return; }
    handleSearchAndReview();
  }

  async function handleSearchAndReview(opts) {
    opts = opts || {};
    if (CLIP.searchActive) { toast("A search is already running."); return; }
    const cfg = readCfg();
    const err = sourceError(cfg);
    if (err) { toast(err, true); return; }
    if (opts.bumpLimit) cfg.result_limit = Math.min(100, (cfg.result_limit || 20) + 20);
    CLIP.searchAppend = !!opts.append;
    CLIP.searchActive = true;
    setBusy(true);
    setSearchBtn("starting");
    resetSearchProgress();
    $("#resumeBanner").hidden = true;
    try {
      const { jobId } = await post("/api/intel/video-search/start", { config: cfg });
      CLIP.searchJobId = jobId;
      pollSearchJob(jobId);
    } catch (e) {
      CLIP.searchActive = false; setBusy(false); setSearchBtn("error");
      $("#searchProgressTitle").textContent = e.message;
      $("#btnSearchCancel").hidden = true;
      toast(e.message, true);
    }
  }

  function pollSearchJob(jobId) {
    if (CLIP.searchPoll) clearTimeout(CLIP.searchPoll);
    CLIP.activeJobId = jobId;
    const tick = async () => {
      let job;
      try { job = await api(`/api/intel/video-search/job/${jobId}`); }
      catch (e) { CLIP.searchActive = false; setBusy(false); setSearchBtn("error"); toast(e.message, true); return; }
      renderSearchStatus(job);
      if (job.status === "searching") setSearchBtn(job.currentStep === "analyzing" ? "ranking" : "searching");
      if (["done", "error", "cancelled"].includes(job.status)) {
        CLIP.searchActive = false; setBusy(false); $("#btnSearchCancel").hidden = true;
        if (job.status === "error") {
          setSearchBtn("error"); $("#btnSearchRetry").hidden = false;
          toast(job.error || "Search failed", true);
          return;
        }
        setSearchBtn("done");
        await loadSearchResults(jobId, { append: CLIP.searchAppend });
        if (job.status === "cancelled") toast("Search cancelled — showing partial results.");
        return;
      }
      CLIP.searchPoll = setTimeout(tick, 1300);
    };
    tick();
  }

  async function loadSearchResults(jobId, opts) {
    opts = opts || {};
    let data;
    try { data = await api(`/api/intel/video-search/job/${jobId}/results`); }
    catch (e) { toast(e.message, true); return; }
    const fresh = data.candidates || [];
    if (opts.append && CLIP.candidates.length) {
      const seen = new Set(CLIP.candidates.map((c) => c.video_id));
      CLIP.candidates = CLIP.candidates.concat(fresh.filter((c) => !seen.has(c.video_id)));
    } else {
      CLIP.candidates = fresh;
    }
    const autoOn = $("#cAutoSelect") ? $("#cAutoSelect").checked : true;
    CLIP.candidates.forEach((c) => {
      if (c._included === undefined) c._included = autoOn ? !!c.auto_selected : false;
    });
    $("#reviewPanel").hidden = false;
    applyFilters();
    $("#reviewPanel").scrollIntoView({ behavior: "smooth", block: "start" });
  }

  // ---- filters ------------------------------------------------------
  function readFilters() {
    const val = (id) => { const e = $("#" + id); return e ? e.value : ""; };
    const num = (id) => { const n = parseFloat(val(id)); return isNaN(n) ? null : n; };
    return {
      minViews: num("fMinViews"), maxViews: num("fMaxViews"),
      minDur: num("fMinDur"), maxDur: num("fMaxDur"), after: val("fAfter"),
      lang: val("fLang").trim().toLowerCase(), channel: val("fChannel").trim().toLowerCase(),
      keyword: val("fKeyword").trim().toLowerCase(),
      minRel: parseInt(val("fMinRel"), 10) || 0, minClip: parseInt(val("fMinClip"), 10) || 0,
      videoType: val("fVideoType"), sort: val("fSort"),
    };
  }
  function applyFilters() {
    const f = readFilters();
    if ($("#fMinRelV")) $("#fMinRelV").textContent = f.minRel;
    if ($("#fMinClipV")) $("#fMinClipV").textContent = f.minClip;
    let list = CLIP.candidates.filter((c) => {
      if (f.minViews != null && (c.view_count || 0) < f.minViews) return false;
      if (f.maxViews != null && (c.view_count || 0) > f.maxViews) return false;
      const durMin = (c.duration || 0) / 60;
      if (f.minDur != null && durMin < f.minDur) return false;
      if (f.maxDur != null && c.duration && durMin > f.maxDur) return false;
      if (f.after && c.upload_date && c.upload_date < f.after) return false;
      if (f.lang && c.language && !String(c.language).toLowerCase().startsWith(f.lang)) return false;
      if (f.channel && !(c.channel || "").toLowerCase().includes(f.channel)) return false;
      if (f.keyword && !(c.title || "").toLowerCase().includes(f.keyword)) return false;
      if (f.minRel && (c.topic_relevance ?? c.relevance_score ?? 0) < f.minRel) return false;
      if (f.minClip && (c.clip_potential ?? c.clip_score ?? 0) < f.minClip) return false;
      // video type only filters when known (post stage-2) — best-effort
      if (f.videoType && f.videoType !== "any" && c.video_type && c.video_type !== f.videoType) return false;
      return true;
    });
    const key = { "most-popular": "popularity_score", "most-recent": "recency_score",
      "highest-engagement": "engagement_score", "best-clip-potential": "clip_potential",
      "most-commented": "comment_count" };
    if (f.sort === "longest") list.sort((a, b) => (b.duration || 0) - (a.duration || 0));
    else if (f.sort === "shortest") list.sort((a, b) => (a.duration || 1e12) - (b.duration || 1e12));
    else if (key[f.sort]) list.sort((a, b) => (b[key[f.sort]] || 0) - (a[key[f.sort]] || 0));
    else list.sort((a, b) => (b.score || 0) - (a.score || 0));
    CLIP.viewCands = list;
    renderCandidates();
  }

  // ---- candidate cards ----------------------------------------------
  function byId(vid) { return CLIP.candidates.find((c) => c.video_id === vid); }
  function removeCand(vid) { CLIP.candidates = CLIP.candidates.filter((c) => c.video_id !== vid); applyFilters(); }
  function selectedCandidates() { return CLIP.candidates.filter((c) => c._included !== false); }
  function updateReviewMeta() {
    const list = CLIP.viewCands || CLIP.candidates;
    $("#reviewMeta").textContent = `${list.length} shown · ${CLIP.candidates.length} found · ${selectedCandidates().length} selected`;
  }
  function selectTop(n) {
    CLIP.candidates.forEach((c) => (c._included = false));
    (CLIP.viewCands || CLIP.candidates).slice(0, n).forEach((c) => (c._included = true));
    renderCandidates();
  }
  function miniScore(short, full, val, cls) {
    return `<span class="mini-score ${cls}" title="${full}">${short} ${val ?? "—"}</span>`;
  }
  function candCard(c) {
    const on = c._included !== false;
    const kw = (c.matched_keywords || []).map((k) => `<span class="kw-chip">${escapeHtml(k)}</span>`).join("");
    const stage2 = c._analyzed
      ? `<div class="cand-stage2">🔬 ${escapeHtml(c.engagement_summary || "")}${c.has_transcript ? " · transcript ✓" : " · no transcript"}</div>` : "";
    const stats = [
      c.view_count != null ? fmtNum(c.view_count) + " views" : null,
      c.like_count != null ? fmtNum(c.like_count) + " likes" : null,
      c.comment_count != null ? fmtNum(c.comment_count) + " comments" : null,
    ].filter(Boolean).join(" · ");
    return `
      <div class="cand ${on ? "on" : ""}" data-vid="${escapeHtml(c.video_id)}">
        <label class="cand-pick"><input type="checkbox" ${on ? "checked" : ""} data-vid="${escapeHtml(c.video_id)}"/></label>
        <img class="cand-thumb" src="${escapeHtml(c.thumbnail || "")}" loading="lazy" alt=""/>
        <div class="cand-body">
          <div class="cand-title">${escapeHtml(c.title || c.video_id)}</div>
          <div class="cand-sub">${escapeHtml(c.channel || "")} ${c.upload_date ? "· " + c.upload_date : ""} ${c.duration_str ? "· " + c.duration_str : ""}${stats ? " · " + stats : ""}</div>
          <div class="cand-reason">${escapeHtml(c.reason_selected || c.reason || "")}</div>
          ${kw ? `<div class="cand-kw">${kw}</div>` : ""}
          ${stage2}
          <div class="cand-scores">
            <span class="mini-score ov" title="Overall score">★ ${c.score ?? "—"}</span>
            ${miniScore("Rel", "Topic relevance", c.topic_relevance ?? c.relevance_score, "rel")}
            ${miniScore("Pop", "Popularity", c.popularity_score, "pop")}
            ${miniScore("Eng", "Engagement", c.engagement_score, "eng")}
            ${miniScore("Clip", "Clip potential", c.clip_potential ?? c.clip_score, "clip")}
          </div>
        </div>
        <div class="cand-actions">
          <a class="btn tiny cand-open" href="${escapeHtml(c.url)}" target="_blank" rel="noopener">▶ YouTube</a>
          <button class="btn tiny" data-vid="${escapeHtml(c.video_id)}" data-act="refresh">↻ Meta</button>
          <button class="btn tiny" data-vid="${escapeHtml(c.video_id)}" data-act="exclude">✕ Remove</button>
        </div>
      </div>`;
  }
  function renderCandidates() {
    const list = CLIP.viewCands || CLIP.candidates;
    updateReviewMeta();
    if (!list.length) {
      $("#candidates").innerHTML = '<div class="empty">No videos match the current filters.</div>';
      return;
    }
    $("#candidates").innerHTML = list.map((c) => candCard(c)).join("");
    $$("#candidates .cand-pick input").forEach((cb) => (cb.onchange = () => {
      const c = byId(cb.dataset.vid); if (c) c._included = cb.checked;
      cb.closest(".cand").classList.toggle("on", cb.checked);
      updateReviewMeta();
    }));
    $$("#candidates [data-act]").forEach((el) => (el.onclick = () => candAction(el.dataset.vid, el.dataset.act)));
  }
  function candAction(vid, act) {
    if (act === "exclude") removeCand(vid);
    else if (act === "refresh") refreshMeta([vid]);
  }
  async function refreshMeta(vids) {
    toast("Refreshing metadata…");
    try {
      const { candidates } = await post("/api/intel/video-search/refresh-meta", { video_ids: vids, config: readCfg() });
      (candidates || []).forEach((nc) => {
        const i = CLIP.candidates.findIndex((c) => c.video_id === nc.video_id);
        if (i >= 0) CLIP.candidates[i] = { ...CLIP.candidates[i], ...nc };
      });
      applyFilters();
      toast("Metadata refreshed.");
    } catch (e) { toast(e.message, true); }
  }

  // ---- analyze selected + create clips ------------------------------
  async function analyzeSelected() {
    const sel = selectedCandidates();
    if (!sel.length) { toast("Select at least one video.", true); return; }
    if (!CLIP.searchJobId) { toast("Run a search first.", true); return; }
    if (CLIP.searchActive) { toast("Wait for the current job to finish."); return; }
    CLIP.searchActive = true; setBusy(true);
    resetSearchProgress();
    $("#searchProgressTitle").textContent = "Analyzing selected videos…";
    try {
      const { jobId } = await post("/api/intel/video-search/analyze-selected",
        { jobId: CLIP.searchJobId, videoIds: sel.map((c) => c.video_id) });
      pollAnalyzeJob(jobId);
    } catch (e) { CLIP.searchActive = false; setBusy(false); $("#btnSearchCancel").hidden = true; toast(e.message, true); }
  }
  function pollAnalyzeJob(jobId) {
    if (CLIP.searchPoll) clearTimeout(CLIP.searchPoll);
    CLIP.activeJobId = jobId;
    const tick = async () => {
      let job;
      try { job = await api(`/api/intel/video-search/job/${jobId}`); }
      catch (e) { CLIP.searchActive = false; setBusy(false); toast(e.message, true); return; }
      renderSearchStatus(job);
      if (["done", "error", "cancelled"].includes(job.status)) {
        CLIP.searchActive = false; setBusy(false); $("#btnSearchCancel").hidden = true;
        if (job.status === "error") { toast(job.error || "Analyze failed", true); return; }
        try {
          const data = await api(`/api/intel/video-search/job/${jobId}/results`);
          (data.candidates || []).forEach((nc) => {
            const i = CLIP.candidates.findIndex((c) => c.video_id === nc.video_id);
            if (i >= 0) CLIP.candidates[i] = { ...CLIP.candidates[i], ...nc };
          });
          applyFilters();
          toast("Deep analysis complete.");
        } catch (_) {}
        return;
      }
      CLIP.searchPoll = setTimeout(tick, 1300);
    };
    tick();
  }
  async function createClipsFromSelected() {
    const sel = selectedCandidates();
    if (!sel.length) { toast("Select at least one video.", true); return; }
    setBusy(true);
    resetStatus();
    try {
      let run_id;
      if (CLIP.searchJobId) {
        ({ run_id } = await post("/api/intel/video-search/create-clips",
          { jobId: CLIP.searchJobId, selected: sel, config: readCfg() }));
      } else {
        ({ run_id } = await post("/api/intel/autoclips", { config: readCfg(), selected: sel }));
      }
      $("#reviewPanel").hidden = true;
      CLIP.runId = run_id;
      pollRun(run_id);
    } catch (e) { setBusy(false); toast(e.message, true); }
  }

  // ---- resume / recovery --------------------------------------------
  async function checkUnfinishedSearch() {
    let job;
    try { job = await api("/api/intel/video-search/latest"); } catch (_) { return; }
    if (!job || !job.id) { $("#resumeBanner").hidden = true; return; }
    CLIP.resumeJob = job;
    const q = job.request ? (job.request.topic || job.request.channel_url || job.request.video_url || "search") : "search";
    $("#resumeInfo").textContent = `“${q}” — ${job.status}, ${job.progress || 0}%`;
    $("#resumeBanner").hidden = false;
  }

  // ---- auto create / run --------------------------------------------
  async function autoCreate(selected) {
    const cfg = readCfg();
    const err = sourceError(cfg);
    if (err) { toast(err, true); return; }
    setBusy(true);
    resetStatus();
    try {
      const { run_id } = await post("/api/intel/autoclips", { config: cfg, selected: selected || null });
      $("#reviewPanel").hidden = true;
      CLIP.runId = run_id;
      pollRun(run_id);
    } catch (e) { setBusy(false); toast(e.message, true); }
  }

  function resetStatus() {
    $("#clipProgress").hidden = false;
    $("#clipProgressFill").style.width = "0%";
    $("#clipProgressPct").textContent = "0%";
    $("#clipProgressTitle").textContent = "Starting…";
    $("#clipSteps").innerHTML = "";
    $("#clipCounters").innerHTML = "";
    $("#clipLog").textContent = "";
    $("#clipReview").hidden = true;
    $("#clipCards").innerHTML = "";
    CLIP.lastClipsSig = "";
  }

  function pollRun(runId) {
    if (CLIP.runPoll) clearTimeout(CLIP.runPoll);
    const tick = async () => {
      let run;
      try { run = await api(`/api/intel/run/${runId}`); }
      catch (e) { setBusy(false); toast(e.message, true); return; }
      renderStatus(run);
      renderRunClips(run);
      if (run.status === "done" || run.status === "error") {
        setBusy(false);
        loadRuns();
        if (run.status === "error") toast(run.job?.error || "Run failed", true);
        else {
          const n = run.stats?.clips_done || 0;
          toast(n ? `Created ${n} clip${n === 1 ? "" : "s"}.` : "Run finished — no strong clips found.");
        }
        return;
      }
      CLIP.runPoll = setTimeout(tick, 1300);
    };
    tick();
  }

  const STEP_ICONS = { pending: "•", running: "↻", done: "✓", error: "!", skipped: "–" };
  function renderStatus(run) {
    const s = run.stats || {};
    const pct = s.pct ?? run.progress ?? 0;
    $("#clipProgressFill").style.width = pct + "%";
    $("#clipProgressPct").textContent = pct + "%";
    const titles = { queued: "Queued", running: "Working…", done: "Done", error: "Error" };
    $("#clipProgressTitle").textContent = titles[run.status] || "Working…";
    const counters = [
      ["Videos", `${s.videos_done || 0}/${s.videos_selected || 0}`],
      ["Moments found", s.moments_found || 0],
      ["Clips", `${s.clips_done || 0}/${s.clips_total || 0}`],
      ["Errors", s.errors || 0],
    ];
    $("#clipCounters").innerHTML = counters.map(([k, v]) =>
      `<span class="counter"><b>${v}</b> ${k}</span>`).join("") +
      (s.current_video ? `<span class="counter cur">▶ ${escapeHtml(s.current_video)}</span>` : "");
    const steps = run.job?.steps || [];
    $("#clipSteps").innerHTML = steps.map((st) =>
      `<li class="s-${st.status}"><span class="step-icon">${STEP_ICONS[st.status] || "•"}</span>
         <span class="step-name">${escapeHtml(st.label)}</span>
         <span class="step-detail">${escapeHtml(st.detail || "")}</span></li>`).join("");
    const logs = run.job?.logs || [];
    const logEl = $("#clipLog");
    logEl.textContent = logs.join("\n");
    logEl.scrollTop = logEl.scrollHeight;
  }

  function renderRunClips(run) {
    const clips = run.clips || [];
    if (!clips.length) return;
    const sig = clips.map((c) => `${c.id}:${c.status}:${c.file_path || ""}`).join("|");
    if (sig === CLIP.lastClipsSig) return;   // avoid reloading <video> every poll
    CLIP.lastClipsSig = sig;
    CLIP.runId = run.id;
    $("#clipReview").hidden = false;
    const done = clips.filter((c) => c.status === "rendered" || c.status === "approved").length;
    $("#clipReviewTitle").textContent = `Clips (${done}/${clips.length})`;
    $("#clipReviewMeta").textContent = run.query ? `“${run.query}”` : "";
    const bust = Date.now();
    $("#clipCards").innerHTML = clips.map((c) => clipCard(c, bust)).join("");
    wireClipCards();
  }

  function scoreClass(v) { return v >= 75 ? "score-hi" : v >= 50 ? "score-mid" : "score-lo"; }
  function clipCard(c, bust) {
    const rendering = c.status === "rendering" || c.status === "pending";
    const failed = c.status === "failed";
    const media = c.file_path
      ? `<video class="clip-video" controls preload="none" poster="${c.poster_path ? escapeHtml(c.poster_path + "?t=" + bust) : ""}">
           <source src="${escapeHtml(c.file_path + "?t=" + bust)}" type="video/mp4"></video>`
      : `<div class="clip-video placeholder">${failed ? "⚠ Render failed" : "⏳ Rendering…"}</div>`;
    const desc = c.description || c.hook || c.reason || "";
    const tags = (c.hashtags || []).map((h) => `<span class="tag">${escapeHtml(h)}</span>`).join("");
    return `
    <div class="clip-card ${c.status}" data-id="${c.id}">
      <div class="clip-media">${media}
        <span class="clip-badge ${c.status}">${escapeHtml(statusLabel(c))}</span></div>
      <div class="clip-info">
        <div class="clip-title-row">
          <input class="clip-title-edit" value="${escapeHtml(c.title || "Clip")}" data-id="${c.id}"/>
        </div>
        <div class="clip-time"><a href="${escapeHtml(srcAt(c))}" target="_blank" rel="noopener">${escapeHtml(c.start_str || "")}–${escapeHtml(c.end_str || "")}</a> · ${Math.round(c.duration || 0)}s · ${escapeHtml((c.video_title || "").slice(0, 40))}</div>
        <div class="clip-scores">
          <span class="score ${scoreClass(c.clip_score ?? c.viral_score)}">${c.clip_score ?? c.viral_score ?? "—"}<i>clip</i></span>
          <span class="score ${scoreClass(c.hook_score ?? 0)}">${c.hook_score ?? "—"}<i>hook</i></span>
          <span class="score ${scoreClass(c.topic_score ?? 0)}">${c.topic_score ?? "—"}<i>topic</i></span>
          <span class="plat-tag">${escapeHtml(c.framing_mode || "")}</span>
        </div>
        ${c.reason ? `<div class="clip-line"><span class="lab">Why:</span>${escapeHtml(c.reason)}</div>` : ""}
        ${c.hook ? `<div class="clip-line"><span class="lab">Hook:</span>${escapeHtml(c.hook)}</div>` : ""}
        <div class="clip-line"><span class="lab">Description:</span>${escapeHtml(desc)}</div>
        ${c.caption ? `<div class="clip-line"><span class="lab">Caption:</span>${escapeHtml(c.caption)}</div>` : ""}
        ${tags ? `<div class="taglist">${tags}</div>` : ""}
        ${c.error ? `<div class="clip-line err">⚠ ${escapeHtml(c.error)}</div>` : ""}
        <div class="clip-controls" data-id="${c.id}">
          <button class="btn tiny ok" data-act="approve" ${rendering ? "disabled" : ""}>${c.status === "approved" ? "✓ Approved" : "Approve"}</button>
          <button class="btn tiny bad" data-act="reject" ${rendering ? "disabled" : ""}>${c.status === "rejected" ? "Rejected" : "Reject"}</button>
          <button class="btn tiny" data-act="regenerate" ${rendering ? "disabled" : ""}>↻ Regenerate</button>
          <button class="btn tiny" data-act="trim" ${rendering ? "disabled" : ""}>✂ Trim</button>
          <select class="mini-sel" data-act="reframe" ${rendering ? "disabled" : ""} title="Reframe">
            <option value="">Reframe…</option><option value="smart">Smart Auto</option>
            <option value="center">Center Crop</option><option value="blur">Blurred BG</option><option value="split">Split Speaker</option>
          </select>
          <select class="mini-sel" data-act="captions" ${rendering ? "disabled" : ""} title="Captions">
            <option value="">Captions…</option><option value="bold">Bold</option><option value="clean">Clean</option>
            <option value="minimal">Minimal</option><option value="big">Big</option><option value="none">Off</option>
          </select>
          <button class="btn tiny" data-act="replace" ${rendering ? "disabled" : ""}>⇄ Next best</button>
          <a class="btn tiny ${c.file_path ? "" : "disabled"}" ${c.file_path ? `href="${escapeHtml(c.file_path)}" download` : ""}>⬇ Export</a>
        </div>
      </div>
    </div>`;
  }
  function statusLabel(c) {
    return { rendering: "Rendering…", pending: "Queued", rendered: "Ready", approved: "Approved",
             rejected: "Rejected", failed: "Failed" }[c.status] || c.status;
  }
  function srcAt(c) {
    const base = c.source_url || "#";
    return base.includes("watch?v=") ? `${base}&t=${Math.floor(c.start || 0)}s` : base;
  }

  function wireClipCards() {
    $$("#clipCards .clip-controls").forEach((box) => {
      const id = box.dataset.id;
      box.querySelectorAll("button[data-act]").forEach((b) => (b.onclick = () => clipAction(id, b.dataset.act)));
      box.querySelectorAll("select[data-act]").forEach((sel) => (sel.onchange = () => {
        if (sel.value) clipAction(id, sel.dataset.act, sel.value);
        sel.value = "";
      }));
    });
    $$("#clipCards .clip-title-edit").forEach((inp) => (inp.onchange = () => saveTitle(inp.dataset.id, inp.value)));
  }

  async function saveTitle(id, title) {
    // title edits persist via a lightweight reframe call carrying the new title?
    // Simpler: store via captions endpoint not suitable — use a dedicated PUT.
    try { await post(`/api/intel/clip/${id}/title`, { title }); toast("Title saved."); }
    catch (_) { /* endpoint optional */ }
  }

  async function clipAction(id, act, value) {
    try {
      if (act === "approve" || act === "reject") {
        await post(`/api/intel/clip/${id}/${act}`, {});
        refreshRun();
        return;
      }
      if (act === "trim") {
        const cur = currentClip(id);
        const start = parseFloat(prompt("New START (seconds):", Math.round(cur?.start ?? 0)));
        const end = parseFloat(prompt("New END (seconds):", Math.round(cur?.end ?? 0)));
        if (isNaN(start) || isNaN(end) || end <= start) { toast("Invalid trim.", true); return; }
        await reRender(`/api/intel/clip/${id}/trim`, { start, end });
        return;
      }
      if (act === "reframe") { await reRender(`/api/intel/clip/${id}/reframe`, { framing: value }); return; }
      if (act === "captions") { await reRender(`/api/intel/clip/${id}/captions`, { caption_style: value }); return; }
      if (act === "regenerate") { await reRender(`/api/intel/clip/${id}/regenerate`, {}); return; }
      if (act === "replace") { await reRender(`/api/intel/clip/${id}/replace`, {}); return; }
    } catch (e) { toast(e.message, true); }
  }
  function currentClip(id) {
    return (CLIP._clipsCache || []).find((c) => String(c.id) === String(id));
  }
  async function reRender(url, body) {
    toast("Re-rendering…");
    const { job_id } = await post(url, body);
    CLIP.lastClipsSig = "";               // force a redraw when it finishes
    if (job_id) pollJob(job_id, () => refreshRun());
    else refreshRun();
  }
  function pollJob(jobId, onDone) {
    const tick = async () => {
      let job;
      try { job = await api(`/api/intel/job/${jobId}`); } catch (_) { return; }
      refreshRun();
      if (job.status === "done") { toast("Clip updated."); onDone && onDone(); return; }
      if (job.status === "error") { toast(job.error || "Re-render failed", true); onDone && onDone(); return; }
      setTimeout(tick, 1200);
    };
    tick();
  }
  async function refreshRun() {
    if (!CLIP.runId) return;
    try {
      const run = await api(`/api/intel/run/${CLIP.runId}`);
      CLIP._clipsCache = run.clips || [];
      renderRunClips(run);
    } catch (_) {}
  }

  // ---- runs history -------------------------------------------------
  async function loadRuns() {
    let runs;
    try { runs = await api("/api/intel/runs"); } catch (_) { return; }
    $("#runsList").innerHTML = runs.map((r) => {
      const s = r.stats || {};
      return `<li data-id="${r.id}"><div><div class="run-q">${escapeHtml(r.query || r.source_type)}</div>
        <div class="run-sub">${escapeHtml(r.source_type)} · ${s.clips_done || 0} clips · ${escapeHtml(r.status)}</div></div>
        <button class="btn tiny run-del" data-id="${r.id}">🗑</button></li>`;
    }).join("") || '<li class="muted">No runs yet.</li>';
    $$("#runsList li[data-id]").forEach((li) => (li.onclick = (e) => {
      if (e.target.classList.contains("run-del")) return;
      openRun(li.dataset.id);
    }));
    $$("#runsList .run-del").forEach((b) => (b.onclick = async (e) => {
      e.stopPropagation();
      await fetch(`/api/intel/run/${b.dataset.id}`, { method: "DELETE" });
      loadRuns();
    }));
  }
  async function openRun(runId) {
    CLIP.runId = runId;
    $("#clipProgress").hidden = false;
    CLIP.lastClipsSig = "";
    const run = await api(`/api/intel/run/${runId}`);
    CLIP._clipsCache = run.clips || [];
    renderStatus(run);
    renderRunClips(run);
    if (run.status === "running" || run.status === "queued") pollRun(runId);
    $("#clipReview").scrollIntoView({ behavior: "smooth", block: "start" });
  }

  // ---- review wiring ------------------------------------------------
  function wireReviewToolbar() {
    const on = (id, fn) => { const e = $("#" + id); if (e) e.onclick = fn; };
    on("btnSelAll", () => { CLIP.candidates.forEach((c) => (c._included = true)); renderCandidates(); });
    on("btnSelNone", () => { CLIP.candidates.forEach((c) => (c._included = false)); renderCandidates(); });
    on("btnSelTop5", () => selectTop(5));
    on("btnSelTop10", () => selectTop(10));
    on("btnSelTop20", () => selectTop(20));
    on("btnRemoveSel", () => { CLIP.candidates = CLIP.candidates.filter((c) => c._included === false); applyFilters(); });
    on("btnExclChannel", () => {
      const sel = selectedCandidates(); if (!sel.length) { toast("Select a video first.", true); return; }
      const chans = new Set(sel.map((c) => (c.channel || "").toLowerCase()).filter(Boolean));
      CLIP.candidates = CLIP.candidates.filter((c) => !chans.has((c.channel || "").toLowerCase()));
      applyFilters(); toast("Excluded channel(s).");
    });
    on("btnExclVideo", () => {
      const sel = selectedCandidates(); if (!sel.length) { toast("Select a video first.", true); return; }
      const ids = new Set(sel.map((c) => c.video_id));
      CLIP.candidates = CLIP.candidates.filter((c) => !ids.has(c.video_id));
      applyFilters();
    });
    on("btnRefreshMeta", () => {
      const sel = selectedCandidates(); if (!sel.length) { toast("Select videos to refresh.", true); return; }
      refreshMeta(sel.slice(0, 8).map((c) => c.video_id));
    });
    on("btnFindMore", () => handleSearchAndReview({ append: true, bumpLimit: true }));
    on("btnReplaceWeak", () => {
      CLIP.candidates = CLIP.candidates.filter((c) => c._included !== false || (c.score || 0) >= 60);
      handleSearchAndReview({ append: true, bumpLimit: true });
    });
    on("btnAnalyzeSelected", analyzeSelected);
    on("btnUseSelected", createClipsFromSelected);
    on("btnBackToSearch", () => { $("#reviewPanel").hidden = true; $(".clips-controls").scrollIntoView({ behavior: "smooth" }); });
    on("btnClearFilters", () => {
      ["fMinViews", "fMaxViews", "fMinDur", "fMaxDur", "fAfter", "fLang", "fChannel", "fKeyword"]
        .forEach((id) => { const e = $("#" + id); if (e) e.value = ""; });
      ["fMinRel", "fMinClip"].forEach((id) => { const e = $("#" + id); if (e) e.value = 0; });
      if ($("#fVideoType")) $("#fVideoType").value = "any";
      applyFilters();
    });
  }
  function wireReviewFilters() {
    ["fMinViews", "fMaxViews", "fMinDur", "fMaxDur", "fAfter", "fLang", "fChannel",
      "fKeyword", "fVideoType", "fSort", "fMinRel", "fMinClip"].forEach((id) => {
        const e = $("#" + id); if (!e) return;
        e.oninput = applyFilters; e.onchange = applyFilters;
      });
  }
  function wireResumeBanner() {
    const on = (id, fn) => { const e = $("#" + id); if (e) e.onclick = fn; };
    on("btnResumeSearch", () => {
      const id = CLIP.resumeJob && CLIP.resumeJob.id; if (!id) return;
      $("#resumeBanner").hidden = true;
      CLIP.searchJobId = id; CLIP.searchActive = true; setBusy(true);
      setSearchBtn("searching"); resetSearchProgress(); pollSearchJob(id);
    });
    on("btnResumePartial", async () => {
      const id = CLIP.resumeJob && CLIP.resumeJob.id; if (!id) return;
      $("#resumeBanner").hidden = true; CLIP.searchJobId = id;
      await loadSearchResults(id, {});
    });
    on("btnResumeRestart", () => {
      if (CLIP.resumeJob && CLIP.resumeJob.request) writeCfg(CLIP.resumeJob.request);
      $("#resumeBanner").hidden = true;
      handleSearchAndReview();
    });
    on("btnResumeDelete", async () => {
      const id = CLIP.resumeJob && CLIP.resumeJob.id; if (!id) return;
      try { await fetch(`/api/intel/video-search/job/${id}`, { method: "DELETE" }); } catch (_) {}
      $("#resumeBanner").hidden = true; CLIP.resumeJob = null;
    });
  }

  // ---- view toggle + init -------------------------------------------
  function switchView(view) {
    $$(".mode-btn").forEach((b) => b.classList.toggle("active", b.dataset.view === view));
    $("#view-single").hidden = view !== "single";
    $("#view-clips").hidden = view !== "clips";
  }

  function init() {
    $$(".mode-btn").forEach((b) => (b.onclick = () => switchView(b.dataset.view)));
    $("#cSourceType").onchange = () => { updateSource(); syncScope(); };
    if ($("#cSearchScope")) $("#cSearchScope").onchange = syncSourceFromScope;
    $("#cNumClips").oninput = updateAutoBtn;
    $("#btnRefine").onclick = refine;
    $("#cTopic").addEventListener("keydown", (e) => { if (e.key === "Enter") handleSearchAndReview(); });

    // presets
    $("#cPresetPick").onchange = (e) => {
      const p = CLIP.presets.find((x) => String(x.id) === e.target.value);
      if (p) loadPresetIntoForm(p);
    };
    $("#btnPresetCreate").onclick = presetCreate;
    $("#btnPresetSave").onclick = presetSave;
    $("#btnPresetUpdate").onclick = presetUpdate;
    $("#btnPresetDuplicate").onclick = presetDuplicate;
    $("#btnPresetDelete").onclick = presetDelete;
    $("#btnPresetRun").onclick = () => autoCreate(null);

    // Smart Video Searcher
    $("#btnSearchReview").onclick = onSearchReviewClick;
    if ($("#btnSearchCancel")) $("#btnSearchCancel").onclick = async () => {
      const id = CLIP.activeJobId; if (!id) return;
      try { await post(`/api/intel/video-search/job/${id}/cancel`, {}); toast("Cancelling after the current query…"); }
      catch (e) { toast(e.message, true); }
    };
    if ($("#btnSearchRetry")) $("#btnSearchRetry").onclick = async () => {
      const id = CLIP.searchJobId; if (!id) return;
      try {
        const { jobId } = await post(`/api/intel/video-search/job/${id}/retry`, {});
        CLIP.searchJobId = jobId; CLIP.searchActive = true; setBusy(true);
        setSearchBtn("starting"); resetSearchProgress(); pollSearchJob(jobId);
      } catch (e) { toast(e.message, true); }
    };
    wireReviewToolbar();
    wireReviewFilters();
    wireResumeBanner();

    // create
    $("#btnAutoCreate").onclick = () => autoCreate(null);
    $("#refreshRuns").onclick = (e) => { e.stopPropagation(); loadRuns(); };

    updateSource();
    syncScope();
    updateAutoBtn();
    loadPresets();
    loadRuns();
    checkUnfinishedSearch();
  }
  document.addEventListener("DOMContentLoaded", init);
})();
