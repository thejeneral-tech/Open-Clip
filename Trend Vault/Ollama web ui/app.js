/* ============================================================
   Ollama Studio — front-end logic
   Three views: Chat, Code (claw-dev via Ollama), Models
   ============================================================ */

(() => {
  "use strict";

  /* ----------------------------------------------------------
     Constants & defaults
     ---------------------------------------------------------- */
  const STORAGE = {
    settings:       "ollama-chat:settings",
    chatConvs:      "ollama-chat:conversations",
    chatActive:     "ollama-chat:activeConversation",
    codeConvs:      "ollama-chat:codeConversations",
    codeActive:     "ollama-chat:codeActiveConversation",
    lastModelChat:  "ollama-chat:lastModel",
    lastModelCode:  "ollama-chat:lastCodeModel",
    activeView:     "ollama-chat:activeView",
    projects:       "ollama-chat:projects",
    activeProject:  "ollama-chat:activeProject",
    inProjectsView: "ollama-chat:codeShowingProjects",
  };

  const DEFAULTS = {
    host: "",
    systemPrompt: "",
    codeCwd: "",
    temperature: 0.7,
    topP: 0.9,
    topK: 40,
    numPredict: -1,
    repeatPenalty: 1.1,
  };

  // Coder-tuned Ollama models tend to drive claw-dev's tool loop better;
  // we surface them as the default selection when entering Code mode.
  const CODE_MODEL_HINTS = [
    "qwen2.5-coder", "qwen3-coder", "deepseek-coder", "codellama",
    "codestral", "starcoder", "wizardcoder", "code",
  ];

  /* ----------------------------------------------------------
     State
     ---------------------------------------------------------- */
  let settings = loadSettings();
  let chatConvs = loadJSON(STORAGE.chatConvs, []);
  let codeConvs = loadJSON(STORAGE.codeConvs, []);
  let chatActiveId = localStorage.getItem(STORAGE.chatActive) || null;
  let codeActiveId = localStorage.getItem(STORAGE.codeActive) || null;
  let activeView = localStorage.getItem(STORAGE.activeView) || "chat";
  let currentAbortController = null;
  let currentCodeJobId = null;
  let isStreaming = false;
  let allModels = [];
  let pullAbort = null;

  let projects = loadJSON(STORAGE.projects, []);
  let activeProjectId = localStorage.getItem(STORAGE.activeProject) || null;
  let inCodeProjectsView = localStorage.getItem(STORAGE.inProjectsView) === "1";

  // claw-dev status: { available, version, bin, cwd, error? }
  let codeCheckInfo = null;
  const codeToolUseEls = new Map();

  // Directory picker modal state.
  let dirPickerCurrentPath = "";
  let dirPickerOnSelect = null;
  let dirPickerSelectLabel = "Select this folder";

  // Projects modal state.
  let editingProjectId = null;
  let projectsSearchOpen = false;
  let projectsSearchQuery = "";
  let projectsSortByName = false;

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
    sidebarBackdrop: $("sidebarBackdrop"),
    settingsBtn: $("settingsBtn"),
    projectsLinkBtn: $("projectsLinkBtn"),
    projectsLinkCount: $("projectsLinkCount"),

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
    composerHint: $("composerHint"),

    // code banner
    codeBanner: $("codeBanner"),
    codeBackendName: $("codeBackendName"),
    codeProjectChip: $("codeProjectChip"),
    codeProjectName: $("codeProjectName"),
    codeCwd: $("codeCwd"),
    codePickCwdBtn: $("codePickCwdBtn"),
    codeDirsBadge: $("codeDirsBadge"),
    codeAddDirBtn: $("codeAddDirBtn"),
    codeStatus: $("codeStatus"),

    // code projects view
    codeProjectsView: $("codeProjectsView"),
    projectsGrid: $("projectsGrid"),
    projectsEmpty: $("projectsEmpty"),
    newProjectBtn: $("newProjectBtn"),
    projectsSortBtn: $("projectsSortBtn"),
    projectsSearchBtn: $("projectsSearchBtn"),
    projectsSearchInput: $("projectsSearchInput"),

    // project modal
    projectModal: $("projectModal"),
    projectModalTitle: $("projectModalTitle"),
    projectModalClose: $("projectModalClose"),
    projectNameInput: $("projectNameInput"),
    projectCwdInput: $("projectCwdInput"),
    projectCwdBrowseBtn: $("projectCwdBrowseBtn"),
    projectAllowedDirsInput: $("projectAllowedDirsInput"),
    projectAllowedDirsCount: $("projectAllowedDirsCount"),
    projectAddDirBtn: $("projectAddDirBtn"),
    projectDeleteBtn: $("projectDeleteBtn"),
    projectCancelBtn: $("projectCancelBtn"),
    projectSaveBtn: $("projectSaveBtn"),

    // dir picker modal
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
    runningModelsList: $("runningModelsList"),
    modelsTotalMem: $("modelsTotalMem"),
    refreshRunningBtn: $("refreshRunningBtn"),

    // settings modal
    modal: $("settingsModal"),
    closeSettings: $("closeSettings"),
    saveSettings: $("saveSettings"),
    resetSettings: $("resetSettings"),
    hostInput: $("hostInput"),
    systemPrompt: $("systemPrompt"),
    codeCwdInput: $("codeCwdInput"),
    codePickCwdSettingsBtn: $("codePickCwdSettingsBtn"),
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
  function saveProjects() {
    saveJSON(STORAGE.projects, projects);
    if (activeProjectId) localStorage.setItem(STORAGE.activeProject, activeProjectId);
    else localStorage.removeItem(STORAGE.activeProject);
  }

  function uuidv4() {
    if (window.crypto && typeof window.crypto.randomUUID === "function") {
      return window.crypto.randomUUID();
    }
    const b = new Uint8Array(16);
    (window.crypto || window.msCrypto).getRandomValues(b);
    b[6] = (b[6] & 0x0f) | 0x40;
    b[8] = (b[8] & 0x3f) | 0x80;
    const h = Array.from(b, (x) => x.toString(16).padStart(2, "0"));
    return `${h.slice(0, 4).join("")}-${h.slice(4, 6).join("")}-${h.slice(6, 8).join("")}-${h.slice(8, 10).join("")}-${h.slice(10, 16).join("")}`;
  }

  function parseAllowedDirsText(text) {
    if (!text) return [];
    return text.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
  }
  function allowedDirsAsText(arr) {
    return Array.isArray(arr) ? arr.join("\n") : "";
  }
  function derivedProjectName(p) {
    if (!p) return "";
    const trimmed = String(p).replace(/[\\/]+$/, "");
    const lastSlash = Math.max(trimmed.lastIndexOf("\\"), trimmed.lastIndexOf("/"));
    return lastSlash === -1 ? trimmed : trimmed.slice(lastSlash + 1);
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
        systemPrompt: "",
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
    if (c.view === "code") {
      conv.clawSessionId = uuidv4();
      conv.projectId = activeProjectId || null;
    }
    c.convs.unshift(conv);
    c.activeId = conv.id;
    c.save();
    if (activeView === "code" && inCodeProjectsView) {
      inCodeProjectsView = false;
      localStorage.setItem(STORAGE.inProjectsView, "0");
      refreshViewPanes();
      refreshProjectsLinkBtn();
      if (el.codeBanner) el.codeBanner.hidden = false;
    }
    renderConversations();
    renderMessages();
    closeMobileSidebar();
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
    if (activeView === "code" && inCodeProjectsView) {
      inCodeProjectsView = false;
      localStorage.setItem(STORAGE.inProjectsView, "0");
      refreshViewPanes();
      refreshProjectsLinkBtn();
      if (el.codeBanner) el.codeBanner.hidden = false;
    }
    renderConversations();
    renderMessages();
    closeMobileSidebar();
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
     Mobile drawer helpers
     ---------------------------------------------------------- */
  function isMobileViewport() {
    return window.matchMedia("(max-width: 768px)").matches;
  }
  function closeMobileSidebar() {
    if (!isMobileViewport()) return;
    el.sidebar.classList.add("collapsed");
    document.body.classList.remove("sidebar-open");
  }
  function syncSidebarForViewport() {
    if (isMobileViewport()) {
      if (!el.sidebar.dataset.mobileSynced) {
        el.sidebar.classList.add("collapsed");
        document.body.classList.remove("sidebar-open");
        el.sidebar.dataset.mobileSynced = "1";
      }
    } else {
      document.body.classList.remove("sidebar-open");
      delete el.sidebar.dataset.mobileSynced;
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
    const inModels = name === "models";

    // First-time Code entry with projects but no active one → show grid.
    if (inCode && !activeProjectId && projects.length > 0 && !inCodeProjectsView) {
      inCodeProjectsView = true;
      localStorage.setItem(STORAGE.inProjectsView, "1");
    }
    if (!inCode) inCodeProjectsView = false;

    refreshViewPanes();

    // Model picker stays visible in both Chat AND Code (claw-dev needs it).
    el.modelPickerWrap.style.display = inModels ? "none" : "";
    if (el.codeBanner) el.codeBanner.hidden = !inCode || inCodeProjectsView;
    el.clearChatBtn.style.display = (inModels || inCodeProjectsView) ? "none" : "";
    refreshProjectsLinkBtn();
    if (inCode && inCodeProjectsView) renderProjects();

    closeMobileSidebar();

    if (name === "chat") {
      el.viewTitle.textContent = "Chat";
      el.newChatLabel.textContent = "New chat";
      el.welcomeTitle.textContent = "Ollama Chat";
      el.welcomeSubtitle.textContent =
        "Chat with your local Ollama models. Pick a model above and send a message to begin.";
      el.welcomeTips.hidden = true;
      el.input.placeholder = "Message Ollama…";
    } else if (inCode) {
      el.viewTitle.textContent = "Code";
      el.newChatLabel.textContent = "New task";
      el.welcomeTitle.textContent = "Code · claw-dev (Ollama)";
      el.welcomeSubtitle.innerHTML =
        "Agentic coding via the bundled <strong>claw-dev</strong> CLI, routed through a local " +
        "Anthropic↔Ollama proxy. Pick an Ollama model in the topbar — it drives claw-dev's " +
        "tool loop. <em>Tip: coder-tuned models (qwen2.5-coder, deepseek-coder) work best.</em>";
      el.welcomeTips.hidden = false;
      el.input.placeholder = "Tell claw-dev what to do — e.g. 'add a /healthz endpoint to server.js'";
      codeCheck();
    } else {
      el.viewTitle.textContent = "Models";
    }

    if (!inModels) {
      const c = ctx();
      if (c.lastModelKey) {
        const last = localStorage.getItem(c.lastModelKey);
        const installed = Array.from(el.modelSelect.options).map((o) => o.value);
        if (last && installed.includes(last)) {
          el.modelSelect.value = last;
        } else if (inCode) {
          const preferred = installed.find((n) =>
            CODE_MODEL_HINTS.some((h) => n.toLowerCase().includes(h)));
          if (preferred) el.modelSelect.value = preferred;
        }
      }
      renderConversations();
      renderMessages();
      if (inCode) refreshCodeBanner();
      el.newChatBtn.parentElement.style.display = "";
      if (el.conversations) el.conversations.style.display = "";
    } else {
      el.newChatBtn.parentElement.style.display = "none";
      if (el.conversations) el.conversations.style.display = "none";
      renderInstalledModels();
      startRunningModelsPoll();
    }
    if (!inModels) stopRunningModelsPoll();

    if (el.composerHint) {
      el.composerHint.textContent = inCode
        ? "Enter to send · Shift+Enter for newline · claw-dev resumes the session per chat"
        : "Press Enter to send · Shift+Enter for newline";
    }
  }

  function refreshViewPanes() {
    const inCode = activeView === "code";
    const inModels = activeView === "models";
    const inProjects = inCode && inCodeProjectsView;
    el.chatView.hidden = inModels || inProjects;
    el.modelsView.hidden = !inModels;
    if (el.codeProjectsView) el.codeProjectsView.hidden = !inProjects;
  }

  /* ----------------------------------------------------------
     Rendering: conversations + messages
     ---------------------------------------------------------- */
  function renderConversations() {
    const c = ctx();
    el.conversations.innerHTML = "";
    // In Code mode with active project, only show that project's chats.
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

  function buildMessageEl(msg, conv) {
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

    if (msg.role === "assistant" && msg.content && msg.content.trim()) {
      const statsBar = buildStatsBar(msg.stats);
      if (statsBar) body.appendChild(statsBar);
      body.appendChild(buildActionBar(conv, msg));
    }

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
     Ollama: list / pull / delete / run
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
    const lastKey = (activeView === "code") ? STORAGE.lastModelCode : STORAGE.lastModelChat;
    const last = localStorage.getItem(lastKey);
    if (last && models.includes(last)) {
      el.modelSelect.value = last;
    } else if (activeView === "code") {
      const coder = models.find((n) =>
        CODE_MODEL_HINTS.some((h) => n.toLowerCase().includes(h)));
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

  /* ----------------------------------------------------------
     Running models polling
     ---------------------------------------------------------- */
  let runningModelsPollTimer = null;

  async function fetchRunningModels() {
    if (!el.runningModelsList) return;
    try {
      const r = await fetch(`${settings.host}/api/ps`);
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const data = await r.json();
      renderRunningModels(Array.isArray(data.models) ? data.models : []);
    } catch (err) {
      el.runningModelsList.innerHTML =
        `<div class="models-empty error">Couldn't reach Ollama: ${escapeHtml(err.message)}</div>`;
      if (el.modelsTotalMem) el.modelsTotalMem.textContent = "—";
    }
  }

  function formatExpiry(date) {
    const secs = Math.floor((date.getTime() - Date.now()) / 1000);
    if (secs <= 0) return "any moment";
    if (secs < 60) return `in ${secs}s`;
    const mins = Math.floor(secs / 60);
    const remSecs = secs % 60;
    if (mins < 60) return remSecs ? `in ${mins}m ${remSecs}s` : `in ${mins}m`;
    const hrs = Math.floor(mins / 60);
    const remMins = mins % 60;
    if (hrs < 24) return remMins ? `in ${hrs}h ${remMins}m` : `in ${hrs}h`;
    const days = Math.floor(hrs / 24);
    return `in ${days}d`;
  }

  function renderRunningModels(models) {
    if (!el.runningModelsList) return;
    el.runningModelsList.innerHTML = "";
    if (models.length === 0) {
      el.runningModelsList.innerHTML =
        '<div class="models-empty">No models currently loaded in memory. ' +
        'Send a chat message to load one.</div>';
      if (el.modelsTotalMem) el.modelsTotalMem.textContent = "0 B used";
      return;
    }
    let totalSize = 0, totalVram = 0;
    for (const m of models) {
      const size = m.size || 0;
      const vram = m.size_vram || 0;
      const vramPct = size > 0 ? Math.round((vram / size) * 100) : 0;
      const expiry = m.expires_at ? new Date(m.expires_at) : null;
      const expiryLabel = expiry && Number.isFinite(expiry.getTime())
        ? formatExpiry(expiry) : "—";
      const location = vramPct >= 99 ? "GPU"
                     : vramPct <= 1  ? "CPU"
                     : `${vramPct}% GPU / ${100 - vramPct}% CPU`;

      const row = document.createElement("div");
      row.className = "model-row running-row";
      row.innerHTML =
        `<div class="model-info">
           <div class="model-name">${escapeHtml(m.name)}
             <span class="run-loc-pill" title="Where the weights are loaded">${escapeHtml(location)}</span>
           </div>
           <div class="model-meta">
             <span title="Total memory used">${formatBytes(size)} RAM</span>
             <span class="dot-sep">•</span>
             <span title="In VRAM">${formatBytes(vram)} VRAM</span>
             <span class="dot-sep">•</span>
             <span title="${expiry ? expiry.toLocaleString() : ''}">auto-unloads ${escapeHtml(expiryLabel)}</span>
           </div>
         </div>
         <div class="model-actions">
           <button class="btn-link danger" data-act="unload" data-name="${escapeHtml(m.name)}">Unload</button>
         </div>`;
      el.runningModelsList.appendChild(row);
      totalSize += size;
      totalVram += vram;
    }
    if (el.modelsTotalMem) {
      el.modelsTotalMem.textContent =
        `${formatBytes(totalSize)} RAM · ${formatBytes(totalVram)} VRAM across ${models.length} model${models.length === 1 ? "" : "s"}`;
    }
  }

  async function unloadModel(name) {
    if (!name) return;
    try {
      const r = await fetch(`${settings.host}/api/generate`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ model: name, keep_alive: 0, prompt: "" }),
      });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      setTimeout(fetchRunningModels, 400);
    } catch (err) {
      alert(`Failed to unload ${name}: ${err.message}`);
    }
  }

  function startRunningModelsPoll() {
    if (runningModelsPollTimer) return;
    fetchRunningModels();
    runningModelsPollTimer = setInterval(fetchRunningModels, 3000);
  }
  function stopRunningModelsPoll() {
    if (!runningModelsPollTimer) return;
    clearInterval(runningModelsPollTimer);
    runningModelsPollTimer = null;
  }

  if (el.runningModelsList) {
    el.runningModelsList.addEventListener("click", (e) => {
      const btn = e.target.closest("[data-act='unload']");
      if (!btn) return;
      const name = btn.dataset.name;
      btn.disabled = true;
      btn.textContent = "Unloading…";
      unloadModel(name);
    });
  }
  if (el.refreshRunningBtn) {
    el.refreshRunningBtn.addEventListener("click", () => fetchRunningModels());
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
     Code section: claw-dev (Ollama) client
     ---------------------------------------------------------- */
  function getActiveProject() {
    if (!activeProjectId) return null;
    return projects.find((p) => p.id === activeProjectId) || null;
  }

  // The cwd / allowedDirs that should actually be used right now.
  // Project values override global Settings when a project is active.
  function effectiveCodeContext() {
    const proj = getActiveProject();
    if (proj) {
      return {
        cwd: proj.cwd || "",
        allowedDirs: Array.isArray(proj.allowedDirs) ? proj.allowedDirs : [],
        source: "project",
        projectId: proj.id,
        projectName: proj.name,
      };
    }
    return {
      cwd: settings.codeCwd || "",
      allowedDirs: [],
      source: "settings",
      projectId: null,
      projectName: null,
    };
  }

  async function codeCheck() {
    try {
      const r = await fetch("/code/check");
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
    const cwd = eff.cwd || info.cwd || "(unknown cwd)";
    if (el.codeCwd) {
      el.codeCwd.textContent = cwd;
      el.codeCwd.title = cwd + (eff.source === "project" ? `  (from project "${eff.projectName}")` : "");
    }
    if (el.codeDirsBadge) {
      const n = eff.allowedDirs.length;
      el.codeDirsBadge.textContent = n === 0
        ? "no extra dirs"
        : `+${n} dir${n === 1 ? "" : "s"}`;
    }
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
    if (el.codeBackendName) {
      if (info.available) {
        const m = el.modelSelect?.value || "";
        const v = info.version || "claw-dev";
        el.codeBackendName.textContent = m ? `${v} · ${m}` : `${v} · pick a model`;
        el.codeBackendName.classList.remove("error");
      } else {
        el.codeBackendName.textContent = "claw-dev unavailable";
        el.codeBackendName.classList.add("error");
      }
    }
    if (el.codeStatus) {
      if (info.available) {
        el.codeStatus.textContent = "ready · Ollama";
        el.codeStatus.classList.remove("error");
        el.codeStatus.title = `claw-dev: ${info.bin || ""}\nOllama: ${info.ollamaHost || ""}\nproxy: 127.0.0.1:${info.proxyPort || "?"}`;
      } else {
        el.codeStatus.textContent = info.error || "unavailable";
        el.codeStatus.classList.add("error");
        el.codeStatus.title = info.error || "";
      }
    }
  }

  /* ---- Tool-use block rendering (claw-dev tools) ---------------------- */
  function buildToolUseBlock(toolName, input) {
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

  function formatToolCall(name, input) {
    const arg = (s) => {
      if (typeof s !== "string") return "";
      return s.length > 70 ? s.slice(0, 70) + "…" : s;
    };
    const n = (name || "").toLowerCase();
    if (n === "read" || n === "fileread" || n === "filereadtool") return `Read(${arg(input?.file_path || input?.path || "")})`;
    if (n === "write" || n === "filewrite" || n === "filewritetool") return `Write(${arg(input?.file_path || input?.path || "")})`;
    if (n === "edit" || n === "fileedit" || n === "fileedittool") return `Edit(${arg(input?.file_path || input?.path || "")})`;
    if (n === "bash" || n === "bashtool") return `Bash(${arg(input?.command || "")})`;
    if (n === "grep" || n === "greptool") return `Grep(${arg(input?.pattern || "")})`;
    if (n === "glob" || n === "globtool") return `Glob(${arg(input?.pattern || "")})`;
    if (n === "ls" || n === "lstool" || n === "listdir") return `LS(${arg(input?.path || ".")})`;
    return `${name || "tool"}(${arg(safeJsonStringify(input || {}))})`;
  }

  function safeJsonStringify(v) {
    try { return JSON.stringify(v, null, 2); }
    catch { return String(v); }
  }

  function attachToolResult(block, content, isError) {
    if (!block) return;
    block.classList.remove("status-running");
    block.classList.add(isError ? "status-error" : "status-ok");

    if (block._snippet) {
      let text = typeof content === "string" ? content : safeJsonStringify(content);
      const head = text.split(/\r?\n/, 1)[0] || "";
      block._snippet.textContent = isError
        ? `Error: ${head.slice(0, 200)}`
        : head.slice(0, 200) || "done";
    }
    const pre = block._resultPre;
    if (pre) {
      pre.classList.remove("hidden");
      let text = typeof content === "string" ? content : safeJsonStringify(content);
      if (text.length > 8000) text = text.slice(0, 8000) + `\n…\n[truncated, ${text.length} chars total]`;
      pre.textContent = text;
    }
  }

  /* ---- Stats bar + action bar (same for chat + code) ------------------ */
  function getModelDetails(modelName) {
    if (!modelName) return { paramSize: "", quantization: "" };
    const m = allModels.find((x) => x.name === modelName);
    if (!m || !m.details) return { paramSize: "", quantization: "" };
    return {
      paramSize: m.details.parameter_size || "",
      quantization: m.details.quantization_level || "",
    };
  }

  function formatNumberCompact(n) {
    if (!Number.isFinite(n)) return "0";
    if (n < 10000) return n.toLocaleString();
    if (n < 1_000_000) return (n / 1000).toFixed(1).replace(/\.0$/, "") + "k";
    return (n / 1_000_000).toFixed(2) + "M";
  }

  function formatDurationShort(seconds) {
    if (!Number.isFinite(seconds) || seconds < 0) return "0s";
    if (seconds < 1) return Math.max(1, Math.round(seconds * 1000)) + "ms";
    if (seconds < 10) return seconds.toFixed(1) + "s";
    if (seconds < 60) return Math.round(seconds) + "s";
    const m = Math.floor(seconds / 60);
    const s = Math.round(seconds - m * 60);
    if (m < 60) return s ? `${m}m ${s}s` : `${m}m`;
    const h = Math.floor(m / 60);
    const mm = m - h * 60;
    return mm ? `${h}h ${mm}m` : `${h}h`;
  }

  function messagePlainText(msg) {
    if (!msg) return "";
    if (typeof msg.content === "string" && msg.content) return msg.content;
    const blocks = Array.isArray(msg.blocks) ? msg.blocks : [];
    return blocks.filter((b) => b && b.type === "text")
      .map((b) => b.text || "")
      .join("\n\n");
  }

  function svgEl(width, height, paths) {
    const ns = "http://www.w3.org/2000/svg";
    const svg = document.createElementNS(ns, "svg");
    svg.setAttribute("viewBox", "0 0 24 24");
    svg.setAttribute("width", String(width));
    svg.setAttribute("height", String(height));
    svg.setAttribute("fill", "none");
    svg.setAttribute("stroke", "currentColor");
    svg.setAttribute("stroke-width", "2");
    svg.setAttribute("stroke-linecap", "round");
    svg.setAttribute("stroke-linejoin", "round");
    svg.setAttribute("aria-hidden", "true");
    svg.innerHTML = paths;
    return svg;
  }

  function buildStatsBar(stats) {
    if (!stats) return null;
    const bar = document.createElement("div");
    bar.className = "msg-stats";

    const details = getModelDetails(stats.model);

    const modelChip = document.createElement("span");
    modelChip.className = "stats-chip stats-model";
    modelChip.appendChild(svgEl(13, 13,
      '<path d="M12 2 L22 8 L22 16 L12 22 L2 16 L2 8 Z"/><path d="M2 8 L12 14 L22 8"/><line x1="12" y1="14" x2="12" y2="22"/>'));
    const name = document.createElement("span");
    name.className = "stats-model-name";
    name.textContent = stats.model || "(unknown model)";
    modelChip.appendChild(name);
    if (details.paramSize) {
      const sub = document.createElement("span");
      sub.className = "stats-sub";
      sub.textContent = details.paramSize.replace(/\s+/g, "").toUpperCase();
      modelChip.appendChild(sub);
    }
    if (details.quantization) {
      const sub = document.createElement("span");
      sub.className = "stats-sub stats-sub-quant";
      sub.textContent = `${details.quantization}.gguf`;
      modelChip.appendChild(sub);
    }
    bar.appendChild(modelChip);

    const items = [];
    if (stats.tokens) {
      items.push({
        title: "Tokens generated",
        svg: '<line x1="9" y1="6" x2="20" y2="6"/><line x1="9" y1="12" x2="20" y2="12"/><line x1="9" y1="18" x2="20" y2="18"/><line x1="4" y1="6" x2="5" y2="6"/><line x1="4" y1="12" x2="5" y2="12"/><line x1="4" y1="18" x2="5" y2="18"/>',
        text: `${formatNumberCompact(stats.tokens || 0)} tokens`,
      });
    }
    items.push({
      title: "Total time",
      svg: '<circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/>',
      text: formatDurationShort(stats.durationSec || 0),
    });
    if (stats.tps) {
      items.push({
        title: "Generation speed",
        svg: '<path d="M12 14a4 4 0 1 0 0-8 4 4 0 0 0 0 8z"/><path d="M21.17 8H12V2.83A9 9 0 1 0 21.17 8z"/>',
        text: `${(stats.tps || 0).toFixed(2)} t/s`,
      });
    }
    for (const it of items) {
      const span = document.createElement("span");
      span.className = "stats-info";
      span.title = it.title;
      span.appendChild(svgEl(12, 12, it.svg));
      const t = document.createElement("span");
      t.textContent = it.text;
      span.appendChild(t);
      bar.appendChild(span);
    }
    return bar;
  }

  function buildActionBar(conv, msg) {
    const bar = document.createElement("div");
    bar.className = "msg-actions";
    const specs = [
      { act: "copy",       title: "Copy",       svg: '<rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/>' },
      { act: "edit",       title: "Edit",       svg: '<path d="M12 20h9"/><path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4z"/>' },
      { act: "regenerate", title: "Regenerate", svg: '<polyline points="23 4 23 10 17 10"/><polyline points="1 20 1 14 7 14"/><path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10"/><path d="M20.49 15a9 9 0 0 1-14.85 3.36L1 14"/>' },
      { act: "delete",     title: "Delete",     svg: '<polyline points="3 6 5 6 21 6"/><path d="M19 6l-2 14a2 2 0 0 1-2 2H9a2 2 0 0 1-2-2L5 6"/><line x1="10" y1="11" x2="10" y2="17"/><line x1="14" y1="11" x2="14" y2="17"/>' },
    ];
    for (const s of specs) {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "msg-action-btn";
      btn.title = s.title;
      btn.dataset.act = s.act;
      btn.appendChild(svgEl(14, 14, s.svg));
      btn.addEventListener("click", () => handleMsgAction(s.act, conv, msg, btn));
      bar.appendChild(btn);
    }
    return bar;
  }

  function handleMsgAction(action, conv, msg, btn) {
    if (action === "copy") {
      const text = messagePlainText(msg);
      navigator.clipboard.writeText(text).then(() => {
        const orig = btn.innerHTML;
        btn.innerHTML = "";
        btn.appendChild(svgEl(14, 14, '<polyline points="20 6 9 17 4 12"/>'));
        btn.classList.add("status-ok");
        setTimeout(() => { btn.innerHTML = orig; btn.classList.remove("status-ok"); }, 1200);
      }).catch(() => alert("Copy failed."));
      return;
    }
    if (action === "delete") {
      if (!confirm("Delete this message? This cannot be undone.")) return;
      const idx = conv.messages.indexOf(msg);
      if (idx === -1) return;
      conv.messages.splice(idx, 1);
      ctx().save();
      renderMessages();
      return;
    }
    if (action === "edit") {
      startEditMessage(conv, msg);
      return;
    }
    if (action === "regenerate") {
      regenerateMessage(conv, msg);
      return;
    }
  }

  function startEditMessage(conv, msg) {
    const text = messagePlainText(msg);
    const ta = document.createElement("textarea");
    ta.className = "msg-edit-textarea";
    ta.value = text;
    ta.rows = Math.min(20, Math.max(3, text.split("\n").length + 1));
    const save = document.createElement("button");
    save.type = "button";
    save.className = "btn-primary msg-edit-save";
    save.textContent = "Save";
    const cancel = document.createElement("button");
    cancel.type = "button";
    cancel.className = "btn-secondary msg-edit-cancel";
    cancel.textContent = "Cancel";
    const wrap = document.createElement("div");
    wrap.className = "msg-edit";
    wrap.appendChild(ta);
    const row = document.createElement("div");
    row.className = "msg-edit-actions";
    row.appendChild(cancel);
    row.appendChild(save);
    wrap.appendChild(row);

    const all = el.messages.querySelectorAll(".message");
    const idx = conv.messages.indexOf(msg);
    if (idx === -1 || idx >= all.length) return;
    const bubble = all[idx];
    const body = bubble.querySelector(".message-body");
    if (!body) return;
    body.appendChild(wrap);
    setTimeout(() => ta.focus(), 0);

    const close = () => renderMessages();
    cancel.addEventListener("click", close);
    save.addEventListener("click", () => {
      const newText = ta.value;
      msg.content = newText;
      if (Array.isArray(msg.blocks)) {
        let replaced = false;
        for (const b of msg.blocks) {
          if (b && b.type === "text") { b.text = newText; replaced = true; break; }
        }
        if (!replaced) msg.blocks.unshift({ type: "text", text: newText });
      }
      ctx().save();
      renderMessages();
    });
  }

  function buildLiveStats() {
    const wrap = document.createElement("div");
    wrap.className = "live-stats";
    const pulse = document.createElement("span");
    pulse.className = "live-pulse";
    wrap.appendChild(pulse);
    const label = document.createElement("span");
    label.className = "live-stats-label";
    label.textContent = "waiting…";
    wrap.appendChild(label);
    const start = performance.now();
    let tokens = 0;
    const render = () => {
      const elapsed = (performance.now() - start) / 1000;
      if (tokens <= 0) {
        label.textContent = `thinking… ${elapsed.toFixed(1)}s`;
        return;
      }
      const tps = elapsed > 0 ? tokens / elapsed : 0;
      label.textContent =
        `thinking… ${tokens.toLocaleString()} tokens · ${elapsed.toFixed(1)}s · ${tps.toFixed(2)} t/s`;
    };
    const tick = setInterval(render, 150);
    return {
      el: wrap,
      addTokens(n) { tokens += n; render(); },
      setTokens(n) { tokens = n; render(); },
      stop() { clearInterval(tick); },
    };
  }

  function regenerateMessage(conv, msg) {
    if (msg.role !== "assistant") return;
    const idx = conv.messages.indexOf(msg);
    if (idx <= 0) return;
    let userIdx = idx - 1;
    while (userIdx >= 0 && conv.messages[userIdx].role !== "user") userIdx--;
    if (userIdx < 0) return;
    const userText = messagePlainText(conv.messages[userIdx]);
    if (!userText.trim()) return;
    conv.messages.splice(userIdx);
    ctx().save();
    renderMessages();
    if (activeView === "code") sendCodeMessage(userText);
    else                       sendMessage(userText);
  }

  /* ---- Code message DOM (with block list for tool calls) -------------- */
  function buildCodeMessageEl(msg, conv) {
    const wrapper = document.createElement("div");
    wrapper.className = "message " + msg.role + " code-msg";

    const avatar = document.createElement("div");
    avatar.className = "avatar";
    avatar.textContent = msg.role === "user" ? "U" : "CD";
    if (msg.role !== "user") avatar.title = "claw-dev";
    wrapper.appendChild(avatar);

    const body = document.createElement("div");
    body.className = "message-body";

    const role = document.createElement("div");
    role.className = "message-role";
    role.textContent = msg.role === "user" ? "You" : "claw-dev";
    body.appendChild(role);

    const blocksEl = document.createElement("div");
    blocksEl.className = "message-blocks";
    body.appendChild(blocksEl);

    wrapper.appendChild(body);
    wrapper._blocksEl = blocksEl;

    const blocks = msg.blocks || (msg.content ? [{ type: "text", text: msg.content }] : []);
    for (const b of blocks) appendBlockEl(blocksEl, b);

    const hasContent = (msg.content && msg.content.trim()) ||
                       (Array.isArray(msg.blocks) && msg.blocks.length > 0);
    if (msg.role === "assistant" && hasContent) {
      const statsBar = buildStatsBar(msg.stats);
      if (statsBar) body.appendChild(statsBar);
      body.appendChild(buildActionBar(conv, msg));
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
    return null;
  }

  /* ---- Sending a code message: stream claw-dev output ----------------- */
  async function sendCodeMessage(text) {
    const ollamaModel = el.modelSelect.value || "";
    if (!ollamaModel) {
      alert("Pick an Ollama model in the topbar first — claw-dev runs on it via the local proxy.");
      return;
    }

    const c = ctx();
    let conv = getActiveConversation();
    if (!conv) conv = createConversation();
    if (!conv.clawSessionId) conv.clawSessionId = uuidv4();
    // Tag this conversation with the active project at send-time so the
    // sidebar filter and project recency stay accurate.
    if (activeProjectId && conv.projectId !== activeProjectId) {
      conv.projectId = activeProjectId;
    }
    const isFirstTurn = conv.messages.length === 0;

    const userMsg = { role: "user", content: text, blocks: [{ type: "text", text }] };
    conv.messages.push(userMsg);
    setConversationTitle(conv, text);
    conv.model = ollamaModel;
    const activeProj = getActiveProject();
    if (activeProj) {
      activeProj.updatedAt = Date.now();
      saveProjects();
    }
    c.save();
    el.welcome.classList.add("hidden");
    el.messages.appendChild(buildCodeMessageEl(userMsg, conv));

    const assistantMsg = { role: "assistant", content: "", blocks: [], model: ollamaModel };
    conv.messages.push(assistantMsg);
    const assistantEl = buildCodeMessageEl(assistantMsg, conv);
    const blocksEl = assistantEl._blocksEl;
    const live = buildLiveStats();
    assistantEl.querySelector(".message-body").appendChild(live.el);
    el.messages.appendChild(assistantEl);
    scrollToBottom();

    codeToolUseEls.clear();
    isStreaming = true;
    el.sendBtn.classList.add("hidden");
    el.stopBtn.classList.remove("hidden");
    currentAbortController = new AbortController();

    let activeTextBlock = null;
    const ensureTextBlock = () => {
      if (activeTextBlock) return activeTextBlock;
      const blk = { type: "text", text: "" };
      assistantMsg.blocks.push(blk);
      blk._el = appendBlockEl(blocksEl, blk);
      activeTextBlock = blk;
      return blk;
    };
    const closeTextBlock = () => { activeTextBlock = null; };

    const eff = effectiveCodeContext();
    const wallStart = performance.now();
    try {
      const res = await fetch("/code/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          prompt: text,
          sessionId: conv.clawSessionId,
          resume: !isFirstTurn,
          cwd: eff.cwd || undefined,
          allowedDirs: eff.allowedDirs,
          ollamaModel,
        }),
        signal: currentAbortController.signal,
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
          let env;
          try { env = JSON.parse(line); } catch { continue; }

          if (env.kind === "meta") {
            currentCodeJobId = env.jobId;
          } else if (env.kind === "system_init") {
            // claw-dev's own model string (claude-sonnet-4-6) — keep ours.
          } else if (env.kind === "text_delta") {
            const blk = ensureTextBlock();
            blk.text += env.text || "";
            if (blk._el) blk._el.innerHTML = renderMarkdown(blk.text);
            if (env.text) live.addTokens(1);
          } else if (env.kind === "assistant_text") {
            const blk = ensureTextBlock();
            if (!blk.text) {
              blk.text = env.text || "";
              if (blk._el) blk._el.innerHTML = renderMarkdown(blk.text);
            }
          } else if (env.kind === "thinking") {
            const t = { type: "text", text: `_${env.text || ""}_` };
            assistantMsg.blocks.push(t);
            appendBlockEl(blocksEl, t);
            closeTextBlock();
          } else if (env.kind === "tool_use") {
            closeTextBlock();
            const blk = { type: "tool_use", id: env.id, name: env.name, input: env.input || {} };
            assistantMsg.blocks.push(blk);
            const dom = buildToolUseBlock(blk.name, blk.input);
            blocksEl.appendChild(dom);
            codeToolUseEls.set(env.id, { dom, block: blk });
          } else if (env.kind === "tool_result") {
            const entry = codeToolUseEls.get(env.id);
            if (entry) {
              attachToolResult(entry.dom, env.output, env.isError);
              entry.block.result = env.output;
              entry.block.isError = !!env.isError;
            }
          } else if (env.kind === "result") {
            assistantMsg.stats = {
              model: ollamaModel,
              tokens: env.usage?.output_tokens || 0,
              durationSec: env.durationMs > 0 ? env.durationMs / 1000 : (performance.now() - wallStart) / 1000,
              tps: 0,
            };
            if (env.usage?.output_tokens && env.durationMs > 0) {
              assistantMsg.stats.tps = env.usage.output_tokens / (env.durationMs / 1000);
            }
            if (env.isError && env.result) {
              const e = { type: "text", text: `**Error:** ${env.result}` };
              assistantMsg.blocks.push(e);
              appendBlockEl(blocksEl, e);
            }
          } else if (env.kind === "warning") {
            const w = { type: "text", text: `_${env.message}_` };
            assistantMsg.blocks.push(w);
            appendBlockEl(blocksEl, w);
            closeTextBlock();
          } else if (env.kind === "error") {
            const e = { type: "text", text: `**Error:** ${env.message}` };
            assistantMsg.blocks.push(e);
            appendBlockEl(blocksEl, e);
            closeTextBlock();
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
      live.stop();
      if (live.el.parentElement) live.el.remove();
      isStreaming = false;
      currentAbortController = null;
      currentCodeJobId = null;
      el.sendBtn.classList.remove("hidden");
      el.stopBtn.classList.add("hidden");
      assistantMsg.content = assistantMsg.blocks
        .filter((b) => b.type === "text")
        .map((b) => b.text).join("\n\n");
      c.save();
      localStorage.setItem(STORAGE.lastModelCode, ollamaModel);

      const body = assistantEl.querySelector(".message-body");
      if (body) {
        const statsBar = buildStatsBar(assistantMsg.stats);
        if (statsBar) body.appendChild(statsBar);
        body.appendChild(buildActionBar(conv, assistantMsg));
      }
      refreshCodeBanner();
    }
  }

  async function stopCodeJob() {
    if (currentAbortController) currentAbortController.abort();
    if (currentCodeJobId) {
      try {
        await fetch("/code/stop", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ jobId: currentCodeJobId }),
        });
      } catch { /* best effort */ }
    }
  }

  /* ----------------------------------------------------------
     Chat send / stream
     ---------------------------------------------------------- */
  async function sendMessage(text) {
    text = text.trim();
    if (!text || isStreaming) return;

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
    el.messages.appendChild(buildMessageEl(conv.messages[conv.messages.length - 1], conv));

    const assistantMsg = { role: "assistant", content: "" };
    conv.messages.push(assistantMsg);
    const assistantEl = buildMessageEl(assistantMsg, conv);
    const contentEl = assistantEl.querySelector(".message-content");
    const live = buildLiveStats();
    assistantEl.querySelector(".message-body").appendChild(live.el);
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
      const wallStart = performance.now();
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
              live.addTokens(1);
              assistantMsg.content += piece;
              contentEl.innerHTML = renderMarkdown(assistantMsg.content);
              scrollToBottom();
            }
            if (chunk.done) {
              const evalCount = chunk.eval_count || 0;
              const evalDurNs = chunk.eval_duration || 0;
              const totalDurNs = chunk.total_duration || 0;
              assistantMsg.stats = {
                model,
                tokens: evalCount,
                durationSec: totalDurNs > 0 ? totalDurNs / 1e9 : (performance.now() - wallStart) / 1000,
                tps: evalDurNs > 0 ? evalCount / (evalDurNs / 1e9) : 0,
              };
              c.save();
            }
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
      localStorage.setItem(STORAGE.lastModelChat, model);
      live.stop();
      if (live.el.parentElement) live.el.remove();
      const statsBar = buildStatsBar(assistantMsg.stats);
      if (statsBar) assistantEl.querySelector(".message-body").appendChild(statsBar);
      const actionBar = buildActionBar(getActiveConversation(), assistantMsg);
      assistantEl.querySelector(".message-body").appendChild(actionBar);
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
     Projects: CRUD + grid + modal
     ---------------------------------------------------------- */
  function refreshProjectsLinkBtn() {
    if (!el.projectsLinkBtn) return;
    el.projectsLinkBtn.hidden = activeView !== "code";
    if (el.projectsLinkCount) el.projectsLinkCount.textContent = String(projects.length);
    el.projectsLinkBtn.classList.toggle("active", activeView === "code" && inCodeProjectsView);
  }

  function showCodeProjectsView() {
    if (activeView !== "code") return;
    inCodeProjectsView = true;
    localStorage.setItem(STORAGE.inProjectsView, "1");
    renderProjects();
    refreshViewPanes();
    refreshProjectsLinkBtn();
    if (el.codeBanner) el.codeBanner.hidden = true;
    if (el.clearChatBtn) el.clearChatBtn.style.display = "none";
  }

  function hideCodeProjectsView() {
    inCodeProjectsView = false;
    localStorage.setItem(STORAGE.inProjectsView, "0");
    refreshViewPanes();
    refreshProjectsLinkBtn();
    if (el.codeBanner) el.codeBanner.hidden = false;
    if (el.clearChatBtn) el.clearChatBtn.style.display = "";
  }

  function setActiveProject(id, opts = {}) {
    activeProjectId = id || null;
    saveProjects();
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
      if (el.codeBanner) el.codeBanner.hidden = false;
      if (el.clearChatBtn) el.clearChatBtn.style.display = "";
      codeCheck();
    }
  }

  function createProjectObject(name, cwd, allowedDirs) {
    const id = "p_" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
    const now = Date.now();
    return {
      id,
      name: (name || "").trim() || derivedProjectName(cwd) || "Untitled project",
      cwd: (cwd || "").trim(),
      allowedDirs: Array.isArray(allowedDirs) ? allowedDirs.slice() : [],
      createdAt: now,
      updatedAt: now,
    };
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

  function renderProjects() {
    if (!el.projectsGrid) return;
    const q = (projectsSearchQuery || "").trim().toLowerCase();
    const list = projects
      .filter((p) => !q || p.name.toLowerCase().includes(q) || (p.cwd || "").toLowerCase().includes(q))
      .slice()
      .sort(projectsSortByName
        ? (a, b) => a.name.localeCompare(b.name)
        : (a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));

    Array.from(el.projectsGrid.children).forEach((c) => {
      if (c !== el.projectsEmpty) c.remove();
    });

    if (el.projectsEmpty) el.projectsEmpty.hidden = list.length !== 0;
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

  function openProjectModal(id) {
    editingProjectId = id || null;
    const proj = id ? projects.find((p) => p.id === id) : null;
    el.projectModalTitle.textContent = proj ? "Edit project" : "New project";
    el.projectNameInput.value = proj ? proj.name : "";
    el.projectCwdInput.value = proj ? proj.cwd : "";
    el.projectAllowedDirsInput.value = proj ? allowedDirsAsText(proj.allowedDirs) : "";
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

    if (editingProjectId) {
      const proj = projects.find((p) => p.id === editingProjectId);
      if (!proj) return closeProjectModal();
      proj.name = name || derivedProjectName(cwd) || proj.name || "Untitled";
      proj.cwd = cwd;
      proj.allowedDirs = allowedDirs;
      proj.updatedAt = Date.now();
      saveProjects();
      if (activeProjectId === proj.id) {
        refreshCodeBanner();
        codeCheck();
      }
    } else {
      const proj = createProjectObject(name, cwd, allowedDirs);
      projects.unshift(proj);
      saveProjects();
      setActiveProject(proj.id, { silent: true });
      // Open the chat view for the new project.
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

  /* ----------------------------------------------------------
     Directory picker modal
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
      const res = await fetch(`/code/fs/list?${qs}`);
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
      const icon = entry.type === "drive" ? "💽"
                 : entry.type === "dir"   ? "📁"
                 : entry.type === "symlink" ? "🔗" : "📄";
      row.innerHTML =
        `<span class="dir-picker-icon">${icon}</span>` +
        `<span class="dir-picker-name">${escapeHtml(entry.name)}</span>`;
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

  function pickPrimaryCwd() {
    const proj = getActiveProject();
    if (proj) {
      // Active project — picker edits the project's cwd, not the global setting.
      openDirPicker({
        title: `Pick working directory for "${proj.name}"`,
        selectLabel: "Use as project directory",
        initialPath: proj.cwd || "",
        onSelect: (absPath) => {
          proj.cwd = absPath;
          proj.updatedAt = Date.now();
          saveProjects();
          refreshCodeBanner();
        },
      });
      return;
    }
    openDirPicker({
      title: "Pick default working directory",
      selectLabel: "Use as default directory",
      initialPath: settings.codeCwd || (codeCheckInfo && codeCheckInfo.cwd) || "",
      onSelect: (absPath) => {
        settings.codeCwd = absPath;
        saveSettings();
        if (el.codeCwdInput) el.codeCwdInput.value = absPath;
        refreshCodeBanner();
        codeCheck();
      },
    });
  }

  function pickAdditionalDir() {
    const proj = getActiveProject();
    if (proj) {
      openDirPicker({
        title: `Add a directory to "${proj.name}"`,
        selectLabel: "Add this directory",
        initialPath: "",
        onSelect: (absPath) => {
          if (absPath === proj.cwd) {
            alert("That's already the working directory.");
            return;
          }
          const list = Array.isArray(proj.allowedDirs) ? proj.allowedDirs.slice() : [];
          if (list.includes(absPath)) {
            alert("That directory is already in the list.");
            return;
          }
          list.push(absPath);
          proj.allowedDirs = list;
          proj.updatedAt = Date.now();
          saveProjects();
          refreshCodeBanner();
        },
      });
      return;
    }
    alert(
      "Pick or create a project first — additional directories belong to a project.\n\n" +
      "Settings → Default working directory is for the case when no project is active."
    );
  }

  /* ----------------------------------------------------------
     Settings UI
     ---------------------------------------------------------- */
  function openSettings() {
    el.hostInput.value = settings.host;
    el.systemPrompt.value = settings.systemPrompt;
    if (el.codeCwdInput) el.codeCwdInput.value = settings.codeCwd || "";
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
    if (el.codeCwdInput) settings.codeCwd = el.codeCwdInput.value.trim();
    settings.temperature = parseFloat(el.temperature.value);
    settings.topP = parseFloat(el.topP.value);
    settings.topK = parseInt(el.topK.value, 10);
    settings.numPredict = parseInt(el.numPredict.value, 10);
    settings.repeatPenalty = parseFloat(el.repeatPenalty.value);
    saveSettings();
    fetchModels();
    if (activeView === "code") {
      codeCheck();
      refreshCodeBanner();
    }
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
    el.navTabs.forEach((t) =>
      t.addEventListener("click", () => setView(t.dataset.view))
    );

    el.newChatBtn.addEventListener("click", () => createConversation());
    el.toggleSidebar.addEventListener("click", () => {
      const willOpen = el.sidebar.classList.contains("collapsed");
      el.sidebar.classList.toggle("collapsed");
      if (isMobileViewport()) {
        document.body.classList.toggle("sidebar-open", willOpen);
      }
    });
    if (el.sidebarBackdrop) {
      el.sidebarBackdrop.addEventListener("click", closeMobileSidebar);
    }
    document.addEventListener("keydown", (e) => {
      if (e.key === "Escape" && isMobileViewport() &&
          !el.sidebar.classList.contains("collapsed")) {
        closeMobileSidebar();
      }
    });
    window.addEventListener("resize", syncSidebarForViewport);
    syncSidebarForViewport();

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

    el.clearChatBtn.addEventListener("click", () => {
      const conv = getActiveConversation();
      if (!conv) return;
      if (confirm("Clear all messages in this chat?")) {
        conv.messages = [];
        conv.title = activeView === "code" ? "New task" : "New chat";
        if (activeView === "code") conv.clawSessionId = uuidv4();
        ctx().save();
        renderConversations();
        renderMessages();
        if (activeView === "code") refreshCodeBanner();
      }
    });

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

    if (el.welcomeTips) {
      el.welcomeTips.addEventListener("click", (e) => {
        const card = e.target.closest(".tip-card");
        if (!card) return;
        el.input.value = card.textContent.replace(/^[^\s]+\s/, "");
        autoSizeTextarea();
        el.input.focus();
      });
    }

    el.modelSelect.addEventListener("change", () => {
      const lastKey = (activeView === "code") ? STORAGE.lastModelCode : STORAGE.lastModelChat;
      localStorage.setItem(lastKey, el.modelSelect.value);
      const conv = getActiveConversation();
      if (conv) {
        conv.model = el.modelSelect.value;
        ctx().save();
      }
      if (activeView === "code") refreshCodeBanner();
    });

    // Code banner buttons
    if (el.codePickCwdBtn) el.codePickCwdBtn.addEventListener("click", pickPrimaryCwd);
    if (el.codeAddDirBtn) el.codeAddDirBtn.addEventListener("click", pickAdditionalDir);

    // Settings: Browse for default cwd
    if (el.codePickCwdSettingsBtn) {
      el.codePickCwdSettingsBtn.addEventListener("click", () => {
        openDirPicker({
          title: "Pick default working directory",
          selectLabel: "Use as default directory",
          initialPath: (el.codeCwdInput && el.codeCwdInput.value.trim()) ||
                       settings.codeCwd || (codeCheckInfo && codeCheckInfo.cwd) || "",
          onSelect: (abs) => {
            if (el.codeCwdInput) el.codeCwdInput.value = abs;
          },
        });
      });
    }

    // Dir picker modal wiring
    if (el.dirPickerClose) el.dirPickerClose.addEventListener("click", closeDirPicker);
    if (el.dirPickerCancel) el.dirPickerCancel.addEventListener("click", closeDirPicker);
    if (el.dirPickerSelect) el.dirPickerSelect.addEventListener("click", confirmDirPicker);
    if (el.dirPickerUp) {
      el.dirPickerUp.addEventListener("click", async () => {
        const qs = new URLSearchParams({ path: dirPickerCurrentPath || "" });
        try {
          const res = await fetch(`/code/fs/list?${qs}`);
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

    // Projects wiring
    if (el.projectsLinkBtn) {
      el.projectsLinkBtn.addEventListener("click", () => {
        if (inCodeProjectsView) hideCodeProjectsView();
        else showCodeProjectsView();
        closeMobileSidebar();
      });
    }
    if (el.codeProjectChip) {
      el.codeProjectChip.addEventListener("click", showCodeProjectsView);
    }
    if (el.newProjectBtn) {
      el.newProjectBtn.addEventListener("click", () => openProjectModal(null));
    }
    if (el.projectsSearchBtn && el.projectsSearchInput) {
      el.projectsSearchBtn.addEventListener("click", () => {
        projectsSearchOpen = !projectsSearchOpen;
        el.projectsSearchInput.hidden = !projectsSearchOpen;
        if (projectsSearchOpen) {
          setTimeout(() => el.projectsSearchInput.focus(), 0);
        } else {
          projectsSearchQuery = "";
          el.projectsSearchInput.value = "";
          renderProjects();
        }
      });
      el.projectsSearchInput.addEventListener("input", () => {
        projectsSearchQuery = el.projectsSearchInput.value;
        renderProjects();
      });
    }
    if (el.projectsSortBtn) {
      el.projectsSortBtn.addEventListener("click", () => {
        projectsSortByName = !projectsSortByName;
        renderProjects();
      });
    }
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

    setView(activeView);
    renderConversations();
    renderMessages();
    fetchModels();
    refreshProjectsLinkBtn();

    setInterval(() => {
      fetch(`${settings.host}/api/tags`, { method: "GET" })
        .then((r) => setStatus(r.ok))
        .catch(() => setStatus(false));
    }, 30000);

    el.input.focus();
  }

  document.addEventListener("DOMContentLoaded", init);
})();
