const fs = require("node:fs");
const http = require("node:http");
const path = require("node:path");
const { spawn } = require("node:child_process");
const readline = require("node:readline/promises");

const repoRoot = __dirname;
const workspaceRoot = path.dirname(repoRoot);
const cliPath = path.join(repoRoot, "package", "cli.js");
const brandingPatchPath = path.join(repoRoot, "patch-branding.js");
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
    env.ANTHROPIC_AUTH_TOKEN = "claw-dev-proxy";
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

  process.stdout.write("\nClaw Dev provider setup\n");
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
      env.OLLAMA_MODEL = env.OLLAMA_MODEL?.trim() || "qwen3";
      env.OLLAMA_KEEP_ALIVE = env.OLLAMA_KEEP_ALIVE?.trim() || "30m";
      process.stdout.write(`\nLaunching Ollama mode against ${env.OLLAMA_BASE_URL} with model ${env.OLLAMA_MODEL}.\n`);
      process.stdout.write(`Ollama keep-alive is set to ${env.OLLAMA_KEEP_ALIVE} for faster follow-up turns.\n`);
      process.stdout.write("Make sure Ollama is running and the model is already pulled.\n");
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

  proxyProcess =
    process.platform === "win32"
      ? spawn("cmd.exe", ["/d", "/s", "/c", "npm run proxy:compat"], {
          cwd: workspaceRoot,
          stdio: "ignore",
          windowsHide: true,
          env,
        })
      : spawn("npm", ["run", "proxy:compat"], {
          cwd: workspaceRoot,
          stdio: "ignore",
          env,
        });

  ownsProxyProcess = true;

  proxyProcess.on("exit", (code) => {
    if (!exiting && code && code !== 0) {
      console.error(`Compatibility proxy exited early with code ${code}.`);
      cleanupAndExit(code);
    }
  });

  await waitForProxy(proxyUrl, provider, modelForProvider(provider, env));
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
