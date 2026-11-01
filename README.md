# LensPub Zapper (proof of concept)

> **Not a LensPub engine.** This tool uses your LensPub lens, but unlike a LensPub engine it hides parts of pages. A conforming Lens Engine never hides content by default ([Protocol §7.3](../spec/lenspub-protocol.md#73-unconditional-requirements)). This tool sits outside the protocol by design, and it is not tested by the [conformance suite](../conformance/README.md). The reasoning is in [Exploration: a semantic zapper built on LensPub](../docs/explorations/semantic-zapper.md), Section 5.

The zapper is a Chromium extension. On every page it splits the content into blocks, judges how well each block matches the interest topics in your [Lens Manifest](../spec/lens-manifest.md), and hides the blocks it is confident are off your lens, much like uBlock Origin's element zapper but chosen for you. Every hidden block is listed with its reasoning and can be put back.

![The fictional demo page with off-lens blocks hidden and the ledger open](screenshots/after.jpg)

## What it does

- **Zaps off-lens blocks.** Each block gets an "off-lens" confidence. A block is hidden when that confidence reaches your threshold. Interests you weight positively keep blocks; interests you weight negatively zap them.
- **Ledger.** The panel lists every hidden block with the reason it was hidden and a **Show** button. After every pass the zapper checks that the blocks hidden on the page are exactly the ones in the ledger. If they ever differ, it restores everything and says so.
- **Before / After.** **Before** shows the page as published, with zapped blocks outlined in red.
- **Confidence slider.** "Zap when at least this sure." By default it applies everywhere, or you can set it for one site only.
- **Interest sliders.** One slider per topic in your lens. Changes apply on every page as soon as you move a slider and are kept on this device while you browse. **Save to lens** writes them into your lens as one new version.
- **Pause on this site**, and **Restore all** on any page.

![Before: the page as published, with zapped blocks outlined](screenshots/before.jpg)

## Never zapped

The zapper never hides the following:
- headings, navigation, forms, dialogs (including cookie notices), and editable areas;
- corrections, clarifications, retractions, and passages citing a primary source;
- any block the scorer returned nothing for: when the model says nothing, the block stays.

Zapping is a style change only. Nodes are never removed or rewritten, so **Before** and **Show** always give back the page exactly as published.

## Scorers

| Scorer | Setup | Behavior |
|---|---|---|
| **Words only** (default) | None | Matches your topic words. It's fast and deterministic, but it zaps far too much on real pages, because a block about your topic that never uses its words looks off-lens. The demo page includes one such paragraph on purpose. |
| **Local model** | A model server on this machine | A small model rates every block against every topic, plus whether the block is a correction or cites a source. Moving a slider re-runs only the decision step, never the model. |

The local-model scorer speaks Ollama's native API and the OpenAI-compatible API served by llama.cpp's `llama-server`, LM Studio, and vLLM. **Only addresses on this machine are accepted** (localhost, 127.0.0.1, ::1), so page text never leaves your device ([ADR-0005](../adr/0005-local-only-default.md)).

To use Ollama:

```
OLLAMA_ORIGINS=chrome-extension://* ollama serve
ollama pull qwen3:4b
```

Then open the extension's settings, choose **A model running on this machine**, and keep the defaults (`http://localhost:11434`, `qwen3:4b`). Press **Test connection**. Any instruction-following model works. Cloudflare's open-weight decision model Clef-flash is the best fit on paper ([exploration §3](../docs/explorations/semantic-zapper.md#3-the-models-named)), served through llama.cpp's OpenAI-compatible endpoint. **Neither Clef-flash nor any real model has been tried with this code yet**: the browser check uses a stand-in server with canned answers.

## Install

1. Open `chrome://extensions` and turn on **Developer mode**.
2. Choose **Load unpacked** and select this `zapper/` directory.
3. Open any http(s) page. The panel appears in the bottom-right corner.

You can load the reference engine in `poc/` at the same time; the two don't interact. The zapper starts with a copy of the sample lens `avery-daily`. Import your own lens from the settings page, which you open by clicking the toolbar icon.

## What it stores, and where

Everything is kept in `chrome.storage.local` on this device and never synced.

| Item | What it is | Leaves the device? |
|---|---|---|
| Your lens | A Lens Manifest, history-free | Only when you press **Export** |
| Unsaved slider positions | Adaptation State | Never |
| Per-site pause and threshold | Adaptation State, keyed by hostname | Never, and never written into the lens |
| Model scores | A cache of page text and scores, in memory only | Never; gone when the browser stops the background worker |

When you press **Save to lens**, the zapper acts as a LensPub **Manifest Producer**, and that part does claim conformance:
- The new version validates against [the schema](../schemas/lens-manifest.schema.json).
- The version number is bumped by impact class: a weight change of at most 0.2 is a minor change, anything larger is major ([Adaptation Model §4](../spec/adaptation-model.md#4-impact-classification)).
- The old version is recorded in `versionHistory` by its content hash, with no date.
- `modified` is rounded to the day.
- A signature and publisher are removed, because they no longer describe the edited document.
- Nothing about the pages you read is ever written into the lens.

## Lens features it reads but does not use

The zapper reads these from your lens but doesn't act on them, and it lists them on the settings page and under **This site** instead of dropping them silently:
- Domain Scope restrictions on priorities: the zapper applies every priority on every page.
- Source trust and distrust.
- Presentation preferences.
- Subscriptions.
- Extensions.

## Known limits

- **Splitting the page into blocks is heuristic.** Paragraphs, list items, cards, and sidebars become blocks; text under 40 characters is never judged. Odd layouts will split oddly.
- **Content shifts after the page loads.** Blocks are hidden after the page renders, so the layout moves once, and a model scorer adds its own delay.
- **Prompt injection.** Page text goes to the model as data, with an instruction to ignore instructions inside it. That reduces the risk of a page steering the model, but doesn't remove it.
- **Pages can tell the extension is installed.** The extension exposes its own module files to pages, so a page can detect it. The panel's closed shadow root keeps page scripts away from its controls.
- **The tool only lists what it hides.** It does not label the blocks it keeps as being on your lens.

## Tests

```
npm run zapper:test                           # pure modules, plus Ajv validation of edited lenses (runs in CI)
node zapper/test/browser-check.mjs [--screenshots]   # the extension in Chromium, against demo/fixture.html
```

The browser check loads the unpacked extension against the fictional fixture page and checks:
- the expected blocks are hidden;
- controls and the correction never are;
- **Before** and **Show** work, and every hidden block is listed;
- saving a slider change writes a valid new lens version;
- the model-scorer path works over both APIs (against a stand-in model server), including that a block the model skips stays visible.

The check needs Playwright with Chromium and isn't run in CI.

## Layout

```
zapper/
  manifest.json          MV3 manifest
  core/                  pure, DOM-free modules (scoring, decisions, ledger check, lens editing)
  background/            storage, lens saving, local-model requests
  content/               page segmentation, zapping, and the panel
  options/               settings page: lens import/export, scorer, local data
  lenses/sample-lens.json
  demo/fixture.html      a fictional page for trying it
  test/                  Node tests and the browser check
```

Licensed Apache-2.0, like all code in this repository.
