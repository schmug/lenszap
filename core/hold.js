// SPDX-License-Identifier: Apache-2.0
//
// Hold the first screen until it is scored (opt-in, settings.holdFirstScreen).
// content/hold-start.js runs at document_start on every page and, when
// shouldHold() says so, marks <html data-lpz-hold>; content/hold.css then
// keeps the page transparent so zapped blocks never appear and then vanish.
// (A dynamically registered stylesheet would need host permission for every
// site; the manifest keeps host access to loopback only.) The content script
// lifts the hold as soon as every block on the first screen is scored (or the
// model fails, or the page is paused), and at most HOLD_MS after it starts;
// first-screen blocks still being scored then stay invisible in place until
// judged. The stylesheet also lifts both by itself (HOLD_MAX_MS,
// PENDING_MAX_MS) with no script at all, so a slow or silent model, or a
// crashed content script, never leaves a page blank. Only the first screen is
// waited for: blocks further down are scored and zapped as usual, out of sight.
// Pure and DOM-free.

import { effectiveScorer } from './hosted.js';

/** How long the content script holds the page, in ms from when it starts. */
export const HOLD_MS = 3000;
/** The stylesheet's own ceilings, needing no script. Keep in step with content/hold.css. */
export const HOLD_MAX_MS = 8000; // the page, from when it is marked held (document_start)
export const PENDING_MAX_MS = 10000; // a first-screen block still being scored, from when the page showed

/**
 * Whether a page on a site should be held: the setting is on, nothing is
 * paused, and the site is scored by something (not kept off the hosted
 * model). content/hold-start.js repeats this check (it cannot import);
 * test/run-tests.mjs runs that file against the same cases.
 */
export function shouldHold(settings, site) {
  if (settings?.holdFirstScreen !== true || settings?.paused === true) return false;
  if (site?.paused === true) return false;
  return effectiveScorer(settings, site) !== 'none';
}

/**
 * Whether the content script can lift the hold now: true once no block on the
 * first screen is still waiting for a score.
 * @param {Iterable<string>} firstScreen ids of blocks on the first screen
 * @param {(id: string) => boolean} waiting whether a block is queued or being scored
 */
export function holdDone(firstScreen, waiting) {
  for (const id of firstScreen) if (waiting(id)) return false;
  return true;
}
