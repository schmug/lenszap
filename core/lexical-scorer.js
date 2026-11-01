// SPDX-License-Identifier: Apache-2.0
//
// The zero-setup scorer: estimates, for each block of text, how well it matches
// each priority topic in the reader's lens, using words alone. It needs no
// model and no network, so the zapper works the moment it is loaded.
//
// It is deliberately crude. A block that never uses a topic's words scores 0
// for that topic, however related it is, so on real pages this scorer zaps
// far too much. It exists as a fallback and as a deterministic baseline to
// measure the local-model scorer (model-scorer.js) against.
//
// Pure and DOM-free: runs in the content script and under Node.

export const LEXICAL_SCORER_ID = 'lexical-v0.1';

const STOPWORDS = new Set([
  'a', 'an', 'and', 'are', 'as', 'at', 'be', 'by', 'for', 'from', 'in', 'into',
  'is', 'it', 'of', 'on', 'or', 'the', 'to', 'with', 'about', 'new', 'news'
]);

/** Lowercase word tokens with a light plural strip ("schools" → "school"). */
export function tokenize(text) {
  return String(text)
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean)
    .map((t) => (t.length > 3 && t.endsWith('s') && !t.endsWith('ss') ? t.slice(0, -1) : t));
}

/** Content tokens of a topic: stopwords and one- or two-letter words dropped. */
export function topicTokens(topic) {
  return tokenize(topic).filter((t) => t.length > 2 && !STOPWORDS.has(t));
}

/**
 * Match strength of one block against one topic, in [0, 1].
 *
 * The whole phrase, in order, scores 1. Otherwise the share of the topic's
 * content words present in the block, scaled by 0.6, so that a partial match
 * never reads as strongly as the phrase itself.
 */
export function topicMatch(blockTokens, topic) {
  const tokens = topicTokens(topic);
  if (tokens.length === 0) return 0;
  const joined = ` ${blockTokens.join(' ')} `;
  if (joined.includes(` ${tokens.join(' ')} `)) return 1;
  const present = new Set(blockTokens);
  const hits = tokens.filter((t) => present.has(t)).length;
  return Math.round((hits / tokens.length) * 0.6 * 1000) / 1000;
}

const EVIDENCE_PATTERN =
  /\b(correction|corrected|clarification|retraction|editor['’]s note|update:|we previously reported|primary source|according to (?:the )?(?:study|report|data|filing|court records))\b/i;

/**
 * Lexical guess at whether a block is a correction, a clarification, or cites
 * a primary source. These blocks are never zapped (decide.js), so a false
 * positive here costs only a missed zap.
 */
export function looksLikeEvidence(text) {
  return EVIDENCE_PATTERN.test(String(text));
}

/**
 * Score blocks against topics.
 *
 * @param {{id: string, text: string}[]} blocks
 * @param {string[]} topics
 * @returns {{id: string, matches: Record<string, number>, evidence: boolean}[]}
 */
export function scoreLexical(blocks, topics) {
  return blocks.map(({ id, text }) => {
    const tokens = tokenize(text);
    const matches = {};
    for (const topic of topics) matches[topic] = topicMatch(tokens, topic);
    return { id, matches, evidence: looksLikeEvidence(text) };
  });
}
