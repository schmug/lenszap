// SPDX-License-Identifier: Apache-2.0
//
// Hosted decision models for the eval only: TypeSafe's Jev and Cloudflare Workers
// AI's Clef, both of which speak the System One API that llama-server serves at
// /v1/systemone. The extension never uses this: it stays loopback-only. This lets a
// developer measure a hosted model against the same labelled pages.
//
// It sends the captured page text in eval/data to the provider, so it runs only when
// asked for by name (eval/run.mjs --hosted jev|workers-ai) and with a key in the
// environment. The core scorer still builds every request for a loopback address;
// hostedFetch swaps that address for the provider's and adds the key, so
// core/model-scorer.js keeps its loopback-only guard.

export const HOSTED = {
  jev: {
    label: 'TypeSafe Jev',
    defaultModel: 'jev-1.14.0',
    keys: ['TYPESAFE_API_KEY'],
    url: () => 'https://api.typesafe.ai/v1/systemone'
  },
  'workers-ai': {
    label: 'Cloudflare Workers AI',
    defaultModel: 'clef-flash',
    keys: ['CLOUDFLARE_ACCOUNT_ID', 'CLOUDFLARE_API_TOKEN'],
    url: (env, model) =>
      `https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(env.CLOUDFLARE_ACCOUNT_ID)}/ai/run/@cf/cloudflare/${encodeURIComponent(model)}`
  }
};

/**
 * Where and how to reach a hosted provider. Throws if the provider is unknown or a
 * key is missing from env.
 * @returns {{label: string, model: string, url: string, headers: Record<string, string>}}
 */
export function hostedTarget(name, env, model) {
  const p = HOSTED[name];
  if (!p) throw new Error(`Unknown --hosted provider "${name}". Use one of: ${Object.keys(HOSTED).join(', ')}.`);
  const missing = p.keys.filter((k) => !env[k]);
  if (missing.length) throw new Error(`--hosted ${name} needs ${missing.join(' and ')} in the environment.`);
  const m = model || p.defaultModel;
  const token = name === 'jev' ? env.TYPESAFE_API_KEY : env.CLOUDFLARE_API_TOKEN;
  return { label: p.label, model: m, url: p.url(env, m), headers: { authorization: `Bearer ${token}` } };
}

/** Workers AI wraps results as {success, result: {...}}; Jev returns them bare. */
export function unwrapHosted(json) {
  return json && typeof json === 'object' && json.result && typeof json.result === 'object' && !json.answers
    ? json.result
    : json;
}

/**
 * A fetch for scoreWithEndpoint that sends each request to the hosted provider
 * instead of the loopback URL it was built for. Retries 429 and 5xx with backoff.
 */
export function hostedFetch(target, { fetchFn = fetch, retries = 4, sleep = (ms) => new Promise((r) => setTimeout(r, ms)) } = {}) {
  return async (_loopbackUrl, init) => {
    const req = { ...init, headers: { ...(init?.headers ?? {}), ...target.headers } };
    for (let attempt = 0; ; attempt++) {
      const res = await fetchFn(target.url, req);
      if ((res.status === 429 || res.status >= 500) && attempt < retries) {
        const after = Number(res.headers?.get?.('retry-after'));
        await sleep(Number.isFinite(after) && after > 0 ? after * 1000 : 1000 * 2 ** attempt);
        continue;
      }
      if (!res.ok) return res;
      const json = unwrapHosted(await res.json());
      return { ok: true, status: res.status, json: async () => json, text: async () => JSON.stringify(json) };
    }
  };
}
