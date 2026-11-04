// SPDX-License-Identifier: Apache-2.0
//
// Hold the first screen until it is scored (opt-in, settings.holdFirstScreen).
// With it on, the extension registers content/hold.css at document_start,
// which keeps the page transparent so zapped blocks never appear and then
// vanish. The content script lifts the hold as soon as every block on the
// first screen is scored (or the model fails, or the page is paused). The
// stylesheet also lifts itself after HOLD_MS with no script at all, so a slow
// or silent model, or a crashed content script, never leaves a page blank.
// Only the first screen is waited for: blocks further down are scored and
// zapped as usual, out of sight.
// Pure and DOM-free.

import { effectiveScorer } from './hosted.js';

/** The hard ceiling on a hold, in ms from navigation start. Keep in step with content/hold.css. */
export const HOLD_MS = 3000;

export const HOLD_SCRIPT_ID = 'lpz-hold';

// A host Chrome accepts in a match pattern. Anything else (an IPv6 literal,
// say) is left out of the exclusions; the content script then lifts the hold
// on that page at once.
const PATTERN_HOST = /^[a-z0-9.-]+$/i;

/**
 * The dynamic content script that holds pages, or null when nothing should be
 * held: the setting is off, or zapping is paused everywhere. Sites paused on
 * their own, and sites kept off the hosted model (scored by nothing), are
 * excluded, so a paused page is never touched.
 */
export function holdScript(settings, sites = {}) {
  if (settings?.holdFirstScreen !== true || settings?.paused === true) return null;
  const excludeMatches = Object.entries(sites ?? {})
    .filter(([host, site]) => PATTERN_HOST.test(host) && (site?.paused === true || effectiveScorer(settings, site) === 'none'))
    .map(([host]) => `*://${host}/*`)
    .sort();
  return {
    id: HOLD_SCRIPT_ID,
    matches: ['http://*/*', 'https://*/*'],
    excludeMatches,
    css: ['content/hold.css'],
    runAt: 'document_start',
    allFrames: false,
    persistAcrossSessions: true
  };
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
