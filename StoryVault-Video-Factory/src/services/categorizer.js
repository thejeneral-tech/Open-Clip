'use strict';
// Infer a category from story text when the source doesn't provide one
// (pasted text, CSV without a category column, RSS). Keyword scoring → best match.
const RULES = [
  ['AITA', /\b(aita|am i the (asshole|a-?hole)|wibta|was i wrong)\b/i, 5],
  ['Revenge', /\b(revenge|petty revenge|pro ?revenge|got back at|payback|karma|malicious compliance)\b/i, 4],
  ['Cheating', /\b(cheat(ed|ing)?|affair|unfaithful|caught (him|her|them))\b/i, 4],
  ['Wedding drama', /\b(wedding|bride|groom|bridesmaid|engagement|fianc)\b/i, 3],
  ['Relationships', /\b(boyfriend|girlfriend|husband|wife|partner|dating|relationship|broke up)\b/i, 2],
  ['Family drama', /\b(mother|father|mom|dad|sister|brother|sibling|parents|in-?law|mil|family)\b/i, 2],
  ['Roommate drama', /\b(roommate|housemate|flatmate)\b/i, 3],
  ['Workplace drama', /\b(boss|coworker|manager|office|fired|hr|workplace|my job)\b/i, 3],
  ['Entitled people', /\b(entitled|karen|choosing beggar|demanded free|how dare)\b/i, 3],
  ['Customer service stories', /\b(customer|retail|register|manager please|tech support|call center)\b/i, 2],
  ['Money disputes', /\b(money|owe|debt|rent|paid|refund|venmo|loan|\$\d+)\b/i, 1],
  ['Neighbor disputes', /\b(neighbor|neighbour|hoa|fence|property line|parking spot)\b/i, 3],
  ['Scary stories', /\b(nosleep|haunted|ghost|creepy|terrifying|in the dark|footsteps)\b/i, 3],
  ['TIFU', /\b(tifu|today i (messed|fucked) up|biggest mistake)\b/i, 5],
  ['Confessions', /\b(confess|i never told|secret|off my chest|i have to admit)\b/i, 2],
  ['School stories', /\b(school|teacher|classmate|college|university|professor|exam)\b/i, 2],
  ['Funny stories', /\b(hilarious|funny|laughed|comedy|prank)\b/i, 1],
  ['Inspirational stories', /\b(inspir|overcame|never gave up|changed my life|grateful)\b/i, 1],
  ['Moral dilemmas', /\b(moral|dilemma|right thing|should i have|ethical)\b/i, 2],
];

// Explicit subreddit-style tags in the TITLE are unambiguous and take priority
// over thematic keyword frequency (an "AITA for…wedding" post is AITA, not Wedding).
const TITLE_TAGS = [
  ['AITA', /\b(aita|aitah|wibta|wibtah)\b/i],
  ['TIFU', /\btifu\b/i],
];

function infer(title, body) {
  const ttl = String(title || '');
  for (const [cat, re] of TITLE_TAGS) if (re.test(ttl)) return cat;
  // Otherwise score by keyword frequency, weighting title hits 3× body hits.
  let best = null, bestScore = 0;
  for (const [cat, re, weight] of RULES) {
    const g = new RegExp(re, 'gi');
    const titleHits = (ttl.match(g) || []).length;
    const bodyHits = (String(body || '').match(new RegExp(re, 'gi')) || []).length;
    const score = (titleHits * 3 + bodyHits) * weight;
    if (score > bestScore) { bestScore = score; best = cat; }
  }
  return best || 'Confessions';
}

module.exports = { infer };
