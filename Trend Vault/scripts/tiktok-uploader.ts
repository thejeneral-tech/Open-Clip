/**
 * TikTok auto-uploader using Playwright.
 *
 * Auth model: a Chromium persistent context is stored in `<ROOT>/.tiktok-session/`.
 * Call `loginInteractive()` once — a headed browser opens, you sign in by hand,
 * then close it. Subsequent `uploadVideo()` calls reuse the saved session.
 *
 * Selectors target https://www.tiktok.com/tiktokstudio/upload. They WILL drift
 * when TikTok ships UI changes — adjust below when something stops working.
 */

import { chromium, type BrowserContext, type Page } from 'playwright';
import * as path from 'path';
import * as fs from 'fs';

const ROOT = path.resolve('.');
const SESSION_DIR = path.join(ROOT, '.tiktok-session');
const UPLOAD_URL = 'https://www.tiktok.com/tiktokstudio/upload?from=upload';

export type Privacy = 'public' | 'friends' | 'private';
export type UploadMode = 'direct' | 'draft';

export interface UploadOptions {
  videoPath: string;
  caption: string;
  privacy: Privacy;
  mode: UploadMode;
  onLog?: (line: string) => void;
}

function ensureSessionDir() {
  if (!fs.existsSync(SESSION_DIR)) fs.mkdirSync(SESSION_DIR, { recursive: true });
}

async function openContext(headless: boolean): Promise<BrowserContext> {
  ensureSessionDir();
  return chromium.launchPersistentContext(SESSION_DIR, {
    headless,
    viewport: { width: 1280, height: 900 },
    args: ['--disable-blink-features=AutomationControlled'],
  });
}

export async function loginInteractive(timeoutMs = 5 * 60 * 1000): Promise<void> {
  const ctx = await openContext(false);
  const page = await ctx.newPage();
  await page.goto('https://www.tiktok.com/login');
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const cookies = await ctx.cookies('https://www.tiktok.com');
    if (cookies.some((c) => c.name === 'sessionid' || c.name === 'sid_tt')) break;
    await page.waitForTimeout(2000);
  }
  await ctx.close();
}

export async function isLoggedIn(): Promise<boolean> {
  if (!fs.existsSync(SESSION_DIR)) return false;
  const ctx = await openContext(true);
  try {
    const cookies = await ctx.cookies('https://www.tiktok.com');
    return cookies.some((c) => c.name === 'sessionid' || c.name === 'sid_tt');
  } finally {
    await ctx.close();
  }
}

async function findUploadFrame(page: Page) {
  for (const frame of page.frames()) {
    const input = await frame.$('input[type="file"]');
    if (input) return { frame, input };
  }
  return null;
}

async function setCaption(page: Page, caption: string, log: (s: string) => void) {
  const editor = page
    .locator('div[contenteditable="true"]')
    .filter({ has: page.locator('*') })
    .last();
  await editor.waitFor({ state: 'visible', timeout: 30_000 });
  await editor.click();
  await page.keyboard.press('Control+A');
  await page.keyboard.press('Delete');
  for (const token of tokenize(caption)) {
    if (token.startsWith('#') || token.startsWith('@')) {
      await page.keyboard.type(token, { delay: 25 });
      await page.waitForTimeout(800);
      await page.keyboard.press('Escape');
      await page.keyboard.type(' ');
    } else {
      await page.keyboard.type(token, { delay: 10 });
    }
  }
  log('caption set');
}

function tokenize(s: string): string[] {
  const out: string[] = [];
  const re = /(\s+|[#@][\w._-]+|[^\s#@]+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(s)) !== null) out.push(m[1]);
  return out;
}

async function setPrivacy(page: Page, privacy: Privacy, log: (s: string) => void) {
  if (privacy === 'public') return;
  const wanted = privacy === 'friends' ? /^Friends$/ : /^Only you$/;
  const trigger = page.getByText(/Who can watch this video/i).first();
  if (!(await trigger.isVisible().catch(() => false))) {
    log('privacy selector not found (UI may have changed) — leaving default');
    return;
  }
  await trigger.click();
  const option = page.getByRole('option', { name: wanted }).first();
  if (await option.isVisible().catch(() => false)) {
    await option.click();
    log(`privacy → ${privacy}`);
  } else {
    log(`privacy option for ${privacy} not visible — leaving default`);
  }
}

async function clickPost(page: Page, mode: UploadMode, log: (s: string) => void) {
  if (mode === 'draft') {
    const btn = page.getByRole('button', { name: /Save\s*draft/i }).first();
    await btn.waitFor({ state: 'visible', timeout: 60_000 });
    await btn.click();
    log('clicked Save draft');
  } else {
    const btn = page.getByRole('button', { name: /^Post$/ }).first();
    await btn.waitFor({ state: 'visible', timeout: 60_000 });
    await btn.click();
    log('clicked Post');
  }
}

export async function uploadVideo(opts: UploadOptions): Promise<{ ok: true } | { ok: false; error: string }> {
  const log = opts.onLog ?? (() => {});
  if (!fs.existsSync(opts.videoPath)) return { ok: false, error: `file not found: ${opts.videoPath}` };

  const headless = process.env.TIKTOK_HEADLESS === '1';
  const ctx = await openContext(headless);
  const keepOpen = process.env.DEBUG_TIKTOK === '1';
  const page = await ctx.newPage();

  try {
    log(`navigating to ${UPLOAD_URL}`);
    await page.goto(UPLOAD_URL, { waitUntil: 'domcontentloaded' });

    log('waiting for upload control');
    let attempt: { frame: any; input: any } | null = null;
    const deadline = Date.now() + 45_000;
    while (Date.now() < deadline) {
      attempt = await findUploadFrame(page);
      if (attempt) break;
      await page.waitForTimeout(500);
    }
    if (!attempt) return { ok: false, error: 'upload page did not load (are you signed in?)' };

    log(`attaching file: ${path.basename(opts.videoPath)}`);
    await attempt.input.setInputFiles(opts.videoPath);

    log('waiting for upload to process (caption editor appears when ready)');
    await page
      .locator('div[contenteditable="true"]')
      .last()
      .waitFor({ state: 'visible', timeout: 5 * 60_000 });

    await setCaption(page, opts.caption, log);
    await setPrivacy(page, opts.privacy, log);

    await waitForUploadComplete(page, log);

    await clickPost(page, opts.mode, log);

    log('waiting for confirmation');
    const confirmed = await Promise.race([
      page.getByText(/Your video has been uploaded|Posted|saved to drafts/i).first().waitFor({ timeout: 90_000 }).then(() => true).catch(() => false),
      page.waitForURL(/\/tiktokstudio\/content|\/upload\?from=upload/, { timeout: 90_000 }).then(() => true).catch(() => false),
    ]);
    if (!confirmed) return { ok: false, error: 'no confirmation received within 90s — check TikTok manually' };

    log('done');
    return { ok: true };
  } catch (err: any) {
    return { ok: false, error: err?.message ?? String(err) };
  } finally {
    if (!keepOpen) await ctx.close();
  }
}

async function waitForUploadComplete(page: Page, log: (s: string) => void) {
  const deadline = Date.now() + 10 * 60_000;
  let lastPct = -1;
  while (Date.now() < deadline) {
    const txt = await page.locator('body').innerText().catch(() => '');
    const m = txt.match(/(\d{1,3})\s*%/);
    if (m) {
      const pct = parseInt(m[1], 10);
      if (pct !== lastPct) {
        log(`upload progress: ${pct}%`);
        lastPct = pct;
      }
      if (pct >= 100) return;
    }
    const postBtn = page.getByRole('button', { name: /^Post$/ }).first();
    if (await postBtn.isEnabled().catch(() => false)) return;
    await page.waitForTimeout(1500);
  }
  log('upload-complete check timed out — proceeding anyway');
}
