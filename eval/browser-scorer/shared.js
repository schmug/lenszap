// SPDX-License-Identifier: Apache-2.0
//
// Pure helpers for the in-browser scorer spike (eval/browser-scorer.mjs). The same
// file runs in the scorer page (Chromium, WebGPU) and under Node for the tests.
// Developer tooling only: the extension never loads anything in eval/.
//
// The page answers the same two APIs the eval already speaks, so eval/run.mjs
// scores it like any other local endpoint:
//   - /v1/systemone (api "systemone"): an NLI or embedding model turns each
//     yes/no question into a probability, standing in for a decision model.
//   - /v1/chat/completions (api "openai"): a small chat model via WebLLM.

/** Scorer kinds the page can run. */
export const KINDS = Object.freeze({
  nli: 'Zero-shot NLI (transformers.js): P(entailment) that the passage matches each question.',
  embed: 'Embedding similarity (transformers.js): cosine between passage and question, rescaled to 0–1.',
  webllm: 'Small chat model (WebLLM): the extension\'s chat prompt, JSON reply.'
});

/** The api eval/run.mjs should use for a kind. */
export const apiForKind = (kind) => (kind === 'webllm' ? 'openai' : 'systemone');

/**
 * Turn a System One yes/no question into an NLI hypothesis: "Is this passage
 * about X?" → "This passage is about X." The questions come from
 * core/model-scorer.js; anything else is used as is, minus its question mark.
 */
export function questionToHypothesis(q) {
  let s = String(q ?? '').trim().replace(/\s+/g, ' ');
  s = s.replace(/^is this passage\b/i, 'This passage is');
  s = s.replace(/,? or does it cite\b/i, ', or it cites');
  s = s.replace(/\?\s*$/, '');
  return s.endsWith('.') ? s : `${s}.`;
}

/** The passage text from a System One `state` (model-scorer.js prefixes a label line). */
export const passageFromState = (state) => String(state ?? '').replace(/^Passage from a web page:\n/, '');

/** Cosine similarity → 0–1, linear between `lo` (0) and `hi` (1), clamped. */
export function rescaleCosine(cos, lo, hi) {
  if (!Number.isFinite(cos) || !(hi > lo)) return 0;
  return Math.min(1, Math.max(0, (cos - lo) / (hi - lo)));
}

/** A /v1/systemone response from per-question probabilities, in the question order given. */
export function systemOneAnswers(keys, probs) {
  const answers = {};
  keys.forEach((k, i) => {
    const p = Number(probs[i]);
    answers[k] = { noul: Number.isFinite(p) ? Math.min(1, Math.max(0, p)) : null };
  });
  return { answers };
}

/**
 * Validate a /v1/systemone body: {state: string, questions: {key: {instructions}}}.
 * Returns {passage, keys, hypotheses} or throws.
 */
export function readSystemOneBody(body) {
  if (!body || typeof body.state !== 'string' || !body.questions || typeof body.questions !== 'object') {
    throw new Error('Expected {state, questions}.');
  }
  const keys = Object.keys(body.questions);
  const hypotheses = keys.map((k) => questionToHypothesis(body.questions[k]?.instructions));
  return { passage: passageFromState(body.state), keys, hypotheses };
}

/**
 * Map a request path under /models/ to a relative file path in the model
 * folder. WebLLM asks for <id>/resolve/main/<file>, transformers.js for
 * <id>/<file>; both land on <id>/<file>. Returns null for anything that tries
 * to leave the folder.
 */
export function modelFilePath(urlPath) {
  let p;
  try {
    p = decodeURIComponent(String(urlPath).split('?')[0]);
  } catch {
    return null;
  }
  if (!p.startsWith('/models/')) return null;
  p = p.slice('/models/'.length).replace('/resolve/main/', '/');
  const parts = p.split('/');
  if (!p || parts.some((s) => s === '' || s === '.' || s === '..' || s.includes('\\'))) return null;
  return parts.join('/');
}

/** True for a URL the scorer page may load: http(s) on 127.0.0.1 or localhost, or a data:/blob: URL. */
export function isLocalRequest(url) {
  let u;
  try {
    u = new URL(url);
  } catch {
    return false;
  }
  if (u.protocol === 'data:' || u.protocol === 'blob:') return true;
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return false;
  return u.hostname === '127.0.0.1' || u.hostname === 'localhost';
}
