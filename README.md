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
| **Local decision model** (recommended) | llama.cpp's `llama-server` on this machine | A decision model such as Clef-flash answers one yes/no question per topic for every block, plus one question asking whether the block is a correction or cites a source. It returns calibrated probabilities from a single forward pass, with no text to parse. Moving a slider re-runs only the decision step, never the model. |
| **Local chat model** | Ollama, LM Studio, or any OpenAI-compatible server | Any instruction-following model, asked to return scores as JSON. It's slower and less calibrated than a decision model, but works with what you may already have installed. |

**Only addresses on this machine are accepted** (localhost, 127.0.0.1, ::1), so page text never leaves your device ([ADR-0005](../adr/0005-local-only-default.md)). A block counts as a correction or source if either the model or the word-level check says so.

### Running a decision model locally

Decision models run in llama.cpp's `llama-server`, which serves them at `/v1/systemone`. **Ollama and LM Studio can't serve them**: a chat runner loads only the backbone and produces noise.

1. **Install a recent llama.cpp.** Use `brew install llama.cpp` on macOS, `winget install llama.cpp` on Windows, or a release build on Linux. You need a build from October 2026 or later with decision-model support; the community Clef-flash quantizations were made with release b11430. Check with `llama-server --version`.
2. **Start a model.** Pick one from the table below. Each command downloads the model on first run.

   ```
   llama-server -hf ggml-org/Clef-Flash-GGUF:Q4_K_M --port 8080 --parallel 4
   ```

   If long passages fail with a "too large to process" error, add `-ub 2048`.
3. **Point the zapper at it.** In the extension's settings, choose **A model running on this machine**, then the **Decision model via llama-server** API, with endpoint `http://127.0.0.1:8080`. Leave Model empty. Press **Test connection**.
4. **Measure it on your machine.** This scores 28 hand-labelled passages and reports latency and wrong-zap rates at each threshold, next to the word-only baseline:

   ```
   npm run zapper:bench                                  # default: decision model at 127.0.0.1:8080
   npm run zapper:bench -- --concurrency 4               # match --parallel
   npm run zapper:bench -- --api ollama --model qwen3:4b # a chat model in Ollama, for comparison
   ```

| Model | Size | Notes |
|---|---|---|
| `ggml-org/Clef-Flash-GGUF:Q4_K_M` | 9B; about a 6 GB download | Cloudflare's model and the best fit on paper. It wants a GPU or Apple-silicon unified memory with roughly 8 GB free; it will run on a CPU, but slowly. Apache-2.0. |
| `ggml-org/Kev-4B-GGUF` | 4B | Smaller and faster. Apache-2.0. |
| `ggml-org/Julia-1-GGUF` | 144M | Tiny and multilingual, and fine on a laptop CPU. Expect weaker judgments; the benchmark will tell you how much. Apache-2.0. |

The sizes and licenses come from the model publishers and llama.cpp's announcement. **None of these models has been run with this code yet**: the cloud environment this was built in can't download models. The extension's model path, and the benchmark, were tested only against a stand-in server with canned answers. Your first benchmark run is the first real measurement.

### Using a chat model instead

```
OLLAMA_ORIGINS=chrome-extension://* ollama serve
ollama pull qwen3:4b
```

Then choose the **Chat model via Ollama** API with endpoint `http://localhost:11434` and model `qwen3:4b`.

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
- the model-scorer path works over all three APIs (against a stand-in model server), including that a block the model skips stays visible.

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
  bench/                 benchmark: speed and wrong-zap rates for a scorer on your machine
  test/                  Node tests and the browser check
```

Licensed Apache-2.0, like all code in this repository.
