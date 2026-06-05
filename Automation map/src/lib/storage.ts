import type { WorkflowFile } from '@/types';

export const STORAGE_KEY = 'codeflow-canvas-v1';

/** Trigger a browser download of a text payload. */
export function triggerDownload(
  filename: string,
  content: string,
  mime = 'text/plain',
): void {
  const blob = new Blob([content], { type: `${mime};charset=utf-8` });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

/** Read a user-selected file as text. */
export function readTextFile(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result ?? ''));
    reader.onerror = () => reject(reader.error);
    reader.readAsText(file);
  });
}

/** Copy text to the clipboard, resolving to whether it succeeded. */
export async function copyToClipboard(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}

/** Validate & normalize an imported workflow file. Throws on bad input. */
export function parseWorkflowFile(raw: string): WorkflowFile {
  const data = JSON.parse(raw);
  if (!data || typeof data !== 'object') throw new Error('Not a valid workflow file.');
  if (!Array.isArray(data.nodes) || !Array.isArray(data.edges)) {
    throw new Error('Workflow file is missing nodes or edges.');
  }
  return {
    app: 'codeflow-canvas',
    version: typeof data.version === 'number' ? data.version : 1,
    exportedAt: typeof data.exportedAt === 'string' ? data.exportedAt : '',
    nodes: data.nodes,
    edges: data.edges,
    spaces: Array.isArray(data.spaces) ? data.spaces : [],
  };
}
