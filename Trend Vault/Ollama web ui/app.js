/* ============================================================
   Ollama Studio — front-end logic
   Three views: Chat, Code, Models
   ============================================================ */

(() => {
  "use strict";

  /* ----------------------------------------------------------
     Constants & defaults
     ---------------------------------------------------------- */
  const STORAGE = {
    settings:           "ollama-chat:settings",
    chatConvs:          "ollama-chat:conversations",
    chatActive:         "ollama-chat:activeConversation",
    codeConvs:          "ollama-chat:codeConversations",
    codeActive:         "ollama-chat:codeActiveConversation",
    lastModelChat:      "ollama-chat:lastModel",
    lastModelCode:      "ollama-chat:lastCodeModel",
    activeView:         "ollama-chat:activeView",
    projects:           "ollama-chat:projects",
    activeProject:      "ollama-chat:activeProject",
    inProjectsView:     "ollama-chat:codeShowingProjects",
  };

  const DEFAULT_CODE_PROMPT =
    "You are an expert pair programmer. Be concise. When you write code, " +
    "use fenced code blocks with the correct language tag. Explain non-obvious " +
    "decisions in 1-2 sentences. If the user's request is ambiguous, ask one " +
    "clarifying question before writing code.";

  const DEFAULTS = {
    host: "",
    systemPrompt: "",
    codeSystemPrompt: DEFAULT_CODE_PROMPT,
    codeCwd: "",
    codeAllowedDirs: [],
    codeUnrestrictedFs: false,
    temperature: 0.7,
    topP: 0.9,
    topK: 40,
    numPredict: -1,
    repeatPenalty: 1.1,
  };

  // Models that tend to be the best coding picks if installed.
  const CODE_MODEL_HINTS = [
    "qwen2.5-coder", "deepseek-coder", "codellama", "codestral",
    "starcoder", "wizardcoder", "code",
  ];

  /* ----------------------------------------------------------
     State
     ---------------------------------------------------------- */
  let settings = loadSettings();
  let chatConvs = loadJSON(STORAGE.chatConvs, []);
  let codeConvs = loadJSON(STORAGE.codeConvs, []);
  let chatActiveId = localStorage.getItem(STORAGE.chatActive) || null;
  let codeActiveId = localStorage.getItem(STORAGE.codeActive) || null;
  let activeView = localStorage.getItem(STORAGE.activeView) || "chat"; // chat | code | models
  let currentAbortController = null;
  let isStreaming = false;
  let allModels = [];
  let pullAbort = null;

  // Projects (Code section): { id, name, cwd, allowedDirs, unrestrictedFs, createdAt, updatedAt }
  let projects = loadJSON(STORAGE.projects, []);
  let activeProjectId = localStorage.getItem(STORAGE.activeProject) || null;
  // When true (and we're in Code view), the main pane shows the projects grid
  // instead of the chat. Toggled by the "Projects" sidebar button.
  let inCodeProjectsView = localStorage.getItem(STORAGE.inProjectsView) === "1";

  // Local Code agent state
  let codeCheckInfo = null;          // { available, cwd, models, toolCapableModels }
  let currentCodeJobId = null;
  const codeToolUseEls = new Map();  // tool-call id -> DOM block

  // Files staged for the next outgoing Code message. Each entry:
  //   { id, name, sizeBytes, status: "uploading"|"done"|"error",
  //     relPath?, absPath?, error?, el }
  // Cleared after the message is sent so the agent only sees them once in-band.
  const stagedAttachments = [];
  let attachmentIdSeq = 0;
  let dragDepth = 0;

  // Directory picker modal state.
  let dirPickerCurrentPath = "";
  let dirPickerOnSelect = null;     // (absolutePath) => void
  let dirPickerSelectLabel = "Select this folder";

  /* ----------------------------------------------------------
     Element refs
     ---------------------------------------------------------- */
  const $ = (id) => document.getElementById(id);
  const el = {
    // sidebar
    sidebar: $("sidebar"),
    navTabs: document.querySelectorAll(".nav-tab"),
    newChatBtn: $("newChatBtn"),
    newChatLabel: $("newChatLabel"),
    conversations: $("conversations"),
    toggleSidebar: $("toggleSidebar"),
    settingsBtn: $("settingsBtn"),

    // topbar
    viewTitle: $("viewTitle"),
    modelPickerWrap: $("modelPickerWrap"),
    modelSelect: $("modelSelect"),
    statusDot: $("statusDot"),
    clearChatBtn: $("clearChatBtn"),

    // chat / code shared
    chatView: $("chatView"),
    chat: $("chat"),
    welcome: $("welcome"),
    welcomeTitle: $("welcomeTitle"),
    welcomeSubtitle: $("welcomeSubtitle"),
    welcomeTips: $("welcomeTips"),
    messages: $("messages"),
    form: $("composerForm"),
    input: $("input"),
    sendBtn: $("sendBtn"),
    stopBtn: $("stopBtn"),

    // models view
    modelsView: $("modelsView"),
    pullForm: $("pullForm"),
    pullInput: $("pullInput"),
    pullBtn: $("pullBtn"),
    pullCancel: $("pullCancel"),
    pullProgress: $("pullProgress"),
    pullProgressName: $("pullProgressName"),
    pullProgressStatus: $("pullProgressStatus"),
    pullProgressFill: $("pullProgressFill"),
    pullProgressDetail: $("pullProgressDetail"),
    modelsList: $("modelsList"),
    refreshModelsBtn: $("refreshModelsBtn"),

    // Local Code agent UI
    codeBanner: $("codeBanner"),
    codeCwd: $("codeCwd"),
    codeDirsBadge: $("codeDirsBadge"),
    codeStatus: $("codeStatus"),
    codeToolCap: $("codeToolCap"),
    codePickCwdBtn: $("codePickCwdBtn"),
    codeAddDirBtn: $("codeAddDirBtn"),

    // Composer: file upload + drop zone (Code view only)
    composer: document.querySelector(".composer"),
    attachBtn: $("attachBtn"),
    attachInput: $("attachInput"),
    attachments: $("attachments"),
    composerHint: $("composerHint"),
    dropOverlay: $("dropOverlay"),
    dropSub: $("dropSub"),

    // Directory picker modal
    dirPickerModal: $("dirPickerModal"),
    dirPickerClose: $("dirPickerClose"),
    dirPickerCancel: $("dirPickerCancel"),
    dirPickerSelect: $("dirPickerSelect"),
    dirPickerUp: $("dirPickerUp"),
    dirPickerHome: $("dirPickerHome"),
    dirPickerPath: $("dirPickerPath"),
    dirPickerGo: $("dirPickerGo"),
    dirPickerList: $("dirPickerList"),
    dirPickerCurrent: $("dirPickerCurrent"),
    codePickCwdSettingsBtn: $("codePickCwdSettingsBtn"),
    codeAddDirSettingsBtn: $("codeAddDirSettingsBtn"),

    // Projects
    codeProjectsView: $("codeProjectsView"),
    projectsGrid: $("projectsGrid"),
    projectsEmpty: $("projectsEmpty"),
    newProjectBtn: $("newProjectBtn"),
    projectsSortBtn: $("projectsSortBtn"),
    projectsSearchBtn: $("projectsSearchBtn"),
    projectsSearchInput: $("projectsSearchInput"),
    projectsLinkBtn: $("projectsLinkBtn"),
    projectsLinkCount: $("projectsLinkCount"),
    codeProjectChip: $("codeProjectChip"),
    codeProjectName: $("codeProjectName"),

    // Project modal
    projectModal: $("projectModal"),
    projectModalTitle: $("projectModalTitle"),
    projectModalClose: $("projectModalClose"),
    projectNameInput: $("projectNameInput"),
    projectCwdInput: $("projectCwdInput"),
    projectCwdBrowseBtn: $("projectCwdBrowseBtn"),
    projectAllowedDirsInput: $("projectAllowedDirsInput"),
    projectAllowedDirsCount: $("projectAllowedDirsCount"),
    projectAddDirBtn: $("projectAddDirBtn"),
    projectUnrestrictedInput: $("projectUnrestrictedInput"),
    projectDeleteBtn: $("projectDeleteBtn"),
    projectCancelBtn: $("projectCancelBtn"),
    projectSaveBtn: $("projectSaveBtn"),

    // settings modal
    modal: $("settingsModal"),
    closeSettings: $("closeSettings"),
    saveSettings: $("saveSettings"),
    resetSettings: $("resetSettings"),
    hostInput: $("hostInput"),
    systemPrompt: $("systemPrompt"),
    codeSystemPrompt: $("codeSystemPrompt"),
    codeCwdInput: $("codeCwdInput"),
    codeAllowedDirsInput: $("codeAllowedDirsInput"),
    codeAllowedDirsCount: $("codeAllowedDirsCount"),
    codeVerifyDirsBtn: $("codeVerifyDirsBtn"),
    codeVerifyDirsStatus: $("codeVerifyDirsStatus"),
    codeUnrestrictedInput: $("codeUnrestrictedInput"),
    codeUnrestrictedBadge: $("codeUnrestrictedBadge"),
    temperature: $("temperature"),
    tempValue: $("tempValue"),
    topP: $("topP"),
    topPValue: $("topPValue"),
    topK: $("topK"),
    topKValue: $("topKValue"),
    numPredict: $("numPredict"),
    numPredictValue: $("numPredictValue"),
    repeatPenalty: $("repeatPenalty"),
    repeatPenaltyValue: $("repeatPenaltyValue"),
  };

  /* ----------------------------------------------------------
     Storage helpers
     ---------------------------------------------------------- */
  function loadJSON(key, fallback) {
    try { return JSON.parse(localStorage.getItem(key)) || fallback; }
    catch { return fallback; }
  }
  function saveJSON(key, val) {
    localStorage.setItem(key, JSON.stringify(val));
  }

  function loadSettings() {
    return { ...DEFAULTS, ...loadJSON(STORAGE.settings, {}) };
  }
  function saveSettings() {
    saveJSON(STORAGE.settings, settings);
  }

  function saveChatConvs() {
    saveJSON(STORAGE.chatConvs, chatConvs);
    if (chatActiveId) localStorage.setItem(STORAGE.chatActive, chatActiveId);
    else localStorage.removeItem(STORAGE.chatActive);
  }
  function saveCodeConvs() {
    saveJSON(STORAGE.codeConvs, codeConvs);
    if (codeActiveId) localStorage.setItem(STORAGE.codeActive, codeActiveId);
    else localStorage.removeItem(STORAGE.codeActive);
  }

  /* ----------------------------------------------------------
     View context — chat vs code share the same DOM
     ---------------------------------------------------------- */
  function ctx() {
    if (activeView === "code") {
      return {
        view: "code",
        convs: codeConvs,
        get activeId() { return codeActiveId; },
        set activeId(v) { codeActiveId = v; },
        save: saveCodeConvs,
        systemPrompt: settings.codeSystemPrompt,
        lastModelKey: STORAGE.lastModelCode,
      };
    }
    return {
      view: "chat",
      convs: chatConvs,
      get activeId() { return chatActiveId; },
      set activeId(v) { chatActiveId = v; },
      save: saveChatConvs,
      systemPrompt: settings.systemPrompt,
      lastModelKey: STORAGE.lastModelChat,
    };
  }

  function getActiveConversation() {
    const c = ctx();
    return c.convs.find((x) => x.id === c.activeId) || null;
  }

  function createConversation() {
    const c = ctx();
    const conv = {
      id: "c_" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
      title: "New " + (c.view === "code" ? "task" : "chat"),
      model: el.modelSelect.value || "",
      messages: [],
      createdAt: Date.now(),
      view: c.view,
    };
    // Tag Code-mode conversations with the active project so the sidebar can
    // filter, and the project's chat count stays in sync.
    if (c.view === "code") {
      conv.projectId = activeProjectId || null;
    }
    c.convs.unshift(conv);
    c.activeId = conv.id;
    c.save();
    // Same as setActiveConversation: pop out of the projects grid so the
    // newly-created chat is actually visible.
    if (activeView === "code" && inCodeProjectsView) {
      inCodeProjectsView = false;
      localStorage.setItem(STORAGE.inProjectsView, "0");
      refreshViewPanes();
      refreshProjectsLinkBtn();
      if (el.codeBanner) el.codeBanner.hidden = false;
    }
    renderConversations();
    renderMessages();
    return conv;
  }

  function deleteConversation(id) {
    const c = ctx();
    const idx = c.convs.findIndex((x) => x.id === id);
    if (idx === -1) return;
    c.convs.splice(idx, 1);
    if (c.activeId === id) c.activeId = c.convs[0]?.id || null;
    c.save();
    renderConversations();
    renderMessages();
  }

  function setActiveConversation(id) {
    const c = ctx();
    c.activeId = id;
    c.save();
    // If we were viewing the projects grid in Code mode, jump back to the
    // chat so the clicked conversation is actually visible.
    if (activeView === "code" && inCodeProjectsView) {
      inCodeProjectsView = false;
      localStorage.setItem(STORAGE.inProjectsView, "0");
      refreshViewPanes();
      refreshProjectsLinkBtn();
      if (el.codeBanner) el.codeBanner.hidden = false;
    }
    renderConversations();
    renderMessages();
  }

  function setConversationTitle(conv, text) {
    const trimmed = text.trim().replace(/\s+/g, " ").slice(0, 60);
    if (trimmed && (conv.title === "New chat" || conv.title === "New task")) {
      conv.title = trimmed;
      ctx().save();
      renderConversations();
    }
  }

  /* ----------------------------------------------------------
     View switching
     ---------------------------------------------------------- */
  function setView(name) {
    if (!["chat", "code", "models"].includes(name)) return;
    activeView = name;
    localStorage.setItem(STORAGE.activeView, name);

    el.navTabs.forEach((t) => {
      const on = t.dataset.view === name;
      t.classList.toggle("active", on);
      t.setAttribute("aria-selected", on ? "true" : "false");
    });

    const inCode = name === "code";
    // First-time Code entry with projects but no active one → show grid.
    if (inCode && !activeProjectId && projects.length > 0 && !inCodeProjectsView) {
      inCodeProjectsView = true;
      localStorage.setItem(STORAGE.inProjectsView, "1");
    }
    // Leaving Code resets the projects-view sub-state.
    if (!inCode) {
      inCodeProjectsView = false;
    }
    refreshViewPanes();

    // Local Code mode keeps the Ollama model picker (the agent calls Ollama)
    // and shows an extra banner above the messages.
    el.modelPickerWrap.style.display = (name === "models") ? "none" : "";
    if (el.codeBanner) el.codeBanner.hidden = !inCode || inCodeProjectsView;
    el.clearChatBtn.style.display = (name === "models" || inCodeProjectsView) ? "none" : "";
    refreshProjectsLinkBtn();
    if (inCode && inCodeProjectsView) renderProjects();

    // Update labels
    if (name === "chat") {
      el.viewTitle.textContent = "Chat";
      el.newChatLabel.textContent = "New chat";
      el.welcomeTitle.textContent = "Ollama Chat";
      el.welcomeSubtitle.textContent =
        "Chat with your local Ollama models. Pick a model above and send a message to begin.";
      el.welcomeTips.hidden = true;
      el.input.placeholder = "Message Ollama…";
    } else if (name === "code") {
      el.viewTitle.textContent = "Local Code";
      el.newChatLabel.textContent = "New task";
      el.welcomeTitle.textContent = "Local Code";
      el.welcomeSubtitle.textContent =
        "Agentic coding with your local Ollama model — full read & write access to the project. " +
        "The agent loops through tool calls (read_file, write_file, edit_file, bash, glob, grep, list_dir) until done. " +
        "Pick a tool-capable model: llama3.1, qwen2.5-coder, mistral-nemo, etc.";
      el.welcomeTips.hidden = false;
      el.input.placeholder = "Tell the agent what to do — e.g. 'add a /healthz endpoint to server.ts'";
      // Check Ollama availability + show cwd / tool support.
      codeCheck();
    } else {
      el.viewTitle.textContent = "Models";
    }

    if (name !== "models") {
      // Use the picker's per-view model memory (separate buckets for chat & code).
      const c = ctx();
      const last = localStorage.getItem(c.lastModelKey);
      const installed = Array.from(el.modelSelect.options).map((o) => o.value);
      if (last && installed.includes(last)) {
        el.modelSelect.value = last;
      } else if (inCode) {
        // Prefer a tool-capable / coder model when entering Code mode for the first time.
        const preferred = installed.find((n) => /^(qwen2\.5-coder|llama3\.[12]|mistral-nemo|qwen3|llama3\.3)/i.test(n))
          || installed.find((n) => CODE_MODEL_HINTS.some((h) => n.toLowerCase().includes(h)));
        if (preferred) el.modelSelect.value = preferred;
      }
      renderConversations();
      renderMessages();
      if (inCode) refreshCodeBanner();
      // Sidebar shows the "new" button only for chat/code
      el.newChatBtn.parentElement.style.display = "";
    } else {
      el.newChatBtn.parentElement.style.display = "none";
      renderInstalledModels();
    }
    refreshComposerForView();
  }

  /* ----------------------------------------------------------
     Rendering: conversations + messages
     ---------------------------------------------------------- */
  function renderConversations() {
    const c = ctx();
    el.conversations.innerHTML = "";
    // In Code mode with an active project, only show that project's chats.
    // Otherwise (no active project, or in Chat mode) show all.
    const visible = (c.view === "code" && activeProjectId)
      ? c.convs.filter((x) => x.projectId === activeProjectId)
      : c.convs;
    if (visible.length === 0) {
      const empty = document.createElement("div");
      empty.className = "convs-empty";
      empty.textContent =
        c.view === "code"
          ? (activeProjectId ? "No chats in this project yet" : "No coding tasks yet")
          : "No conversations yet";
      el.conversations.appendChild(empty);
      return;
    }
    for (const conv of visible) {
      const item = document.createElement("div");
      item.className = "conv-item" + (conv.id === c.activeId ? " active" : "");
      item.dataset.id = conv.id;

      const title = document.createElement("span");
      title.className = "conv-title";
      title.textContent = conv.title || "Untitled";
      item.appendChild(title);

      const del = document.createElement("button");
      del.className = "conv-delete";
      del.title = "Delete";
      del.innerHTML =
        '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"></polyline><path d="M19 6l-2 14a2 2 0 0 1-2 2H9a2 2 0 0 1-2-2L5 6"></path></svg>';
      del.addEventListener("click", (e) => {
        e.stopPropagation();
        if (confirm(`Delete "${conv.title}"?`)) deleteConversation(conv.id);
      });
      item.appendChild(del);

      item.addEventListener("click", () => setActiveConversation(conv.id));
      el.conversations.appendChild(item);
    }
  }

  function renderMessages() {
    const conv = getActiveConversation();
    el.messages.innerHTML = "";
    if (!conv || conv.messages.length === 0) {
      el.welcome.classList.remove("hidden");
      return;
    }
    el.welcome.classList.add("hidden");
    const builder = activeView === "code" ? buildCodeMessageEl : buildMessageEl;
    for (const msg of conv.messages) {
      el.messages.appendChild(builder(msg, conv));
    }
    scrollToBottom();
  }

  function buildMessageEl(msg) {
    const wrapper = document.createElement("div");
    wrapper.className = "message " + msg.role;

    const avatar = document.createElement("div");
    avatar.className = "avatar";
    avatar.textContent = msg.role === "user" ? "U" : "AI";
    wrapper.appendChild(avatar);

    const body = document.createElement("div");
    body.className = "message-body";

    const role = document.createElement("div");
    role.className = "message-role";
    role.textContent = msg.role === "user" ? "You" : "Assistant";
    body.appendChild(role);

    const content = document.createElement("div");
    content.className = "message-content";
    content.innerHTML = renderMarkdown(msg.content || "");
    body.appendChild(content);

    wrapper.appendChild(body);
    return wrapper;
  }

  function scrollToBottom() {
    requestAnimationFrame(() => {
      el.chat.scrollTop = el.chat.scrollHeight;
    });
  }

  /* ----------------------------------------------------------
     Minimal markdown renderer
     ---------------------------------------------------------- */
  function escapeHtml(s) {
    return s.replace(/&/g, "&amp;").replace(/</g, "&lt;")
      .replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#039;");
  }

  function renderMarkdown(text) {
    if (!text) return "";
    const codeBlocks = [];
    text = text.replace(/```([a-zA-Z0-9_+-]*)\n?([\s\S]*?)```/g, (_, lang, code) => {
      const idx = codeBlocks.length;
      const langAttr = lang ? ` data-lang="${escapeHtml(lang)}"` : "";
      const langLabel = lang ? `<div class="code-lang">${escapeHtml(lang)}</div>` : "";
      codeBlocks.push(
        `<div class="code-block"${langAttr}>` +
        langLabel +
        `<button class="code-copy" type="button" data-action="copy-code">Copy</button>` +
        `<pre><code>${escapeHtml(code.replace(/\n$/, ""))}</code></pre>` +
        `</div>`
      );
      return ` CODEBLOCK${idx} `;
    });

    text = escapeHtml(text);
    text = text.replace(/`([^`\n]+)`/g, (_, c) => `<code>${c}</code>`);
    text = text.replace(/^###### (.+)$/gm, "<h6>$1</h6>");
    text = text.replace(/^##### (.+)$/gm, "<h5>$1</h5>");
    text = text.replace(/^#### (.+)$/gm, "<h4>$1</h4>");
    text = text.replace(/^### (.+)$/gm, "<h3>$1</h3>");
    text = text.replace(/^## (.+)$/gm, "<h2>$1</h2>");
    text = text.replace(/^# (.+)$/gm, "<h1>$1</h1>");
    text = text.replace(/\*\*([^*\n]+)\*\*/g, "<strong>$1</strong>");
    text = text.replace(/\*([^*\n]+)\*/g, "<em>$1</em>");
    text = text.replace(/(^|\s)_([^_\n]+)_(?=\s|$)/g, "$1<em>$2</em>");
    text = text.replace(
      /\[([^\]]+)\]\(([^)\s]+)\)/g,
      '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>'
    );
    text = text.replace(/^&gt; (.+)$/gm, "<blockquote>$1</blockquote>");

    text = text.replace(/(?:^|\n)((?:[-*] .+(?:\n|$))+)/g, (_, block) => {
      const items = block.trim().split("\n")
        .map((line) => line.replace(/^[-*] /, ""))
        .map((line) => `<li>${line}</li>`).join("");
      return `\n<ul>${items}</ul>`;
    });
    text = text.replace(/(?:^|\n)((?:\d+\. .+(?:\n|$))+)/g, (_, block) => {
      const items = block.trim().split("\n")
        .map((line) => line.replace(/^\d+\. /, ""))
        .map((line) => `<li>${line}</li>`).join("");
      return `\n<ol>${items}</ol>`;
    });

    const paragraphs = text.split(/\n{2,}/).map((para) => {
      if (/^\s*<(h\d|ul|ol|pre|blockquote|div)/.test(para)) return para;
      return `<p>${para.replace(/\n/g, "<br>")}</p>`;
    });
    text = paragraphs.join("\n");
    text = text.replace(/ CODEBLOCK(\d+) /g, (_, i) => codeBlocks[+i]);
    return text;
  }

  // Delegate Copy-to-clipboard for code blocks
  el.messages.addEventListener("click", (e) => {
    const btn = e.target.closest('[data-action="copy-code"]');
    if (!btn) return;
    const pre = btn.parentElement.querySelector("pre code");
    if (!pre) return;
    navigator.clipboard.writeText(pre.innerText).then(() => {
      const orig = btn.textContent;
      btn.textContent = "Copied";
      setTimeout(() => (btn.textContent = orig), 1200);
    });
  });

  /* ----------------------------------------------------------
     Ollama: list / pull / delete models
     ---------------------------------------------------------- */
  async function fetchModels() {
    try {
      const res = await fetch(`${settings.host}/api/tags`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      allModels = data.models || [];
      const names = allModels.map((m) => m.name).sort();
      populateModelSelect(names);
      setStatus(true);
      if (activeView === "models") renderInstalledModels();
      return names;
    } catch (err) {
      console.error("Failed to list models:", err);
      allModels = [];
      populateModelSelect([], err.message);
      setStatus(false);
      if (activeView === "models") renderInstalledModels();
      return [];
    }
  }

  function populateModelSelect(models, errorMsg) {
    el.modelSelect.innerHTML = "";
    if (models.length === 0) {
      const opt = document.createElement("option");
      opt.value = "";
      opt.textContent = errorMsg
        ? "Can't reach Ollama"
        : "No models — pull one in the Models tab";
      el.modelSelect.appendChild(opt);
      el.modelSelect.disabled = true;
      return;
    }
    el.modelSelect.disabled = false;
    for (const name of models) {
      const opt = document.createElement("option");
      opt.value = name;
      opt.textContent = name;
      el.modelSelect.appendChild(opt);
    }
    const c = activeView !== "models" ? ctx() : null;
    const lastKey = c ? c.lastModelKey :
      (activeView === "code" ? STORAGE.lastModelCode : STORAGE.lastModelChat);
    const last = localStorage.getItem(lastKey);
    if (last && models.includes(last)) {
      el.modelSelect.value = last;
    } else if (activeView === "code") {
      const coder = models.find((n) =>
        CODE_MODEL_HINTS.some((h) => n.toLowerCase().includes(h))
      );
      if (coder) el.modelSelect.value = coder;
    }
  }

  function setStatus(online) {
    el.statusDot.classList.toggle("online", online);
    el.statusDot.classList.toggle("offline", !online);
    el.statusDot.title = online
      ? `Connected to ${settings.host || "ollama proxy"}`
      : `Can't reach ${settings.host || "ollama proxy"}`;
  }

  function formatBytes(n) {
    if (!Number.isFinite(n) || n <= 0) return "—";
    const units = ["B", "KB", "MB", "GB", "TB"];
    let i = 0;
    while (n >= 1024 && i < units.length - 1) { n /= 1024; i++; }
    return `${n.toFixed(n >= 10 || i === 0 ? 0 : 1)} ${units[i]}`;
  }

  function formatRelative(iso) {
    try {
      const t = new Date(iso).getTime();
      if (!Number.isFinite(t)) return "";
      const diff = Date.now() - t;
      const sec = Math.floor(diff / 1000);
      if (sec < 60) return `${sec}s ago`;
      const min = Math.floor(sec / 60);
      if (min < 60) return `${min}m ago`;
      const hr = Math.floor(min / 60);
      if (hr < 24) return `${hr}h ago`;
      const day = Math.floor(hr / 24);
      if (day < 30) return `${day}d ago`;
      return new Date(t).toLocaleDateString();
    } catch { return ""; }
  }

  function renderInstalledModels() {
    el.modelsList.innerHTML = "";
    if (!allModels.length) {
      const empty = document.createElement("div");
      empty.className = "models-empty";
      empty.textContent = "No models installed yet. Pull one above to get started.";
      el.modelsList.appendChild(empty);
      return;
    }
    for (const m of allModels.slice().sort((a, b) => a.name.localeCompare(b.name))) {
      const row = document.createElement("div");
      row.className = "model-row";
      row.innerHTML =
        `<div class="model-info">
           <div class="model-name">${escapeHtml(m.name)}</div>
           <div class="model-meta">
             <span>${formatBytes(m.size)}</span>
             <span class="dot-sep">•</span>
             <span>${escapeHtml(m.details?.parameter_size || "")}</span>
             <span class="dot-sep">•</span>
             <span>${escapeHtml(m.details?.quantization_level || "")}</span>
             <span class="dot-sep">•</span>
             <span>modified ${formatRelative(m.modified_at)}</span>
           </div>
         </div>
         <div class="model-actions">
           <button class="btn-link" data-act="use" data-name="${escapeHtml(m.name)}">Use in chat</button>
           <button class="btn-link danger" data-act="delete" data-name="${escapeHtml(m.name)}">Delete</button>
         </div>`;
      el.modelsList.appendChild(row);
    }
  }

  el.modelsList.addEventListener("click", async (e) => {
    const btn = e.target.closest("[data-act]");
    if (!btn) return;
    const name = btn.dataset.name;
    if (btn.dataset.act === "use") {
      el.modelSelect.value = name;
      localStorage.setItem(STORAGE.lastModelChat, name);
      setView("chat");
    } else if (btn.dataset.act === "delete") {
      if (!confirm(`Delete "${name}"? This removes the model files from disk.`)) return;
      try {
        const r = await fetch(`${settings.host}/api/delete`, {
          method: "DELETE",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ name }),
        });
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        fetchModels();
      } catch (err) {
        alert("Delete failed: " + err.message);
      }
    }
  });

  async function pullModel(name) {
    name = name.trim();
    if (!name) return;
    if (pullAbort) { alert("A pull is already in progress."); return; }
    pullAbort = new AbortController();

    el.pullProgress.classList.remove("hidden");
    el.pullProgressName.textContent = name;
    el.pullProgressStatus.textContent = "Connecting…";
    el.pullProgressFill.style.width = "0%";
    el.pullProgressDetail.textContent = "";
    el.pullBtn.disabled = true;

    try {
      const res = await fetch(`${settings.host}/api/pull`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name, stream: true }),
        signal: pullAbort.signal,
      });
      if (!res.ok) {
        const t = await res.text().catch(() => "");
        throw new Error(`HTTP ${res.status} — ${t || res.statusText}`);
      }
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let nl;
        while ((nl = buffer.indexOf("\n")) !== -1) {
          const line = buffer.slice(0, nl).trim();
          buffer = buffer.slice(nl + 1);
          if (!line) continue;
          try {
            const obj = JSON.parse(line);
            updatePullProgress(obj);
          } catch (e) { /* ignore */ }
        }
      }
      el.pullProgressStatus.textContent = "Done";
      el.pullProgressFill.style.width = "100%";
      el.pullProgressDetail.textContent = `${name} installed`;
      fetchModels();
    } catch (err) {
      if (err.name === "AbortError") {
        el.pullProgressStatus.textContent = "Cancelled";
      } else {
        el.pullProgressStatus.textContent = "Failed";
        el.pullProgressDetail.textContent = err.message;
      }
    } finally {
      el.pullBtn.disabled = false;
      pullAbort = null;
    }
  }

  function updatePullProgress(obj) {
    if (obj.error) {
      el.pullProgressStatus.textContent = "Error";
      el.pullProgressDetail.textContent = obj.error;
      return;
    }
    if (obj.status) el.pullProgressStatus.textContent = obj.status;
    if (obj.total && obj.completed != null) {
      const pct = Math.min(100, (obj.completed / obj.total) * 100);
      el.pullProgressFill.style.width = pct.toFixed(1) + "%";
      el.pullProgressDetail.textContent =
        `${formatBytes(obj.completed)} of ${formatBytes(obj.total)} (${pct.toFixed(1)}%)`;
    }
  }

  /* ----------------------------------------------------------
     Local Code: Ollama tool-call agent client
     ---------------------------------------------------------- */
  function parseAllowedDirsText(text) {
    if (!text) return [];
    return text.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
  }

  function allowedDirsAsText(arr) {
    return Array.isArray(arr) ? arr.join("\n") : "";
  }

  async function codeCheck() {
    try {
      const r = await fetch("/local-code/check");
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      codeCheckInfo = await r.json();
    } catch (err) {
      codeCheckInfo = { available: false, error: err.message };
    }
    refreshCodeBanner();
    return codeCheckInfo;
  }

  function refreshCodeBanner() {
    if (!el.codeBanner) return;
    const info = codeCheckInfo || {};
    const eff = effectiveCodeContext();
    // Effective cwd: project value (if any) → Settings → server default.
    const cwd = eff.cwd || info.cwd || "(unknown cwd)";
    el.codeCwd.textContent = cwd;
    el.codeCwd.title = cwd + (eff.source === "project" ? `  (from project "${eff.projectName}")` : "");

    const dirs = eff.allowedDirs;
    if (el.codeDirsBadge) {
      el.codeDirsBadge.textContent = dirs.length === 0
        ? "no extra dirs"
        : `+${dirs.length} dir${dirs.length === 1 ? "" : "s"}`;
      el.codeDirsBadge.title = dirs.length
        ? "Additional roots the agent can read/edit:\n" + dirs.join("\n")
        : "Add directories to give the agent access to more roots.";
    }

    // Active project chip — visible only when a project is active.
    if (el.codeProjectChip && el.codeProjectName) {
      const proj = getActiveProject();
      if (proj) {
        el.codeProjectChip.hidden = false;
        el.codeProjectName.textContent = proj.name || derivedProjectName(proj.cwd) || "Project";
        el.codeProjectChip.title = `Active project: ${proj.name}\nClick to switch projects.`;
      } else {
        el.codeProjectChip.hidden = true;
      }
    }

    if (info.available) {
      el.codeStatus.textContent = `Ollama: ${(info.models || []).length} models`;
      el.codeStatus.title = info.ollamaHost || "";
      el.codeStatus.classList.remove("error");
    } else if (info.error) {
      el.codeStatus.textContent = "Ollama unreachable";
      el.codeStatus.title = info.error;
      el.codeStatus.classList.add("error");
    } else {
      el.codeStatus.textContent = "checking…";
      el.codeStatus.classList.remove("error");
    }

    const model = el.modelSelect?.value || "";
    const toolModels = info.toolCapableModels || [];
    if (!model) {
      el.codeToolCap.textContent = "no model picked";
      el.codeToolCap.classList.remove("error");
    } else if (toolModels.includes(model)) {
      el.codeToolCap.textContent = "tools: yes";
      el.codeToolCap.title = "Model is in the known-tool-capable list.";
      el.codeToolCap.classList.remove("error");
    } else {
      el.codeToolCap.textContent = "tools: maybe";
      el.codeToolCap.title =
        "Not in the known-tool-capable list. The agent will still try, " +
        "but may fall back to plain chat if the model can't emit tool_calls.";
      el.codeToolCap.classList.remove("error");
    }

    if (el.codeUnrestrictedBadge) {
      el.codeUnrestrictedBadge.hidden = eff.unrestrictedFs !== true;
    }
  }

  function buildToolUseBlock(toolName, input) {
    // Claude Code TUI style: one bullet-prefixed call line, one indented
    // result line, and a click-to-expand block for full I/O.
    const block = document.createElement("div");
    block.className = "tool-use status-running";
    block.dataset.tool = toolName || "tool";

    const call = document.createElement("div");
    call.className = "tool-call-line";
    const bullet = document.createElement("span");
    bullet.className = "tool-bullet";
    bullet.textContent = "●";
    const callText = document.createElement("span");
    callText.className = "tool-call-text";
    callText.textContent = formatToolCall(toolName, input);
    call.appendChild(bullet);
    call.appendChild(callText);
    block.appendChild(call);

    const resultLine = document.createElement("div");
    resultLine.className = "tool-result-line";
    const arrow = document.createElement("span");
    arrow.className = "tool-result-arrow";
    arrow.textContent = "⎿";
    const snippet = document.createElement("span");
    snippet.className = "tool-result-snippet";
    snippet.textContent = "running…";
    resultLine.appendChild(arrow);
    resultLine.appendChild(snippet);
    block.appendChild(resultLine);

    const detail = document.createElement("details");
    detail.className = "tool-use-detail";
    const sum = document.createElement("summary");
    sum.textContent = "expand";
    detail.appendChild(sum);

    const inputPre = document.createElement("pre");
    inputPre.className = "tool-use-input";
    inputPre.textContent = safeJsonStringify(input);
    detail.appendChild(inputPre);

    const resultPre = document.createElement("pre");
    resultPre.className = "tool-use-result hidden";
    detail.appendChild(resultPre);

    block.appendChild(detail);
    block._snippet = snippet;
    block._resultPre = resultPre;
    return block;
  }

  // Render a tool call as `tool_name(key-arg)` for the one-line headline.
  function formatToolCall(name, input) {
    const n = (name || "").toLowerCase();
    const arg = (s) => {
      if (typeof s !== "string") return "";
      return s.length > 70 ? s.slice(0, 70) + "…" : s;
    };
    if (n === "read_file" || n === "write_file" || n === "edit_file" || n === "list_dir") {
      return `${name}(${arg(input?.path || "")})`;
    }
    if (n === "bash") return `${name}(${arg(input?.command || "")})`;
    if (n === "grep") {
      const p = input?.pattern || "";
      const where = input?.path ? `, ${arg(input.path)}` : "";
      return `${name}(${arg(p)}${where})`;
    }
    if (n === "glob") return `${name}(${arg(input?.pattern || "")})`;
    return `${name}(${arg(safeJsonStringify(input || {}))})`;
  }

  function toolIcon(name) {
    const n = (name || "").toLowerCase();
    if (n === "read_file") return "📖";
    if (n === "edit_file") return "✏️";
    if (n === "write_file") return "📝";
    if (n === "bash") return "▶";
    if (n === "grep") return "🔎";
    if (n === "glob") return "📁";
    if (n === "list_dir") return "📂";
    return "⚙";
  }

  function summarizeToolInput(name, input) {
    if (!input || typeof input !== "object") return "";
    const n = (name || "").toLowerCase();
    if (n === "read_file" || n === "write_file" || n === "edit_file") {
      return input.path || "";
    }
    if (n === "bash") {
      const cmd = (input.command || "").toString();
      return cmd.length > 80 ? cmd.slice(0, 80) + "…" : cmd;
    }
    if (n === "grep" || n === "glob") {
      return input.pattern || "";
    }
    if (n === "list_dir") return input.path || ".";
    return "";
  }

  function safeJsonStringify(v) {
    try { return JSON.stringify(v, null, 2); }
    catch { return String(v); }
  }

  function attachToolResult(block, content, isError) {
    if (!block) return;
    block.classList.remove("status-running");
    block.classList.add(isError ? "status-error" : "status-ok");

    // One-line snippet under the call line — the part you can read at a glance.
    if (block._snippet) {
      block._snippet.textContent = summarizeToolResult(block.dataset.tool, content, isError);
    }

    // Full I/O, hidden behind the "expand" disclosure.
    const pre = block._resultPre;
    if (pre) {
      pre.classList.remove("hidden");
      let text;
      if (typeof content === "string") text = content;
      else if (Array.isArray(content)) {
        text = content.map((c) => (typeof c === "string" ? c : c.text || safeJsonStringify(c))).join("\n");
      } else text = safeJsonStringify(content);
      if (text.length > 8000) text = text.slice(0, 8000) + `\n…\n[truncated, ${text.length} chars total]`;
      pre.textContent = text;
    }
  }

  // Produce the dim one-liner that goes under the call (e.g. "Read 245 lines, 8 KB").
  function summarizeToolResult(toolName, content, isError) {
    if (isError) {
      const msg = content && content.error ? content.error : (typeof content === "string" ? content : safeJsonStringify(content));
      return `Error: ${msg.length > 200 ? msg.slice(0, 200) + "…" : msg}`;
    }
    const n = (toolName || "").toLowerCase();
    const obj = content || {};
    const fmtBytes = (b) => {
      if (!Number.isFinite(b)) return "";
      if (b < 1024) return `${b}B`;
      if (b < 1024 * 1024) return `${(b / 1024).toFixed(1)} KB`;
      return `${(b / (1024 * 1024)).toFixed(2)} MB`;
    };

    if (n === "read_file") {
      const lines = (obj.content || "").split(/\r?\n/).length;
      const size = fmtBytes(obj.bytes);
      return `Read ${lines} line${lines === 1 ? "" : "s"}${size ? `, ${size}` : ""}`;
    }
    if (n === "write_file") return `Wrote ${fmtBytes(obj.bytes) || "OK"}`;
    if (n === "edit_file") return `Replaced 1 occurrence at offset ${obj.replacedAt ?? "?"}`;
    if (n === "list_dir") return `${(obj.entries || []).length} entries`;
    if (n === "glob") return `${obj.count ?? (obj.paths || []).length} matches`;
    if (n === "grep") return `${obj.count ?? (obj.hits || []).length} hits`;
    if (n === "bash") {
      const ec = obj.exitCode;
      const out = (obj.stdout || "").length;
      const err = (obj.stderr || "").length;
      const head = (obj.stdout || obj.stderr || "").split(/\r?\n/, 1)[0].slice(0, 80);
      return `exit ${ec ?? "?"}, ${out}B out / ${err}B err${head ? ` · ${head}` : ""}`;
    }
    // Generic fallback.
    if (typeof content === "string") return content.split(/\r?\n/, 1)[0].slice(0, 120);
    return "done";
  }

  // Two-letter avatar derived from the model name, e.g.
  //   "qwen2.5-coder:7b" → "QW"   "llama3.2" → "LL"   "deepseek-coder" → "DE"
  // Falls back to "AG" if no model is known.
  function modelAvatar(modelName) {
    if (!modelName) return "AG";
    const alpha = modelName.replace(/[^a-zA-Z]/g, "");
    const seed = alpha.length >= 2 ? alpha : modelName;
    return seed.slice(0, 2).toUpperCase() || "AG";
  }

  function buildCodeMessageEl(msg, conv) {
    const wrapper = document.createElement("div");
    wrapper.className = "message " + msg.role + " code-msg";

    // Use the model stored on the message (or the conversation, or the
    // currently-picked model as a last resort) so the assistant turn is
    // labelled with whatever produced it.
    const modelName = msg.model || (conv && conv.model) || el.modelSelect.value || "";

    const avatar = document.createElement("div");
    avatar.className = "avatar";
    avatar.textContent = msg.role === "user" ? "U" : modelAvatar(modelName);
    if (msg.role !== "user" && modelName) avatar.title = modelName;
    wrapper.appendChild(avatar);

    const body = document.createElement("div");
    body.className = "message-body";

    const role = document.createElement("div");
    role.className = "message-role";
    role.textContent = msg.role === "user" ? "You" : (modelName || "Agent");
    body.appendChild(role);

    const blocksEl = document.createElement("div");
    blocksEl.className = "message-blocks";
    body.appendChild(blocksEl);

    wrapper.appendChild(body);
    wrapper._blocksEl = blocksEl;

    // Replay any pre-existing blocks (when re-rendering history).
    const blocks = msg.blocks || (msg.content ? [{ type: "text", text: msg.content }] : []);
    for (const b of blocks) {
      appendBlockEl(blocksEl, b);
    }
    return wrapper;
  }

  function appendBlockEl(blocksEl, b) {
    if (!b) return null;
    if (b.type === "text") {
      const div = document.createElement("div");
      div.className = "message-content";
      div.innerHTML = renderMarkdown(b.text || "");
      blocksEl.appendChild(div);
      return div;
    }
    if (b.type === "tool_use") {
      const block = buildToolUseBlock(b.name, b.input);
      if (b.result !== undefined) attachToolResult(block, b.result, b.isError);
      blocksEl.appendChild(block);
      return block;
    }
    if (b.type === "attachments") {
      const wrap = document.createElement("div");
      wrap.className = "message-attachments";
      for (const it of (b.items || [])) {
        const chip = document.createElement("div");
        chip.className = "attachment-chip status-done in-message";
        const icon = document.createElement("span");
        icon.className = "attachment-icon"; icon.textContent = "📄";
        chip.appendChild(icon);
        const name = document.createElement("span");
        name.className = "attachment-name";
        name.textContent = it.relPath || it.name || "(file)";
        name.title = it.relPath || it.name || "";
        chip.appendChild(name);
        if (Number.isFinite(it.sizeBytes) && it.sizeBytes > 0) {
          const size = document.createElement("span");
          size.className = "attachment-size";
          size.textContent = formatChipSize(it.sizeBytes);
          chip.appendChild(size);
        }
        wrap.appendChild(chip);
      }
      blocksEl.appendChild(wrap);
      return wrap;
    }
    return null;
  }

  function updateAllowedDirsCount() {
    if (!el.codeAllowedDirsCount || !el.codeAllowedDirsInput) return;
    const n = parseAllowedDirsText(el.codeAllowedDirsInput.value).length;
    el.codeAllowedDirsCount.textContent = String(n);
  }

  async function verifyAllowedDirs() {
    if (!el.codeAllowedDirsInput || !el.codeVerifyDirsStatus) return;
    const dirs = parseAllowedDirsText(el.codeAllowedDirsInput.value);
    if (dirs.length === 0) {
      el.codeVerifyDirsStatus.textContent = "Nothing to verify — add at least one path.";
      el.codeVerifyDirsStatus.classList.remove("error", "ok");
      return;
    }
    el.codeVerifyDirsBtn.disabled = true;
    el.codeVerifyDirsStatus.textContent = "Verifying…";
    el.codeVerifyDirsStatus.classList.remove("error", "ok");
    try {
      const r = await fetch("/local-code/verify-dirs", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ dirs }),
      });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const data = await r.json();
      const results = Array.isArray(data.results) ? data.results : [];
      const bad = results.filter((x) => !x.ok);
      if (bad.length === 0) {
        el.codeVerifyDirsStatus.textContent = `All ${results.length} paths look good ✓`;
        el.codeVerifyDirsStatus.classList.add("ok");
        el.codeVerifyDirsStatus.classList.remove("error");
      } else {
        const detail = bad.map((b) => `${b.input || "(empty)"} — ${b.reason}`).join("; ");
        el.codeVerifyDirsStatus.textContent = `${bad.length} of ${results.length} failed: ${detail}`;
        el.codeVerifyDirsStatus.classList.add("error");
        el.codeVerifyDirsStatus.classList.remove("ok");
      }
    } catch (err) {
      el.codeVerifyDirsStatus.textContent = `Verify failed: ${err.message}`;
      el.codeVerifyDirsStatus.classList.add("error");
      el.codeVerifyDirsStatus.classList.remove("ok");
    } finally {
      el.codeVerifyDirsBtn.disabled = false;
    }
  }

  /* ----------------------------------------------------------
     File uploads — drop / pick → POST /local-code/upload
     ---------------------------------------------------------- */
  function formatChipSize(n) {
    if (!Number.isFinite(n) || n <= 0) return "";
    if (n < 1024) return `${n}B`;
    if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
    return `${(n / (1024 * 1024)).toFixed(2)} MB`;
  }

  // Build the X-Code-Context header value (base64 JSON) so the server can
  // validate the upload target against the same cwd + allowedDirs the chat
  // endpoint sees.
  function buildCodeContextHeader() {
    const eff = effectiveCodeContext();
    const cwd = eff.cwd || (codeCheckInfo && codeCheckInfo.cwd) || "";
    const json = JSON.stringify({
      cwd,
      allowedDirs: eff.allowedDirs,
      unrestrictedFs: eff.unrestrictedFs,
    });
    return btoa(unescape(encodeURIComponent(json)));
  }

  function renderAttachments() {
    if (!el.attachments) return;
    if (stagedAttachments.length === 0) {
      el.attachments.hidden = true;
      el.attachments.innerHTML = "";
      return;
    }
    el.attachments.hidden = false;
    el.attachments.innerHTML = "";
    for (const att of stagedAttachments) {
      const chip = document.createElement("div");
      chip.className = `attachment-chip status-${att.status}`;
      chip.dataset.id = att.id;

      const icon = document.createElement("span");
      icon.className = "attachment-icon";
      icon.textContent =
        att.status === "uploading" ? "⏳" :
        att.status === "error" ? "✕" : "📄";
      chip.appendChild(icon);

      const name = document.createElement("span");
      name.className = "attachment-name";
      name.title = att.error || att.relPath || att.name;
      name.textContent = att.name;
      chip.appendChild(name);

      const size = document.createElement("span");
      size.className = "attachment-size";
      size.textContent =
        att.status === "uploading" ? "uploading…" :
        att.status === "error" ? (att.error || "failed") :
        formatChipSize(att.sizeBytes);
      chip.appendChild(size);

      const del = document.createElement("button");
      del.type = "button";
      del.className = "attachment-remove";
      del.title = "Remove";
      del.textContent = "×";
      del.addEventListener("click", () => {
        const idx = stagedAttachments.findIndex((x) => x.id === att.id);
        if (idx !== -1) stagedAttachments.splice(idx, 1);
        renderAttachments();
      });
      chip.appendChild(del);

      el.attachments.appendChild(chip);
    }
  }

  async function uploadOneFile(file) {
    const id = "att_" + (++attachmentIdSeq);
    const entry = {
      id,
      name: file.name || "upload",
      sizeBytes: file.size || 0,
      status: "uploading",
    };
    stagedAttachments.push(entry);
    renderAttachments();
    try {
      const ab = await file.arrayBuffer();
      const qs = new URLSearchParams({
        filename: file.name || "upload.bin",
        target: "primary",
      });
      const res = await fetch(`/local-code/upload?${qs}`, {
        method: "POST",
        headers: {
          "Content-Type": file.type || "application/octet-stream",
          "X-Code-Context": buildCodeContextHeader(),
        },
        body: ab,
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || !data.ok) {
        throw new Error(data.error || `HTTP ${res.status}`);
      }
      entry.status = "done";
      entry.relPath = data.relPath;
      entry.absPath = data.path;
      entry.sizeBytes = data.bytes ?? entry.sizeBytes;
      entry.name = data.name || entry.name;
    } catch (err) {
      entry.status = "error";
      entry.error = err.message;
    }
    renderAttachments();
  }

  async function handlePickedFiles(files) {
    if (!files || files.length === 0) return;
    for (const f of Array.from(files)) {
      // Run uploads in parallel — they're independent POSTs.
      uploadOneFile(f).catch((err) => console.error("upload failed:", err));
    }
  }

  function setDropOverlayShown(show) {
    if (!el.dropOverlay) return;
    el.dropOverlay.classList.toggle("hidden", !show);
  }

  // Install drag-and-drop on the chat area. Active only in Code view.
  function installDropHandlers() {
    const target = el.chatView;
    if (!target) return;
    const isInCodeView = () => activeView === "code";

    target.addEventListener("dragenter", (e) => {
      if (!isInCodeView()) return;
      if (!e.dataTransfer || !Array.from(e.dataTransfer.types).includes("Files")) return;
      e.preventDefault();
      dragDepth++;
      setDropOverlayShown(true);
    });
    target.addEventListener("dragover", (e) => {
      if (!isInCodeView()) return;
      if (!e.dataTransfer || !Array.from(e.dataTransfer.types).includes("Files")) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = "copy";
    });
    target.addEventListener("dragleave", (e) => {
      if (!isInCodeView()) return;
      dragDepth = Math.max(0, dragDepth - 1);
      if (dragDepth === 0) setDropOverlayShown(false);
    });
    target.addEventListener("drop", (e) => {
      if (!isInCodeView()) return;
      e.preventDefault();
      dragDepth = 0;
      setDropOverlayShown(false);
      const files = e.dataTransfer?.files;
      if (files && files.length) handlePickedFiles(files);
    });
  }

  // Show / hide composer chrome when entering/leaving Code view.
  function refreshComposerForView() {
    const inCode = activeView === "code";
    if (el.attachBtn) el.attachBtn.classList.toggle("hidden", !inCode);
    if (!inCode) {
      stagedAttachments.length = 0;
      renderAttachments();
      setDropOverlayShown(false);
    } else {
      renderAttachments();
    }
    if (el.composerHint) {
      el.composerHint.textContent = inCode
        ? "Enter to send · Shift+Enter for newline · drop files to attach"
        : "Press Enter to send · Shift+Enter for newline";
    }
  }

  /* ----------------------------------------------------------
     Directory picker modal — browses the real server-side filesystem
     ---------------------------------------------------------- */
  function openDirPicker({ title, selectLabel, initialPath, onSelect }) {
    dirPickerOnSelect = typeof onSelect === "function" ? onSelect : null;
    dirPickerSelectLabel = selectLabel || "Select this folder";
    const titleEl = document.getElementById("dirPickerTitle");
    if (titleEl) titleEl.textContent = title || "Pick a directory";
    if (el.dirPickerSelect) el.dirPickerSelect.textContent = dirPickerSelectLabel;
    el.dirPickerModal.classList.remove("hidden");
    el.dirPickerModal.setAttribute("aria-hidden", "false");
    loadDirPicker(initialPath || "");
  }

  function closeDirPicker() {
    el.dirPickerModal.classList.add("hidden");
    el.dirPickerModal.setAttribute("aria-hidden", "true");
    dirPickerOnSelect = null;
  }

  async function loadDirPicker(absPath) {
    dirPickerCurrentPath = absPath || "";
    if (el.dirPickerPath) el.dirPickerPath.value = absPath || "";
    if (el.dirPickerCurrent) {
      el.dirPickerCurrent.textContent = absPath || "(drives)";
      el.dirPickerCurrent.title = absPath || "";
    }
    if (el.dirPickerList) {
      el.dirPickerList.innerHTML = '<div class="dir-picker-empty">Loading…</div>';
    }
    let data;
    try {
      const qs = new URLSearchParams({ path: absPath || "" });
      const res = await fetch(`/local-code/fs/list?${qs}`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      data = await res.json();
    } catch (err) {
      el.dirPickerList.innerHTML =
        `<div class="dir-picker-empty error">Couldn't list: ${escapeHtml(err.message)}</div>`;
      return;
    }
    renderDirPickerEntries(data);
  }

  function renderDirPickerEntries(data) {
    if (!el.dirPickerList) return;
    el.dirPickerList.innerHTML = "";

    if (data.error) {
      const empty = document.createElement("div");
      empty.className = "dir-picker-empty error";
      empty.textContent = data.error;
      el.dirPickerList.appendChild(empty);
    }

    if (!data.isRoot && data.parent !== null) {
      const up = document.createElement("button");
      up.type = "button";
      up.className = "dir-picker-row dir-picker-up";
      up.innerHTML =
        '<span class="dir-picker-icon">⬆</span>' +
        '<span class="dir-picker-name">.. (up one level)</span>';
      up.addEventListener("click", () => loadDirPicker(data.parent || ""));
      el.dirPickerList.appendChild(up);
    }

    const entries = Array.isArray(data.entries) ? data.entries : [];
    if (entries.length === 0 && !data.error) {
      const empty = document.createElement("div");
      empty.className = "dir-picker-empty";
      empty.textContent = data.isRoot ? "No drives detected." : "(empty)";
      el.dirPickerList.appendChild(empty);
      return;
    }

    for (const entry of entries) {
      const row = document.createElement("button");
      row.type = "button";
      row.className = "dir-picker-row";
      const icon = entry.type === "drive" ? "💽" :
                   entry.type === "dir" ? "📁" :
                   entry.type === "symlink" ? "🔗" : "📄";
      row.innerHTML =
        `<span class="dir-picker-icon">${icon}</span>` +
        `<span class="dir-picker-name">${escapeHtml(entry.name)}</span>`;
      // Only dirs/drives are navigable; we don't list files in the picker by default.
      if (entry.type === "dir" || entry.type === "drive") {
        row.addEventListener("click", () => loadDirPicker(entry.path));
      } else {
        row.disabled = true;
      }
      el.dirPickerList.appendChild(row);
    }
  }

  function confirmDirPicker() {
    const chosen = dirPickerCurrentPath || (el.dirPickerPath ? el.dirPickerPath.value.trim() : "");
    if (!chosen) {
      alert("Pick a folder first (or paste an absolute path).");
      return;
    }
    const cb = dirPickerOnSelect;
    closeDirPicker();
    if (cb) cb(chosen);
  }

  // Use the picker to set the primary cwd: writes back to settings and to
  // both the banner and the open-Settings input if visible.
  function pickPrimaryCwd() {
    openDirPicker({
      title: "Pick primary working directory",
      selectLabel: "Use as primary directory",
      initialPath: settings.codeCwd || (codeCheckInfo && codeCheckInfo.cwd) || "",
      onSelect: (absPath) => {
        settings.codeCwd = absPath;
        saveSettings();
        if (el.codeCwdInput) el.codeCwdInput.value = absPath;
        refreshCodeBanner();
        // Re-check Ollama / cwd; this also picks up the new primary in the banner.
        codeCheck();
      },
    });
  }

  // Use the picker to add an entry to the allowed-dirs list.
  function pickAdditionalDir() {
    openDirPicker({
      title: "Add a directory the agent can read & edit",
      selectLabel: "Add this directory",
      initialPath: "",
      onSelect: (absPath) => {
        const list = Array.isArray(settings.codeAllowedDirs) ? settings.codeAllowedDirs.slice() : [];
        const primary = settings.codeCwd || (codeCheckInfo && codeCheckInfo.cwd) || "";
        if (primary && absPath === primary) {
          alert("That's already the primary directory.");
          return;
        }
        if (list.includes(absPath)) {
          alert("That directory is already in the list.");
          return;
        }
        list.push(absPath);
        settings.codeAllowedDirs = list;
        saveSettings();
        if (el.codeAllowedDirsInput) {
          el.codeAllowedDirsInput.value = allowedDirsAsText(list);
          updateAllowedDirsCount();
        }
        refreshCodeBanner();
      },
    });
  }

  /* ----------------------------------------------------------
     Projects — bundles of (name, cwd, allowedDirs, unrestrictedFs)
     that scope a set of Code conversations.
     ---------------------------------------------------------- */
  function saveProjects() {
    saveJSON(STORAGE.projects, projects);
    if (activeProjectId) localStorage.setItem(STORAGE.activeProject, activeProjectId);
    else localStorage.removeItem(STORAGE.activeProject);
  }

  function getActiveProject() {
    if (!activeProjectId) return null;
    return projects.find((p) => p.id === activeProjectId) || null;
  }

  // The cwd / allowedDirs / unrestrictedFs that should ACTUALLY be used right
  // now: project values override the global Settings values when a project
  // is active. Used by sendCodeMessage, file uploads, and the banner.
  function effectiveCodeContext() {
    const proj = getActiveProject();
    if (proj) {
      return {
        cwd: proj.cwd || "",
        allowedDirs: Array.isArray(proj.allowedDirs) ? proj.allowedDirs : [],
        unrestrictedFs: proj.unrestrictedFs === true,
        source: "project",
        projectId: proj.id,
        projectName: proj.name,
      };
    }
    return {
      cwd: settings.codeCwd || "",
      allowedDirs: Array.isArray(settings.codeAllowedDirs) ? settings.codeAllowedDirs : [],
      unrestrictedFs: settings.codeUnrestrictedFs === true,
      source: "settings",
      projectId: null,
      projectName: null,
    };
  }

  function setActiveProject(id, opts = {}) {
    activeProjectId = id || null;
    saveProjects();
    // Make sure we're not stuck on a conversation from a different project.
    const conv = getActiveConversation();
    if (conv && conv.projectId && conv.projectId !== activeProjectId) {
      codeActiveId = null;
      saveCodeConvs();
    }
    if (!opts.silent) {
      inCodeProjectsView = false;
      localStorage.setItem(STORAGE.inProjectsView, "0");
      renderConversations();
      renderMessages();
      refreshCodeBanner();
      refreshProjectsLinkBtn();
      refreshViewPanes();
      codeCheck();
    }
  }

  function createProjectObject(name, cwd, allowedDirs, unrestrictedFs) {
    const id = "p_" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
    const now = Date.now();
    return {
      id,
      name: (name || "").trim() || derivedProjectName(cwd) || "Untitled project",
      cwd: (cwd || "").trim(),
      allowedDirs: Array.isArray(allowedDirs) ? allowedDirs.slice() : [],
      unrestrictedFs: !!unrestrictedFs,
      createdAt: now,
      updatedAt: now,
    };
  }

  // "C:\\path\\to\\Ollama web ui" → "Ollama web ui"
  // "/home/me/projects/foo"       → "foo"
  function derivedProjectName(p) {
    if (!p) return "";
    const trimmed = String(p).replace(/[\\/]+$/, "");
    const lastSlash = Math.max(trimmed.lastIndexOf("\\"), trimmed.lastIndexOf("/"));
    return lastSlash === -1 ? trimmed : trimmed.slice(lastSlash + 1);
  }

  function deleteProject(id) {
    const idx = projects.findIndex((p) => p.id === id);
    if (idx === -1) return;
    const proj = projects[idx];
    const orphaned = codeConvs.filter((c) => c.projectId === id).length;
    const ok = confirm(
      `Delete project "${proj.name}"?\n\n` +
      (orphaned > 0
        ? `${orphaned} conversation${orphaned === 1 ? "" : "s"} will be unlinked from this project (the conversations stay).`
        : "No conversations belong to this project.")
    );
    if (!ok) return;
    // Unlink conversations rather than delete them — preserves the user's history.
    for (const c of codeConvs) {
      if (c.projectId === id) c.projectId = null;
    }
    saveCodeConvs();
    projects.splice(idx, 1);
    if (activeProjectId === id) activeProjectId = null;
    saveProjects();
    renderProjects();
    renderConversations();
    refreshCodeBanner();
    refreshProjectsLinkBtn();
  }

  /* ---- Projects grid rendering ---------------------------------------- */
  let projectsSearchOpen = false;
  let projectsSearchQuery = "";

  function refreshProjectsLinkBtn() {
    if (!el.projectsLinkBtn) return;
    el.projectsLinkBtn.hidden = activeView !== "code";
    if (el.projectsLinkCount) el.projectsLinkCount.textContent = String(projects.length);
    el.projectsLinkBtn.classList.toggle("active", activeView === "code" && inCodeProjectsView);
  }

  function renderProjects() {
    if (!el.projectsGrid) return;
    // Sort: most-recently-updated first (matches the picture's "X ago" feel).
    const q = (projectsSearchQuery || "").trim().toLowerCase();
    const list = projects
      .filter((p) => !q || p.name.toLowerCase().includes(q) || (p.cwd || "").toLowerCase().includes(q))
      .slice()
      .sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));

    // Clear everything except the empty-state node (kept so we can toggle it).
    Array.from(el.projectsGrid.children).forEach((c) => {
      if (c !== el.projectsEmpty) c.remove();
    });

    if (el.projectsEmpty) {
      el.projectsEmpty.hidden = list.length !== 0;
    }
    if (list.length === 0) return;

    for (const proj of list) {
      const card = document.createElement("button");
      card.type = "button";
      card.className = "project-card" + (proj.id === activeProjectId ? " active" : "");
      card.dataset.id = proj.id;

      const top = document.createElement("div");
      top.className = "project-card-top";

      const name = document.createElement("div");
      name.className = "project-card-name";
      name.textContent = proj.name || derivedProjectName(proj.cwd) || "Untitled";
      name.title = proj.cwd || "";
      top.appendChild(name);

      const edit = document.createElement("span");
      edit.className = "project-card-edit";
      edit.title = "Edit project";
      edit.innerHTML =
        '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">' +
        '<path d="M12 20h9"></path><path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4z"></path></svg>';
      edit.addEventListener("click", (e) => {
        e.stopPropagation();
        openProjectModal(proj.id);
      });
      top.appendChild(edit);

      card.appendChild(top);

      const meta = document.createElement("div");
      meta.className = "project-card-meta";
      const when = proj.updatedAt ? formatRelative(new Date(proj.updatedAt).toISOString()) : "";
      const convCount = codeConvs.filter((c) => c.projectId === proj.id).length;
      meta.textContent =
        (when || "just now") +
        (convCount ? `  ·  ${convCount} chat${convCount === 1 ? "" : "s"}` : "");
      card.appendChild(meta);

      card.addEventListener("click", () => setActiveProject(proj.id));
      el.projectsGrid.appendChild(card);
    }
  }

  /* ---- Project modal (new / edit) ------------------------------------- */
  let editingProjectId = null;

  function openProjectModal(id) {
    editingProjectId = id || null;
    const proj = id ? projects.find((p) => p.id === id) : null;
    el.projectModalTitle.textContent = proj ? "Edit project" : "New project";
    el.projectNameInput.value = proj ? proj.name : "";
    el.projectCwdInput.value = proj ? proj.cwd : "";
    el.projectAllowedDirsInput.value = proj ? allowedDirsAsText(proj.allowedDirs) : "";
    el.projectUnrestrictedInput.checked = proj ? !!proj.unrestrictedFs : false;
    el.projectDeleteBtn.hidden = !proj;
    el.projectAllowedDirsCount.textContent =
      String(parseAllowedDirsText(el.projectAllowedDirsInput.value).length);
    el.projectModal.classList.remove("hidden");
    el.projectModal.setAttribute("aria-hidden", "false");
    setTimeout(() => el.projectNameInput.focus(), 0);
  }

  function closeProjectModal() {
    el.projectModal.classList.add("hidden");
    el.projectModal.setAttribute("aria-hidden", "true");
    editingProjectId = null;
  }

  function saveProjectFromModal() {
    const name = el.projectNameInput.value.trim();
    const cwd = el.projectCwdInput.value.trim();
    if (!cwd) {
      alert("Pick a working directory for this project.");
      el.projectCwdInput.focus();
      return;
    }
    const allowedDirs = parseAllowedDirsText(el.projectAllowedDirsInput.value);
    const unrestrictedFs = !!el.projectUnrestrictedInput.checked;

    if (editingProjectId) {
      const proj = projects.find((p) => p.id === editingProjectId);
      if (!proj) return closeProjectModal();
      proj.name = name || derivedProjectName(cwd) || proj.name || "Untitled";
      proj.cwd = cwd;
      proj.allowedDirs = allowedDirs;
      proj.unrestrictedFs = unrestrictedFs;
      proj.updatedAt = Date.now();
      saveProjects();
      if (activeProjectId === proj.id) {
        refreshCodeBanner();
        codeCheck();
      }
    } else {
      const proj = createProjectObject(name, cwd, allowedDirs, unrestrictedFs);
      projects.unshift(proj);
      saveProjects();
      // Auto-activate the newly created project.
      setActiveProject(proj.id, { silent: true });
      // Open the chat view for it; rendering happens below.
      inCodeProjectsView = false;
      localStorage.setItem(STORAGE.inProjectsView, "0");
    }
    closeProjectModal();
    renderProjects();
    renderConversations();
    refreshCodeBanner();
    refreshProjectsLinkBtn();
    refreshViewPanes();
  }

  /* ---- View toggling: chat ↔ projects-grid (within Code) -------------- */
  function showCodeProjectsView() {
    if (activeView !== "code") return;
    inCodeProjectsView = true;
    localStorage.setItem(STORAGE.inProjectsView, "1");
    renderProjects();
    refreshViewPanes();
    refreshProjectsLinkBtn();
  }

  function hideCodeProjectsView() {
    inCodeProjectsView = false;
    localStorage.setItem(STORAGE.inProjectsView, "0");
    refreshViewPanes();
    refreshProjectsLinkBtn();
  }

  // Single source of truth for which main pane is visible. Called after any
  // state change that should affect it (entering Code, toggling projects, …).
  function refreshViewPanes() {
    const inCode = activeView === "code";
    const inModels = activeView === "models";
    const inProjects = inCode && inCodeProjectsView;
    el.chatView.hidden = inModels || inProjects;
    el.modelsView.hidden = !inModels;
    if (el.codeProjectsView) el.codeProjectsView.hidden = !inProjects;
  }

  // Convert this conversation's prior messages into the wire format the
  // server expects under `history`. We strip our display-only fields and
  // pass plain Ollama-shaped messages.
  function buildAgentHistory(conv) {
    const out = [];
    // Messages on the conversation are pairs of { role, content, blocks? }.
    // For the agent's purposes we only need user/assistant text turns from
    // history — tool calls and their results are reconstructed by the server
    // each turn from the prompt.
    for (const m of conv.messages || []) {
      if (m.role !== "user" && m.role !== "assistant") continue;
      const text = (m.content || (m.blocks || [])
        .filter((b) => b.type === "text").map((b) => b.text).join("\n\n")).trim();
      if (!text) continue;
      out.push({ role: m.role, content: text });
    }
    return out;
  }

  async function sendCodeMessage(text) {
    const model = el.modelSelect.value;
    if (!model) {
      alert("Pick a model in the top bar first (the agent uses Ollama tool calling).");
      return;
    }

    // If any uploads are still in flight, ask the user to wait.
    const pendingUpload = stagedAttachments.find((a) => a.status === "uploading");
    if (pendingUpload) {
      alert("An upload is still in progress — please wait a moment.");
      return;
    }

    const c = ctx();
    let conv = getActiveConversation();
    if (!conv) conv = createConversation();

    // History includes everything BEFORE the new user turn.
    const history = buildAgentHistory(conv);

    // If the user attached files, prepend a small "attached" preamble so the
    // agent sees the saved paths in-band. Only successful uploads are listed;
    // failed ones are shown to the user as chips but not sent.
    const okAttachments = stagedAttachments.filter((a) => a.status === "done");
    let promptToSend = text;
    if (okAttachments.length > 0) {
      const lines = okAttachments.map((a) => {
        const size = formatChipSize(a.sizeBytes);
        return `  • ${a.relPath || a.name}${size ? ` (${size})` : ""}`;
      });
      promptToSend =
        `[The user attached ${okAttachments.length} file${okAttachments.length === 1 ? "" : "s"}, ` +
        `saved into the primary working directory:\n${lines.join("\n")}\n` +
        `You can read or edit them with the file tools.]\n\n${text}`;
    }

    // Append user message visibly. We render the attachments inline in the
    // bubble so the conversation history makes sense on re-open.
    const userBlocks = [];
    if (okAttachments.length > 0) {
      userBlocks.push({
        type: "attachments",
        items: okAttachments.map((a) => ({
          name: a.name, relPath: a.relPath, sizeBytes: a.sizeBytes,
        })),
      });
    }
    userBlocks.push({ type: "text", text });
    const userMsg = { role: "user", content: text, blocks: userBlocks };
    conv.messages.push(userMsg);
    setConversationTitle(conv, text);
    conv.model = model;
    // Tag (or re-tag) the conv with the active project; bump project recency.
    if (activeProjectId && conv.projectId !== activeProjectId) {
      conv.projectId = activeProjectId;
    }
    const activeProj = getActiveProject();
    if (activeProj) {
      activeProj.updatedAt = Date.now();
      saveProjects();
    }
    c.save();
    el.welcome.classList.add("hidden");
    el.messages.appendChild(buildCodeMessageEl(userMsg, conv));

    // Clear the staged attachments — they've been "sent".
    stagedAttachments.length = 0;
    renderAttachments();

    // Streaming assistant placeholder. Stamp the model on this turn so the
    // bubble keeps showing the right name even if the user later picks a
    // different model in the dropdown.
    const assistantMsg = { role: "assistant", content: "", blocks: [], model };
    conv.messages.push(assistantMsg);
    const assistantEl = buildCodeMessageEl(assistantMsg, conv);
    const blocksEl = assistantEl._blocksEl;
    const typing = document.createElement("div");
    typing.className = "typing";
    typing.innerHTML = "<span></span><span></span><span></span>";
    blocksEl.appendChild(typing);
    el.messages.appendChild(assistantEl);
    scrollToBottom();

    codeToolUseEls.clear();
    isStreaming = true;
    el.sendBtn.classList.add("hidden");
    el.stopBtn.classList.remove("hidden");
    currentAbortController = new AbortController();

    const eff = effectiveCodeContext();
    const body = {
      prompt: promptToSend,
      model,
      history,
      cwd: eff.cwd || undefined,
      allowedDirs: eff.allowedDirs,
      unrestrictedFs: eff.unrestrictedFs,
      systemPrompt: (settings.codeSystemPrompt || "").trim() || undefined,
      options: {
        temperature: settings.temperature,
        top_p: settings.topP,
        top_k: settings.topK,
        repeat_penalty: settings.repeatPenalty,
      },
    };

    try {
      const res = await fetch("/local-code/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
        signal: currentAbortController.signal,
      });
      if (!res.ok) {
        const t = await res.text().catch(() => "");
        throw new Error(`HTTP ${res.status} — ${t || res.statusText}`);
      }

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      let firstChunkSeen = false;

      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let nl;
        while ((nl = buffer.indexOf("\n")) !== -1) {
          const line = buffer.slice(0, nl).trim();
          buffer = buffer.slice(nl + 1);
          if (!line) continue;
          let env;
          try { env = JSON.parse(line); } catch { continue; }

          if (!firstChunkSeen) {
            firstChunkSeen = true;
            if (typing.parentElement) typing.remove();
          }

          if (env.kind === "meta") {
            currentCodeJobId = env.jobId;
            if (!env.toolCapable) {
              const warn = {
                type: "text",
                text: `_Heads up: \`${env.model}\` isn't in the known tool-capable list — the agent will try anyway, but may just chat back._`,
              };
              assistantMsg.blocks.push(warn);
              appendBlockEl(blocksEl, warn);
            }
          } else if (env.kind === "assistant_text") {
            const block = { type: "text", text: env.text || "" };
            assistantMsg.blocks.push(block);
            appendBlockEl(blocksEl, block);
          } else if (env.kind === "tool_use") {
            const block = { type: "tool_use", id: env.id, name: env.name, input: env.input };
            assistantMsg.blocks.push(block);
            const domBlock = buildToolUseBlock(env.name, env.input);
            blocksEl.appendChild(domBlock);
            codeToolUseEls.set(env.id, { domBlock, block });
          } else if (env.kind === "tool_result") {
            const entry = codeToolUseEls.get(env.id);
            if (entry) {
              attachToolResult(entry.domBlock, env.output, env.isError);
              entry.block.result = env.output;
              entry.block.isError = !!env.isError;
            }
          } else if (env.kind === "warning") {
            const w = { type: "text", text: `_${env.message}_` };
            assistantMsg.blocks.push(w);
            appendBlockEl(blocksEl, w);
          } else if (env.kind === "error") {
            const e = { type: "text", text: `**Error:** ${env.message}` };
            assistantMsg.blocks.push(e);
            appendBlockEl(blocksEl, e);
          } else if (env.kind === "done") {
            // Agent finished cleanly; no extra rendering needed.
          }
          c.save();
          scrollToBottom();
        }
      }
    } catch (err) {
      if (err.name === "AbortError") {
        const stop = { type: "text", text: "_(stopped)_" };
        assistantMsg.blocks.push(stop);
        appendBlockEl(blocksEl, stop);
      } else {
        console.error(err);
        const e = { type: "text", text: `**Error:** ${err.message}` };
        assistantMsg.blocks.push(e);
        appendBlockEl(blocksEl, e);
      }
    } finally {
      if (typing.parentElement) typing.remove();
      isStreaming = false;
      currentAbortController = null;
      currentCodeJobId = null;
      el.sendBtn.classList.remove("hidden");
      el.stopBtn.classList.add("hidden");
      assistantMsg.content = assistantMsg.blocks
        .filter((b) => b.type === "text")
        .map((b) => b.text).join("\n\n");
      c.save();
      localStorage.setItem(c.lastModelKey, model);
      refreshCodeBanner();
    }
  }

  async function stopCodeJob() {
    if (currentAbortController) currentAbortController.abort();
    if (currentCodeJobId) {
      try {
        await fetch("/local-code/stop", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ jobId: currentCodeJobId }),
        });
      } catch { /* best effort */ }
    }
  }

  /* ----------------------------------------------------------
     Send / stream a chat or code message
     ---------------------------------------------------------- */
  async function sendMessage(text) {
    text = text.trim();
    if (!text || isStreaming) return;

    // Code view goes through the local-code agent loop (Ollama + tool calls).
    if (activeView === "code") {
      return sendCodeMessage(text);
    }

    const model = el.modelSelect.value;
    if (!model) {
      alert("Pick a model first (or pull one from the Models tab).");
      return;
    }

    const c = ctx();
    let conv = getActiveConversation();
    if (!conv) conv = createConversation();
    conv.model = model;

    conv.messages.push({ role: "user", content: text });
    setConversationTitle(conv, text);
    c.save();
    el.welcome.classList.add("hidden");
    el.messages.appendChild(buildMessageEl(conv.messages[conv.messages.length - 1]));

    const assistantMsg = { role: "assistant", content: "" };
    conv.messages.push(assistantMsg);
    const assistantEl = buildMessageEl(assistantMsg);
    const contentEl = assistantEl.querySelector(".message-content");
    contentEl.innerHTML =
      '<div class="typing"><span></span><span></span><span></span></div>';
    el.messages.appendChild(assistantEl);
    scrollToBottom();

    const apiMessages = [];
    const sys = (c.systemPrompt || "").trim();
    if (sys) apiMessages.push({ role: "system", content: sys });
    for (const m of conv.messages.slice(0, -1)) {
      apiMessages.push({ role: m.role, content: m.content });
    }

    const options = {
      temperature: settings.temperature,
      top_p: settings.topP,
      top_k: settings.topK,
      repeat_penalty: settings.repeatPenalty,
    };
    if (settings.numPredict !== -1) options.num_predict = settings.numPredict;

    const body = { model, messages: apiMessages, stream: true, options };

    isStreaming = true;
    el.sendBtn.classList.add("hidden");
    el.stopBtn.classList.remove("hidden");
    currentAbortController = new AbortController();
    let firstTokenSeen = false;

    try {
      const res = await fetch(`${settings.host}/api/chat`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
        signal: currentAbortController.signal,
      });
      if (!res.ok) {
        const errText = await res.text().catch(() => "");
        throw new Error(`HTTP ${res.status} — ${errText || res.statusText}`);
      }
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let nl;
        while ((nl = buffer.indexOf("\n")) !== -1) {
          const line = buffer.slice(0, nl).trim();
          buffer = buffer.slice(nl + 1);
          if (!line) continue;
          try {
            const chunk = JSON.parse(line);
            const piece = chunk.message?.content || "";
            if (piece) {
              if (!firstTokenSeen) {
                firstTokenSeen = true;
                contentEl.innerHTML = "";
              }
              assistantMsg.content += piece;
              contentEl.innerHTML = renderMarkdown(assistantMsg.content);
              scrollToBottom();
            }
            if (chunk.done) c.save();
          } catch (e) { /* ignore */ }
        }
      }
    } catch (err) {
      if (err.name === "AbortError") {
        assistantMsg.content += "\n\n_(stopped)_";
      } else {
        console.error(err);
        assistantMsg.content =
          `**Error:** ${err.message}\n\nMake sure Ollama is running.`;
      }
      contentEl.innerHTML = renderMarkdown(assistantMsg.content);
    } finally {
      isStreaming = false;
      currentAbortController = null;
      el.sendBtn.classList.remove("hidden");
      el.stopBtn.classList.add("hidden");
      c.save();
      localStorage.setItem(c.lastModelKey, model);
    }
  }

  function stopGeneration() {
    if (activeView === "code") {
      stopCodeJob();
      return;
    }
    if (currentAbortController) currentAbortController.abort();
  }

  /* ----------------------------------------------------------
     Settings UI
     ---------------------------------------------------------- */
  function openSettings() {
    el.hostInput.value = settings.host;
    el.systemPrompt.value = settings.systemPrompt;
    el.codeSystemPrompt.value = settings.codeSystemPrompt;
    if (el.codeCwdInput) el.codeCwdInput.value = settings.codeCwd || "";
    if (el.codeAllowedDirsInput) {
      el.codeAllowedDirsInput.value = allowedDirsAsText(settings.codeAllowedDirs);
      updateAllowedDirsCount();
    }
    if (el.codeVerifyDirsStatus) {
      el.codeVerifyDirsStatus.classList.remove("error", "ok");
      el.codeVerifyDirsStatus.textContent =
        "The agent can read & edit files in any of these directories (in addition to the primary one).";
    }
    if (el.codeUnrestrictedInput) {
      el.codeUnrestrictedInput.checked = !!settings.codeUnrestrictedFs;
    }
    el.temperature.value = settings.temperature;
    el.tempValue.textContent = settings.temperature;
    el.topP.value = settings.topP;
    el.topPValue.textContent = settings.topP;
    el.topK.value = settings.topK;
    el.topKValue.textContent = settings.topK;
    el.numPredict.value = settings.numPredict;
    el.numPredictValue.textContent =
      settings.numPredict === -1 ? "-1 (unlimited)" : settings.numPredict;
    el.repeatPenalty.value = settings.repeatPenalty;
    el.repeatPenaltyValue.textContent = settings.repeatPenalty;
    el.modal.classList.remove("hidden");
  }
  function closeSettings() { el.modal.classList.add("hidden"); }
  function applySettingsFromForm() {
    settings.host = el.hostInput.value.trim().replace(/\/+$/, "") || DEFAULTS.host;
    settings.systemPrompt = el.systemPrompt.value;
    settings.codeSystemPrompt = el.codeSystemPrompt.value;
    if (el.codeCwdInput) settings.codeCwd = el.codeCwdInput.value.trim();
    if (el.codeAllowedDirsInput) {
      settings.codeAllowedDirs = parseAllowedDirsText(el.codeAllowedDirsInput.value);
    }
    if (el.codeUnrestrictedInput) {
      const wasOn = settings.codeUnrestrictedFs === true;
      const nowOn = !!el.codeUnrestrictedInput.checked;
      if (nowOn && !wasOn) {
        const ok = confirm(
          "Enable Full Disk Access?\n\n" +
          "The agent will be able to read & edit ANY file on this computer — " +
          "including system files, credentials, and anything outside your project folder.\n\n" +
          "Only enable this if you trust both the model and the prompts you send."
        );
        if (!ok) {
          el.codeUnrestrictedInput.checked = false;
        } else {
          settings.codeUnrestrictedFs = true;
        }
      } else {
        settings.codeUnrestrictedFs = nowOn;
      }
    }
    settings.temperature = parseFloat(el.temperature.value);
    settings.topP = parseFloat(el.topP.value);
    settings.topK = parseInt(el.topK.value, 10);
    settings.numPredict = parseInt(el.numPredict.value, 10);
    settings.repeatPenalty = parseFloat(el.repeatPenalty.value);
    saveSettings();
    fetchModels();
    if (activeView === "code") codeCheck();
  }
  function resetSettingsForm() {
    settings = { ...DEFAULTS };
    saveSettings();
    openSettings();
    fetchModels();
  }

  /* ----------------------------------------------------------
     Wiring
     ---------------------------------------------------------- */
  function autoSizeTextarea() {
    el.input.style.height = "auto";
    el.input.style.height = Math.min(el.input.scrollHeight, 200) + "px";
  }

  function init() {
    // Nav tabs
    el.navTabs.forEach((t) =>
      t.addEventListener("click", () => setView(t.dataset.view))
    );

    // Sidebar
    el.newChatBtn.addEventListener("click", () => createConversation());
    el.toggleSidebar.addEventListener("click", () =>
      el.sidebar.classList.toggle("collapsed")
    );

    // Settings
    el.settingsBtn.addEventListener("click", openSettings);
    el.closeSettings.addEventListener("click", closeSettings);
    el.modal.addEventListener("click", (e) => {
      if (e.target === el.modal) closeSettings();
    });
    el.saveSettings.addEventListener("click", () => {
      applySettingsFromForm();
      closeSettings();
    });
    el.resetSettings.addEventListener("click", () => {
      if (confirm("Reset all settings to defaults?")) resetSettingsForm();
    });
    el.temperature.addEventListener("input", () => {
      el.tempValue.textContent = el.temperature.value;
    });
    el.topP.addEventListener("input", () => {
      el.topPValue.textContent = el.topP.value;
    });
    el.topK.addEventListener("input", () => {
      el.topKValue.textContent = el.topK.value;
    });
    el.numPredict.addEventListener("input", () => {
      const v = parseInt(el.numPredict.value, 10);
      el.numPredictValue.textContent = v === -1 ? "-1 (unlimited)" : v;
    });
    el.repeatPenalty.addEventListener("input", () => {
      el.repeatPenaltyValue.textContent = el.repeatPenalty.value;
    });

    // Clear current chat
    el.clearChatBtn.addEventListener("click", () => {
      const conv = getActiveConversation();
      if (!conv) return;
      if (confirm("Clear all messages in this chat?")) {
        conv.messages = [];
        conv.title = activeView === "code" ? "New task" : "New chat";
        ctx().save();
        renderConversations();
        renderMessages();
        if (activeView === "code") refreshCodeBanner();
      }
    });

    // Composer
    el.input.addEventListener("input", autoSizeTextarea);
    el.input.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        el.form.requestSubmit();
      }
    });
    el.form.addEventListener("submit", (e) => {
      e.preventDefault();
      const text = el.input.value;
      if (!text.trim() || isStreaming) return;
      el.input.value = "";
      autoSizeTextarea();
      sendMessage(text);
    });
    el.stopBtn.addEventListener("click", stopGeneration);

    // Tip cards in welcome (code view) — populate composer
    el.welcomeTips.addEventListener("click", (e) => {
      const card = e.target.closest(".tip-card");
      if (!card) return;
      el.input.value = card.textContent.replace(/^[^\s]+\s/, "");
      autoSizeTextarea();
      el.input.focus();
    });

    // Model selection persistence
    el.modelSelect.addEventListener("change", () => {
      const c = ctx();
      localStorage.setItem(c.lastModelKey, el.modelSelect.value);
      const conv = getActiveConversation();
      if (conv) {
        conv.model = el.modelSelect.value;
        c.save();
      }
    });

    // Local Code: refresh banner when the user picks a different model so
    // the "tools: yes/maybe" hint stays in sync.
    el.modelSelect.addEventListener("change", () => {
      if (activeView === "code") refreshCodeBanner();
    });

    // Local Code: allowed-dirs UI in Settings.
    if (el.codeAllowedDirsInput) {
      el.codeAllowedDirsInput.addEventListener("input", updateAllowedDirsCount);
    }
    if (el.codeVerifyDirsBtn) {
      el.codeVerifyDirsBtn.addEventListener("click", verifyAllowedDirs);
    }

    // Local Code: directory picker buttons in the banner.
    if (el.codePickCwdBtn) el.codePickCwdBtn.addEventListener("click", pickPrimaryCwd);
    if (el.codeAddDirBtn) el.codeAddDirBtn.addEventListener("click", pickAdditionalDir);

    // Local Code: directory picker buttons in Settings.
    if (el.codePickCwdSettingsBtn) {
      el.codePickCwdSettingsBtn.addEventListener("click", () => {
        openDirPicker({
          title: "Pick primary working directory",
          selectLabel: "Use as primary directory",
          initialPath: (el.codeCwdInput && el.codeCwdInput.value.trim()) ||
                       settings.codeCwd || (codeCheckInfo && codeCheckInfo.cwd) || "",
          onSelect: (abs) => {
            if (el.codeCwdInput) el.codeCwdInput.value = abs;
          },
        });
      });
    }
    if (el.codeAddDirSettingsBtn) {
      el.codeAddDirSettingsBtn.addEventListener("click", () => {
        openDirPicker({
          title: "Add a directory the agent can read & edit",
          selectLabel: "Add this directory",
          initialPath: "",
          onSelect: (abs) => {
            if (!el.codeAllowedDirsInput) return;
            const current = parseAllowedDirsText(el.codeAllowedDirsInput.value);
            if (current.includes(abs)) {
              alert("That directory is already in the list.");
              return;
            }
            current.push(abs);
            el.codeAllowedDirsInput.value = allowedDirsAsText(current);
            updateAllowedDirsCount();
          },
        });
      });
    }

    // Directory picker modal — wiring.
    if (el.dirPickerClose) el.dirPickerClose.addEventListener("click", closeDirPicker);
    if (el.dirPickerCancel) el.dirPickerCancel.addEventListener("click", closeDirPicker);
    if (el.dirPickerSelect) el.dirPickerSelect.addEventListener("click", confirmDirPicker);
    if (el.dirPickerUp) {
      el.dirPickerUp.addEventListener("click", async () => {
        // Re-fetch parent of current path. The list endpoint also returns parent,
        // but we can re-derive client-side by asking the server again.
        const qs = new URLSearchParams({ path: dirPickerCurrentPath || "" });
        try {
          const res = await fetch(`/local-code/fs/list?${qs}`);
          const data = await res.json();
          if (data.parent !== null && data.parent !== undefined) {
            loadDirPicker(data.parent);
          }
        } catch { /* ignore */ }
      });
    }
    if (el.dirPickerHome) {
      el.dirPickerHome.addEventListener("click", () => loadDirPicker(""));
    }
    if (el.dirPickerGo) {
      el.dirPickerGo.addEventListener("click", () => {
        const p = el.dirPickerPath ? el.dirPickerPath.value.trim() : "";
        loadDirPicker(p);
      });
    }
    if (el.dirPickerPath) {
      el.dirPickerPath.addEventListener("keydown", (e) => {
        if (e.key === "Enter") {
          e.preventDefault();
          loadDirPicker(el.dirPickerPath.value.trim());
        }
      });
    }
    if (el.dirPickerModal) {
      el.dirPickerModal.addEventListener("click", (e) => {
        if (e.target === el.dirPickerModal) closeDirPicker();
      });
    }

    // File upload: button + hidden input + drop overlay.
    if (el.attachBtn && el.attachInput) {
      el.attachBtn.addEventListener("click", () => el.attachInput.click());
      el.attachInput.addEventListener("change", () => {
        handlePickedFiles(el.attachInput.files);
        el.attachInput.value = ""; // allow re-picking the same file
      });
    }
    installDropHandlers();

    /* ---- Projects wiring ---- */
    // Sidebar "Projects" link toggles the projects grid in the main pane.
    if (el.projectsLinkBtn) {
      el.projectsLinkBtn.addEventListener("click", () => {
        if (inCodeProjectsView) hideCodeProjectsView();
        else showCodeProjectsView();
      });
    }
    // Banner "project" chip → re-open the projects grid.
    if (el.codeProjectChip) {
      el.codeProjectChip.addEventListener("click", showCodeProjectsView);
    }
    // New project button (in the grid).
    if (el.newProjectBtn) {
      el.newProjectBtn.addEventListener("click", () => openProjectModal(null));
    }
    // Search toggle in projects header.
    if (el.projectsSearchBtn && el.projectsSearchInput) {
      el.projectsSearchBtn.addEventListener("click", () => {
        projectsSearchOpen = !projectsSearchOpen;
        el.projectsSearchInput.hidden = !projectsSearchOpen;
        if (projectsSearchOpen) setTimeout(() => el.projectsSearchInput.focus(), 0);
        else { projectsSearchQuery = ""; el.projectsSearchInput.value = ""; renderProjects(); }
      });
      el.projectsSearchInput.addEventListener("input", () => {
        projectsSearchQuery = el.projectsSearchInput.value;
        renderProjects();
      });
    }
    // Sort button — for now just toggles between recency and name.
    let projectsSortByName = false;
    if (el.projectsSortBtn) {
      el.projectsSortBtn.addEventListener("click", () => {
        projectsSortByName = !projectsSortByName;
        // Cheap implementation: re-sort the array in place before rendering.
        projects.sort(projectsSortByName
          ? (a, b) => a.name.localeCompare(b.name)
          : (a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
        renderProjects();
      });
    }

    // Project modal buttons.
    if (el.projectModalClose) el.projectModalClose.addEventListener("click", closeProjectModal);
    if (el.projectCancelBtn) el.projectCancelBtn.addEventListener("click", closeProjectModal);
    if (el.projectSaveBtn) el.projectSaveBtn.addEventListener("click", saveProjectFromModal);
    if (el.projectDeleteBtn) {
      el.projectDeleteBtn.addEventListener("click", () => {
        if (editingProjectId) {
          const id = editingProjectId;
          closeProjectModal();
          deleteProject(id);
        }
      });
    }
    if (el.projectModal) {
      el.projectModal.addEventListener("click", (e) => {
        if (e.target === el.projectModal) closeProjectModal();
      });
    }
    if (el.projectCwdBrowseBtn) {
      el.projectCwdBrowseBtn.addEventListener("click", () => {
        openDirPicker({
          title: "Pick the project's working directory",
          selectLabel: "Use as project directory",
          initialPath: el.projectCwdInput.value.trim() || "",
          onSelect: (abs) => {
            el.projectCwdInput.value = abs;
            if (!el.projectNameInput.value.trim()) {
              el.projectNameInput.value = derivedProjectName(abs);
            }
          },
        });
      });
    }
    if (el.projectAddDirBtn) {
      el.projectAddDirBtn.addEventListener("click", () => {
        openDirPicker({
          title: "Add a directory to this project",
          selectLabel: "Add this directory",
          initialPath: "",
          onSelect: (abs) => {
            const current = parseAllowedDirsText(el.projectAllowedDirsInput.value);
            if (current.includes(abs)) {
              alert("That directory is already in this project.");
              return;
            }
            current.push(abs);
            el.projectAllowedDirsInput.value = allowedDirsAsText(current);
            el.projectAllowedDirsCount.textContent = String(current.length);
          },
        });
      });
    }
    if (el.projectAllowedDirsInput) {
      el.projectAllowedDirsInput.addEventListener("input", () => {
        el.projectAllowedDirsCount.textContent =
          String(parseAllowedDirsText(el.projectAllowedDirsInput.value).length);
      });
    }

    // Models view: pull form
    el.pullForm.addEventListener("submit", (e) => {
      e.preventDefault();
      pullModel(el.pullInput.value);
    });
    document.querySelectorAll(".suggest-chip").forEach((chip) =>
      chip.addEventListener("click", () => {
        el.pullInput.value = chip.dataset.name;
        pullModel(chip.dataset.name);
      })
    );
    el.pullCancel.addEventListener("click", () => {
      if (pullAbort) pullAbort.abort();
    });
    el.refreshModelsBtn.addEventListener("click", () => fetchModels());

    // First render
    setView(activeView);
    renderConversations();
    renderMessages();
    fetchModels();

    // Periodic connection check
    setInterval(() => {
      fetch(`${settings.host}/api/tags`, { method: "GET" })
        .then((r) => setStatus(r.ok))
        .catch(() => setStatus(false));
    }, 30000);

    el.input.focus();
  }

  document.addEventListener("DOMContentLoaded", init);
})();
