const fs = require("node:fs");
const http = require("node:http");
const path = require("node:path");
const { spawn } = require("node:child_process");
const readline = require("node:readline/promises");

const launcherDir = __dirname;
const repoRoot = path.join(__dirname, "..");
const workspaceRoot = repoRoot;
const cliPath = path.join(repoRoot, "vendor", "claude-code-bundle", "cli.js");
const brandingPatchPath = path.join(launcherDir, "patch-branding.cjs");
const defaultPorts = {
  gemini: "8787",
  groq: "8788",
  ollama: "8789",
};

let exiting = false;
let proxyProcess = null;
let ownsProxyProcess = false;

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  cleanupAndExit(1);
});

async function main() {
  applyBrandingPatch();

  const { providerArg, forwardArgs } = parseLauncherArgs(process.argv.slice(2));
  const infoOnly = isInfoOnlyInvocation(forwardArgs);

  if (infoOnly) {
    return launchBundledClient({ ...process.env }, forwardArgs);
  }

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  try {
    const provider = await resolveProvider(rl, providerArg, forwardArgs);
    const env = { ...process.env };

    if (provider === "anthropic") {
      if (!infoOnly) {
        await configureAnthropic(env, rl);
      }
      return launchBundledClient(env, forwardArgs);
    }

    await configureCompatProvider(provider, env, rl);
    await ensureCompatProxy(provider, env);
    env.ANTHROPIC_BASE_URL = `http://127.0.0.1:${env.ANTHROPIC_COMPAT_PORT}`;
    env.ANTHROPIC_AUTH_TOKEN = "trendvault-coder-proxy";
    delete env.ANTHROPIC_API_KEY;
    return launchBundledClient(env, forwardArgs);
  } finally {
    rl.close();
  }
}

function parseLauncherArgs(args) {
  const forwardArgs = [];
  let providerArg = null;

  for (let i = 0; i < args.length; i += 1) {
    const value = args[i];
    if (value === "--provider") {
      providerArg = args[i + 1] ?? null;
      i += 1;
      continue;
    }
    forwardArgs.push(value);
  }

  return { providerArg, forwardArgs };
}

function applyBrandingPatch() {
  if (!fs.existsSync(brandingPatchPath)) {
    return;
  }

  require(brandingPatchPath);
}

async function resolveProvider(rl, providerArg, forwardArgs) {
  const preset = normalizeProviderName((providerArg ?? process.env.CLAW_PROVIDER ?? "").trim().toLowerCase());
  if (["anthropic", "gemini", "groq", "ollama"].includes(preset)) {
    return preset;
  }

  if (isInfoOnlyInvocation(forwardArgs)) {
    return "anthropic";
  }

  process.stdout.write("\nTrendVault Coder provider setup\n");
  process.stdout.write("1. Anthropic account or ANTHROPIC_API_KEY\n");
  process.stdout.write("2. Gemini API\n");
  process.stdout.write("3. Groq API\n");
  process.stdout.write("4. Ollama (local)\n\n");

  const answer = (await rl.question("Choose a provider [1]: ")).trim();
  switch (answer || "1") {
    case "1":
      return "anthropic";
    case "2":
      return "gemini";
    case "3":
      return "groq";
    case "4":
      return "ollama";
    default:
      throw new Error(`Unknown provider option: ${answer}`);
  }
}

function normalizeProviderName(raw) {
  if (raw === "claude") {
    return "anthropic";
  }
  if (raw === "grok") {
    return "groq";
  }
  return raw;
}

function isInfoOnlyInvocation(forwardArgs) {
  return (
    forwardArgs.includes("--version") ||
    forwardArgs.includes("-v") ||
    forwardArgs.includes("--help") ||
    forwardArgs.includes("-h")
  );
}

async function configureAnthropic(env, rl) {
  process.stdout.write("\nLaunching Anthropic-backed mode.\n");

  if (env.ANTHROPIC_API_KEY?.trim()) {
    process.stdout.write("Using ANTHROPIC_API_KEY from the current environment.\n");
    process.stdout.write("The bundled terminal client may ask you to confirm the detected custom API key on startup.\n");
    return;
  }

  const answer = (await rl.question(
    "No ANTHROPIC_API_KEY found. Use the normal Anthropic login flow in the app? [Y/n]: ",
  ))
    .trim()
    .toLowerCase();

  if (answer === "n" || answer === "no") {
    const key = (await rl.question("Enter ANTHROPIC_API_KEY (input is visible): ")).trim();
    if (!key) {
      throw new Error("ANTHROPIC_API_KEY was not provided.");
    }
    env.ANTHROPIC_API_KEY = key;
    process.stdout.write("Using the provided ANTHROPIC_API_KEY for this session.\n");
    process.stdout.write("The bundled terminal client may ask you to confirm the detected custom API key on startup.\n");
    return;
  }

  process.stdout.write("You can log in with an Anthropic account or Anthropic Console inside the app.\n");
}

async function configureCompatProvider(provider, env, rl) {
  env.ANTHROPIC_COMPAT_PROVIDER = provider;
  env.ANTHROPIC_COMPAT_PORT = env.ANTHROPIC_COMPAT_PORT || defaultPorts[provider];

  switch (provider) {
    case "gemini": {
      if (!env.GEMINI_API_KEY?.trim()) {
        const key = (await rl.question("Enter GEMINI_API_KEY (input is visible): ")).trim();
        if (!key) {
          throw new Error("GEMINI_API_KEY is required for Gemini mode.");
        }
        env.GEMINI_API_KEY = key;
      }
      env.GEMINI_MODEL = env.GEMINI_MODEL?.trim() || "gemini-2.5-flash";
      process.stdout.write(`\nLaunching Gemini mode with model ${env.GEMINI_MODEL}.\n`);
      break;
    }
    case "groq": {
      if (!env.GROQ_API_KEY?.trim()) {
        const key = (await rl.question("Enter GROQ_API_KEY (input is visible): ")).trim();
        if (!key) {
          throw new Error("GROQ_API_KEY is required for Groq mode.");
        }
        env.GROQ_API_KEY = key;
      }
      env.GROQ_MODEL = env.GROQ_MODEL?.trim() || "openai/gpt-oss-20b";
      process.stdout.write(`\nLaunching Groq mode with model ${env.GROQ_MODEL}.\n`);
      break;
    }
    case "ollama": {
      env.OLLAMA_BASE_URL = env.OLLAMA_BASE_URL?.trim() || "http://127.0.0.1:11434";
      env.OLLAMA_KEEP_ALIVE = env.OLLAMA_KEEP_ALIVE?.trim() || "30m";

      const userPickedModel = env.OLLAMA_MODEL?.trim();
      const probe = await fetchOllamaModels(env.OLLAMA_BASE_URL);

      if (!probe.ok) {
        process.stdout.write(
          `\nWarning: couldn't reach Ollama at ${env.OLLAMA_BASE_URL} (${probe.error}).\n`,
        );
        process.stdout.write("Continuing anyway — start Ollama before sending a message.\n");
        env.OLLAMA_MODEL = userPickedModel || "qwen3";
      } else if (userPickedModel) {
        // User specified a model — verify it. Allow base-name match so
        // "qwen3" resolves to "qwen3:8b" if that's what's installed.
        env.OLLAMA_MODEL = resolveModelName(userPickedModel, probe.models)
          || userPickedModel;
        if (!probe.models.includes(env.OLLAMA_MODEL)) {
          process.stdout.write(
            `\nWarning: model '${userPickedModel}' is not installed in Ollama.\n`,
          );
          process.stdout.write(
            `Installed: ${probe.models.length > 0 ? probe.models.join(", ") : "(none)"}\n`,
          );
          process.stdout.write(`Pull it first with:  ollama pull ${userPickedModel}\n`);
        } else if (env.OLLAMA_MODEL !== userPickedModel) {
          process.stdout.write(
            `\nResolved OLLAMA_MODEL '${userPickedModel}' -> '${env.OLLAMA_MODEL}'.\n`,
          );
        }
      } else {
        // No user pick — choose a real installed model so we don't 404 on
        // 'qwen3' just because the user pulled a different one.
        if (probe.models.length === 0) {
          throw new Error(
            `Ollama is running at ${env.OLLAMA_BASE_URL} but has no models installed.\n` +
              `Pull one first, e.g.:  ollama pull qwen3`,
          );
        }
        env.OLLAMA_MODEL = pickPreferredModel(probe.models);
        process.stdout.write(
          `\nNo OLLAMA_MODEL set — auto-picked '${env.OLLAMA_MODEL}'.\n`,
        );
        if (probe.models.length > 1) {
          process.stdout.write(
            `Other installed models: ${probe.models.filter((m) => m !== env.OLLAMA_MODEL).join(", ")}\n`,
          );
          process.stdout.write("Set OLLAMA_MODEL=<name> to override.\n");
        }
      }

      process.stdout.write(`\nLaunching Ollama mode against ${env.OLLAMA_BASE_URL} with model ${env.OLLAMA_MODEL}.\n`);
      process.stdout.write(`Ollama keep-alive is set to ${env.OLLAMA_KEEP_ALIVE} for faster follow-up turns.\n`);
      break;
    }
    default:
      throw new Error(`Unsupported provider: ${provider}`);
  }
}

async function ensureCompatProxy(provider, env) {
  const proxyPort = env.ANTHROPIC_COMPAT_PORT;
  const proxyUrl = `http://127.0.0.1:${proxyPort}`;

  if (await isHealthyProxy(proxyUrl, provider, modelForProvider(provider, env))) {
    return;
  }

  // Pipe stdio so we can both surface real errors (previously hidden by
  // stdio: "ignore" — which made every Ollama crash look identical) and
  // include the tail in the error message if startup fails.
  const stdio = ["ignore", "pipe", "pipe"];
  proxyProcess =
    process.platform === "win32"
      ? spawn("cmd.exe", ["/d", "/s", "/c", "npm run proxy:compat"], {
          cwd: workspaceRoot,
          stdio,
          windowsHide: true,
          env,
        })
      : spawn("npm", ["run", "proxy:compat"], {
          cwd: workspaceRoot,
          stdio,
          env,
        });

  ownsProxyProcess = true;

  const recentProxyLines = [];
  const RECENT_LINE_CAP = 40;
  const recordProxyLine = (text) => {
    for (const line of String(text).split(/\r?\n/)) {
      if (!line) continue;
      recentProxyLines.push(line);
      while (recentProxyLines.length > RECENT_LINE_CAP) recentProxyLines.shift();
    }
  };

  proxyProcess.stdout?.setEncoding("utf8");
  proxyProcess.stderr?.setEncoding("utf8");
  proxyProcess.stdout?.on("data", (chunk) => {
    recordProxyLine(chunk);
    process.stdout.write(`[compat-proxy] ${chunk}`);
  });
  proxyProcess.stderr?.on("data", (chunk) => {
    recordProxyLine(chunk);
    process.stderr.write(`[compat-proxy] ${chunk}`);
  });

  // Without this, a spawn-level error (npm not on PATH, etc.) bubbled up
  // as an uncaught exception and slammed the cmd.exe window shut before
  // the user could read it.
  proxyProcess.on("error", (err) => {
    if (exiting) return;
    console.error(`\nFailed to spawn compatibility proxy: ${err.message}`);
    cleanupAndExit(1);
  });

  proxyProcess.on("exit", (code) => {
    if (!exiting && code && code !== 0) {
      console.error(`\nCompatibility proxy exited early with code ${code}.`);
      if (recentProxyLines.length > 0) {
        console.error("Last proxy output:");
        for (const line of recentProxyLines.slice(-15)) console.error(`  ${line}`);
      } else {
        console.error("(no output captured — try `npm run proxy:compat` directly to debug)");
      }
      cleanupAndExit(code);
    }
  });

  try {
    await waitForProxy(proxyUrl, provider, modelForProvider(provider, env));
  } catch (err) {
    const tail = recentProxyLines.slice(-15).join("\n");
    const detail = tail ? `\nLast proxy output:\n${tail}` : "";
    throw new Error(`${err.message}${detail}`);
  }
}

function fetchOllamaModels(baseUrl) {
  // GET <baseUrl>/api/tags  →  { models: [{ name: "qwen3:8b" }, ...] }
  return new Promise((resolve) => {
    let target;
    try {
      target = new URL("/api/tags", baseUrl);
    } catch (err) {
      resolve({ ok: false, error: `bad OLLAMA_BASE_URL: ${err.message}` });
      return;
    }
    const req = http.get(target, (res) => {
      let body = "";
      res.setEncoding("utf8");
      res.on("data", (chunk) => {
        body += chunk;
      });
      res.on("end", () => {
        if (!res.statusCode || res.statusCode < 200 || res.statusCode >= 300) {
          resolve({ ok: false, error: `HTTP ${res.statusCode}` });
          return;
        }
        try {
          const json = JSON.parse(body);
          const models = Array.isArray(json?.models)
            ? json.models
                .map((m) => (m && typeof m.name === "string" ? m.name : ""))
                .filter((n) => n.length > 0)
            : [];
          resolve({ ok: true, models });
        } catch (err) {
          resolve({ ok: false, error: `bad JSON from /api/tags: ${err.message}` });
        }
      });
    });
    req.on("error", (err) => resolve({ ok: false, error: err.message }));
    req.setTimeout(2000, () => {
      req.destroy();
      resolve({ ok: false, error: "timeout after 2s" });
    });
  });
}

function resolveModelName(requested, installed) {
  // Exact match wins.
  if (installed.includes(requested)) return requested;
  // Then "qwen3" should resolve to e.g. "qwen3:8b" or "qwen3:latest".
  const prefixMatches = installed.filter((m) => m === requested || m.startsWith(`${requested}:`));
  if (prefixMatches.length > 0) {
    // Prefer ":latest" if present, otherwise the first prefix match.
    const latest = prefixMatches.find((m) => m === `${requested}:latest`);
    return latest || prefixMatches[0];
  }
  return null;
}

function pickPreferredModel(installed) {
  // Heuristic: prefer a qwen-family chat model if the user has one,
  // otherwise the first installed model. Tweak freely.
  const preferred = ["qwen3:latest", "qwen3", "qwen2.5:latest", "llama3.1:latest", "llama3:latest"];
  for (const name of preferred) {
    if (installed.includes(name)) return name;
  }
  const qwenAny = installed.find((m) => m.startsWith("qwen3:") || m.startsWith("qwen2.5:"));
  if (qwenAny) return qwenAny;
  return installed[0];
}

function modelForProvider(provider, env) {
  switch (provider) {
    case "gemini":
      return env.GEMINI_MODEL;
    case "groq":
      return env.GROQ_MODEL;
    case "ollama":
      return env.OLLAMA_MODEL;
    default:
      return "";
  }
}

function waitForProxy(proxyUrl, provider, model) {
  return new Promise((resolve, reject) => {
    let attempts = 0;
    const maxAttempts = 50;

    const tryOnce = async () => {
      attempts += 1;
      if (await isHealthyProxy(proxyUrl, provider, model)) {
        resolve();
        return;
      }

      if (attempts >= maxAttempts) {
        reject(new Error(`Compatibility proxy did not start on ${proxyUrl} for ${provider}:${model}.`));
        return;
      }

      setTimeout(tryOnce, 250);
    };

    void tryOnce();
  });
}

function isHealthyProxy(proxyUrl, provider, model) {
  return new Promise((resolve) => {
    const req = http.get(`${proxyUrl}/health`, (res) => {
      let body = "";
      res.setEncoding("utf8");
      res.on("data", (chunk) => {
        body += chunk;
      });
      res.on("end", () => {
        if (!res.statusCode || res.statusCode < 200 || res.statusCode >= 300) {
          resolve(false);
          return;
        }

        resolve(body.includes(`"provider":"${provider}"`) && body.includes(`"model":"${model}"`));
      });
    });

    req.on("error", () => resolve(false));
    req.setTimeout(1200, () => {
      req.destroy();
      resolve(false);
    });
  });
}

function launchBundledClient(env, forwardArgs) {
  process.on("SIGINT", () => cleanupAndExit(130));
  process.on("SIGTERM", () => cleanupAndExit(143));
  process.on("exit", () => {
    if (ownsProxyProcess && proxyProcess && !proxyProcess.killed) {
      proxyProcess.kill();
    }
  });

  const child = spawn(process.execPath, [cliPath, ...forwardArgs], {
    cwd: repoRoot,
    stdio: "inherit",
    env,
  });

  child.on("exit", (code, signal) => {
    if (signal) {
      cleanupAndExit(1);
      return;
    }
    cleanupAndExit(code ?? 0);
  });
}

function cleanupAndExit(code) {
  if (exiting) {
    return;
  }
  exiting = true;
  if (ownsProxyProcess && proxyProcess && !proxyProcess.killed) {
    proxyProcess.kill();
  }
  process.exit(code);
}
