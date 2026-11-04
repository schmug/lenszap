// SPDX-License-Identifier: Apache-2.0
//
// Settings → "Hold the first screen until it is scored". Runs at
// document_start on every page; when the hold applies here, marks
// <html data-lpz-hold> so content/hold.css keeps the page transparent until
// content/content.js has judged the first screen. Does nothing else, and
// nothing at all when the setting is off or the site or browser is paused, or
// when the page finished parsing before the setting could be read.
// The check is core/hold.js shouldHold(), repeated here because a manifest
// content script cannot import (test/run-tests.mjs runs this file against it).

(() => {
  if (window.top !== window) return;
  const host = location.hostname;
  chrome.storage.local.get(['settings', 'sites']).then(({ settings, sites }) => {
    const site = sites?.[host];
    if (settings?.holdFirstScreen !== true || settings?.paused === true) return;
    if (site?.paused === true) return;
    if ((settings.scorer ?? 'lexical') === 'hosted' && site?.noHosted === true) return; // scored by nothing
    const html = document.documentElement;
    // Too late once the page has finished parsing: the content script may
    // already have looked for the hold, and nothing would lift it but the
    // stylesheet's own ceiling.
    if (!html || document.readyState !== 'loading' || html.hasAttribute('data-lpz-shown')) return;
    html.setAttribute('data-lpz-hold', '');
  }).catch(() => {});
})();
