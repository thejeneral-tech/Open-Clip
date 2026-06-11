# Fish Speech on the 32 GB Linux GPU server

This is how StoryVault hits **100–1000 videos/day**. The old setup ran the s2.cpp
engine **CPU-only**, reloaded the 2.6 GB model **on every clip**, and synthesized at
**~25× realtime** — a 3-minute story took ~75 min of CPU and crashed (`exit
4294967295`) the moment two ran at once on a 16 GB box. The fix is to run the engine
**once, resident, on the GPU**, and let StoryVault POST text to it over HTTP.

On a 32 GB GPU the model fits many times over; synthesis runs at roughly realtime or
faster, so a single server stream comfortably covers 1000 short videos a day.

---

## Two ways to deploy (the app supports both — no code change)

### A) StoryVault runs on a different machine, TTS offloads to the Linux box
Run the server on Linux, then point StoryVault at it.

```bash
# On the Linux GPU box:
cd /opt/StoryVault-Video-Factory
./scripts/fish-server.sh            # builds s2 with CUDA + downloads model + serves on 0.0.0.0:8080
```

```ini
# On the StoryVault machine, in .env:
FISH_TTS_URL=http://<linux-host-ip>:8080
```
A non-loopback `FISH_TTS_URL` tells StoryVault "use my remote GPU box" — it will **not**
try to spawn a local engine, and `engineReady()` / the Voice Lab connection pill go
green based on that server.

### B) StoryVault runs ON the Linux box (everything local)
Build the engine, then just set the GPU mode — StoryVault auto-starts the resident
server itself on first synth.

```bash
cd /opt/StoryVault-Video-Factory
./scripts/fish-server.sh build      # build the CUDA s2 binary + fetch the model
FISH_GPU=cuda npm start             # the app launches `s2 --server --cuda 0 --gpu-layers -1`
```

---

## Verify it's alive
```bash
# From the StoryVault machine. Any HTTP status (even 404) = the model is loaded and bound.
curl -s -o /dev/null -w '%{http_code}\n' http://<linux-host-ip>:8080/

# Real synth round-trip:
curl -s -F 'text=Fish Speech is online and running on the GPU.' \
        -F 'params={"segment_sentences":true}' \
        http://<linux-host-ip>:8080/generate -o /tmp/out.wav && ls -l /tmp/out.wav
```

## Run it as a service (survives reboots + restarts on crash)
```bash
sudo cp scripts/fish-s2.service /etc/systemd/system/
# edit User=, WorkingDirectory= to match your install
sudo systemctl daemon-reload && sudo systemctl enable --now fish-s2
systemctl status fish-s2
```

---

## Tuning knobs (env vars)

| Variable | Default | What it does |
|---|---|---|
| `FISH_TTS_URL` | `http://127.0.0.1:8080` | Where StoryVault sends synth requests. Set to the Linux box for offload (mode A). |
| `FISH_GPU` | `cpu` | `cuda` \| `vulkan` \| `cpu` for the **locally auto-started** server (mode B). |
| `FISH_GPU_DEVICE` | `0` | GPU index. |
| `FISH_GPU_LAYERS` | `-1` | Transformer layers on GPU (`-1` = offload all that fit). |
| `FISH_QUANT` | `q8_0` (server script) | Model quant. With 32 GB VRAM use `q8_0` (best quality) or `f16`; `q4_k_m` is smaller/faster. |
| `FISH_TEMPERATURE` | `0.7` | Sampling temperature for narration. Lower = steadier. |
| `FISH_MAX_TOKENS` | `2048` | Max tokens **per sentence** (segmented), so individual sentences never truncate. |
| `FISH_SEGMENT_CHARS` | `240` | Long sentences are split into clauses at this length for stability. |
| `FISH_SENTENCE_PAUSE_MS` | `180` | Natural pause inserted between sentences. |
| `FISH_THREADS` | auto | CPU threads (CPU/codec work). |
| `FISH_SYNTH_TIMEOUT_MS` | `1800000` | Client socket timeout (30 min) — guards a hung server, not normal long synth. |
| `FISH_HOST` / `FISH_PORT` | `0.0.0.0` / `8080` | Bind address/port for the server script. |

### Why long narration no longer truncates
The client sends `segment_sentences:true`, so the engine renders the script
**sentence by sentence** — each sentence gets its own `max_new_tokens` budget instead
of the whole story sharing one ~1024-token (~47 s) cap. This both removes the
truncation and improves quality (Fish is trained on short utterances).

---

## Pushing past one GPU stream (toward the high end of 1000/day)
The s2 server handles **one synthesis at a time** (HTTP 503 while busy). On a 32 GB
card the ~9 GB q8 model fits ~3× over, so for maximum throughput run **multiple
server instances** on different ports and round-robin:

```bash
FISH_PORT=8080 FISH_GPU_DEVICE=0 ./scripts/fish-server.sh serve &
FISH_PORT=8081 FISH_GPU_DEVICE=0 ./scripts/fish-server.sh serve &
FISH_PORT=8082 FISH_GPU_DEVICE=0 ./scripts/fish-server.sh serve &
# put nginx/HAProxy in front and point FISH_TTS_URL at the load balancer
```
At realtime-or-faster synthesis a single stream already clears ~1000 short videos/day;
the extra instances are headroom for spikes and for batches that run many items in
parallel. (StoryVault's Batch Studio currently processes items sequentially — the
narration bottleneck is what GPU offload removes.)
