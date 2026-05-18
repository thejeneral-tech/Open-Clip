/* ============================================================
   Ollama Chat — front-end logic
   ============================================================ */

(() => {
  "use strict";

  /* ----------------------------------------------------------
     Constants & defaults
     ---------------------------------------------------------- */
  const STORAGE_KEYS = {
    settings: "ollama-chat:settings",
    conversations: "ollama-chat:conversations",
    activeConversation: "ollama-chat:activeConversation",
  };

  const DEFAULT_SETTINGS = {
    // Empty host = same origin → the bundled server.js proxies /api/*
    // to Ollama. Set to "http://localhost:11434" to talk to Ollama
    // directly (requires OLLAMA_ORIGINS to be configured).
    host: "",
    systemPrompt: "",
    temperature: 0.7,
    topP: 0.9,
    topK: 40,
    numPredict: -1,
    repeatPenalty: 1.1,
  };

  /* ----------------------------------------------------------
     State
     ---------------------------------------------------------- */
  let settings = loadSettings();
  let conversations = loadConversations();
  let activeId = localStorage.getItem(STORAGE_KEYS.activeConversation) || null;
  let currentAbortController = null;
  let isStreaming = false;

  /* ----------------------------------------------------------
     Element references
     ---------------------------------------------------------- */
  const $ = (id) => document.getElementById(id);
  const el = {
    sidebar: $("sidebar"),
    conversations: $("conversations"),
    newChatBtn: $("newChatBtn"),
    toggleSidebar: $("toggleSidebar"),
    settingsBtn: $("settingsBtn"),
    clearChatBtn: $("clearChatBtn"),

    modelSelect: $("modelSelect"),
    statusDot: $("statusDot"),

    chat: $("chat"),
    welcome: $("welcome"),
    messages: $("messages"),

    form: $("composerForm"),
    input: $("input"),
    sendBtn: $("sendBtn"),
    stopBtn: $("stopBtn"),

    modal: $("settingsModal"),
    closeSettings: $("closeSettings"),
    saveSettings: $("saveSettings"),
    resetSettings: $("resetSettings"),
    hostInput: $("hostInput"),
    systemPrompt: $("systemPrompt"),
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
  function loadSettings() {
    try {
      const stored = JSON.parse(localStorage.getItem(STORAGE_KEYS.settings));
      return { ...DEFAULT_SETTINGS, ...(stored || {}) };
    } catch {
      return { ...DEFAULT_SETTINGS };
    }
  }

  function saveSettings() {
    localStorage.setItem(STORAGE_KEYS.settings, JSON.stringify(settings));
  }

  function loadConversations() {
    try {
      return JSON.parse(localStorage.getItem(STORAGE_KEYS.conversations)) || [];
    } catch {
      return [];
    }
  }

  function saveConversations() {
    localStorage.setItem(
      STORAGE_KEYS.conversations,
      JSON.stringify(conversations)
    );
    if (activeId) {
      localStorage.setItem(STORAGE_KEYS.activeConversation, activeId);
    } else {
      localStorage.removeItem(STORAGE_KEYS.activeConversation);
    }
  }

  /* ----------------------------------------------------------
     Conversations model
     ---------------------------------------------------------- */
  function getActiveConversation() {
    return conversations.find((c) => c.id === activeId) || null;
  }

  function createConversation() {
    const conv = {
      id: "c_" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
      title: "New chat",
      model: el.modelSelect.value || "",
      messages: [],
      createdAt: Date.now(),
    };
    conversations.unshift(conv);
    activeId = conv.id;
    saveConversations();
    renderConversations();
    renderMessages();
    return conv;
  }

  function deleteConversation(id) {
    conversations = conversations.filter((c) => c.id !== id);
    if (activeId === id) {
      activeId = conversations[0]?.id || null;
    }
    saveConversations();
    renderConversations();
    renderMessages();
  }

  function setActiveConversation(id) {
    activeId = id;
    saveConversations();
    renderConversations();
    renderMessages();
  }

  function setConversationTitle(conv, text) {
    const trimmed = text.trim().replace(/\s+/g, " ").slice(0, 60);
    if (trimmed && conv.title === "New chat") {
      conv.title = trimmed || "New chat";
      saveConversations();
      renderConversations();
    }
  }

  /* ----------------------------------------------------------
     Rendering
     ---------------------------------------------------------- */
  function renderConversations() {
    el.conversations.innerHTML = "";
    if (conversations.length === 0) {
      const empty = document.createElement("div");
      empty.style.cssText =
        "color:var(--text-dim);font-size:13px;padding:12px;text-align:center;";
      empty.textContent = "No conversations yet";
      el.conversations.appendChild(empty);
      return;
    }
    for (const conv of conversations) {
      const item = document.createElement("div");
      item.className = "conv-item" + (conv.id === activeId ? " active" : "");
      item.dataset.id = conv.id;

      const title = document.createElement("span");
      title.className = "conv-title";
      title.textContent = conv.title || "New chat";
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
     Minimal markdown renderer (safe-ish for chat output)
     - Escapes HTML
     - Supports code fences, inline code, bold, italics,
       headings, lists, blockquotes, links, paragraphs
     ---------------------------------------------------------- */
  function escapeHtml(s) {
    return s
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#039;");
  }

  function renderMarkdown(text) {
    if (!text) return "";

    // Extract code blocks first so their contents aren't re-processed.
    const codeBlocks = [];
    text = text.replace(/```([a-zA-Z0-9_+-]*)\n?([\s\S]*?)```/g, (_, lang, code) => {
      const idx = codeBlocks.length;
      codeBlocks.push(
        `<pre><code${lang ? ` class="lang-${escapeHtml(lang)}"` : ""}>${escapeHtml(
          code.replace(/\n$/, "")
        )}</code></pre>`
      );
      return ` CODEBLOCK${idx} `;
    });

    // Escape the rest of the text.
    text = escapeHtml(text);

    // Inline code.
    text = text.replace(/`([^`\n]+)`/g, (_, c) => `<code>${c}</code>`);

    // Headings.
    text = text.replace(/^###### (.+)$/gm, "<h6>$1</h6>");
    text = text.replace(/^##### (.+)$/gm, "<h5>$1</h5>");
    text = text.replace(/^#### (.+)$/gm, "<h4>$1</h4>");
    text = text.replace(/^### (.+)$/gm, "<h3>$1</h3>");
    text = text.replace(/^## (.+)$/gm, "<h2>$1</h2>");
    text = text.replace(/^# (.+)$/gm, "<h1>$1</h1>");

    // Bold and italics (bold first to avoid conflicts).
    text = text.replace(/\*\*([^*\n]+)\*\*/g, "<strong>$1</strong>");
    text = text.replace(/\*([^*\n]+)\*/g, "<em>$1</em>");
    text = text.replace(/(^|\s)_([^_\n]+)_(?=\s|$)/g, "$1<em>$2</em>");

    // Links: [text](url)
    text = text.replace(
      /\[([^\]]+)\]\(([^)\s]+)\)/g,
      '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>'
    );

    // Blockquotes.
    text = text.replace(/^&gt; (.+)$/gm, "<blockquote>$1</blockquote>");

    // Lists — group consecutive bullet/numbered items.
    text = text.replace(/(?:^|\n)((?:[-*] .+(?:\n|$))+)/g, (_, block) => {
      const items = block
        .trim()
        .split("\n")
        .map((line) => line.replace(/^[-*] /, ""))
        .map((line) => `<li>${line}</li>`)
        .join("");
      return `\n<ul>${items}</ul>`;
    });
    text = text.replace(/(?:^|\n)((?:\d+\. .+(?:\n|$))+)/g, (_, block) => {
      const items = block
        .trim()
        .split("\n")
        .map((line) => line.replace(/^\d+\. /, ""))
        .map((line) => `<li>${line}</li>`)
        .join("");
      return `\n<ol>${items}</ol>`;
    });

    // Paragraphs from double newlines; single newlines become <br>.
    const paragraphs = text.split(/\n{2,}/).map((para) => {
      if (/^\s*<(h\d|ul|ol|pre|blockquote)/.test(para)) return para;
      return `<p>${para.replace(/\n/g, "<br>")}</p>`;
    });
    text = paragraphs.join("\n");

    // Restore code blocks.
    text = text.replace(/ CODEBLOCK(\d+) /g, (_, i) => codeBlocks[+i]);

    return text;
  }

  /* ----------------------------------------------------------
     Ollama API
     ---------------------------------------------------------- */
  async function fetchModels() {
    try {
      const res = await fetch(`${settings.host}/api/tags`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      const models = (data.models || []).map((m) => m.name).sort();
      populateModelSelect(models);
      setStatus(true);
      return models;
    } catch (err) {
      console.error("Failed to list models:", err);
      populateModelSelect([], err.message);
      setStatus(false);
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
        : "No models — run 'ollama pull <model>'";
      el.modelSelect.appendChild(opt);
      el.modelSelect.disabled = true;
      return;
    }
    el.modelSelect.disabled = false;

    // Remember last picked model.
    const last = localStorage.getItem("ollama-chat:lastModel");
    for (const name of models) {
      const opt = document.createElement("option");
      opt.value = name;
      opt.textContent = name;
      el.modelSelect.appendChild(opt);
    }
    if (last && models.includes(last)) {
      el.modelSelect.value = last;
    }
  }

  function setStatus(online) {
    el.statusDot.classList.toggle("online", online);
    el.statusDot.classList.toggle("offline", !online);
    el.statusDot.title = online
      ? `Connected to ${settings.host}`
      : `Can't reach ${settings.host}`;
  }

  /* ----------------------------------------------------------
     Send / stream a message
     ---------------------------------------------------------- */
  async function sendMessage(text) {
    text = text.trim();
    if (!text || isStreaming) return;

    const model = el.modelSelect.value;
    if (!model) {
      alert("Pick a model first (or pull one with `ollama pull <model>`).");
      return;
    }

    let conv = getActiveConversation();
    if (!conv) conv = createConversation();
    conv.model = model;

    // Push user message.
    conv.messages.push({ role: "user", content: text });
    setConversationTitle(conv, text);
    saveConversations();
    el.welcome.classList.add("hidden");
    el.messages.appendChild(buildMessageEl(conv.messages[conv.messages.length - 1]));

    // Add an empty assistant message we'll stream into.
    const assistantMsg = { role: "assistant", content: "" };
    conv.messages.push(assistantMsg);
    const assistantEl = buildMessageEl(assistantMsg);
    const contentEl = assistantEl.querySelector(".message-content");
    contentEl.innerHTML =
      '<div class="typing"><span></span><span></span><span></span></div>';
    el.messages.appendChild(assistantEl);
    scrollToBottom();

    // Build the message list for the request — prepend system prompt if set.
    const apiMessages = [];
    if (settings.systemPrompt && settings.systemPrompt.trim()) {
      apiMessages.push({ role: "system", content: settings.systemPrompt.trim() });
    }
    // Send everything *except* the empty assistant placeholder.
    for (const m of conv.messages.slice(0, -1)) {
      apiMessages.push({ role: m.role, content: m.content });
    }

    const options = {
      temperature: settings.temperature,
      top_p: settings.topP,
      top_k: settings.topK,
      repeat_penalty: settings.repeatPenalty,
    };
    if (settings.numPredict !== -1) {
      options.num_predict = settings.numPredict;
    }

    const body = {
      model,
      messages: apiMessages,
      stream: true,
      options,
    };

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

        // Ollama emits one JSON object per line.
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
            if (chunk.done) {
              // Persist on completion.
              saveConversations();
            }
          } catch (parseErr) {
            console.warn("Bad chunk:", line, parseErr);
          }
        }
      }
    } catch (err) {
      if (err.name === "AbortError") {
        assistantMsg.content += "\n\n_(stopped)_";
      } else {
        console.error(err);
        assistantMsg.content =
          `**Error:** ${err.message}\n\n` +
          "Make sure Ollama is running and reachable at " +
          `\`${settings.host}\`. If the request was blocked by CORS, ` +
          "set `OLLAMA_ORIGINS=*` (or the page's origin) in Ollama's " +
          "environment and restart it.";
      }
      contentEl.innerHTML = renderMarkdown(assistantMsg.content);
    } finally {
      isStreaming = false;
      currentAbortController = null;
      el.sendBtn.classList.remove("hidden");
      el.stopBtn.classList.add("hidden");
      saveConversations();
      localStorage.setItem("ollama-chat:lastModel", model);
    }
  }

  function stopGeneration() {
    if (currentAbortController) {
      currentAbortController.abort();
    }
  }

  /* ----------------------------------------------------------
     Settings UI
     ---------------------------------------------------------- */
  function openSettings() {
    el.hostInput.value = settings.host;
    el.systemPrompt.value = settings.systemPrompt;
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

  function closeSettings() {
    el.modal.classList.add("hidden");
  }

  function applySettingsFromForm() {
    settings.host = el.hostInput.value.trim().replace(/\/+$/, "") ||
      DEFAULT_SETTINGS.host;
    settings.systemPrompt = el.systemPrompt.value;
    settings.temperature = parseFloat(el.temperature.value);
    settings.topP = parseFloat(el.topP.value);
    settings.topK = parseInt(el.topK.value, 10);
    settings.numPredict = parseInt(el.numPredict.value, 10);
    settings.repeatPenalty = parseFloat(el.repeatPenalty.value);
    saveSettings();
    fetchModels();
  }

  function resetSettingsForm() {
    settings = { ...DEFAULT_SETTINGS };
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
    // Sidebar.
    el.newChatBtn.addEventListener("click", () => createConversation());
    el.toggleSidebar.addEventListener("click", () => {
      el.sidebar.classList.toggle("collapsed");
    });

    // Settings.
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

    // Clear current chat.
    el.clearChatBtn.addEventListener("click", () => {
      const conv = getActiveConversation();
      if (!conv) return;
      if (confirm("Clear all messages in this chat?")) {
        conv.messages = [];
        conv.title = "New chat";
        saveConversations();
        renderConversations();
        renderMessages();
      }
    });

    // Composer.
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

    // Model selection persistence.
    el.modelSelect.addEventListener("change", () => {
      localStorage.setItem("ollama-chat:lastModel", el.modelSelect.value);
      const conv = getActiveConversation();
      if (conv) {
        conv.model = el.modelSelect.value;
        saveConversations();
      }
    });

    // First render.
    renderConversations();
    renderMessages();
    fetchModels();

    // Re-check connection every 30 seconds in case Ollama starts later.
    setInterval(() => {
      fetch(`${settings.host}/api/tags`, { method: "GET" })
        .then((r) => setStatus(r.ok))
        .catch(() => setStatus(false));
    }, 30000);

    // Focus the input.
    el.input.focus();
  }

  document.addEventListener("DOMContentLoaded", init);
})();
