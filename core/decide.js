// SPDX-License-Identifier: Apache-2.0
//
// The zap decision, and the ledger that accounts for it.
//
// A scorer (lexical-scorer.js or model-scorer.js) says how well each block
// matches each topic. This module combines those matches with the reader's
// interest weights and confidence threshold, decides which blocks to hide,
// and writes a reasoning trace for every block, hidden or not.
//
// Keeping the decision separate from the scoring is what makes the sliders
// instant: moving a weight or the threshold re-runs this module over cached
// scores, and never calls the model again.
//
// Pure and DOM-free: runs in the content script and under Node.

/** Reasons a block is never hidden, whatever its score. */
export const EXEMPT = Object.freeze({
  evidence: 'Looks like a correction, clarification, or primary source; never zapped.',
  restored: 'You restored this block on this page.',
  structural: 'Part of the page’s controls (form, dialog, navigation, or heading); never zapped.',
  unscored: 'The scorer returned nothing for this block; never zapped on silence.'
});

/**
 * How sure the zapper is that a block is off the reader's lens, in [0, 1].
 *
 * A block is on-lens to the degree it matches a topic the reader weighted
 * positively, scaled by that weight: a perfect match to a 0.6-weighted topic
 * leaves the zapper 40% sure it is off-lens. A block that matches a topic the
 * reader weighted negatively is off-lens to the degree of that match times the
 * weight's size. The larger of the two readings wins.
 *
 * @param {Record<string, number>} matches - topic → match strength in [0, 1]
 * @param {{topic: string, weight: number}[]} priorities
 * @returns {{offLens: number, best: {topic: string, match: number, weight: number} | null,
 *            against: {topic: string, match: number, weight: number} | null}}
 */
export function offLensConfidence(matches, priorities) {
  let best = null;
  let bestKeep = 0;
  let against = null;
  let worstAvoid = 0;
  for (const { topic, weight } of priorities) {
    const match = clamp01(matches[topic] ?? 0);
    if (weight > 0) {
      const keep = match * weight;
      if (keep > bestKeep) {
        bestKeep = keep;
        best = { topic, match, weight };
      }
    } else if (weight < 0) {
      const avoid = match * -weight;
      if (avoid > worstAvoid) {
        worstAvoid = avoid;
        against = { topic, match, weight };
      }
    }
  }
  const hasPositive = priorities.some((p) => p.weight > 0);
  // With no positive interests, only an explicit "less of this" can zap.
  const offByAbsence = hasPositive ? 1 - bestKeep : 0;
  return { offLens: round3(Math.max(offByAbsence, worstAvoid)), best, against };
}

/**
 * Decide every block.
 *
 * @param {object} input
 * @param {{id: string, matches: Record<string, number>, evidence?: boolean, unscored?: boolean}[]} input.scores
 * @param {{topic: string, weight: number}[]} input.priorities
 * @param {number} input.threshold - zap when offLens >= threshold; in (0, 1]
 * @param {string} input.scorer - scorer identifier, recorded in every trace
 * @param {Set<string>} [input.restored] - ids the reader restored on this page
 * @param {Map<string, string>} [input.exempt] - id → EXEMPT key, decided by the page
 * @returns {{id: string, zap: boolean, offLens: number, trace: string, exempt?: string}[]}
 */
export function decide({ scores, priorities, threshold, scorer, restored = new Set(), exempt = new Map() }) {
  if (!(threshold > 0 && threshold <= 1)) throw new RangeError('threshold must be in (0, 1]');
  return scores.map(({ id, matches, evidence, unscored }) => {
    const { offLens, best, against } = offLensConfidence(matches, priorities);
    const exemptKey =
      exempt.get(id) ??
      (unscored ? 'unscored' : evidence ? 'evidence' : restored.has(id) ? 'restored' : undefined);
    const why = explain(offLens, threshold, best, against, scorer);
    if (exemptKey) {
      return { id, zap: false, offLens, exempt: exemptKey, trace: `${EXEMPT[exemptKey]} (${why})` };
    }
    return { id, zap: offLens >= threshold, offLens, trace: why };
  });
}

function explain(offLens, threshold, best, against, scorer) {
  const pct = (x) => `${Math.round(x * 100)}%`;
  const parts = [`${pct(offLens)} sure it is off your lens; you zap at ${pct(threshold)}`];
  if (against && against.match > 0) {
    parts.push(`matches “${against.topic}” (${pct(against.match)}), which you weighted ${against.weight}`);
  }
  if (best) parts.push(`best interest match “${best.topic}” ${pct(best.match)} × weight ${best.weight}`);
  else parts.push('matches none of your interests');
  parts.push(`scorer ${scorer}`);
  return parts.join(' · ');
}

/**
 * The ledger's completeness check: the set of blocks hidden on the page must
 * equal the set the ledger lists. Any difference means the reader could be
 * missing content they cannot see accounted for, and the caller must restore
 * everything and say so.
 *
 * @param {Iterable<string>} hiddenOnPage
 * @param {Iterable<string>} ledgerIds
 * @returns {{ok: boolean, unlisted: string[], phantom: string[]}}
 */
export function checkLedger(hiddenOnPage, ledgerIds) {
  const hidden = new Set(hiddenOnPage);
  const ledger = new Set(ledgerIds);
  const unlisted = [...hidden].filter((id) => !ledger.has(id));
  const phantom = [...ledger].filter((id) => !hidden.has(id));
  return { ok: unlisted.length === 0 && phantom.length === 0, unlisted, phantom };
}

const clamp01 = (x) => (Number.isFinite(x) ? Math.min(1, Math.max(0, x)) : 0);
const round3 = (x) => Math.round(x * 1000) / 1000;
