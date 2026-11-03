#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
//
// Compare decision models on your labelled pages: for each model, start
// llama-server, run the eval (eval/run.mjs) in both modes (blocks matching
// none of your interests kept, then hidden), record speed and memory, stop the
// server, and move on. Prints one table and saves it, with the raw results,
// to DATA/results/.
//
// Usage:
//   npm run compare-models                      # the default shortlist below
//   npm run compare-models -- --models ggml-org/Kev-4B-GGUF,ggml-org/vllm-d3-mini-GGUF
//   npm run compare-models -- --lens my-lens.json --port 8182 --parallel 4
//
// Options: --models LIST (comma-separated llama-server -hf names; add :QUANT to pick a
//          quantization)  --port N (default 8182, so a llama-server you already run on
//          8181 is left alone)  --parallel N (llama-server slots and eval concurrency,
//          default 4)  --at THRESHOLD (default 0.65)  --lens FILE  --data DIR
//          --llama-server PATH (default: llama-server on your PATH)
//          --load-timeout SECONDS (first run downloads the model; default 1800)
//          --fresh (ask each model again instead of using its cached scores)
//          --server-args "…" (extra llama-server arguments; default "-c 8192 -ub 2048 -b 2048")
//
// Every model's scores are cached under its own name (eval/run.mjs --tag), so a
// re-run only asks models about blocks they haven't seen. Memory is the peak
// resident size of llama-server.
//
// Downloads come from Hugging Face through llama-server's own -hf; model
// requests stay on 127.0.0.1.

import { spawn } from 'node:child_process';
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { parseArgs } from './lib.mjs';

// The shortlist (2026-11-03): decision-model GGUFs that released llama.cpp serves at
// /v1/systemone, under ~10 GB, with their Decision Index (benchlm.ai) for reference.
export const SHORTLIST = [
  'ggml-org/Kev-4B-GGUF', //            4B, 3.0 GB Q4, index 34.9 — the current baseline
  'ggml-org/vllm-d3-mini-GGUF', //      4B, 3.7 GB Q4, index 50.0 — same size, much higher index
  'ggml-org/vllm-d3-flash-GGUF', //     9B, index 54.3 — best open model under 10B
  'ggml-org/Bespoke-Nimble-9B-v3-GGUF', // 9B, 6.3 GB Q4, index 51.1 — CC BY-NC
  'ggml-org/vllm-d3-nano-GGUF', //      2B, index 34.3 — Kev-4B's index at half the size
  'LiquidAI/d1-3B-GGUF', //             3B, 1.7 GB Q4, index 31.1 — smallest download
  'ggml-org/lev-GGUF' //                4B, index 35.5 — Kev-4B's base, another fine-tune
];

const args = parseArgs(process.argv.slice(2));
const root = fileURLToPath(new URL('..', import.meta.url));
const dataDir = args.data ?? join(root, 'eval/data');
const models = typeof args.models === 'string' ? args.models.split(',').map((m) => m.trim()).filter(Boolean) : SHORTLIST;
const port = Number(args.port ?? 8182);
const parallel = Number(args.parallel ?? 4);
const at = Number(args.at ?? 0.65);
const server = typeof args['llama-server'] === 'string' ? args['llama-server'] : 'llama-server';
const loadTimeoutMs = Number(args['load-timeout'] ?? 1800) * 1000;
// -c 8192 shares 2048 tokens per slot across --parallel 4, ample for a 1500-character
// block plus its questions; without it llama-server sizes the KV cache to the model's
// full training context per slot (about 35 GiB resident for a 4B model).
// Non-causal decision models (vllm-d3) need the whole prompt in one batch: llama-server's
// default 512-token batch aborts on a long block (GGML_ASSERT n_ubatch >= n_tokens).
const DEFAULT_SERVER_ARGS = ['-c', '8192', '-ub', '2048', '-b', '2048'];
const extraServerArgs = typeof args['server-args'] === 'string' ? args['server-args'].split(/\s+/).filter(Boolean) : DEFAULT_SERVER_ARGS;
const endpoint = `http://127.0.0.1:${port}`;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function portBusy() {
  try {
    await fetch(`${endpoint}/health`, { signal: AbortSignal.timeout(1000) });
    return true;
  } catch {
    return false;
  }
}

/** Resident size of a process in MiB (ps works on macOS and Linux), or null. */
function rssMiB(pid) {
  try {
    const kb = Number(execFileSync('ps', ['-o', 'rss=', '-p', String(pid)], { encoding: 'utf8' }).trim());
    return Number.isFinite(kb) ? kb / 1024 : null;
  } catch {
    return null;
  }
}

/** Start llama-server for one model; resolve once /health answers 200. */
async function startServer(model) {
  const argv = ['-hf', model, '--host', '127.0.0.1', '--port', String(port), '--parallel', String(parallel), ...extraServerArgs];
  const child = spawn(server, argv, { stdio: ['ignore', 'pipe', 'pipe'] });
  // Collect whole lines: a chunk can end mid-line.
  const log = [];
  const partial = { out: '', err: '' };
  const collect = (k) => (d) => {
    const lines = (partial[k] + String(d)).split('\n');
    partial[k] = lines.pop();
    log.push(...lines);
  };
  child.stdout.on('data', collect('out'));
  child.stderr.on('data', collect('err'));
  let exited = null;
  child.on('exit', (code, signal) => { exited = { code, signal }; });
  child.on('error', (err) => { exited = { error: err.message }; });
  const t0 = Date.now();
  let lastNote = t0;
  while (Date.now() - t0 < loadTimeoutMs) {
    if (exited) break;
    try {
      const res = await fetch(`${endpoint}/health`, { signal: AbortSignal.timeout(2000) });
      if (res.ok) return { child, log, loadMs: Date.now() - t0 };
    } catch {
      /* not up yet */
    }
    if (Date.now() - lastNote > 30000) {
      lastNote = Date.now();
      process.stderr.write(`  …still loading (${Math.round((Date.now() - t0) / 1000)} s; first run downloads the model)\n`);
    }
    await sleep(1000);
  }
  if (!exited) child.kill('SIGTERM');
  const tail = log.filter((l) => /error|unknown|failed|unsupported/i.test(l)).slice(-3).join(' | ') || log.slice(-3).join(' | ');
  throw new Error(exited ? `llama-server exited (${JSON.stringify(exited)}): ${tail}` : `not ready after ${loadTimeoutMs / 1000} s: ${tail}`);
}

async function stopServer(child) {
  if (child.exitCode !== null) return;
  child.kill('SIGTERM');
  for (let i = 0; i < 20 && child.exitCode === null; i++) await sleep(250);
  if (child.exitCode === null) child.kill('SIGKILL');
}


/** Run eval/run.mjs against the server; return its JSON result. */
function runEval(model, extra) {
  const argv = [
    join(root, 'eval/run.mjs'), '--api', 'systemone', '--endpoint', endpoint, '--tag', model,
    '--concurrency', String(parallel), '--at', String(at), '--data', dataDir, '--json', ...extra
  ];
  if (typeof args.lens === 'string') argv.push('--lens', args.lens);
  if (args.fresh) argv.push('--fresh');
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, argv, { stdio: ['ignore', 'pipe', 'inherit'] });
    let out = '';
    child.stdout.on('data', (d) => { out += d; });
    child.on('exit', (code) => {
      if (code !== 0) return reject(new Error(`eval exited with ${code}`));
      try { resolve(JSON.parse(out)); } catch (err) { reject(err); }
    });
  });
}

const pct = (x) => (x == null ? '—' : `${Math.round(x * 100)}%`);
const rowAt = (run, threshold) => run.rows.find((r) => r.threshold === threshold) ?? run.rows.at(-1);

if (await portBusy()) {
  console.error(`Something already answers on ${endpoint}. Pick a free port with --port.`);
  process.exit(2);
}

const results = [];
for (const model of models) {
  console.error(`\n== ${model}`);
  let srv;
  try {
    srv = await startServer(model);
  } catch (err) {
    console.error(`  Skipped: ${err.message}`);
    results.push({ model, error: err.message });
    continue;
  }
  let peak = rssMiB(srv.child.pid) ?? 0;
  const sampler = setInterval(() => { peak = Math.max(peak, rssMiB(srv.child.pid) ?? 0); }, 1000);
  try {
    const kept = await runEval(model, []);
    const hidden = await runEval(model, ['--hide-unmatched']); // same scores, from the cache
    const run = kept.runs.at(-1);
    results.push({
      model,
      loadMs: srv.loadMs,
      peakRssMiB: Math.round(peak),
      timing: run.timing,
      unscored: run.unscored,
      pages: kept.pages,
      kept: run.rows,
      hidden: hidden.runs.at(-1).rows,
      lexical: kept.runs[0].rows
    });
  } catch (err) {
    console.error(`  Eval failed: ${err.message}`);
    results.push({ model, error: err.message });
  } finally {
    clearInterval(sampler);
    await stopServer(srv.child);
  }
}

// --- Report ------------------------------------------------------------------

const lines = [];
const ok = results.filter((r) => !r.error);
lines.push(`Model comparison, ${new Date().toISOString().slice(0, 10)}: ${ok[0]?.pages ?? '?'} pages, threshold ${pct(at)}, llama-server --parallel ${parallel}.`);
lines.push('');
lines.push('Default mode (blocks matching none of your interests are kept):');
lines.push('');
lines.push('| Model | Wanted, hidden | Should go, kept | Precision | Evidence hidden | Hide-unmatched: wanted hidden / should go kept | Median ms/block | p95 ms | s/page | Peak RSS | Unscored |');
lines.push('|---|---|---|---|---|---|---|---|---|---|---|');
for (const r of results) {
  if (r.error) {
    lines.push(`| ${r.model} | failed: ${r.error.slice(0, 120).replace(/\|/g, '/')} ||||||||||`);
    continue;
  }
  const k = rowAt({ rows: r.kept }, at);
  const h = rowAt({ rows: r.hidden }, at);
  const fresh = r.timing.asked > 0;
  lines.push(
    `| ${r.model} | ${pct(k.rates.wrongZapRate)} (${k.totals.keptHidden.length + k.totals.evidenceHidden.length}) | ` +
      `${pct(k.rates.missRate)} (${k.totals.zapMissed.length + k.totals.adMissed.length}) | ${pct(k.rates.precision)} | ` +
      `${k.totals.evidenceHidden.length}/${k.totals.evidence} | ${pct(h.rates.wrongZapRate)} / ${pct(h.rates.missRate)} | ` +
      `${fresh ? r.timing.perBlockMedianMs : 'cached'} | ${fresh ? r.timing.perBlockP95Ms : '—'} | ` +
      `${fresh ? (r.timing.wallMs / 1000 / r.pages).toFixed(1) : '—'} | ${(r.peakRssMiB / 1024).toFixed(1)} GiB | ${r.unscored} |`
  );
}
lines.push('');
lines.push('Each model at every threshold (wanted hidden / should go kept, default mode):');
lines.push('');
const ths = ok[0]?.kept.map((x) => x.threshold) ?? [];
lines.push(`| Model | ${ths.map((t) => pct(t)).join(' | ')} |`);
lines.push(`|---|${ths.map(() => '---').join('|')}|`);
for (const r of ok) {
  lines.push(`| ${r.model} | ${r.kept.map((x) => `${pct(x.rates.wrongZapRate)} / ${pct(x.rates.missRate)}`).join(' | ')} |`);
}
const report = lines.join('\n') + '\n';
console.log('\n' + report);

mkdirSync(join(dataDir, 'results'), { recursive: true });
const stamp = new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-');
writeFileSync(join(dataDir, 'results', `compare-${stamp}.json`), JSON.stringify({ at, parallel, results }, null, 2) + '\n');
writeFileSync(join(dataDir, 'results', `compare-${stamp}.md`), report);
console.error(`Saved ${join(dataDir, 'results', `compare-${stamp}.md`)} and .json`);
