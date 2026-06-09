'use strict';
// One-call orchestration for "story → preview", reused by single create, the
// Batch Studio, the Variation Engine, and regeneration in the Review Queue.
// Each step is isolated so a failure preserves the project + completed artefacts
// (spec §22 "Never erase a project because one step failed").
const db = require('../db/database');
const stories = require('./stories');
const sg = require('./scriptGenerator');
const tts = require('./tts');
const captions = require('./captions');
const composer = require('./composer');
const templates = require('./templates');
const jobs = require('./jobs');
const prefsSvc = require('./preferences');
const log = require('./logger');

function resolveSettings(overrides = {}) {
  const prefs = prefsSvc.get();
  return {
    durationSeconds: overrides.durationSeconds || prefs.targetVideoLength || 60,
    hookStyle: overrides.hookStyle || 'conflict',
    dramaLevel: overrides.dramaLevel || 3,
    safeMode: overrides.safeMode != null ? overrides.safeMode : (prefs.profanity === 'censor'),
    variationSeed: overrides.variationSeed || 0,
    provider: overrides.provider || 'sapi',
    voice: overrides.voice || prefs.preferredVoice || 'Microsoft Zira Desktop',
    speed: overrides.speed != null ? overrides.speed : 1.0,
    narrationStyle: overrides.narrationStyle || 'Calm storyteller',
    captionStyle: overrides.captionStyle || prefs.preferredCaptionStyle || 'bold',
    captionPosition: overrides.captionPosition || 'bottom',
    captionSize: overrides.captionSize || null,
    censorCaptions: overrides.censorCaptions != null ? overrides.censorCaptions : (prefs.profanity === 'censor'),
    backgroundCategory: overrides.backgroundCategory || null,
    backgroundIds: overrides.backgroundIds || null,
    avoidSegmentIds: overrides.avoidSegmentIds || [],
    batchId: overrides.batchId || null,
    attribution: overrides.attribution !== false,
    templateId: overrides.templateId || prefs.templateId || null,
  };
}

// stage(name, detail) is called as the pipeline advances (drives batch statuses).
// Pass { jobId } to checkpoint each stage to the DB so a failed/interrupted run RESUMES
// from the last completed stage instead of redoing finished work. Omit jobId for an
// identical, un-checkpointed single-shot run.
async function createVideoForStory(storyOrId, overrides = {}, { stage = () => {}, jobId = null } = {}) {
  const story = typeof storyOrId === 'string' ? stories.getStory(storyOrId) : storyOrId;
  if (!story) throw new Error('Story not found.');
  const s = resolveSettings(overrides);
  const ck = jobId ? jobs.checkpointer(jobId) : jobs.nullCheckpointer;

  stage('Writing script', 'Rewriting story into a script');
  const script = await ck.step({
    name: 'script',
    run: () => sg.generateAndSave(story, {
      durationSeconds: s.durationSeconds, hookStyle: s.hookStyle, dramaLevel: s.dramaLevel,
      safeMode: s.safeMode, variationSeed: s.variationSeed, attribution: s.attribution,
    }),
    revive: (o) => sg.getScript(o.id),
  });

  stage('Generating audio', 'Synthesizing narration');
  const narration = await ck.step({
    name: 'narration',
    run: () => tts.generate(script, { provider: s.provider, voice: s.voice, speed: s.speed, style: s.narrationStyle }),
    revive: (o) => tts.getNarration(o.id),
  });

  stage('Creating captions', 'Building word-level captions');
  const caption = await ck.step({
    name: 'captions',
    run: () => captions.generate(narration, { style: s.captionStyle, position: s.captionPosition, size: s.captionSize, censor: s.censorCaptions }),
    revive: (o) => captions.getCaption(o.id),
  });

  stage('Selecting footage', 'Choosing unused background segments');
  const template = templates.resolve(s.templateId);
  let video = await ck.step({
    name: 'footage',
    run: () => composer.createVideo({
      story, script, narration, caption,
      opts: { batchId: s.batchId, avoidSegmentIds: s.avoidSegmentIds, backgroundCategory: s.backgroundCategory, backgroundIds: s.backgroundIds, variationSeed: s.variationSeed, templateId: template.id },
    }),
    revive: (o) => composer.getVideo(o.id),
  });

  // Reference template intro (topic card → author intro → captions). Soft-fail: on any
  // error we keep the plain captioned video rather than failing the whole job.
  const introOn = template && (template.topicCard?.enabled !== false || template.authorIntro?.enabled !== false);
  if (introOn) {
    stage('Creating intro', 'Topic card + author intro');
    video = await ck.step({
      name: 'intro',
      run: async () => {
        try {
          return await composer.applyTemplateIntro(video, {
            story, narration, template,
            ttsOpts: { voice: s.voice, speed: s.speed, style: s.narrationStyle, censor: s.censorCaptions },
            selectOpts: { avoidSegmentIds: s.avoidSegmentIds, backgroundCategory: s.backgroundCategory, backgroundIds: s.backgroundIds, variationSeed: s.variationSeed },
          });
        } catch (e) {
          log.error('PREVIEW', `Reference intro failed, using plain captions: ${e.message}`, null, video.id);
          return composer.getVideo(video.id);
        }
      },
      revive: (o) => composer.getVideo(o.id),
    });
  }

  stage('Building preview', 'Assembling preview');
  await ck.step({
    name: 'preview',
    run: async () => { await composer.buildPreview(video.id); return composer.getVideo(video.id); },
    revive: (o) => composer.getVideo(o.id),
  });

  // Mark the story as used once a preview exists.
  db.update('stories', story.id, { status: 'used' });
  return composer.getVideo(video.id);
}

module.exports = { createVideoForStory, resolveSettings };
