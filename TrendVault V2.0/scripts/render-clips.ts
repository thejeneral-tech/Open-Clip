import * as fs from 'fs';
import * as path from 'path';
import { bundle } from '@remotion/bundler';
import { renderMedia, selectComposition } from '@remotion/renderer';
import { enableTailwind } from '@remotion/tailwind-v4';
import type { ClipSelection, Word } from './types';
import type { Transcript } from './transcribe';

const CLIP_NAME = 'current-clip.mp4';

// ── Concurrency: 1 on Windows ────────────────────────────────────────────────
// Each Remotion render opens a headless Chrome tab that holds the all-keyframe
// source video file open. At concurrency 2, Windows hits EMFILE (too many open
// file descriptors) around clip 4-5. Concurrency 1 = one Chrome tab at a time,
// keeps fd usage well within Windows limits for all 10 clips.
const CONCURRENCY = 1;

// Milliseconds to wait between clip renders so Chrome can fully exit and
// release all file handles before the next render starts.
const BETWEEN_CLIP_COOLDOWN_MS = 6000;

function sleep(ms: number) { return new Promise<void>(r => setTimeout(r, ms)); }

function getClipWords(allWords: Word[], clipStartMs: number, clipEndMs: number): Word[] {
  return allWords
    .filter((w) => w.start >= clipStartMs - 500 && w.end <= clipEndMs + 500)
    .map((w) => ({
      ...w,
      start: Math.max(0, w.start - clipStartMs),
      end: Math.max(0, w.end - clipStartMs),
    }));
}

export async function renderAllClips(
  rawPaths: string[],
  clips: ClipSelection[],
  transcript: Transcript,
  finalDir = path.resolve('./output/final')
): Promise<void> {
  if (!fs.existsSync(finalDir)) fs.mkdirSync(finalDir, { recursive: true });

  console.log(`\nBundling Remotion project (one-time)... [concurrency: ${CONCURRENCY}]`);
  const bundleLocation = await bundle({
    entryPoint: path.resolve('./src/index.ts'),
    webpackOverride: enableTailwind,
    publicDir: path.resolve('./public'),
  });
  const bundlePublicDir = path.join(bundleLocation, 'public');
  if (!fs.existsSync(bundlePublicDir)) fs.mkdirSync(bundlePublicDir, { recursive: true });
  console.log('Bundle ready.\n');

  for (let i = 0; i < rawPaths.length; i++) {
    const rawPath  = rawPaths[i];
    const clip     = clips[i];
    const num      = String(i + 1).padStart(2, '0');
    const outputPath = path.join(finalDir, `clip-${num}.mp4`);

    if (fs.existsSync(outputPath)) {
      console.log(`Clip ${i + 1} already rendered, skipping.`);
      continue;
    }

    // Give previous render's Chrome processes time to fully exit and release
    // their file descriptors before we start the next render.
    if (i > 0) {
      console.log(`Cooling down ${BETWEEN_CLIP_COOLDOWN_MS / 1000}s (releasing file handles)...`);
      await sleep(BETWEEN_CLIP_COOLDOWN_MS);
    }

    const clipStartMs      = clip.start * 1000;
    const clipEndMs        = clip.end * 1000;
    const clipWords        = getClipWords(transcript.words, clipStartMs, clipEndMs);
    const durationInSeconds = clip.end - clip.start;

    const publicClipPath = path.join(bundlePublicDir, CLIP_NAME);
    fs.copyFileSync(rawPath, publicClipPath);

    try {
      const inputProps = {
        clipName: CLIP_NAME,
        words: clipWords,
        hookText: clip.hook,
        title: clip.title,
        durationInSeconds,
      };

      const composition = await selectComposition({
        serveUrl: bundleLocation,
        id: 'ClipVideo',
        inputProps,
      });

      console.log(`Rendering ${i + 1}/${rawPaths.length}: ${clip.title}`);

      await renderMedia({
        composition,
        serveUrl: bundleLocation,
        codec: 'h264',
        outputLocation: outputPath,
        inputProps,
        // JPEG frames are ~3-4x faster than PNG with no visible quality loss on TikTok
        imageFormat: 'jpeg',
        jpegQuality: 90,
        concurrency: CONCURRENCY,
        // Fast encoder — still great quality, TikTok recompresses anyway
        x264Preset: 'veryfast',
        // CRF 23 is standard "high quality" and plenty for TikTok
        crf: 23,
        onProgress: ({ progress }) => {
          process.stdout.write(`\r  ${Math.round(progress * 100)}%`);
        },
      });

      console.log(`\n  → ${outputPath}`);
    } finally {
      if (fs.existsSync(publicClipPath)) fs.unlinkSync(publicClipPath);
    }
  }

  console.log(`\nAll clips rendered to ${finalDir}`);
}
