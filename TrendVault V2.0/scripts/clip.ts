import * as dotenv from 'dotenv';
dotenv.config({ override: true });
import * as fs from 'fs';
import { extractAudio } from './extract-audio';
import { transcribeAudio } from './transcribe';
import { chooseClips } from './choose-clips';
import { chooseClipsHeuristic } from './choose-clips-heuristic';
import { cutAllClips } from './cut-clips';
import { renderAllClips } from './render-clips';

// When launched by the web server the video path and output folder are passed
// via environment variables (safe: env vars bypass cmd.exe shell splitting).
// When run manually via "npm run clip path/to/video.mp4" process.argv is used.
const VIDEO_PATH =
  process.env.CLIP_FACTORY_VIDEO ??
  process.argv[2];

if (!VIDEO_PATH) {
  console.error('Error: No video file specified.');
  console.error('Usage:  npm run clip "path/to/video.mp4"');
  console.error('   or:  npx tsx scripts/clip.ts "path/to/video.mp4"');
  process.exit(1);
}

const OUTPUT_SUBFOLDER =
  process.env.CLIP_FACTORY_FOLDER ??
  process.argv[3] ??
  '';

const FINAL_DIR = OUTPUT_SUBFOLDER
  ? `output/final/${OUTPUT_SUBFOLDER}`
  : 'output/final';

async function main() {
  console.log('=== YouTube Clip Factory ===\n');
  console.log('Video:', VIDEO_PATH);

  if (!fs.existsSync(VIDEO_PATH)) {
    throw new Error(`Video file not found: ${VIDEO_PATH}`);
  }

  // Step 1: Extract audio
  const audioPath = await extractAudio(VIDEO_PATH);

  // Step 2: Transcribe
  const transcript = await transcribeAudio(audioPath);
  console.log(`Transcript: ${transcript.words.length} words, ~${Math.round((transcript.words.at(-1)?.end ?? 0) / 60000)} min\n`);

  // Step 3: Pick the best 10 clips (local model if reachable, heuristic otherwise)
  let clips;
  try {
    clips = await chooseClips(transcript, 10);
  } catch (err: any) {
    console.warn('Local model unavailable — using heuristic clip selector instead.');
    console.warn('  reason:', err?.message || err);
    clips = chooseClipsHeuristic(transcript, 10);
  }
  console.log();

  // Step 4: Cut raw clips with FFmpeg
  console.log('Cutting clips...');
  const rawPaths = await cutAllClips(VIDEO_PATH, clips);
  console.log();

  // Step 5: Render vertical clips with Remotion
  console.log('Rendering vertical clips with captions...');
  await renderAllClips(rawPaths, clips, transcript, FINAL_DIR);

  console.log('\n✓ Done! Final clips are in output/final/');
  clips.forEach((c, i) => {
    const num = String(i + 1).padStart(2, '0');
    console.log(`  clip-${num}.mp4  ${c.title}`);
  });
}

main().catch((err) => {
  console.error('\nError:', err.message);
  process.exit(1);
});
