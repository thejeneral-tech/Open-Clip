// Fallback clip selector — no API needed.
// Divides the video into N equal sections and picks the highest word-density
// window from each section (fast talking = high-energy moment).
import * as fs from 'fs';
import * as path from 'path';
import type { ClipSelection } from './types';
import type { Transcript } from './transcribe';

const TARGET_DURATION = 90; // seconds per clip
const MIN_GAP = 30;         // min seconds between clips

function scoreWindow(words: Transcript['words'], startMs: number, endMs: number): number {
  const inWindow = words.filter((w) => w.start >= startMs && w.end <= endMs);
  const durationSec = (endMs - startMs) / 1000;
  if (durationSec === 0) return 0;
  // Words-per-second as base score
  const wps = inWindow.length / durationSec;
  // Bonus for consistent speech (low gap ratio)
  const totalSpeechMs = inWindow.reduce((acc, w) => acc + (w.end - w.start), 0);
  const speechRatio = totalSpeechMs / (endMs - startMs);
  return wps * (0.5 + speechRatio * 0.5);
}

export function chooseClipsHeuristic(
  transcript: Transcript,
  count = 10,
  outputDir = 'output'
): ClipSelection[] {
  if (!fs.existsSync(outputDir)) fs.mkdirSync(outputDir, { recursive: true });

  const totalMs = transcript.words.at(-1)?.end ?? 0;
  const totalSec = totalMs / 1000;
  const stepSec = totalSec / count;
  const windowSec = TARGET_DURATION;
  const slideSec = 5; // slide resolution

  const clips: ClipSelection[] = [];

  for (let section = 0; section < count; section++) {
    const sectionStart = section * stepSec;
    const sectionEnd = sectionStart + stepSec;

    let bestScore = -1;
    let bestStart = sectionStart;

    // Slide a window through this section
    for (let s = sectionStart; s + windowSec <= sectionEnd; s += slideSec) {
      const score = scoreWindow(transcript.words, s * 1000, (s + windowSec) * 1000);
      if (score > bestScore) {
        bestScore = score;
        bestStart = s;
      }
    }

    const start = Math.round(bestStart * 10) / 10;
    const end = Math.round((bestStart + windowSec) * 10) / 10;

    // Avoid overlap with previous clip
    const prev = clips.at(-1);
    if (prev && start < prev.end + MIN_GAP) continue;

    clips.push({
      title: `Clip ${section + 1}`,
      start,
      end,
      hook: `FUNNY MOMENT #${section + 1}`,
      reason: `Highest energy window in section ${section + 1}`,
    });
  }

  const outputPath = path.join(outputDir, 'clips.json');
  fs.writeFileSync(outputPath, JSON.stringify(clips, null, 2));
  console.log(`${clips.length} clips selected (heuristic) → ${outputPath}`);
  clips.forEach((c, i) =>
    console.log(`  ${i + 1}. [${c.start}s–${c.end}s] ${c.title}`)
  );

  return clips;
}
