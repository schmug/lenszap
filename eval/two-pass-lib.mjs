// SPDX-License-Identifier: Apache-2.0
//
// Two-pass scoring, simulated from cached scores: a fast scorer (an in-browser
// encoder, eval/browser-scorer.mjs) runs first, a slow one (Kev-4B) second.
// Pure: no I/O, so the tests can check it directly. eval/two-pass.mjs runs it
// on labelled pages.
//
// Three ways to combine them, each checked against the labels:
//   early  The fast pass hides what it is sure about before the slow one
//          answers; the slow pass has the last word, so a block the fast pass
//          hid but the slow pass keeps comes back (a flicker). The final page
//          is the slow scorer's; what changes is how much is hidden early.
//   union  Hidden if either pass says so. The slow pass cannot bring a block back.
//   skip   The slow pass scores only blocks the fast pass is not sure are on
//          your lens (offLens >= skipBelow); the rest are kept unscored. Saves
//          slow-model calls; the cost is misses among the skipped blocks.

import { decide } from '../core/decide.js';
import { compare, total, rates } from './metrics.mjs';
import { SHOULD_HIDE, SHOULD_KEEP } from './lib.mjs';

/**
 * @param {{labels: Record<string,string>, fast: object[], slow: object[]}[]} pages
 *   per page: labels, and score lists (core/decide.js input shape) from each scorer
 *   for the same blocks
 * @param {{priorities: object[], fastAt: number, slowAt: number, skipBelow?: number, hideUnmatched?: boolean}} opts
 */
export function twoPass(pages, { priorities, fastAt, slowAt, skipBelow = 0.2, hideUnmatched = false }) {
  const out = { early: [], union: [], skip: [], fast: [], slow: [] };
  const flicker = { wanted: [], other: 0 };
  const earlyRight = { count: 0, ofSlowRight: 0 };
  let slowCalls = 0;
  let skipped = 0;
  for (const { labels, fast, slow } of pages) {
    const f = new Map(decide({ scores: fast, priorities, threshold: fastAt, scorer: 'fast', hideUnmatched }).map((d) => [d.id, d]));
    const s = new Map(decide({ scores: slow, priorities, threshold: slowAt, scorer: 'slow', hideUnmatched }).map((d) => [d.id, d]));
    const ids = [...s.keys()].filter((id) => f.has(id));
    const slot = new Set(fast.filter((x) => x.adSlot).map((x) => x.id));
    const shouldGo = (l) => SHOULD_HIDE.has(l) || (hideUnmatched && l === 'neutral');
    const shouldStay = (l) => SHOULD_KEEP.has(l) || (!hideUnmatched && l === 'neutral');
    const dec = (pick) => ids.map((id) => ({ key: id, zap: pick(f.get(id), s.get(id)) }));
    out.fast.push(compare(dec((a) => a.zap), labels, { hideUnmatched }));
    out.slow.push(compare(dec((_a, b) => b.zap), labels, { hideUnmatched }));
    out.early.push(compare(dec((_a, b) => b.zap), labels, { hideUnmatched }));
    out.union.push(compare(dec((a, b) => a.zap || b.zap), labels, { hideUnmatched }));
    // Ad slots are judged by structure, never by either model: skipping does not apply.
    out.skip.push(compare(dec((a, b) => (slot.has(a.id) || a.offLens >= skipBelow) && b.zap), labels, { hideUnmatched }));
    for (const id of ids) {
      const l = labels[id];
      const a = f.get(id);
      const b = s.get(id);
      if (!slot.has(id)) {
        if (a.offLens >= skipBelow) slowCalls++;
        else skipped++;
      }
      if (a.zap && !b.zap) {
        if (shouldStay(l) && l !== 'neutral') flicker.wanted.push(id);
        else flicker.other++;
      }
      if (b.zap && shouldGo(l)) {
        earlyRight.ofSlowRight++;
        if (a.zap) earlyRight.count++;
      }
    }
  }
  const sum = (list) => {
    const t = total(list);
    return { totals: t, rates: rates(t) };
  };
  return {
    fastAt,
    slowAt,
    skipBelow,
    fast: sum(out.fast),
    slow: sum(out.slow),
    union: sum(out.union),
    skip: { ...sum(out.skip), slowCalls, skipped },
    early: { ...sum(out.early), flickerWanted: flicker.wanted, flickerOther: flicker.other, hiddenEarly: earlyRight.count, slowCorrectZaps: earlyRight.ofSlowRight }
  };
}
