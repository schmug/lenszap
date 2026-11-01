#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
//
// Benchmark a zapper scorer on your own machine: how fast is it, and how often
// does it hide the wrong thing? This answers questions 1 and 2 of the spike in
// docs/explorations/semantic-zapper.md Section 8.
//
// It scores the hand-labelled passages in passages.json against the sample
// lens, with the same request code the extension uses (core/model-scorer.js),
// then runs the extension's decision step (core/decide.js) at several
// confidence thresholds and counts the mistakes. The word-only scorer is
// always run alongside as a baseline.
//
// Usage:
//   node zapper/bench/bench.mjs                                   # llama-server decision model at 127.0.0.1:8080
//   node zapper/bench/bench.mjs --endpoint http://127.0.0.1:8081 --concurrency 2
//   node zapper/bench/bench.mjs --api ollama --endpoint http://localhost:11434 --model qwen3:4b
//   node zapper/bench/bench.mjs --api lexical                     # baseline only, no server needed
//
// Options: --api systemone|ollama|openai|lexical  --endpoint URL  --model NAME
//          --concurrency N (decision models; default 1, which measures per-block latency
//          honestly)  --passages FILE  --lens FILE  --json
//
// Requests go only to the loopback endpoint you name; nothing leaves the machine.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { scoreLexical, LEXICAL_SCORER_ID } from '../core/lexical-scorer.js';
import { decide } from '../core/decide.js';
import { scoreWithEndpoint, modelScorerId, isLoopbackEndpoint } from '../core/model-scorer.js';

const args = Object.fromEntries(
  process.argv.slice(2).reduce((acc, a, i, all) => {
    if (a.startsWith('--')) acc.push([a.slice(2), all[i + 1] && !all[i + 1].startsWith('--') ? all[i + 1] : true]);
    return acc;
  }, [])
);
const here = (p) => fileURLToPath(new URL(p, import.meta.url));
const api = args.api ?? 'systemone';
const settings = {
  api,
  endpoint: args.endpoint ?? (api === 'ollama' ? 'http://localhost:11434' : 'http://127.0.0.1:8080'),
  model: args.model && args.model !== true ? args.model : ''
};
const concurrency = Number(args.concurrency ?? 1);
const { passages } = JSON.parse(readFileSync(args.passages ?? here('./passages.json'), 'utf8'));
const lens = JSON.parse(readFileSync(args.lens ?? here('../lenses/sample-lens.json'), 'utf8'));
const priorities = lens.interpretation.priorities.map(({ topic, weight }) => ({ topic, weight }));
const topics = priorities.map((p) => p.topic);
const blocks = passages.map(({ id, text }) => ({ id, text }));
const label = Object.fromEntries(passages.map((p) => [p.id, p.label]));
const THRESHOLDS = [0.5, 0.6, 0.7, 0.8, 0.9, 0.95];

function evaluate(scores, scorer) {
  return THRESHOLDS.map((threshold) => {
    const d = decide({ scores, priorities, threshold, scorer });
    const zapped = new Set(d.filter((x) => x.zap).map((x) => x.id));
    const count = (lab, hidden) => passages.filter((p) => p.label === lab && zapped.has(p.id) === hidden).length;
    return {
      threshold,
      onLensHidden: count('keep', true),
      offLensKept: count('zap', false),
      evidenceHidden: count('evidence', true),
      hidden: zapped.size
    };
  });
}

const totals = { keep: 0, zap: 0, evidence: 0 };
for (const p of passages) totals[p.label]++;

const results = { passages: passages.length, totals, runs: [] };
results.runs.push({ scorer: LEXICAL_SCORER_ID, rows: evaluate(scoreLexical(blocks, topics), LEXICAL_SCORER_ID) });

if (api !== 'lexical') {
  if (!isLoopbackEndpoint(settings.endpoint)) {
    console.error('Refusing: --endpoint must be on this machine (localhost, 127.0.0.1, or [::1]).');
    process.exit(2);
  }
  const scorer = modelScorerId(settings);
  try {
    // One untimed warm-up request, so model loading is not counted as latency.
    await scoreWithEndpoint(settings, blocks.slice(0, 1), topics, fetch);
  } catch (err) {
    console.error(`Could not reach ${settings.endpoint} (${api}): ${err.message}`);
    console.error('Is the server running? For a decision model: llama-server -hf ggml-org/Clef-Flash-GGUF:Q4_K_M --port 8080');
    process.exit(1);
  }
  const timings = [];
  const t0 = performance.now();
  const scores = await scoreWithEndpoint(settings, blocks, topics, fetch, {
    concurrency,
    onTiming: (_id, ms) => timings.push(ms)
  });
  const wall = performance.now() - t0;
  timings.sort((a, b) => a - b);
  const pct = (q) => timings[Math.min(timings.length - 1, Math.floor(q * timings.length))];
  const unscored = scores.filter((s) => s.unscored).length;
  const evidenceFlagged = passages.filter((p, i) => p.label === 'evidence' && scores[i].evidence).length;
  results.runs.push({
    scorer,
    timing: {
      wallMs: Math.round(wall),
      perBlockMedianMs: Math.round(pct(0.5)),
      perBlockP95Ms: Math.round(pct(0.95)),
      concurrency: api === 'systemone' ? concurrency : 'batched'
    },
    unscored,
    evidenceFlagged,
    rows: evaluate(scores, scorer)
  });
}

if (args.json) {
  console.log(JSON.stringify(results, null, 2));
} else {
  console.log(`${passages.length} passages: ${totals.keep} on-lens, ${totals.zap} off-lens, ${totals.evidence} corrections/primary sources.\n`);
  for (const run of results.runs) {
    console.log(`Scorer: ${run.scorer}`);
    if (run.timing) {
      const t = run.timing;
      console.log(`  Time: ${t.wallMs} ms for all ${passages.length} blocks; per block median ${t.perBlockMedianMs} ms, p95 ${t.perBlockP95Ms} ms (concurrency ${t.concurrency}).`);
      console.log(`  Unscored blocks: ${run.unscored}. Corrections/sources recognized: ${run.evidenceFlagged} of ${totals.evidence}.`);
    }
    console.log('  Threshold  On-lens hidden (bad)  Off-lens kept (missed)  Evidence hidden (must be 0)');
    for (const r of run.rows) {
      console.log(
        `  ${String(Math.round(r.threshold * 100) + '%').padEnd(9)}  ${`${r.onLensHidden}/${totals.keep}`.padEnd(20)}  ${`${r.offLensKept}/${totals.zap}`.padEnd(22)}  ${r.evidenceHidden}/${totals.evidence}`
      );
    }
    console.log('');
  }
  if (results.runs.length > 1) {
    console.log('Rough page cost: blocks on the page × per-block median ÷ concurrency. Scores are cached, so');
    console.log('moving a slider afterwards costs nothing; only new blocks are scored.');
  }
}
