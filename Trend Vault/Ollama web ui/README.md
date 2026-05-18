# Ollama Chat — Web UI

A clean, ChatGPT/Claude-inspired web interface for your local [Ollama](https://ollama.com) server. Pure HTML + CSS + vanilla JavaScript on the frontend, with a tiny zero-dependency Node web server that also proxies to Ollama.

## Features

- Streaming chat via Ollama's `/api/chat` endpoint
- Model picker that lists every model installed locally (`/api/tags`)
- Multiple conversations, saved in `localStorage`
- System prompt and sampling parameters (temperature, top_p, top_k, repeat penalty, max tokens)
- Configurable Ollama host
- Stop button to abort generation mid-stream
- Markdown rendering (code blocks, lists, headings, bold/italic, links)
- Dark, ChatGPT-style layout — responsive on mobile
- Bundled Node web server with built-in Ollama proxy (no CORS config needed)

## Files

- `index.html` — markup
- `styles.css` — dark theme
- `app.js` — frontend logic, streaming, storage, settings
- `server.js` — zero-dependency Node web server + Ollama reverse proxy
- `README.md` — this file

## Quick start

### 1. Install and run Ollama

If you don't have it yet, grab it from [ollama.com](https://ollama.com), then pull at least one model:

```bash
ollama pull llama3.2
# or any other model
ollama pull qwen2.5-coder
```

Make sure Ollama is running. It listens on `http://localhost:11434` by default.

### 2. Start the web server

You need [Node.js](https://nodejs.org) installed (any recent version — no `npm install` required).

```bash
node server.js
```

That's it. Visit **http://localhost:5500** in your browser.

You can change the port or point at a different Ollama host:

```bash
PORT=8080 node server.js
OLLAMA_HOST=http://192.168.1.50:11434 node server.js
```

On Windows PowerShell:

```powershell
$env:PORT=8080
node server.js
```

> Because `server.js` proxies `/api/*` to Ollama server-side, **you don't need to touch `OLLAMA_ORIGINS`** — the browser only ever talks to the proxy on the same origin.

## Usage

1. The model dropdown auto-populates from your local Ollama install.
2. The green dot in the top bar indicates a live connection to Ollama.
3. Click the gear in the sidebar to set a system prompt and tweak sampling parameters.
4. New chats appear in the sidebar — click to switch, hover and click the trash icon to delete.
5. While generating, the send button turns into a stop button.

## Alternative: skip the server, talk to Ollama directly

If you'd rather just open `index.html` in a browser without running the Node server, you can — but you'll need to allow the browser's origin in Ollama's CORS config.

Set the `OLLAMA_ORIGINS` environment variable before starting Ollama:

**macOS / Linux**

```bash
export OLLAMA_ORIGINS="*"
ollama serve
```

**Windows (PowerShell)**

```powershell
$env:OLLAMA_ORIGINS="*"
ollama serve
```

**Windows (permanent)** — open *System Properties → Environment Variables*, add a new user variable `OLLAMA_ORIGINS` with value `*`, then restart the Ollama app from the system tray.

Then open Settings in the UI and set the Ollama host to `http://localhost:11434` (instead of the empty default).

> Using `*` allows any origin. For a tighter setup, list specific origins, e.g.
> `OLLAMA_ORIGINS="http://localhost:5500,file://"`.

## Troubleshooting

- **"Couldn't reach Ollama"** in the proxy response — Ollama isn't running, or `OLLAMA_HOST` doesn't match. Test with `curl http://localhost:11434/api/tags`.
- **"Can't reach Ollama"** in the UI's top-bar dot — same cause; if you're using the server, restart it after starting Ollama.
- **CORS errors** (only happens if you're *not* using `server.js`) — set `OLLAMA_ORIGINS` (see above) and restart Ollama.
- **No models in the dropdown** — pull one: `ollama pull llama3.2`.
- **Slow first response** — Ollama loads the model into memory on the first request after idle; subsequent messages are fast.
- **Port 5500 already in use** — `PORT=8081 node server.js`.

## License

MIT — do whatever you want with it.
