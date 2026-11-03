// SPDX-License-Identifier: Apache-2.0
//
// Pause state. The reader can pause zapping everywhere (settings.paused) or on
// one site (sites[host].paused). Either way the zapper is inert on the page:
// no model calls, no scoring, nothing hidden, nothing drawn. Pausing mid-page
// stops the queue and cancels requests already sent. Resuming picks up where
// it stopped: scores that arrived before the pause (and the session cache) are
// used at once, and the rest is scored as usual. The two pauses are
// independent: resuming everywhere leaves a site's own pause in place.
// Pure and DOM-free.

/**
 * Why zapping is paused, or null when it is not.
 * @returns {null | 'everywhere' | 'site' | 'both'}
 */
export function pauseScope(settings, site) {
  const all = settings?.paused === true;
  const here = site?.paused === true;
  if (all && here) return 'both';
  if (all) return 'everywhere';
  if (here) return 'site';
  return null;
}

/** Whether zapping is paused on `host`, from stored settings and sites. */
export function isPausedOn(settings, sites, host) {
  return pauseScope(settings, sites?.[host]) !== null;
}

/**
 * What a change of state means for a page: 'pause' (stop everything now),
 * 'resume' (start scoring again), or null (no change).
 */
export function pauseTransition(wasPaused, nowPaused) {
  if (!wasPaused && nowPaused) return 'pause';
  if (wasPaused && !nowPaused) return 'resume';
  return null;
}

/** A short phrase for the panel header, popover, and toolbar tooltip. */
export function pauseLabel(scope) {
  return {
    everywhere: 'Paused everywhere',
    site: 'Paused on this site',
    both: 'Paused everywhere and on this site'
  }[scope] ?? '';
}

/** Toolbar badge for a tab: text, colour, and tooltip. */
export function badgeFor(page, browserPaused = false) {
  const scope = page ? page.pausedBy ?? (page.paused ? 'site' : null) : browserPaused ? 'everywhere' : null;
  if (scope) return { text: '‖', color: '#6b6b76', title: `LensZap: ${pauseLabel(scope).toLowerCase()}` };
  const n = page?.zapped?.length ?? 0;
  return { text: n ? String(n) : '', color: '#c62828', title: n ? `LensZap: ${n} hidden on this page` : 'LensZap' };
}
