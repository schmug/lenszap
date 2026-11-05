// SPDX-License-Identifier: Apache-2.0
//
// The in-browser scorer: a small zero-shot NLI model run by the extension
// itself, on WebGPU, in an offscreen page (offscreen/scorer.js). No model
// server needed. Two uses:
//   - scorer 'browser': it scores every block by itself.
//   - the gate (settings.inBrowser.gate, with the local or hosted model): it
//     scores every block first, and only the blocks it rates at least `gate`
//     off-lens go on to the model. The rest are kept, scored by it. In the eval
//     (2026-11-05, 538 labelled blocks, default mode) a 20% gate sent 7% of
//     blocks to Kev-4B, about 12× faster, for one more should-go block kept.
//
// The model files are downloaded once, only when the reader asks, from
// Hugging Face into the extension's Cache Storage. Nothing else about the
// in-browser scorer touches the network. Pure and DOM-free.

import { offLensConfidence } from './decide.js';

export const IN_BROWSER_MODEL = 'Xenova/nli-deberta-v3-small';
export const IN_BROWSER_REVISION = 'main';
export const DEFAULT_IN_BROWSER = Object.freeze({ gate: false, gateAt: 0.2 });
export const IN_BROWSER_MAX_CHARS = 1500;
export const MODEL_CACHE = 'lenszap-models';

/** Hosts the download may touch: the model files and Hugging Face's file CDN. */
export const MODEL_ORIGINS = Object.freeze(['https://huggingface.co/*', 'https://*.huggingface.co/*', 'https://*.hf.co/*']);

/** Files to download for a weight type: fp16 where the GPU has shader-f16, else fp32. */
export function modelFiles(dtype) {
  const onnx = dtype === 'fp16' ? 'onnx/model_fp16.onnx' : 'onnx/model.onnx';
  return ['config.json', 'tokenizer.json', 'tokenizer_config.json', 'special_tokens_map.json', onnx];
}

export const remoteFileUrl = (file, model = IN_BROWSER_MODEL, revision = IN_BROWSER_REVISION) =>
  `https://huggingface.co/${model}/resolve/${encodeURIComponent(revision)}/${file}`;

/** The scorer id, for the score cache and the trace. */
export const inBrowserScorerId = (model = IN_BROWSER_MODEL) => `in-browser:${model}`;

/** "This passage is about X." for each topic, plus the evidence hypothesis last. */
export const EVIDENCE_HYPOTHESIS =
  'This passage is a correction, clarification, or retraction, or it cites a primary source such as a study, dataset, court record, or official filing.';
export function hypotheses(topics) {
  return [...topics.map((t) => `This passage is about ${t}.`), EVIDENCE_HYPOTHESIS];
}

/**
 * Probabilities from the NLI model (one per hypothesis, in hypotheses() order)
 * to a score in core/decide.js's shape.
 */
export function toScore(id, topics, probs) {
  if (!Array.isArray(probs) || probs.length !== topics.length + 1 || probs.some((p) => !Number.isFinite(p))) {
    return { id, matches: Object.fromEntries(topics.map((t) => [t, 0])), evidence: false, unscored: true };
  }
  const clamp = (x) => Math.min(1, Math.max(0, x));
  return {
    id,
    matches: Object.fromEntries(topics.map((t, i) => [t, clamp(probs[i])])),
    evidence: probs[topics.length] >= 0.5
  };
}

/**
 * Which blocks the model still has to judge. A block goes on when the
 * in-browser score is at least `gateAt` off-lens or is unscored; the rest keep
 * their in-browser score (as eval/two-pass-lib.mjs's skip simulates). The gate never sits above the
 * zap threshold, so a block it keeps back could not have been zapped on its
 * in-browser score anyway.
 *
 * @param {{id: string, matches: object, evidence?: boolean, unscored?: boolean}[]} scores
 * @param {{topic: string, weight: number}[]} priorities
 * @returns {{ask: string[], keep: string[]}}
 */
export function gateSplit(scores, priorities, { gateAt = DEFAULT_IN_BROWSER.gateAt, threshold = 1, hideUnmatched = false } = {}) {
  const at = Math.min(gateAt, threshold);
  const ask = [];
  const keep = [];
  for (const s of scores) {
    if (!s || s.unscored) {
      ask.push(s?.id);
      continue;
    }
    const { offLens } = offLensConfidence(s.matches, priorities, { hideUnmatched });
    (offLens >= at ? ask : keep).push(s.id);
  }
  return { ask, keep };
}

/** Does this scorer setting use the in-browser model, and how? */
export function inBrowserMode(settings) {
  if (settings?.scorer === 'browser') return 'only';
  if ((settings?.scorer === 'model' || settings?.scorer === 'hosted') && settings?.inBrowser?.gate === true) return 'gate';
  return 'off';
}
