# Changelog

Each release of the extension, newest first. The version is in
`manifest.json` (what Chrome shows on `chrome://extensions`) and
`package.json`; see CONTRIBUTING.md "Versions" for how to bump it.

Versions are MAJOR.MINOR.PATCH. While LensZap is below 1.0, a MINOR bump may
include a breaking change; it says so here.

## 0.7.0

- **Stats tab.** A new side-panel tab with numbers on how LensZap is doing.
  For the page you're on: time on the page (counted only while it is visible
  and not paused), blocks found, scored, and hidden, about how long the
  hidden blocks would have taken to read (238 words a minute), scoring time
  per block (average, median, p95, slowest), how long the first screen and
  the rest of the page near it took to judge, how many blocks came from the
  score cache or were settled by the in-browser model, and failed requests.
  The same are added up for the site and for all sites since the browser
  started, with a short list of the sites hiding the most.
- Cache hits and in-browser settles are counted apart from model time, so a
  warm cache doesn't make a slow model look fast.
- Stats are kept in memory only (`chrome.storage.session`, like the score
  cache): forgotten when the browser closes, never sent anywhere, never
  written to the lens. Nothing is counted while paused or in incognito
  windows. **Reset session stats** on the tab, or Settings → "Clear it",
  wipes them.
- The debug report includes the page's stats.

## 0.6.0

- **In-browser model.** LensZap can now run a small model itself, on your
  graphics card (WebGPU), with no model server: Settings → Scorer → "The
  in-browser model". It is `Xenova/nli-deberta-v3-small`, downloaded once
  when you click **Download** (from huggingface.co, into this browser; the
  access is asked for on the click and given back after), and deleted with
  **Delete the model**. It scores a block in about 30 ms.
- **Ask it first.** With a local or hosted model, "Ask it first" lets the
  in-browser model score every block and sends only the blocks it rates at
  least 10% off your lens on to that model. On real front pages (Ars
  Technica, The Verge, Hacker News) Kev-4B got 4–8 requests a page instead of
  12–30, with the same blocks hidden. If the in-browser model fails, every
  block goes to the model as before.
- **Fix: pages that re-render after scoring.** When scores arrived before a
  site swapped in new nodes for blocks (hydration), the ledger check failed
  and every hidden block came back for the rest of the visit. Blocks the page
  has taken out are now forgotten before each pass, and their replacements
  are judged afresh. Fast scorers and a warm score cache made this common.
- The extension now ships transformers.js and onnxruntime-web, unmodified, in
  `vendor/` (see vendor/README.md), and asks for the `offscreen` permission to
  run them. They load only in the in-browser scorer's own page.

## 0.5.2

- **Hold the first screen** now works on real sites. 0.5.0 and 0.5.1 held
  pages only on localhost: Chrome injects a dynamically registered stylesheet
  only where the extension has host permission, and LensZap's is loopback
  only. A small document_start script now reads the setting and marks the
  page instead. The `scripting` permission is gone.

## 0.5.1

- **Hold the first screen** now works with a local model and on heavy pages.
  The 3-second limit counts from when LensZap starts on the page, not from
  navigation (a slow page used it all up before scoring began). First-screen
  blocks still being judged at the limit stay invisible in place until judged,
  instead of appearing and then zapping. The stylesheet's own fail-open
  ceilings are now 8 s for the page and 10 s for a block.

## 0.5.0

- **Hold the first screen until it is scored** (Settings → Display, off by
  default). A page you open stays blank until the blocks on its first screen
  are judged, so zapped blocks never flash into view. The hold ends after 3
  seconds at most, even if the model is silent, and at once if it fails. Never
  on a paused site or while paused everywhere. Adds the `scripting` permission,
  used only to register the hold stylesheet while the setting is on.

## 0.4.0

- **Hosted scorer, opt-in.** Settings can point scoring at a hosted model with
  your own API key, for speed or when you can't run a model locally. Local
  stays the default; the extension asks for the provider's host only when you
  set one up.

## 0.3.1

- Turning off Settings → hover info now closes a popover that is already open.

## 0.3.0

- **Pause everywhere**, alongside pause on this site. A paused site or browser
  is fully inert: no model calls, no scoring, nothing drawn on the page.
- **Ads.** Display ads, image ads, and ad-network iframes are recognised by
  structure and zapped when your lens has a "less of ads" interest. An ad slot
  never takes a whole column, and a slot that fills with text is let go.
- **Behaviour change:** blocks that match none of your interests are now kept
  by default. Settings → "Also hide blocks that match none of my interests"
  hides them again.
- **Scoring.** The model threshold defaults to 65%. Only blocks near the
  screen are scored, and the score cache lives in session storage. Updates,
  court records, and (PDF) citations count as evidence and are never zapped.
- **Splitter.** Titled items and link-wrapped cards stay whole, multi-story
  cards split, link lines are skipped, captions attach to their images,
  `display: contents` wrappers are walked into, and a paragraph ending in a
  colon stays with what it introduces.
- **Side panel** follows the system light or dark theme, and has a debug
  report for troubleshooting.
- **Fix:** editing a lens that was never saved no longer shows as invalid.
- Developer tooling (not part of the extension): the eval (capture, label,
  run, compare-models), the offline dev browser, demo recording, CI, and repo
  basics.

## 0.2.0

- Controls move into Chrome's side panel: lens editor, training mode, and a
  calmer scoring indicator.
