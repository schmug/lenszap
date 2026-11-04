#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
//
// Spike: a lens from your browsing history, judged by the eval.
//
//   1. scan    read this browser's history (a copy; Chrome keeps the file locked)
//   2. group   embed page titles with a local embedding model, give each page its
//              nearest seed topic (eval/history/topics.json), and group the rest
//   3. review  a local page with one row per group: name it, weight it, save a
//              lens; plus a 3D map of your history over time
//
// Usage:
//   node eval/history-lens.mjs [scan|group|review|all] [--history FILE] [--days 90]
//        [--endpoint http://127.0.0.1:8282] [--model NAME] [--base my-lens.json] [--port 8766]
//
// The embedding model runs in llama-server, for example:
//   llama-server -hf ggml-org/embeddinggemma-300M-GGUF --embeddings --port 8282 -b 2048 -ub 2048
//
// Privacy, for a tool that reads history:
//   - Everything stays on this machine. The endpoint must be loopback, and
//     titles, addresses, and vectors are written only to eval/data/history/,
//     which git ignores.
//   - This script never prints a title, address, or site to the terminal: only
//     counts and topic names. Titles appear only in the review page, served on
//     127.0.0.1 to your own browser.
//   - The lens it saves holds only the topics you named and the weights you
//     chose (lensFromRows): nothing about the pages read.

import { createServer } from 'node:http';
import { readFileSync, writeFileSync, mkdirSync, existsSync, copyFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from './lib.mjs';
import { isLoopbackEndpoint } from '../core/model-scorer.js';
import { commitEdit, validateLens } from '../core/lens-edit.js';
import {
  chromeTimeToMs,
  msToChromeTime,
  collapseVisits,
  pageText,
  topicText,
  normalize,
  groupPages,
  suggestedWeights,
  lensFromRows,
  lensErrors,
  project3
} from './history/lib.mjs';

const args = parseArgs(process.argv.slice(2));
const step = args._[0] ?? 'all';
const root = fileURLToPath(new URL('..', import.meta.url));
const dir = join(root, 'eval/data/history');
const file = (name) => join(dir, name);
const readJson = (p) => JSON.parse(readFileSync(p, 'utf8'));
const writeJson = (p, v) => writeFileSync(p, JSON.stringify(v) + '\n');
mkdirSync(dir, { recursive: true });

const CHROME_HISTORY = {
  darwin: 'Library/Application Support/Google/Chrome/Default/History',
  linux: '.config/google-chrome/Default/History',
  win32: 'AppData/Local/Google/Chrome/User Data/Default/History'
};

async function scan() {
  const src = args.history ?? join(homedir(), CHROME_HISTORY[process.platform] ?? CHROME_HISTORY.linux);
  if (!existsSync(src)) {
    console.error(`No history file at ${src}. Pass --history with the path to a Chromium "History" file.`);
    process.exit(2);
  }
  const days = Number(args.days ?? 90);
  const copy = file('History.copy');
  copyFileSync(src, copy);
  const { DatabaseSync } = await import('node:sqlite');
  const db = new DatabaseSync(copy, { readOnly: true });
  const since = msToChromeTime(Date.now() - days * 86400000);
  const stmt = db.prepare('SELECT u.url AS url, u.title AS title, v.visit_time AS t FROM visits v JOIN urls u ON u.id = v.url WHERE v.visit_time >= ?');
  stmt.setReadBigInts(true);
  const rows = stmt
    .all(since)
    .map((r) => ({ url: r.url, title: r.title, visitTime: chromeTimeToMs(r.t) }));
  db.close();
  const pages = collapseVisits(rows);
  writeJson(file('pages.json'), { days, scanned: new Date().toISOString().slice(0, 10), pages });
  const sites = new Set(pages.map((p) => p.host)).size;
  console.log(`Last ${days} days: ${rows.length} visits, ${pages.length} pages kept on ${sites} sites.`);
}

async function embed(texts, cache) {
  const endpoint = (args.endpoint ?? 'http://127.0.0.1:8282').replace(/\/+$/, '');
  if (!isLoopbackEndpoint(endpoint)) throw new Error('The embedding endpoint must be on this machine.');
  const key = (t) => createHash('sha256').update(t).digest('hex').slice(0, 24);
  const todo = [...new Set(texts.filter((t) => !cache[key(t)]))];
  for (let i = 0; i < todo.length; i += 32) {
    const batch = todo.slice(i, i + 32);
    const res = await fetch(`${endpoint}/v1/embeddings`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ input: batch, model: args.model ?? 'default' })
    });
    if (!res.ok) throw new Error(`Embedding request failed: ${res.status} ${(await res.text()).slice(0, 200)}`);
    const { data } = await res.json();
    data.forEach((d, j) => (cache[key(batch[d.index ?? j])] = d.embedding.map((x) => Math.round(x * 1e5) / 1e5)));
    process.stdout.write(`\rEmbedded ${Math.min(i + 32, todo.length)} of ${todo.length}`);
  }
  if (todo.length) process.stdout.write('\n');
  return texts.map((t) => normalize(cache[key(t)]));
}

async function group() {
  const { pages } = readJson(file('pages.json'));
  const { topics } = readJson(args.topics ?? join(root, 'eval/history/topics.json'));
  const cachePath = file(`embeddings-${(args.model ?? 'default').replace(/[^\w.-]/g, '_')}.json`);
  const cache = existsSync(cachePath) ? readJson(cachePath) : {};
  const started = Date.now();
  const pageVecs = await embed(pages.map(pageText), cache);
  const topicVecs = await embed(topics.map(topicText), cache);
  writeJson(cachePath, cache);
  const groups = groupPages(pages, pageVecs, topics, topicVecs, {
    unassignedShare: Number(args.unassigned ?? 0.3),
    minPages: Number(args['min-pages'] ?? 5)
  });
  const xyz = project3(pageVecs);
  const groupOf = new Map(groups.flatMap((g) => g.pages.map((id) => [id, g.id])));
  writeJson(file('groups.json'), {
    groups,
    points: pages.map((p, i) => ({ id: p.id, g: groupOf.get(p.id), v: p.visits, d: p.days, xyz: xyz[i].map((x) => Math.round(x * 1000) / 1000) }))
  });
  const total = groups.reduce((a, g) => a + g.visits, 0) || 1;
  console.log(`${groups.length} groups from ${pages.length} pages in ${((Date.now() - started) / 1000).toFixed(1)} s:`);
  for (const g of groups) console.log(`  ${String(Math.round((100 * g.visits) / total)).padStart(3)}%  ${String(g.pages.length).padStart(5)} pages  ${g.name}`);
}

function review() {
  const port = Number(args.port ?? 8766);
  const send = (res, status, body, type = 'application/json') => {
    res.writeHead(status, { 'content-type': type, 'cache-control': 'no-store' });
    res.end(type === 'application/json' ? JSON.stringify(body) : body);
  };
  const state = () => {
    const { pages, days } = readJson(file('pages.json'));
    const { groups, points } = readJson(file('groups.json'));
    const byId = new Map(pages.map((p) => [p.id, p]));
    const saved = existsSync(file('table.json')) ? readJson(file('table.json')).rows : [];
    const savedById = new Map(saved.map((r) => [r.id, r]));
    const suggested = suggestedWeights(groups);
    return {
      days,
      rows: groups.map((g) => ({
        id: g.id,
        kind: g.kind,
        name: savedById.get(g.id)?.name ?? g.name,
        weight: savedById.get(g.id)?.weight ?? suggested[g.id],
        pages: g.pages.length,
        visits: g.visits,
        examples: g.pages.slice(0, 8).map((id) => ({ title: byId.get(id).title, host: byId.get(id).host }))
      })),
      points: points.map((pt) => ({ ...pt, t: byId.get(pt.id).title, h: byId.get(pt.id).host }))
    };
  };
  createServer((req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    if (url.pathname === '/') return send(res, 200, readFileSync(join(root, 'eval/history/review.html')), 'text/html; charset=utf-8');
    if (url.pathname === '/map') return send(res, 200, readFileSync(join(root, 'eval/history/map.html')), 'text/html; charset=utf-8');
    if (url.pathname === '/api/state' && req.method === 'GET') return send(res, 200, state());
    if (url.pathname === '/api/save' && req.method === 'PUT') {
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', async () => {
        try {
          const { rows } = JSON.parse(body);
          writeJson(file('table.json'), { rows: rows.map(({ id, name, weight }) => ({ id, name, weight })) });
          const result = await saveLens(rows);
          send(res, 200, result);
        } catch (err) {
          send(res, 400, { error: err.message });
        }
      });
      return;
    }
    send(res, 404, { error: 'not found' });
  }).listen(port, '127.0.0.1', () => {
    console.log(`Review your groups at http://127.0.0.1:${port}/  and the map at http://127.0.0.1:${port}/map`);
    console.log('Ctrl+C to stop. Saving writes eval/data/history/history-lens.json and capture-list.txt.');
  });
}

async function saveLens(rows) {
  const sha256 = async (bytes) => createHash('sha256').update(bytes).digest();
  let lens;
  if (args.base) {
    const base = readJson(args.base);
    const errs = validateLens(base);
    if (errs.length) throw new Error(`--base lens does not validate: ${errs.join(' ')}`);
    const r = await commitEdit(base, lensFromRows(rows, base), { sha256 });
    lens = r ? r.manifest : base;
  } else lens = lensFromRows(rows);
  const errors = lensErrors(lens);
  if (errors.length) throw new Error(`The lens would not validate: ${errors.join(' ')}`);
  writeFileSync(file('history-lens.json'), JSON.stringify(lens, null, 2) + '\n');
  const list = captureList(rows, lens);
  writeFileSync(file('capture-list.txt'), list.join('\n') + '\n');
  return { topics: lens.interpretation.priorities.length, version: lens.metadata.lensVersion, capture: list.filter((l) => l && !l.startsWith('#')).length };
}

/**
 * Pages to eval the lens on: your two most-visited pages in each weighted
 * group (up to 30), plus public front pages heavy in topics you weighted down
 * (eval/history/unlike-sites.txt), so the eval has things to zap.
 */
function captureList(rows, lens) {
  const { pages } = readJson(file('pages.json'));
  const { groups } = readJson(file('groups.json'));
  const byId = new Map(pages.map((p) => [p.id, p]));
  const weighted = rows.filter((r) => Number(r.weight) !== 0);
  const out = ['# Your pages, two per weighted group'];
  for (const r of weighted) {
    const g = groups.find((x) => x.id === r.id);
    for (const id of (g?.pages ?? []).slice(0, 2)) if (out.length <= 30) out.push(byId.get(id).url);
  }
  const negatives = lens.interpretation.priorities.filter((p) => p.weight < 0).map((p) => p.topic.toLowerCase());
  const unlike = readFileSync(join(root, 'eval/history/unlike-sites.txt'), 'utf8')
    .split('\n')
    .map((l) => l.replace(/#.*/, '').trim())
    .filter(Boolean)
    .map((l) => {
      const [url, ...tags] = l.split(/\s+/);
      return { url, tags: tags.join(' ').toLowerCase().split(',').map((t) => t.trim()) };
    });
  const matched = unlike.filter((u) => u.tags.some((t) => negatives.some((n) => n.includes(t) || t.includes(n))));
  out.push('# Pages heavy in topics you weighted down');
  out.push(...(matched.length ? matched : unlike.slice(0, 8)).map((u) => u.url));
  return out;
}

if (step === 'scan' || step === 'all') await scan();
if (step === 'group' || step === 'all') await group();
if (step === 'review' || step === 'all') review();
if (!['scan', 'group', 'review', 'all'].includes(step)) {
  console.error('Steps: scan, group, review, or all (the default).');
  process.exit(2);
}
