#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
//
// Score labelled pages with a scorer and report how often the zapper gets it
// wrong: blocks you wanted that it hid, blocks it should have hidden that it
// kept (off-lens and ads separately), corrections it hid (must be zero), and
// how often the splitter made a bad block. Uses the extension's own scoring
// and decision code (core/model-scorer.js, core/decide.js), against your lens.
//
// Usage:
//   node eval/run.mjs                               # word-only baseline on eval/data
//   node eval/run.mjs --api systemone               # plus llama-server at 127.0.0.1:8080
//   node eval/run.mjs --data eval/demo --api lexical
//   node eval/run.mjs --api systemone --at 0.7 --show
//
// Options: --data DIR  --lens FILE  --api lexical|systemone|ollama|openai  --endpoint URL
//          --model NAME  --concurrency N  --at THRESHOLD (detail rows; default 0.8)
//          --method topics|categories|both (model scoring: per-topic questions, label-first
//          categories, or both side by side; categories needs --api systemone; default topics)
//          --zap-ads (add a "less of this" priority for ads, as a reader setting would)
//          --show (list every mistake with its text)  --json  --save (write results to DATA/results/)
//
// Model requests go only to the loopback endpoint you name.

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { scoreLexical, LEXICAL_SCORER_ID } from '../core/lexical-scorer.js';
import { decide } from '../core/decide.js';
import { scoreWithEndpoint, modelScorerId, isLoopbackEndpoint } from '../core/model-scorer.js';
import { scoreByCategories, AD_TOPIC, CATEGORIZE_SCORER_PREFIX } from '../core/categorize.js';
import { loadDataset, parseArgs, readLens } from './lib.mjs';
import { compare, total, rates } from './metrics.mjs';

const args = parseArgs(process.argv.slice(2));
const root = fileURLToPath(new URL('..', import.meta.url));
const dataDir = args.data ?? join(root, 'eval/data');
const api = args.api ?? 'lexical';
const settings = {
  api,
  endpoint: args.endpoint ?? (api === 'ollama' ? 'http://localhost:11434' : 'http://127.0.0.1:8080'),
  model: typeof args.model === 'string' ? args.model : ''
};
const concurrency = Number(args.concurrency ?? 4);
const at = Number(args.at ?? 0.8);
const THRESHOLDS = [...new Set([0.5, 0.6, 0.7, 0.8, 0.9, at])].sort();

const lens = readLens(args.lens ?? join(root, 'lenses/sample-lens.json'));
const priorities = lens.interpretation.priorities.map(({ topic, weight }) => ({ topic, weight }));
if (args['zap-ads']) priorities.push({ topic: AD_TOPIC, weight: -1 });
const method = args.method ?? 'topics';
if (!['topics', 'categories', 'both'].includes(method)) throw new Error('--method must be topics, categories, or both');
if (method !== 'topics' && api !== 'systemone') {
  console.error('Label-first scoring (--method categories) needs a decision model: --api systemone.');
  process.exit(2);
}
const topics = priorities.map((p) => p.topic);

const dataset = loadDataset(dataDir).filter((d) => Object.keys(d.labels).length > 0);
if (dataset.length === 0) {
  console.error(`No labelled pages in ${dataDir}. Capture with npm run capture, then label with npm run label.`);
  process.exit(2);
}

const textOf = new Map();
for (const { page } of dataset) for (const b of page.blocks) textOf.set(b.key, b.text);

// Label-first: the topic → category relevance table is asked once and reused.
let relevance;

async function scoreAll(scorer) {
  const perPage = [];
  const timings = [];
  const t0 = performance.now();
  for (const { slug, page, labels } of dataset) {
    // Only labelled blocks are scored: unlabelled ones cannot be judged.
    const blocks = page.blocks.filter((b) => labels[b.key] && labels[b.key] !== 'skip').map((b) => ({ id: b.key, text: b.text }));
    const onTiming = (_id, ms) => timings.push(ms);
    let scores;
    if (scorer === 'lexical') scores = scoreLexical(blocks, topics);
    else if (scorer === 'categories') {
      const r = await scoreByCategories(settings, blocks, topics, fetch, { concurrency, onTiming, relevance });
      relevance = r.relevance;
      scores = r.scores;
    } else scores = await scoreWithEndpoint(settings, blocks, topics, fetch, { concurrency, onTiming });
    perPage.push({ slug, labels, scores });
  }
  return { perPage, wallMs: performance.now() - t0, timings };
}

function evaluate({ perPage }, scorerId) {
  return THRESHOLDS.map((threshold) => {
    const pages = perPage.map(({ slug, labels, scores }) => {
      const d = decide({ scores, priorities, threshold, scorer: scorerId });
      return { slug, ...compare(d.map((x) => ({ key: x.id, zap: x.zap })), labels) };
    });
    const t = total(pages.map(({ slug, ...c }) => c));
    return { threshold, totals: t, rates: rates(t), pages };
  });
}

const runs = [];
const lexical = await scoreAll('lexical');
runs.push({ scorer: LEXICAL_SCORER_ID, rows: evaluate(lexical, LEXICAL_SCORER_ID) });

if (api !== 'lexical') {
  if (!isLoopbackEndpoint(settings.endpoint)) {
    console.error('Refusing: --endpoint must be on this machine (localhost, 127.0.0.1, or [::1]).');
    process.exit(2);
  }
  try {
    await scoreWithEndpoint(settings, [{ id: 'warm', text: 'Warm-up passage.' }], topics, fetch);
  } catch (err) {
    console.error(`Could not reach ${settings.endpoint} (${api}): ${err.message}`);
    process.exit(1);
  }
  const methods = method === 'both' ? ['topics', 'categories'] : [method];
  for (const m of methods) {
    const id = m === 'categories' ? `${CATEGORIZE_SCORER_PREFIX}+${modelScorerId(settings)}` : modelScorerId(settings);
    const res = await scoreAll(m === 'categories' ? 'categories' : 'model');
    const unscored = res.perPage.reduce((n, p) => n + p.scores.filter((s) => s.unscored).length, 0);
    res.timings.sort((a, b) => a - b);
    const pct = (q) => Math.round(res.timings[Math.min(res.timings.length - 1, Math.floor(q * res.timings.length))] ?? 0);
    runs.push({
      scorer: id,
      timing: { wallMs: Math.round(res.wallMs), perBlockMedianMs: pct(0.5), perBlockP95Ms: pct(0.95), concurrency },
      unscored,
      rows: evaluate(res, id),
      ...(m === 'categories' ? { relevance } : {})
    });
  }
}

const result = { data: dataDir, lens: lens.id, zapAds: !!args['zap-ads'], pages: dataset.length, date: new Date().toISOString().slice(0, 10), runs };

if (args.save) {
  mkdirSync(join(dataDir, 'results'), { recursive: true });
  const file = join(dataDir, 'results', `${result.date}-${runs.at(-1).scorer.replace(/[^a-z0-9.-]+/gi, '_')}.json`);
  writeFileSync(file, JSON.stringify(result, null, 2) + '\n');
  console.error(`Saved ${file}`);
}

if (args.json) {
  console.log(JSON.stringify(result, null, 2));
  process.exit(0);
}

const p = (x) => (x == null ? '  —' : `${String(Math.round(x * 100)).padStart(3)}%`);
const first = runs[0].rows[0].totals;
console.log(`${dataset.length} pages, ${first.labelled} labelled blocks: ${first.keep} keep, ${first.zap} zap, ${first.ad} ad, ${first.evidence} evidence, ${first.chrome} chrome, ${first.mixed} mixed.`);
console.log(`Bad splits (chrome + mixed): ${p(rates(first).splitProblemRate)} of labelled blocks.\n`);
for (const run of runs) {
  console.log(`Scorer: ${run.scorer}`);
  if (run.timing) {
    const t = run.timing;
    console.log(`  Time: ${t.wallMs} ms total; per block median ${t.perBlockMedianMs} ms, p95 ${t.perBlockP95Ms} ms (concurrency ${t.concurrency}). Unscored: ${run.unscored}.`);
  }
  console.log('  Zap at   Wanted, hidden   Should go, kept   Ads kept   Evidence hidden   Precision');
  for (const r of run.rows) {
    const t = r.totals;
    console.log(
      `  ${p(r.threshold)}     ${p(r.rates.wrongZapRate)} (${t.keptHidden.length + t.evidenceHidden.length})`.padEnd(29) +
        `${p(r.rates.missRate)} (${t.zapMissed.length + t.adMissed.length})`.padEnd(18) +
        `${t.adMissed.length}/${t.ad}`.padEnd(11) +
        `${t.evidenceHidden.length}/${t.evidence}`.padEnd(18) +
        p(r.rates.precision)
    );
  }
  const detail = run.rows.find((r) => r.threshold === at);
  console.log(`\n  Per page at ${p(at).trim()}: wanted-but-hidden / should-go-but-kept`);
  for (const pg of detail.pages) {
    console.log(`    ${String(pg.keptHidden.length + pg.evidenceHidden.length).padStart(3)} / ${String(pg.zapMissed.length + pg.adMissed.length).padEnd(3)}  ${pg.slug}`);
  }
  if (args.show) {
    const t = detail.totals;
    const list = (title, keys) => {
      if (!keys.length) return;
      console.log(`\n  ${title}:`);
      for (const k of keys) console.log(`    - ${(textOf.get(k) ?? k).slice(0, 110)}`);
    };
    list('Evidence hidden (must never happen)', t.evidenceHidden);
    list('Wanted, but hidden', t.keptHidden);
    list('Should go, but kept', t.zapMissed);
    list('Ads kept', t.adMissed);
  }
  console.log('');
}
