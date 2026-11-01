// SPDX-License-Identifier: Apache-2.0
//
// Label-first scoring (experimental; used by the eval, not yet by the
// extension).
//
// Today's model scorer asks, for each block, "is this about <your topic>?" once
// per lens topic. Label-first scoring splits that in two:
//   1. Categorize: each block gets a confidence for each category in a fixed
//      list, whatever the lens. This is the expensive part, and because it
//      does not depend on the lens it can be cached across lens edits, sites,
//      and readers' lenses.
//   2. Relate: each lens topic gets a relevance for each category, asked once
//      per topic (a handful of requests per lens, not per page).
// A block's match to a topic is then the best category-confidence × relevance
// over all categories, and core/decide.js takes it from there unchanged.
//
// Ads and sponsored blocks are one of the categories, so "zap ads" is a
// reader setting that adds a negative priority for AD_TOPIC, matched directly
// to the ad category.
//
// As with the per-topic scorer, a block is evidence (never zapped) if the model
// or the word-level heuristic says so.
//
// Decision models only (llama-server /v1/systemone). Builds requests and parses
// responses; the caller passes fetch. Pure and DOM-free.

import { isLoopbackEndpoint, EVIDENCE_QUESTION } from './model-scorer.js';
import { looksLikeEvidence } from './lexical-scorer.js';

export const CATEGORIZE_SCORER_PREFIX = 'categories-v0.1';
export const MAX_STATE_CHARS = 1500;

/** The topic a "zap ads" setting adds, with a negative weight. */
export const AD_TOPIC = 'advertising or sponsored content';

/** The fixed category list. Short ids, plain-language descriptions. */
export const CATEGORIES = Object.freeze([
  ['ad', 'an advertisement, sponsored post, affiliate promotion, or paid placement'],
  ['politics', 'politics, government, elections, or public policy'],
  ['local', 'local community news about a town, county, or school district'],
  ['world', 'international or world news'],
  ['business', 'business, finance, markets, or the economy'],
  ['tech', 'technology products, the tech industry, or gadgets'],
  ['software', 'software development, programming, or open-source projects'],
  ['security', 'cybersecurity, hacking, breaches, ransomware, or online safety'],
  ['privacy', 'data privacy, surveillance, or personal data rights'],
  ['science', 'science or research findings'],
  ['health', 'health, medicine, or fitness'],
  ['education', 'schools, teaching, students, or education policy'],
  ['sports', 'sports, games, teams, or athletes'],
  ['entertainment', 'movies, TV, music, or games as entertainment'],
  ['celebrity', 'celebrity gossip or famous people’s private lives'],
  ['lifestyle', 'food, recipes, travel, fashion, home, or shopping'],
  ['weather', 'weather forecasts or conditions'],
  ['crime', 'crime, courts, or public safety'],
  ['opinion', 'an opinion piece, editorial, or personal commentary'],
  ['discussion', 'a reader comment, forum post, or reply in a discussion'],
  ['links', 'a list of links, related stories, or recommendations to read more'],
  ['promo', 'a newsletter sign-up, subscription pitch, or app download prompt']
].map(([id, description]) => Object.freeze({ id, description })));

const ids = CATEGORIES.map((c) => c.id);
const clamp01 = (x) => (Number.isFinite(x) ? Math.min(1, Math.max(0, x)) : 0);

function endpointBase(settings) {
  if (!isLoopbackEndpoint(settings.endpoint)) {
    throw new Error('The model endpoint must be on this machine (localhost or 127.0.0.1).');
  }
  return settings.endpoint.replace(/\/+$/, '');
}

function request(settings, state, questions) {
  const body = { state, questions };
  if (settings.model) body.model = settings.model;
  return {
    url: `${endpointBase(settings)}/v1/systemone`,
    init: { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }
  };
}

/** Categorize one block: one question per category, plus the evidence question. */
export function buildCategorizeRequest(settings, block) {
  const questions = {};
  for (const c of CATEGORIES) {
    questions[c.id] = { type: 'noul', instructions: `Is this passage ${c.description}?` };
  }
  questions[EVIDENCE_QUESTION] = {
    type: 'noul',
    instructions:
      'Is this passage a correction, clarification, or retraction, or does it cite a primary source such as a study, dataset, court record, or official filing?'
  };
  return request(settings, `Passage from a web page:\n${String(block.text).slice(0, MAX_STATE_CHARS)}`, questions);
}

/** Parse a categorization. If no category came back, the block is unscored. */
export function parseCategorizeResponse(json, block) {
  const answers = json?.answers ?? {};
  const categories = {};
  let answered = 0;
  for (const id of ids) {
    const v = Number(answers[id]?.noul);
    if (Number.isFinite(v)) answered++;
    categories[id] = clamp01(v);
  }
  const ev = Number(answers[EVIDENCE_QUESTION]?.noul);
  const out = { id: block.id, categories, evidence: Number.isFinite(ev) && ev >= 0.5 };
  if (answered === 0) out.unscored = true;
  return out;
}

/** How much each category bears on one interest topic. */
export function buildRelevanceRequest(settings, topic) {
  const questions = {};
  for (const c of CATEGORIES) {
    questions[c.id] = {
      type: 'noul',
      instructions: `Would a passage that is ${c.description} usually be about this interest?`
    };
  }
  return request(settings, `A reader's interest: ${topic}`, questions);
}

export function parseRelevanceResponse(json) {
  const answers = json?.answers ?? {};
  return Object.fromEntries(ids.map((id) => [id, clamp01(Number(answers[id]?.noul))]));
}

/** The fixed relevance row for AD_TOPIC: the ad category only. */
export const AD_RELEVANCE = Object.freeze(Object.fromEntries(ids.map((id) => [id, id === 'ad' ? 1 : 0])));

/**
 * A block's match to each topic, from its categories and the relevance table.
 * @param {Record<string, number>} categories - category id → confidence
 * @param {Record<string, Record<string, number>>} relevance - topic → category id → relevance
 * @returns {Record<string, number>} topic → match in [0, 1]
 */
export function matchesFromCategories(categories, relevance) {
  const out = {};
  for (const [topic, row] of Object.entries(relevance)) {
    let best = 0;
    for (const id of ids) best = Math.max(best, clamp01(categories[id]) * clamp01(row[id]));
    out[topic] = Math.round(best * 1000) / 1000;
  }
  return out;
}

/**
 * Score blocks label-first against a llama-server decision model.
 * Returns scorer output that core/decide.js accepts, with `categories` kept on
 * each block for reports.
 *
 * @param {{endpoint: string, model?: string}} settings
 * @param {{id: string, text: string}[]} blocks
 * @param {string[]} topics - may include AD_TOPIC
 * @param {typeof fetch} fetchFn
 * @param {{concurrency?: number, onTiming?: (id: string, ms: number) => void,
 *          relevance?: Record<string, Record<string, number>>}} [opts] - pass a cached relevance table to skip asking
 */
export async function scoreByCategories(settings, blocks, topics, fetchFn, { concurrency = 4, onTiming, relevance } = {}) {
  const post = async ({ url, init }) => {
    const res = await fetchFn(url, init);
    if (!res.ok) throw new Error(`Model endpoint answered ${res.status}`);
    return res.json();
  };
  const now = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());
  const rel = { ...(relevance ?? {}) };
  for (const t of topics) {
    if (rel[t]) continue;
    rel[t] = t === AD_TOPIC ? AD_RELEVANCE : parseRelevanceResponse(await post(buildRelevanceRequest(settings, t)));
  }
  const out = new Array(blocks.length);
  let next = 0;
  const worker = async () => {
    while (next < blocks.length) {
      const i = next++;
      const t0 = now();
      const c = parseCategorizeResponse(await post(buildCategorizeRequest(settings, blocks[i])), blocks[i]);
      const zeros = Object.fromEntries(topics.map((t) => [t, 0]));
      out[i] = c.unscored
        ? { id: c.id, matches: zeros, evidence: false, unscored: true }
        : { id: c.id, matches: { ...zeros, ...matchesFromCategories(c.categories, pick(rel, topics)) }, evidence: c.evidence || looksLikeEvidence(blocks[i].text), categories: c.categories };
      onTiming?.(blocks[i].id, now() - t0);
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, blocks.length) }, worker));
  return { scores: out, relevance: rel };
}

const pick = (obj, keys) => Object.fromEntries(keys.filter((k) => k in obj).map((k) => [k, obj[k]]));
