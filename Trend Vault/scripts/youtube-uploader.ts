/**
 * YouTube Shorts uploader — official YouTube Data API v3 + OAuth 2.0.
 *
 * One-time setup (Google Cloud Console):
 *   1. Create / pick a project at https://console.cloud.google.com
 *   2. Enable "YouTube Data API v3" in APIs & Services → Library.
 *   3. Configure OAuth consent screen (External, add yourself as a test user).
 *   4. Create OAuth 2.0 Client ID → "Web application" type
 *      → Authorized redirect URI: http://localhost:3001/api/youtube/oauth-callback
 *   5. Download the JSON → save it to data/youtube-credentials.json
 *
 * After that, the /youtube page handles the sign-in flow and stores a refresh
 * token in data/youtube-token.json. Uploads use youtube.videos.insert with
 * #Shorts appended to the description so YT classifies the video as a Short
 * (you also need the source MP4 to be vertical and ≤ 180 s).
 */

import { google } from 'googleapis';
import type { OAuth2Client } from 'google-auth-library';
import * as path from 'path';
import * as fs from 'fs';

const ROOT = path.resolve('.');
const DATA_DIR = path.join(ROOT, 'data');
const CRED_FILE = path.join(DATA_DIR, 'youtube-credentials.json');
const TOKEN_FILE = path.join(DATA_DIR, 'youtube-token.json');
const SCOPES = [
  'https://www.googleapis.com/auth/youtube.upload',
  'https://www.googleapis.com/auth/youtube.readonly',
];

export type Privacy = 'public' | 'unlisted' | 'private';

export interface YouTubeUploadOptions {
  videoPath: string;
  title: string;
  description: string;
  tags?: string[];
  privacy: Privacy;
  madeForKids?: boolean;
  onLog?: (line: string) => void;
}

interface CredFile {
  client_id: string;
  client_secret: string;
  redirect_uri: string;
}

function loadCredentials(): CredFile | null {
  if (!fs.existsSync(CRED_FILE)) return null;
  try {
    const raw = JSON.parse(fs.readFileSync(CRED_FILE, 'utf8'));
    // Google downloads JSON shaped as { web: {...} } or { installed: {...} }
    const c = raw.web ?? raw.installed ?? raw;
    if (!c.client_id || !c.client_secret) return null;
    const redirect_uri = Array.isArray(c.redirect_uris)
      ? c.redirect_uris[0]
      : c.redirect_uri ?? 'http://localhost:3001/api/youtube/oauth-callback';
    return { client_id: c.client_id, client_secret: c.client_secret, redirect_uri };
  } catch {
    return null;
  }
}

function makeOAuthClient(): OAuth2Client {
  const c = loadCredentials();
  if (!c) throw new Error(`Missing ${path.relative(ROOT, CRED_FILE)} — download OAuth client JSON from Google Cloud Console first`);
  return new google.auth.OAuth2(c.client_id, c.client_secret, c.redirect_uri);
}

function loadToken(): any | null {
  if (!fs.existsSync(TOKEN_FILE)) return null;
  try { return JSON.parse(fs.readFileSync(TOKEN_FILE, 'utf8')); }
  catch { return null; }
}

function saveToken(token: any) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(TOKEN_FILE, JSON.stringify(token, null, 2));
}

export function getRedirectUri(): string {
  const c = loadCredentials();
  return c?.redirect_uri ?? 'http://localhost:3001/api/youtube/oauth-callback';
}

export interface AuthState {
  configured: boolean;
  signedIn: boolean;
  channel?: string;
  channelId?: string;
  error?: string;
}

export async function getAuthState(): Promise<AuthState> {
  if (!loadCredentials()) return { configured: false, signedIn: false };
  const tok = loadToken();
  if (!tok || !tok.refresh_token) return { configured: true, signedIn: false };
  try {
    const oauth = makeOAuthClient();
    oauth.setCredentials(tok);
    const yt = google.youtube({ version: 'v3', auth: oauth });
    const r = await yt.channels.list({ part: ['snippet'], mine: true });
    const ch = r.data.items?.[0];
    return {
      configured: true,
      signedIn: true,
      channel: ch?.snippet?.title ?? undefined,
      channelId: ch?.id ?? undefined,
    };
  } catch (e: any) {
    return { configured: true, signedIn: false, error: e?.message ?? String(e) };
  }
}

export function getAuthUrl(): string {
  const oauth = makeOAuthClient();
  return oauth.generateAuthUrl({
    access_type: 'offline',
    prompt: 'consent',
    scope: SCOPES,
  });
}

export async function exchangeCode(code: string): Promise<void> {
  const oauth = makeOAuthClient();
  const { tokens } = await oauth.getToken(code);
  // Preserve refresh_token across re-consents — Google only returns it the first time
  const existing = loadToken();
  const merged = { ...(existing ?? {}), ...tokens };
  if (!merged.refresh_token && existing?.refresh_token) merged.refresh_token = existing.refresh_token;
  saveToken(merged);
}

export function signOut(): void {
  if (fs.existsSync(TOKEN_FILE)) fs.unlinkSync(TOKEN_FILE);
}

export async function uploadShort(opts: YouTubeUploadOptions): Promise<{ ok: true; videoId: string; url: string } | { ok: false; error: string }> {
  const log = opts.onLog ?? (() => {});
  if (!fs.existsSync(opts.videoPath)) return { ok: false, error: `file not found: ${opts.videoPath}` };
  const tok = loadToken();
  if (!tok) return { ok: false, error: 'not signed in — visit /youtube and click Sign in' };

  try {
    const oauth = makeOAuthClient();
    oauth.setCredentials(tok);
    // Persist refreshed access tokens so we don't re-auth every run
    oauth.on('tokens', (t: any) => {
      const merged = { ...loadToken(), ...t };
      if (!merged.refresh_token && tok.refresh_token) merged.refresh_token = tok.refresh_token;
      saveToken(merged);
    });
    const yt = google.youtube({ version: 'v3', auth: oauth });
    const stats = fs.statSync(opts.videoPath);

    const title = (opts.title || 'Short').slice(0, 100);
    const baseDesc = opts.description ?? '';
    const description = (/\#shorts\b/i.test(baseDesc) ? baseDesc : `${baseDesc}\n\n#Shorts`).slice(0, 5000);

    log(`uploading ${path.basename(opts.videoPath)} (${(stats.size / 1e6).toFixed(1)} MB) — privacy=${opts.privacy}`);

    const r = await yt.videos.insert(
      {
        part: ['snippet', 'status'],
        notifySubscribers: true,
        requestBody: {
          snippet: {
            title,
            description,
            tags: opts.tags && opts.tags.length ? opts.tags.slice(0, 30) : ['shorts', 'trendvault'],
            categoryId: '22',
          },
          status: {
            privacyStatus: opts.privacy,
            selfDeclaredMadeForKids: !!opts.madeForKids,
          },
        },
        media: { body: fs.createReadStream(opts.videoPath) },
      },
      {
        onUploadProgress: (e: { bytesRead: number }) => {
          const pct = stats.size ? Math.round((e.bytesRead / stats.size) * 100) : 0;
          if (pct % 10 === 0 || pct >= 100) log(`upload progress: ${pct}%`);
        },
      },
    );

    const id = r.data.id;
    if (!id) return { ok: false, error: 'no video id returned by YouTube' };
    log(`done — id=${id}`);
    return { ok: true, videoId: id, url: `https://youtube.com/shorts/${id}` };
  } catch (e: any) {
    const msg = e?.errors?.[0]?.message ?? e?.message ?? String(e);
    return { ok: false, error: msg };
  }
}
