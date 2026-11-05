# CLAUDE.md — LensZap

## What this repository is

A Chromium (MV3) extension that hides page blocks that are off the reader's
interests, judged by a local model. It is **built on LensPub**
(https://github.com/schmug/lenspub) and is deliberately **not a LensPub
engine**: a conforming Lens Engine never hides content by default, and this
tool does. The reasoning is in LensPub's
`docs/explorations/semantic-zapper.md`, Section 5. Never describe LensZap with
Lens Engine conformance language. It claims only **Manifest Consumer** (it
rejects lenses that fail the schema) and **Manifest Producer** (every lens it
saves validates, is versioned by impact class, and is history-free).

## Commands

```
npm install              # once; Ajv and Playwright devDependencies
npx playwright install chromium   # once, for capture and browser-check
npm test                 # test/run-tests.mjs + test/repo-checks.mjs — pure modules, Ajv validation, repo guards (CI, Node 22 and 24)
npm run browser-check    # test/browser-check.mjs — the extension in Chromium via Playwright (not in CI)
npm run bench            # bench/bench.mjs — speed and wrong-zap rates for a scorer on this machine
npm run check-upstream -- /path/to/lenspub   # has LensPub's lens schema moved?
npm run capture -- URL…   # eval/capture.mjs — real pages → blocks via the extension's splitter (eval/data/, git-ignored)
npm run label            # eval/label.mjs — local labelling page for captured blocks
npm run eval             # eval/run.mjs — wrong-zap / miss / ad / evidence / bad-split rates on labelled pages
npm run compare-models   # eval/compare-models.mjs — the eval once per llama-server decision model, with speed and memory
npm run history-lens     # eval/history-lens.mjs — spike: history → topic groups → weights table → lens + capture list; 3D map (local only)
npm run browser-scorer -- --kind nli|embed|webllm --model ID   # eval/browser-scorer.mjs — WebGPU in-browser model on 127.0.0.1:8283 (spike; libs via npm install --no-save)
npm run two-pass -- --fast ID --slow ID   # eval/two-pass.mjs — fast-then-Kev combinations from cached scores (--list for ids)
npm run dev -- --site X  # scripts/dev.mjs — offline dev browser with the extension; reloads it on every save
npm run test:watch       # npm test's unit tests, re-run on save
npm version patch|minor|major   # bump package.json, lock, and manifest.json together (no commit/tag)
npm run check-version    # scripts/version.mjs — did extension files change without a version bump? (CI on PRs)
```

Dev-loop defaults come from `LENSZAP_API`, `LENSZAP_ENDPOINT`, `LENSZAP_LENS` (see
README "A fast dev loop"). The eval's score cache (`eval/data/cache/`) is a
developer file under the git-ignored data folder; it is never part of the
extension, whose score cache stays in `chrome.storage.session`.

No build step and no runtime dependencies: load the directory unpacked.

## Rules that are easy to break by accident

- **Hide by style, never by DOM surgery.** Zapping sets attributes that
  `content/zap.css` hides. Nodes are never removed, rewritten, or reordered, so
  Before/Show always give back the page as published.
- **Every hidden block is in the ledger**, and `checkLedger` runs after every
  pass; on a mismatch everything is restored.
- **Never zapped:** page chrome and controls, corrections and primary sources,
  and any block the scorer returned nothing for.
- **The first-screen hold fails open.** With `settings.holdFirstScreen` on,
  `content/hold-start.js` (document_start, every page) marks
  `<html data-lpz-hold>` while the page is still parsing, and
  `content/hold.css` holds it (core/hold.js `shouldHold`; the two are tested
  to agree). Don't register it dynamically: Chrome injects dynamic scripts
  only where the extension has host permission, which is loopback. The content script
  lifts it on scores, failure, or pause, and at most `HOLD_MS` after it
  starts, marking first-screen blocks still being scored `data-lpz-pending`
  (invisible in place) until judged. The stylesheet's animations end both with
  no script (`HOLD_MAX_MS`, `PENDING_MAX_MS`; tested to match). Never
  applied on paused sites or while paused everywhere.
- **Unmatched blocks** (matching none of the positive interests) are kept by
  default; `settings.hideUnmatched` (Settings → "Also hide blocks that match
  none of my interests") hides them too. `decide()` and `offLensConfidence()`
  default to hiding, for callers that don't pass the setting; the extension
  always passes it. Eval labels: `zap` = matches a "less of this" interest,
  `neutral` = matches none; `npm run eval -- --hide-unmatched` for the other mode.
- **Ad slots** (core/segment.js `adSlotScore`) are judged by structure, not
  text, and are zapped only when the lens has a negative interest about ads;
  otherwise they are unscored and never zapped.
- **Local by default.** A local model endpoint must be loopback
  (`isLoopbackEndpoint`). The one exception is the opt-in hosted scorer,
  bring your own key (`core/hosted.js`, settings `scorer: 'hosted'`): https
  only, its host is an `optional_host_permissions` entry requested from the
  Save click, never used on a site with `sites[host].noHosted` (that site is
  scored by nothing) or while paused. The key lives in `hostedKeys`, apart
  from settings, and never reaches pages, the side panel, or debug reports.
  No other network requests. Local stays the default scorer.
- **Lenses stay history-free.** Nothing about pages read goes into a lens.
  Drafts, per-site settings, and training marks are local Adaptation State.
  Training marks hold scores and a label only: no text, no URL.
- **Saved lenses** go through `core/lens-edit.js` (`commitDraft`,
  `commitEdit`), which classifies impact per LensPub's Adaptation Model §4,
  appends `versionHistory` by content hash with no date, rounds `modified` to
  the day, and validates.
- `core/*.js` is **pure and DOM-free**; the same files run in the extension and
  under Node.
- `core/lens-manifest.schema.js` and `core/schema-check.js` are copies of
  LensPub files kept in `upstream/` at the commit in `upstream/LENSPUB_COMMIT`;
  tests assert they match. Change them only by syncing from LensPub.
- `eval/` is developer tooling, never loaded by the extension. Captured page
  text stays in `eval/data/` (git-ignored); only fictional demo pages are
  committed.
- `eval/history-lens.mjs` reads browser history: it never prints a title,
  address, or site (counts and topic names only), keeps everything in
  `eval/data/history/`, and its lens holds only topic names and weights.
- New code files carry `SPDX-License-Identifier: Apache-2.0`.
- **Bump the version** when a change touches anything the browser loads
  (`manifest.json`, `background/`, `content/`, `core/`, `sidepanel/`,
  `lenses/`): `npm version patch|minor|major`, then a `## X.Y.Z` entry in
  CHANGELOG.md. CI fails a PR that skips it; see CONTRIBUTING.md "Versions".

## Pull requests merge themselves

During rapid development `.github/workflows/automerge.yml` turns on auto-merge
(squash) for every non-draft PR from a branch here, so a PR merges once the
required checks on main pass, with no review wait. Open a PR only when it is
ready to land; open it as a draft, or add the `no-automerge` label, to hold it.
