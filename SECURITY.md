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

- **Local by default.** A local model endpoint must be a loopback address
  (`localhost`, `127.0.0.1`, or `[::1]`). The manifest grants host access to
  loopback only. Page text is sent to your local model and nowhere else.
- **Hosted only when you set it up.** The one exception is a hosted model you
  choose under Settings with your own key. Its host (Cloudflare, TypeSafe,
  OpenRouter, or an https endpoint you name) is an optional permission, asked
  for when you save and given back by **Forget key**. Only block text and your
  interest topics are sent, only to that host, never from a site you keep off
  the hosted model, and never while paused. The key is never sent to pages or
  shown in the side panel or debug reports.
- **The in-browser model downloads only when you ask.** Its files come from
  huggingface.co when you click Download in Settings; the access is an
  optional permission asked for on that click and removed when the download
  ends. After that it reads only the downloaded files and the libraries
  shipped in `vendor/` (hash-checked by `npm test`), runs in the extension's
  own offscreen page, and sends nothing anywhere.
- **Nothing is deleted from the page.** Zapping hides blocks with a style and
  never removes, rewrites, or reorders nodes, so **Before** and **Show** always
  give back the page as published.
- **A held page always shows.** With Settings → "Hold the first screen until
  it is scored" on, pages start transparent until their first screen is
  judged, and blocks still being judged after 3 seconds stay invisible in
  place. The stylesheet ends both holds by itself (8 seconds for the page, 10
  for a block), with no script needed, so a silent model or a broken content
  script never leaves a page blank. It is never applied on a paused site or while
  paused everywhere. It needs no extra permission: a small document_start
  script reads the setting and marks the page, and does nothing else.
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
- What a hosted provider you chose does with the text it receives. That is
  governed by its terms.
- A page hiding or showing its own content. LensZap only decides what it hides.
