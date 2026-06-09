'use strict';
// Seed a pleasant starting state: a handful of example internet-style stories so
// the library/dashboard aren't empty on first run. No media is created — the user
// uploads their own background footage. Safe to run multiple times (dedup applies).
const stories = require('../src/services/stories');
const textImport = require('../src/services/sources/textImport');

const EXAMPLES = [
  'AITA for charging my family an entrance fee to my wedding?\n\nMy fiance insisted we charge guests to attend our wedding to "cover costs." I refused, but he set up a table at the door demanding twenty dollars per person. My mother cried and left. Then I discovered he had quietly planned this for months and even printed tickets. In the end I cancelled the wedding. Update: we broke up and honestly I feel free.',
  'My petty revenge on the neighbor who kept stealing my parking spot\n\nMy neighbor stole my assigned parking spot every single day. I asked nicely twice and he laughed in my face. So I checked the rules, confirmed it was mine, and had his car towed at 6am before work. He was furious and banged on my door, but the building office sided with me. Now he parks three blocks away and I smile every morning.',
  'TIFU by replying-all to five thousand coworkers with a meme\n\nToday I fucked up. I meant to send a funny meme to one work friend but I hit reply-all on a company-wide email. Five thousand people got it. My manager called me in within minutes. Somehow the CEO replied "this made my day" and now everyone calls me meme guy. I still cringe.',
  'My best friend secretly recorded our private conversations for a year\n\nI told my best friend everything. Last week I found out she had been recording our calls and playing them for her other friends as entertainment. I was devastated and humiliated. When I confronted her she said it was "just jokes." I ended the friendship. Was I wrong to cut her off completely?',
  'Entitled customer demanded I give her my own lunch for free\n\nA customer at the cafe insisted that because she was a "loyal regular" she deserved a free meal. When I said I could not do that, she demanded I hand over my own lunch from the break room. The manager backed me up and asked her to leave. She is still leaving one-star reviews.',
];

let total = 0;
const r = stories.ingest(EXAMPLES.flatMap((t) => textImport.fromPasted(t)), { sourceType: 'pasted', sourceLabel: 'Example stories', applyPrefs: false });
total = r.stories.length;
console.log(`Seeded ${total} example stories. Open the app and visit Story Library / Discovery.`);
console.log('Upload background MP4s under "Background Library" to start making videos.');
