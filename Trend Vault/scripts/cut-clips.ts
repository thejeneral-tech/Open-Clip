import ffmpeg from 'fluent-ffmpeg';
import ffmpegInstaller from '@ffmpeg-installer/ffmpeg';
import * as fs from 'fs';
import * as path from 'path';
import type { ClipSelection } from './types';

ffmpeg.setFfmpegPath(ffmpegInstaller.path);

function cutClip(
  videoPath: string,
  clip: ClipSelection,
  outputPath: string
): Promise<string> {
  return new Promise((resolve, reject) => {
    const dir = path.dirname(outputPath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

    ffmpeg(videoPath)
      .setStartTime(clip.start)
      .setDuration(clip.end - clip.start)
      .videoCodec('libx264')
      .audioCodec('aac')
      .outputOptions([
        '-movflags faststart',
        '-preset fast',
        '-crf 18',
        '-g 1',        // every frame is a keyframe — Remotion can seek instantly to any frame
        '-r 30',       // lock to 30fps so frame timestamps are always exact
      ])
      .save(outputPath)
      .on('end', () => resolve(outputPath))
      .on('error', reject);
  });
}

export async function cutAllClips(
  videoPath: string,
  clips: ClipSelection[],
  rawDir = 'output/raw'
): Promise<string[]> {
  const outputPaths: string[] = [];

  for (let i = 0; i < clips.length; i++) {
    const clip = clips[i];
    const num = String(i + 1).padStart(2, '0');
    const outputPath = path.join(rawDir, `clip-${num}.mp4`);

    if (fs.existsSync(outputPath)) {
      console.log(`Clip ${i + 1} already cut, skipping.`);
      outputPaths.push(outputPath);
      continue;
    }

    console.log(`Cutting clip ${i + 1}/${clips.length}: ${clip.title} (${clip.start}s–${clip.end}s)`);
    await cutClip(videoPath, clip, outputPath);
    outputPaths.push(outputPath);
  }

  return outputPaths;
}
