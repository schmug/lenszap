// SPDX-License-Identifier: Apache-2.0
//
// Pure helpers for splitting a page into blocks and choosing what to score
// first. DOM-free: the content script passes in elements (or anything with
// `nextElementSibling`) and numbers, so these run under Node in the tests.

/**
 * Site rules, for pages whose items the generic walk cannot find on its own.
 *
 * Hacker News lays out each story as table rows: the title row (tr.athing),
 * then a row with points, author and comment count, then a spacer. A generic
 * walk either takes the whole table as one block or skips the title rows as
 * too short. The rule makes each story one block, made of all its rows, judged
 * by the title row's text. On a comments page each comment is its own
 * tr.athing, so each comment becomes one block.
 *
 * `structural` lists page chrome the rule's site marks up without <nav> or
 * <header>. It is never scored and never zapped.
 */
export const SITE_RULES = [
  {
    name: 'Hacker News',
    hosts: ['news.ycombinator.com'],
    item: 'tr.athing',
    stop: 'tr.athing, tr.morespace',
    structural: '.pagetop, .yclinks, .morelink'
  }
];

/** The rule for a hostname, or null. Matches the host and its subdomains. */
export function siteRule(hostname, rules = SITE_RULES) {
  const h = String(hostname ?? '').toLowerCase();
  return rules.find((r) => r.hosts.some((x) => h === x || h.endsWith(`.${x}`))) ?? null;
}

/**
 * An item and the siblings that belong to it: everything after it up to (not
 * including) the first sibling for which `isStop` is true.
 */
export function groupWithFollowing(item, isStop) {
  const els = [item];
  for (let s = item.nextElementSibling; s && !isStop(s); s = s.nextElementSibling) els.push(s);
  return els;
}

/**
 * Order blocks for scoring: what the reader can see first (top to bottom),
 * then what is below the fold (nearest first), then what is above it.
 *
 * @param {{id: string, top: number, bottom: number}[]} items  viewport coordinates
 * @param {number} viewportHeight
 * @returns {string[]} ids in scoring order
 */
export function scoringOrder(items, viewportHeight) {
  const rank = ({ top, bottom }) => {
    if (bottom > 0 && top < viewportHeight) return [0, top];
    if (top >= viewportHeight) return [1, top - viewportHeight];
    return [2, -bottom];
  };
  return items
    .map((it) => ({ id: it.id, r: rank(it) }))
    .sort((a, b) => a.r[0] - b.r[0] || a.r[1] - b.r[1])
    .map((x) => x.id);
}
