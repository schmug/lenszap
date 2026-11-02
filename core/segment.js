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

/** Shortest text for a block, and for a headline inside a list of stories. */
export const MIN_CHARS = 40;
export const MIN_HEADLINE_CHARS = 20;
/** Longest container kept as one block. */
export const MAX_CONTAINER_CHARS = 1200;
/** Longest container that can be skipped as a line or list of short links. */
export const LINK_LINE_MAX_CHARS = 600;
/** Longest card without a heading kept whole on the strength of one headline link. */
export const CARD_MAX_CHARS = 600;
/** A link at least this long reads as a story headline, not a tag or a control. */
export const STORY_LINK_CHARS = 25;

/**
 * Decide what the walk does with one element, from numbers the content script
 * measures:
 *   'skip'  - not a block and not walked into (too short, or a line of links
 *             such as tags, categories, tabs, or a pager: page chrome, never zapped);
 *   'block' - one block;
 *   'split' - walk into its children.
 *
 * @param {{chars: number, leafy: boolean, containerish: boolean,
 *   headings: number, storyLinks: number, links: number, linkChars: number,
 *   letters: number, linkLetters: number,
 *   severalChildren: boolean, hasControls: boolean, inStories?: boolean, hasLink?: boolean}} m
 *   headings: h2–h6 inside; storyLinks: distinct links of STORY_LINK_CHARS or more;
 *   links, linkChars: all links and their text length; letters, linkLetters:
 *   letters (not digits or punctuation) in the text and in its links; severalChildren: two or
 *   more children of MIN_CHARS or more; hasControls: holds an input, a form with
 *   one, a dialog, nav, h1, or an existing block; inStories: inside a container
 *   that was split because it holds several stories.
 */
export function splitDecision(m) {
  const min = m.inStories && m.hasLink ? MIN_HEADLINE_CHARS : MIN_CHARS;
  if (m.chars < min) return 'skip';
  // Mostly short links: tags, categories, tabs, a pager. Only a small element:
  // a whole page or column can be mostly short links and still hold stories.
  const small = m.leafy || (m.chars <= LINK_LINE_MAX_CHARS && m.storyLinks === 0);
  if (small && m.links >= 3 && m.linkLetters >= 0.7 * m.letters && m.linkChars / m.links < 20) return 'skip';
  if (m.hasControls) return 'split';
  if (m.leafy) return 'block';
  if (!m.containerish || m.chars > MAX_CONTAINER_CHARS) return 'split';
  // One titled item (a repo card, a story teaser) stays whole, whatever its parts.
  if (m.headings === 1 && m.storyLinks <= 1) return 'block';
  // A card with one headline link and no heading (headline, dek, byline, comment
  // count): one item, so the byline and comment count never stand alone.
  if (m.headings === 0 && m.storyLinks === 1 && m.chars <= CARD_MAX_CHARS) return 'block';
  // Several headlines: a feed, a "Most read" list, a multi-story card.
  if (m.headings >= 2 || m.storyLinks >= 2) return 'split';
  return m.severalChildren ? 'split' : 'block';
}
