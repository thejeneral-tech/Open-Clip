'use strict';
// Quora ingestion from PUBLIC question URLs (spec §2 "Quora question URL"). We fetch
// the public page and parse the schema.org QAPage JSON-LD that Quora embeds — a
// permitted, documented access method. We DO NOT log in, scrape behind auth, bypass
// anti-bot/CAPTCHA, or collect passwords. If the public page can't be parsed (login
// wall / bot block), we throw a clear message pointing the user to manual paste.
const text = require('../../util/text');

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) StoryVaultVideoFactory/1.0 (+self-hosted; respects robots & rate limits)';

function stripHtml(s) {
  return String(s || '')
    .replace(/<br\s*\/?>/gi, ' ')
    .replace(/<\/(p|div|li|h[1-6])>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'").replace(/&apos;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
}

// All <script type="application/ld+json"> payloads, parsed (malformed ones skipped).
function extractJsonLd(html) {
  const blocks = [];
  const re = /<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
  let m;
  while ((m = re.exec(html))) {
    try { blocks.push(JSON.parse(m[1].trim())); } catch { /* skip malformed block */ }
  }
  return blocks;
}

function findQuestion(blocks) {
  for (const b of blocks) {
    for (const node of (Array.isArray(b) ? b : [b])) {
      if (!node || typeof node !== 'object') continue;
      const type = node['@type'];
      if (type === 'Question') return node;
      if ((type === 'QAPage' || node.mainEntity) && node.mainEntity && node.mainEntity['@type'] === 'Question') {
        return node.mainEntity;
      }
    }
  }
  return null;
}

// Prefer the accepted answer, else the highest-upvoted suggested answer.
function bestAnswer(q) {
  if (q.acceptedAnswer) return Array.isArray(q.acceptedAnswer) ? q.acceptedAnswer[0] : q.acceptedAnswer;
  let cands = q.suggestedAnswer || q.answer || [];
  if (!Array.isArray(cands)) cands = [cands];
  cands = cands.filter(Boolean);
  if (!cands.length) return null;
  cands.sort((a, b) => (Number(b.upvoteCount) || 0) - (Number(a.upvoteCount) || 0));
  return cands[0];
}

function metaTag(html, prop) {
  const m = html.match(new RegExp(`<meta[^>]+(?:property|name)=["']${prop}["'][^>]+content=["']([^"']*)["']`, 'i'))
    || html.match(new RegExp(`<meta[^>]+content=["']([^"']*)["'][^>]+(?:property|name)=["']${prop}["']`, 'i'));
  return m ? m[1] : null;
}

function quoraId(url) {
  try { return new URL(url).pathname.replace(/\/+$/, '').split('/').filter(Boolean).pop() || null; } catch { return null; }
}

// Pure parser — testable offline against a saved fixture (no network).
function parseQuoraHtml(html, url = null) {
  const q = findQuestion(extractJsonLd(html));
  let title = stripHtml((q && q.name) || metaTag(html, 'og:title') || '').replace(/\s*[-–]\s*Quora\s*$/i, '').trim();
  const ans = q ? bestAnswer(q) : null;
  let body = ans && ans.text ? stripHtml(ans.text) : '';
  if (!body) {
    const desc = metaTag(html, 'og:description') || metaTag(html, 'description');
    if (desc) body = stripHtml(desc);
  }
  if (!title && !body) {
    throw new Error('Could not read this Quora question from the public page (Quora may require login or blocked the request). Use "Paste Quora story" instead.');
  }
  if (!body || body.length < 40) {
    throw new Error('Quora returned only a short preview, not the full answer (login wall / bot block). Use "Paste Quora story" instead.');
  }
  const author = ans && ans.author ? (typeof ans.author === 'string' ? ans.author : ans.author.name) : null;
  const upvotes = ans && ans.upvoteCount != null ? (Number(ans.upvoteCount) || 0) : 0;
  const created = (ans && ans.dateCreated) || (q && q.dateCreated) || null;
  let createdUtc = Math.floor(Date.now() / 1000);
  if (created) { const t = Math.floor(new Date(created).getTime() / 1000); if (t) createdUtc = t; }
  return {
    source_type: 'quora',
    external_id: url ? quoraId(url) : null,
    url,
    title: title || text.truncate(text.sentences(body)[0] || body, 90),
    body,
    author: author || null,
    community: 'Quora',
    category: null,
    created_utc: createdUtc,
    upvotes,                 // real upvote count when present → scoring marks it "estimated"
    num_comments: 0,         // Quora has no comparable public comment count → unavailable
    upvote_ratio: null,
    awards: 0,
    answer_count: (q && Number(q.answerCount)) || null,
  };
}

// Fetch a public Quora question URL and parse it. Best-effort: a login wall / bot block
// yields a clear, actionable error (manual paste still works).
async function fetchQuestion(url) {
  const u = String(url || '').trim();
  if (!/quora\.com/i.test(u)) throw new Error('That does not look like a Quora URL.');
  let res;
  try {
    res = await fetch(u, { headers: { 'User-Agent': UA, Accept: 'text/html,application/xhtml+xml', 'Accept-Language': 'en-US,en;q=0.9' } });
  } catch (e) {
    throw new Error(`The Quora request failed because the page could not be reached (${e.message}). Use "Paste Quora story" instead.`);
  }
  if (res.status === 429) throw new Error('Quora is rate-limiting requests right now. Wait a minute, or use "Paste Quora story".');
  if (res.status === 403) throw new Error('Quora blocked the request (403). Use "Paste Quora story" instead.');
  if (res.status === 404) throw new Error('That Quora question was not found (404).');
  if (!res.ok) throw new Error(`Quora responded with HTTP ${res.status}. Use "Paste Quora story" instead.`);
  return parseQuoraHtml(await res.text(), u);
}

module.exports = { fetchQuestion, parseQuoraHtml, stripHtml, extractJsonLd };
