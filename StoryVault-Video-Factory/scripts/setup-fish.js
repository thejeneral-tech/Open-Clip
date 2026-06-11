'use strict';
// Downloads the Fish Speech S2-Pro GGUF model locally (rodrigomt/s2-pro-gguf) via
// huggingface_hub. Run with: npm run setup:fish  (also available in-app on the Fish Speech page).
// Pass --force to re-download even when a model is already present.
const fish = require('../src/services/fishspeech');

const argv = process.argv.slice(2);
const force = argv.includes('--force');
const quant = argv.find((a) => !a.startsWith('--')) || fish.DEFAULT_QUANT; // e.g. npm run setup:fish q2_k
(async () => {
  console.log(`\n  🐟 Fish Speech setup\n  Model: ${fish.REPO}  (quant ${quant})\n  →      ${fish.getModelDir()}\n`);
  // Skip the multi-GB download when a model is already present. Re-downloading on
  // every Repair/Download click is what froze the launcher: its GUI thread blocks
  // for the WHOLE download. Use --force to deliberately re-fetch a corrupt model.
  if (fish.modelPresent() && !force) {
    console.log('  A GGUF is already present — nothing to download. (Pass --force to re-download.)\n');
    process.exit(0);
  }
  try {
    const r = await fish.download({ quant, onProgress: (l) => process.stdout.write(l) });
    console.log(`\n\n  ✓ Downloaded quant ${r.quant} to ${r.dir}`);
    console.log('  Next: build the s2.cpp engine (Voice Lab → Setup → "Build engine", needs CMake + a C++ compiler)\n  or set the path to a prebuilt s2 binary there. Narration falls back to SAPI until the engine is ready.\n');
    process.exit(0);
  } catch (e) {
    console.error(`\n  ✗ ${e.message}\n  (Ensure Python + huggingface_hub are installed: pip install -U "huggingface_hub[hf_xet]")\n`);
    process.exit(1);
  }
})();
