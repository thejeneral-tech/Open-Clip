import * as fs from 'fs';
import * as path from 'path';
import { aiComplete } from './ai-completion';
import type { ClipSelection } from './types';
import type { Transcript } from './transcribe';

export async function chooseClips(
  transcript: Transcript,
  count = 10,
  outputDir = 'output'
): Promise<ClipSelection[]> {
  if (!fs.existsSync(outputDir)) fs.mkdirSync(outputDir, { recursive: true });

  // Check cache
  const cachePath = path.join(outputDir, 'clips.json');
  if (fs.existsSync(cachePath)) {
    console.log('Using cached clip selections:', cachePath);
    return JSON.parse(fs.readFileSync(cachePath, 'utf-8')) as ClipSelection[];
  }

  // Build compact timestamped transcript — timestamp every 10th word to keep prompt manageable
  const lines: string[] = [];
  let chunk: string[] = [];
  transcript.words.forEach((w, i) => {
    if (i % 10 === 0) chunk.push(`[${(w.start / 1000).toFixed(1)}s]`);
    chunk.push(w.text);
    if (chunk.length >= 30) {
      lines.push(chunk.join(' '));
      chunk = [];
    }
  });
  if (chunk.length) lines.push(chunk.join(' '));

  const formattedTranscript = lines.join('\n');
  const totalDuration = transcript.words.at(-1)?.end ?? 0;

  const prompt = `You are an expert TikTok/Reels video editor. Analyze this timestamped transcript from a comedy compilation video and select the ${count} best clips for short-form social media.

VIDEO DURATION: ${Math.round(totalDuration / 1000)}s
TRANSCRIPT (timestamps mark position in seconds):
${formattedTranscript}

RULES:
- Each clip must be 60–120 seconds long (1–2 minutes)
- Pick complete comedic moments, reactions, or bits — nothing cut off mid-joke
- Prioritize: surprising punchlines, strong reactions, embarrassing moments, complete funny bits
- Spread clips across the whole video (don't cluster at the start)
- Each clip must stand alone without needing prior context
- Return ONLY a JSON array, nothing else

JSON FORMAT:
[
  {
    "title": "Short punchy title (5 words max)",
    "start": 123.4,
    "end": 178.9,
    "hook": "HOOK TEXT IN CAPS (6 words max)",
    "reason": "Why this will perform well"
  }
]`;

  console.log('Asking the local model to pick the best clips...');

  const { text: responseText } = await aiComplete({ user: prompt, maxTokens: 4096 });

  const jsonMatch = responseText.match(/\[[\s\S]*\]/);
  if (!jsonMatch) {
    throw new Error(`Could not parse JSON from model response:\n${responseText.slice(0, 500)}`);
  }

  const clips: ClipSelection[] = JSON.parse(jsonMatch[0]);

  // Validate and clamp
  const validated = clips.map((c) => ({
    ...c,
    start: Math.max(0, c.start),
    end: Math.min(totalDuration / 1000, c.end),
  }));

  fs.writeFileSync(cachePath, JSON.stringify(validated, null, 2));
  console.log(`${validated.length} clips selected → ${cachePath}`);
  validated.forEach((c, i) =>
    console.log(`  ${i + 1}. [${c.start}s–${c.end}s] ${c.title}`)
  );

  return validated;
}
