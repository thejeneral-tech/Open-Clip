import { exec } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";

const execAsync = promisify(exec);

export type ToolDefinition = {
  name: string;
  description: string;
  input_schema: {
    type: "object";
    properties: Record<string, unknown>;
    required?: string[];
  };
};

export type ToolResult = {
  isError?: boolean;
  content: string;
};

export type ToolHandler = (input: Record<string, unknown>, cwd: string) => Promise<ToolResult>;

function resolveWithinCwd(cwd: string, maybeRelative: string): string {
  const resolved = path.resolve(cwd, maybeRelative);
  if (!resolved.startsWith(path.resolve(cwd))) {
    throw new Error(`Path escapes working directory: ${maybeRelative}`);
  }
  return resolved;
}

async function listFiles(input: Record<string, unknown>, cwd: string): Promise<ToolResult> {
  const target = typeof input.path === "string" ? input.path : ".";
  const fullPath = resolveWithinCwd(cwd, target);
  const entries = await fs.readdir(fullPath, { withFileTypes: true });
  const lines = entries
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((entry) => `${entry.isDirectory() ? "dir " : "file"} ${entry.name}`);
  return {
    content: lines.length > 0 ? lines.join("\n") : "(empty directory)",
  };
}

async function readFile(input: Record<string, unknown>, cwd: string): Promise<ToolResult> {
  if (typeof input.path !== "string") {
    throw new Error("path is required");
  }
  const fullPath = resolveWithinCwd(cwd, input.path);
  const content = await fs.readFile(fullPath, "utf8");
  return { content };
}

async function writeFile(input: Record<string, unknown>, cwd: string): Promise<ToolResult> {
  if (typeof input.path !== "string") {
    throw new Error("path is required");
  }
  if (typeof input.content !== "string") {
    throw new Error("content is required");
  }
  const fullPath = resolveWithinCwd(cwd, input.path);
  await fs.mkdir(path.dirname(fullPath), { recursive: true });
  await fs.writeFile(fullPath, input.content, "utf8");
  return { content: `Wrote ${input.path}` };
}

async function searchText(input: Record<string, unknown>, cwd: string): Promise<ToolResult> {
  if (typeof input.query !== "string" || input.query.length === 0) {
    throw new Error("query is required");
  }
  const target = typeof input.path === "string" ? input.path : ".";
  const fullPath = resolveWithinCwd(cwd, target);
  const result = await execAsync(`rg -n --hidden --glob "!node_modules" --glob "!dist" ${JSON.stringify(input.query)} ${JSON.stringify(fullPath)}`, {
    cwd,
    windowsHide: true,
    maxBuffer: 1024 * 1024,
  }).catch((error: { stdout?: string; stderr?: string }) => ({
    stdout: error.stdout ?? "",
    stderr: error.stderr ?? "",
  }));
  const content = result.stdout?.trim() || result.stderr?.trim() || "(no matches)";
  return { content };
}

async function runShell(input: Record<string, unknown>, cwd: string): Promise<ToolResult> {
  if (typeof input.command !== "string" || input.command.length === 0) {
    throw new Error("command is required");
  }
  const { stdout, stderr } = await execAsync(input.command, {
    cwd,
    shell: "powershell.exe",
    windowsHide: true,
    maxBuffer: 1024 * 1024,
  });
  const content = [stdout.trim(), stderr.trim()].filter(Boolean).join("\n");
  return { content: content || "(command produced no output)" };
}

export const toolDefinitions: ToolDefinition[] = [
  {
    name: "list_files",
    description: "List files and directories inside a path relative to the current workspace.",
    input_schema: {
      type: "object",
      properties: {
        path: { type: "string", description: "Relative path to inspect." },
      },
    },
  },
  {
    name: "read_file",
    description: "Read a UTF-8 text file from the workspace.",
    input_schema: {
      type: "object",
      properties: {
        path: { type: "string", description: "Relative file path." },
      },
      required: ["path"],
    },
  },
  {
    name: "write_file",
    description: "Write a UTF-8 text file inside the workspace.",
    input_schema: {
      type: "object",
      properties: {
        path: { type: "string", description: "Relative file path." },
        content: { type: "string", description: "Full file content." },
      },
      required: ["path", "content"],
    },
  },
  {
    name: "search_text",
    description: "Search for text using ripgrep in the workspace.",
    input_schema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Search text." },
        path: { type: "string", description: "Optional relative path to narrow the search." },
      },
      required: ["query"],
    },
  },
  {
    name: "run_shell",
    description: "Run a PowerShell command in the current workspace and capture stdout and stderr.",
    input_schema: {
      type: "object",
      properties: {
        command: { type: "string", description: "PowerShell command to execute." },
      },
      required: ["command"],
    },
  },
];

export const toolHandlers: Record<string, ToolHandler> = {
  list_files: listFiles,
  read_file: readFile,
  write_file: writeFile,
  search_text: searchText,
  run_shell: runShell,
};
