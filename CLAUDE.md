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
npm install              # once; Ajv devDependencies for the tests
npm test                 # test/run-tests.mjs — pure modules + Ajv validation (CI, Node 18 and 22)
npm run browser-check    # test/browser-check.mjs — the extension in Chromium via Playwright (not in CI)
npm run bench            # bench/bench.mjs — speed and wrong-zap rates for a scorer on this machine
npm run check-upstream -- /path/to/lenspub   # has LensPub's lens schema moved?
```

No build step and no runtime dependencies: load the directory unpacked.

## Rules that are easy to break by accident

- **Hide by style, never by DOM surgery.** Zapping sets attributes that
  `content/zap.css` hides. Nodes are never removed, rewritten, or reordered, so
  Before/Show always give back the page as published.
- **Every hidden block is in the ledger**, and `checkLedger` runs after every
  pass; on a mismatch everything is restored.
- **Never zapped:** page chrome and controls, corrections and primary sources,
  and any block the scorer returned nothing for.
- **Local only.** The model endpoint must be loopback (`isLoopbackEndpoint`).
  The extension makes no other network requests.
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
- New code files carry `SPDX-License-Identifier: Apache-2.0`.
