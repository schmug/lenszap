# Changelog

Each release of the extension, newest first. The version is in
`manifest.json` (what Chrome shows on `chrome://extensions`) and
`package.json`; see CONTRIBUTING.md "Versions" for how to bump it.

Versions are MAJOR.MINOR.PATCH. While LensZap is below 1.0, a MINOR bump may
include a breaking change; it says so here.

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
