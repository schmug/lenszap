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
//   node eval/capture.mjs --resplit            # re-split saved snapshots with the current splitter
//
// Each capture also saves the page's HTML (scripts removed) to
// <data>/snapshots/<slug>.html. --resplit loads those snapshots instead of the
// live sites, so a splitter change can be measured on the same pages: blocks
// whose text is unchanged keep their labels, a block cut out of one labelled
// block inherits its label (unless that block was labelled mixed), and the rest
// are left for `npm run label`.
//
// Options: --data DIR (default eval/data, which git ignores)  --wait MS (default 3000)
//          --headed (show the browser; some sites block headless ones)  --shots
//
// This fetches the pages you name, from this machine, like a browser would.
// Captured text is the sites' own content: keep it out of public places.

import { mkdirSync, writeFileSync, readFileSync, mkdtempSync, existsSync, readdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { blockKey, slugFor, parseArgs, carryLabels } from './lib.mjs';

const require = createRequire(import.meta.url);
let chromium;
try {
  ({ chromium } = require('playwright'));
} catch {
  console.error('Playwright is missing. Run: npm install && npx playwright install chromium');
  process.exit(2);
}

const args = parseArgs(process.argv.slice(2));
const root = fileURLToPath(new URL('..', import.meta.url));
const dataDir = args.data ?? join(root, 'eval/data');
const wait = Number(args.wait ?? 3000);
const version = JSON.parse(readFileSync(join(root, 'manifest.json'), 'utf8')).version;

const notUrls = args._.filter((t) => !/^https?:\/\//i.test(t));
if (notUrls.length) {
  console.error(`Not a web address: ${notUrls.join(' ')}`);
  console.error('Pass http(s) URLs, or --list FILE. (A "#" comment on the command line is passed along as words in zsh.)');
  process.exit(2);
}
const targets = [...args._];
if (args.list) {
  for (const line of readFileSync(args.list, 'utf8').split('\n')) {
    const t = line.replace(/#.*/, '').trim();
    if (t) targets.push(t);
  }
}
// --resplit: every saved snapshot, served at its own address.
const snapshots = new Map(); // url → html
if (args.resplit) {
  const dir = join(dataDir, 'snapshots');
  if (!existsSync(dir)) {
    console.error(`No snapshots in ${dir}. Capture pages first (this version saves them).`);
    process.exit(2);
  }
  for (const f of readdirSync(dir).filter((f) => f.endsWith('.html'))) {
    const html = readFileSync(join(dir, f), 'utf8');
    const url = html.match(/<base href="([^"]+)"/)?.[1];
    if (url) { snapshots.set(url, html); targets.push(url); }
  }
}
if (args.file) {
  if (!args.as) throw new Error('--file needs --as <url> to say which address the page is served at');
  targets.push(args.as);
}
if (targets.length === 0 && !args.resplit) {
  console.error('Name at least one URL, or --list FILE, or --file PATH --as URL.');
  process.exit(2);
}

mkdirSync(join(dataDir, 'pages'), { recursive: true });
mkdirSync(join(dataDir, 'snapshots'), { recursive: true });
if (args.shots) mkdirSync(join(dataDir, 'shots'), { recursive: true });

let context;
try {
  context = await chromium.launchPersistentContext(mkdtempSync(join(tmpdir(), 'lpz-capture-')), {
    headless: !args.headed,
    channel: 'chromium', // headless_shell cannot load extensions
    viewport: { width: 1280, height: 900 },
    args: [`--disable-extensions-except=${root}`, `--load-extension=${root}`]
  });
} catch (err) {
  console.error(`Could not start Chromium: ${err.message.split('\n')[0]}`);
  console.error('If the browser is not installed yet, run: npx playwright install chromium');
  process.exit(2);
}
if (!context.serviceWorkers().length) await context.waitForEvent('serviceworker');
if (args.file) {
  const body = readFileSync(args.file);
  await context.route(args.as, (route) => route.fulfill({ status: 200, contentType: 'text/html; charset=utf-8', body }));
}
for (const [url, body] of snapshots) {
  await context.route(url, (route) => route.fulfill({ status: 200, contentType: 'text/html; charset=utf-8', body }));
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
    await page.waitForTimeout(snapshots.has(url) ? Math.min(wait, 1500) : wait);
    const slug = slugFor(url);
    if (!snapshots.has(url)) {
      // The page as published, for --resplit: no scripts, no marks from the extension.
      const html = await page.evaluate((base) => {
        const doc = document.documentElement.cloneNode(true);
        doc.querySelectorAll('script, noscript, lenspub-zapper, iframe').forEach((e) => e.remove());
        for (const e of [doc, ...doc.querySelectorAll('*')]) {
          for (const a of [...e.attributes]) if (a.name.startsWith('data-lpz-') || /^on/i.test(a.name)) e.removeAttribute(a.name);
        }
        doc.classList.remove('lpz-before');
        const head = doc.querySelector('head');
        head.querySelectorAll('base').forEach((b) => b.remove());
        const b = document.createElement('base');
        b.setAttribute('href', base);
        head.prepend(b);
        return '<!doctype html>\n' + doc.outerHTML;
      }, url);
      writeFileSync(join(dataDir, 'snapshots', `${slug}.html`), html);
    }
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
    const out = {
      url,
      host: new URL(url).hostname,
      captured: new Date().toISOString().slice(0, 10),
      splitter: `lenszap@${version}`,
      blocks
    };
    const pagePath = join(dataDir, 'pages', `${slug}.json`);
    const labelPath = join(dataDir, 'labels', `${slug}.json`);
    let carried = '';
    if (existsSync(pagePath) && existsSync(labelPath)) {
      const before = JSON.parse(readFileSync(pagePath, 'utf8'));
      const old = JSON.parse(readFileSync(labelPath, 'utf8'));
      const c = carryLabels(before.blocks, old.labels ?? {}, blocks);
      writeFileSync(labelPath, JSON.stringify({ ...old, labels: { ...old.labels, ...c.labels } }, null, 2) + '\n');
      carried = `  (labels: ${c.kept} kept, ${c.inherited} inherited, ${c.unlabelled} to label)`;
    }
    writeFileSync(pagePath, JSON.stringify(out, null, 2) + '\n');
    if (args.shots) await page.screenshot({ path: join(dataDir, 'shots', `${slug}.jpg`), quality: 70, fullPage: true });
    console.log(`${String(blocks.length).padStart(4)} blocks  ${slug}${carried}`);
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
