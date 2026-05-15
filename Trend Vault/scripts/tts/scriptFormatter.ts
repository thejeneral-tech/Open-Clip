// Approximate words per second at different speech rates
const WORDS_PER_SECOND_BASE = 2.8;

export function formatScript(text: string): string {
  return text
    // Ensure ellipsis pauses after sentences
    .replace(/\.\s+/g, '... ')
    .replace(/!\s+/g, '! ')
    .replace(/\?\s+/g, '? ')
    // Add slight pause after commas
    .replace(/,\s+/g, ', ')
    // Trim double spaces
    .replace(/\s{2,}/g, ' ')
    .trim();
}

export function truncateForPreview(text: string, maxSeconds = 12, speedMultiplier = 1.0): string {
  const wps = WORDS_PER_SECOND_BASE * speedMultiplier;
  const maxWords = Math.ceil(wps * maxSeconds);
  const words = text.split(/\s+/);
  if (words.length <= maxWords) return text;
  return words.slice(0, maxWords).join(' ') + '...';
}

export function estimateDuration(text: string, speedMultiplier = 1.0): number {
  const words = text.split(/\s+/).length;
  return words / (WORDS_PER_SECOND_BASE * speedMultiplier);
}
