#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
//
// A dev browser for LensZap: Chromium with the unpacked extension loaded, which
// reloads the extension and its tabs whenever a file in it changes. Offline by
// default: it opens the fixture page and any captured snapshots you name, and
// refuses every other request that is not to this machine, so editing the
// splitter or the zapper never sends the browser to the web.
//
// Usage:
//   node scripts/dev.mjs                          # the fixture page
//   node scripts/dev.mjs --site verge             # plus captured snapshots whose name contains "verge"
//   node scripts/dev.mjs --site all               # every captured snapshot
//   node scripts/dev.mjs --live https://lobste.rs/   # a live page (this goes to the web)
//
// Options: --data DIR (snapshots in DIR/snapshots; default eval/data)
//          --fresh (start from an empty profile; otherwise .dev-profile/ keeps your
//          lens and settings between runs)
//
// LENSZAP_ENDPOINT (e.g. http://127.0.0.1:8181) is written into the extension's
// model settings at start, so a fresh profile talks to your llama-server.
// The browser is Playwright's Chromium: branded Chrome no longer loads an
// unpacked extension from the command line.

import { readFileSync, readdirSync, existsSync, watch, rmSync, mkdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { join, relative } from 'node:path';
import { parseArgs } from '../eval/lib.mjs';

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
const profile = join(root, '.dev-profile');
if (args.fresh) rmSync(profile, { recursive: true, force: true });
mkdirSync(profile, { recursive: true });

// Pages served from disk, at their own addresses.
const FIXTURE_URL = 'https://fixture.example/';
const served = new Map([[FIXTURE_URL, () => readFileSync(join(root, 'demo/fixture.html'))]]);
const open = [FIXTURE_URL];
if (typeof args.site === 'string') {
  const dir = join(dataDir, 'snapshots');
  const want = args.site.toLowerCase();
  const files = existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith('.html') && (want === 'all' || f.toLowerCase().includes(want))) : [];
  if (!files.length) {
    console.error(`No snapshot matching "${args.site}" in ${dir}. Capture pages with npm run capture first.`);
    process.exit(2);
  }
  for (const f of files) {
    const path = join(dir, f);
    const url = readFileSync(path, 'utf8').match(/<base href="([^"]+)"/)?.[1];
    if (!url) continue;
    served.set(url, () => readFileSync(path)); // read on each load, so a recapture shows up
    open.push(url);
  }
}
const live = [args.live, ...args._].filter((u) => typeof u === 'string' && /^https?:\/\//i.test(u));
open.push(...live);

const context = await chromium.launchPersistentContext(profile, {
  headless: false,
  channel: 'chromium',
  viewport: null,
  args: [`--disable-extensions-except=${root}`, `--load-extension=${root}`, '--window-size=1920,1080']
});

if (!live.length) {
  // Offline: registered first, so the page routes below take precedence.
  await context.route('**/*', (route) => {
    const u = new URL(route.request().url());
    const local = !/^https?:$/.test(u.protocol) || ['localhost', '127.0.0.1', '[::1]'].includes(u.hostname);
    return local ? route.continue() : route.abort('blockedbyclient');
  });
}
for (const [url, body] of served) {
  await context.route(url, (route) => route.fulfill({ status: 200, contentType: 'text/html; charset=utf-8', body: body() }));
}

// Chromium disables a command-line extension that reloads itself unless
// developer mode is on, so turn it on (the profile keeps it), and reload through
// chrome://extensions, which also reports a broken manifest.
const extId = new URL((context.serviceWorkers()[0] ?? (await context.waitForEvent('serviceworker'))).url()).host;
async function onExtensionsPage(fn, arg) {
  const page = await context.newPage();
  try {
    await page.goto('chrome://extensions');
    return await page.evaluate(fn, arg);
  } finally {
    await page.close();
  }
}
await onExtensionsPage(() => new Promise((r) => chrome.developerPrivate.updateProfileConfiguration({ inDeveloperMode: true }, r)));

async function worker() {
  return context.serviceWorkers().find((w) => w.url().startsWith('chrome-extension://')) ?? context.waitForEvent('serviceworker');
}

const endpoint = process.env.LENSZAP_ENDPOINT;
async function applyEnv() {
  if (!endpoint) return;
  await (await worker()).evaluate(async (ep) => {
    const { settings = {} } = await chrome.storage.local.get('settings');
    await chrome.storage.local.set({ settings: { ...settings, model: { ...(settings.model ?? {}), endpoint: ep } } });
  }, endpoint);
}
await applyEnv();

function watchPage(page) {
  page.on('console', (m) => {
    if (m.type() === 'error' && /^chrome-extension:/.test(m.location()?.url ?? '')) console.error(`  extension error: ${m.text()}`);
  });
  page.on('pageerror', (e) => { if (/chrome-extension:/.test(e.stack ?? '')) console.error(`  extension error: ${e.message}`); });
}
context.on('page', watchPage);

const [first] = context.pages();
for (const [i, url] of open.entries()) {
  const page = i === 0 && first ? first : await context.newPage();
  if (page === first) watchPage(page);
  await page.goto(url).catch((e) => console.error(`  could not open ${url}: ${e.message.split('\n')[0]}`));
}

const WATCHED = ['background', 'content', 'core', 'sidepanel', 'lenses', 'manifest.json'];
let timer = null;
let changed = new Set();
let busy = null;
async function reload() {
  if (busy) { await busy; if (!changed.size) return; }
  busy = doReload();
  await busy;
  busy = null;
}
async function doReload() {
  const files = [...changed];
  changed = new Set();
  const t0 = Date.now();
  try {
    const next = context.waitForEvent('serviceworker', { timeout: 10000 });
    const loadError = await onExtensionsPage(
      (id) => new Promise((r) => chrome.developerPrivate.reload(id, { failQuietly: true }, (e) => r(e ? `${e.error} ${e.path ?? ''}`.trim() : chrome.runtime.lastError?.message ?? null))),
      extId
    );
    if (loadError) throw new Error(loadError);
    await next.catch(() => {
      throw new Error('the extension did not start again (a broken manifest or a syntax error in the service worker? chrome://extensions shows the error)');
    });
    await applyEnv();
    const pages = context.pages().filter((p) => /^https?:/.test(p.url()));
    await Promise.all(pages.map((p) => p.reload().catch(() => {})));
    console.log(`${new Date().toLocaleTimeString()}  reloaded (${files.join(', ')}) in ${Date.now() - t0} ms`);
  } catch (err) {
    console.error(`  reload failed: ${err.message.split('\n')[0]}. Fix it and save again.`);
  }
}
for (const name of WATCHED) {
  const path = join(root, name);
  if (!existsSync(path)) continue;
  watch(path, { recursive: true }, (_event, file) => {
    changed.add(name.includes('.') ? name : relative(root, file ? join(path, file) : path));
    clearTimeout(timer);
    timer = setTimeout(reload, 250);
  });
}

console.log(`LensZap dev browser: ${open.length} tab${open.length > 1 ? 's' : ''}, ${live.length ? 'live (requests go to the web)' : 'offline (only this machine is reachable)'}.`);
console.log(`Watching ${WATCHED.join(', ')}. Save a file to reload the extension and its tabs. Close the browser or press Ctrl-C to stop.`);
context.on('close', () => process.exit(0));
process.on('SIGINT', async () => { await context.close().catch(() => {}); process.exit(0); });
