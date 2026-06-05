/**
 * Automation Map — file I/O helpers (ported from lib/storage.ts).
 * Browser download, file read, clipboard, and import-file validation.
 */

export const APP_ID = 'trendvault-automation-map';
/** Older exports (and files from the original CodeFlow Canvas) use this id. */
const LEGACY_APP_ID = 'codeflow-canvas';

/** Trigger a browser download of a text payload. */
export function triggerDownload(filename, content, mime = 'text/plain') {
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
export function readTextFile(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result ?? ''));
    reader.onerror = () => reject(reader.error);
    reader.readAsText(file);
  });
}

/** Copy text to the clipboard, resolving to whether it succeeded. */
export async function copyToClipboard(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    // Fallback for non-secure contexts.
    try {
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
      const ok = document.execCommand('copy');
      document.body.removeChild(ta);
      return ok;
    } catch {
      return false;
    }
  }
}

/** Validate & normalize an imported workflow file. Throws on bad input. */
export function parseWorkflowFile(raw) {
  const data = JSON.parse(raw);
  if (!data || typeof data !== 'object') throw new Error('Not a valid workflow file.');
  if (data.app && data.app !== APP_ID && data.app !== LEGACY_APP_ID) {
    // Not fatal — accept anything with nodes/edges — but guard obvious mistakes.
  }
  if (!Array.isArray(data.nodes) || !Array.isArray(data.edges)) {
    throw new Error('Workflow file is missing nodes or edges.');
  }
  return {
    app: APP_ID,
    version: typeof data.version === 'number' ? data.version : 1,
    exportedAt: typeof data.exportedAt === 'string' ? data.exportedAt : '',
    nodes: data.nodes,
    edges: data.edges,
    spaces: Array.isArray(data.spaces) ? data.spaces : [],
  };
}
