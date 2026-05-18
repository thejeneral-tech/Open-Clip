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

    // settings modal
    modal: $("settingsModal"),
    closeSettings: $("closeSettings"),
    saveSettings: $("saveSettings"),
    resetSettings: $("resetSettings"),
    hostInput: $("hostInput"),
    systemPrompt: $("systemPrompt"),
    codeSystemPrompt: $("codeSystemPrompt"),
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
    c.convs.unshift(conv);
    c.activeId = conv.id;
    c.save();
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

    // Toggle main panels
    el.chatView.hidden = (name === "models");
    el.modelsView.hidden = (name !== "models");
    el.modelPickerWrap.style.display = (name === "models") ? "none" : "";
    el.clearChatBtn.style.display = (name === "models") ? "none" : "";

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
      el.viewTitle.textContent = "Code";
      el.newChatLabel.textContent = "New task";
      el.welcomeTitle.textContent = "Ollama Code";
      el.welcomeSubtitle.textContent =
        "Local pair-programming with a coding model. Paste code, ask for fixes, or describe what you want built.";
      el.welcomeTips.hidden = false;
      el.input.placeholder = "Describe what you want to build, or paste code…";
    } else {
      el.viewTitle.textContent = "Models";
    }

    if (name !== "models") {
      // Use the picker's per-view model memory
      const c = ctx();
      const last = localStorage.getItem(c.lastModelKey);
      const installed = Array.from(el.modelSelect.options).map((o) => o.value);
      if (last && installed.includes(last)) {
        el.modelSelect.value = last;
      } else if (name === "code") {
        // Prefer a coding model if available
        const coder = installed.find((n) =>
          CODE_MODEL_HINTS.some((h) => n.toLowerCase().includes(h))
        );
        if (coder) el.modelSelect.value = coder;
      }
      renderConversations();
      renderMessages();
      // Sidebar shows the "new" button only for chat/code
      el.newChatBtn.parentElement.style.display = "";
    } else {
      el.newChatBtn.parentElement.style.display = "none";
      renderInstalledModels();
    }
  }

  /* ----------------------------------------------------------
     Rendering: conversations + messages
     ---------------------------------------------------------- */
  function renderConversations() {
    const c = ctx();
    el.conversations.innerHTML = "";
    if (c.convs.length === 0) {
      const empty = document.createElement("div");
      empty.className = "convs-empty";
      empty.textContent =
        c.view === "code" ? "No coding tasks yet" : "No conversations yet";
      el.conversations.appendChild(empty);
      return;
    }
    for (const conv of c.convs) {
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
    for (const msg of conv.messages) {
      el.messages.appendChild(buildMessageEl(msg));
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
     Send / stream a chat or code message
     ---------------------------------------------------------- */
  async function sendMessage(text) {
    text = text.trim();
    if (!text || isStreaming) return;

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
    if (currentAbortController) currentAbortController.abort();
  }

  /* ----------------------------------------------------------
     Settings UI
     ---------------------------------------------------------- */
  function openSettings() {
    el.hostInput.value = settings.host;
    el.systemPrompt.value = settings.systemPrompt;
    el.codeSystemPrompt.value = settings.codeSystemPrompt;
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
    settings.temperature = parseFloat(el.temperature.value);
    settings.topP = parseFloat(el.topP.value);
    settings.topK = parseInt(el.topK.value, 10);
    settings.numPredict = parseInt(el.numPredict.value, 10);
    settings.repeatPenalty = parseFloat(el.repeatPenalty.value);
    saveSettings();
    fetchModels();
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
