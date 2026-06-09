'use strict';
// Discovery orchestrator (spec §3). Turns a search request into normalized
// candidates from the chosen source(s), applies pre-ingest hard filters, then
// hands off to stories.ingest() for analysis/scoring/dedup/persistence.
const db = require('../db/database');
const { id } = require('../util/ids');
const reddit = require('./sources/reddit');
const quora = require('./sources/quora');
const rss = require('./sources/rss');
const textImport = require('./sources/textImport');
const stories = require('./stories');
const log = require('./logger');

async function gatherCandidates(params) {
  const {
    source = 'reddit', communities = [], keyword = '', dateRange = 'month',
    sort = 'popular', limit = 50, feedUrls = [], urls = [], pastedText = '', category = null,
  } = params;

  const want = Math.min(200, Math.max(1, Number(limit) || 50));
  let candidates = [];

  if (source === 'reddit' || source === 'multiple') {
    const subs = communities.length ? communities : [];
    for (const sub of subs) {
      log.activity('STORIES', `Searching ${reddit.cleanSub(sub) ? 'r/' + reddit.cleanSub(sub) : sub}`);
      try {
        const got = await reddit.fetchCommunity(sub, { sort, dateRange, keyword, limit: Math.ceil(want / Math.max(1, subs.length)) + 5 });
        candidates.push(...got);
      } catch (e) {
        log.error('STORIES', `r/${reddit.cleanSub(sub)}: ${e.message}`);
        params._errors = params._errors || [];
        params._errors.push(e.message);
      }
    }
  }

  if (source === 'reddit_url' || source === 'multiple') {
    for (const u of urls) {
      try { candidates.push(await reddit.fetchPost(u)); }
      catch (e) { log.error('STORIES', e.message); params._errors = (params._errors || []).concat(e.message); }
    }
  }

  if (source === 'rss' || source === 'multiple') {
    for (const u of feedUrls) {
      try { candidates.push(...await rss.fetchFeed(u, { limit: want, category })); }
      catch (e) { log.error('STORIES', e.message); params._errors = (params._errors || []).concat(e.message); }
    }
  }

  // Quora public question URLs (parsed from embedded schema.org data; no login/scraping).
  if (source === 'quora' || source === 'quora_url' || source === 'multiple') {
    for (const u of urls) {
      if (!/quora\.com/i.test(u)) continue;
      log.activity('STORIES', `Reading Quora question ${u}`);
      try { candidates.push(await quora.fetchQuestion(u)); }
      catch (e) { log.error('STORIES', e.message); params._errors = (params._errors || []).concat(e.message); }
    }
  }

  if (source === 'pasted' || source === 'quora_url' || source === 'website') {
    if (pastedText && pastedText.trim()) {
      candidates.push(...textImport.fromPasted(pastedText, {
        source_type: source === 'pasted' ? 'pasted' : source,
        url: params.url || null, category,
      }));
    }
  }

  return candidates;
}

function applyHardFilters(candidates, params) {
  const { minUpvotes = 0, minComments = 0, minLength = 0, maxLength = 0 } = params;
  return candidates.filter((c) => {
    const len = (c.body || '').length;
    if (minUpvotes && (c.upvotes || 0) < minUpvotes) return false;
    if (minComments && (c.num_comments || 0) < minComments) return false;
    if (minLength && len < minLength) return false;
    if (maxLength && maxLength > 0 && len > maxLength) return false;
    return true;
  });
}

async function search(params) {
  log.activity('STORIES', `Discovery started (source=${params.source || 'reddit'})`);
  let candidates = await gatherCandidates(params);
  log.activity('STORIES', `${candidates.length} raw results found`);

  // De-duplicate within this batch by external id / url before ingest.
  const seen = new Set();
  candidates = candidates.filter((c) => {
    const key = c.external_id || c.url || c.title;
    if (seen.has(key)) return false; seen.add(key); return true;
  });

  candidates = applyHardFilters(candidates, params);
  if (params.minScore == null && params.categories) { /* category filter applied post-score below */ }

  const { stories: saved, duplicates, filtered } = stories.ingest(candidates, {
    sort: params.sort, sourceType: params.source, sourceLabel: describe(params), url: params.url,
    applyPrefs: params.applyPrefs,
  });

  // Post-score filters: category whitelist + min overall score.
  let result = saved;
  if (params.categories && params.categories.length) {
    result = result.filter((s) => params.categories.includes(s.category));
  }
  if (params.minScore) result = result.filter((s) => s.score_overall >= params.minScore);

  result = stories.sortStories(result, params.sort);
  if (params.limit) result = result.slice(0, Number(params.limit));

  log.activity('STORIES', `${duplicates} duplicates flagged`, { level: duplicates ? 'warn' : 'info' });
  log.activity('STORIES', `${result.length} high-quality stories selected`, { level: 'success' });

  const searchId = id('search');
  db.insert('searches', {
    id: searchId, params: JSON.stringify(params), result_ids: JSON.stringify(result.map((s) => s.id)),
    count: result.length, saved: 0, name: params.name || null, created_at: db.nowIso(),
  });

  return { searchId, stories: result, total: saved.length, duplicates, filtered, errors: params._errors || [] };
}

function describe(params) {
  if (params.communities && params.communities.length) return params.communities.join(', ');
  if (params.source === 'rss') return (params.feedUrls || []).join(', ');
  return params.source || 'discovery';
}

function saveSearch(searchId, name) {
  db.update('searches', searchId, { saved: 1, name });
  return db.get('SELECT * FROM searches WHERE id = ?', [searchId]);
}

function listSearches() { return db.all('SELECT * FROM searches ORDER BY created_at DESC LIMIT 100'); }

module.exports = { search, gatherCandidates, applyHardFilters, saveSearch, listSearches };
