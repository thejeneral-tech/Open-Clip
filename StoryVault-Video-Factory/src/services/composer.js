'use strict';
// Video Composer + Renderer (spec §13/§19). Selects/assembles background segments
// to fill the narration, converts horizontal footage to vertical safely, burns
// word-level captions, muxes narration, and outputs a 1080x1920 H.264/AAC MP4.
const fs = require('node:fs');
const path = require('node:path');
const db = require('../db/database');
const { id } = require('../util/ids');
const { PATHS, RENDER } = require('../config');
const ff = require('./ffmpeg');
const segSvc = require('./segments');
const bgSvc = require('./backgrounds');
const dedup = require('./dedup');
const fp = require('./fingerprint');
const rng = require('../util/rng');
const log = require('./logger');
const overlays = require('./overlays');
const tts = require('./tts');

// Crossfade duration between footage clips; selections add a small buffer so the xfade
// overlap (which shortens total footage) never leaves the video shorter than the audio.
const TRANSITION = 0.35;
function withTransitionBuffer(dur) { return dur * 1.04 + 3; }

// Create the video (project) record linking all artefacts + a footage plan.
function createVideo({ story, script, narration, caption, opts = {} }) {
  const targetDur = narration.duration;
  const seedRng = rng.mulberry32(rng.seedFrom(`${narration.id}|${opts.variationSeed || 0}`));
  const sel = segSvc.selectForDuration(withTransitionBuffer(targetDur), {
    avoidSegmentIds: opts.avoidSegmentIds || [],
    backgroundIds: opts.backgroundIds || null,
    category: opts.backgroundCategory || null,
    seedRng,
  });

  const vid = id('vid');
  const row = {
    id: vid,
    story_id: story.id, script_id: script.id, narration_id: narration.id, caption_id: caption.id,
    batch_id: opts.batchId || null,
    title: story.title,
    duration: targetDur,
    segment_plan: JSON.stringify(sel.plan),
    voice: narration.voice,
    caption_style: caption.style,
    template_id: opts.templateId || null,
    status: 'draft',
    preview_path: null, render_path: null,
    duplicate_score: story.duplicate_score || 0,
    warnings: JSON.stringify(story.warnings || []),
    error: null,
    created_at: db.nowIso(), updated_at: db.nowIso(),
  };
  db.insert('videos', row);
  return hydrate(row);
}

function hydrate(row) {
  if (!row) return row;
  const o = { ...row };
  for (const k of ['segment_plan', 'warnings']) { if (typeof o[k] === 'string') { try { o[k] = JSON.parse(o[k]); } catch { /* */ } } }
  return o;
}
function getVideo(vid) { return hydrate(db.get('SELECT * FROM videos WHERE id = ?', [vid])); }

// --- Reference template intro (topic card + author intro + karaoke captions) ----------
// Adds the 3-stage intro to an already-created video. Synthesises the spoken title (and
// "Posted by …" line), measures them so the cards track the audio, concatenates intro+body
// audio, builds one combined overlay ASS, and re-selects footage to cover the full length.
// Soft-fails: if anything here throws, the caller falls back to the plain captioned render.
async function applyTemplateIntro(video, { story, narration, template, ttsOpts = {}, selectOpts = {} }) {
  const tpl = template || {};
  const tc = tpl.topicCard || {}; const ai = tpl.authorIntro || {};
  if (tc.enabled === false && ai.enabled === false) return video; // intro disabled by template

  const isQuora = /quora/i.test(story.source_type || '') || /quora/i.test(story.community || '');
  const platform = isQuora ? 'quora' : 'reddit';
  const voiceOpts = { provider: ttsOpts.provider, voice: ttsOpts.voice, speed: ttsOpts.speed, style: ttsOpts.style, refPath: ttsOpts.refPath, promptText: ttsOpts.promptText, temperature: ttsOpts.temperature };

  // Stage 1 audio — the title.
  const title = (story.title || 'Untitled story').trim();
  const titleSynth = await tts.synth(cleanForSpeech(title), { ...voiceOpts, out: path.join(PATHS.tmp, `${video.id}_title.wav`) });
  const dT = titleSynth.duration;

  // Stage 2 audio — "Posted by <author>". Every post gets a username: the real author when
  // known, otherwise a deterministic believable handle (so cards never say "User submitted").
  let dA = 0; let authorWav = null;
  const author = (story.author && !/^\[?deleted\]?$/i.test(story.author))
    ? String(story.author).replace(/^u\//i, '')
    : generateHandle(story, isQuora);
  if (ai.enabled !== false && author) {
    const prefix = isQuora ? (ai.prefixQuora || 'Written by') : (ai.prefixReddit || 'Posted by');
    const aSynth = await tts.synth(`${prefix}, ${humanizeHandle(author)}.`, { ...voiceOpts, out: path.join(PATHS.tmp, `${video.id}_author.wav`) });
    dA = aSynth.duration; authorWav = aSynth.path;
  }
  const topicEnd = dT, introEnd = dT + dA, total = introEnd + narration.duration;

  // Concatenate intro + body audio into the video's final track.
  const finalAudio = path.join(PATHS.narration, `${video.id}_final.wav`);
  const inputs = [titleSynth.path]; if (authorWav) inputs.push(authorWav); inputs.push(narration.path);
  await concatAudio(inputs, finalAudio);

  // Shift body word timings to sit after the intro, then build the combined overlay ASS.
  const bodyTimings = (narration.word_timings || []).map((w) => ({ word: w.word, start: w.start + introEnd, end: w.end + introEnd }));
  const ass = overlays.buildAss({
    platform, subreddit: story.community || (isQuora ? 'Quora' : null), displayName: story.community,
    author, title, metrics: realMetrics(story), wordTimings: bodyTimings, topicEnd, introEnd,
    template: widenWindows(tpl), censor: !!ttsOpts.censor,
  });
  const assPath = path.join(PATHS.captions, `${video.id}_overlay.ass`);
  fs.writeFileSync(assPath, ass, 'utf8');

  // Re-select footage to cover the FULL (intro + body) duration.
  const seedRng = rng.mulberry32(rng.seedFrom(`${narration.id}|${selectOpts.variationSeed || 0}|tpl`));
  const sel = segSvc.selectForDuration(withTransitionBuffer(total), {
    avoidSegmentIds: selectOpts.avoidSegmentIds || [], backgroundIds: selectOpts.backgroundIds || null,
    category: selectOpts.backgroundCategory || null, seedRng,
  });

  db.update('videos', video.id, {
    template_id: tpl.id || video.template_id || null, final_audio_path: finalAudio, overlay_ass_path: assPath,
    total_duration: total, duration: total, segment_plan: JSON.stringify(sel.plan),
    intro_meta: JSON.stringify({ topicEnd, introEnd, total }), updated_at: db.nowIso(),
  });
  log.activity('PREVIEW', `Built reference intro (card ${topicEnd.toFixed(1)}s + author ${(introEnd - topicEnd).toFixed(1)}s).`, { refId: video.id });
  return getVideo(video.id);
}

function cleanForSpeech(s) {
  return String(s || '').replace(/https?:\S+/g, '').replace(/[*_`#>]/g, '').replace(/\s+/g, ' ').trim() || 'Untitled story';
}
// Deterministic, believable username for user-submitted stories (so every card has an
// author + avatar instead of "User submitted"). Same story id → same handle every time.
function generateHandle(story, isQuora) {
  const r = rng.mulberry32(rng.seedFrom('handle|' + (story.id || story.title || 'x')));
  const pick = (arr) => arr[Math.floor(r() * arr.length)];
  if (isQuora) {
    const first = ['Jordan', 'Alex', 'Sam', 'Taylor', 'Morgan', 'Casey', 'Riley', 'Jamie', 'Drew', 'Quinn', 'Avery', 'Reese'];
    const last = ['Bennett', 'Carter', 'Hughes', 'Patel', 'Nguyen', 'Reyes', 'Foster', 'Brooks', 'Hayes', 'Mercer', 'Cole', 'Ward'];
    return `${pick(first)} ${pick(last)}`;
  }
  const adj = ['Quiet', 'Brave', 'Sleepy', 'Lucky', 'Salty', 'Cosmic', 'Grumpy', 'Mellow', 'Witty', 'Rusty', 'Silent', 'Frosty', 'Hidden', 'Spicy'];
  const noun = ['Walrus', 'Otter', 'Falcon', 'Pickle', 'Comet', 'Badger', 'Maple', 'Raven', 'Cactus', 'Lobster', 'Penguin', 'Yeti', 'Marble', 'Goblin'];
  return `${pick(adj)}-${pick(noun)}-${1000 + Math.floor(r() * 9000)}`;
}
function humanizeHandle(h) {
  const out = String(h).replace(/^u\//i, '').replace(/[_-]+/g, ' ').replace(/\d+/g, ' ').replace(/\s+/g, ' ').trim();
  return out || String(h).replace(/^u\//i, '');
}
function realMetrics(story) {
  const m = {};
  if (story.upvotes && story.upvotes > 0) m.upvotes = story.upvotes;
  if (story.num_comments && story.num_comments > 0) m.comments = story.num_comments;
  if (story.views && story.views > 0) m.views = story.views;
  return Object.keys(m).length ? m : null;
}
// Let the overlay engine use the real audio-derived stage boundaries verbatim.
function widenWindows(tpl) {
  return { ...tpl,
    topicCard: { ...(tpl.topicCard || {}), minSeconds: 0.3, maxSeconds: 600 },
    authorIntro: { ...(tpl.authorIntro || {}), minSeconds: 0.3, maxSeconds: 600 } };
}
async function concatAudio(inputs, out) {
  const args = ['-y', '-hide_banner', '-loglevel', 'error'];
  inputs.forEach((i) => args.push('-i', i));
  const pre = inputs.map((_, i) => `[${i}:a]aformat=sample_rates=48000:channel_layouts=mono[a${i}]`).join(';');
  const cat = inputs.map((_, i) => `[a${i}]`).join('') + `concat=n=${inputs.length}:v=0:a=1[a]`;
  args.push('-filter_complex', `${pre};${cat}`, '-map', '[a]', out);
  await ff.ffmpeg(args, { timeoutMs: 5 * 60000 });
}

// Choose the audio + subtitle source for a render: the combined overlay when the reference
// intro was applied, else the plain body narration + caption file (unchanged default path).
function renderSources(v, narration, caption) {
  const useOverlay = v.overlay_ass_path && v.final_audio_path && ff.fileExists(v.final_audio_path) && ff.fileExists(v.overlay_ass_path);
  return useOverlay
    ? { audioPath: v.final_audio_path, assBasename: path.basename(v.overlay_ass_path), durationCap: v.total_duration || v.duration }
    : { audioPath: narration.path, assBasename: path.basename(caption.ass_path), durationCap: narration.duration };
}

// Build the ffmpeg argv to assemble plan → vertical video with burned captions.
function buildArgs(plan, narrationPath, assBasename, { width, height, fps, crf, preset, durationCap }) {
  const args = ['-y', '-hide_banner'];
  // background segment inputs (pre-trimmed via -ss/-t before each -i)
  for (const c of plan) {
    const bg = bgSvc.get(c.backgroundId);
    args.push('-ss', String(c.start), '-t', String(c.duration), '-i', bg.path);
  }
  const audioIndex = plan.length;
  args.push('-i', narrationPath);

  // per-segment: scale to cover, crop to frame, normalise fps/sar/pixfmt
  const parts = [];
  const labels = [];
  for (let i = 0; i < plan.length; i++) {
    parts.push(`[${i}:v]scale=${width}:${height}:force_original_aspect_ratio=increase,crop=${width}:${height},setsar=1,fps=${fps},format=yuv420p[v${i}]`);
    labels.push(`[v${i}]`);
  }
  let chain = parts.join(';');
  if (plan.length === 1) {
    chain += `;[v0]copy[bg]`;
  } else {
    // Seamless crossfade between consecutive clips — no hard cuts / colour flashes.
    let prev = 'v0';
    let acc = plan[0].duration;             // cumulative duration of the chain built so far
    for (let i = 1; i < plan.length; i++) {
      const out = (i === plan.length - 1) ? 'bg' : `xf${i}`;
      const offset = Math.max(0, acc - TRANSITION).toFixed(3);
      chain += `;[${prev}][v${i}]xfade=transition=fade:duration=${TRANSITION}:offset=${offset}[${out}]`;
      acc += plan[i].duration - TRANSITION; // each xfade overlaps by TRANSITION seconds
      prev = out;
    }
  }
  // burn captions (ass referenced by basename; ffmpeg cwd set to captions dir)
  chain += `;[bg]subtitles=${assBasename}[vout]`;

  args.push('-filter_complex', chain);
  args.push('-map', '[vout]', '-map', `${audioIndex}:a`);
  args.push('-c:v', RENDER.vcodec, '-preset', preset, '-crf', String(crf), '-pix_fmt', 'yuv420p');
  args.push('-c:a', RENDER.acodec, '-b:a', '160k', '-ar', '48000');
  args.push('-r', String(fps));
  // Trim to the narration length so video fills audio exactly with NO frozen tail.
  if (durationCap) args.push('-t', String(durationCap));
  args.push('-movflags', '+faststart');
  return args;
}

function runFfmpegWithProgress(args, totalDur, onProgress) {
  return ff.ffmpeg(args, {
    cwd: PATHS.captions,
    timeoutMs: 30 * 60000,
    onStderr: (s) => {
      const m = /time=(\d+):(\d+):(\d+\.\d+)/.exec(s);
      if (m && onProgress) {
        const t = (+m[1]) * 3600 + (+m[2]) * 60 + parseFloat(m[3]);
        onProgress(Math.min(0.99, t / (totalDur || 1)));
      }
    },
  });
}

// Fast, lower-res preview (spec §13 preview). Returns updated video.
async function buildPreview(videoId, { onProgress } = {}) {
  const v = getVideo(videoId);
  if (!v) throw new Error('Video not found.');
  const narration = tts.hydrate(db.get('SELECT * FROM narration WHERE id = ?', [v.narration_id]));
  const caption = db.get('SELECT * FROM captions WHERE id = ?', [v.caption_id]);
  if (!narration) throw new Error('Missing narration for preview.');
  const src = renderSources(v, narration, caption);
  if (!src.assBasename) throw new Error('Missing captions for preview.');
  validatePlan(v.segment_plan);

  const out = path.join(PATHS.previews, `${videoId}.mp4`);
  const args = buildArgs(v.segment_plan, src.audioPath, src.assBasename,
    { width: 540, height: 960, fps: 30, crf: 28, preset: 'veryfast', durationCap: src.durationCap });
  args.push(out);
  log.activity('PREVIEW', `Building preview for "${v.title}"…`, { refId: videoId });
  await runFfmpegWithProgress(args, src.durationCap, onProgress);
  if (!ff.fileExists(out)) throw new Error('Preview render produced no output file.');
  db.update('videos', videoId, { preview_path: out, status: 'ready_for_review', updated_at: db.nowIso(), error: null });
  log.activity('PREVIEW', `Preview ready for "${v.title}".`, { level: 'success', refId: videoId });
  return getVideo(videoId);
}

// --- Structured export naming + sidecar metadata (spec §20) -------------------
function slug(s, max = 40) {
  return String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, max) || 'na';
}
function platformOf(sourceType) {
  const t = String(sourceType || '').toLowerCase();
  if (t.startsWith('reddit')) return 'reddit';
  if (t.startsWith('quora')) return 'quora';
  if (t === 'rss') return 'rss';
  return t || 'manual';
}
// YYYY-MM-DD_platform_category_story-id_template_version.mp4
function exportBasename(v, story, preset, version) {
  const date = db.nowIso().slice(0, 10);
  const platform = platformOf(story && story.source_type);
  const category = slug((story && story.category) || 'story', 20);
  const sid = slug((v.story_id || '').replace(/^story_/, ''), 16);
  const tmpl = slug(v.template_id || preset, 20);
  return `${date}_${platform}_${category}_${sid}_${tmpl}_v${version}`;
}
// Sidecar JSON written next to the MP4: provenance + every input used to make it.
function buildSidecar(v, story, script, narration, caption, exportRow, preset) {
  const segs = (v.segment_plan || []).map((c) => {
    const bg = bgSvc.get(c.backgroundId);
    return { segmentId: c.segmentId, backgroundId: c.backgroundId, source: bg ? bg.original_name : null, start: c.start, end: c.end };
  });
  return {
    generatedAt: db.nowIso(),
    storyVaultVersion: 1,
    video: { id: v.id, title: v.title, durationSeconds: exportRow.duration, resolution: `${exportRow.width}x${exportRow.height}`, preset },
    story: story ? {
      id: story.id, source: story.source_type, platform: platformOf(story.source_type),
      originalUrl: story.url || null, author: story.author || null, community: story.community || null,
      category: story.category || null, score: story.score_overall != null ? story.score_overall : null,
      scoreLabel: story.score_label || null,
      engagement: { upvotes: story.upvotes || 0, comments: story.num_comments || 0, provenance: safeParse(story.metrics_provenance) },
    } : null,
    script: script ? { id: script.id, hook: script.hook || null, wordCount: script.word_count || null, text: script.full_text || null } : null,
    narration: narration ? { id: narration.id, provider: narration.provider, voice: narration.voice, speed: narration.speed, durationSeconds: narration.duration } : null,
    captions: caption ? { id: caption.id, style: caption.style, position: caption.position, assFile: caption.ass_path ? path.basename(caption.ass_path) : null, srtFile: caption.srt_path ? path.basename(caption.srt_path) : null } : null,
    template: v.template_id || null,
    footage: segs,
    output: { file: exportRow.filename, sizeBytes: exportRow.size_bytes },
  };
}
function safeParse(s) { if (s && typeof s === 'object') return s; try { return JSON.parse(s); } catch { return null; } }

// Full-quality render + export (spec §19). Records a render_job and an export.
async function render(videoId, { preset = 'tiktok', onProgress } = {}) {
  const v = getVideo(videoId);
  if (!v) throw new Error('Video not found.');
  const narration = tts.hydrate(db.get('SELECT * FROM narration WHERE id = ?', [v.narration_id]));
  const caption = db.get('SELECT * FROM captions WHERE id = ?', [v.caption_id]);
  if (!narration) throw new Error('Missing narration for render.');
  const src = renderSources(v, narration, caption);
  if (!src.assBasename) throw new Error('Missing captions for render.');
  validatePlan(v.segment_plan);

  const presetConf = RENDER.presets[preset] || RENDER.presets.tiktok;
  const jobId = id('job');
  db.insert('render_jobs', { id: jobId, video_id: videoId, preset, status: 'running', progress: 0, stage: 'encoding', output_path: null, error: null, started_at: db.nowIso(), finished_at: null, created_at: db.nowIso() });
  db.update('videos', videoId, { status: 'rendering', updated_at: db.nowIso() });

  // Structured, human-readable output name (spec §20): date_platform_category_story_template_version.
  // Bump the version until the name is unique on disk AND in the exports table, so two videos
  // from the same story/template/date never overwrite each other (ffmpeg runs with -y).
  const story = db.get('SELECT * FROM stories WHERE id = ?', [v.story_id]);
  let version = (db.get('SELECT count(*) c FROM exports WHERE video_id = ?', [videoId]).c || 0) + 1;
  let base = exportBasename(v, story, preset, version);
  let out = path.join(PATHS.renders, `${base}.mp4`);
  while (ff.fileExists(out) || db.get('SELECT 1 AS x FROM exports WHERE filename = ?', [`${base}.mp4`])) {
    version++;
    base = exportBasename(v, story, preset, version);
    out = path.join(PATHS.renders, `${base}.mp4`);
  }
  const args = buildArgs(v.segment_plan, src.audioPath, src.assBasename,
    { width: presetConf.width, height: presetConf.height, fps: presetConf.fps, crf: RENDER.crf, preset: 'medium', durationCap: src.durationCap });
  args.push(out);

  log.activity('RENDER', `Rendering "${v.title}" (${preset} ${presetConf.width}x${presetConf.height})…`, { refId: videoId });
  try {
    await runFfmpegWithProgress(args, src.durationCap, (p) => {
      db.update('render_jobs', jobId, { progress: Math.round(p * 100) });
      if (onProgress) onProgress(p);
    });
  } catch (e) {
    db.update('render_jobs', jobId, { status: 'failed', error: e.message, finished_at: db.nowIso() });
    db.update('videos', videoId, { status: 'failed', error: `Render failed: ${e.message}`, updated_at: db.nowIso() });
    throw e;
  }
  if (!ff.fileExists(out)) throw new Error('Render produced no output file.');

  // Verify the output is playable and has audio (spec §19 guarantees).
  let meta;
  try { meta = await ff.probe(out); } catch (e) { throw new Error(`Rendered file failed verification: ${e.message}`); }
  if (!meta.hasAudio) log.error('RENDER', 'Rendered video has no audio track.', null, videoId);

  db.update('render_jobs', jobId, { status: 'done', progress: 100, output_path: out, finished_at: db.nowIso() });

  // Register the footage sequence + render fingerprint so it's not reused (§9).
  const segIds = v.segment_plan.map((p) => p.segmentId);
  segSvc.markSequenceUsed(segIds, videoId);
  const renderHash = fp.sha256(`${v.story_id}|${v.script_id}|${v.narration_id}|${segIds.join(',')}`);
  dedup.fingerprintVideo(v, { segmentIds: segIds, voice: v.voice, captionStyle: v.caption_style, renderHash });

  const exId = id('export');
  const sidecarPath = path.join(PATHS.renders, `${base}.json`);
  const exportRow = { id: exId, video_id: videoId, platform: preset, path: out, filename: `${base}.mp4`, sidecar_path: sidecarPath, size_bytes: meta.sizeBytes, width: meta.width, height: meta.height, duration: meta.duration, created_at: db.nowIso() };
  db.insert('exports', exportRow);
  // Sidecar metadata file (spec §20): full provenance + every input used to make it.
  try {
    const script = db.get('SELECT * FROM scripts WHERE id = ?', [v.script_id]);
    const sidecar = buildSidecar(v, story, script, narration, caption, exportRow, preset);
    fs.writeFileSync(sidecarPath, JSON.stringify(sidecar, null, 2), 'utf8');
  } catch (e) {
    log.error('RENDER', `Export sidecar metadata could not be written: ${e.message}`, null, videoId);
  }
  db.update('videos', videoId, { status: 'complete', render_path: out, updated_at: db.nowIso(), error: null });
  log.activity('RENDER', `Exported "${v.title}" → ${path.basename(out)} (${Math.round(meta.sizeBytes / 1024)} KB).`, { level: 'success', refId: videoId });
  return { video: getVideo(videoId), export: db.get('SELECT * FROM exports WHERE id = ?', [exId]), job: db.get('SELECT * FROM render_jobs WHERE id = ?', [jobId]) };
}

function validatePlan(plan) {
  if (!plan || !plan.length) throw new Error('No background segments selected. Upload footage and create segments first.');
  for (const c of plan) {
    const bg = bgSvc.get(c.backgroundId);
    if (!bg) throw new Error('A selected background no longer exists.');
    if (!ff.fileExists(bg.path)) throw new Error(`Background file is missing: ${bg.original_name}.`);
  }
}

module.exports = { createVideo, applyTemplateIntro, buildPreview, render, getVideo, buildArgs, hydrate, validatePlan };
