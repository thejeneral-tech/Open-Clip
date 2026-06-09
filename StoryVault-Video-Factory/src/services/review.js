'use strict';
// Review Queue (spec §18). Shows everything needed to judge a generated video and
// supports approve→render→export, reject, edit-script, and regenerate-one-component
// without rebuilding the whole project.
const db = require('../db/database');
const stories = require('./stories');
const sg = require('./scriptGenerator');
const tts = require('./tts');
const captions = require('./captions');
const composer = require('./composer');
const segSvc = require('./segments');
const log = require('./logger');

function bundle(videoId) {
  const v = composer.getVideo(videoId);
  if (!v) return null;
  const story = v.story_id ? stories.getStory(v.story_id) : null;
  const script = db.get('SELECT * FROM scripts WHERE id = ?', [v.script_id]);
  const narration = db.get('SELECT * FROM narration WHERE id = ?', [v.narration_id]);
  const caption = db.get('SELECT * FROM captions WHERE id = ?', [v.caption_id]);
  const backgrounds = [...new Set((v.segment_plan || []).map((p) => p.backgroundId))]
    .map((bid) => db.get('SELECT id, original_name, category FROM backgrounds WHERE id = ?', [bid]))
    .filter(Boolean);
  return {
    video: v,
    story: story ? { id: story.id, title: story.title, url: story.url, community: story.community, source_type: story.source_type, warnings: story.warnings } : null,
    script: script ? { id: script.id, full_text: script.full_text, hook: script.hook, audience_question: script.audience_question, word_count: script.word_count } : null,
    narration: narration ? { id: narration.id, voice: narration.voice, duration: narration.duration, path: narration.path } : null,
    caption: caption ? { id: caption.id, style: caption.style, position: caption.position } : null,
    backgrounds,
    segmentTimestamps: (v.segment_plan || []).map((p) => ({ name: p.name, start: p.start, end: p.end, duration: p.duration })),
    duplicateScore: v.duplicate_score,
    warnings: v.warnings,
  };
}

function queue() {
  const vids = db.all("SELECT id FROM videos WHERE status IN ('ready_for_review','preview','draft','failed') ORDER BY created_at DESC LIMIT 200");
  return vids.map((r) => bundle(r.id)).filter(Boolean);
}

function approve(videoId, { preset = 'tiktok' } = {}) {
  const v = composer.getVideo(videoId);
  if (!v) throw new Error('Video not found.');
  if (!v.preview_path) throw new Error('Build a preview before approving.');
  db.update('videos', videoId, { status: 'approved', updated_at: db.nowIso() });
  log.activity('RENDER', `Approved "${v.title}". Rendering final export…`, { refId: videoId });
  return composer.render(videoId, { preset }); // returns {video, export, job}
}

function reject(videoId, reason) {
  db.update('videos', videoId, { status: 'rejected', error: reason || null, updated_at: db.nowIso() });
  log.activity('SYSTEM', `Rejected video.`, { level: 'warn', refId: videoId });
  return composer.getVideo(videoId);
}

// Replace one component and rebuild the preview, preserving the project (§22).
async function regenerate(videoId, component, overrides = {}) {
  const v = composer.getVideo(videoId);
  if (!v) throw new Error('Video not found.');
  const story = stories.getStory(v.story_id);
  let script = db.get('SELECT * FROM scripts WHERE id = ?', [v.script_id]);
  let narration = tts.getNarration(v.narration_id);
  let caption = db.get('SELECT * FROM captions WHERE id = ?', [v.caption_id]);
  let plan = v.segment_plan;

  const patch = { updated_at: db.nowIso() };

  if (component === 'script' || component === 'editScript') {
    if (overrides.fullText) {
      // user-edited script text → save a new script row with that text
      script = sg.save({ ...scriptToObj(script), full_text: overrides.fullText, word_count: overrides.fullText.trim().split(/\s+/).length });
    } else {
      script = sg.remix(story, { durationSeconds: script.duration_target, hookStyle: script.hook_style, dramaLevel: script.drama_level }, overrides.modifier || 'another_angle');
    }
    narration = await tts.generate(script, { voice: narration.voice, speed: narration.speed, style: narration.style });
    caption = captions.generate(narration, { style: caption.style, position: caption.position });
    plan = reselect(narration.duration, plan).plan;
    Object.assign(patch, { script_id: script.id, narration_id: narration.id, caption_id: caption.id, segment_plan: JSON.stringify(plan), duration: narration.duration });
  } else if (component === 'voice') {
    narration = await tts.generate(script, { voice: overrides.voice || nextVoice(narration.voice), speed: overrides.speed || narration.speed, style: overrides.style || narration.style });
    caption = captions.generate(narration, { style: caption.style, position: caption.position });
    plan = reselect(narration.duration, plan).plan;
    Object.assign(patch, { narration_id: narration.id, caption_id: caption.id, voice: narration.voice, segment_plan: JSON.stringify(plan), duration: narration.duration });
  } else if (component === 'captions') {
    caption = captions.generate(narration, { style: overrides.style || nextCaption(caption.style), position: overrides.position || caption.position, size: overrides.size, censor: overrides.censor });
    Object.assign(patch, { caption_id: caption.id, caption_style: caption.style });
  } else if (component === 'background') {
    plan = reselect(narration.duration, plan, overrides).plan;
    Object.assign(patch, { segment_plan: JSON.stringify(plan) });
  } else {
    throw new Error(`Unknown component "${component}".`);
  }

  db.update('videos', videoId, patch);
  await composer.buildPreview(videoId);
  log.activity('PREVIEW', `Regenerated ${component} and rebuilt preview.`, { level: 'success', refId: videoId });
  return bundle(videoId);
}

function reselect(duration, prevPlan, overrides = {}) {
  return segSvc.selectForDuration(duration, {
    avoidSegmentIds: (prevPlan || []).map((p) => p.segmentId),
    category: overrides.backgroundCategory || null,
    backgroundIds: overrides.backgroundIds || null,
  });
}
function scriptToObj(s) {
  const o = {}; for (const k of ['story_id', 'duration_target', 'hook_style', 'hook', 'setup', 'conflict', 'escalation', 'ending', 'audience_question', 'full_text', 'word_count', 'est_seconds', 'drama_level', 'safe_mode', 'source_attribution']) o[k] = s[k];
  return o;
}
function nextVoice(v) { return v === 'Microsoft Zira Desktop' ? 'Microsoft David Desktop' : 'Microsoft Zira Desktop'; }
function nextCaption(c) { const order = ['bold', 'clean', 'karaoke', 'minimal', 'large_centered', 'two_line']; return order[(order.indexOf(c) + 1) % order.length]; }

module.exports = { bundle, queue, approve, reject, regenerate };
