#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
//
// A small labelling page for captured blocks. Serves eval/label.html on
// 127.0.0.1 and saves your labels to <data>/labels/<slug>.json as you go.
//
// Usage: node eval/label.mjs [--data eval/data] [--lens FILE] [--port 8765]

import { createServer } from 'node:http';
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { LABELS, loadDataset, parseArgs } from './lib.mjs';

const args = parseArgs(process.argv.slice(2));
const root = fileURLToPath(new URL('..', import.meta.url));
const dataDir = args.data ?? join(root, 'eval/data');
const port = Number(args.port ?? 8765);
const lensId = JSON.parse(readFileSync(args.lens ?? join(root, 'lenses/sample-lens.json'), 'utf8')).id;
const SLUG = /^[a-z0-9][a-z0-9.-]*$/;

const send = (res, status, body, type = 'application/json') => {
  res.writeHead(status, { 'content-type': type, 'cache-control': 'no-store' });
  res.end(type === 'application/json' ? JSON.stringify(body) : body);
};

createServer((req, res) => {
  const url = new URL(req.url, 'http://127.0.0.1');
  const [, a, b, slug] = url.pathname.split('/');
  if (url.pathname === '/') return send(res, 200, readFileSync(join(root, 'eval/label.html')), 'text/html; charset=utf-8');
  if (a !== 'api') return send(res, 404, { error: 'not found' });
  if (b === 'pages' && req.method === 'GET') {
    return send(res, 200, {
      lens: lensId,
      labels: LABELS,
      pages: loadDataset(dataDir).map(({ slug, page, labels }) => ({
        slug, url: page.url, blocks: page.blocks.length, labelled: Object.keys(labels).length
      }))
    });
  }
  if (!slug || !SLUG.test(slug)) return send(res, 400, { error: 'bad page name' });
  const pagePath = join(dataDir, 'pages', `${slug}.json`);
  const labelPath = join(dataDir, 'labels', `${slug}.json`);
  if (!existsSync(pagePath)) return send(res, 404, { error: 'no such page' });
  if (b === 'page' && req.method === 'GET') {
    const labels = existsSync(labelPath) ? JSON.parse(readFileSync(labelPath, 'utf8')).labels ?? {} : {};
    return send(res, 200, { page: JSON.parse(readFileSync(pagePath, 'utf8')), labels });
  }
  if (b === 'labels' && req.method === 'PUT') {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      try {
        const keys = new Set(JSON.parse(readFileSync(pagePath, 'utf8')).blocks.map((x) => x.key));
        const { labels } = JSON.parse(body);
        const clean = Object.fromEntries(Object.entries(labels ?? {}).filter(([k, v]) => keys.has(k) && v in LABELS));
        mkdirSync(join(dataDir, 'labels'), { recursive: true });
        writeFileSync(labelPath, JSON.stringify({ lens: lensId, labels: clean }, null, 2) + '\n');
        send(res, 200, { saved: Object.keys(clean).length });
      } catch (err) {
        send(res, 400, { error: err.message });
      }
    });
    return;
  }
  send(res, 404, { error: 'not found' });
}).listen(port, '127.0.0.1', () => {
  console.log(`Labelling ${dataDir} against ${lensId}`);
  console.log(`Open http://127.0.0.1:${port}/  (Ctrl+C to stop; labels save as you go)`);
});
