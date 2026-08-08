/**
 * Eilatan Lingo — background service worker.
 *
 * The dumb pipe. Content scripts ask, it fetches Google's free translate
 * endpoint, caches everything, and answers. No API keys. No account. Just
 * abuse, lovingly rate-limited.
 */

'use strict';

const TLX = 'https://translate.googleapis.com/translate_a/single?client=gtx';
const TTL = 24 * 60 * 60 * 1000;          // cache entries live 24h
const MAX_CACHE = 5000;                    // keep the poor storage.local sane
const CONCURRENCY = 5;                     // parallel fetches, don't be greedy

const CACHE = new Map();                   // key -> { tx, det, t }
const TARGET_TTL = 7 * 24 * 60 * 60 * 1000; // remember a site's language for a week
const TARGETS = new Map();                 // origin -> { code, t }
let cacheDirty = false;

// ---------------------------------------------------------------------------
// Cache bootstrap + persistence
// ---------------------------------------------------------------------------
chrome.storage.local.get(['etrCache', 'etrTargets'], (v) => {
  const c = v.etrCache || {};
  for (const k of Object.keys(c)) {
    if (Date.now() - c[k].t < TTL) CACHE.set(k, c[k]);
  }
  const t = v.etrTargets || {};
  for (const origin of Object.keys(t)) {
    if (Date.now() - t[origin].t < TARGET_TTL) TARGETS.set(origin, t[origin]);
  }
});

function persistTargets() {
  chrome.storage.local.set({ etrTargets: Object.fromEntries(TARGETS) }).catch(() => {});
}

function cacheKey(from, to, text) {
  return `${from}\u0001${to}\u0001${text}`;
}

function persistCache() {
  if (!cacheDirty) return;
  cacheDirty = false;
  if (CACHE.size > MAX_CACHE) {
    // Map preserves insertion order — drop the oldest.
    const excess = CACHE.size - MAX_CACHE;
    let i = 0;
    for (const k of CACHE.keys()) {
      if (i++ >= excess) break;
      CACHE.delete(k);
    }
  }
  chrome.storage.local.set({ etrCache: Object.fromEntries(CACHE) }).catch(() => {});
}
setInterval(persistCache, 10 * 1000);

// ---------------------------------------------------------------------------
// The actual abuse
// ---------------------------------------------------------------------------
async function googleSingle(text, from, to) {
  // One request per text (max ~4500 chars) so the 1:1 mapping stays honest.
  const chunks = [];
  for (let i = 0; i < text.length; i += 4500) chunks.push(text.slice(i, i + 4500));

  let full = '';
  let det = '';
  for (const chunk of chunks) {
    const url = `${TLX}&sl=${encodeURIComponent(from)}&tl=${encodeURIComponent(to)}&dt=t&q=${encodeURIComponent(chunk)}`;
    const res = await fetch(url);
    if (!res.ok) throw new Error(`translate http ${res.status}`);
    const data = await res.json();
    const segs = data[0];
    if (Array.isArray(segs)) full += segs.map((s) => (s && s[0]) || '').join('');
    if (!det && data[2]) det = data[2];
  }
  return { tx: full, det };
}

function normalizeCode(raw) {
  if (!raw) return '';
  const l = String(raw).toLowerCase();
  if (l.startsWith('zh-hans') || l === 'zh' || l.startsWith('zh-cn')) return 'zh-CN';
  if (l.startsWith('zh-hant') || l.startsWith('zh-tw')) return 'zh-TW';
  if (l.startsWith('pt')) return 'pt';
  const m = l.match(/^[a-z]{2}/);
  return m ? m[0] : '';
}

/**
 * Translate a batch of strings.
 * Returns { translations: string[], detected?: string, detections?: string[] }.
 * `detected` is the source language of the first string; `detections` is the
 * per-string source language (only filled when wantDetect is true).
 */
async function translateAll(texts, from, to, wantDetect) {
  const out = new Array(texts.length);
  const dets = new Array(texts.length).fill('');
  const queue = [];

  texts.forEach((t, i) => {
    const k = cacheKey(from, to, t);
    const hit = CACHE.get(k);
    if (hit) {
      out[i] = hit.tx;
      dets[i] = hit.det;
    } else {
      queue.push({ i, t, k });
    }
  });

  let cursor = 0;
  async function worker() {
    while (cursor < queue.length) {
      const { i, t, k } = queue[cursor++];
      try {
        const r = await googleSingle(t, from, to);
        out[i] = r.tx;
        dets[i] = r.det || '';
        CACHE.set(k, { tx: r.tx, det: dets[i], t: Date.now() });
        cacheDirty = true;
      } catch (e) {
        out[i] = '';
      }
    }
  }

  const workers = Math.min(CONCURRENCY, queue.length);
  if (workers > 0) await Promise.all(Array.from({ length: workers }, worker));

  const resp = { translations: out };
  if (wantDetect) {
    resp.detected = normalizeCode(dets[0]);
    resp.detections = dets.map(normalizeCode);
  }
  return resp;
}

/**
 * Resolve the language a given site should be treated as.
 * Autodetect chain: per-origin memory → Google sniffing of the sample text.
 */
async function resolveTarget(origin, sample) {
  const key = origin || 'global';
  const mem = TARGETS.get(key);
  if (mem && Date.now() - mem.t < TARGET_TTL) return { detected: mem.code, cached: true };

  const det = await detectLang(sample || '');
  if (det.detected) {
    TARGETS.set(key, { code: det.detected, t: Date.now() });
    persistTargets();
  }
  return { detected: det.detected, cached: false };
}

async function detectLang(text) {
  const key = 'det:' + text.slice(0, 300);
  const hit = CACHE.get(key);
  if (hit) return { detected: hit.det };
  try {
    const r = await googleSingle(text.slice(0, 900), 'auto', 'en');
    const det = normalizeCode(r.det);
    CACHE.set(key, { tx: '', det, t: Date.now() });
    cacheDirty = true;
    return { detected: det };
  } catch {
    return { detected: '' };
  }
}

// ---------------------------------------------------------------------------
// Message plumbing
// ---------------------------------------------------------------------------
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || typeof msg !== 'object') return;
  if (msg.type === 'translate') {
    const from = typeof msg.from === 'string' && msg.from ? msg.from : 'auto';
    const to = typeof msg.to === 'string' && msg.to ? msg.to : 'en';
    translateAll(Array.isArray(msg.texts) ? msg.texts : [String(msg.texts ?? '')], from, to, !!msg.detect)
      .then(sendResponse)
      .catch((e) => sendResponse({ error: String(e) }));
    return true; // async response
  }
  if (msg.type === 'detect') {
    detectLang(String(msg.text || ''))
      .then(sendResponse)
      .catch(() => sendResponse({ detected: '' }));
    return true;
  }
  if (msg.type === 'resolveTarget') {
    resolveTarget(String(msg.origin || ''), String(msg.sample || ''))
      .then(sendResponse)
      .catch(() => sendResponse({ detected: '' }));
    return true;
  }
});

// ---------------------------------------------------------------------------
// Keyboard commands (Alt+Shift+T / Alt+Shift+Y)
// ---------------------------------------------------------------------------
async function flipSetting(key, tabId) {
  const { eilatanLingo } = await chrome.storage.local.get('eilatanLingo');
  const s = { ...(eilatanLingo || {}) };
  s[key] = !s[key];
  await chrome.storage.local.set({ eilatanLingo: s });
  if (tabId !== undefined) {
    chrome.tabs.sendMessage(tabId, { type: 'settingsChanged', settings: s }).catch(() => {});
  }
}

chrome.commands.onCommand.addListener((cmd, tab) => {
  if (!tab || tab.id === undefined) return;
  if (cmd === 'toggle-page-translation') flipSetting('pageOn', tab.id);
  if (cmd === 'toggle-input-translation') flipSetting('inputOn', tab.id);
});
