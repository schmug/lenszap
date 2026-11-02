# Security policy

## Reporting a problem

Please report security problems privately, through GitHub's
[private vulnerability reporting](https://github.com/schmug/lenszap/security/advisories/new)
(the **Security** tab, then **Report a vulnerability**). Please don't open a
public issue for anything that could put users at risk.

Include what you saw, the steps to reproduce it, your Chrome version, and the
LensZap version (from `chrome://extensions`). You should hear back within a
week. LensZap is a small project run by one person, so there is no bounty.

## Supported versions

Only the latest release on `main` gets fixes.

## What LensZap promises

These are the security and privacy properties the extension is built to keep.
A way to break any of them is a security problem worth reporting.

- **Local only.** The model endpoint must be a loopback address
  (`localhost`, `127.0.0.1`, or `[::1]`). The manifest grants host access to
  loopback only, and the extension makes no other network requests. Page text
  is sent to your local model and nowhere else.
- **Nothing is deleted from the page.** Zapping hides blocks with a style and
  never removes, rewrites, or reorders nodes, so **Before** and **Show** always
  give back the page as published.
- **Every hidden block is accounted for.** The ledger lists every hidden block,
  and after every pass the zapper checks the page against it; on a mismatch it
  restores everything.
- **Lenses stay history-free.** A saved lens holds your interests and their
  weights, never the pages you read. Training marks store a block's scores and
  your label, never its text or URL. Drafts, per-site settings, and training
  marks stay in the extension's local storage.

## Out of scope

- The local model server itself (for example, llama-server) and anything else
  listening on loopback. LensZap trusts whatever answers on the endpoint you
  configure.
- A page hiding or showing its own content. LensZap only decides what it hides.
