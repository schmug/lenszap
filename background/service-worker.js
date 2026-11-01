// SPDX-License-Identifier: Apache-2.0
//
// Background host for the LensPub Zapper.
//
// Owns everything the zapper stores, all in chrome.storage.local and never
// synced:
//   lens         the reader's Lens Manifest (shareable, history-free)
//   draftWeights interest-slider positions not yet saved into the lens
//   settings     confidence threshold and scorer choice
//   sites        per-site pause and threshold, keyed by hostname
// Only `lens` is ever exported. draftWeights and sites are Adaptation State in
// the protocol's sense (ADR-0006): local, private, and never written into the
// manifest, because a hostname next to a preference is reading history.
//
// Network: with the lexical scorer (the default) the zapper makes no requests.
// With the model scorer it makes requests to one endpoint on this machine
// (llama-server's /v1/systemone for decision models, or a chat API)
// (localhost or 127.0.0.1, enforced in core/model-scorer.js); nothing ever
// leaves the device. The other fetch() here loads the bundled sample lens
// from the extension's own package.

import { commitDraft, validateLens, unsupportedFeatures } from '../core/lens-edit.js';
import { scoreWithEndpoint, modelScorerId } from '../core/model-scorer.js';

const DEFAULT_SETTINGS = {
  threshold: 0.8,
  scorer: 'lexical',
  // Display: score popover on hover, scoring and zapping animations, sidebar state.
  hoverInfo: true,
  animate: true,
  sidebarCollapsed: false,
  // llama-server's decision endpoint; the model is whatever llama-server loaded.
  // concurrency: requests in flight at once (match llama-server's --parallel).
  model: { api: 'systemone', endpoint: 'http://127.0.0.1:8080', model: '', concurrency: 4 }
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
    settings: { ...DEFAULT_SETTINGS, ...(s.settings ?? {}), model: { ...DEFAULT_SETTINGS.model, ...(s.settings?.model ?? {}) } },
    sites: s.sites ?? {}
  };
}

const sha256 = (bytes) => crypto.subtle.digest('SHA-256', bytes);

// Model scores cached for the life of the service worker, keyed by model,
// topics, and block text. Never persisted: the cache holds page text.
const scoreCache = new Map();
const CACHE_LIMIT = 4000;

function cacheKey(settings, topics, text) {
  let h = 0x811c9dc5;
  const s = `${modelScorerId(settings)}\u0000${topics.join('\u0001')}\u0000${text}`;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return `${h.toString(16)}:${s.length}`;
}

async function scoreWithModel(blocks, topics) {
  const { settings } = await load();
  const m = settings.model;
  const results = new Map();
  const todo = [];
  for (const b of blocks) {
    const hit = scoreCache.get(cacheKey(m, topics, b.text));
    if (hit) results.set(b.id, { ...hit, id: b.id });
    else todo.push(b);
  }
  const fresh = await scoreWithEndpoint(m, todo, topics, (u, i) => fetch(u, i));
  fresh.forEach((r, i) => {
    results.set(r.id, r);
    if (!r.unscored) {
      if (scoreCache.size >= CACHE_LIMIT) scoreCache.delete(scoreCache.keys().next().value);
      scoreCache.set(cacheKey(m, topics, todo[i].text), r);
    }
  });
  return { scores: blocks.map((b) => results.get(b.id)), scorer: modelScorerId(m) };
}

const handlers = {
  async 'get-state'({ host }) {
    const st = await load();
    return {
      lens: st.lens,
      draftWeights: st.draftWeights,
      settings: st.settings,
      site: st.sites[host] ?? {},
      unsupported: unsupportedFeatures(st.lens)
    };
  },

  async 'set-draft'({ weights }) {
    await chrome.storage.local.set({ draftWeights: weights });
    return { ok: true };
  },

  async 'set-settings'({ patch }) {
    const { settings } = await load();
    const next = { ...settings, ...patch, model: { ...settings.model, ...(patch.model ?? {}) } };
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
    await chrome.storage.local.remove(['draftWeights', 'sites']);
    scoreCache.clear();
    return { ok: true };
  },

  async 'score-model'({ blocks, topics }) {
    return scoreWithModel(blocks, topics);
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
  },

  async 'open-options'() {
    await chrome.runtime.openOptionsPage();
    return { ok: true };
  }
};

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  const handler = handlers[msg?.type];
  if (!handler) return false;
  handler(msg)
    .then(sendResponse)
    .catch((err) => sendResponse({ error: String(err?.message ?? err) }));
  return true;
});

chrome.action.onClicked.addListener(() => chrome.runtime.openOptionsPage());
