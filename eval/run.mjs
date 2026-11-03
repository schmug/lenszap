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
//          --model NAME  --concurrency N  --at THRESHOLD (detail rows; default 0.8 for
//          word-only and 0.65 for a model, the extension's defaults)
//          --zap-ads (add a "less of this" priority for ads, as a reader setting would)
//          --hide-unmatched (also hide blocks that match none of the interests; the
//          extension's default keeps them). Blocks labelled neutral count as should-go
//          with it and should-stay without it; a zap label always means should-go.
//          --show (list every mistake with its text)  --json  --save (write results to DATA/results/)
//          --site TEXT (only pages whose name contains TEXT, e.g. --site verge)
//          --fresh (ask the model again instead of using DATA/cache/scores.json)
//          --tag NAME (name the model behind the endpoint, so each model keeps its own
//          cached scores and results; eval/compare-models.mjs passes the model's repo)
//
// LENSZAP_API, LENSZAP_ENDPOINT, LENSZAP_MODEL and LENSZAP_LENS set the defaults for
// --api, --endpoint, --model and --lens, so a dev loop needs no flags.
//
// Model scores are cached in DATA/cache/scores.json (git ignores DATA), keyed by
// scorer, the scorer code (core/model-scorer.js, core/lexical-scorer.js), the topics, and the block text,
// so a re-run after a change to decide.js or the threshold takes seconds. A change
// to the prompt or scorer code misses the cache on its own; swapping the model
// behind the same endpoint does not, so pass --fresh or a different --tag then.
//
// Model requests go only to the loopback endpoint you name.

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { scoreLexical, LEXICAL_SCORER_ID } from '../core/lexical-scorer.js';
import { decide } from '../core/decide.js';
import { adSlotScore } from '../core/segment.js';
import { scoreWithEndpoint, modelScorerId, isLoopbackEndpoint } from '../core/model-scorer.js';
import { loadDataset, parseArgs, readLens } from './lib.mjs';
import { compare, total, rates } from './metrics.mjs';

const args = parseArgs(process.argv.slice(2));
const root = fileURLToPath(new URL('..', import.meta.url));
const dataDir = args.data ?? join(root, 'eval/data');
const env = process.env;
const api = args.api ?? env.LENSZAP_API ?? 'lexical';
const settings = {
  api,
  endpoint: args.endpoint ?? env.LENSZAP_ENDPOINT ?? (api === 'ollama' ? 'http://localhost:11434' : 'http://127.0.0.1:8080'),
  model: typeof args.model === 'string' ? args.model : (env.LENSZAP_MODEL ?? '')
};
const concurrency = Number(args.concurrency ?? 4);
// --tag only labels the scorer (cache key and results); it is never sent to the model.
const tag = typeof args.tag === 'string' ? args.tag : '';
const scorerIdOf = (s) => (tag ? `${modelScorerId(s)}#${tag}` : modelScorerId(s));
// The extension's default thresholds (background/service-worker.js).
const atFor = (scorerId) => Number(args.at ?? (scorerId === LEXICAL_SCORER_ID ? 0.8 : 0.65));
const THRESHOLDS = [...new Set([0.5, 0.6, 0.65, 0.7, 0.8, 0.9, ...(args.at ? [Number(args.at)] : [])])].sort();
const AD_TOPIC = 'advertising or sponsored content';
const hideUnmatched = !!args['hide-unmatched'];

const lens = readLens(args.lens ?? env.LENSZAP_LENS ?? join(root, 'lenses/sample-lens.json'));
const priorities = lens.interpretation.priorities.map(({ topic, weight }) => ({ topic, weight }));
if (args['zap-ads']) priorities.push({ topic: AD_TOPIC, weight: -1 });
const topics = priorities.map((p) => p.topic);

const site = typeof args.site === 'string' ? args.site.toLowerCase() : null;
const dataset = loadDataset(dataDir)
  .filter((d) => Object.keys(d.labels).length > 0)
  .filter((d) => !site || d.slug.toLowerCase().includes(site));
if (dataset.length === 0) {
  console.error(site
    ? `No labelled page in ${dataDir} has "${args.site}" in its name. Names: ${loadDataset(dataDir).map((d) => d.slug).join(', ')}`
    : `No labelled pages in ${dataDir}. Capture with npm run capture, then label with npm run label.`);
  process.exit(2);
}

// Model scores from earlier runs, so only new or changed blocks reach the model.
const cachePath = join(dataDir, 'cache', 'scores.json');
// The scorer and the evidence check it applies (core/lexical-scorer.js).
const scorerCode = createHash('sha256')
  .update(['core/model-scorer.js', 'core/lexical-scorer.js'].map((f) => readFileSync(join(root, f), 'utf8')).join('\0'))
  .digest('hex').slice(0, 12);
let cache = {};
if (existsSync(cachePath)) {
  try { cache = JSON.parse(readFileSync(cachePath, 'utf8')); } catch { cache = {}; }
}
const cacheKey = (scorerId, text) =>
  createHash('sha256').update(JSON.stringify([scorerId, scorerCode, topics, text])).digest('hex').slice(0, 32);
let cacheHits = 0;

const textOf = new Map();
for (const { page } of dataset) for (const b of page.blocks) textOf.set(b.key, b.text);

// A running count on stderr, so a long model run shows it is alive.
const totalBlocks = () => dataset.reduce((n, d) => n + Object.values(d.labels).filter((l) => l !== 'skip').length, 0);
let done = 0;
let lastShown = 0;
function progress(scorer) {
  done++;
  const now = Date.now();
  if (process.stderr.isTTY || now - lastShown > 15000) {
    lastShown = now;
    process.stderr.write(`${process.stderr.isTTY ? '\r' : ''}  ${scorer}: ${done}/${totalBlocks()} blocks${process.stderr.isTTY ? '' : '\n'}`);
  }
}

async function scoreAll(scorer) {
  done = 0;
  const perPage = [];
  const timings = [];
  const t0 = performance.now();
  for (const { slug, page, labels } of dataset) {
    // Only labelled blocks are scored: unlabelled ones cannot be judged.
    const labelled = page.blocks.filter((b) => labels[b.key] && labels[b.key] !== 'skip');
    // Ad slots are judged by structure, as in the extension, not sent to the scorer.
    const slots = labelled.filter((b) => b.adSlot).map((b) => adSlotScore(b.key, priorities));
    const blocks = labelled.filter((b) => !b.adSlot).map((b) => ({ id: b.key, text: b.text }));
    const onTiming = (_id, ms) => {
      timings.push(ms);
      progress(scorer);
    };
    let scores;
    if (scorer === 'lexical') scores = scoreLexical(blocks, topics);
    else {
      const id = scorerIdOf(settings);
      const keyOf = new Map(blocks.map((b) => [b.id, cacheKey(id, b.text)]));
      const cached = (b) => !args.fresh && !!cache[keyOf.get(b.id)];
      const hit = blocks.filter(cached);
      const miss = blocks.filter((b) => !cached(b));
      cacheHits += hit.length;
      for (let i = 0; i < hit.length; i++) progress(scorer);
      const fresh = miss.length ? await scoreWithEndpoint(settings, miss, topics, fetch, { concurrency, onTiming }) : [];
      for (const sc of fresh) if (!sc.unscored) cache[keyOf.get(sc.id)] = { matches: sc.matches, evidence: sc.evidence };
      scores = [...hit.map((b) => ({ id: b.id, ...cache[keyOf.get(b.id)] })), ...fresh];
    }
    perPage.push({ slug, labels, scores: [...scores, ...slots] });
  }
  return { perPage, wallMs: performance.now() - t0, timings };
}

function evaluate({ perPage }, scorerId) {
  return THRESHOLDS.map((threshold) => {
    const pages = perPage.map(({ slug, labels, scores }) => {
      const d = decide({ scores, priorities, threshold, scorer: scorerId, hideUnmatched });
      return { slug, ...compare(d.map((x) => ({ key: x.id, zap: x.zap })), labels, { hideUnmatched }) };
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
  {
    const id = scorerIdOf(settings);
    const res = await scoreAll('model');
    mkdirSync(join(dataDir, 'cache'), { recursive: true });
    writeFileSync(cachePath, JSON.stringify(cache) + '\n');
    if (process.stderr.isTTY) process.stderr.write('\n');
    const unscored = res.perPage.reduce((n, p) => n + p.scores.filter((s) => s.unscored).length, 0);
    res.timings.sort((a, b) => a - b);
    const pct = (q) => Math.round(res.timings[Math.min(res.timings.length - 1, Math.floor(q * res.timings.length))] ?? 0);
    runs.push({
      scorer: id,
      timing: { wallMs: Math.round(res.wallMs), perBlockMedianMs: pct(0.5), perBlockP95Ms: pct(0.95), concurrency, asked: res.timings.length, cached: cacheHits },
      unscored,
      rows: evaluate(res, id)
    });
  }
}

const result = { data: dataDir, lens: lens.id, zapAds: !!args['zap-ads'], hideUnmatched, pages: dataset.length, date: new Date().toISOString().slice(0, 10), runs };

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
console.log(`Blocks matching none of your interests: ${hideUnmatched ? 'hidden (--hide-unmatched)' : 'kept (the default)'}.`);
console.log(`${dataset.length} pages, ${first.labelled} labelled blocks: ${first.keep} keep, ${first.zap} zap, ${first.neutral} neutral, ${first.ad} ad, ${first.evidence} evidence, ${first.chrome} chrome, ${first.mixed} mixed.`);
console.log(`Bad splits (chrome + mixed): ${p(rates(first).splitProblemRate)} of labelled blocks.\n`);
for (const run of runs) {
  console.log(`Scorer: ${run.scorer}`);
  if (run.timing) {
    const t = run.timing;
    console.log(`  Time: ${t.wallMs} ms total; per block median ${t.perBlockMedianMs} ms, p95 ${t.perBlockP95Ms} ms (concurrency ${t.concurrency}; ${t.asked} asked, ${t.cached} from the cache). Unscored: ${run.unscored}.`);
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
  const at = atFor(run.scorer);
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
