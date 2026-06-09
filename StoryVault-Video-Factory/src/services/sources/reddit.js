'use strict';
// Reddit ingestion via the PUBLIC .json endpoints (a permitted, documented access
// method — spec §2). We send a descriptive User-Agent and DO NOT bypass auth,
// anti-bot, paywalls, or rate limits. On 429/403 we surface a clear message (§22).
const constants = require('../../constants');

const UA = 'StoryVaultVideoFactory/1.0 (self-hosted; respects robots & rate limits)';

// Optional OFFICIAL OAuth access (spec §2 "Use official or permitted access methods").
// Credentials come from the encrypted Accounts store OR REDDIT_CLIENT_ID/SECRET env vars
// (create a "script" app at reddit.com/prefs/apps). Authenticated API is far more reliable
// than the anonymous .json endpoints from datacenter IPs.
const TOKEN_CACHE = { token: null, expires: 0, key: '' };

function getCreds() {
  try { const c = require('../accounts').getRedditCreds(); if (c) return c; } catch { /* accounts not loaded */ }
  if (process.env.REDDIT_CLIENT_ID && process.env.REDDIT_CLIENT_SECRET) {
    return { clientId: process.env.REDDIT_CLIENT_ID, clientSecret: process.env.REDDIT_CLIENT_SECRET, source: 'env' };
  }
  return null;
}

function hasOAuth() { return !!getCreds(); }

async function getToken() {
  const creds = getCreds();
  if (!creds) throw new Error('No Reddit credentials configured (set them on the Accounts page or via REDDIT_CLIENT_ID/SECRET).');
  const key = `${creds.clientId}:${creds.clientSecret}`;
  if (TOKEN_CACHE.token && TOKEN_CACHE.key === key && Date.now() < TOKEN_CACHE.expires - 30000) return TOKEN_CACHE.token;
  const basic = Buffer.from(key).toString('base64');
  const res = await fetch('https://www.reddit.com/api/v1/access_token', {
    method: 'POST',
    headers: { Authorization: `Basic ${basic}`, 'Content-Type': 'application/x-www-form-urlencoded', 'User-Agent': UA },
    body: 'grant_type=client_credentials',
  });
  if (!res.ok) throw new Error(`Reddit OAuth failed (HTTP ${res.status}). Check the client ID/secret on the Accounts page.`);
  const j = await res.json();
  TOKEN_CACHE.token = j.access_token;
  TOKEN_CACHE.expires = Date.now() + (j.expires_in || 3600) * 1000;
  TOKEN_CACHE.key = key;
  return TOKEN_CACHE.token;
}

// Returns the base host + auth headers for the current mode.
async function authContext() {
  if (hasOAuth()) {
    const token = await getToken();
    return { base: 'https://oauth.reddit.com', headers: { Authorization: `Bearer ${token}`, 'User-Agent': UA, Accept: 'application/json' } };
  }
  return { base: 'https://www.reddit.com', headers: { 'User-Agent': UA, Accept: 'application/json' } };
}

// Map our UI sort ids to a Reddit listing sort + a flag for client-side re-rank.
function redditSort(sortId) {
  switch (sortId) {
    case 'upvoted':
    case 'popular': return { sort: 'top', rerank: false };
    case 'rising': return { sort: 'rising', rerank: false };
    case 'commented':
    case 'engaging':
    case 'controversy': return { sort: 'top', rerank: true };
    default: return { sort: 'top', rerank: true }; // storytelling/short_video/emotional/hidden_gems
  }
}

function timeParam(dateRange) {
  const ok = ['hour', 'day', 'week', 'month', 'year', 'all'];
  return ok.includes(dateRange) ? dateRange : 'month';
}

async function fetchJson(url, headers) {
  let res;
  try {
    res = await fetch(url, { headers: headers || { 'User-Agent': UA, Accept: 'application/json' } });
  } catch (e) {
    throw new Error(`The Reddit request failed because the source could not be reached (${e.message}).`);
  }
  if (res.status === 429) throw new Error('Reddit is rate-limiting requests right now. Wait a minute and try again, or paste the post URL/text manually.');
  if (res.status === 403) {
    throw new Error(hasOAuth()
      ? 'Reddit refused the request (403). The community may be private/quarantined.'
      : 'Reddit blocked anonymous access (403). Add REDDIT_CLIENT_ID/REDDIT_CLIENT_SECRET for official API access, or paste the post URL/story text manually.');
  }
  if (res.status === 404) throw new Error('That Reddit community or post was not found (404).');
  if (!res.ok) throw new Error(`Reddit responded with HTTP ${res.status}.`);
  try { return await res.json(); } catch { throw new Error('Reddit returned an unexpected (non-JSON) response.'); }
}

function cleanSub(name) {
  return String(name || '').trim().replace(/^\/?r\//i, '').replace(/[^A-Za-z0-9_]/g, '');
}

function categoryForSub(sub) {
  return constants.SUBREDDIT_CATEGORY[String(sub || '').toLowerCase()] || 'AITA';
}

function normalizePost(child) {
  const d = child.data || {};
  if (d.stickied || d.removed_by_category || d.pinned) return null;
  const body = (d.selftext || '').trim();
  if (!d.is_self || body.length < 80) return null; // need actual story text
  if (body === '[removed]' || body === '[deleted]') return null;
  return {
    source_type: 'reddit',
    external_id: d.id,
    url: 'https://www.reddit.com' + (d.permalink || ''),
    title: (d.title || '').trim(),
    body,
    author: d.author && d.author !== '[deleted]' ? d.author : null,
    community: d.subreddit ? 'r/' + d.subreddit : null,
    category: categoryForSub(d.subreddit),
    created_utc: d.created_utc ? Math.floor(d.created_utc) : null,
    upvotes: d.ups != null ? d.ups : (d.score || 0),
    num_comments: d.num_comments || 0,
    upvote_ratio: d.upvote_ratio != null ? d.upvote_ratio : null,
    awards: d.total_awards_received || 0,
    over18: !!d.over_18,
  };
}

// Search a single community. Returns an array of normalized story candidates.
async function fetchCommunity(community, { sort = 'popular', dateRange = 'month', limit = 50, keyword = '' } = {}) {
  const sub = cleanSub(community);
  if (!sub) return [];
  const { sort: rsort } = redditSort(sort);
  const { base, headers } = await authContext();
  let url;
  if (keyword && keyword.trim()) {
    const q = encodeURIComponent(keyword.trim());
    url = `${base}/r/${sub}/search.json?q=${q}&restrict_sr=1&sort=top&t=${timeParam(dateRange)}&limit=${Math.min(100, limit)}&raw_json=1`;
  } else {
    url = `${base}/r/${sub}/${rsort}.json?limit=${Math.min(100, limit)}&t=${timeParam(dateRange)}&raw_json=1`;
  }
  const json = await fetchJson(url, headers);
  const children = json?.data?.children || [];
  return children.map(normalizePost).filter(Boolean);
}

// Fetch a single post by full URL or id (spec §2 "Reddit post URLs").
async function fetchPost(urlOrId) {
  const { base, headers } = await authContext();
  let url = String(urlOrId).trim();
  if (/^[a-z0-9]{5,8}$/i.test(url)) url = `${base}/comments/${url}.json`;
  else {
    // keep only the path portion, then re-root on the active base host
    let pathPart = url.replace(/^https?:\/\/[^/]+/i, '').replace(/\?.*$/, '').replace(/\/?$/, '');
    if (!pathPart.endsWith('.json')) pathPart += '.json';
    url = base + (pathPart.startsWith('/') ? '' : '/') + pathPart;
  }
  const json = await fetchJson(url + '?raw_json=1', headers);
  const listing = Array.isArray(json) ? json[0] : json;
  const child = listing?.data?.children?.[0];
  if (!child) throw new Error('Could not read that Reddit post.');
  // For single posts we relax the length filter (user explicitly asked for it).
  const d = child.data || {};
  const norm = normalizePost(child) || {
    source_type: 'reddit', external_id: d.id, url: 'https://www.reddit.com' + (d.permalink || ''),
    title: (d.title || '').trim(), body: (d.selftext || '').trim(), author: d.author,
    community: d.subreddit ? 'r/' + d.subreddit : null, category: categoryForSub(d.subreddit),
    created_utc: d.created_utc ? Math.floor(d.created_utc) : null, upvotes: d.ups || d.score || 0,
    num_comments: d.num_comments || 0, upvote_ratio: d.upvote_ratio, awards: d.total_awards_received || 0,
  };
  if (!norm.body || norm.body.length < 20) throw new Error('That Reddit post has no usable story text (it may be an image/link post).');
  return norm;
}

module.exports = { fetchCommunity, fetchPost, cleanSub, categoryForSub, redditSort, hasOAuth };
