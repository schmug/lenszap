# Contributing to LensZap

Thanks for helping. LensZap is a Chromium (MV3) extension that hides page
blocks that are off your interests, judged by a local model. Read the
[README](README.md) first for what it does and how to load it.

## Setup

You need Node 22 or later and a Chromium-based browser.

```
npm install              # once; Ajv for the tests
npm test                 # pure modules, Ajv validation, and repository checks (runs in CI)
npm run browser-check    # the extension in Chromium via Playwright (not in CI)
npm run bench            # speed and wrong-zap rates for a scorer on this machine
```

There is no build step and there are no runtime dependencies. Load the
repository directory unpacked at `chrome://extensions` with Developer mode on.

## Rules that are easy to break

These hold across the whole codebase. The PR template asks about them.

- **Hide by style, never by DOM surgery.** Zapping sets attributes that
  `content/zap.css` hides. Never remove, rewrite, or reorder page nodes.
- **Every hidden block is in the ledger**, and `checkLedger` runs after every
  pass. On a mismatch everything is restored.
- **Never zapped:** page chrome and controls, corrections and primary sources,
  and any block the scorer returned nothing for.
- **Local by default.** A local endpoint must be loopback
  (`isLoopbackEndpoint`). The only other requests are to a hosted provider the
  reader set up with their own key (`core/hosted.js`), whose host is an
  optional permission. The tests fail if the manifest asks for non-loopback
  host access up front, or for optional hosts beyond the providers'.
- **Lenses stay history-free.** Nothing about pages read goes into a lens.
  Training marks hold scores and a label only: no text, no URL.
- **Saved lenses** go through `core/lens-edit.js` (`commitDraft`,
  `commitEdit`), which classifies impact, appends `versionHistory`, and
  validates.
- **`core/*.js` is pure and DOM-free**, so the same files run in the extension
  and under Node.
- **Don't edit the LensPub copies by hand.** `core/lens-manifest.schema.js`
  and `core/schema-check.js` mirror the files in `upstream/`; change them only
  by syncing with `npm run check-upstream -- /path/to/lenspub --update`.

## Describing LensZap

LensZap is built on [LensPub](https://github.com/schmug/lenspub) but is **not a
LensPub engine**, because it hides content and a conforming engine never does.
Don't describe it with Lens Engine conformance language. It claims only to be a
Manifest Consumer and a Manifest Producer.

## Code style

- New code files start with `// SPDX-License-Identifier: Apache-2.0` (or the
  CSS/HTML comment equivalent). The tests check this.
- Two-space indentation, LF line endings; `.editorconfig` sets this up for most
  editors.

## Versions

The extension's version is MAJOR.MINOR.PATCH, kept the same in
`manifest.json` (what Chrome shows), `package.json`, and `package-lock.json`.
A pull request that changes anything the browser loads (`manifest.json`,
`background/`, `content/`, `core/`, `sidepanel/`, `lenses/`) must raise it; CI
checks this. Tooling-only changes (`eval/`, `test/`, `scripts/`, docs) don't
need a bump.

```
npm version patch   # a fix: nothing new to learn
npm version minor   # a new feature or setting
npm version major   # breaking: saved settings, lenses, or storage no longer carry over
```

`npm version` updates `package.json` and the lock, and copies the version into
`manifest.json`; it makes no commit or tag (see `.npmrc`). Then add a
`## X.Y.Z` entry at the top of [CHANGELOG.md](CHANGELOG.md) saying what a
user will notice, and commit it with your change. Below 1.0, a breaking
change may go in a MINOR bump if the changelog says so.

If two open PRs both bump to the same number, the second to merge takes the
next one up when it resolves the conflict. `npm run check-version` runs the CI
check locally against `origin/main`.

## Pull requests

- Keep each PR to one change, and add or update tests for it.
- Run `npm test` before pushing. If you touched `content/`, `sidepanel/`, or
  `background/`, run `npm run browser-check` as well.
- Commit messages follow [Conventional Commits](https://www.conventionalcommits.org/)
  loosely, such as `feat(zapper): ...` or `fix(lens): ...`.

By contributing, you agree that your contributions are licensed under the
[Apache License 2.0](LICENSE).

## Security

Please report security problems privately. See [SECURITY.md](SECURITY.md).
