// SPDX-License-Identifier: Apache-2.0
//
// Training: the reader marks blocks Keep or Zap, and this module suggests a
// threshold and interest weights that would have decided those blocks the way
// the reader did. Pure and DOM-free.
//
// A training example holds only the scorer's numbers for one block, never its
// text or where it came from:
//   { matches: { [topic]: 0..1 }, label: 'keep' | 'zap' }
// Examples are Adaptation State (ADR-0006): kept on this device, never written
// into the lens. Suggestions reach the lens only when the reader applies them
// to the sliders and then saves, which is a manual edit like any other.

import { offLensConfidence } from './decide.js';

export const MIN_EXAMPLES = 6;
// Wrongly hiding something the reader wanted costs more than missing a zap.
const COST_FALSE_ZAP = 2;
const COST_MISSED = 1;
// Each unit of total weight change costs about one wrong decision, so a
// suggestion moves a weight only when that fixes something.
const COST_PER_WEIGHT = 1;

const THRESHOLDS = Array.from({ length: 50 }, (_, i) => Math.round((0.5 + i * 0.01) * 100) / 100);
const WEIGHTS = Array.from({ length: 41 }, (_, i) => Math.round((-1 + i * 0.05) * 100) / 100);

/** How many examples a setting gets wrong. */
export function evaluate(examples, priorities, threshold) {
  let falseZaps = 0;
  let missed = 0;
  for (const ex of examples) {
    const zap = offLensConfidence(ex.matches, priorities).offLens >= threshold;
    if (zap && ex.label === 'keep') falseZaps++;
    else if (!zap && ex.label === 'zap') missed++;
  }
  return { falseZaps, missed, wrong: falseZaps + missed, total: examples.length };
}

/** The best threshold for fixed weights; ties go to the one nearest the current. */
function bestThreshold(offs, labels, current) {
  let best = null;
  for (const t of THRESHOLDS) {
    let cost = 0;
    for (let i = 0; i < offs.length; i++) {
      const zap = offs[i] >= t;
      if (zap && labels[i] === 'keep') cost += COST_FALSE_ZAP;
      else if (!zap && labels[i] === 'zap') cost += COST_MISSED;
    }
    if (!best || cost < best.cost || (cost === best.cost && Math.abs(t - current) < Math.abs(best.t - current))) best = { t, cost };
  }
  return best;
}

/**
 * Suggest a threshold and weights for the reader's examples.
 *
 * @param {{matches: Record<string, number>, label: 'keep'|'zap'}[]} examples
 * @param {{topic: string, weight: number}[]} priorities - current weights (drafts included)
 * @param {number} threshold - current threshold
 * @returns {{needMore: number} | {threshold: number, weights: Record<string, number>,
 *           changes: {topic: string, from: number, to: number}[], unmatched: number,
 *           before: object, after: object}}
 */
export function suggest(examples, priorities, threshold) {
  const usable = examples.filter((e) => e && e.matches && (e.label === 'keep' || e.label === 'zap'));
  if (usable.length < MIN_EXAMPLES) return { needMore: MIN_EXAMPLES - usable.length };
  const labels = usable.map((e) => e.label);
  const current = priorities.map((p) => ({ ...p }));
  const weights = priorities.map((p) => ({ ...p }));

  const costOf = (ws) => {
    const offs = usable.map((e) => offLensConfidence(e.matches, ws).offLens);
    const b = bestThreshold(offs, labels, threshold);
    const drift = ws.reduce((s, p, i) => s + Math.abs(p.weight - current[i].weight), 0);
    return { cost: b.cost + COST_PER_WEIGHT * drift, t: b.t };
  };

  // Steepest descent: each round makes the one weight change, across all
  // topics, that lowers the cost most, and stops when none does.
  let best = costOf(weights);
  for (let round = 0; round < 8; round++) {
    let move = null;
    for (let i = 0; i < weights.length; i++) {
      const keep = weights[i].weight;
      for (const w of WEIGHTS) {
        if (w === keep) continue;
        weights[i].weight = w;
        const c = costOf(weights);
        if (c.cost < (move ? move.cost : best.cost) - 1e-9) move = { i, w, ...c };
      }
      weights[i].weight = keep;
    }
    if (!move) break;
    weights[move.i].weight = move.w;
    best = { cost: move.cost, t: move.t };
  }

  // Kept blocks that match none of the interests: no weight or threshold can
  // keep them. The fix is a new interest, which only the reader can name.
  const unmatched = usable.filter((e) => e.label === 'keep' && Object.values(e.matches).every((m) => m < 0.05)).length;

  const changes = weights
    .map((p, i) => ({ topic: p.topic, from: current[i].weight, to: p.weight }))
    .filter((c) => c.from !== c.to);
  return {
    threshold: best.t,
    weights: Object.fromEntries(weights.map((p) => [p.topic, p.weight])),
    changes,
    unmatched,
    before: evaluate(usable, current, threshold),
    after: evaluate(usable, weights, best.t)
  };
}

/** Keep an example to the numbers for known topics, rounded; nothing else. */
export function toExample(score, label, topics) {
  // Corrections and sources are never zapped, so they teach nothing here.
  if (!score || score.unscored || score.evidence || !score.matches || !['keep', 'zap'].includes(label)) return null;
  const matches = {};
  for (const t of topics) matches[t] = Math.round(Math.min(1, Math.max(0, Number(score.matches[t] ?? 0))) * 1000) / 1000;
  return { matches, label };
}
