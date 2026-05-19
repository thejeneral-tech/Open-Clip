# Trend Vault — Linux Install Guide

This is for `launcher-linux.py` — the Linux build of the launcher. If you're
on Windows, use `launcher.py` instead (the Linux one aborts at import time
on Windows).

---

## 1. Prerequisites

Install these before launching anything.

### System packages

| Package         | Why                                                  |
| --------------- | ---------------------------------------------------- |
| `python3` (≥ 3.10) | runs the launcher                                |
| `python3-tk`    | Tk GUI bindings (the launcher is a Tk app)           |
| `nodejs` + `npm`| Web App + Render Worker + Ollama Chat UI need it     |
| `lsof`          | port-kill mechanism (fallbacks: `ss`, `fuser`)       |
| Fonts: `DejaVu Sans` + `DejaVu Sans Mono` | usually preinstalled |

Distro-specific install:

```bash
# Debian / Ubuntu / Mint
sudo apt update
sudo apt install python3 python3-tk nodejs npm lsof fonts-dejavu

# Fedora / RHEL
sudo dnf install python3 python3-tkinter nodejs npm lsof dejavu-fonts-all

# Arch / Manjaro
sudo pacman -S python tk nodejs npm lsof ttf-dejavu
```

> If your distro ships an old Node.js (< 18), grab a current one from
> [nodejs.org](https://nodejs.org/) or use
> [`nvm`](https://github.com/nvm-sh/nvm).

### Ollama

The launcher will **not** install Ollama for you on Linux (the official
installer needs `sudo`). Run this in a terminal once:

```bash
curl -fsSL https://ollama.com/install.sh | sh
```

…or follow the steps at <https://ollama.com/download/linux>. After install:

```bash
ollama pull llama3.2          # any model — this one is small + general-purpose
```

The launcher detects Ollama on PATH and lights up its service card.

### Kokoro TTS (optional)

If you want local voice synthesis, set up the Kokoro venv:

```bash
# from the Trend Vault root
bash scripts/setup-kokoro.sh
```

This creates `kokoro-tts/.venv/` and downloads the voice model
(`kokoro-tts/kokoro-v0_19.onnx`, ~330 MB). The launcher's HEALTH check
flags it as MISSING until both exist.

If you don't need TTS, you can skip this — every other service still works.

---

## 2. Run the launcher

From the `Trend Vault/` folder:

```bash
python3 launcher-linux.py
```

You should see a dark-themed window with:

- A **services** column (Web App, Render Worker, Kokoro TTS, Ollama,
  Ollama Chat UI) — each with its own Start/Stop button and a red/green
  status dot.
- A **console** that streams stdout/stderr from every service.
- A **CLI** input row at the bottom: type a shell command, hit Enter, watch
  it run in the project root. Up/Down browse history. STOP (or Esc) kills
  the running command.

The first time you click START on the Web App or Render Worker, the
launcher will run `npm install` for you. You can also trigger this
manually with the **INSTALL** action.

---

## 3. Build a single binary (optional)

If you'd rather double-click an icon than run `python3`, package it:

```bash
pip install pyinstaller
pyinstaller --onefile --name TrendVaultLauncher launcher-linux.py
```

The output is `dist/TrendVaultLauncher` — a self-contained ~12 MB ELF you
can move into `~/.local/bin/` (or wherever) and run directly. Tk and the
Python stdlib are bundled; **Node.js, Ollama, and Kokoro still need to be
installed system-wide.**

> Don't pass `--windowed` on Linux — Tk apps run fine without it, and
> `--windowed` is a macOS-specific flag.

### Desktop launcher entry

To make it appear in your application menu, drop this at
`~/.local/share/applications/trendvault.desktop`:

```ini
[Desktop Entry]
Type=Application
Name=Trend Vault Launcher
Exec=/home/YOU/.local/bin/TrendVaultLauncher
Icon=utilities-terminal
Categories=Development;
Terminal=false
```

Then `update-desktop-database ~/.local/share/applications/` (some
distros need this).

---

## 4. Service map

| Service        | Port  | What it is                                      |
| -------------- | ----- | ----------------------------------------------- |
| Web App        | 3001  | Express server — open at /trend-vault            |
| Render Worker  | 4000  | Remotion video renderer                         |
| Kokoro TTS     | 5070  | Local TTS server (needs the venv + onnx model)  |
| Ollama         | 11434 | Local LLM server                                |
| Ollama Chat UI | 3002  | Web chat (the Code/Projects feature lives here) |

Boot order when you click **START ALL**: Ollama + Kokoro first, then the
Ollama Chat UI (which proxies to `:11434`), then the rest.

---

## 5. Troubleshooting

### `ModuleNotFoundError: No module named '_tkinter'`

Tk wasn't installed alongside Python. Install `python3-tk` (Debian),
`python3-tkinter` (Fedora), or `tk` (Arch) — see the prereqs table above.

### A service won't start on its port

Something else is already listening there. Click **STOP** on that service —
the launcher uses `lsof -ti tcp:PORT` (then `ss`, then `fuser`) to find
the PID and sends SIGTERM, escalating to SIGKILL after 0.4 s. If that
still doesn't free the port, find it yourself:

```bash
lsof -i :3001       # show whatever is on port 3001
kill -9 <pid>
```

### "npm not found" / "node not found"

The launcher resolves `npm` / `node` via your `PATH`. If you installed
via `nvm`, make sure your shell sources nvm in `~/.bashrc` / `~/.zshrc`
**before** launching from a desktop entry — Desktop Entries don't read
your shell rc. Easiest fix: in the `.desktop` file, set
`Exec=bash -lc '/home/YOU/.local/bin/TrendVaultLauncher'` so a login
shell is started first.

### Ollama card stays red after install

The launcher checks `shutil.which('ollama')` on every status poll
(every 2 s). If it doesn't see it, the binary isn't on PATH for the
launcher's process. Either restart the launcher after `curl …/install.sh`,
or symlink it: `sudo ln -s /usr/local/bin/ollama /usr/bin/ollama`.

### Kokoro shows MISSING in Health

Either:
- the venv at `kokoro-tts/.venv/bin/python` doesn't exist → run
  `bash scripts/setup-kokoro.sh`
- or the model at `kokoro-tts/kokoro-v0_19.onnx` is missing — the setup
  script downloads it; re-run it.

### Permission denied on a kill

Some processes (e.g. spawned by `sudo`) can't be killed by your user.
You'll see a silent fail in the log. Kill them manually as root.

### Fonts look wrong / boxes instead of glyphs

Install `fonts-dejavu` (or your distro's equivalent). The launcher
explicitly asks for `DejaVu Sans` / `DejaVu Sans Mono`; Tk falls back to
its default if either is missing.

---

## 6. CLI input row — quick reference

| Key       | Action                                              |
| --------- | --------------------------------------------------- |
| Enter     | run the typed command (`$SHELL -c '<cmd>'`)         |
| Up        | previous command in history                         |
| Down      | next command (past the newest restores your draft)  |
| Esc       | stop the running command (same as the STOP button)  |

History is in-memory only (200 entries, dedup consecutive repeats);
it does **not** persist across launcher restarts.
