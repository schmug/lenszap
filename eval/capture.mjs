#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
//
// Capture pages for the eval: load each page in Chromium with the extension
// installed, let the extension split it into blocks exactly as it does for a
// reader, and save those blocks (text and a little layout) to
// <data>/pages/<slug>.json. Label them with `npm run label`, then score them
// with `npm run eval`.
//
// Usage:
//   node eval/capture.mjs https://example.com/a https://example.com/b
//   node eval/capture.mjs --list eval/sites.txt
//   node eval/capture.mjs --file demo/fixture.html --as https://fixture.example/ --data eval/demo
//
// Options: --data DIR (default eval/data, which git ignores)  --wait MS (default 3000)
//          --headed (show the browser; some sites block headless ones)  --shots
//
// This fetches the pages you name, from this machine, like a browser would.
// Captured text is the sites' own content: keep it out of public places.

import { mkdirSync, writeFileSync, readFileSync, mkdtempSync, existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { blockKey, slugFor, parseArgs } from './lib.mjs';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright');

const args = parseArgs(process.argv.slice(2));
const root = fileURLToPath(new URL('..', import.meta.url));
const dataDir = args.data ?? join(root, 'eval/data');
const wait = Number(args.wait ?? 3000);
const version = JSON.parse(readFileSync(join(root, 'manifest.json'), 'utf8')).version;

const targets = [...args._];
if (args.list) {
  for (const line of readFileSync(args.list, 'utf8').split('\n')) {
    const t = line.replace(/#.*/, '').trim();
    if (t) targets.push(t);
  }
}
if (args.file) {
  if (!args.as) throw new Error('--file needs --as <url> to say which address the page is served at');
  targets.push(args.as);
}
if (targets.length === 0) {
  console.error('Name at least one URL, or --list FILE, or --file PATH --as URL.');
  process.exit(2);
}

mkdirSync(join(dataDir, 'pages'), { recursive: true });
if (args.shots) mkdirSync(join(dataDir, 'shots'), { recursive: true });

const context = await chromium.launchPersistentContext(mkdtempSync(join(tmpdir(), 'lpz-capture-')), {
  headless: !args.headed,
  channel: 'chromium', // headless_shell cannot load extensions
  viewport: { width: 1280, height: 900 },
  args: [`--disable-extensions-except=${root}`, `--load-extension=${root}`]
});
if (!context.serviceWorkers().length) await context.waitForEvent('serviceworker');
if (args.file) {
  const body = readFileSync(args.file);
  await context.route(args.as, (route) => route.fulfill({ status: 200, contentType: 'text/html; charset=utf-8', body }));
}

let failed = 0;
for (const url of targets) {
  const page = await context.newPage();
  try {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForLoadState('networkidle', { timeout: 10000 }).catch(() => {});
    // Scroll through once so lazy-loaded content arrives, then back to the top.
    await page.evaluate(async () => {
      for (let y = 0; y < document.body.scrollHeight && y < 20000; y += innerHeight) {
        scrollTo(0, y);
        await new Promise((r) => setTimeout(r, 150));
      }
      scrollTo(0, 0);
    });
    await page.waitForTimeout(wait);
    const raw = await page.evaluate(() => {
      // Show the page as published, so hidden blocks have a real position.
      document.documentElement.classList.add('lpz-before');
      const norm = (s) => String(s ?? '').replace(/\s+/g, ' ').trim();
      const byId = new Map();
      for (const el of document.querySelectorAll('[data-lpz-id]')) {
        const id = el.getAttribute('data-lpz-id');
        if (!byId.has(id)) byId.set(id, []);
        byId.get(id).push(el);
      }
      const AD_HINT = '[id*="ad-" i], [id^="ad" i], [class*="ad-slot" i], [class*="advert" i], [class*="sponsor" i], [class*="promoted" i], [data-ad], [data-ad-slot], [aria-label*="advert" i], [aria-label*="sponsor" i]';
      return [...byId.entries()].map(([id, els]) => {
        const text = norm(els.map((e) => e.textContent).join(' '));
        const linkText = norm(els.flatMap((e) => [...e.querySelectorAll('a')].map((a) => a.textContent)).join(' '));
        const r = els[0].getBoundingClientRect();
        return {
          id,
          tag: els[0].tagName.toLowerCase(),
          text,
          links: els.reduce((n, e) => n + e.querySelectorAll('a').length, 0),
          linkShare: text ? Math.round((linkText.length / text.length) * 100) / 100 : 0,
          top: Math.round(r.top + scrollY),
          height: Math.round(r.height),
          adHint: els.some((e) => !!e.closest(AD_HINT))
        };
      });
    });
    const seen = new Map();
    const blocks = raw
      .sort((a, b) => a.top - b.top)
      .map(({ id, ...b }) => {
        let key = blockKey(b.text);
        const n = (seen.get(key) ?? 0) + 1;
        seen.set(key, n);
        if (n > 1) key = `${key}-${n}`;
        return { key, ...b };
      });
    const slug = slugFor(url);
    const out = {
      url,
      host: new URL(url).hostname,
      captured: new Date().toISOString().slice(0, 10),
      splitter: `lenszap@${version}`,
      blocks
    };
    writeFileSync(join(dataDir, 'pages', `${slug}.json`), JSON.stringify(out, null, 2) + '\n');
    if (args.shots) await page.screenshot({ path: join(dataDir, 'shots', `${slug}.jpg`), quality: 70, fullPage: true });
    console.log(`${String(blocks.length).padStart(4)} blocks  ${slug}`);
  } catch (err) {
    failed++;
    console.error(`  failed  ${url}: ${err.message.split('\n')[0]}`);
  } finally {
    await page.close();
  }
}
await context.close();
if (!existsSync(join(dataDir, 'labels'))) console.log(`\nNext: npm run label -- --data ${dataDir}`);
process.exit(failed ? 1 : 0);
