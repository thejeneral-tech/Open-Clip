import { AssemblyAI } from 'assemblyai';
import * as fs from 'fs';
import * as path from 'path';
import type { Word } from './types';

export interface Transcript {
  text: string;
  words: Word[];
}

export async function transcribeAudio(
  audioPath: string,
  outputDir = 'transcripts'
): Promise<Transcript> {
  const apiKey = process.env.ASSEMBLYAI_API_KEY;
  if (!apiKey) throw new Error('ASSEMBLYAI_API_KEY not set in .env');

  if (!fs.existsSync(outputDir)) fs.mkdirSync(outputDir, { recursive: true });

  const cachePath = path.join(outputDir, 'video.json');
  if (fs.existsSync(cachePath)) {
    console.log('Using cached transcript:', cachePath);
    return JSON.parse(fs.readFileSync(cachePath, 'utf-8')) as Transcript;
  }

  const client = new AssemblyAI({ apiKey });

  console.log('Uploading audio to AssemblyAI...');
  console.log('(This may take several minutes for a long video)');

  const result = await client.transcripts.transcribe({
    audio: audioPath,
    speech_models: ['universal-2'],
  } as any);

  if (result.status === 'error') {
    throw new Error(`Transcription failed: ${result.error}`);
  }

  const transcript: Transcript = {
    text: result.text ?? '',
    words: (result.words ?? []).map((w) => ({
      text: w.text,
      start: w.start,
      end: w.end,
      confidence: w.confidence ?? 1,
    })),
  };

  fs.writeFileSync(cachePath, JSON.stringify(transcript, null, 2));
  console.log(`Transcript saved: ${cachePath} (${transcript.words.length} words)`);

  return transcript;
}
