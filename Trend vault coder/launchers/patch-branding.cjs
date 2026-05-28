const fs = require("node:fs");
const path = require("node:path");

// The bundled CLI lives under <repo>/vendor/claude-code-bundle/cli.js.
// (`__dirname` here is <repo>/launchers/.) An older revision pointed at
// `launchers/package/cli.js`, which never existed and caused
// `trendvault-coder-launcher.cjs` to die with exit(1) on every platform
// because it `require()`s this file on every CLI launch.
const cliPath = path.resolve(__dirname, "..", "vendor", "claude-code-bundle", "cli.js");

if (!fs.existsSync(cliPath)) {
  // No bundled CLI to patch — leave silently so the launcher can still try
  // to invoke whatever `cli.js` was passed via env / arg. Hard-exiting here
  // would kill the launcher process before it ever runs the CLI.
  console.warn(`Branding patch skipped — bundle not found at ${cliPath}.`);
} else {
  let source = fs.readFileSync(cliPath, "utf8");
  const original = source;

  const replacements = [
    ["Welcome to Claude Code", "Welcome to TrendVault Coder"],
    ["Claude Code", "TrendVault Coder"],

    // Mini mascot in the startup panel.
    ["▛███▜", "TREND"],
    ["▟███▟", "VAULT"],
    ["▙███▙", "CODER"],
    ["█████", "     "],
    ["▘▘ ▝▝", "     "],

    // Larger welcome art variants.
    [" █████████ ", " TRENDVAULT"],
    ["██▄█████▄██", " [TRENDVLT] "],
    ["█ █   █ █", "TRENDVAULT"],
  ];

  for (const [from, to] of replacements) {
    source = source.split(from).join(to);
  }

  if (source !== original) {
    fs.writeFileSync(cliPath, source, "utf8");
    console.log("Applied local TrendVault Coder branding patch.");
  } else {
    console.log("Branding patch already applied or no matching strings found.");
  }
}
