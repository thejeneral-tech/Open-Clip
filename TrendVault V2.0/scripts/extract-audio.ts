import ffmpeg from 'fluent-ffmpeg';
import ffmpegInstaller from '@ffmpeg-installer/ffmpeg';
import * as fs from 'fs';
import * as path from 'path';

ffmpeg.setFfmpegPath(ffmpegInstaller.path);

export function extractAudio(videoPath: string, outputDir = 'input'): Promise<string> {
  if (!fs.existsSync(outputDir)) fs.mkdirSync(outputDir, { recursive: true });
  const audioPath = path.join(outputDir, 'audio.mp3');

  if (fs.existsSync(audioPath)) {
    console.log('Using cached audio:', audioPath);
    return Promise.resolve(audioPath);
  }

  return new Promise((resolve, reject) => {
    console.log('Extracting audio from video...');
    ffmpeg(videoPath)
      .noVideo()
      .audioCodec('libmp3lame')
      .audioQuality(2)
      .save(audioPath)
      .on('progress', (p) => {
        if (p.percent) process.stdout.write(`\r  ${Math.round(p.percent)}%`);
      })
      .on('end', () => {
        console.log('\nAudio extracted:', audioPath);
        resolve(audioPath);
      })
      .on('error', (err) => {
        console.error('\nFFmpeg error:', err.message);
        reject(err);
      });
  });
}
