## What this changes

<!-- One or two sentences. Link the issue if there is one. -->

## How it was checked

- [ ] `npm test` passes
- [ ] `npm run browser-check` passes (if `content/`, `sidepanel/`, or `background/` changed)
- [ ] Version bumped with `npm version patch|minor|major` and CHANGELOG.md updated (if anything the browser loads changed)

## Rules

- [ ] Hides by style only; no page nodes removed, rewritten, or reordered
- [ ] Every hidden block is still in the ledger
- [ ] No network requests beyond the loopback model endpoint, or the hosted provider the reader set up with their own key (`core/hosted.js`)
- [ ] Nothing about pages read goes into a lens or training mark
- [ ] `core/*.js` stays DOM-free
- [ ] New code files carry `SPDX-License-Identifier: Apache-2.0`
