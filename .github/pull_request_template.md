## What this changes

<!-- One or two sentences. Link the issue if there is one. -->

## How it was checked

- [ ] `npm test` passes
- [ ] `npm run browser-check` passes (if `content/`, `sidepanel/`, or `background/` changed)

## Rules

- [ ] Hides by style only; no page nodes removed, rewritten, or reordered
- [ ] Every hidden block is still in the ledger
- [ ] No network requests beyond the loopback model endpoint
- [ ] Nothing about pages read goes into a lens or training mark
- [ ] `core/*.js` stays DOM-free
- [ ] New code files carry `SPDX-License-Identifier: Apache-2.0`
