// SPDX-License-Identifier: Apache-2.0
//
// Pause state. The reader can pause zapping everywhere (settings.paused) or on
// one site (sites[host].paused). Either way nothing is hidden and nothing is
// drawn on the page; blocks are still scored so resuming is instant. The two
// are independent: resuming everywhere leaves a site's own pause in place.
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
