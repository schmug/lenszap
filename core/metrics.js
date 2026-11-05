// SPDX-License-Identifier: Apache-2.0
//
// Zap metrics for the reader: how long scoring takes, how much was hidden,
// and how long they spent on the page, shown in the side panel's Stats tab.
//
// Everything stays in the browser. A page's numbers live in its content
// script and die with the page. The per-site rollup lives in
// chrome.storage.session (memory only, gone when the browser closes, never
// readable by pages) and holds counts and timings only: no text, no
// addresses beyond the hostname it is keyed by. Nothing is counted while
// paused, and nothing is counted in incognito.
//
// Pure and DOM-free: runs in the content script, the service worker, the
// side panel, and under Node.

/** Timing samples kept per page, per site, and for all sites. */
export const SAMPLE_LIMIT = 500;
/** First-screen samples kept per site. */
export const FIRST_SCREEN_LIMIT = 100;
/** Sites kept in the session rollup; the least recently seen goes first. */
export const SITE_LIMIT = 100;
/** Average adult silent reading speed (Brysbaert 2019), for "reading time hidden". */
export const WORDS_PER_MINUTE = 238;

/** Nearest-rank percentile of `values`, q in [0, 1]; null when empty. */
export function percentile(values, q) {
  const v = values.filter(Number.isFinite).sort((a, b) => a - b);
  if (!v.length) return null;
  const rank = Math.ceil(q * v.length);
  return v[Math.min(v.length - 1, Math.max(0, rank - 1))];
}

/** Count, mean, median, p95, and max of timing samples (ms, rounded); null when empty. */
export function summarize(values) {
  const v = values.filter(Number.isFinite);
  if (!v.length) return null;
  const r = (x) => Math.round(x);
  return {
    n: v.length,
    mean: r(v.reduce((a, b) => a + b, 0) / v.length),
    p50: r(percentile(v, 0.5)),
    p95: r(percentile(v, 0.95)),
    max: r(Math.max(...v))
  };
}

export const wordCount = (text) => (String(text ?? '').match(/[\p{L}\p{N}]+(?:['’][\p{L}]+)?/gu) ?? []).length;

/** Seconds a reader would take to read `words` words. */
export const readingSeconds = (words) => Math.round((60 * Math.max(0, words)) / WORDS_PER_MINUTE);

const push = (arr, items, limit) => {
  arr.push(...items);
  if (arr.length > limit) arr.splice(0, arr.length - limit);
};

// --- A page's numbers (held by the content script) ------------------------------

export function newPageMetrics() {
  return {
    scored: 0, // blocks given a score, by any route
    fromCache: 0, // ... of which came from the session score cache
    gated: 0, // ... of which the in-browser model settled before the model was asked
    requests: 0, // answers from the extension (model, hosted, or in-browser)
    failed: 0, // ... of which failed
    blockMs: [], // per-block scoring time, for blocks actually scored (not cache hits); the last SAMPLE_LIMIT
    samples: 0, // per-block times ever recorded on this page
    firstScreenMs: null, // LensZap start → every block on the first screen judged
    pageMs: null, // LensZap start → nothing near the screen left to judge, the first time
    clock: { ms: 0, since: null } // time on page: visible and not paused
  };
}

/**
 * One answer from the extension for `n` blocks, `ms` after it was asked.
 * `cached` of them came from the score cache and `gated` were settled by the
 * in-browser model; the rest share the time as model work.
 */
export function recordAnswer(m, { n, ms, ok = true, cached = 0, gated = 0 }) {
  m.requests++;
  if (!ok) {
    m.failed++;
    return m;
  }
  m.scored += n;
  m.fromCache += cached;
  m.gated += gated;
  const fresh = n - cached;
  if (fresh > 0 && Number.isFinite(ms)) addSamples(m, fresh, ms / fresh);
  return m;
}

/** Blocks scored straight from the session cache (no model call). */
export function recordCached(m, n) {
  m.scored += n;
  m.fromCache += n;
  return m;
}

/** Blocks scored by the word scorer, which is synchronous: `ms` for all `n`. */
export function recordLocal(m, n, ms) {
  if (n <= 0) return m;
  m.scored += n;
  if (Number.isFinite(ms)) addSamples(m, n, ms / n);
  return m;
}

function addSamples(m, n, each) {
  push(m.blockMs, Array(n).fill(each), SAMPLE_LIMIT);
  m.samples += n;
}

// The time-on-page clock runs only while the page is visible and not paused.
export function clockRun(c, running, now) {
  if (running && c.since == null) c.since = now;
  else if (!running && c.since != null) {
    c.ms += Math.max(0, now - c.since);
    c.since = null;
  }
  return c;
}
export const clockRead = (c, now) => c.ms + (c.since == null ? 0 : Math.max(0, now - c.since));

/**
 * What the side panel shows for a page. `hidden` and `hiddenWords` are the
 * blocks hidden right now and their word count.
 */
export function pageView(m, { now, blocks = 0, hidden = 0, hiddenWords = 0, adSlots = 0 }) {
  return {
    timeOnPageMs: Math.round(clockRead(m.clock, now)),
    clockRunning: m.clock.since != null,
    blocks,
    adSlots,
    scored: m.scored,
    fromCache: m.fromCache,
    gated: m.gated,
    requests: m.requests,
    failed: m.failed,
    hidden,
    hiddenWords,
    hiddenReadingSec: readingSeconds(hiddenWords),
    perBlock: summarize(m.blockMs),
    firstScreenMs: m.firstScreenMs == null ? null : Math.round(m.firstScreenMs),
    pageMs: m.pageMs == null ? null : Math.round(m.pageMs)
  };
}

/**
 * What changed since the last call, for the session rollup. `sent` is the
 * caller's own record of what it has already sent (start from {}); it is
 * updated here. Returns null when nothing changed.
 */
export function takeDelta(m, sent, { now, hidden = 0, hiddenWords = 0 }) {
  const visibleMs = Math.round(clockRead(m.clock, now));
  const d = {
    page: !sent.page,
    scored: m.scored - (sent.scored ?? 0),
    fromCache: m.fromCache - (sent.fromCache ?? 0),
    gated: m.gated - (sent.gated ?? 0),
    failed: m.failed - (sent.failed ?? 0),
    hidden: hidden - (sent.hidden ?? 0),
    hiddenWords: hiddenWords - (sent.hiddenWords ?? 0),
    visibleMs: visibleMs - (sent.visibleMs ?? 0),
    // blockMs is bounded, so count what was added, not where it ends
    blockMs: newest(m.blockMs, m.samples - (sent.samples ?? 0)),
    firstScreenMs: m.firstScreenMs != null && !sent.firstScreen ? Math.round(m.firstScreenMs) : null
  };
  // A page counts once it has been scored at all.
  if (d.page && m.scored === 0) d.page = false;
  // Time on its own is not worth a message until it has added up to a second;
  // it rides along with the next change otherwise.
  const changed = d.page || d.scored || d.fromCache || d.gated || d.failed || d.hidden || d.hiddenWords || d.blockMs.length || d.firstScreenMs != null || d.visibleMs >= 1000;
  if (!changed) return null;
  Object.assign(sent, {
    page: sent.page || d.page,
    scored: m.scored,
    fromCache: m.fromCache,
    gated: m.gated,
    failed: m.failed,
    hidden,
    hiddenWords,
    visibleMs,
    samples: m.samples,
    firstScreen: sent.firstScreen || d.firstScreenMs != null
  });
  return d;
}
const newest = (arr, n) => (n > 0 ? arr.slice(Math.max(0, arr.length - n)) : []);

// --- The session rollup (held by the service worker) ----------------------------

export const newRollup = () => ({ all: newEntry(), sites: {} });

function newEntry() {
  return { pages: 0, scored: 0, fromCache: 0, gated: 0, failed: 0, hidden: 0, hiddenWords: 0, visibleMs: 0, blockMs: [], firstScreenMs: [] };
}

function addTo(e, d) {
  if (d.page) e.pages++;
  for (const k of ['scored', 'fromCache', 'gated', 'failed', 'hidden', 'hiddenWords', 'visibleMs']) {
    e[k] = Math.max(0, e[k] + (Number.isFinite(d[k]) ? d[k] : 0));
  }
  if (Array.isArray(d.blockMs)) push(e.blockMs, d.blockMs.filter(Number.isFinite), SAMPLE_LIMIT);
  if (Number.isFinite(d.firstScreenMs)) push(e.firstScreenMs, [d.firstScreenMs], FIRST_SCREEN_LIMIT);
}

/** Add a page's delta to the rollup, under `host` and in the all-sites total. */
export function addToRollup(rollup, host, d) {
  if (!d || !host) return rollup;
  const e = rollup.sites[host] ?? newEntry();
  delete rollup.sites[host]; // re-inserted last: the most recently seen
  rollup.sites[host] = e;
  addTo(e, d);
  addTo(rollup.all, d);
  const hosts = Object.keys(rollup.sites);
  for (const h of hosts.slice(0, Math.max(0, hosts.length - SITE_LIMIT))) delete rollup.sites[h];
  return rollup;
}

/** What the side panel shows for one rollup entry. */
export function entryView(e) {
  if (!e) return null;
  return {
    pages: e.pages,
    scored: e.scored,
    fromCache: e.fromCache,
    gated: e.gated,
    failed: e.failed,
    hidden: e.hidden,
    hiddenWords: e.hiddenWords,
    hiddenReadingSec: readingSeconds(e.hiddenWords),
    visibleMs: e.visibleMs,
    perBlock: summarize(e.blockMs),
    firstScreen: summarize(e.firstScreenMs)
  };
}

/** The rollup as the side panel shows it: all sites, one site, and the sites hiding the most. */
export function rollupView(rollup, host, top = 8) {
  const sites = Object.entries(rollup.sites)
    .filter(([, e]) => e.pages > 0)
    .sort((a, b) => b[1].hidden - a[1].hidden || b[1].pages - a[1].pages)
    .slice(0, top)
    .map(([h, e]) => ({ host: h, pages: e.pages, scored: e.scored, hidden: e.hidden, p50: summarize(e.blockMs)?.p50 ?? null }));
  return { all: entryView(rollup.all), site: entryView(rollup.sites[host]), sites };
}

/** "850 ms", "1.2 s", "3m 05s", "1h 02m". */
export function formatMs(ms) {
  if (ms == null || !Number.isFinite(ms)) return '–';
  if (ms < 1000) return `${Math.round(ms)} ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(ms < 10_000 ? 1 : 0)} s`;
  const s = Math.round(ms / 1000);
  if (s < 3600) return `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, '0')}s`;
  return `${Math.floor(s / 3600)}h ${String(Math.floor((s % 3600) / 60)).padStart(2, '0')}m`;
}
