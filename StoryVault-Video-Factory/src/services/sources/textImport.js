'use strict';
// Manual / file-based story import (spec §2): pasted text, .txt, .csv, .json,
// Quora URLs and arbitrary website URLs (pasted text, since we must not scrape
// behind auth/anti-bot). Everything is labelled as a user-submitted/internet story.
const fs = require('node:fs');
const text = require('../../util/text');

// Pasted free text → one or more stories. A line of "---" separates multiple.
function fromPasted(raw, meta = {}) {
  const blocks = String(raw || '').split(/\n\s*-{3,}\s*\n/).map((b) => b.trim()).filter(Boolean);
  return blocks.map((block) => makeStory(block, meta));
}

function makeStory(block, meta = {}) {
  const lines = block.split('\n');
  let title = meta.title || '';
  let body = block;
  // If a "Title:" prefix or a short first line is present, treat it as the title.
  if (/^title\s*:/i.test(lines[0])) {
    title = lines[0].replace(/^title\s*:/i, '').trim();
    body = lines.slice(1).join('\n').trim();
  } else if (lines.length > 1 && lines[0].length <= 120 && lines[1] === '') {
    title = lines[0].trim();
    body = lines.slice(1).join('\n').trim();
  }
  if (!title) title = text.truncate(text.sentences(body)[0] || block, 90);
  return {
    source_type: meta.source_type || 'pasted',
    external_id: null,
    url: meta.url || null,
    title,
    body,
    author: meta.author || null,
    community: meta.community || (meta.source_type === 'quora_url' ? 'Quora' : 'User submitted'),
    category: meta.category || null,
    created_utc: Math.floor(Date.now() / 1000),
    upvotes: Number(meta.upvotes) || 0,
    num_comments: Number(meta.num_comments) || 0,
    upvote_ratio: null,
    awards: 0,
  };
}

function fromTxt(filePath, meta = {}) {
  const raw = fs.readFileSync(filePath, 'utf8');
  return fromPasted(raw, { ...meta, source_type: 'file' });
}

// Minimal RFC-4180-ish CSV parser (handles quoted fields, commas, newlines).
function parseCsv(raw) {
  const rows = [];
  let row = [], field = '', inQuotes = false;
  for (let i = 0; i < raw.length; i++) {
    const c = raw[i];
    if (inQuotes) {
      if (c === '"') {
        if (raw[i + 1] === '"') { field += '"'; i++; } else inQuotes = false;
      } else field += c;
    } else if (c === '"') inQuotes = true;
    else if (c === ',') { row.push(field); field = ''; }
    else if (c === '\r') { /* skip */ }
    else if (c === '\n') { row.push(field); rows.push(row); row = []; field = ''; }
    else field += c;
  }
  if (field.length || row.length) { row.push(field); rows.push(row); }
  return rows.filter((r) => r.length && r.some((x) => x.trim() !== ''));
}

// CSV with a header row. Recognised columns: title, body/story/text, author,
// url, community/subreddit, category, upvotes/score, comments.
function fromCsv(filePath, meta = {}) {
  const raw = fs.readFileSync(filePath, 'utf8');
  const rows = parseCsv(raw);
  if (!rows.length) return [];
  const header = rows[0].map((h) => h.trim().toLowerCase());
  const idx = (names) => names.map((n) => header.indexOf(n)).find((i) => i >= 0);
  const iTitle = idx(['title', 'headline']);
  const iBody = idx(['body', 'story', 'text', 'content', 'selftext']);
  const iAuthor = idx(['author', 'user']);
  const iUrl = idx(['url', 'link', 'permalink']);
  const iComm = idx(['community', 'subreddit', 'source']);
  const iCat = idx(['category', 'tag']);
  const iUp = idx(['upvotes', 'score', 'ups', 'votes']);
  const iCom = idx(['comments', 'num_comments']);
  const out = [];
  for (let r = 1; r < rows.length; r++) {
    const row = rows[r];
    const body = (iBody != null ? row[iBody] : row[row.length - 1]) || '';
    if (!body.trim()) continue;
    out.push(makeStory(body, {
      ...meta,
      source_type: 'csv',
      title: iTitle != null ? row[iTitle] : '',
      author: iAuthor != null ? row[iAuthor] : null,
      url: iUrl != null ? row[iUrl] : null,
      community: iComm != null ? row[iComm] : 'CSV import',
      category: iCat != null ? row[iCat] : null,
      upvotes: iUp != null ? row[iUp] : 0,
      num_comments: iCom != null ? row[iCom] : 0,
    }));
  }
  return out;
}

function fromJson(filePath, meta = {}) {
  const raw = fs.readFileSync(filePath, 'utf8');
  let data;
  try { data = JSON.parse(raw); } catch { throw new Error('The JSON import file is not valid JSON.'); }
  const arr = Array.isArray(data) ? data : (Array.isArray(data.stories) ? data.stories : [data]);
  return arr.map((o) => makeStory(o.body || o.text || o.story || '', {
    ...meta, source_type: 'file', title: o.title, author: o.author, url: o.url,
    community: o.community || o.subreddit, category: o.category,
    upvotes: o.upvotes || o.score, num_comments: o.comments || o.num_comments,
  })).filter((s) => s.body && s.body.trim());
}

function fromFile(filePath, originalName, meta = {}) {
  const ext = (originalName || filePath).toLowerCase().split('.').pop();
  if (ext === 'csv') return fromCsv(filePath, meta);
  if (ext === 'json') return fromJson(filePath, meta);
  return fromTxt(filePath, meta);
}

module.exports = { fromPasted, fromTxt, fromCsv, fromJson, fromFile, makeStory, parseCsv };
