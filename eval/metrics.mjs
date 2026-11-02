// SPDX-License-Identifier: Apache-2.0
//
// Scoring the zapper's decisions against hand labels. Pure: no I/O, so the
// tests can check it directly.

import { SHOULD_HIDE, SHOULD_KEEP, SPLIT_PROBLEM } from './lib.mjs';

/**
 * Compare decisions with labels.
 *
 * @param {{key: string, zap: boolean}[]} decisions - one per scored block
 * @param {Record<string, string>} labels - block key → label
 * @returns counts, plus the keys of every mistake so a report can show them
 */
export function compare(decisions, labels, { hideUnmatched = true } = {}) {
  const c = {
    labelled: 0,
    keep: 0, zap: 0, neutral: 0, ad: 0, evidence: 0, chrome: 0, mixed: 0,
    // neutral blocks counted as should-go (hideUnmatched) or as should-stay
    neutralShouldGo: 0, neutralShouldStay: 0,
    keptHidden: [], // labelled keep, but hidden: the worst mistake for a reader
    evidenceHidden: [], // must always be empty
    zapMissed: [], // labelled zap, left visible
    adMissed: [], // labelled ad, left visible
    hiddenCorrect: 0
  };
  for (const { key, zap } of decisions) {
    const l = labels[key];
    if (!l || l === 'skip') continue;
    c.labelled++;
    if (l in c && typeof c[l] === 'number') c[l]++;
    if (SPLIT_PROBLEM.has(l)) continue;
    if (l === 'neutral') {
      // A block matching none of the interests: should go only if unmatched blocks are hidden.
      if (hideUnmatched) { c.neutralShouldGo++; if (zap) c.hiddenCorrect++; else c.zapMissed.push(key); }
      else { c.neutralShouldStay++; if (zap) c.keptHidden.push(key); }
      continue;
    }
    if (SHOULD_HIDE.has(l)) {
      if (zap) c.hiddenCorrect++;
      else (l === 'ad' ? c.adMissed : c.zapMissed).push(key);
    } else if (SHOULD_KEEP.has(l) && zap) {
      (l === 'evidence' ? c.evidenceHidden : c.keptHidden).push(key);
    }
  }
  return c;
}

/** Sum several pages' compare() results. */
export function total(results) {
  const t = compare([], {});
  for (const r of results) {
    for (const [k, v] of Object.entries(r)) {
      if (Array.isArray(v)) t[k].push(...v);
      else t[k] += v;
    }
  }
  return t;
}

/**
 * Headline rates, each in [0, 1] or null when there is nothing to measure.
 *  - wrongZapRate: of the blocks that should stay, how many were hidden.
 *  - missRate: of the blocks that should go (off-lens and ads), how many stayed.
 *  - precision: of the blocks hidden among the labelled ones, how many should have been.
 *  - splitProblemRate: of the labelled blocks, how many the splitter got wrong.
 */
export function rates(t) {
  const shouldKeep = t.keep + t.evidence + t.neutralShouldStay;
  const shouldHide = t.zap + t.ad + t.neutralShouldGo;
  const hiddenLabelled = t.hiddenCorrect + t.keptHidden.length + t.evidenceHidden.length;
  const div = (a, b) => (b > 0 ? a / b : null);
  return {
    wrongZapRate: div(t.keptHidden.length + t.evidenceHidden.length, shouldKeep),
    missRate: div(t.zapMissed.length + t.adMissed.length, shouldHide),
    precision: div(t.hiddenCorrect, hiddenLabelled),
    splitProblemRate: div(t.chrome + t.mixed, t.labelled)
  };
}
