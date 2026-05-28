export type ChatMessage =
  | { role: "user"; content: string }
  | { role: "assistant"; content: string };

export type SessionOptions = {
  cwd: string;
  model?: string;
};
