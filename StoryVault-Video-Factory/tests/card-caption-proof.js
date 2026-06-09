'use strict';
// Visual proof: render a video through the real pipeline and extract the topic-card frame
// (Stage 1) + a caption frame (Stage 3) so the ScalingStories card + centered captions
// can be eyeballed.
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const db = require('./../src/db/database');
const { PATHS, FFMPEG } = require('./../src/config');
const stories = require('./../src/services/stories');
const textImport = require('./../src/services/sources/textImport');
const pipeline = require('./../src/services/pipeline');
const composer = require('./../src/services/composer');

function frame(video, t, out) {
  const r = spawnSync(FFMPEG, ['-y', '-hide_banner', '-loglevel', 'error', '-ss', String(t), '-i', video, '-frames:v', '1', out], { encoding: 'utf8' });
  if (r.status !== 0) throw new Error('frame extract failed: ' + (r.stderr || '').slice(-200));
}

(async () => {
  db.getDb();
  const STORY = 'AITA for charging my family an entrance fee to my wedding?\n\nMy fiance insisted we charge guests to attend our wedding to "cover costs." I refused, but he set up a table at the door demanding twenty dollars per person. My mother cried and left. Then I discovered he had quietly planned this for months and even printed tickets. In the end I cancelled the wedding and walked away with my dignity. Plus ten updates.';
  const ing = stories.ingest(textImport.fromPasted(STORY), { sourceType: 'pasted' });
  const story = ing.stories[0] || stories.getStory(ing.stories[0]?.id);
  const s = story.duplicate_of ? stories.getStory(story.duplicate_of) : story;
  console.log('Story:', s.id, '· author:', s.author || '(none → generated)');

  const video = await pipeline.createVideoForStory(s, { durationSeconds: 40, captionStyle: 'reference' });
  const v = composer.getVideo(video.id);
  const meta = v.intro_meta && typeof v.intro_meta === 'string' ? JSON.parse(v.intro_meta) : v.intro_meta || {};
  console.log('intro_meta:', JSON.stringify(meta));
  const preview = v.preview_path;
  if (!preview || !fs.existsSync(preview)) throw new Error('no preview produced');

  const cardT = Math.max(0.6, (meta.topicEnd || 3) / 2);
  const capT = (meta.introEnd || 5) + 2.5;
  const dir = path.join(PATHS.tmp, 'proof');
  fs.mkdirSync(dir, { recursive: true });
  const f1 = path.join(dir, 'card.png'), f2 = path.join(dir, 'caption.png');
  frame(preview, cardT, f1);
  frame(preview, capT, f2);
  console.log('CARD_FRAME=' + f1);
  console.log('CAPTION_FRAME=' + f2);
  process.exit(0);
})().catch((e) => { console.error('ERR', e.message); process.exit(1); });
