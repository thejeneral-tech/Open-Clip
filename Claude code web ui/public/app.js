"use strict";

const $ = (id) => document.getElementById(id);
const qsa = (sel, root = document) => Array.from(root.querySelectorAll(sel));

const LS_KEYS = {
  sessions: "claw.sessions.v1",
  active: "claw.activeSession.v1",
  user: "claw.user.v1",
  events: "claw.events.v1",
  recentFolders: "claw.recentFolders.v1",
  termSessions: "claw.termSessions.v1",
  activeTermSession: "claw.activeTermSession.v1",
};

const MAX_RECENT_FOLDERS = 8;

const PROVIDER_SUGGESTIONS = {
  anthropic: ["claude-opus-4-7", "claude-sonnet-4-6", "claude-haiku-4-5-20251001"],
  gemini: ["gemini-2.5-flash", "gemini-2.5-pro"],
  ollama: ["qwen3", "llama3.2", "gpt-oss", "deepseek-coder"],
};

const EFFORT_LEVELS = [
  { id: "low", label: "Low", num_predict: 128 },
  { id: "medium", label: "Medium", num_predict: 256 },
  { id: "high", label: "High", num_predict: 512 },
  { id: "extra-high", label: "Extra high", num_predict: 1024 },
  { id: "max", label: "Max", num_predict: 2048 },
];

const FAST_MODE_NUM_PREDICT = 128;
const FAST_MODE_NUM_CTX = 4096;

const TAB_DEFAULT_VIEW = {
  chat: "pure-chat",
  code: "terminal",
  models: "models",
};

const state = {
  info: null,
  busy: false,
  tab: "code", // active tab pill; drives which sidebar subsection is visible
  view: "terminal", // "terminal" | "chat" | "pure-chat" | "customize" | "models"
  activeSessionId: null,
  activeProjectId: null,
  sessions: [],
  termSessions: [], // [{ id, name, model, cwd, createdAt, updatedAt }]
  activeTermSessionId: null,
  user: { name: "there", tier: "Max", avatar: "A" },
  events: [],
  recentFolders: [], // [{ name, path, lastUsed }]
  draftConfig: null, // staged provider/model edits before Apply
  abortController: null,
  pureChat: {
    model: "",
    baseUrl: "",
    messages: [], // local mirror of pure-chat messages: { role, content }
    initialized: false,
  },
  modelPicker: {
    effort: "max",
    fastMode: false,
    ollamaModels: [], // most recent /api/ollama/probe result
  },
};

const auth = {
  authed: false,
  user: null,
  bootedPostAuth: false,
};

// ---------------- helpers ----------------

function el(tag, attrs = {}, children = []) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (value == null) continue;
    if (key === "class") node.className = value;
    else if (key === "dataset") Object.assign(node.dataset, value);
    else if (key.startsWith("on") && typeof value === "function") {
      node.addEventListener(key.slice(2), value);
    } else if (typeof value === "boolean") {
      if (value) node.setAttribute(key, "");
    } else {
      node.setAttribute(key, value);
    }
  }
  for (const child of [].concat(children)) {
    if (child == null) continue;
    node.appendChild(typeof child === "string" ? document.createTextNode(child) : child);
  }
  return node;
}

function load(key, fallback) {
  try {
    const raw = localStorage.getItem(key);
    return raw == null ? fallback : JSON.parse(raw);
  } catch {
    return fallback;
  }
}

function save(key, value) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {}
}

function uid() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

function prettyJson(value) {
  try {
    return JSON.stringify(value ?? {}, null, 2);
  } catch {
    return String(value);
  }
}

function formatNum(n) {
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + "M";
  if (n >= 1_000) return (n / 1_000).toFixed(1) + "k";
  return String(n);
}

function dateKey(d = new Date()) {
  return d.toISOString().slice(0, 10);
}

// ---------------- sessions ----------------

function loadAll() {
  state.sessions = load(LS_KEYS.sessions, []);
  state.activeSessionId = load(LS_KEYS.active, null);
  state.user = { ...state.user, ...load(LS_KEYS.user, {}) };
  state.events = load(LS_KEYS.events, []);
  state.recentFolders = load(LS_KEYS.recentFolders, []);
  state.termSessions = load(LS_KEYS.termSessions, []);
  state.activeTermSessionId = load(LS_KEYS.activeTermSession, null);
}

function saveRecentFolders() { save(LS_KEYS.recentFolders, state.recentFolders); }

function folderNameFromPath(p) {
  if (!p) return "";
  return p.replace(/[\\/]+$/, "").split(/[\\/]/).filter(Boolean).pop() || p;
}

function rememberFolder(path) {
  if (!path) return;
  const name = folderNameFromPath(path);
  const filtered = state.recentFolders.filter((f) => f.path !== path);
  filtered.unshift({ name, path, lastUsed: Date.now() });
  state.recentFolders = filtered.slice(0, MAX_RECENT_FOLDERS);
  saveRecentFolders();
}

function saveSessions() { save(LS_KEYS.sessions, state.sessions); }
function saveActive() { save(LS_KEYS.active, state.activeSessionId); }
function saveUser() { save(LS_KEYS.user, state.user); }
function saveEvents() { save(LS_KEYS.events, state.events.slice(-2000)); }

function activeSession() {
  return state.sessions.find((s) => s.id === state.activeSessionId) || null;
}

function newSession(title) {
  const session = {
    id: uid(),
    title: title || "New session",
    createdAt: Date.now(),
    updatedAt: Date.now(),
    messages: [],
  };
  state.sessions.unshift(session);
  state.activeSessionId = session.id;
  saveSessions();
  saveActive();
  return session;
}

function deleteSession(id) {
  state.sessions = state.sessions.filter((s) => s.id !== id);
  if (state.activeSessionId === id) {
    state.activeSessionId = null;
    saveActive();
  }
  saveSessions();
}

function renderSidebarSessions() {
  const list = $("recents-list");
  if (!list) return;
  list.innerHTML = "";

  // Sort by updatedAt desc — most recent first.
  const sorted = [...state.sessions].sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));

  if (sorted.length === 0) {
    list.appendChild(
      el("div", { class: "muted", style: "padding: 6px 12px; font-size: 11px;" }, "No chats yet"),
    );
    return;
  }

  for (const s of sorted) {
    list.appendChild(renderSessionRow(s, s.id === state.activeSessionId));
  }
}

function chatBubbleIcon() {
  // Outline speech-bubble matching the screenshot.
  const ns = "http://www.w3.org/2000/svg";
  const svg = document.createElementNS(ns, "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("width", "14");
  svg.setAttribute("height", "14");
  svg.setAttribute("fill", "none");
  svg.setAttribute("stroke", "currentColor");
  svg.setAttribute("stroke-width", "2");
  svg.setAttribute("stroke-linecap", "round");
  svg.setAttribute("stroke-linejoin", "round");
  svg.setAttribute("class", "session-icon");
  const path = document.createElementNS(ns, "path");
  path.setAttribute(
    "d",
    "M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5z",
  );
  svg.appendChild(path);
  return svg;
}

function renderSessionRow(session, isActive) {
  const row = el("button", { class: `session-row ${isActive ? "active" : ""}`, type: "button" });
  row.appendChild(chatBubbleIcon());
  row.appendChild(el("span", { class: "session-title" }, session.title || "Untitled"));
  row.addEventListener("click", () => {
    if (state.activeSessionId !== session.id) {
      activateSession(session.id);
    } else {
      switchView("chat");
    }
  });
  const del = el("span", { class: "session-delete", title: "Delete" }, "×");
  del.addEventListener("click", (e) => {
    e.stopPropagation();
    deleteSession(session.id);
    renderSidebarSessions();
    if (!activeSession()) switchView("terminal");
  });
  row.appendChild(del);
  return row;
}

function truncate(s, n) {
  if (!s) return "";
  return s.length <= n ? s : s.slice(0, n - 1) + "…";
}

function activateSession(id) {
  state.activeSessionId = id;
  saveActive();
  renderSidebarSessions();
  renderChat();
  switchView("chat");
  renderContextMeter();
  // Clear the backend agent so its server-side context matches the client's view.
  fetch("/api/clear", { method: "POST" }).catch(() => {});
  // Replay messages as user/system prompts? The backend would lose context — that's a known
  // limitation; the client view shows the prior conversation, but new turns start fresh.
}

// ---------------- terminal sessions ----------------
// These persist in localStorage so the sidebar list survives a refresh. The live
// PTY process lives on the server (keyed by the same id) and is reattached on reload.

function saveTermSessions() { save(LS_KEYS.termSessions, state.termSessions); }
function saveActiveTermSession() { save(LS_KEYS.activeTermSession, state.activeTermSessionId); }

function activeTermSession() {
  return state.termSessions.find((s) => s.id === state.activeTermSessionId) || null;
}

function termSessionName(cwd) {
  return folderNameFromPath(cwd) || "Terminal";
}

function newTermSession({ model, cwd } = {}) {
  const session = {
    id: uid(),
    name: termSessionName(cwd),
    model: model || "",
    cwd: cwd || "",
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };
  state.termSessions.unshift(session);
  state.activeTermSessionId = session.id;
  saveTermSessions();
  saveActiveTermSession();
  return session;
}

function updateTermSession(id, patch) {
  const s = state.termSessions.find((x) => x.id === id);
  if (!s) return;
  Object.assign(s, patch, { updatedAt: Date.now() });
  saveTermSessions();
}

function deleteTermSession(id) {
  state.termSessions = state.termSessions.filter((s) => s.id !== id);
  if (state.activeTermSessionId === id) {
    state.activeTermSessionId = null;
    saveActiveTermSession();
  }
  saveTermSessions();
  // Kill the live process too, so removing the entry actually frees it.
  fetch(`/api/pty/${id}/kill`, { method: "POST" }).catch(() => {});
}

function terminalSessionIcon() {
  const ns = "http://www.w3.org/2000/svg";
  const svg = document.createElementNS(ns, "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("width", "14");
  svg.setAttribute("height", "14");
  svg.setAttribute("fill", "none");
  svg.setAttribute("stroke", "currentColor");
  svg.setAttribute("stroke-width", "2");
  svg.setAttribute("stroke-linecap", "round");
  svg.setAttribute("stroke-linejoin", "round");
  svg.setAttribute("class", "session-icon");
  const rect = document.createElementNS(ns, "rect");
  rect.setAttribute("x", "3"); rect.setAttribute("y", "4");
  rect.setAttribute("width", "18"); rect.setAttribute("height", "16"); rect.setAttribute("rx", "2");
  const path = document.createElementNS(ns, "path");
  path.setAttribute("d", "m7 9 3 3-3 3M14 15h3");
  svg.appendChild(rect); svg.appendChild(path);
  return svg;
}

function renderTermSessions() {
  const list = $("term-sessions-list");
  if (!list) return;
  list.innerHTML = "";
  const sorted = [...state.termSessions].sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
  if (!sorted.length) {
    list.appendChild(
      el("div", { class: "muted", style: "padding: 6px 12px; font-size: 11px;" }, "No sessions yet"),
    );
    return;
  }
  for (const s of sorted) {
    list.appendChild(renderTermSessionRow(s, s.id === state.activeTermSessionId));
  }
}

function renderTermSessionRow(session, isActive) {
  const row = el("button", { class: `session-row ${isActive ? "active" : ""}`, type: "button" });
  row.appendChild(terminalSessionIcon());
  row.appendChild(el("span", { class: "session-title", title: session.cwd || "" }, session.name || "Terminal"));
  row.addEventListener("click", () => openTermSession(session.id));
  const del = el("span", { class: "session-delete", title: "Close session" }, "×");
  del.addEventListener("click", (e) => {
    e.stopPropagation();
    const wasActive = state.activeTermSessionId === session.id;
    deleteTermSession(session.id);
    renderTermSessions();
    if (wasActive) { teardownCodeTerminal(); resetTerminalToLaunch(); }
  });
  row.appendChild(del);
  return row;
}

// ---------------- views ----------------

function switchTab(tab) {
  if (!TAB_DEFAULT_VIEW[tab]) return;
  state.tab = tab;
  // Swap sidebar subsection.
  for (const sub of qsa(".sidebar-subsection")) {
    sub.hidden = sub.dataset.subsection !== tab;
  }
  // Update tab pill active state.
  for (const btn of qsa(".mode-tab[data-tab]")) {
    btn.classList.toggle("active", btn.dataset.tab === tab);
  }
  // Drop into this tab's default view.
  switchView(TAB_DEFAULT_VIEW[tab]);
}

function switchView(view) {
  state.view = view;
  for (const v of ["chat", "pure-chat", "customize", "models", "terminal"]) {
    const node = $(`view-${v}`);
    if (node) node.hidden = v !== view;
  }
  for (const btn of qsa("[data-view]")) {
    btn.classList.toggle("active", btn.dataset.view === view);
  }
  if (view === "customize") {
    populateCustomize();
  } else if (view === "pure-chat") {
    initPureChat();
  } else if (view === "models") {
    if (typeof refreshModelsView === "function") refreshModelsView();
  } else if (view === "terminal") {
    enterCodeTerminal();
  } else if (view === "chat") {
    // When entering the Code (agent) view explicitly, render the active session's
    // history. Skip mid-stream to avoid wiping the in-progress assistant block.
    if (!state.busy) renderChat();
  }
  // The terminal view captures keystrokes directly, so hide the chat composer there.
  const composerWrap = document.querySelector(".composer-wrap");
  if (composerWrap) composerWrap.style.display = view === "terminal" ? "none" : "";
  updateComposerForView();
}

function updateComposerForView() {
  const input = $("prompt-input");
  if (!input) return;
  if (state.view === "pure-chat") {
    input.placeholder = "Message Ollama…";
  } else if (state.view === "chat") {
    input.placeholder = "Describe a coding task — the agent can read, write, search, and run commands";
  } else {
    input.placeholder = "Describe a task or ask a question";
  }
}

// ---------------- chat ----------------

function renderChat() {
  const messages = $("messages");
  messages.innerHTML = "";
  const session = activeSession();
  if (!session) return;
  for (const msg of session.messages) {
    if (msg.kind === "text") {
      addMessageNode(msg.role, msg.content);
    } else if (msg.kind === "tool") {
      const card = addToolCardNode({
        id: msg.id,
        name: msg.name,
        input: msg.input,
      });
      card.setResult(msg.result || "", msg.isError);
    }
  }
  scrollToBottom();
}

function addMessageNode(role, content) {
  const wrap = el("div", { class: `message ${role}` }, [
    el("div", { class: "content" }, content),
  ]);
  $("messages").appendChild(wrap);
  scrollToBottom();
  return wrap;
}

function summarizeToolCall(name, input) {
  const i = input || {};
  switch (name) {
    case "list_files": {
      const p = (typeof i.path === "string" && i.path) || ".";
      return `Listed files in ${p}`;
    }
    case "read_file": {
      const p = (typeof i.path === "string" && i.path) || "a file";
      return `Read ${p}`;
    }
    case "write_file": {
      const p = (typeof i.path === "string" && i.path) || "a file";
      return `Wrote ${p}`;
    }
    case "search_text": {
      const q = typeof i.pattern === "string" ? i.pattern : (typeof i.query === "string" ? i.query : "");
      return q ? `Searched for "${truncate(q, 40)}"` : "Searched";
    }
    case "run_shell": {
      const c = typeof i.command === "string" ? i.command : "";
      return c ? `Ran \`${truncate(c, 60)}\`` : "Ran a command";
    }
    default:
      return name || "Used a tool";
  }
}

function addToolCardNode(toolUse) {
  const summary = summarizeToolCall(toolUse.name, toolUse.input);

  const inputCode = el("pre", { class: "tool-code" }, prettyJson(toolUse.input));
  const resultCode = el("pre", { class: "tool-code" }, "running…");

  const body = el("div", { class: "tool-body" }, [
    el("div", { class: "tool-section" }, [el("span", { class: "tool-label" }, "input"), inputCode]),
    el("div", { class: "tool-section" }, [el("span", { class: "tool-label" }, "result"), resultCode]),
  ]);
  body.hidden = true;

  const summaryEl = el("span", { class: "tool-line-summary" }, summary);
  const chevron = el("span", { class: "tool-line-chev" }, "›");
  const status = el("span", { class: "tool-line-status" }, "");

  const line = el(
    "div",
    {
      class: "tool-line",
      onclick: () => {
        body.hidden = !body.hidden;
        line.classList.toggle("open", !body.hidden);
      },
    },
    [summaryEl, status, chevron],
  );

  const card = el("div", { class: "tool-card tool-card-flat", dataset: { id: toolUse.id } }, [line, body]);
  $("messages").appendChild(card);
  scrollToBottom();

  return {
    card,
    setResult(content, isError) {
      resultCode.textContent = content && content.length > 0 ? content : "(empty)";
      if (isError) {
        resultCode.classList.add("error");
        status.textContent = "error";
        status.classList.add("error");
        line.classList.add("error");
      } else {
        // success state: stay quiet (no dot), matching the flat look
        status.textContent = "";
      }
    },
  };
}

function scrollToBottom() {
  const messages = $("messages");
  if (messages) messages.scrollTop = messages.scrollHeight;
}

function recordEvent(type, extra = {}) {
  state.events.push({ type, at: Date.now(), ...extra });
  saveEvents();
}

async function sendPrompt(prompt) {
  if (state.busy) return;
  let session = activeSession();
  if (!session) {
    session = newSession(truncate(prompt, 40));
    renderSidebarSessions();
  } else if (session.messages.length === 0) {
    session.title = truncate(prompt, 40);
  }

  switchView("chat");

  state.busy = true;
  const sendBtn = $("send-btn");
  const promptInput = $("prompt-input");
  sendBtn.disabled = true;
  promptInput.disabled = true;
  setModelStatus("busy");

  session.messages.push({ kind: "text", role: "user", content: prompt });
  session.updatedAt = Date.now();
  saveSessions();
  renderSidebarSessions();

  recordEvent("user_message", { provider: state.info?.provider, model: state.info?.model });

  addMessageNode("user", prompt);

  // Turn-stats bar: icon-prefixed metrics (tokens / time / t-per-s) that sit
  // at the bottom of the messages list and freeze when the model is done.
  // An action toolbar (copy / edit / retry / delete) appears below the bar
  // after the turn finishes.
  const turnStart = Date.now();
  let charCount = 0;        // running text length used to estimate tokens
  let finalTokens = null;   // when set, the bar stops auto-updating

  const svgIcon = (paths, opts = {}) => {
    const ns = "http://www.w3.org/2000/svg";
    const svg = document.createElementNS(ns, "svg");
    svg.setAttribute("viewBox", "0 0 24 24");
    svg.setAttribute("width", String(opts.size || 14));
    svg.setAttribute("height", String(opts.size || 14));
    svg.setAttribute("fill", opts.fill || "none");
    svg.setAttribute("stroke", opts.stroke || "currentColor");
    svg.setAttribute("stroke-width", String(opts.strokeWidth || 1.8));
    svg.setAttribute("stroke-linecap", "round");
    svg.setAttribute("stroke-linejoin", "round");
    for (const d of [].concat(paths)) {
      const p = document.createElementNS(ns, "path");
      p.setAttribute("d", d);
      svg.appendChild(p);
    }
    return svg;
  };

  // Chip / memory glyph for the token count.
  const chipIcon = () => svgIcon([
    "M7 4h10a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2z",
    "M9 8h6M9 12h6M9 16h4",
    "M3 8h2M3 12h2M3 16h2M19 8h2M19 12h2M19 16h2",
  ]);
  // Clock for time.
  const clockIcon = () => svgIcon([
    "M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18z",
    "M12 7v5l3 2",
  ]);
  // Speedometer / gauge for tokens-per-second.
  const gaugeIcon = () => svgIcon([
    "M3 13a9 9 0 1 1 18 0",
    "M12 13l5-4",
    "M12 13a1.5 1.5 0 1 0 0 3 1.5 1.5 0 0 0 0-3z",
  ]);

  const turnStats = el("div", { class: "turn-stats thinking-active" }, [
    el("span", { class: "turn-stats-metric" }, [
      el("span", { class: "turn-stats-icon" }, chipIcon()),
      el("span", { class: "turn-stats-tokens" }, "0 tokens"),
    ]),
    el("span", { class: "turn-stats-metric" }, [
      el("span", { class: "turn-stats-icon" }, clockIcon()),
      el("span", { class: "turn-stats-time" }, "0s"),
    ]),
    el("span", { class: "turn-stats-metric" }, [
      el("span", { class: "turn-stats-icon" }, gaugeIcon()),
      el("span", { class: "turn-stats-rate" }, "0.00 t/s"),
    ]),
  ]);
  $("messages").appendChild(turnStats);
  scrollToBottom();

  // Action toolbar — hidden until the turn completes successfully.
  const copyIcon = () => svgIcon([
    "M9 9h9a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H9a2 2 0 0 1-2-2v-9a2 2 0 0 1 2-2z",
    "M5 15V5a2 2 0 0 1 2-2h10",
  ]);
  const editIcon = () => svgIcon([
    "M4 20h4l10-10-4-4L4 16v4z",
    "M14 6l4 4",
  ]);
  const retryIcon = () => svgIcon([
    "M4 12a8 8 0 0 1 13.7-5.7L21 8",
    "M21 3v5h-5",
    "M20 12a8 8 0 0 1-13.7 5.7L3 16",
    "M3 21v-5h5",
  ]);
  const trashIcon = () => svgIcon([
    "M4 7h16",
    "M10 11v6M14 11v6",
    "M6 7l1 12a2 2 0 0 0 2 2h6a2 2 0 0 0 2-2l1-12",
    "M9 7V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v3",
  ]);

  const actionBtn = (icon, title, onClick) => {
    const b = el("button", { class: "turn-action-btn", type: "button", title }, [icon]);
    b.addEventListener("click", onClick);
    return b;
  };

  const turnActions = el("div", { class: "turn-actions", hidden: true }, [
    actionBtn(copyIcon(), "Copy response", () => {
      navigator.clipboard?.writeText(assistantText || "").catch(() => {});
    }),
    actionBtn(editIcon(), "Edit prompt", () => {
      const input = $("prompt-input");
      if (input) {
        input.value = prompt;
        input.focus();
      }
    }),
    actionBtn(retryIcon(), "Retry", () => {
      if (state.busy) return;
      sendPrompt(prompt);
    }),
    actionBtn(trashIcon(), "Delete turn", () => {
      const s = activeSession();
      if (!s) return;
      // Remove the most recent user turn and everything after it.
      for (let i = s.messages.length - 1; i >= 0; i--) {
        const m = s.messages[i];
        if (m.kind === "text" && m.role === "user") {
          s.messages = s.messages.slice(0, i);
          break;
        }
      }
      saveSessions();
      renderChat();
      renderContextMeter();
    }),
  ]);
  $("messages").appendChild(turnActions);

  // Keep the stats bar (and its sibling action row) at the bottom of the
  // messages list as new content is appended.
  const pinStatsToBottom = () => {
    const messages = $("messages");
    if (turnStats.parentNode === messages) messages.appendChild(turnStats);
    if (turnActions.parentNode === messages) messages.appendChild(turnActions);
  };

  const formatTurnDuration = (ms) => {
    const s = Math.floor(ms / 1000);
    if (s < 60) return `${s}s`;
    const m = Math.floor(s / 60);
    const rem = s % 60;
    return rem === 0 ? `${m}m` : `${m}m ${rem}s`;
  };

  const refreshTurnStats = () => {
    const elapsedMs = Date.now() - turnStart;
    const tokens = finalTokens ?? Math.round(charCount / 4);
    const secs = elapsedMs / 1000;
    const tps = secs > 0 ? Math.max(0, tokens / secs) : 0;
    turnStats.querySelector(".turn-stats-time").textContent = formatTurnDuration(elapsedMs);
    turnStats.querySelector(".turn-stats-tokens").textContent = `${formatNum(tokens)} tokens`;
    turnStats.querySelector(".turn-stats-rate").textContent = `${tps.toFixed(2)} t/s`;
  };
  const tickHandle = setInterval(refreshTurnStats, 250);

  const stopTurnStats = () => {
    clearInterval(tickHandle);
    turnStats.classList.remove("thinking-active");
    refreshTurnStats();
    // Reveal the action toolbar once we have a finalised turn.
    if (turnActions) {
      turnActions.hidden = false;
      pinStatsToBottom();
    }
  };

  // Kept for backwards-compat with existing call sites: removing "thinking"
  // now means stopping the live ticker and leaving the stats bar in place.
  const removeThinking = () => {
    /* no-op — the stats bar replaces the old "thinking…" placeholder and is
       finalised by stopTurnStats() once the turn completes or errors. */
  };

  const toolCards = new Map();
  let assistantBlock = null;
  let assistantText = "";
  const toolRecords = new Map();

  try {
    const response = await fetch("/api/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ prompt }),
    });

    if (!response.ok || !response.body) {
      stopTurnStats();
      const body = await response.json().catch(() => ({ error: `HTTP ${response.status}` }));
      addMessageNode("error", body.error || "Request failed");
      session.messages.push({ kind: "text", role: "error", content: body.error || "Request failed" });
      saveSessions();
      return;
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";

    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      let idx;
      while ((idx = buffer.indexOf("\n\n")) !== -1) {
        const chunk = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 2);
        const lines = chunk.split("\n");
        let eventName = "message";
        const dataParts = [];
        for (const line of lines) {
          if (line.startsWith("event: ")) eventName = line.slice("event: ".length).trim();
          else if (line.startsWith("data: ")) dataParts.push(line.slice("data: ".length));
        }
        if (dataParts.length === 0) continue;
        let payload;
        try { payload = JSON.parse(dataParts.join("\n")); } catch { continue; }

        removeThinking();

        if (eventName === "tool_use") {
          const card = addToolCardNode(payload);
          toolCards.set(payload.id, card);
          toolRecords.set(payload.id, {
            kind: "tool",
            id: payload.id,
            name: payload.name,
            input: payload.input,
          });
          // Count tool-call input toward the running token estimate.
          try { charCount += JSON.stringify(payload.input || {}).length; } catch {}
          pinStatsToBottom();
        } else if (eventName === "tool_result") {
          const card = toolCards.get(payload.id);
          if (card) card.setResult(payload.content || "", payload.isError);
          const rec = toolRecords.get(payload.id);
          if (rec) {
            rec.result = payload.content || "";
            rec.isError = !!payload.isError;
          }
          if (typeof payload.content === "string") charCount += payload.content.length;
          pinStatsToBottom();
        } else if (eventName === "text") {
          assistantText = payload.text || "";
          charCount = assistantText.length;
          if (!assistantBlock) {
            assistantBlock = addMessageNode("assistant", assistantText);
          } else {
            assistantBlock.querySelector(".content").textContent = assistantText;
            scrollToBottom();
          }
          pinStatsToBottom();
          refreshTurnStats();
        } else if (eventName === "done") {
          if (payload.text) {
            assistantText = payload.text;
            charCount = assistantText.length;
            if (!assistantBlock) assistantBlock = addMessageNode("assistant", assistantText);
            else assistantBlock.querySelector(".content").textContent = assistantText;
            scrollToBottom();
          } else if (!assistantBlock) {
            addMessageNode("assistant", "(no response)");
            assistantText = "(no response)";
          }
          // Prefer the server's reported token count when available.
          if (typeof payload.tokens === "number") finalTokens = payload.tokens;
          pinStatsToBottom();
          stopTurnStats();
        } else if (eventName === "error") {
          addMessageNode("error", payload.message || "Unknown error");
          session.messages.push({ kind: "text", role: "error", content: payload.message || "Unknown error" });
          pinStatsToBottom();
          stopTurnStats();
        }
      }
    }

    // persist tool records in order, then final assistant text
    for (const rec of toolRecords.values()) {
      session.messages.push(rec);
    }
    if (assistantText) {
      session.messages.push({ kind: "text", role: "assistant", content: assistantText });
    }
    session.updatedAt = Date.now();
    saveSessions();
    recordEvent("assistant_message", { provider: state.info?.provider, model: state.info?.model });
    setModelStatus("ok");
    renderContextMeter();
  } catch (error) {
    stopTurnStats();
    addMessageNode("error", error?.message || String(error));
    setModelStatus("error");
  } finally {
    stopTurnStats();
    state.busy = false;
    sendBtn.disabled = false;
    promptInput.disabled = false;
    promptInput.value = "";
    promptInput.focus();
  }
}

// ---------------- backend info ----------------

async function fetchInfo() {
  try {
    const res = await fetch("/api/info");
    const data = await res.json();
    state.info = data;
    if (data?.cwd) rememberFolder(data.cwd);
    updateModelButton();
    updateContextPills();
    updateChatModeButton();
    setModelStatus(data.ready ? "ok" : data.error ? "error" : "warn");
  } catch {
    setModelStatus("error");
  }
}

function updateChatModeButton() {
  const btn = $("chat-mode-btn");
  const label = $("chat-mode-label");
  if (!btn || !label) return;
  const mode = state.info?.chatMode === "lightweight" ? "lightweight" : "cli";
  const proxy = state.info?.proxy || null;
  const proxyError = state.info?.proxyError || null;
  btn.dataset.mode = mode;
  if (mode === "cli") {
    label.textContent = proxy ? `CLI · ${proxy.provider}` : "CLI agent";
    if (proxyError) {
      btn.title = `CLI mode, but compat proxy failed: ${proxyError}`;
    } else if (proxy) {
      btn.title = `CLI agent routed through the ${proxy.provider} compat proxy at ${proxy.baseUrl}. Click to switch to the lite agent.`;
    } else {
      btn.title =
        "Using the bundled CLI — full tool set. Click to switch to the lite agent.";
    }
  } else {
    label.textContent = "Lite agent";
    btn.title = "Using the lightweight built-in agent. Click to switch to the CLI.";
  }
}

async function toggleChatMode() {
  const current = state.info?.chatMode === "lightweight" ? "lightweight" : "cli";
  const next = current === "cli" ? "lightweight" : "cli";
  try {
    const res = await fetch("/api/chat/mode", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ mode: next }),
    });
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      console.warn("Failed to switch chat mode:", body.error || res.status);
      return;
    }
    const data = await res.json();
    if (state.info) state.info.chatMode = data.chatMode;
    updateChatModeButton();
  } catch (err) {
    console.warn("Failed to switch chat mode:", err);
  }
}

function renderToolList(listEl, tools, emptyText) {
  listEl.innerHTML = "";
  if (!tools.length) {
    listEl.appendChild(el("div", { class: "muted" }, emptyText));
    return;
  }
  for (const tool of tools) {
    const children = [el("div", { class: "tool-name-big" }, tool.name)];
    if (tool.folder && tool.folder !== tool.name) {
      children.push(el("div", { class: "tool-folder" }, tool.folder));
    }
    children.push(el("div", { class: "tool-desc" }, tool.description || ""));
    listEl.appendChild(el("li", {}, children));
  }
}

async function fetchTools() {
  try {
    const res = await fetch("/api/tools/all");
    const data = await res.json();
    const active = Array.isArray(data.active) ? data.active : [];
    const bundled = Array.isArray(data.bundled) ? data.bundled : [];
    renderToolList($("tools-list"), active, "No active tools registered.");
    renderToolList($("tools-bundled-list"), bundled, "No bundled tools found.");
    const activeCount = $("tools-active-count");
    const bundledCount = $("tools-bundled-count");
    if (activeCount) activeCount.textContent = `(${active.length})`;
    if (bundledCount) bundledCount.textContent = `(${bundled.length})`;
    $("tools-count").textContent = String(active.length + bundled.length);
  } catch {
    /* leave previous render */
  }
}

function updateModelButton() {
  $("model-name").textContent = state.info?.model ? truncate(state.info.model, 20) : "—";
  $("model-tier-pill").textContent = state.user.tier || "";
}

function updateContextPills() {
  const cwd = state.info?.cwd || "";
  const base = cwd ? cwd.split(/[\\/]/).filter(Boolean).pop() : "—";
  $("ctx-folder-name").textContent = base || "—";
  $("ctx-folder").title = cwd || "";
  renderContextMeter();
}

function setModelStatus(level) {
  const dot = $("model-status");
  dot.classList.remove("ok", "warn", "error", "busy");
  if (level === "ok") dot.classList.add("ok");
  else if (level === "warn") dot.classList.add("warn");
  else if (level === "error") dot.classList.add("error");
  else if (level === "busy") dot.classList.add("busy");
}

// ---------------- context meter ----------------

// Best-effort defaults for the context window of common Ollama models. The
// `num_ctx` runtime override (when set) trumps these. Falls back to 32k if a
// model isn't in the table.
const MODEL_CONTEXT_DEFAULTS = [
  { match: /qwen2\.5/i, ctx: 32768 },
  { match: /qwen3/i, ctx: 32768 },
  { match: /qwen/i, ctx: 32768 },
  { match: /llama3\.2/i, ctx: 131072 },
  { match: /llama3/i, ctx: 8192 },
  { match: /gemma2/i, ctx: 8192 },
  { match: /gemma/i, ctx: 8192 },
  { match: /mistral/i, ctx: 32768 },
  { match: /phi3?\.5/i, ctx: 131072 },
  { match: /phi/i, ctx: 4096 },
  { match: /deepseek-coder-v2/i, ctx: 163840 },
  { match: /deepseek-coder/i, ctx: 16384 },
  { match: /gpt-oss/i, ctx: 131072 },
  { match: /claude-opus/i, ctx: 200000 },
  { match: /claude-sonnet/i, ctx: 200000 },
  { match: /claude-haiku/i, ctx: 200000 },
  { match: /gemini-2\.5/i, ctx: 1000000 },
  { match: /gemini/i, ctx: 1000000 },
];

function defaultContextForModel(name) {
  if (!name) return 32768;
  for (const entry of MODEL_CONTEXT_DEFAULTS) {
    if (entry.match.test(name)) return entry.ctx;
  }
  return 32768;
}

function activeContextMax() {
  // num_ctx (if overridden via the runtime) wins; otherwise use the per-model
  // default table.
  if (typeof state.runtimeNumCtx === "number" && state.runtimeNumCtx > 0) {
    return state.runtimeNumCtx;
  }
  return defaultContextForModel(state.info?.model || "");
}

function computeSessionTokenUsage(session) {
  if (!session) return 0;
  let chars = 0;
  for (const m of session.messages || []) {
    if (m.kind === "text" && typeof m.content === "string") {
      chars += m.content.length;
    } else if (m.kind === "tool") {
      if (m.input) {
        try { chars += JSON.stringify(m.input).length; } catch {}
      }
      if (typeof m.result === "string") chars += m.result.length;
    }
  }
  return Math.round(chars / 4);
}

function renderContextMeter() {
  const meterEl = $("context-meter");
  const valEl = $("context-meter-val");
  const pctEl = $("context-meter-pct");
  if (!meterEl || !valEl || !pctEl) return;

  const session = activeSession();
  const tokens = computeSessionTokenUsage(session);
  const max = activeContextMax();
  const pct = max > 0 ? Math.min(100, (tokens / max) * 100) : 0;

  valEl.textContent = `${formatNum(tokens)} / ${formatNum(max)}`;
  pctEl.textContent = `${pct < 1 && pct > 0 ? "<1" : Math.round(pct)}%`;
  meterEl.style.setProperty("--ctx-fill", `${pct}%`);

  meterEl.classList.remove("warn", "danger");
  if (pct >= 90) meterEl.classList.add("danger");
  else if (pct >= 70) meterEl.classList.add("warn");

  meterEl.title = `Context used: ${formatNum(tokens)} of ${formatNum(max)} tokens (${pct.toFixed(1)}%)`;
}

// ---------------- stats ----------------

function rangeCutoff(range) {
  if (range === "7") return Date.now() - 7 * 24 * 60 * 60 * 1000;
  if (range === "30") return Date.now() - 30 * 24 * 60 * 60 * 1000;
  return 0;
}

let currentRange = "all";

function renderStats() {
  const cutoff = rangeCutoff(currentRange);
  const events = state.events.filter((e) => e.at >= cutoff);
  const sessions = state.sessions.filter((s) => s.updatedAt >= cutoff || cutoff === 0);

  $("stat-sessions").textContent = String(sessions.length);

  let userMsgs = 0;
  let assistantMsgs = 0;
  let totalChars = 0;
  const dayMap = new Map();
  const hourMap = new Map();
  const modelMap = new Map();

  for (const e of events) {
    const d = new Date(e.at);
    const k = dateKey(d);
    dayMap.set(k, (dayMap.get(k) || 0) + 1);
    hourMap.set(d.getHours(), (hourMap.get(d.getHours()) || 0) + 1);
    if (e.type === "user_message") userMsgs++;
    if (e.type === "assistant_message") {
      assistantMsgs++;
      if (e.model) modelMap.set(e.model, (modelMap.get(e.model) || 0) + 1);
    }
  }

  for (const s of sessions) {
    for (const m of s.messages || []) {
      if (m.kind === "text" && typeof m.content === "string") totalChars += m.content.length;
      if (m.kind === "tool" && typeof m.result === "string") totalChars += m.result.length;
    }
  }

  $("stat-messages").textContent = formatNum(userMsgs + assistantMsgs);
  // Rough token estimate: ~4 chars/token.
  $("stat-tokens").textContent = formatNum(Math.round(totalChars / 4));
  $("stat-active-days").textContent = String(dayMap.size);

  const streaks = computeStreaks(dayMap);
  $("stat-current-streak").textContent = `${streaks.current}d`;
  $("stat-longest-streak").textContent = `${streaks.longest}d`;

  let peakHour = "—";
  let peakCount = 0;
  for (const [h, c] of hourMap.entries()) {
    if (c > peakCount) { peakHour = h; peakCount = c; }
  }
  $("stat-peak-hour").textContent = peakHour === "—" ? "—" : `${(peakHour % 12) || 12} ${peakHour < 12 ? "AM" : "PM"}`;

  let fav = "—";
  let favCount = 0;
  for (const [m, c] of modelMap.entries()) {
    if (c > favCount) { fav = m; favCount = c; }
  }
  $("stat-fav-model").textContent = fav === "—" ? "—" : truncate(fav, 16);

  renderHeatmap(dayMap);
  renderModelsList(modelMap);

  // Footer flavour text
  const footer = $("stats-footer");
  const tokens = Math.round(totalChars / 4);
  if (tokens > 100000) {
    const ratio = (tokens / 587287).toFixed(1); // War and Peace ≈ 587k tokens
    footer.textContent = `You've used ~${ratio}× ${ratio < 1 ? "of" : "more tokens than"} War and Peace.`;
  } else if (tokens > 0) {
    footer.textContent = `${formatNum(tokens)} tokens across ${sessions.length} session(s).`;
  } else {
    footer.textContent = "Start a conversation to begin tracking activity.";
  }
}

function computeStreaks(dayMap) {
  const today = new Date();
  let current = 0;
  let longest = 0;
  let run = 0;
  const days = Array.from(dayMap.keys()).sort();
  // longest run
  let prev = null;
  for (const k of days) {
    if (prev) {
      const diff = (new Date(k) - new Date(prev)) / (24 * 60 * 60 * 1000);
      run = diff === 1 ? run + 1 : 1;
    } else {
      run = 1;
    }
    longest = Math.max(longest, run);
    prev = k;
  }
  // current run ending today
  for (let i = 0; i < 400; i++) {
    const d = new Date(today);
    d.setDate(d.getDate() - i);
    if (dayMap.has(dateKey(d))) current++;
    else break;
  }
  return { current, longest };
}

function renderHeatmap(dayMap) {
  const heatmap = $("heatmap");
  heatmap.innerHTML = "";
  const cols = 20;
  const rows = 7;
  const total = cols * rows;
  const today = new Date();
  // populate column-by-column oldest → newest
  for (let i = total - 1; i >= 0; i--) {
    const d = new Date(today);
    d.setDate(d.getDate() - i);
    const count = dayMap.get(dateKey(d)) || 0;
    let cls = "heatmap-cell";
    if (count >= 8) cls += " l4";
    else if (count >= 4) cls += " l3";
    else if (count >= 2) cls += " l2";
    else if (count >= 1) cls += " l1";
    heatmap.appendChild(el("div", { class: cls, title: `${dateKey(d)}: ${count} event(s)` }));
  }
}

function renderModelsList(modelMap) {
  const list = $("models-list");
  list.innerHTML = "";
  if (modelMap.size === 0) {
    list.appendChild(el("div", { class: "muted" }, "No model usage recorded yet."));
    return;
  }
  const sorted = Array.from(modelMap.entries()).sort((a, b) => b[1] - a[1]);
  for (const [model, count] of sorted) {
    list.appendChild(
      el("div", { class: "model-row" }, [
        el("span", {}, model),
        el("span", { class: "count" }, `${count} turn${count === 1 ? "" : "s"}`),
      ]),
    );
  }
}

// ---------------- projects ----------------

function loadProjects() {
  const projects = load("claw.projects.v1", [
    { id: "default", name: "Default", color: "#d97757" },
  ]);
  // Migrate legacy entries: ensure each project has a createdAt timestamp.
  let migrated = false;
  for (const p of projects) {
    if (typeof p.createdAt !== "number") {
      p.createdAt = Date.now();
      migrated = true;
    }
  }
  if (migrated) saveProjects(projects);
  return projects;
}

function saveProjects(projects) {
  save("claw.projects.v1", projects);
}

const projectsView = {
  sort: "recent",       // "recent" | "name"
  searchOpen: false,
  searchQuery: "",
};

function daysAgo(ts) {
  if (!ts) return "";
  const diff = (Date.now() - ts) / 1000;
  if (diff < 60) return "just now";
  if (diff < 3600) {
    const m = Math.floor(diff / 60);
    return `${m} minute${m === 1 ? "" : "s"} ago`;
  }
  if (diff < 86400) {
    const h = Math.floor(diff / 3600);
    return `${h} hour${h === 1 ? "" : "s"} ago`;
  }
  const d = Math.floor(diff / 86400);
  if (d < 30) return `${d} day${d === 1 ? "" : "s"} ago`;
  const mo = Math.floor(d / 30);
  if (mo < 12) return `${mo} month${mo === 1 ? "" : "s"} ago`;
  const y = Math.floor(d / 365);
  return `${y} year${y === 1 ? "" : "s"} ago`;
}

function renderProjects() {
  const grid = $("projects-grid");
  if (!grid) return;
  grid.innerHTML = "";

  let projects = loadProjects();

  // Apply search filter.
  const q = projectsView.searchQuery.trim().toLowerCase();
  if (q) {
    projects = projects.filter((p) => (p.name || "").toLowerCase().includes(q));
  }

  // Apply sort.
  if (projectsView.sort === "name") {
    projects.sort((a, b) => (a.name || "").localeCompare(b.name || ""));
  } else {
    projects.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
  }

  if (projects.length === 0) {
    grid.appendChild(el("div", { class: "projects-empty" }, q ? "No matching projects." : "No projects yet. Click “New project” to add one."));
    return;
  }

  for (const p of projects) {
    const card = el("button", {
      class: `project-card${state.activeProjectId === p.id ? " active" : ""}`,
      type: "button",
      title: p.cwd || p.name,
    }, [
      el("div", { class: "project-name" }, p.name || "Untitled"),
      el("div", { class: "project-date" }, daysAgo(p.createdAt)),
    ]);
    card.addEventListener("click", () => {
      state.activeProjectId = state.activeProjectId === p.id ? null : p.id;
      renderProjects();
      filterRecentsByProject();
    });
    grid.appendChild(card);
  }
}

// ---- create-project modal ----

const PROJECT_OPTION_META = {
  scratch: {
    title: "Start from scratch",
    desc: "Set up a new project for your work. Add files later from the Artifacts view.",
  },
  import: {
    title: "Import a project",
    desc: "Group existing chats under one project. Pick the conversations to bring along.",
  },
  existing: {
    title: "Use an existing folder",
    desc: "Point TrendVault Coder at a folder you already work from. The agent's working directory will switch to this path.",
  },
};

let draftProjectOption = null;

function openProjectModal() {
  const modal = $("project-modal");
  if (!modal) return;
  resetProjectForm();
  showProjectStep("options");
  modal.hidden = false;
}

function closeProjectModal() {
  const modal = $("project-modal");
  if (!modal) return;
  modal.hidden = true;
  draftProjectOption = null;
}

function showProjectStep(step) {
  for (const node of qsa(".project-modal-step")) {
    node.hidden = node.dataset.step !== step;
  }
  if (step === "form") {
    const input = $("project-name-input");
    setTimeout(() => input?.focus(), 30);
  }
}

function startProjectOption(option) {
  if (!PROJECT_OPTION_META[option]) return;
  draftProjectOption = option;
  const meta = PROJECT_OPTION_META[option];
  $("project-form-title").textContent = meta.title;
  $("project-form-desc").textContent = meta.desc;

  // The folder picker is now offered on every option that needs a path on disk
  // — both "scratch" (the new project's folder) and "existing" (point at an
  // existing folder). Only "import" skips it since it groups existing chats.
  const needsFolder = option === "existing" || option === "scratch";
  $("project-folder-field").hidden = !needsFolder;
  $("project-import-list").hidden = option !== "import";

  if (option === "existing") {
    $("project-folder-input").value = state.info?.cwd || "";
  } else if (option === "scratch") {
    // Default to the current cwd as a starting point; user can change it.
    $("project-folder-input").value = state.info?.cwd || "";
  }
  if (option === "import") {
    renderImportSessions();
  }

  hideProjectError();
  showProjectStep("form");
}

// Open the folder picker from a project-modal context. Picks fill the
// "Folder path" input without touching the agent's CWD.
function openFolderPickerForProjectField() {
  const input = $("project-folder-input");
  const initial = (input?.value || state.info?.cwd || "").trim();
  openFolderPicker(initial, {
    title: "Pick project folder",
    confirmLabel: "Use this folder",
    onConfirm: (picked) => {
      if (input) input.value = picked;
      hideProjectError();
    },
  });
}

function renderImportSessions() {
  const container = $("project-import-sessions");
  if (!container) return;
  container.innerHTML = "";
  if (state.sessions.length === 0) {
    container.appendChild(
      el("div", { class: "muted", style: "padding: 6px 4px; font-size: 12px;" }, "No chats yet — you can create the project and add chats later."),
    );
    return;
  }
  for (const s of state.sessions) {
    const cb = el("input", { type: "checkbox", value: s.id });
    const row = el("label", { class: "project-import-row" }, [
      cb,
      el("span", { class: "import-name" }, s.title || "Untitled"),
    ]);
    container.appendChild(row);
  }
}

function resetProjectForm() {
  draftProjectOption = null;
  const name = $("project-name-input");
  const folder = $("project-folder-input");
  const importList = $("project-import-sessions");
  if (name) name.value = "";
  if (folder) folder.value = "";
  if (importList) importList.innerHTML = "";
  hideProjectError();
}

function showProjectError(message) {
  const err = $("project-error");
  if (!err) return;
  err.textContent = message;
  err.hidden = false;
}

function hideProjectError() {
  const err = $("project-error");
  if (!err) return;
  err.textContent = "";
  err.hidden = true;
}

async function createProjectFromForm() {
  const name = $("project-name-input").value.trim();
  if (!name) {
    showProjectError("Give the project a name.");
    $("project-name-input").focus();
    return;
  }

  const projects = loadProjects();
  if (projects.some((p) => p.name.toLowerCase() === name.toLowerCase())) {
    showProjectError("A project with that name already exists.");
    return;
  }

  const newId = uid();
  const project = { id: newId, name, color: "#d97757", createdAt: Date.now() };
  let cwdToApply = null;

  if (draftProjectOption === "existing") {
    const folder = $("project-folder-input").value.trim();
    if (!folder) {
      showProjectError("Pick a folder for the project.");
      $("project-folder-browse").focus();
      return;
    }
    project.cwd = folder;
    cwdToApply = folder;
  } else if (draftProjectOption === "scratch") {
    // Folder is optional for "scratch"; if provided, store it and switch CWD.
    const folder = $("project-folder-input").value.trim();
    if (folder) {
      project.cwd = folder;
      cwdToApply = folder;
    }
  } else if (draftProjectOption === "import") {
    const checkedIds = qsa("#project-import-sessions input[type='checkbox']:checked").map(
      (cb) => cb.value,
    );
    for (const sid of checkedIds) {
      const s = state.sessions.find((x) => x.id === sid);
      if (s) s.projectId = newId;
    }
    saveSessions();
  }

  projects.push(project);
  saveProjects(projects);

  // If "Use an existing folder", swap the agent's cwd to it.
  if (cwdToApply) {
    try {
      const res = await fetch("/api/config", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ cwd: cwdToApply }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        showProjectError(`Project created, but switching folder failed: ${data.error || "unknown"}`);
        await fetchInfo();
        renderProjects();
        return;
      }
      await fetchInfo();
    } catch (error) {
      showProjectError(`Project created, but switching folder failed: ${error?.message || error}`);
      renderProjects();
      return;
    }
  }

  closeProjectModal();
  renderProjects();
}

function filterRecentsByProject() {
  const list = $("recents-list");
  if (!list) return;
  list.innerHTML = "";
  const filtered = state.activeProjectId
    ? state.sessions.filter((s) => (s.projectId || "default") === state.activeProjectId)
    : state.sessions;
  const sorted = [...filtered].sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
  if (sorted.length === 0) {
    list.appendChild(
      el("div", { class: "muted", style: "padding: 6px 12px; font-size: 11px;" }, "No chats in this project"),
    );
    return;
  }
  for (const s of sorted) {
    list.appendChild(renderSessionRow(s, s.id === state.activeSessionId));
  }
}

// ---------------- customize ----------------

function populateCustomize() {
  $("customize-name").value = state.user.name === "there" ? "" : state.user.name;
  $("customize-tier").value = state.user.tier || "";
  $("customize-avatar").value = state.user.avatar || "A";
  $("customize-cwd").value = state.info?.cwd || "";
}

async function saveCustomize() {
  const name = $("customize-name").value.trim() || "there";
  const tier = $("customize-tier").value.trim();
  const avatar = ($("customize-avatar").value.trim() || name[0] || "A").toUpperCase().slice(0, 2);
  const cwd = $("customize-cwd").value.trim();

  state.user = { name, tier, avatar };
  saveUser();
  applyUser();

  if (cwd && cwd !== state.info?.cwd) {
    await fetch("/api/config", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ cwd }),
    });
    await fetchInfo();
  }
}

function applyUser() {
  $("user-name").textContent = state.user.name === "there" ? "User" : state.user.name;
  $("user-tier").textContent = state.user.tier || "";
  $("avatar").textContent = state.user.avatar || "A";
  $("model-tier-pill").textContent = state.user.tier || "";
}

// ---------------- model popover ----------------

function loadModelPickerSettings() {
  state.modelPicker.effort = load("claw.effort", "max");
  state.modelPicker.fastMode = load("claw.fastMode", false);
}

function saveModelPickerSettings() {
  save("claw.effort", state.modelPicker.effort);
  save("claw.fastMode", state.modelPicker.fastMode);
}

async function openModelPopover() {
  const btn = $("model-btn");
  const popover = $("model-popover");
  const backdrop = $("popover-backdrop");

  popover.hidden = false;
  backdrop.hidden = false;

  // Position above the model button.
  const r = btn.getBoundingClientRect();
  popover.style.visibility = "hidden";
  popover.style.right = `${window.innerWidth - r.right}px`;
  popover.style.bottom = `${window.innerHeight - r.top + 6}px`;
  popover.style.visibility = "visible";

  renderEffortRows();
  renderFastModeToggle();
  await populateModelList();
}

function closeModelPopover() {
  $("model-popover").hidden = true;
  $("popover-backdrop").hidden = true;
}

async function populateModelList() {
  const list = $("model-list");
  list.innerHTML = '<div class="popover-empty">Probing Ollama…</div>';

  const baseUrl = state.info?.baseUrl || "http://127.0.0.1:11434";
  try {
    const res = await fetch(`/api/ollama/probe?baseUrl=${encodeURIComponent(baseUrl)}`);
    const data = await res.json();
    list.innerHTML = "";

    if (!data.ok) {
      list.appendChild(el("div", { class: "popover-empty" }, data.error || "Ollama unreachable"));
      return;
    }
    if (!data.models || data.models.length === 0) {
      list.appendChild(el("div", { class: "popover-empty" }, "No models installed — run `ollama pull qwen3`"));
      return;
    }

    state.modelPicker.ollamaModels = data.models;
    const current = state.info?.model || "";

    data.models.forEach((modelName, idx) => {
      const isCurrent = modelName === current;
      const shortcut = idx < 9 ? String(idx + 1) : "";
      const row = el("button", {
        class: `popover-row${isCurrent ? " active" : ""}`,
        type: "button",
        dataset: { model: modelName },
      }, [
        el("span", { class: "row-name" }, displayModelName(modelName)),
        renderModelBadge(modelName),
        el("span", { class: "row-check" }),
        el("span", { class: "row-shortcut" }, shortcut),
      ]);
      row.addEventListener("click", () => selectModel(modelName));
      list.appendChild(row);
    });
  } catch (error) {
    list.innerHTML = "";
    list.appendChild(el("div", { class: "popover-empty" }, error?.message || "Could not reach server"));
  }
}

function displayModelName(modelName) {
  // Strip the "default" implicit tag so names look cleaner: "qwen3:latest" → "qwen3"
  return modelName.replace(/:latest$/, "");
}

function renderModelBadge(modelName) {
  // Show the size/quant tag in dim text, e.g. "14b", "1b", "Q4_K_M".
  const m = modelName.match(/:([^:]+)$/);
  if (!m) return null;
  const tag = m[1];
  if (!tag || tag === "latest") return null;
  return el("span", { class: "row-badge" }, tag);
}

async function selectModel(modelName) {
  // Switch the agent over to Ollama with this model (in-place model update keeps history).
  try {
    const res = await fetch("/api/config", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ provider: "ollama", model: modelName }),
    });
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      console.error("Failed to switch model:", data.error);
      return;
    }
    // Mirror to pure-chat so both modes use the same model by default.
    fetch("/api/ollama/chat/model", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: modelName }),
    }).catch(() => {});
    state.pureChat.model = modelName;
  } finally {
    closeModelPopover();
    await fetchInfo();
    // Re-apply effort/fast-mode in case we just rebuilt the provider.
    applyEffortAndFastMode();
  }
}

function renderEffortRows() {
  for (const btn of qsa("#effort-list .popover-row")) {
    const eid = btn.dataset.effort;
    btn.classList.toggle("active", eid === state.modelPicker.effort);
  }
}

function setEffort(effort) {
  if (!EFFORT_LEVELS.some((e) => e.id === effort)) return;
  state.modelPicker.effort = effort;
  saveModelPickerSettings();
  renderEffortRows();
  applyEffortAndFastMode();
}

function renderFastModeToggle() {
  const toggle = $("fast-mode-toggle");
  if (!toggle) return;
  toggle.classList.toggle("on", state.modelPicker.fastMode);
  toggle.setAttribute("aria-checked", String(state.modelPicker.fastMode));
}

function toggleFastMode() {
  state.modelPicker.fastMode = !state.modelPicker.fastMode;
  saveModelPickerSettings();
  renderFastModeToggle();
  applyEffortAndFastMode();
}

async function applyEffortAndFastMode() {
  let numPredict;
  let numCtx;
  if (state.modelPicker.fastMode) {
    numPredict = FAST_MODE_NUM_PREDICT;
    numCtx = FAST_MODE_NUM_CTX;
  } else {
    const level = EFFORT_LEVELS.find((e) => e.id === state.modelPicker.effort);
    numPredict = level ? level.num_predict : 1024;
    numCtx = null; // null = clear override and let provider default kick in
  }
  try {
    await fetch("/api/runtime", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ numPredict, numCtx }),
    });
  } catch {}
  state.runtimeNumCtx = typeof numCtx === "number" ? numCtx : null;
  updateModelButtonLabel();
  renderContextMeter();
}

function updateModelButtonLabel() {
  const tier = state.modelPicker.fastMode
    ? "Fast"
    : (EFFORT_LEVELS.find((e) => e.id === state.modelPicker.effort)?.label ?? "Max");
  const tierEl = $("model-tier-pill");
  if (tierEl) tierEl.textContent = tier;
}

// ---------------- models view ----------------

function formatBytes(n) {
  if (typeof n !== "number" || !isFinite(n) || n <= 0) return "—";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let i = 0;
  let v = n;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v.toFixed(i >= 2 ? 1 : 0)} ${units[i]}`;
}

function formatParams(billions) {
  if (typeof billions !== "string" && typeof billions !== "number") return "";
  if (typeof billions === "string") return billions;
  return `${billions}B`;
}

function formatRelative(ts) {
  if (!ts) return "";
  const date = new Date(ts);
  if (isNaN(date.getTime())) return "";
  const diff = (Date.now() - date.getTime()) / 1000;
  if (diff < 60) return "just now";
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  if (diff < 86400 * 30) return `modified ${Math.floor(diff / 86400)}d ago`;
  if (diff < 86400 * 365) return `modified ${Math.floor(diff / (86400 * 30))}mo ago`;
  return `modified ${Math.floor(diff / (86400 * 365))}y ago`;
}

async function refreshModelsView() {
  await Promise.all([refreshRunningModels(), refreshInstalledModels()]);
}

async function refreshRunningModels() {
  const container = $("running-models");
  const countEl = $("running-count");
  container.innerHTML = '<div class="muted small centered">Loading…</div>';
  countEl.textContent = "—";

  try {
    const res = await fetch("/api/ollama/ps");
    const data = await res.json();
    if (!data.ok) {
      countEl.textContent = "";
      container.innerHTML = "";
      container.appendChild(
        el("div", { class: "error-notice" },
          `Couldn't reach Ollama: ${data.error || "unknown error"}`,
        ),
      );
      return;
    }
    const models = Array.isArray(data.models) ? data.models : [];
    countEl.textContent = models.length === 0 ? "" : "—";
    container.innerHTML = "";
    if (models.length === 0) {
      container.appendChild(
        el("div", { class: "muted small centered" }, "No models currently loaded in memory."),
      );
      return;
    }
    for (const m of models) {
      container.appendChild(renderRunningModelRow(m));
    }
  } catch (e) {
    countEl.textContent = "";
    container.innerHTML = "";
    container.appendChild(
      el("div", { class: "error-notice" },
        `Couldn't reach Ollama: ${e?.message || "fetch failed"}`,
      ),
    );
  }
}

function renderRunningModelRow(m) {
  const name = m.name || m.model || "unknown";
  const sizeBytes = typeof m.size_vram === "number" ? m.size_vram : (typeof m.size === "number" ? m.size : 0);
  const params = m.details?.parameter_size || "";
  const quant = m.details?.quantization_level || "";
  const meta = [formatBytes(sizeBytes), params, quant].filter(Boolean);

  const metaEl = el("div", { class: "model-card-meta" }, []);
  meta.forEach((part, i) => {
    if (i > 0) metaEl.appendChild(el("span", { class: "dot" }));
    metaEl.appendChild(el("span", {}, String(part)));
  });
  if (m.expires_at) {
    const expires = new Date(m.expires_at);
    const sec = Math.max(0, Math.round((expires.getTime() - Date.now()) / 1000));
    if (sec > 0) {
      metaEl.appendChild(el("span", { class: "dot" }));
      metaEl.appendChild(el("span", {}, `unloads in ${sec >= 60 ? Math.round(sec / 60) + "m" : sec + "s"}`));
    }
  }

  const unloadBtn = el("button", { class: "danger-btn", type: "button" }, "Unload");
  unloadBtn.addEventListener("click", async () => {
    unloadBtn.disabled = true;
    unloadBtn.textContent = "Unloading…";
    try {
      const res = await fetch("/api/ollama/unload", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        alert(data.error || "Failed to unload");
      }
    } finally {
      refreshRunningModels();
    }
  });

  return el("div", { class: "model-card-row" }, [
    el("div", { class: "model-card-info" }, [
      el("div", { class: "model-card-name" }, name),
      metaEl,
    ]),
    el("div", { class: "model-card-actions" }, [unloadBtn]),
  ]);
}

async function refreshInstalledModels() {
  const container = $("installed-models");
  const countEl = $("installed-count");
  container.innerHTML = '<div class="muted small centered">Loading…</div>';
  countEl.textContent = "—";

  try {
    const res = await fetch("/api/ollama/tags");
    const data = await res.json();
    if (!data.ok) {
      countEl.textContent = "";
      container.innerHTML = "";
      container.appendChild(
        el("div", { class: "error-notice" },
          `Couldn't reach Ollama: ${data.error || "unknown error"}`,
        ),
      );
      return;
    }
    const models = Array.isArray(data.models) ? data.models : [];
    countEl.textContent = `${models.length} installed`;
    container.innerHTML = "";
    if (models.length === 0) {
      container.appendChild(
        el("div", { class: "muted small centered" },
          "No models installed yet. Pull one above to get started.",
        ),
      );
      return;
    }
    // Sort newest-first by modified_at if available
    models.sort((a, b) => {
      const da = a.modified_at ? new Date(a.modified_at).getTime() : 0;
      const db = b.modified_at ? new Date(b.modified_at).getTime() : 0;
      return db - da;
    });
    for (const m of models) {
      container.appendChild(renderInstalledModelRow(m));
    }
  } catch (e) {
    countEl.textContent = "";
    container.innerHTML = "";
    container.appendChild(
      el("div", { class: "error-notice" },
        `Couldn't reach Ollama: ${e?.message || "fetch failed"}`,
      ),
    );
  }
}

function renderInstalledModelRow(m) {
  const name = m.name || m.model || "unknown";
  const size = typeof m.size === "number" ? formatBytes(m.size) : "";
  const params = m.details?.parameter_size || "";
  const quant = m.details?.quantization_level || "";
  const modified = formatRelative(m.modified_at);
  const meta = [size, params, quant, modified].filter(Boolean);

  const metaEl = el("div", { class: "model-card-meta" }, []);
  meta.forEach((part, i) => {
    if (i > 0) metaEl.appendChild(el("span", { class: "dot" }));
    metaEl.appendChild(el("span", {}, String(part)));
  });

  const useBtn = el("button", { class: "link-btn", type: "button" }, "Use in chat");
  useBtn.addEventListener("click", () => useModelInChat(name));

  const deleteBtn = el("button", { class: "danger-btn", type: "button" }, "Delete");
  deleteBtn.addEventListener("click", () => deleteInstalledModel(name));

  return el("div", { class: "model-card-row" }, [
    el("div", { class: "model-card-info" }, [
      el("div", { class: "model-card-name" }, name),
      metaEl,
    ]),
    el("div", { class: "model-card-actions" }, [useBtn, deleteBtn]),
  ]);
}

async function useModelInChat(name) {
  try {
    const res = await fetch("/api/config", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ provider: "ollama", model: name }),
    });
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      alert(data.error || "Failed to switch model");
      return;
    }
    // Mirror to pure-chat so both modes use the same model.
    fetch("/api/ollama/chat/model", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: name }),
    }).catch(() => {});
    state.pureChat.model = name;
    await fetchInfo();
    applyEffortAndFastMode();
    switchView("chat");
  } catch (e) {
    alert(e?.message || "Failed to switch model");
  }
}

async function deleteInstalledModel(name) {
  if (!confirm(`Delete model "${name}"?\nThis frees disk space and can't be undone.`)) return;
  try {
    const res = await fetch("/api/ollama/delete", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name }),
    });
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      alert(data.error || "Failed to delete");
      return;
    }
  } finally {
    refreshInstalledModels();
  }
}

let activePullController = null;

async function startPullModel(name) {
  if (!name) return;
  const progressEl = $("pull-progress");
  const pullBtn = $("pull-btn");
  progressEl.hidden = false;
  progressEl.classList.remove("error", "done");
  progressEl.innerHTML = "";
  progressEl.appendChild(
    el("div", { class: "pull-progress-status" }, [
      el("span", {}, `Pulling ${name}…`),
      el("span", { class: "pct" }, "0%"),
    ]),
  );
  progressEl.appendChild(el("div", { class: "pull-progress-bar" }, [el("div", { style: "width: 0%" })]));

  pullBtn.disabled = true;
  pullBtn.textContent = "Pulling…";

  // Abort any earlier pull
  if (activePullController) {
    try { activePullController.abort(); } catch {}
  }
  activePullController = new AbortController();

  try {
    const response = await fetch("/api/ollama/pull", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name }),
      signal: activePullController.signal,
    });
    if (!response.ok || !response.body) {
      const text = await response.text().catch(() => "");
      setPullError(text || `HTTP ${response.status}`);
      return;
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";

    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      let idx;
      while ((idx = buffer.indexOf("\n\n")) !== -1) {
        const chunk = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 2);
        const lines = chunk.split("\n");
        let eventName = "message";
        const dataParts = [];
        for (const line of lines) {
          if (line.startsWith("event: ")) eventName = line.slice("event: ".length).trim();
          else if (line.startsWith("data: ")) dataParts.push(line.slice("data: ".length));
        }
        if (dataParts.length === 0) continue;
        let payload;
        try { payload = JSON.parse(dataParts.join("\n")); } catch { continue; }

        if (eventName === "progress") {
          updatePullProgress(name, payload);
        } else if (eventName === "error") {
          setPullError(payload.message || "Pull failed");
        } else if (eventName === "done") {
          setPullDone(name);
        }
      }
    }
  } catch (e) {
    if (e?.name === "AbortError") return;
    setPullError(e?.message || "Pull failed");
  } finally {
    pullBtn.disabled = false;
    pullBtn.textContent = "Pull";
    activePullController = null;
  }
}

function updatePullProgress(name, payload) {
  const progressEl = $("pull-progress");
  const total = typeof payload.total === "number" ? payload.total : 0;
  const completed = typeof payload.completed === "number" ? payload.completed : 0;
  const pct = total > 0 ? Math.min(100, Math.round((completed / total) * 100)) : 0;
  const status = payload.status || "pulling";

  progressEl.innerHTML = "";
  const head = el("div", { class: "pull-progress-status" }, [
    el("span", {}, `${name}: ${status}`),
    el("span", { class: "pct" }, total > 0 ? `${pct}%` : ""),
  ]);
  const bar = el("div", { class: "pull-progress-bar" }, [
    el("div", { style: `width: ${pct}%` }),
  ]);
  progressEl.appendChild(head);
  progressEl.appendChild(bar);

  if (total > 0) {
    progressEl.appendChild(
      el("div", { class: "muted small" },
        `${formatBytes(completed)} / ${formatBytes(total)}`,
      ),
    );
  }
}

function setPullError(message) {
  const progressEl = $("pull-progress");
  progressEl.classList.add("error");
  progressEl.classList.remove("done");
  progressEl.innerHTML = "";
  progressEl.appendChild(el("div", { class: "pull-progress-status" }, [
    el("span", {}, "Error"),
    el("span", {}, ""),
  ]));
  progressEl.appendChild(el("div", { class: "muted small" }, message));
}

function setPullDone(name) {
  const progressEl = $("pull-progress");
  progressEl.classList.add("done");
  progressEl.classList.remove("error");
  progressEl.innerHTML = "";
  progressEl.appendChild(el("div", { class: "pull-progress-status" }, [
    el("span", {}, `${name} pulled successfully ✓`),
    el("span", { class: "pct" }, "100%"),
  ]));
  progressEl.appendChild(el("div", { class: "pull-progress-bar" }, [el("div", { style: "width: 100%" })]));
  refreshInstalledModels();
}

// ---------------- cwd popover ----------------

function openCwdPopover() {
  const popover = $("cwd-popover");
  const backdrop = $("popover-backdrop");
  const anchor = $("ctx-folder");
  if (!popover || !anchor) return;

  renderCwdList();

  popover.hidden = false;
  backdrop.hidden = false;

  const r = anchor.getBoundingClientRect();
  popover.style.visibility = "hidden";
  popover.style.left = `${r.left}px`;
  popover.style.right = "auto";
  popover.style.bottom = `${window.innerHeight - r.top + 6}px`;
  popover.style.visibility = "visible";
}

function closeCwdPopover() {
  $("cwd-popover").hidden = true;
  // Only hide backdrop if no other popover is using it
  if ($("model-popover").hidden) {
    $("popover-backdrop").hidden = true;
  }
}

function renderCwdList() {
  const list = $("cwd-list");
  list.innerHTML = "";
  const current = state.info?.cwd || "";

  if (state.recentFolders.length === 0) {
    list.appendChild(el("div", { class: "popover-empty" }, "No recent folders yet."));
    return;
  }

  for (const folder of state.recentFolders) {
    const isCurrent = folder.path === current;
    const row = el(
      "button",
      {
        class: `popover-row cwd-row${isCurrent ? " active" : ""}`,
        type: "button",
        title: folder.path,
      },
      [
        el("span", { class: "row-name" }, folder.name || folderNameFromPath(folder.path)),
        el("span", { class: "row-check" }),
      ],
    );
    row.addEventListener("click", () => switchCwd(folder.path));

    // Hover-only delete to forget a folder
    const del = el("span", { class: "row-delete", title: "Forget" }, "×");
    del.addEventListener("click", (e) => {
      e.stopPropagation();
      state.recentFolders = state.recentFolders.filter((f) => f.path !== folder.path);
      saveRecentFolders();
      renderCwdList();
    });
    row.appendChild(del);

    list.appendChild(row);
  }
}

async function switchCwd(path) {
  if (!path) return;
  closeCwdPopover();
  try {
    const res = await fetch("/api/config", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ cwd: path }),
    });
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      addMessageNode("error", data.error || `Failed to switch to ${path}`);
      return;
    }
    rememberFolder(path);
    await fetchInfo();
  } catch (e) {
    addMessageNode("error", e?.message || "Failed to switch folder");
  }
}

function promptOpenFolder() {
  closeCwdPopover();
  openFolderPicker(state.info?.cwd || "");
}

// ---------------- folder picker modal ----------------

const folderPicker = {
  path: "",         // current absolute path being viewed; "" → drives root (Windows)
  selected: "",     // last clicked path (kept in input as well)
  onConfirm: null,  // optional callback(picked: string) — when set, picker uses it
                    // instead of the default switchCwd flow. Used by the project
                    // modal to fill a "Folder path" field.
};

// openFolderPicker(initialPath, { title?, confirmLabel?, onConfirm? })
// - title:        replaces the modal header (default: "Pick default working directory")
// - confirmLabel: replaces the primary button label (default: "Use as default directory")
// - onConfirm:    fn(picked) — called with the chosen absolute path on confirm.
//                 When omitted, picker falls back to switchCwd(picked).
function openFolderPicker(initialPath, options = {}) {
  const modal = $("folder-picker");
  if (!modal) return;
  modal.hidden = false;

  const titleEl = $("folder-picker-title");
  if (titleEl) titleEl.textContent = options.title || "Pick default working directory";
  const confirmBtn = $("folder-picker-confirm");
  if (confirmBtn) confirmBtn.textContent = options.confirmLabel || "Use as default directory";

  folderPicker.onConfirm = typeof options.onConfirm === "function" ? options.onConfirm : null;

  const input = $("folder-picker-input");
  if (input) input.value = initialPath || "";
  folderPicker.selected = initialPath || "";
  // Start at the initial path's directory if it's a path, else drives root.
  loadFolderPickerAt(initialPath || "");
}

function closeFolderPicker() {
  const modal = $("folder-picker");
  if (!modal) return;
  modal.hidden = true;
  // Reset to default behavior for the next opener so a stale callback can't
  // accidentally fill a field for a closed-and-reopened picker.
  folderPicker.onConfirm = null;
}

async function loadFolderPickerAt(absPath) {
  const list = $("folder-picker-list");
  const footLabel = $("folder-picker-foot-label");
  const input = $("folder-picker-input");
  if (!list) return;

  list.innerHTML = '<div class="folder-picker-empty">Loading…</div>';

  try {
    const res = await fetch(`/api/fs/list?path=${encodeURIComponent(absPath || "")}`);
    const data = await res.json();
    if (!res.ok) {
      list.innerHTML = "";
      list.appendChild(el("div", { class: "folder-picker-error" },
        `Couldn't list: ${data.error || "unknown error"}`));
      return;
    }

    folderPicker.path = data.path || "";
    if (input && folderPicker.path) input.value = folderPicker.path;
    if (footLabel) {
      footLabel.textContent = data.isRoot
        ? (folderPicker.path ? folderPicker.path : "(drives)")
        : folderPicker.path;
    }

    list.innerHTML = "";
    const items = Array.isArray(data.items) ? data.items : [];
    if (items.length === 0) {
      list.appendChild(el("div", { class: "folder-picker-empty" }, "(no subfolders)"));
      return;
    }

    for (const item of items) {
      const row = el("button", { class: "folder-picker-row", type: "button", title: item.path }, [
        el("span", { class: "row-icon" }, folderRowIcon()),
        el("span", {}, item.name),
      ]);
      row.addEventListener("click", () => {
        folderPicker.selected = item.path;
        if (input) input.value = item.path;
      });
      row.addEventListener("dblclick", () => loadFolderPickerAt(item.path));
      list.appendChild(row);
    }
  } catch (e) {
    list.innerHTML = "";
    list.appendChild(el("div", { class: "folder-picker-error" },
      `Couldn't list: ${e?.message || "fetch failed"}`));
  }
}

function folderRowIcon() {
  const ns = "http://www.w3.org/2000/svg";
  const svg = document.createElementNS(ns, "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("width", "14");
  svg.setAttribute("height", "14");
  svg.setAttribute("fill", "none");
  svg.setAttribute("stroke", "currentColor");
  svg.setAttribute("stroke-width", "2");
  svg.setAttribute("stroke-linecap", "round");
  svg.setAttribute("stroke-linejoin", "round");
  const p = document.createElementNS(ns, "path");
  p.setAttribute("d", "M3 6h6l2 2h10v10a2 2 0 0 1-2 2H3z");
  svg.appendChild(p);
  return svg;
}

async function folderPickerGoUp() {
  if (!folderPicker.path) return; // already at drives root
  try {
    const res = await fetch(`/api/fs/list?path=${encodeURIComponent(folderPicker.path)}`);
    const data = await res.json();
    if (!res.ok) return;
    if (data.parent) {
      loadFolderPickerAt(data.parent);
    } else {
      loadFolderPickerAt(""); // already at filesystem root → drives root
    }
  } catch {}
}

async function folderPickerGoHome() {
  try {
    const res = await fetch("/api/fs/home");
    const data = await res.json();
    if (data.home) loadFolderPickerAt(data.home);
  } catch {}
}

function folderPickerConfirm() {
  const input = $("folder-picker-input");
  const picked = (input?.value || folderPicker.selected || folderPicker.path || "").trim();
  if (!picked) return;
  const cb = folderPicker.onConfirm;
  closeFolderPicker();
  if (cb) {
    cb(picked);
  } else {
    switchCwd(picked);
  }
}

// ---------------- settings modal ----------------

function openSettings() {
  if (state.info) {
    $("provider-select").value = state.info.provider || "anthropic";
    $("model-input").value = state.info.model || "";
    $("cwd-input").value = state.info.cwd || "";
    $("baseurl-input").value = state.info.baseUrl || "http://127.0.0.1:11434";
  }
  const errorEl = $("settings-error");
  errorEl.textContent = "";
  errorEl.hidden = true;
  updateSettingsProviderFields();
  $("settings-modal").hidden = false;
}

function closeSettings() { $("settings-modal").hidden = true; }

function updateSettingsProviderFields() {
  const isOllama = $("provider-select").value === "ollama";
  $("ollama-baseurl-field").hidden = !isOllama;
  $("ollama-status-field").hidden = !isOllama;
  const modelInput = $("model-input");
  if (isOllama) {
    if (!modelInput.value.trim()) modelInput.value = "qwen3";
    modelInput.placeholder = "e.g. qwen3, llama3.2, gpt-oss";
    probeSettingsOllamaStatus();
  } else if ($("provider-select").value === "gemini") {
    modelInput.placeholder = "e.g. gemini-2.5-flash";
  } else {
    modelInput.placeholder = "e.g. claude-opus-4-7";
  }
}

async function probeSettingsOllamaStatus() {
  const statusEl = $("ollama-status");
  const textEl = statusEl.querySelector(".ollama-status-text");
  const modelsEl = $("ollama-models");
  const baseUrl = $("baseurl-input").value.trim() || "http://127.0.0.1:11434";

  statusEl.classList.remove("ok", "error");
  statusEl.classList.add("checking");
  textEl.textContent = "checking…";
  modelsEl.textContent = "";

  try {
    const res = await fetch(`/api/ollama/probe?baseUrl=${encodeURIComponent(baseUrl)}`);
    const data = await res.json();
    statusEl.classList.remove("checking");
    if (data.ok) {
      statusEl.classList.add("ok");
      textEl.textContent = `reachable · ${data.models.length} model(s)`;
      if (data.models.length > 0) {
        modelsEl.textContent = `installed: ${data.models.slice(0, 12).join(", ")}${data.models.length > 12 ? ", …" : ""}`;
      } else {
        modelsEl.textContent = "no models installed yet — run `ollama pull qwen3`";
      }
    } else {
      statusEl.classList.add("error");
      textEl.textContent = data.error || "unreachable";
    }
  } catch (error) {
    statusEl.classList.remove("checking");
    statusEl.classList.add("error");
    textEl.textContent = error?.message || "unreachable";
  }
}

async function saveSettings() {
  const provider = $("provider-select").value;
  const model = $("model-input").value.trim();
  const cwd = $("cwd-input").value.trim();
  const baseUrl = $("baseurl-input").value.trim();
  const errorEl = $("settings-error");

  const saveBtn = $("settings-save");
  saveBtn.disabled = true;

  try {
    const payload = { provider, model, cwd };
    if (provider === "ollama" && baseUrl) payload.baseUrl = baseUrl;
    const res = await fetch("/api/config", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      errorEl.textContent = data.error || "Failed to update settings";
      errorEl.hidden = false;
      return;
    }
    closeSettings();
    await fetchInfo();
  } finally {
    saveBtn.disabled = false;
  }
}

async function clearActiveConversation() {
  if (state.busy) return;
  if (state.view === "pure-chat") {
    await clearPureChat();
    return;
  }
  await fetch("/api/clear", { method: "POST" });
  const session = activeSession();
  if (session) {
    session.messages = [];
    saveSessions();
    renderChat();
  } else {
    $("messages").innerHTML = "";
  }
  addMessageNode("system", "Conversation cleared.");
}

// ---------------- pure ollama chat ----------------

async function initPureChat() {
  await refreshPureChatInfo();
  // If the agent is on Ollama and pure-chat hasn't picked a model yet, mirror it.
  if (!state.pureChat.model && state.info?.provider === "ollama" && state.info?.model) {
    await syncPureChatModel(state.info.model);
  }
  state.pureChat.initialized = true;
}

async function refreshPureChatInfo() {
  try {
    const res = await fetch("/api/ollama/chat/info");
    if (!res.ok) return;
    const data = await res.json();
    state.pureChat.model = data.model || state.pureChat.model;
    state.pureChat.baseUrl = data.baseUrl || state.pureChat.baseUrl;
  } catch {}
}

async function syncPureChatModel(name) {
  if (!name) return;
  state.pureChat.model = name;
  try {
    await fetch("/api/ollama/chat/model", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: name }),
    });
  } catch {}
}

function showPureChatNotice(text, level) {
  const greeting = $("pure-chat-greeting");
  if (!greeting) return;
  let notice = greeting.querySelector(".pure-chat-notice");
  if (!notice) {
    notice = el("div", { class: "pure-chat-notice" }, "");
    notice.style.marginTop = "12px";
    notice.style.fontSize = "12px";
    notice.style.padding = "8px 12px";
    notice.style.borderRadius = "6px";
    greeting.appendChild(notice);
  }
  notice.textContent = text;
  notice.style.background =
    level === "error" ? "rgba(248,113,113,0.1)" : "rgba(251,191,36,0.1)";
  notice.style.color = level === "error" ? "var(--error)" : "var(--tool)";
  notice.style.border =
    level === "error"
      ? "1px solid rgba(248,113,113,0.35)"
      : "1px solid rgba(251,191,36,0.35)";
}

function pureChatGreetingActive() {
  const g = $("pure-chat-greeting");
  return g && !g.hidden && g.parentNode;
}

function hidePureChatGreeting() {
  const g = $("pure-chat-greeting");
  if (g) g.hidden = true;
}

function addPureChatMessage(role, content) {
  hidePureChatGreeting();
  const wrap = el("div", { class: `message ${role}` }, [
    el("div", { class: "role" }, role === "assistant" ? "ollama" : role),
    el("div", { class: "content" }, content),
  ]);
  $("pure-chat-messages").appendChild(wrap);
  scrollPureChat();
  return wrap;
}

function scrollPureChat() {
  const m = $("pure-chat-messages");
  if (m) m.scrollTop = m.scrollHeight;
}

async function clearPureChat() {
  if (state.busy) return;
  await fetch("/api/ollama/chat/clear", { method: "POST" });
  state.pureChat.messages = [];
  const container = $("pure-chat-messages");
  container.innerHTML = "";
  const greeting = el("div", { class: "pure-chat-greeting", id: "pure-chat-greeting" }, [
    el("div", { class: "pure-chat-greeting-star" }, [
      Object.assign(document.createElementNS("http://www.w3.org/2000/svg", "svg"), {}),
    ]),
    el("h1", { class: "pure-chat-greeting-title" }, "Hello."),
    el("p", { class: "muted" }, "Send a message below to start chatting with Ollama."),
  ]);
  // Replace placeholder star with proper SVG.
  greeting.querySelector(".pure-chat-greeting-star").innerHTML =
    '<svg viewBox="0 0 24 24" width="32" height="32" fill="#d97757"><path d="M12 2 13.5 8.5 20 10l-6.5 1.5L12 18l-1.5-6.5L4 10l6.5-1.5L12 2z"/></svg>';
  container.appendChild(greeting);
}

async function sendPureChat(prompt) {
  if (state.busy) return;

  state.busy = true;
  const sendBtn = $("send-btn");
  const promptInput = $("prompt-input");
  sendBtn.disabled = true;
  promptInput.disabled = true;
  setModelStatus("busy");

  state.pureChat.messages.push({ role: "user", content: prompt });
  addPureChatMessage("user", prompt);

  const thinking = el("div", { class: "message system" }, [
    el("div", { class: "role" }, "ollama"),
    el("div", { class: "content" }, [el("span", { class: "thinking" }, "thinking")]),
  ]);
  $("pure-chat-messages").appendChild(thinking);
  scrollPureChat();

  const removeThinking = () => {
    if (thinking.parentNode) thinking.parentNode.removeChild(thinking);
  };

  let assistantBlock = null;
  let assistantText = "";

  recordEvent("pure_chat_user", { provider: "ollama", model: state.pureChat.model });

  try {
    const response = await fetch("/api/ollama/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ prompt, model: state.pureChat.model || undefined }),
    });

    if (!response.ok || !response.body) {
      removeThinking();
      const body = await response.json().catch(() => ({ error: `HTTP ${response.status}` }));
      addPureChatMessage("error", body.error || "Request failed");
      setModelStatus("error");
      return;
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";

    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      let idx;
      while ((idx = buffer.indexOf("\n\n")) !== -1) {
        const chunk = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 2);
        const lines = chunk.split("\n");
        let eventName = "message";
        const dataParts = [];
        for (const line of lines) {
          if (line.startsWith("event: ")) eventName = line.slice("event: ".length).trim();
          else if (line.startsWith("data: ")) dataParts.push(line.slice("data: ".length));
        }
        if (dataParts.length === 0) continue;
        let payload;
        try { payload = JSON.parse(dataParts.join("\n")); } catch { continue; }

        removeThinking();

        if (eventName === "meta") {
          if (payload.model) state.pureChat.model = payload.model;
          if (payload.baseUrl) state.pureChat.baseUrl = payload.baseUrl;
        } else if (eventName === "delta") {
          assistantText += payload.text || "";
          if (!assistantBlock) {
            assistantBlock = addPureChatMessage("assistant", assistantText);
          } else {
            assistantBlock.querySelector(".content").textContent = assistantText;
            scrollPureChat();
          }
        } else if (eventName === "done") {
          if (!assistantBlock && payload.text) {
            assistantText = payload.text;
            assistantBlock = addPureChatMessage("assistant", assistantText);
          } else if (assistantBlock && payload.text) {
            assistantText = payload.text;
            assistantBlock.querySelector(".content").textContent = assistantText;
            scrollPureChat();
          } else if (!assistantBlock) {
            addPureChatMessage("assistant", "(no response)");
            assistantText = "(no response)";
          }
        } else if (eventName === "error") {
          addPureChatMessage("error", payload.message || "Unknown error");
          setModelStatus("error");
        }
      }
    }

    state.pureChat.messages.push({ role: "assistant", content: assistantText });
    recordEvent("pure_chat_assistant", { provider: "ollama", model: state.pureChat.model });
    setModelStatus("ok");
  } catch (error) {
    removeThinking();
    addPureChatMessage("error", error?.message || String(error));
    setModelStatus("error");
  } finally {
    state.busy = false;
    sendBtn.disabled = false;
    promptInput.disabled = false;
    promptInput.value = "";
    promptInput.focus();
  }
}

async function setPureChatModel(model) {
  if (!model) return;
  state.pureChat.model = model;
  try {
    await fetch("/api/ollama/chat/model", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model }),
    });
  } catch {}
}

// ---------------- wire-up ----------------

function wireUp() {
  // Composer (routes to agent or pure-ollama based on current view)
  const handleComposerSubmit = (v) => {
    if (state.view === "pure-chat") sendPureChat(v);
    else sendPrompt(v);
  };
  $("composer").addEventListener("submit", (e) => {
    e.preventDefault();
    const v = $("prompt-input").value.trim();
    if (v) handleComposerSubmit(v);
  });
  $("prompt-input").addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      const v = $("prompt-input").value.trim();
      if (v) handleComposerSubmit(v);
    }
  });

  // (Pure-chat header was removed — model is selected via the bottom model picker;
  //  "Clear conversation" in the sidebar More menu clears pure-chat when active.)

  // Sidebar nav (data-view items inside subsections)
  for (const btn of qsa("[data-view]")) {
    btn.addEventListener("click", () => switchView(btn.dataset.view));
  }

  // Tab pill (data-tab buttons in sidebar-top)
  for (const btn of qsa(".mode-tab[data-tab]")) {
    btn.addEventListener("click", () => switchTab(btn.dataset.tab));
  }

  // Chat tab: + New chat — resets pure-chat conversation
  const newPureChatBtn = $("new-pure-chat-btn");
  if (newPureChatBtn) {
    newPureChatBtn.addEventListener("click", async () => {
      await fetch("/api/ollama/chat/clear", { method: "POST" }).catch(() => {});
      state.pureChat.messages = [];
      const container = $("pure-chat-messages");
      if (container) container.innerHTML = "";
      switchTab("chat");
      $("prompt-input").focus();
    });
  }

  // Models tab: refresh installed list
  const refreshModelsBtn = $("refresh-models-btn");
  if (refreshModelsBtn) {
    refreshModelsBtn.addEventListener("click", () => {
      if (typeof refreshModelsView === "function") refreshModelsView();
      switchTab("models");
    });
  }

  // Projects: + New project → opens the styled multi-step modal
  const addProjectBtn = $("add-project-btn");
  if (addProjectBtn) {
    addProjectBtn.addEventListener("click", openProjectModal);
  }

  // Projects: sort toggle (recent ↔ name)
  const projectsSortBtn = $("projects-sort");
  if (projectsSortBtn) {
    projectsSortBtn.addEventListener("click", () => {
      projectsView.sort = projectsView.sort === "recent" ? "name" : "recent";
      projectsSortBtn.classList.toggle("active", projectsView.sort === "name");
      projectsSortBtn.title = projectsView.sort === "name" ? "Sorted by name (click for recent)" : "Sorted by most recent (click for name)";
      renderProjects();
    });
  }

  // Projects: search toggle + filter
  const projectsSearchBtn = $("projects-search-btn");
  const projectsSearchInput = $("projects-search");
  if (projectsSearchBtn && projectsSearchInput) {
    projectsSearchBtn.addEventListener("click", () => {
      projectsView.searchOpen = !projectsView.searchOpen;
      projectsSearchInput.hidden = !projectsView.searchOpen;
      projectsSearchBtn.classList.toggle("active", projectsView.searchOpen);
      if (projectsView.searchOpen) {
        projectsSearchInput.focus();
      } else {
        projectsSearchInput.value = "";
        projectsView.searchQuery = "";
        renderProjects();
      }
    });
    projectsSearchInput.addEventListener("input", () => {
      projectsView.searchQuery = projectsSearchInput.value;
      renderProjects();
    });
  }

  // Project modal wireup
  for (const optionBtn of qsa(".project-option")) {
    optionBtn.addEventListener("click", () => {
      startProjectOption(optionBtn.dataset.option);
    });
  }
  for (const closer of qsa("[data-project-modal-close]")) {
    closer.addEventListener("click", closeProjectModal);
  }
  const projectBack = document.querySelector("[data-project-back]");
  if (projectBack) {
    projectBack.addEventListener("click", () => showProjectStep("options"));
  }
  const projectCreate = $("project-create-btn");
  if (projectCreate) {
    projectCreate.addEventListener("click", createProjectFromForm);
  }
  const projectName = $("project-name-input");
  if (projectName) {
    projectName.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        createProjectFromForm();
      }
    });
  }

  // Project folder field: clicking either the input or Browse opens the picker.
  const projectFolderBrowse = $("project-folder-browse");
  if (projectFolderBrowse) {
    projectFolderBrowse.addEventListener("click", openFolderPickerForProjectField);
  }
  const projectFolderInput = $("project-folder-input");
  if (projectFolderInput) {
    projectFolderInput.addEventListener("click", openFolderPickerForProjectField);
    projectFolderInput.addEventListener("focus", openFolderPickerForProjectField);
  }

  // Folder picker modal wireup
  for (const closer of qsa("[data-folder-picker-close]")) {
    closer.addEventListener("click", closeFolderPicker);
  }
  const fpUp = $("folder-picker-up");
  if (fpUp) fpUp.addEventListener("click", folderPickerGoUp);
  const fpHome = $("folder-picker-home");
  if (fpHome) fpHome.addEventListener("click", folderPickerGoHome);
  const fpConfirm = $("folder-picker-confirm");
  if (fpConfirm) fpConfirm.addEventListener("click", folderPickerConfirm);
  const fpForm = $("folder-picker-form");
  if (fpForm) {
    fpForm.addEventListener("submit", (e) => {
      e.preventDefault();
      const val = ($("folder-picker-input").value || "").trim();
      if (val) loadFolderPickerAt(val);
    });
  }

  // Model selector
  $("model-btn").addEventListener("click", openModelPopover);
  $("popover-backdrop").addEventListener("click", () => {
    closeModelPopover();
    closeCwdPopover();
  });

  for (const btn of qsa("#effort-list .popover-row")) {
    btn.addEventListener("click", () => setEffort(btn.dataset.effort));
  }
  $("fast-mode-row").addEventListener("click", toggleFastMode);

  // Number-key shortcuts (1-9) select Nth model when popover is open.
  document.addEventListener("keydown", (e) => {
    if ($("model-popover").hidden) return;
    if (!/^[1-9]$/.test(e.key)) return;
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    const idx = parseInt(e.key, 10) - 1;
    const rows = qsa("#model-list .popover-row");
    if (idx < rows.length) {
      e.preventDefault();
      rows[idx].click();
    }
  });

  // Context pills
  $("ctx-folder").addEventListener("click", openCwdPopover);
  $("ctx-add").addEventListener("click", promptOpenFolder);
  $("cwd-open-folder").addEventListener("click", promptOpenFolder);

  // Models view
  $("running-refresh").addEventListener("click", refreshRunningModels);
  $("installed-refresh").addEventListener("click", refreshInstalledModels);
  $("pull-form").addEventListener("submit", (e) => {
    e.preventDefault();
    const name = $("pull-input").value.trim();
    if (name) startPullModel(name);
  });
  for (const pill of qsa(".suggested-pill")) {
    pill.addEventListener("click", () => {
      const name = pill.dataset.suggest;
      if (!name) return;
      $("pull-input").value = name;
      startPullModel(name);
    });
  }

  // Customize
  $("customize-save").addEventListener("click", saveCustomize);

  // User card → opens account menu (sign out, customize)
  $("user-card").addEventListener("click", (e) => {
    e.stopPropagation();
    const menu = $("user-menu");
    if (menu && !menu.hidden) {
      closeUserMenu();
    } else {
      openUserMenu();
    }
  });

  // Settings modal
  $("settings-save").addEventListener("click", saveSettings);
  $("provider-select").addEventListener("change", updateSettingsProviderFields);
  $("baseurl-input").addEventListener("change", probeSettingsOllamaStatus);
  $("ollama-refresh").addEventListener("click", probeSettingsOllamaStatus);
  for (const el of qsa("[data-modal-close]")) el.addEventListener("click", closeSettings);

  // Accept-edits toggle (cosmetic — server always auto-accepts agent tool calls today)
  $("accept-edits-btn").addEventListener("click", () => {
    $("accept-edits-btn").classList.toggle("active");
  });

  const chatModeBtn = $("chat-mode-btn");
  if (chatModeBtn) chatModeBtn.addEventListener("click", toggleChatMode);

  // Code → Terminal view (ollama launch claude, streamed over /pty)
  wireCodeTerminal();

  // Sidebar toggle — collapse the grid column so main content fills the space,
  // and surface a floating "show" button so the user can bring the sidebar back.
  const setSidebarCollapsed = (collapsed) => {
    const app = $("app");
    const showBtn = $("show-sidebar");
    if (!app) return;
    app.classList.toggle("sidebar-collapsed", collapsed);
    if (showBtn) showBtn.hidden = !collapsed;
  };
  $("toggle-sidebar").addEventListener("click", () => setSidebarCollapsed(true));
  const showBtn = $("show-sidebar");
  if (showBtn) showBtn.addEventListener("click", () => setSidebarCollapsed(false));

  // Escape closes overlays
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
      if (!$("model-popover").hidden) closeModelPopover();
      const cwdPop = $("cwd-popover");
      if (cwdPop && !cwdPop.hidden && typeof closeCwdPopover === "function") closeCwdPopover();
      const settings = $("settings-modal");
      if (settings && !settings.hidden) closeSettings();
      const projectModal = $("project-modal");
      if (projectModal && !projectModal.hidden) closeProjectModal();
    }
  });
}

function exportSession() {
  const session = activeSession();
  if (!session) return;
  const blob = new Blob([JSON.stringify(session, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `${session.title || "session"}-${session.id}.json`;
  a.click();
  URL.revokeObjectURL(url);
}

// ---------------- auth ----------------

function hydrateUserFromAuth(user) {
  if (!user) return;
  state.user = {
    name: user.displayName || user.username || "User",
    tier: user.tier || "",
    avatar:
      (user.avatar && user.avatar.trim()) ||
      (user.displayName || user.username || "U").slice(0, 1).toUpperCase(),
  };
  saveUser();
  applyUser();
}

function showLogin({ pending = false } = {}) {
  document.body.classList.remove(pending ? "auth-required" : "auth-pending");
  document.body.classList.add(pending ? "auth-pending" : "auth-required");
  if (!pending) {
    setTimeout(() => {
      const u = $("login-username");
      if (u) u.focus();
    }, 40);
  }
}

function finishAuth() {
  document.body.classList.remove("auth-pending", "auth-required");
}

async function checkAuth() {
  try {
    const res = await fetch("/api/auth/me", { credentials: "same-origin" });
    if (res.ok) {
      const data = await res.json();
      auth.authed = true;
      auth.user = data.user;
      hydrateUserFromAuth(data.user);
      finishAuth();
      return true;
    }
    // A 401/403 means an auth backend exists and wants a sign-in.
    if (res.status === 401 || res.status === 403) {
      auth.authed = false;
      auth.user = null;
      showLogin();
      return false;
    }
  } catch {
    /* no auth backend reachable — run open below */
  }
  // No auth backend wired up (e.g. the bundled server.js): run the workspace
  // open instead of trapping the user behind a login that can't succeed.
  auth.authed = false;
  auth.user = null;
  finishAuth();
  return true;
}

async function bootAuthedApp() {
  if (auth.bootedPostAuth) return;
  auth.bootedPostAuth = true;
  try {
    await fetchInfo();
    updateModelButtonLabel();
    applyEffortAndFastMode();
  } catch {
    /* fetchInfo handles its own status display */
  }
  // Now that we're authenticated, reattach to a live terminal session if one is active
  // (this is what survives a page refresh).
  renderTermSessions();
  if (state.view === "terminal") enterCodeTerminal();
}

async function doLogin(event) {
  if (event) event.preventDefault();
  const username = $("login-username").value.trim();
  const password = $("login-password").value;
  const errorEl = $("login-error");
  const submit = $("login-submit");
  errorEl.hidden = true;
  errorEl.textContent = "";
  if (!username || !password) {
    errorEl.textContent = "Enter a username and password.";
    errorEl.hidden = false;
    return;
  }
  submit.disabled = true;
  submit.textContent = "Signing in…";
  try {
    const res = await fetch("/api/auth/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      credentials: "same-origin",
      body: JSON.stringify({ username, password }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || !data.ok) {
      errorEl.textContent = data.error || `Sign in failed (${res.status}).`;
      errorEl.hidden = false;
      submit.disabled = false;
      submit.textContent = "Sign in";
      return;
    }
    auth.authed = true;
    auth.user = data.user;
    hydrateUserFromAuth(data.user);
    finishAuth();
    $("login-password").value = "";
    submit.disabled = false;
    submit.textContent = "Sign in";
    await bootAuthedApp();
  } catch (err) {
    errorEl.textContent = (err && err.message) || "Sign in failed.";
    errorEl.hidden = false;
    submit.disabled = false;
    submit.textContent = "Sign in";
  }
}

async function doLogout() {
  closeUserMenu();
  try {
    await fetch("/api/auth/logout", { method: "POST", credentials: "same-origin" });
  } catch {
    /* ignore — we reload regardless */
  }
  window.location.reload();
}

function openUserMenu() {
  const card = $("user-card");
  const menu = $("user-menu");
  if (!card || !menu) return;
  $("user-menu-avatar").textContent = state.user.avatar || "A";
  $("user-menu-display-name").textContent = state.user.name || "User";
  $("user-menu-username").textContent = (auth.user && auth.user.username) || "";
  menu.hidden = false;
  const r = card.getBoundingClientRect();
  menu.style.visibility = "hidden";
  menu.style.left = `${Math.max(8, r.left)}px`;
  menu.style.bottom = `${window.innerHeight - r.top + 6}px`;
  menu.style.right = "auto";
  menu.style.visibility = "visible";
}

function closeUserMenu() {
  const menu = $("user-menu");
  if (menu) menu.hidden = true;
}

function wireAuth() {
  const form = $("login-form");
  if (form) form.addEventListener("submit", doLogin);
  const logoutBtn = $("user-menu-logout");
  if (logoutBtn) logoutBtn.addEventListener("click", doLogout);
  const customizeBtn = $("user-menu-customize");
  if (customizeBtn) {
    customizeBtn.addEventListener("click", () => {
      closeUserMenu();
      switchView("customize");
    });
  }
  document.addEventListener("click", (e) => {
    const menu = $("user-menu");
    if (!menu || menu.hidden) return;
    if (menu.contains(e.target)) return;
    if ($("user-card").contains(e.target)) return;
    closeUserMenu();
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && !$("user-menu").hidden) closeUserMenu();
  });
}

// ---------------- code terminal (ollama launch claude) ----------------
//
// The Code → Terminal view runs `ollama launch claude` in a chosen folder and
// streams it over the /pty WebSocket served by server.js, rendered with xterm.

const codeTerm = {
  term: null,
  fit: null,
  ws: null,
  launched: false,
  sessionId: null, // id of the term session currently bound to this view
  modelsLoaded: false,
  cwdLoaded: false,
  onResize: null,
  fitTimer: null,
};

function setTermStatus(stateName, text) {
  const wrap = $("term-status");
  const txt = $("term-status-text");
  if (wrap) wrap.dataset.state = stateName;
  if (txt) txt.textContent = text;
}

async function populateTermModels() {
  const select = $("term-model");
  if (!select) return;
  const prev = select.value;
  let models = [];
  try {
    const m = await fetch("/api/models").then((r) => r.json());
    if (m && m.ok && Array.isArray(m.models)) models = m.models;
  } catch {
    /* Ollama unreachable — leave the list empty below */
  }
  select.innerHTML = "";
  codeTerm.modelsLoaded = true;
  if (!models.length) {
    select.appendChild(el("option", { value: "", disabled: true, selected: true },
      "No models installed — pull one in Models"));
    return;
  }
  for (const name of models) select.appendChild(el("option", { value: name }, name));
  // Prefer the active session's model, then the user's previous pick, then a coder model.
  const sess = activeTermSession();
  const want = (sess && sess.model) || prev;
  const coder = models.find((n) => /coder/i.test(n));
  select.value = models.includes(want) ? want : (coder || models[0]);
}

async function populateTermCwd() {
  const input = $("term-cwd");
  if (!input) return;
  codeTerm.cwdLoaded = true;
  if (input.value.trim()) return; // don't clobber a path the user typed
  const fromInfo = state.info && state.info.cwd;
  if (fromInfo) { input.value = fromInfo; return; }
  try {
    const d = await fetch("/api/defaults").then((r) => r.json());
    input.value = d.cwd || d.home || "";
  } catch {
    /* leave blank — server.js falls back to the home directory */
  }
}

function enterCodeTerminal() {
  const sess = activeTermSession();
  // Seed the folder field from the active session first, so the async default fetch
  // in populateTermCwd() doesn't clobber it.
  if (sess) {
    const cwdInput = $("term-cwd");
    if (cwdInput && sess.cwd) cwdInput.value = sess.cwd;
    codeTerm.cwdLoaded = true;
  }
  populateTermModels(); // always refresh so the list reflects whatever is installed now
  if (!codeTerm.cwdLoaded) populateTermCwd();

  // Already bound to the active session — just refit to the current viewport.
  if (codeTerm.launched && codeTerm.sessionId === state.activeTermSessionId) {
    setTimeout(() => { try { codeTerm.fit && codeTerm.fit.fit(); } catch {} }, 50);
    return;
  }
  // Reattach to the active session's live process (the refresh case). Wait until
  // authenticated so we don't open a socket the server will reject on boot.
  if (sess) {
    if (auth.authed) attachTermSession(sess);
  } else {
    resetTerminalToLaunch();
  }
}

function attachTermSession(sess) {
  connectTerminal({ sessionId: sess.id, model: sess.model, cwd: sess.cwd, mode: "attach" });
}

// Click a saved session in the sidebar: make it active and (re)bind the view to it.
function openTermSession(id) {
  const sess = state.termSessions.find((s) => s.id === id);
  if (!sess) return;
  state.activeTermSessionId = id;
  saveActiveTermSession();
  renderTermSessions();
  if (state.view !== "terminal") switchView("terminal"); // → enterCodeTerminal attaches
  else enterCodeTerminal();
}

// "New terminal" button: detach the current view (its process keeps running in the
// sidebar) and show a fresh launch form with no active session.
function startNewTermSession() {
  teardownCodeTerminal();
  state.activeTermSessionId = null;
  saveActiveTermSession();
  renderTermSessions();
  resetTerminalToLaunch();
  if (state.view !== "terminal") switchView("terminal");
}

function resetTerminalToLaunch() {
  const host = $("code-terminal");
  if (host) host.innerHTML = "";
  setTermStatus("stopped", "Stopped");
  const launchBtn = $("term-launch");
  const restartBtn = $("term-restart");
  if (launchBtn) launchBtn.hidden = false;
  if (restartBtn) restartBtn.hidden = true;
}

function sendTerm(obj) {
  const ws = codeTerm.ws;
  if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(obj));
}

function handleTermControl(msg) {
  if (msg.type === "status" && msg.state === "running") {
    setTermStatus("running", "Running");
  } else if (msg.type === "exit") {
    setTermStatus("exited", `Exited (code ${msg.code})`);
    try {
      codeTerm.term.writeln(`\r\n\x1b[90m— Claude Code exited (code ${msg.code}). Press Restart to relaunch. —\x1b[0m`);
    } catch {}
  } else if (msg.type === "gone") {
    // Reattach failed because the process is no longer running (e.g. the server was
    // restarted). Offer a relaunch — the model/folder are already filled in.
    setTermStatus("stopped", "Session ended");
    try {
      codeTerm.term.writeln(`\r\n\x1b[90m— this session is no longer running. Press Launch to start it again. —\x1b[0m`);
    } catch {}
    const launchBtn = $("term-launch");
    const restartBtn = $("term-restart");
    if (launchBtn) launchBtn.hidden = false;
    if (restartBtn) restartBtn.hidden = true;
  } else if (msg.type === "error") {
    setTermStatus("error", "Error");
    try { codeTerm.term.writeln(`\r\n\x1b[31m${msg.message}\x1b[0m`); } catch {}
  }
}

function teardownCodeTerminal() {
  if (codeTerm.onResize) {
    window.removeEventListener("resize", codeTerm.onResize);
    codeTerm.onResize = null;
  }
  // Mark this socket so its onclose handler doesn't report a spurious "Disconnected" —
  // we're detaching on purpose; the server keeps the PTY running.
  if (codeTerm.ws) { codeTerm.ws._intentional = true; try { codeTerm.ws.close(); } catch {} }
  try { codeTerm.term && codeTerm.term.dispose(); } catch {}
  codeTerm.ws = null;
  codeTerm.term = null;
  codeTerm.fit = null;
  codeTerm.launched = false;
  codeTerm.sessionId = null;
}

// Launch (or relaunch) the active session — or start a new one if none is active.
// mode:"create" tells the server to spawn a fresh process, replacing any live one
// for this id.
function launchCodeTerminal() {
  const model = ($("term-model").value || "").trim();
  const cwd = ($("term-cwd").value || "").trim();
  if (!model) { setTermStatus("error", "Pick a model"); return; }

  rememberFolder(cwd);
  if (typeof renderCwdList === "function") { try { renderCwdList(); } catch {} }

  let sess = activeTermSession();
  if (sess) updateTermSession(sess.id, { model, cwd, name: termSessionName(cwd) });
  else sess = newTermSession({ model, cwd });
  renderTermSessions();

  connectTerminal({ sessionId: sess.id, model, cwd, mode: "create" });
}

// Open a WebSocket to the PTY and wire xterm to it. mode:"attach" reattaches to a
// running process (replaying its recent output); mode:"create" spawns a new one.
function connectTerminal({ sessionId, model, cwd, mode }) {
  if (typeof Terminal !== "function" || typeof FitAddon === "undefined") {
    setTermStatus("error", "xterm failed to load");
    return;
  }

  // Detach from whatever was bound before (the old process keeps running server-side).
  teardownCodeTerminal();

  const host = $("code-terminal");
  host.innerHTML = "";
  setTermStatus("connecting", mode === "attach" ? "Reattaching…" : "Connecting…");

  const term = new Terminal({
    cursorBlink: true,
    fontFamily: '"Cascadia Code", "JetBrains Mono", Consolas, monospace',
    fontSize: 13,
    lineHeight: 1.15,
    scrollback: 10000,
    theme: {
      background: "#0b0c10", foreground: "#e6e8ee", cursor: "#d97757",
      selectionBackground: "rgba(217,119,87,0.30)",
      black: "#0b0c10", brightBlack: "#5b6270",
      red: "#f85149", brightRed: "#ff7b72",
      green: "#3fb950", brightGreen: "#56d364",
      yellow: "#d29922", brightYellow: "#e3b341",
      blue: "#58a6ff", brightBlue: "#79c0ff",
      magenta: "#bc8cff", brightMagenta: "#d2a8ff",
      cyan: "#39c5cf", brightCyan: "#56d4dd",
      white: "#b1bac4", brightWhite: "#f0f6fc",
    },
  });
  const fit = new FitAddon.FitAddon();
  term.loadAddon(fit);
  term.open(host);
  fit.fit();

  if (mode === "attach") {
    term.writeln("\x1b[90mReattaching to session…\x1b[0m");
  } else {
    term.writeln("\x1b[38;5;208m◆ Claude Code on Ollama\x1b[0m");
    term.writeln(`\x1b[90mLaunching: ollama launch claude --model ${model}\x1b[0m`);
    term.writeln("");
  }

  const proto = location.protocol === "https:" ? "wss" : "ws";
  const params = { session: sessionId, mode, cols: term.cols, rows: term.rows };
  if (model) params.model = model;
  if (cwd) params.cwd = cwd;
  const qs = new URLSearchParams(params).toString();
  const ws = new WebSocket(`${proto}://${location.host}/pty?${qs}`);
  ws.binaryType = "arraybuffer";

  ws.onopen = () => {
    term.onData((d) => sendTerm({ type: "input", data: d }));
    term.onResize(({ cols, rows }) => sendTerm({ type: "resize", cols, rows }));
  };
  ws.onmessage = (ev) => {
    if (typeof ev.data === "string") {
      try { handleTermControl(JSON.parse(ev.data)); } catch {}
    } else {
      term.write(new Uint8Array(ev.data));
    }
  };
  ws.onclose = () => {
    if (ws._intentional) return; // we tore this socket down on purpose
    const wrap = $("term-status");
    const st = wrap && wrap.dataset.state;
    if (st !== "exited" && st !== "error" && st !== "stopped") {
      setTermStatus("exited", "Disconnected");
      try { term.writeln("\r\n\x1b[90m— connection closed —\x1b[0m"); } catch {}
    }
  };
  ws.onerror = () => setTermStatus("error", "Connection error");

  codeTerm.term = term;
  codeTerm.fit = fit;
  codeTerm.ws = ws;
  codeTerm.launched = true;
  codeTerm.sessionId = sessionId;

  const launchBtn = $("term-launch");
  const restartBtn = $("term-restart");
  if (launchBtn) launchBtn.hidden = true;
  if (restartBtn) restartBtn.hidden = false;

  codeTerm.onResize = () => {
    clearTimeout(codeTerm.fitTimer);
    codeTerm.fitTimer = setTimeout(() => { try { fit.fit(); } catch {} }, 80);
  };
  window.addEventListener("resize", codeTerm.onResize);
  setTimeout(() => term.focus(), 0);
}

// Open the folder picker for the terminal's working-directory field. Picks fill
// #term-cwd without touching the agent's CWD — Launch uses whatever's in the field.
function openFolderPickerForTermCwd() {
  const input = $("term-cwd");
  const initial = (input?.value || state.info?.cwd || "").trim();
  openFolderPicker(initial, {
    title: "Pick working directory",
    confirmLabel: "Use this folder",
    onConfirm: (picked) => { if (input) input.value = picked; },
  });
}

function wireCodeTerminal() {
  const launch = $("term-launch");
  if (launch) launch.addEventListener("click", launchCodeTerminal);
  const restart = $("term-restart");
  if (restart) restart.addEventListener("click", launchCodeTerminal);
  const newSession = $("new-term-session-btn");
  if (newSession) newSession.addEventListener("click", startNewTermSession);
  const browse = $("term-cwd-browse");
  if (browse) browse.addEventListener("click", openFolderPickerForTermCwd);
  const cwd = $("term-cwd");
  if (cwd) {
    cwd.addEventListener("keydown", (e) => {
      if (e.key === "Enter") { e.preventDefault(); launchCodeTerminal(); }
    });
  }
}

// ---------------- boot ----------------

loadAll();
loadModelPickerSettings();
applyUser();
wireUp();
wireAuth();
renderSidebarSessions();
renderTermSessions();
switchTab("code");
checkAuth().then((ok) => {
  if (ok) bootAuthedApp();
});
