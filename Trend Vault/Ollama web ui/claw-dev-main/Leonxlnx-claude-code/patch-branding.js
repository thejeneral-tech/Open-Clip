const fs = require("node:fs");
const path = require("node:path");

const cliPath = path.join(__dirname, "package", "cli.js");

if (!fs.existsSync(cliPath)) {
  console.error(`Bundle not found: ${cliPath}`);
  process.exit(1);
}

let source = fs.readFileSync(cliPath, "utf8");
const original = source;

const replacements = [
  ["Welcome to Claude Code", "Welcome to Claw Dev"],
  ["Claude Code", "Claw Dev"],

  // Clawd mini mascot in the startup panel.
  ["▛███▜", "CLAWD"],
  ["▟███▟", "CLAWD"],
  ["▙███▙", "CLAWD"],
  ["█████", " DEV "],
  ["▘▘ ▝▝", "     "],

  // Larger welcome art variants.
  [" █████████ ", "  CLAWDEV  "],
  ["██▄█████▄██", " [CLAWDEV] "],
  ["█ █   █ █", " CLAW DEV "],
];

for (const [from, to] of replacements) {
  source = source.split(from).join(to);
}

if (source !== original) {
  fs.writeFileSync(cliPath, source, "utf8");
  console.log("Applied local Claw Dev branding patch.");
} else {
  console.log("Branding patch already applied or no matching strings found.");
}
