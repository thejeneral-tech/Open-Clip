'use strict';
// RSS / Atom feed ingestion (spec §2). Pure-regex parser (no XML dependency) — good
// enough for the title/description/link fields we need. Used only where a feed is
// publicly offered.
const text = require('../../util/text');

function decodeEntities(s) {
  return String(s || '')
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'").replace(/&apos;/g, "'").replace(/&amp;/g, '&')
    .replace(/&#(\d+);/g, (_, d) => String.fromCharCode(+d))
    .replace(/\s+/g, ' ').trim();
}

function tag(block, name) {
  const m = block.match(new RegExp(`<${name}[^>]*>([\\s\\S]*?)</${name}>`, 'i'));
  return m ? decodeEntities(m[1]) : '';
}

async function fetchFeed(url, { limit = 25, category = null } = {}) {
  let res;
  try {
    res = await fetch(url, { headers: { 'User-Agent': 'StoryVaultVideoFactory/1.0', Accept: 'application/rss+xml, application/xml, text/xml' } });
  } catch (e) {
    throw new Error(`The RSS feed could not be reached (${e.message}).`);
  }
  if (!res.ok) throw new Error(`The RSS feed responded with HTTP ${res.status}.`);
  const xml = await res.text();
  const items = xml.match(/<item[\s\S]*?<\/item>/gi) || xml.match(/<entry[\s\S]*?<\/entry>/gi) || [];
  const out = [];
  for (const it of items.slice(0, limit)) {
    const title = tag(it, 'title');
    const body = tag(it, 'content:encoded') || tag(it, 'description') || tag(it, 'summary') || tag(it, 'content');
    const linkMatch = it.match(/<link[^>]*href="([^"]+)"/i);
    const link = linkMatch ? linkMatch[1] : tag(it, 'link');
    const pub = tag(it, 'pubDate') || tag(it, 'published') || tag(it, 'updated');
    if (!body || body.length < 60) continue;
    let createdUtc = Math.floor(Date.now() / 1000);
    const d = pub ? Date.parse(pub) : NaN;
    if (!Number.isNaN(d)) createdUtc = Math.floor(d / 1000);
    out.push({
      source_type: 'rss', external_id: link || title, url: link || url,
      title: title || text.truncate(body, 90), body,
      author: null, community: hostOf(url), category,
      created_utc: createdUtc, upvotes: 0, num_comments: 0, upvote_ratio: null, awards: 0,
    });
  }
  return out;
}

function hostOf(u) { try { return new URL(u).hostname.replace(/^www\./, ''); } catch { return 'RSS'; } }

module.exports = { fetchFeed };
