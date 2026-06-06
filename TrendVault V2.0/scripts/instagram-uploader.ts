/**
 * Instagram Reels auto-uploader using `instagram-private-api`.
 *
 * Auth model: username + password (plus 2FA if enabled). The session state is
 * serialized to `data/instagram-session.json` so subsequent uploads skip the
 * login flow. If Instagram challenges the session ("Was this you?"), you'll
 * need to clear the session file and sign in again.
 *
 * ⚠ Uses the private mobile API. This violates Instagram's ToS — use a
 * throwaway account. Rate-limit yourself (a few uploads per day max).
 */

import { IgApiClient, IgLoginTwoFactorRequiredError, IgCheckpointError } from 'instagram-private-api';
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';
import ffmpegInstaller from '@ffmpeg-installer/ffmpeg';
import ffmpeg from 'fluent-ffmpeg';

ffmpeg.setFfmpegPath(ffmpegInstaller.path);

const ROOT = path.resolve('.');
const DATA_DIR = path.join(ROOT, 'data');
const SESSION_FILE = path.join(DATA_DIR, 'instagram-session.json');
const PENDING_2FA_FILE = path.join(DATA_DIR, 'instagram-2fa-pending.json');

export type Privacy = 'public' | 'close-friends';

export interface InstagramUploadOptions {
  videoPath: string;
  caption: string;
  shareToFeed?: boolean;
  onLog?: (line: string) => void;
}

interface SerializedSession {
  username: string;
  state: unknown;
}

interface PendingTwoFactor {
  username: string;
  twoFactorIdentifier: string;
  totpTwoFactorOn: boolean;
}

function ensureDataDir() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
}

function loadSession(): SerializedSession | null {
  if (!fs.existsSync(SESSION_FILE)) return null;
  try { return JSON.parse(fs.readFileSync(SESSION_FILE, 'utf8')); }
  catch { return null; }
}

function saveSession(s: SerializedSession) {
  ensureDataDir();
  fs.writeFileSync(SESSION_FILE, JSON.stringify(s, null, 2));
}

function loadPending2FA(): PendingTwoFactor | null {
  if (!fs.existsSync(PENDING_2FA_FILE)) return null;
  try { return JSON.parse(fs.readFileSync(PENDING_2FA_FILE, 'utf8')); }
  catch { return null; }
}

function savePending2FA(p: PendingTwoFactor) {
  ensureDataDir();
  fs.writeFileSync(PENDING_2FA_FILE, JSON.stringify(p, null, 2));
}

function clearPending2FA() {
  if (fs.existsSync(PENDING_2FA_FILE)) fs.unlinkSync(PENDING_2FA_FILE);
}

async function makeClientFromSession(session: SerializedSession): Promise<IgApiClient> {
  const ig = new IgApiClient();
  ig.state.generateDevice(session.username);
  await ig.state.deserialize(session.state as any);
  return ig;
}

async function persistState(ig: IgApiClient, username: string) {
  const state = await ig.state.serialize();
  // The serialized state contains internal fields the lib doesn't need on rehydrate
  delete (state as any).constants;
  saveSession({ username, state });
}

export interface AuthState {
  signedIn: boolean;
  username?: string;
  pending2FA?: boolean;
  error?: string;
}

export async function getAuthState(): Promise<AuthState> {
  if (loadPending2FA()) {
    return { signedIn: false, pending2FA: true, username: loadPending2FA()!.username };
  }
  const session = loadSession();
  if (!session) return { signedIn: false };
  try {
    const ig = await makeClientFromSession(session);
    const user = await ig.account.currentUser();
    return { signedIn: true, username: user.username };
  } catch (e: any) {
    return { signedIn: false, error: e?.message ?? String(e) };
  }
}

export interface SignInResult {
  ok: boolean;
  needs2FA?: boolean;
  needsCheckpoint?: boolean;
  error?: string;
}

export async function signIn(username: string, password: string): Promise<SignInResult> {
  if (!username || !password) return { ok: false, error: 'username and password required' };
  const ig = new IgApiClient();
  ig.state.generateDevice(username);
  try {
    await ig.simulate.preLoginFlow();
    await ig.account.login(username, password);
    await persistState(ig, username);
    clearPending2FA();
    return { ok: true };
  } catch (err: any) {
    if (err instanceof IgLoginTwoFactorRequiredError) {
      const info = err.response.body.two_factor_info;
      savePending2FA({
        username,
        twoFactorIdentifier: info.two_factor_identifier,
        totpTwoFactorOn: !!info.totp_two_factor_on,
      });
      // We need to persist the device state so the 2FA call uses the same client fingerprint
      await persistState(ig, username);
      return { ok: false, needs2FA: true };
    }
    if (err instanceof IgCheckpointError) {
      return { ok: false, needsCheckpoint: true, error: 'Instagram is challenging the login — open the app, confirm "Was this you?", then try again.' };
    }
    return { ok: false, error: err?.message ?? String(err) };
  }
}

export async function submitTwoFactor(code: string): Promise<SignInResult> {
  const pending = loadPending2FA();
  if (!pending) return { ok: false, error: 'no pending 2FA challenge' };
  const session = loadSession();
  if (!session) return { ok: false, error: 'session lost between login and 2FA — try again' };
  try {
    const ig = await makeClientFromSession(session);
    await ig.account.twoFactorLogin({
      username: pending.username,
      verificationCode: code.replace(/\s+/g, ''),
      twoFactorIdentifier: pending.twoFactorIdentifier,
      verificationMethod: pending.totpTwoFactorOn ? '0' : '1',
      trustThisDevice: '1',
    });
    await persistState(ig, pending.username);
    clearPending2FA();
    return { ok: true };
  } catch (err: any) {
    return { ok: false, error: err?.message ?? String(err) };
  }
}

export function signOut(): void {
  if (fs.existsSync(SESSION_FILE)) fs.unlinkSync(SESSION_FILE);
  clearPending2FA();
}

async function extractCover(videoPath: string): Promise<Buffer> {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'trendvault-cover-'));
  const coverPath = path.join(tmpDir, 'cover.jpg');
  await new Promise<void>((resolve, reject) => {
    ffmpeg(videoPath)
      .on('end', () => resolve())
      .on('error', (e) => reject(e))
      .screenshots({
        timestamps: ['00:00:00.500'],
        filename: 'cover.jpg',
        folder: tmpDir,
        size: '720x1280',
      });
  });
  const buf = fs.readFileSync(coverPath);
  try {
    fs.unlinkSync(coverPath);
    fs.rmdirSync(tmpDir);
  } catch { /* ignore */ }
  return buf;
}

export async function uploadReel(opts: InstagramUploadOptions): Promise<{ ok: true; mediaId: string; url?: string } | { ok: false; error: string }> {
  const log = opts.onLog ?? (() => {});
  if (!fs.existsSync(opts.videoPath)) return { ok: false, error: `file not found: ${opts.videoPath}` };
  const session = loadSession();
  if (!session) return { ok: false, error: 'not signed in — sign in from /instagram first' };

  try {
    log('rehydrating Instagram session');
    const ig = await makeClientFromSession(session);

    log('extracting cover frame');
    const coverImage = await extractCover(opts.videoPath);

    log(`reading video (${(fs.statSync(opts.videoPath).size / 1e6).toFixed(1)} MB)`);
    const video = fs.readFileSync(opts.videoPath);

    log('publishing Reel');
    const result: any = await ig.publish.video({
      video,
      coverImage,
      caption: (opts.caption ?? '').slice(0, 2200),
      // The lib uses these flags to mark the upload as a Reel rather than a feed video.
      // (instagram-private-api typings don't expose all of these; cast to any.)
      ...({
        toFeed: opts.shareToFeed !== false,
        isReel: true,
      } as any),
    });

    // The result shape is `{ status: 'ok', media: { id, code, ... } }`
    const media = result?.media;
    const id = media?.id ?? media?.pk?.toString() ?? 'unknown';
    const code = media?.code;
    const url = code ? `https://www.instagram.com/reel/${code}` : undefined;
    // Refresh and persist the state since the lib rotates tokens internally
    await persistState(ig, session.username);
    log(`done — id=${id}${url ? `, ${url}` : ''}`);
    return { ok: true, mediaId: id, url };
  } catch (err: any) {
    if (err instanceof IgCheckpointError) {
      return { ok: false, error: 'Instagram is challenging the session — confirm "Was this you?" in the app, then sign in again.' };
    }
    const msg = err?.text ?? err?.message ?? String(err);
    return { ok: false, error: msg };
  }
}
