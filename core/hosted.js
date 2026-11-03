// SPDX-License-Identifier: Apache-2.0
//
// Hosted scorers, bring your own key. Off unless the reader picks "A hosted
// model" in Settings, enters their own key, and grants the provider's host.
// While on, the text of each block on a page (up to the scorer's length cap) is
// sent to that provider, and to no one else. The local model stays the
// default, and nothing here runs while zapping is paused.
//
// A site can be kept off the hosted model (sites[host].noHosted): it is then
// not scored at all, so nothing from it is sent. Ad slots are still found by
// structure, which needs no scorer.
//
// Providers:
//   workers-ai  Cloudflare Workers AI, Clef or Clef-flash (System One API).
//               Every account gets a free daily allowance.
//   jev         TypeSafe Jev (System One API). Fastest in the eval.
//   openrouter  OpenRouter chat models, including its :free models. Chat
//               models are not measured by the eval.
//   custom      Any OpenAI-compatible https endpoint.
//
// This module only describes providers and builds targets; the fetch happens
// in background/service-worker.js. Pure and DOM-free.

export const HOSTED_PROVIDERS = {
  'workers-ai': {
    label: 'Cloudflare Workers AI',
    api: 'systemone',
    models: ['clef-flash', 'clef'],
    defaultModel: 'clef-flash',
    needs: ['accountId'],
    origin: 'https://api.cloudflare.com/*',
    keyName: 'API token (Workers AI: Read)',
    note: 'Free daily allowance on every Cloudflare account (10,000 neurons a day as of November 2026), enough for a few hundred pages a day with Clef-flash. Clef was the most precise model in the eval.',
    url: (h, model) =>
      `https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(h.accountId)}/ai/run/@cf/cloudflare/${encodeURIComponent(model)}`
  },
  jev: {
    label: 'TypeSafe Jev',
    api: 'systemone',
    models: ['jev-1.14.0', 'jev-1.13.0'],
    defaultModel: 'jev-1.14.0',
    needs: [],
    origin: 'https://api.typesafe.ai/*',
    keyName: 'API key',
    note: 'Paid. The fastest model in the eval (about 66 ms a block).',
    url: () => 'https://api.typesafe.ai/v1/systemone'
  },
  openrouter: {
    label: 'OpenRouter',
    api: 'openai',
    models: [],
    defaultModel: '',
    needs: ['model'],
    origin: 'https://openrouter.ai/*',
    keyName: 'API key',
    note: 'Chat models, not measured by the eval. Models ending in :free cost nothing but allow about 50 requests a day (1,000 after buying $10 of credit), roughly a dozen pages, and their providers may keep what is sent.',
    url: () => 'https://openrouter.ai/api/v1/chat/completions'
  },
  custom: {
    label: 'Other OpenAI-compatible service',
    api: 'openai',
    models: [],
    defaultModel: '',
    needs: ['endpoint', 'model'],
    origin: null, // from the endpoint
    keyName: 'API key',
    note: 'Any https service with /chat/completions. Chat models are not measured by the eval.',
    url: (h) => `${String(h.endpoint).replace(/\/+$/, '')}/chat/completions`
  }
};

export const DEFAULT_HOSTED = { provider: 'workers-ai', model: '', accountId: '', endpoint: '', concurrency: 4 };

/** The origin pattern to request for an https endpoint, or null. */
export function originPattern(url) {
  let u;
  try {
    u = new URL(url);
  } catch {
    return null;
  }
  return u.protocol === 'https:' && u.hostname ? `https://${u.hostname}/*` : null;
}

/** The host permission a hosted config needs, or null if it can't be built. */
export function hostedOrigin(hosted) {
  const p = HOSTED_PROVIDERS[hosted?.provider];
  if (!p) return null;
  return p.origin ?? originPattern(hosted.endpoint);
}

/** What is missing before this config can be used: a list of field names. */
export function hostedMissing(hosted, key) {
  const p = HOSTED_PROVIDERS[hosted?.provider];
  if (!p) return ['provider'];
  const missing = p.needs.filter((f) => !String(hosted[f] ?? '').trim());
  if (p.needs.includes('endpoint') && hosted.endpoint && !originPattern(hosted.endpoint)) missing.push('endpoint');
  if (!key) missing.push('key');
  return missing;
}

export function hostedScorerId(hosted) {
  const p = HOSTED_PROVIDERS[hosted?.provider];
  const model = hosted?.model || p?.defaultModel || 'default';
  return `hosted:${hosted?.provider ?? 'none'}/${model}`;
}

/**
 * Settings for scoreWithEndpoint that send to the provider. `hosted: true`
 * tells core/model-scorer.js to allow this one https URL instead of loopback.
 * Throws when the config is incomplete.
 */
export function hostedTarget(hosted, key) {
  const missing = hostedMissing(hosted, key);
  if (missing.length) throw new Error(`The hosted model needs: ${missing.join(', ')}. Set it up in Settings.`);
  const p = HOSTED_PROVIDERS[hosted.provider];
  const model = hosted.model || p.defaultModel;
  return {
    hosted: true,
    api: p.api,
    url: p.url(hosted, model),
    model,
    headers: { authorization: `Bearer ${key}` },
    concurrency: Math.min(8, Math.max(1, Math.round(Number(hosted.concurrency)) || 4)),
    scorerId: hostedScorerId(hosted)
  };
}

/**
 * Which scorer runs on a site: 'lexical', 'model', 'hosted', or 'none' (a
 * site kept off the hosted model: nothing is scored or sent).
 */
export function effectiveScorer(settings, site) {
  const s = settings?.scorer ?? 'lexical';
  if (s === 'hosted' && site?.noHosted === true) return 'none';
  return s;
}

/** Workers AI wraps results as {success, result: {...}}; others return them bare. */
export function unwrapHosted(json) {
  return json && typeof json === 'object' && json.result && typeof json.result === 'object' && !json.answers && !json.choices
    ? json.result
    : json;
}

/**
 * A fetch that retries rate limits (429) and server errors with backoff, for
 * hosted providers. Aborts (a pause) stop it at once.
 */
export function withRetry(fetchFn, { retries = 3, sleep = (ms) => new Promise((r) => setTimeout(r, ms)) } = {}) {
  return async (url, init) => {
    for (let attempt = 0; ; attempt++) {
      const res = await fetchFn(url, init);
      if ((res.status === 429 || res.status >= 500) && attempt < retries) {
        init?.signal?.throwIfAborted?.();
        const after = Number(res.headers?.get?.('retry-after'));
        await sleep(Number.isFinite(after) && after > 0 ? Math.min(after, 30) * 1000 : 1000 * 2 ** attempt);
        init?.signal?.throwIfAborted?.();
        continue;
      }
      return res;
    }
  };
}
