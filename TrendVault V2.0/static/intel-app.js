"use strict";
// ---------------------------------------------------------------- helpers
const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const state = { url: "", videoId: null, busy: false, poll: null, lastTerminal: -1, currentOutput: "" };

async function api(path, opts) {
  const res = await fetch(path, opts);
  if (!res.ok) {
    let msg = res.statusText;
    try { msg = (await res.json()).detail || msg; } catch (_) {}
    throw new Error(msg);
  }
  return res.headers.get("content-type")?.includes("json") ? res.json() : res.text();
}
const post = (path, body) =>
  api(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

function toast(msg, isErr) {
  const t = $("#toast");
  t.textContent = msg;
  t.className = "toast show" + (isErr ? " err" : "");
  clearTimeout(toast._t);
  toast._t = setTimeout(() => (t.className = "toast"), 3600);
}
function escapeHtml(s) {
  return String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
function fmtNum(n) {
  if (n == null) return "—";
  if (n >= 1e9) return (n / 1e9).toFixed(1) + "B";
  if (n >= 1e6) return (n / 1e6).toFixed(1) + "M";
  if (n >= 1e3) return (n / 1e3).toFixed(1) + "K";
  return String(n);
}
function fmtTime(sec) {
  if (sec == null) return "0:00";
  sec = Math.round(sec);
  const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = sec % 60;
  return h ? `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}` : `${m}:${String(s).padStart(2, "0")}`;
}
const ytLink = (t) => state.videoId ? `https://www.youtube.com/watch?v=${state.videoId}&t=${Math.floor(t)}s` : "#";
const openAt = (t) => window.open(ytLink(t), "_blank");

// ------------------------------------------------------------- markdown
function mdInline(s) {
  s = escapeHtml(s);
  s = s.replace(/`([^`]+)`/g, (_, c) => `<code>${c}</code>`);
  s = s.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
  s = s.replace(/(^|[^*])\*([^*\n]+)\*/g, "$1<em>$2</em>");
  s = s.replace(/\[([^\]]+)\]\((https?:[^)\s]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>');
  s = s.replace(/(^|[\s(])(https?:\/\/[^\s)<]+)/g, '$1<a href="$2" target="_blank" rel="noopener">$2</a>');
  return s;
}
const splitRow = (l) => l.trim().replace(/^\|/, "").replace(/\|$/, "").split("|").map((x) => x.trim());
function mdToHtml(md) {
  const lines = String(md || "").replace(/\r\n/g, "\n").split("\n");
  let html = "", i = 0;
  const isBlock = (l) => /^(#{1,6}\s|```|\s*>|\s*([-*+]|\d+[.)])\s|\s*(---|\*\*\*|___)\s*$)/.test(l);
  while (i < lines.length) {
    const line = lines[i];
    if (/^```/.test(line)) {
      const buf = []; i++;
      while (i < lines.length && !/^```/.test(lines[i])) buf.push(lines[i++]);
      i++; html += `<pre><code>${escapeHtml(buf.join("\n"))}</code></pre>`; continue;
    }
    if (line.includes("|") && i + 1 < lines.length && /-{2,}/.test(lines[i + 1]) && /^[\s|:-]+$/.test(lines[i + 1])) {
      const header = splitRow(line); i += 2; const rows = [];
      while (i < lines.length && lines[i].includes("|") && lines[i].trim() !== "") rows.push(splitRow(lines[i++]));
      html += "<table><thead><tr>" + header.map((h) => `<th>${mdInline(h)}</th>`).join("") + "</tr></thead><tbody>";
      rows.forEach((r) => (html += "<tr>" + r.map((c) => `<td>${mdInline(c)}</td>`).join("") + "</tr>"));
      html += "</tbody></table>"; continue;
    }
    const hm = line.match(/^(#{1,6})\s+(.*)$/);
    if (hm) { const lvl = Math.min(hm[1].length, 4); html += `<h${lvl}>${mdInline(hm[2])}</h${lvl}>`; i++; continue; }
    if (/^\s*(---|\*\*\*|___)\s*$/.test(line)) { html += "<hr/>"; i++; continue; }
    if (/^\s*>\s?/.test(line)) {
      const buf = []; while (i < lines.length && /^\s*>\s?/.test(lines[i])) buf.push(lines[i++].replace(/^\s*>\s?/, ""));
      html += `<blockquote>${mdInline(buf.join(" "))}</blockquote>`; continue;
    }
    if (/^\s*([-*+]|\d+[.)])\s+/.test(line)) {
      const ordered = /^\s*\d+[.)]\s+/.test(line), tag = ordered ? "ol" : "ul", buf = [];
      while (i < lines.length && /^\s*([-*+]|\d+[.)])\s+/.test(lines[i])) buf.push(lines[i++].replace(/^\s*([-*+]|\d+[.)])\s+/, ""));
      html += `<${tag}>` + buf.map((b) => `<li>${mdInline(b)}</li>`).join("") + `</${tag}>`; continue;
    }
    if (line.trim() === "") { i++; continue; }
    const buf = [line]; i++;
    while (i < lines.length && lines[i].trim() !== "" && !isBlock(lines[i])) buf.push(lines[i++]);
    html += `<p>${mdInline(buf.join(" "))}</p>`;
  }
  return html;
}

// ------------------------------------------------------------- run / jobs
function setBusy(b) {
  state.busy = b;
  $$(".btn.step, #runFull").forEach((el) => (el.disabled = b));
}
function currentUrl() {
  const u = $("#url").value.trim();
  if (!u) { toast("Paste a YouTube URL first.", true); return null; }
  return u;
}

async function runFull() {
  const url = currentUrl(); if (!url) return;
  setBusy(true); resetProgress();
  try {
    const { job_id } = await post("/api/intel/analyze", {
      url, prompt: $("#prompt").value.trim(),
      do_frames: $("#optFrames").checked, prefer_whisper: $("#optWhisper").checked,
    });
    pollJob(job_id, "output");
  } catch (e) { setBusy(false); toast(e.message, true); }
}
async function runStep(step) {
  const url = currentUrl(); if (!url) return;
  setBusy(true); resetProgress();
  try {
    const { job_id } = await post(`/api/intel/step/${step}`, {
      url, prompt: $("#prompt").value.trim(),
      do_vision: $("#optFrames").checked, prefer_whisper: $("#optWhisper").checked,
    });
    const tabFor = { transcript: "transcript", comments: "comments", frames: "frames", clips: "clips", output: "output" };
    pollJob(job_id, tabFor[step]);
  } catch (e) { setBusy(false); toast(e.message, true); }
}

function resetProgress() {
  state.lastTerminal = -1;
  $("#progressFill").style.width = "0%";
  $("#progressPct").textContent = "0%";
  $("#progressTitle").textContent = "Starting…";
  $("#steps").innerHTML = "";
  $("#log").textContent = "";
}
function pollJob(jobId, doneTab) {
  if (state.poll) clearTimeout(state.poll);
  const tick = async () => {
    let job;
    try { job = await api(`/api/intel/job/${jobId}`); }
    catch (e) { setBusy(false); toast(e.message, true); return; }
    renderProgress(job);

    const terminal = job.steps.filter((s) => ["done", "skipped", "error"].includes(s.status)).length;
    if (job.video_id && terminal > state.lastTerminal) {
      state.lastTerminal = terminal;
      state.videoId = job.video_id;
      loadRecord(job.video_id, false).catch(() => {});
    }
    if (job.status === "done" || job.status === "error") {
      setBusy(false);
      if (job.status === "error") toast(job.error || "Job failed", true);
      else toast("Analysis complete.");
      if (job.video_id) await loadRecord(job.video_id, true, doneTab);
      loadHistory();
      return;
    }
    state.poll = setTimeout(tick, 1000);
  };
  tick();
}
function renderProgress(job) {
  $("#progressFill").style.width = job.progress + "%";
  $("#progressPct").textContent = job.progress + "%";
  $("#progressTitle").textContent =
    job.status === "running" ? "Running…" : job.status === "done" ? "Done" : job.status === "error" ? "Error" : "Queued";
  const icons = { pending: "•", running: "↻", done: "✓", error: "!", skipped: "–" };
  $("#steps").innerHTML = job.steps.map((s) =>
    `<li class="s-${s.status}"><span class="step-icon">${icons[s.status] || "•"}</span>
       <span class="step-name">${escapeHtml(s.label)}</span>
       <span class="step-detail">${escapeHtml(s.detail || "")}</span></li>`).join("");
  $("#log").textContent = (job.logs || []).join("\n");
  $("#log").scrollTop = $("#log").scrollHeight;
}

// ------------------------------------------------------------- load + render
async function loadRecord(videoId, switchTabFlag, doneTab) {
  let rec;
  try { rec = await api(`/api/intel/video/${videoId}`); } catch (_) { return; }
  state.videoId = videoId;
  state.record = rec;
  renderMeta(rec.metadata);
  renderTranscript(rec.transcript);
  renderComments(rec.comments);
  renderClips(rec.clips, rec.metadata);
  renderFrames(rec.frames);
  renderOutputs(rec.outputs);
  renderExport(videoId, rec.outputs);
  if (switchTabFlag && doneTab) switchTab(doneTab);
}

function renderMeta(m) {
  if (!m) return;
  const panel = $("#metaPanel");
  const stats = [
    ["Views", fmtNum(m.view_count)], ["Likes", fmtNum(m.like_count)],
    ["Duration", fmtTime(m.duration)], ["Comments", fmtNum(m.comment_count)],
  ];
  panel.innerHTML = `
    ${m.thumbnail ? `<img class="thumb" src="${escapeHtml(m.thumbnail)}" alt="" />` : ""}
    <div class="meta-body">
      <div class="meta-title"><a href="${escapeHtml(m.url)}" target="_blank">${escapeHtml(m.title || "")}</a></div>
      <div class="meta-channel">${escapeHtml(m.channel || "")} ${m.upload_date ? "· " + m.upload_date : ""}</div>
      <div class="badges">
        ${m.is_short ? '<span class="badge short">Short</span>' : '<span class="badge">Long-form</span>'}
        ${m.was_live ? '<span class="badge">Was live</span>' : ""}
        ${m.language ? `<span class="badge">${escapeHtml(m.language)}</span>` : ""}
        ${m.has_captions ? '<span class="badge">Captions</span>' : (m.has_auto_captions ? '<span class="badge">Auto-captions</span>' : "")}
      </div>
      <div class="stats">${stats.map(([k, v]) => `<div class="stat"><div class="k">${k}</div><div class="v">${v}</div></div>`).join("")}</div>
      ${m.chapters?.length ? `<div class="meta-section"><h4>Chapters</h4>${m.chapters.map((c) =>
        `<div class="chapter" onclick="openAt(${c.start || 0})"><span class="t">${fmtTime(c.start)}</span><span>${escapeHtml(c.title || "")}</span></div>`).join("")}</div>` : ""}
      ${(m.hashtags?.length || m.tags?.length) ? `<div class="meta-section"><h4>Tags</h4><div class="taglist">${
        [...(m.hashtags || []), ...(m.tags || []).slice(0, 12)].map((t) => `<span class="tag">${escapeHtml(t)}</span>`).join("")}</div></div>` : ""}
    </div>`;
}

function renderTranscript(t) {
  const el = $("#transcript");
  if (!t || !t.segments?.length) { el.className = "transcript empty"; el.textContent = "No transcript yet."; $("#transcriptMeta").textContent = ""; return; }
  el.className = "transcript";
  $("#transcriptMeta").textContent = `${t.segments.length} segments · ${t.source}${t.language ? " · " + t.language : ""}`;
  el.innerHTML = t.segments.map((s) =>
    `<div class="tline"><span class="t" onclick="openAt(${s.start})">${fmtTime(s.start)}</span><span class="x">${escapeHtml(s.text)}</span></div>`).join("");
}

function renderComments(c) {
  const el = $("#comments");
  const ins = c?.insights;
  if (!ins || (!ins.available && !(ins.most_replayed || []).length)) {
    el.className = "comments empty"; el.textContent = "No comment analysis yet."; return;
  }
  el.className = "comments";
  const list = (arr, fn) => (arr && arr.length) ? `<ul>${arr.slice(0, 8).map(fn).join("")}</ul>` : '<div class="muted">—</div>';
  const tsItem = (t) => `<li><span class="ts-pill" onclick="openAt(${t.time})">${t.time_str}</span> · ${escapeHtml(String(t.mentions))} mentions${t.example ? " — " + escapeHtml(t.example.slice(0, 80)) : ""}</li>`;
  el.innerHTML = `
    <div class="ins-box">
      <h4>Audience reaction <span class="senti ${escapeHtml(ins.overall_sentiment || "")}">${escapeHtml(ins.overall_sentiment || "")}</span></h4>
      <div>${escapeHtml(ins.summary || "")}</div>
    </div>
    <div class="ins-grid">
      <div class="ins-box"><h4>🔥 Most replayed</h4>${list(ins.most_replayed, (r) => `<li><span class="ts-pill" onclick="openAt(${r.time})">${r.time_str}</span> · intensity ${r.intensity ?? ""}</li>`)}</div>
      <div class="ins-box"><h4>💬 Most-mentioned timestamps</h4>${list(ins.mentioned_timestamps, tsItem)}</div>
      <div class="ins-box"><h4>❓ Questions</h4>${list(ins.questions, (q) => `<li>${escapeHtml(typeof q === "string" ? q : JSON.stringify(q))}</li>`)}</div>
      <div class="ins-box"><h4>😂 Funny moments</h4>${list(ins.funny_moments, (q) => `<li>${escapeHtml(q)}</li>`)}</div>
      <div class="ins-box"><h4>⚡ Controversial</h4>${list(ins.controversial, (q) => `<li>${escapeHtml(q)}</li>`)}</div>
      <div class="ins-box"><h4>✂️ Clip requests</h4>${list(ins.clip_requests, (q) => `<li>${escapeHtml(q)}</li>`)}</div>
      <div class="ins-box"><h4>🏷️ Top topics</h4>${list(ins.top_topics, (q) => `<li>${escapeHtml(q.topic ? q.topic + (q.detail ? " — " + q.detail : "") : q)}</li>`)}</div>
    </div>`;
}

function scoreClass(v) { return v >= 75 ? "score-hi" : v >= 50 ? "score-mid" : "score-lo"; }
function renderClips(clips, meta) {
  renderTimeline(clips, meta);
  const el = $("#clips");
  if (!clips?.length) { el.className = "clips empty"; el.innerHTML = "No clips yet. Click <b>Find Clips</b> or run a full analysis."; return; }
  el.className = "clips";
  el.innerHTML = clips.map((c) => `
    <div class="clip-card">
      <div class="clip-top">
        <div><div class="clip-title">${escapeHtml(c.title || "Clip")}</div>
          <div class="clip-time"><a href="${ytLink(c.start)}" target="_blank">${c.start_str} – ${c.end_str}</a> · ${Math.round(c.duration)}s</div></div>
        <div class="score ${scoreClass(c.viral_score)}">${c.viral_score}</div>
      </div>
      <div class="clip-meta">
        ${c.reason ? `<div><span class="lab">Why:</span>${escapeHtml(c.reason)}</div>` : ""}
        ${c.hook ? `<div><span class="lab">Hook:</span>${escapeHtml(c.hook)}</div>` : ""}
        ${c.caption ? `<div><span class="lab">Caption:</span>${escapeHtml(c.caption)}</div>` : ""}
        ${c.edit_style ? `<div><span class="lab">Edit:</span>${escapeHtml(c.edit_style)}</div>` : ""}
      </div>
      <div class="clip-foot">
        <span class="plat-tag">${escapeHtml(c.platform || "")}</span>
        <button class="btn tiny" onclick="openAt(${c.start})">▶ Watch</button>
      </div>
    </div>`).join("");
}
function renderTimeline(clips, meta) {
  const tl = $("#timeline");
  const dur = meta?.duration || 0;
  if (!dur) { tl.innerHTML = ""; return; }
  const ins = state.record?.comments?.insights || {};
  const frames = state.record?.frames || [];
  const mark = (t, cls) => `<div class="tl-mark ${cls}" style="left:${(t / dur) * 100}%" title="${fmtTime(t)}"></div>`;
  let marks = "";
  (ins.most_replayed || []).forEach((r) => (marks += mark(r.time, "replay")));
  (ins.mentioned_timestamps || []).forEach((t) => (marks += mark(t.time, "comment")));
  frames.filter((f) => f.scene_change).forEach((f) => (marks += mark(f.timestamp, "scene")));
  const segs = (clips || []).map((c) =>
    `<div class="tl-clip" style="left:${(c.start / dur) * 100}%;width:${Math.max(0.6, ((c.end - c.start) / dur) * 100)}%"
       title="${escapeHtml(c.title || "")} (${c.start_str}-${c.end_str})" onclick="openAt(${c.start})"></div>`).join("");
  tl.innerHTML = segs + marks + '<div class="tl-axis"></div>';
  $("#panel-clips").querySelector(".tl-legend")?.remove();
  const legend = document.createElement("div");
  legend.className = "tl-legend";
  legend.innerHTML = '<span><i style="background:#3ea6ff"></i>Clip</span><span><i style="background:#ff3b30"></i>Most replayed</span><span><i style="background:#2dd4bf"></i>Comment hotspot</span><span><i style="background:#8a63d2"></i>Scene change</span>';
  tl.after(legend);
}

function renderFrames(frames) {
  const el = $("#frames");
  if (!frames?.length) { el.className = "frames empty"; el.innerHTML = "No frames yet. Click <b>Extract Frames</b>."; return; }
  el.className = "frames";
  el.innerHTML = frames.map((f) => {
    const v = f.vision || {};
    const cap = v.caption || (f.scene_change ? "Scene change" : "");
    return `<div class="frame ${f.scene_change ? "scene" : ""}">
      <img src="${escapeHtml(f.url)}" loading="lazy" onclick="openAt(${f.timestamp})" title="${escapeHtml(v.on_screen_text || "")}" />
      <div class="cap"><span class="t">${f.time_str}</span> ${escapeHtml(cap)}</div></div>`;
  }).join("");
}

function renderOutputs(outputs) {
  const el = $("#output");
  if (!outputs?.length) { el.className = "markdown empty"; el.innerHTML = "Run an analysis or click <b>Generate Output</b>."; $("#outputTitle").textContent = "Output"; return; }
  const o = outputs[0];
  state.currentOutput = o.content || "";
  $("#outputTitle").textContent = (o.meta?.label || o.mode || "Output") + (o.prompt ? ` — “${o.prompt}”` : "");
  el.className = "markdown";
  el.innerHTML = mdToHtml(o.content || "");
}

function renderExport(videoId, outputs) {
  const fmts = [["json", "JSON"], ["csv", "CSV"], ["txt", "TXT"], ["md", "Markdown"], ["srt", "SRT subtitles"], ["timeline", "Timeline notes"]];
  $("#exportButtons").innerHTML = fmts.map(([f, label]) =>
    `<a class="btn" href="/api/intel/export/${videoId}?fmt=${f}" download>${label}</a>`).join("");
  const list = $("#outputsList");
  list.innerHTML = (outputs || []).map((o) =>
    `<li data-id="${o.id}">${escapeHtml(o.meta?.label || o.mode)} — <span class="muted">${escapeHtml(o.prompt || "")}</span></li>`).join("")
    || '<li class="muted">No generated outputs yet.</li>';
  $$("#outputsList li[data-id]").forEach((li) => li.onclick = () => {
    const o = (outputs || []).find((x) => String(x.id) === li.dataset.id);
    if (o) { state.currentOutput = o.content; $("#outputTitle").textContent = (o.meta?.label || o.mode); $("#output").className = "markdown"; $("#output").innerHTML = mdToHtml(o.content); switchTab("output"); }
  });
}

// ------------------------------------------------------------- history / health
async function loadHistory() {
  let vids;
  try { vids = await api("/api/intel/videos"); } catch (_) { return; }
  $("#history").innerHTML = vids.map((v) =>
    `<li data-id="${v.video_id}"><img src="${escapeHtml(v.thumbnail || "")}" alt="" />
      <div><div class="h-title">${escapeHtml(v.title || v.video_id)}</div>
      <div class="h-sub">${escapeHtml(v.channel || "")} · ${fmtTime(v.duration)}</div></div></li>`).join("")
    || '<li class="muted">Nothing analyzed yet.</li>';
  $$("#history li[data-id]").forEach((li) => li.onclick = () => {
    $("#url").value = "https://www.youtube.com/watch?v=" + li.dataset.id;
    loadRecord(li.dataset.id, true, "output");
  });
}
async function loadHealth(prefetched) {
  let h = prefetched;
  if (!h) {
    try { h = await api("/api/intel/health"); } catch (_) { $("#health").innerHTML = '<span class="pill pill-bad"><span class="dot"></span>API offline</span>'; return; }
  }
  const o = h.ollama || {};
  state.models = o.models || [];
  const pills = [];
  // Reasoning + vision pills are clickable: they open a dropdown of installed models.
  const eff = o.effective_reasoning_model || o.reasoning_model || "?";
  const demoted = o.reasoning_demoted && eff !== o.reasoning_model;
  const rLabel = demoted
    ? `${escapeHtml(o.reasoning_model)} <span class="caret">⤵</span> ${escapeHtml(eff)}`
    : escapeHtml(o.reasoning_model || "?");
  const rClass = demoted ? "pill-warn" : (o.reasoning_available ? "pill-ok" : "pill-bad");
  const rTitle = demoted
    ? `${o.reasoning_model} needs more RAM than is free — using ${eff} for now. Click to change.`
    : "Reasoning model — click to change";
  pills.push(`<button type="button" class="pill pill-pick ${rClass}" data-kind="reasoning" title="${escapeHtml(rTitle)}"><span class="dot"></span>${rLabel}<span class="caret">▾</span></button>`);
  pills.push(`<button type="button" class="pill pill-pick ${o.vision_model ? "pill-ok" : "pill-muted"}" data-kind="vision" title="Vision model — click to change">👁 ${o.vision_model ? escapeHtml(o.vision_model) : "no vision model"}<span class="caret">▾</span></button>`);
  pills.push(`<span class="pill ${h.ffmpeg_ok ? "pill-ok" : "pill-bad"}">ffmpeg ${h.ffmpeg_ok ? "✓" : "✗"}</span>`);
  pills.push(`<span class="pill pill-muted">whisper: ${escapeHtml(h.whisper_model || "")}</span>`);
  $("#health").innerHTML = pills.join("");
  $$("#health .pill-pick").forEach((btn) => btn.onclick = (e) => {
    e.stopPropagation();
    openModelMenu(btn, btn.dataset.kind, o);
  });
}

// ------------------------------------------------------------- model picker
// Same hints the backend uses to spot a vision-capable Ollama model.
const VISION_HINTS = ["llava", "vision", "-vl", "qwen2.5vl", "qwen2-vl", "minicpm-v",
  "moondream", "bakllava", "llama3.2-vision", "gemma3", "mistral-small3"];

const menuRow = (label, val, active) =>
  `<div class="mm-item${active ? " active" : ""}" data-val="${escapeHtml(val)}">
     <span class="mm-check">${active ? "✓" : ""}</span><span class="mm-name">${escapeHtml(label)}</span></div>`;

function closeModelMenu() {
  $("#modelMenu")?.remove();
  state.modelMenuKind = null;
  document.removeEventListener("click", closeModelMenu);
  document.removeEventListener("keydown", onModelMenuKey);
}
function onModelMenuKey(e) { if (e.key === "Escape") closeModelMenu(); }

function openModelMenu(anchor, kind, o) {
  const reopen = state.modelMenuKind === kind;
  closeModelMenu();
  if (reopen) return;                     // clicking the same pill again toggles it shut
  state.modelMenuKind = kind;

  const current = kind === "vision" ? o.vision_model : o.reasoning_model;
  let list = (state.models || []).slice();
  if (kind === "vision") list = list.filter((m) => VISION_HINTS.some((hint) => m.toLowerCase().includes(hint)));

  const rows = [];
  if (kind === "vision") rows.push(menuRow("(auto-detect)", "", !o.vision_model));
  if (list.length) list.forEach((m) => rows.push(menuRow(m, m, m === current)));
  else rows.push(`<div class="mm-empty">${(state.models || []).length ? "No vision-capable models installed." : "No models found — is Ollama running?"}</div>`);

  const menu = document.createElement("div");
  menu.id = "modelMenu";
  menu.className = "model-menu";
  menu.innerHTML = `<div class="mm-head">${kind === "vision" ? "Vision model" : "Reasoning model"}</div>` + rows.join("");
  menu.onclick = (e) => e.stopPropagation();
  document.body.appendChild(menu);

  const r = anchor.getBoundingClientRect();          // topbar is sticky, so fixed positioning lines up
  menu.style.top = (r.bottom + 6) + "px";
  menu.style.left = Math.max(12, Math.min(r.left, window.innerWidth - menu.offsetWidth - 12)) + "px";

  menu.querySelectorAll(".mm-item").forEach((el) => el.onclick = () => selectModel(kind, el.dataset.val));
  setTimeout(() => {                                  // defer so this very click doesn't instantly close it
    document.addEventListener("click", closeModelMenu);
    document.addEventListener("keydown", onModelMenuKey);
  }, 0);
}

// Update just one pick-pill's label in place (used for the optimistic update).
function setPillLabel(kind, val) {
  const btn = $(`#health .pill-pick[data-kind="${kind}"]`);
  if (!btn) return;
  const dot = kind === "reasoning" ? '<span class="dot"></span>' : "";
  const text = kind === "vision" ? `👁 ${val}` : (val || "?");
  btn.innerHTML = dot + escapeHtml(text) + '<span class="caret">▾</span>';
}

async function selectModel(kind, val) {
  closeModelMenu();
  if (val) setPillLabel(kind, val);   // optimistic: reflect the choice instantly (Ollama can be slow)
  try {
    const res = await post("/api/intel/model", { kind, model: val });
    toast(val ? `${kind === "vision" ? "Vision" : "Reasoning"} model → ${val}` : "Vision model → auto-detect");
    loadHealth(res.health);           // authoritative refresh (corrects availability colour)
  } catch (e) {
    toast(e.message, true);
    loadHealth();                     // selection failed — revert pills to the real state
  }
}

// ------------------------------------------------------------- tabs / init
function switchTab(name) {
  $$(".tab").forEach((t) => t.classList.toggle("active", t.dataset.tab === name));
  $$(".panel").forEach((p) => p.classList.toggle("active", p.id === "panel-" + name));
}
function initChips() {
  const chips = ["Summarize this video", "Find the best clips for Shorts", "Find the funniest moments",
    "Make a viral TikTok script", "Find controversial moments", "Turn this into a blog post",
    "Make a tweet thread", "Give me hooks", "Extract the useful information", "Find clips under 60 seconds"];
  $("#chips").innerHTML = chips.map((c) => `<span class="chip">${c}</span>`).join("");
  $$("#chips .chip").forEach((ch) => ch.onclick = () => { $("#prompt").value = ch.textContent; $("#prompt").focus(); });
}
function init() {
  initChips();
  loadHealth();
  loadHistory();
  $("#runFull").onclick = runFull;
  $$(".btn.step").forEach((b) => b.onclick = () => runStep(b.dataset.step));
  $$(".tab").forEach((t) => t.onclick = () => switchTab(t.dataset.tab));
  $("#refreshHistory").onclick = (e) => { e.stopPropagation(); loadHistory(); };
  // Collapsible corner dock (metadata + history)
  const sidebar = $("#sidebar");
  const setCollapsed = (c) => {
    sidebar.classList.toggle("collapsed", c);
    $("#toggleSidebar").setAttribute("aria-expanded", String(!c));
    try { localStorage.setItem("yia.sidebarCollapsed", c ? "1" : "0"); } catch (_) {}
  };
  let startCollapsed = true;   // default: tucked in the corner; expand on demand
  try { const v = localStorage.getItem("yia.sidebarCollapsed"); if (v !== null) startCollapsed = v === "1"; } catch (_) {}
  setCollapsed(startCollapsed);
  $("#sidebarHead").onclick = () => setCollapsed(!sidebar.classList.contains("collapsed"));
  $("#copyOutput").onclick = () => { navigator.clipboard?.writeText(state.currentOutput || ""); toast("Output copied."); };
  $("#transcriptSearch").oninput = (e) => {
    const q = e.target.value.toLowerCase();
    $$("#transcript .tline").forEach((l) => {
      const hit = q && l.textContent.toLowerCase().includes(q);
      l.classList.toggle("hit", !!hit);
      l.style.display = (!q || hit) ? "" : "none";
    });
  };
  $("#url").addEventListener("keydown", (e) => { if (e.key === "Enter") runFull(); });
  setInterval(loadHealth, 30000);
}
document.addEventListener("DOMContentLoaded", init);
window.openAt = openAt;
