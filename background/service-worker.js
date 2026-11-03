// SPDX-License-Identifier: Apache-2.0
//
// Background host for the LensPub Zapper.
//
// Owns everything the zapper stores, all in chrome.storage.local and never
// synced:
//   lens         the reader's Lens Manifest (shareable, history-free)
//   draftWeights interest-slider positions not yet saved into the lens
//   settings     confidence threshold, scorer choice, and the browser-wide pause
//   sites        per-site pause and threshold, keyed by hostname
//   training     the reader's Keep/Zap marks: scores only, no text, no URLs
//   hostedKeys   API keys for hosted scorers, by provider; never sent to pages
//                or the side panel, never exported
// Only `lens` is ever exported. draftWeights, sites, and training are Adaptation State in
// the protocol's sense (ADR-0006): local, private, and never written into the
// manifest, because a hostname next to a preference is reading history.
//
// Network: with the lexical scorer (the default) the zapper makes no requests.
// With the model scorer it makes requests to one endpoint on this machine
// (llama-server's /v1/systemone for decision models, or a chat API)
// (localhost or 127.0.0.1, enforced in core/model-scorer.js); nothing ever
// leaves the device. The other fetch() here loads the bundled sample lens
// from the extension's own package.
//
// The exception the reader opts into: the hosted scorer (core/hosted.js), with
// the reader's own key. Block text then goes to that one provider, over https,
// only after the reader granted its host in Settings, never on a site they
// kept off it, and never while paused.

import { commitDraft, commitEdit, validateLens, unsupportedFeatures } from '../core/lens-edit.js';
import { scoreWithEndpoint, modelScorerId } from '../core/model-scorer.js';
import { badgeFor, isPausedOn } from '../core/pause.js';
import { DEFAULT_HOSTED, hostedTarget, hostedOrigin, hostedScorerId, effectiveScorer, withRetry, HOSTED_PROVIDERS } from '../core/hosted.js';

// Default zap threshold per scorer. The word-only scorer's confidence is coarse,
// so it waits for 80%. For a model, the first eval (Kev-4B, 508 labelled
// blocks) found 60-65% the best balance: 80% left over half of what should go.
const DEFAULT_THRESHOLD = { lexical: 0.8, model: 0.65, hosted: 0.65 };

const DEFAULT_SETTINGS = {
  threshold: DEFAULT_THRESHOLD.lexical,
  scorer: 'lexical',
  // Blocks that match none of your interests: kept unless they match a "less
  // of this" interest. true hides them too (the zapper's original behaviour).
  hideUnmatched: false,
  // Display: score popover on hover, scoring and zapping animations, sidebar state.
  hoverInfo: true,
  animate: true,
  sidebarCollapsed: false,
  // Browser-wide pause: nothing is hidden on any site. Per-site pauses are in `sites`.
  paused: false,
  // llama-server's decision endpoint; the model is whatever llama-server loaded.
  // concurrency: requests in flight at once (match llama-server's --parallel).
  model: { api: 'systemone', endpoint: 'http://127.0.0.1:8080', model: '', concurrency: 4 },
  // Hosted scorer, bring your own key (core/hosted.js). Used only when
  // scorer is 'hosted'. The key is kept apart, in hostedKeys.
  hosted: DEFAULT_HOSTED
};

async function bundledLens() {
  const res = await fetch(chrome.runtime.getURL('lenses/sample-lens.json'));
  return res.json();
}

async function load() {
  const s = await chrome.storage.local.get(['lens', 'draftWeights', 'settings', 'sites']);
  return {
    lens: s.lens ?? (await bundledLens()),
    draftWeights: s.draftWeights ?? {},
    settings: {
      ...DEFAULT_SETTINGS,
      ...(s.settings ?? {}),
      model: { ...DEFAULT_SETTINGS.model, ...(s.settings?.model ?? {}) },
      hosted: { ...DEFAULT_SETTINGS.hosted, ...(s.settings?.hosted ?? {}) }
    },
    sites: s.sites ?? {}
  };
}

const sha256 = (bytes) => crypto.subtle.digest('SHA-256', bytes);
const TRAINING_LIMIT = 500;

// Model scores, keyed by a hash of model, topics, and block text, so an
// unchanged block is never sent to the model twice. Kept in
// chrome.storage.session: it outlives this service worker (which Chrome stops
// after about 30 seconds idle) but lives in memory only and is gone when the
// browser closes. Never written to disk, not even as hashes: a saved list of
// block hashes would be a record of what was read. Values are scores only.
const scoreCache = new Map();
const CACHE_LIMIT = 4000;
const CACHE_KEY = 'scoreCache';
let cacheLoaded = null;
let cacheSaveTimer = null;
function loadCache() {
  cacheLoaded ??= (async () => {
    try {
      const { [CACHE_KEY]: saved } = (await chrome.storage.session?.get(CACHE_KEY)) ?? {};
      if (Array.isArray(saved)) for (const [k, v] of saved) if (!scoreCache.has(k)) scoreCache.set(k, v);
    } catch {}
  })();
  return cacheLoaded;
}
function saveCacheSoon() {
  clearTimeout(cacheSaveTimer);
  cacheSaveTimer = setTimeout(() => {
    chrome.storage.session?.set({ [CACHE_KEY]: [...scoreCache] }).catch(() => {});
  }, 500);
}

function cacheKey(settings, topics, text) {
  let h = 0x811c9dc5;
  const s = `${modelScorerId(settings)}\u0000${topics.join('\u0001')}\u0000${text}`;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return `${h.toString(16)}:${s.length}`;
}

// The last few model failures, in memory only, for the side panel's debug
// report. No page text: the endpoint, the error, and how long it took.
const recentErrors = [];
function noteError(m, err, ms, blocks) {
  recentErrors.push({ at: new Date().toISOString(), api: m.api, endpoint: m.endpoint, blocks, ms, error: String(err?.message ?? err).slice(0, 300) });
  if (recentErrors.length > 20) recentErrors.shift();
}

// Model requests in flight, by the site they score for, so a pause can cancel
// them. A pause (everywhere or on one site) aborts that site's requests at
// once, and score-model refuses new ones while paused, so a page that has not
// yet heard about the pause cannot start the model either.
const inFlight = new Map(); // AbortController → host
async function abortPausedRequests() {
  if (!inFlight.size) return;
  const { settings, sites } = await load();
  for (const [ctl, host] of inFlight) if (isPausedOn(settings, sites, host)) ctl.abort(new Error('paused'));
}

async function hostedKey(provider) {
  const { hostedKeys = {} } = await chrome.storage.local.get('hostedKeys');
  return hostedKeys[provider] ?? '';
}

// What scores blocks for these settings: the local endpoint, or the hosted
// target with the reader's key. Throws if hosted is chosen but not set up, or
// its host permission was not granted.
async function activeModel(settings) {
  if (settings.scorer !== 'hosted') return settings.model;
  const target = hostedTarget(settings.hosted, await hostedKey(settings.hosted.provider));
  const origin = hostedOrigin(settings.hosted);
  if (!origin || !(await chrome.permissions.contains({ origins: [origin] }))) {
    throw new Error(`LensZap has no access to ${origin ?? 'the hosted endpoint'}. Save the hosted settings again to grant it.`);
  }
  return target;
}

// Settings without anything secret, for the cache key and errors.
const scorerOnly = (settings) => (settings.scorer === 'hosted' ? hostedTargetId(settings) : settings.model);
const hostedTargetId = (settings) => {
  const p = HOSTED_PROVIDERS[settings.hosted.provider];
  const model = settings.hosted.model || p?.defaultModel || 'default';
  return { api: p?.api ?? 'hosted', model, endpoint: p?.label ?? 'hosted', scorerId: hostedScorerId(settings.hosted) };
};

async function scoreWithModel(blocks, topics, host = null) {
  const { settings, sites } = await load();
  if (host != null && isPausedOn(settings, sites, host)) return { paused: true, scores: [] };
  // A site kept off the hosted model sends nothing, even if a page asks.
  if (host != null && effectiveScorer(settings, sites[host]) === 'none') return { scores: [], scorer: 'none' };
  const id = scorerOnly(settings);
  let m;
  try {
    m = await activeModel(settings);
  } catch (err) {
    noteError(id, err, 0, blocks.length);
    throw err;
  }
  const fetchFn = m.hosted ? withRetry((u, i) => fetch(u, i)) : (u, i) => fetch(u, i);
  await loadCache();
  const results = new Map();
  const todo = [];
  for (const b of blocks) {
    const hit = scoreCache.get(cacheKey(m, topics, b.text));
    if (hit) results.set(b.id, { ...hit, id: b.id });
    else todo.push(b);
  }
  const t0 = Date.now();
  const ctl = new AbortController();
  if (host != null && todo.length) inFlight.set(ctl, host);
  let fresh;
  try {
    fresh = await scoreWithEndpoint(m, todo, topics, fetchFn, { signal: ctl.signal, concurrency: m.concurrency ?? 4 });
  } catch (err) {
    if (ctl.signal.aborted) return { paused: true, scores: [] };
    noteError(id, err, Date.now() - t0, todo.length);
    throw err;
  } finally {
    inFlight.delete(ctl);
  }
  fresh.forEach((r, i) => {
    results.set(r.id, r);
    if (!r.unscored) {
      if (scoreCache.size >= CACHE_LIMIT) scoreCache.delete(scoreCache.keys().next().value);
      const { id, ...score } = r;
      scoreCache.set(cacheKey(m, topics, todo[i].text), score);
    }
  });
  if (fresh.length) saveCacheSoon();
  return { scores: blocks.map((b) => results.get(b.id)), scorer: modelScorerId(m) };
}

// The toolbar badge: a count of hidden blocks, or ‖ in grey while paused.
async function showBadge({ text, color, title }, tabId) {
  const where = tabId == null ? {} : { tabId };
  await Promise.all([
    chrome.action.setBadgeText({ ...where, text }),
    chrome.action.setBadgeBackgroundColor({ ...where, color }),
    chrome.action.setTitle({ ...where, title })
  ]).catch(() => {});
}

// The default badge, for tabs the zapper cannot run on (browser pages, the Web
// Store): ‖ while paused everywhere, so the pause is visible from any tab.
async function syncGlobalBadge() {
  const { settings } = await load();
  await showBadge(badgeFor(null, settings.paused === true));
}

const handlers = {
  async 'get-state'({ host }) {
    const st = await load();
    const site = st.sites[host] ?? {};
    const scorer = effectiveScorer(st.settings, site);
    const sc = scorerOnly(st.settings);
    return {
      lens: st.lens,
      draftWeights: st.draftWeights,
      settings: st.settings,
      site,
      // What scores this site, without secrets: the page paces its requests by it.
      scoring: { scorer, api: sc.api, concurrency: (st.settings.scorer === 'hosted' ? st.settings.hosted : st.settings.model).concurrency ?? 4, id: modelScorerId(sc) },
      unsupported: unsupportedFeatures(st.lens)
    };
  },

  // Which providers have a saved key. The keys themselves never leave the worker.
  async 'hosted-keys'() {
    const { hostedKeys = {} } = await chrome.storage.local.get('hostedKeys');
    return { saved: Object.fromEntries(Object.keys(hostedKeys).map((p) => [p, true])) };
  },

  async 'set-hosted-key'({ provider, key }) {
    if (!HOSTED_PROVIDERS[provider]) return { error: 'unknown provider' };
    const { hostedKeys = {} } = await chrome.storage.local.get('hostedKeys');
    const k = String(key ?? '').trim();
    if (k) hostedKeys[provider] = k;
    else delete hostedKeys[provider];
    await chrome.storage.local.set({ hostedKeys });
    return { ok: true };
  },

  async 'set-draft'({ weights }) {
    await chrome.storage.local.set({ draftWeights: weights });
    return { ok: true };
  },

  async 'set-settings'({ patch }) {
    const { settings } = await load();
    const next = { ...settings, ...patch, model: { ...settings.model, ...(patch.model ?? {}) }, hosted: { ...settings.hosted, ...(patch.hosted ?? {}) } };
    // Switching scorer moves the threshold to the new scorer's default, unless
    // the reader had already moved it away from the old one's.
    if (patch.scorer && patch.scorer !== settings.scorer && patch.threshold === undefined &&
        Math.abs(settings.threshold - (DEFAULT_THRESHOLD[settings.scorer] ?? settings.threshold)) < 1e-9) {
      next.threshold = DEFAULT_THRESHOLD[patch.scorer] ?? settings.threshold;
    }
    await chrome.storage.local.set({ settings: next });
    return { settings: next };
  },

  async 'set-site'({ host, patch }) {
    const { sites } = await load();
    const entry = { ...(sites[host] ?? {}), ...patch };
    for (const k of Object.keys(entry)) if (entry[k] === undefined || entry[k] === null) delete entry[k];
    if (Object.keys(entry).length) sites[host] = entry;
    else delete sites[host];
    await chrome.storage.local.set({ sites });
    return { site: sites[host] ?? {} };
  },

  async 'commit-draft'() {
    const { lens, draftWeights } = await load();
    const result = await commitDraft(lens, draftWeights, { sha256 });
    if (!result) {
      await chrome.storage.local.set({ draftWeights: {} });
      return { unchanged: true };
    }
    await chrome.storage.local.set({ lens: result.manifest, draftWeights: {} });
    return {
      lensVersion: result.manifest.metadata.lensVersion,
      impact: result.impact,
      changes: result.changes,
      dropped: result.dropped
    };
  },

  async 'commit-edit'({ manifest: edited }) {
    const { lens } = await load();
    const result = await commitEdit(lens, edited, { sha256 });
    if (!result) return { unchanged: true };
    // A direct edit starts from the saved weights, so unsaved slider moves go.
    await chrome.storage.local.set({ lens: result.manifest, draftWeights: {} });
    return {
      lensVersion: result.manifest.metadata.lensVersion,
      impact: result.impact,
      changes: result.changes,
      dropped: result.dropped
    };
  },

  async 'train-add'({ example }) {
    // Only numbers for known topics and the label; anything else is dropped.
    if (!example || !['keep', 'zap'].includes(example.label) || typeof example.matches !== 'object') return { error: 'bad example' };
    const matches = {};
    for (const [t, m] of Object.entries(example.matches)) if (typeof m === 'number') matches[t] = m;
    const { training = [] } = await chrome.storage.local.get('training');
    training.push({ matches, label: example.label });
    await chrome.storage.local.set({ training: training.slice(-TRAINING_LIMIT) });
    return { count: Math.min(training.length, TRAINING_LIMIT) };
  },

  async 'train-get'() {
    const { training = [] } = await chrome.storage.local.get('training');
    return { examples: training };
  },

  async 'train-clear'() {
    await chrome.storage.local.remove('training');
    return { ok: true };
  },

  // From a page: the zapped count goes on the toolbar badge for that tab.
  async 'page-update'({ page }, sender) {
    const tabId = sender?.tab?.id;
    if (tabId == null) return { ok: false };
    await showBadge(badgeFor(page), tabId);
    return { ok: true };
  },

  async 'import-lens'({ manifest }) {
    const errors = validateLens(manifest);
    if (errors.length) return { errors };
    await chrome.storage.local.set({ lens: manifest, draftWeights: {} });
    return { ok: true, unsupported: unsupportedFeatures(manifest) };
  },

  async 'reset-lens'() {
    await chrome.storage.local.remove(['lens', 'draftWeights']);
    return { ok: true };
  },

  async 'clear-local-state'() {
    await chrome.storage.local.remove(['draftWeights', 'sites', 'training']);
    scoreCache.clear();
    clearTimeout(cacheSaveTimer);
    await chrome.storage.session?.remove(CACHE_KEY);
    return { ok: true };
  },

  // Scores already cached for these blocks; blocks not in the cache are left out.
  async 'cached-scores'({ blocks, topics }) {
    await loadCache();
    const { settings } = await load();
    const scores = [];
    const m = scorerOnly(settings);
    for (const b of blocks) {
      const hit = scoreCache.get(cacheKey(m, topics, b.text));
      if (hit) scores.push({ ...hit, id: b.id });
    }
    return { scores, scorer: modelScorerId(m) };
  },

  async 'debug-info'() {
    await loadCache();
    return { recentErrors: [...recentErrors], cachedScores: scoreCache.size };
  },

  async 'score-model'({ blocks, topics, host }) {
    return scoreWithModel(blocks, topics, host ?? null);
  },

  async 'test-model'() {
    const t0 = Date.now();
    const { scores, scorer } = await scoreWithModel(
      [
        { id: 't1', text: 'The school district restored its systems after a ransomware attack on student records.' },
        { id: 't2', text: 'The home team won the football final in extra time.' }
      ],
      ['school cybersecurity']
    );
    return { scorer, ms: Date.now() - t0, scores };
  }
};

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  const handler = handlers[msg?.type];
  if (!handler) return false;
  handler(msg, sender)
    .then(sendResponse)
    .catch((err) => sendResponse({ error: String(err?.message ?? err) }));
  return true;
});

// The toolbar button opens the side panel, where all the controls are.
chrome.sidePanel?.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});
syncGlobalBadge();
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && changes.settings) syncGlobalBadge();
  if (area === 'local' && (changes.settings || changes.sites)) abortPausedRequests();
});
