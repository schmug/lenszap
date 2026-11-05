#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
//
// Two passes, fast then slow, simulated from the eval's score cache: no model
// is asked anything. Run each scorer once through eval/run.mjs or
// compare-models first, so its scores are cached, then:
//
//   npm run two-pass -- --list                       # scorers with cached scores
//   npm run two-pass -- --lens my-lens.json \
//     --fast "model:default@systemone#browser:bge-prefix" \
//     --slow "model:default@systemone#ggml-org/Kev-4B-GGUF"
//
// Options: --fast ID --slow ID (scorer ids as --list prints them)  --slow-at X (default 0.65)
//          --fast-at LIST (default 0.6,0.65,0.7,0.8,0.9)  --skip-below LIST (default 0.05,0.1,0.2,0.3)
//          --fast-ms N --slow-ms N (per-block times for the estimate; default 9 and 1267,
//          bge-small in Chromium and Kev-4B on an M4 Max, 2026-11-04)
//          --hide-unmatched  --data DIR  --lens FILE  --json
//
// The three combinations are explained in eval/two-pass-lib.mjs. A block either
// scorer has no cached score for is left out and counted.

import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { adSlotScore } from '../core/segment.js';
import { loadDataset, parseArgs, readLens } from './lib.mjs';
import { twoPass } from './two-pass-lib.mjs';

const args = parseArgs(process.argv.slice(2));
const root = fileURLToPath(new URL('..', import.meta.url));
const dataDir = args.data ?? join(root, 'eval/data');
const env = process.env;
const nums = (v, d) => (typeof v === 'string' ? v.split(',').map(Number) : d);

const lens = readLens(args.lens ?? env.LENSZAP_LENS ?? join(root, 'lenses/sample-lens.json'));
const priorities = lens.interpretation.priorities.map(({ topic, weight }) => ({ topic, weight }));
const topics = priorities.map((p) => p.topic);
const hideUnmatched = !!args['hide-unmatched'];

// The same cache key as eval/run.mjs.
const scorerCode = createHash('sha256')
  .update(['core/model-scorer.js', 'core/lexical-scorer.js'].map((f) => readFileSync(join(root, f), 'utf8')).join('\0'))
  .digest('hex').slice(0, 12);
const cacheKey = (scorerId, text) =>
  createHash('sha256').update(JSON.stringify([scorerId, scorerCode, topics, text])).digest('hex').slice(0, 32);
const cachePath = join(dataDir, 'cache', 'scores.json');
const cache = existsSync(cachePath) ? JSON.parse(readFileSync(cachePath, 'utf8')) : {};

const dataset = loadDataset(dataDir).filter((d) => Object.keys(d.labels).length > 0);
const blocksOf = (d) => d.page.blocks.filter((b) => d.labels[b.key] && d.labels[b.key] !== 'skip');
const hits = (id) => dataset.reduce((n, d) => n + blocksOf(d).filter((b) => !b.adSlot && cache[cacheKey(id, b.text)]).length, 0);
const scoredTotal = dataset.reduce((n, d) => n + blocksOf(d).filter((b) => !b.adSlot).length, 0);

if (args.list) {
  // Scorer ids named in saved results; the cache itself is keyed by hashes.
  const ids = new Set();
  const dir = join(dataDir, 'results');
  for (const f of existsSync(dir) ? readdirSync(dir).filter((x) => x.endsWith('.json')) : []) {
    try {
      const j = JSON.parse(readFileSync(join(dir, f), 'utf8'));
      for (const r of j.runs ?? []) if (r.scorer?.startsWith('model:')) ids.add(r.scorer);
      for (const r of j.results ?? []) {
        if (!r.model) continue;
        ids.add(`model:default@systemone#${r.model}`);
        ids.add(`model:default@openai#${r.model}`);
      }
    } catch { /* not a results file */ }
  }
  for (const t of typeof args.try === 'string' ? args.try.split(',') : []) ids.add(t);
  console.log(`Scorers with cached scores for this lens (${scoredTotal} blocks to score):`);
  for (const id of [...ids].sort()) {
    const n = hits(id);
    if (n) console.log(`  ${String(n).padStart(4)}  ${id}`);
  }
  process.exit(0);
}

if (typeof args.fast !== 'string' || typeof args.slow !== 'string') {
  console.error('Pass --fast ID and --slow ID (see --list).');
  process.exit(2);
}

let missing = 0;
const pages = dataset.map((d) => {
  const labelled = blocksOf(d);
  const slots = labelled.filter((b) => b.adSlot).map((b) => adSlotScore(b.key, priorities));
  const both = labelled.filter((b) => !b.adSlot && cache[cacheKey(args.fast, b.text)] && cache[cacheKey(args.slow, b.text)]);
  missing += labelled.filter((b) => !b.adSlot).length - both.length;
  const from = (id) => [...both.map((b) => ({ id: b.key, ...cache[cacheKey(id, b.text)] })), ...slots];
  return { labels: d.labels, fast: from(args.fast), slow: from(args.slow) };
});
if (pages.every((p) => p.fast.every((s) => s.adSlot))) {
  console.error(`No blocks have both scores cached (${missing} without). Check the ids with --list.`);
  process.exit(2);
}

const slowAt = Number(args['slow-at'] ?? 0.65);
const fastMs = Number(args['fast-ms'] ?? 9);
const slowMs = Number(args['slow-ms'] ?? 1267);
const rows = [];
for (const fastAt of nums(args['fast-at'], [0.6, 0.65, 0.7, 0.8, 0.9])) {
  for (const skipBelow of nums(args['skip-below'], [0.05, 0.1, 0.2, 0.3])) {
    rows.push(twoPass(pages, { priorities, fastAt, slowAt, skipBelow, hideUnmatched }));
  }
}

if (args.json) {
  process.stdout.write(JSON.stringify({ fast: args.fast, slow: args.slow, slowAt, hideUnmatched, missing, rows }, null, 2) + '\n');
  process.exit(0);
}

const pct = (x) => (x == null ? '—' : `${Math.round(x * 100)}%`);
const cell = (r) => `${r.totals.keptHidden.length + r.totals.evidenceHidden.length} / ${r.totals.zapMissed.length + r.totals.adMissed.length}`;
const first = rows[0];
const n = first.slow.totals;
console.log(`Two passes: fast ${args.fast}, then slow ${args.slow} at ${pct(slowAt)}.`);
console.log(`${dataset.length} pages; ${n.labelled} labelled blocks with both scores (${missing} left out for a missing score). Unmatched blocks ${hideUnmatched ? 'hidden' : 'kept'}.`);
console.log('Cells are wanted hidden / should go kept.\n');
console.log(`Slow pass alone: ${cell(first.slow)}, precision ${pct(first.slow.rates.precision)}.\n`);

console.log('| Fast at | Fast alone | Union (either hides) | Early: slow zaps already hidden by the fast pass | Early: wanted blocks that flicker |');
console.log('|---|---|---|---|---|');
const seen = new Set();
for (const r of rows) {
  if (seen.has(r.fastAt)) continue;
  seen.add(r.fastAt);
  console.log(`| ${pct(r.fastAt)} | ${cell(r.fast)} | ${cell(r.union)} | ${r.early.hiddenEarly} of ${r.early.slowCorrectZaps} | ${r.early.flickerWanted.length} |`);
}

console.log('\nSkip: the slow pass scores only blocks the fast pass rates at least this off-lens.\n');
console.log('| Skip below | Slow calls saved | Result | Est. ms/block (fast + slow) |');
console.log('|---|---|---|---|');
const shown = new Set();
for (const r of rows) {
  if (shown.has(r.skipBelow)) continue;
  shown.add(r.skipBelow);
  const all = r.skip.slowCalls + r.skip.skipped;
  const ms = fastMs + (slowMs * r.skip.slowCalls) / Math.max(1, all);
  console.log(`| ${pct(r.skipBelow)} | ${pct(r.skip.skipped / Math.max(1, all))} (${r.skip.skipped}) | ${cell(r.skip)} | ${Math.round(ms)} |`);
}
