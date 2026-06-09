'use strict';
// YouTube footage import (spec §10 — footage sources / custom gameplay). Downloads a
// PUBLIC YouTube video with yt-dlp — invoked as the Python module `python -m yt_dlp`,
// which is what is installed in this environment — and hands the resulting file to
// backgrounds.register(). We do NOT bypass age/region/members-only/private restrictions;
// yt-dlp's own errors are surfaced verbatim (spec §22 "specific failure information").
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const { id } = require('../../util/ids');

const PYTHON = process.env.PYTHON_PATH || 'python';
const MAX_FILESIZE = process.env.YOUTUBE_MAX_FILESIZE || '4000M'; // gameplay clips are long
const MAX_HEIGHT = process.env.YOUTUBE_MAX_HEIGHT || '1080';

function isYouTubeUrl(u) {
  return /^(https?:\/\/)?(www\.|m\.)?(youtube\.com\/(watch\?v=|shorts\/|live\/|embed\/)|youtu\.be\/)[\w-]{6,}/i.test(String(u || '').trim());
}

// Download `url` into `folder`. Resolves { path, title }. Rejects with a clear message.
// onProc(childProcess) is called once the downloader starts, so callers can cancel it.
function download(url, folder, { onProgress, onProc } = {}) {
  return new Promise((resolve, reject) => {
    if (!isYouTubeUrl(url)) return reject(new Error('That does not look like a YouTube video URL.'));
    fs.mkdirSync(folder, { recursive: true });
    const fileId = id('bgfile');                       // unique → never clobbers an existing file
    const outTemplate = path.join(folder, `${fileId}.%(ext)s`);
    const args = [
      '-u',                                            // unbuffered: progress flushes in real time (not block-buffered over the pipe)
      '-m', 'yt_dlp',
      '--no-playlist', '--no-warnings', '--no-color', '--newline',
      '--max-filesize', MAX_FILESIZE,
      // Prefer m4a audio so the mp4 merge is clean; fall back to any audio, then any file.
      '-f', `bv*[height<=${MAX_HEIGHT}]+ba[ext=m4a]/bv*[height<=${MAX_HEIGHT}]+ba/b[height<=${MAX_HEIGHT}]/b`,
      '--merge-output-format', 'mp4',
      '-o', outTemplate,
      // --print implies --quiet (which hides progress) → --progress forces the progress bar back on.
      '--no-simulate', '--progress', '--print', 'after_move:%(title)s\t%(filepath)s',
      url,
    ];
    let ps;
    try { ps = spawn(PYTHON, args, { windowsHide: true, env: { ...process.env, PYTHONUNBUFFERED: '1' } }); }
    catch (e) { return reject(new Error(`Could not launch the YouTube downloader (${e.message}). Install Python + yt_dlp (pip install yt-dlp).`)); }
    if (onProc) onProc(ps);
    let cancelled = false;
    ps._cancel = () => { cancelled = true; killTree(ps.pid); };

    let out = '', err = '';
    // A chunk can hold many progress lines; report the last one + any stage transition.
    // yt-dlp may emit progress on stdout OR stderr depending on flags, so parse both.
    const handleProgress = (s) => {
      if (!onProgress) return;
      let info = null, merging = false, processing = false;
      for (const line of s.split(/\r?\n/)) {
        const m = line.match(/\[download\]\s+([\d.]+)%/);
        if (m) {
          info = {
            stage: 'downloading',
            percent: Number(m[1]),
            size: (line.match(/of\s+~?\s*([\d.]+\s*[KMGT]i?B)/i) || [])[1] || null,
            speed: (line.match(/at\s+([\d.]+\s*[KMGT]i?B\/s)/i) || [])[1] || null,
            eta: (line.match(/ETA\s+([\d:]+)/i) || [])[1] || null,
          };
        } else if (/Merging formats|\[Merger\]/i.test(line)) merging = true;
        else if (/\[VideoRemuxer\]|\[ExtractAudio\]|\[Metadata\]|\[Fixup/i.test(line)) processing = true;
      }
      if (info) onProgress(info);
      else if (merging) onProgress({ stage: 'merging', percent: 100 });
      else if (processing) onProgress({ stage: 'processing' });
    };
    ps.stdout.on('data', (d) => { const s = d.toString(); out += s; handleProgress(s); });
    ps.stderr.on('data', (d) => { const s = d.toString(); err += s; handleProgress(s); });
    ps.on('error', (e) => reject(new Error(`Could not launch the YouTube downloader (${e.message}). Install Python + yt_dlp (pip install yt-dlp).`)));
    ps.on('close', (code) => {
      if (cancelled) {
        // Remove any partial files yt-dlp left behind for this download.
        try { fs.readdirSync(folder).filter((f) => f.startsWith(fileId)).forEach((f) => { try { fs.unlinkSync(path.join(folder, f)); } catch { /* */ } }); } catch { /* */ }
        const err2 = new Error('Import cancelled.'); err2.cancelled = true; return reject(err2);
      }
      if (code !== 0) return reject(new Error(`YouTube download failed: ${parseError(err) || `yt-dlp exited with code ${code}.`}`));
      // Authoritative result line: "title<TAB>finalpath"
      let title = null, filePath = null;
      for (const line of out.split(/\r?\n/).map((l) => l.trim()).filter(Boolean).reverse()) {
        if (line.includes('\t')) { const i = line.indexOf('\t'); title = line.slice(0, i); filePath = line.slice(i + 1); break; }
      }
      // Fallback: find the file we just wrote by its unique id prefix.
      if (!filePath || !fs.existsSync(filePath)) {
        try {
          const found = fs.readdirSync(folder).filter((f) => f.startsWith(fileId)).map((f) => path.join(folder, f));
          filePath = found.find((f) => /\.(mp4|mkv|webm|mov)$/i.test(f)) || found[0] || null;
        } catch { /* folder vanished */ }
      }
      if (!filePath || !fs.existsSync(filePath)) {
        return reject(new Error('The download finished but produced no video file (the video may be too large, unavailable, or restricted).'));
      }
      resolve({ path: filePath, title: title || path.basename(filePath) });
    });
  });
}

// Kill the downloader AND its children (yt-dlp spawns ffmpeg for merging). On Windows a
// plain kill() can orphan ffmpeg, so use taskkill /T to terminate the whole tree.
function killTree(pid) {
  if (!pid) return;
  try {
    if (process.platform === 'win32') spawn('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true });
    else process.kill(pid, 'SIGTERM');
  } catch { /* already gone */ }
}

function parseError(stderr) {
  const s = String(stderr || '');
  if (/Private video/i.test(s)) return 'the video is private.';
  if (/members-only|join this channel/i.test(s)) return 'the video is members-only.';
  if (/confirm your age|age[- ]restricted|inappropriate for some users/i.test(s)) return 'the video is age-restricted and cannot be imported.';
  if (/Video unavailable|This video is not available/i.test(s)) return 'the video is unavailable.';
  if (/max-filesize|larger than/i.test(s)) return `the video exceeds the ${MAX_FILESIZE} limit (raise YOUTUBE_MAX_FILESIZE to allow larger).`;
  if (/HTTP Error 429|Too Many Requests|Sign in to confirm you'?re not a bot/i.test(s)) return 'YouTube is rate-limiting or bot-blocking downloads right now. Try again later.';
  if (/No module named yt_dlp/i.test(s)) return 'yt_dlp is not installed for this Python (run: pip install yt-dlp).';
  if (/is not recognized|No such file/i.test(s)) return 'Python was not found on PATH (set PYTHON_PATH).';
  const errLine = s.split(/\r?\n/).reverse().find((l) => /^ERROR/i.test(l.trim()));
  return errLine ? errLine.replace(/^ERROR:\s*/i, '').trim() : null;
}

module.exports = { download, isYouTubeUrl };
