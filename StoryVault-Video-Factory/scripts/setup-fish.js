'use strict';
// Downloads the Fish Speech S2-Pro GGUF model locally (rodrigomt/s2-pro-gguf) via
// huggingface_hub. Run with: npm run setup:fish  (also available in-app on the Fish Speech page).
const fish = require('../src/services/fishspeech');

(async () => {
  console.log(`\n  🐟 Fish Speech setup\n  Model: ${fish.REPO}\n  →      ${fish.MODEL_DIR}\n`);
  if (fish.modelPresent()) { console.log('  Model already present. Re-downloading to refresh…\n'); }
  try {
    const r = await fish.download({ onProgress: (l) => process.stdout.write(l) });
    console.log(`\n\n  ✓ Downloaded ${r.files.length} file(s) to ${r.dir}`);
    console.log('  Next: set FISH_S2_BIN to your s2 GGUF server binary (or point FISH_TTS_URL at a running Fish server), then start it from the Fish Speech page.\n');
    process.exit(0);
  } catch (e) {
    console.error(`\n  ✗ ${e.message}\n  (Ensure Python + huggingface_hub are installed: pip install -U "huggingface_hub[hf_xet]")\n`);
    process.exit(1);
  }
})();
