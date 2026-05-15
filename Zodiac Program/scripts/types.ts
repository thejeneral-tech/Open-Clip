export interface Word {
  text: string;
  start: number; // milliseconds
  end: number;   // milliseconds
  confidence?: number;
}

export interface ClipSelection {
  title: string;
  start: number; // seconds
  end: number;   // seconds
  hook: string;
  reason: string;
}

export interface ClipWithWords extends ClipSelection {
  index: number;
  words: Word[];
}
