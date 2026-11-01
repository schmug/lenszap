// SPDX-License-Identifier: Apache-2.0
//
// End-to-end check of the zapper extension in Chromium, against the fictional
// fixture page. Not part of CI (it needs a browser); run it by hand:
//
//   node zapper/test/browser-check.mjs [--screenshots]
//
// Needs the `playwright` package and a Chromium it can launch. It serves
// zapper/demo/ on 127.0.0.1, loads the unpacked extension, and checks that the
// right blocks are hidden, that page controls and the correction never are,
// that Before/After and Show work, and that saving an interest change writes
// a valid new lens version.

import { createServer } from 'node:http';
import { readFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright');

const zapperDir = fileURLToPath(new URL('..', import.meta.url));
const shots = process.argv.includes('--screenshots') ? join(zapperDir, 'screenshots') : null;
if (shots) mkdirSync(shots, { recursive: true });

const html = readFileSync(join(zapperDir, 'demo/fixture.html'));
const server = createServer((req, res) => {
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
  res.end(html);
}).listen(0, '127.0.0.1');
await new Promise((r) => server.once('listening', r));
const pageUrl = `http://127.0.0.1:${server.address().port}/`;

const context = await chromium.launchPersistentContext(mkdtempSync(join(tmpdir(), 'lpz-')), {
  headless: true,
  channel: 'chromium', // the full browser in new headless mode; headless_shell cannot load extensions
  viewport: { width: 1280, height: 900 },
  args: [`--disable-extensions-except=${zapperDir}`, `--load-extension=${zapperDir}`]
});
let [worker] = context.serviceWorkers();
if (!worker) worker = await context.waitForEvent('serviceworker');

const page = await context.newPage();
const cdp = await context.newCDPSession(page);

// The panel lives in a closed shadow root, which page scripts (and Playwright
// locators) cannot reach. CDP can: find a button by its text, click its centre.
async function panelButton(text) {
  const { root } = await cdp.send('DOM.getDocument', { depth: -1, pierce: true });
  let found = null;
  (function walk(n) {
    if (found) return;
    if (n.nodeName === 'BUTTON' && (n.children ?? []).some((c) => c.nodeType === 3 && c.nodeValue.trim() === text)) found = n;
    for (const k of [...(n.children ?? []), ...(n.shadowRoots ?? [])]) walk(k);
  })(root);
  if (!found) throw new Error(`panel button not found: ${text}`);
  return found.nodeId;
}
async function clickPanel(text) {
  const nodeId = await panelButton(text);
  const { model } = await cdp.send('DOM.getBoxModel', { nodeId });
  const [x1, y1, , , x3, y3] = model.content;
  await page.mouse.click((x1 + x3) / 2, (y1 + y3) / 2);
}

const zappedTexts = () =>
  page.$$eval('[data-lpz-zapped]', (els) => els.map((e) => e.textContent.replace(/\s+/g, ' ').trim().slice(0, 50)));
const isZapped = (needle) =>
  page.evaluate((n) => [...document.querySelectorAll('[data-lpz-zapped]')].some((e) => e.textContent.includes(n)), needle);

await page.goto(pageUrl);
await page.waitForSelector('[data-lpz-id]', { state: 'attached' });
await page.waitForTimeout(300);

const initial = await zappedTexts();
console.log(`Hidden on load (${initial.length}):\n  ${initial.join('\n  ')}`);

for (const kept of ['ransomware attack', 'data privacy, asking', 'local-first software', 'plain-language data privacy']) {
  assert.equal(await isZapped(kept), false, `on-lens block kept: ${kept}`);
}
for (const gone of ['mild weekend', 'spring musical', 'celebrity gossip', 'Otters beat']) {
  assert.equal(await isZapped(gone), true, `off-lens block hidden: ${gone}`);
}
// A known false zap of the word-only scorer, kept in the fixture on purpose:
// this paragraph is about the attack but never uses a topic's words. A model
// scorer should keep it; the ledger is how a reader catches it.
assert.equal(await isZapped('incident report'), true, 'lexical scorer misses the on-topic paragraph');
// Never zapped: the correction, headings, navigation, the form, the dialog.
assert.equal(await isZapped('Correction:'), false, 'correction kept');
assert.equal(await page.$$eval('h1[data-lpz-zapped], nav[data-lpz-zapped], form [data-lpz-zapped], form[data-lpz-zapped], [role=dialog][data-lpz-zapped]', (e) => e.length), 0);
assert.equal(await page.isVisible('text=Correction: An earlier version'), true);
assert.equal(await page.isVisible('text=mild weekend'), false, 'zapped block is not displayed');
if (shots) await page.screenshot({ path: join(shots, 'after.jpg'), quality: 80 });

// Before/After shows the page as published, with zaps outlined.
await clickPanel('Before');
assert.equal(await page.isVisible('text=mild weekend'), true, 'Before shows zapped blocks');
if (shots) await page.screenshot({ path: join(shots, 'before.jpg'), quality: 80 });
await clickPanel('After');
assert.equal(await page.isVisible('text=mild weekend'), false);

// Show restores one block on this page.
const showButtons = await (async () => {
  const { root } = await cdp.send('DOM.getDocument', { depth: -1, pierce: true });
  let n = 0;
  (function walk(x) {
    if (x.nodeName === 'BUTTON' && (x.children ?? []).some((c) => c.nodeType === 3 && c.nodeValue.trim() === 'Show')) n++;
    for (const k of [...(x.children ?? []), ...(x.shadowRoots ?? [])]) walk(k);
  })(root);
  return n;
})();
assert.equal(showButtons, initial.length, 'ledger lists every hidden block');
await clickPanel('Show');
await page.waitForTimeout(100);
assert.equal((await zappedTexts()).length, initial.length - 1, 'Show restored one block');

// Interests: raise "celebrity gossip" from -0.5 toward 0 with the keyboard, then save.
await clickPanel('Interests');
const { root } = await cdp.send('DOM.getDocument', { depth: -1, pierce: true });
let rangeId = null;
(function walk(x) {
  if (x.nodeName === 'INPUT' && (x.attributes ?? []).join('|').includes('aria-label|celebrity gossip')) rangeId = x.nodeId;
  for (const k of [...(x.children ?? []), ...(x.shadowRoots ?? [])]) walk(k);
})(root);
assert.ok(rangeId, 'celebrity gossip slider present');
await cdp.send('DOM.focus', { nodeId: rangeId });
for (let i = 0; i < 4; i++) await page.keyboard.press('ArrowRight'); // -0.5 → -0.3
await page.waitForTimeout(200);
if (shots) await page.screenshot({ path: join(shots, 'interests.jpg'), quality: 80 });
await clickPanel('Save to lens');
await page.waitForTimeout(400);
const { lens, draftWeights } = await worker.evaluate(() => chrome.storage.local.get(['lens', 'draftWeights']));
const gossip = lens.interpretation.priorities.find((p) => p.topic === 'celebrity gossip');
assert.equal(gossip.weight, -0.3);
assert.equal(lens.metadata.lensVersion, '1.5.0', 'a 0.2 change is minor: MINOR bump');
assert.deepEqual(Object.keys(lens.versionHistory.at(-1)).sort(), ['hash', 'lensVersion']);
assert.deepEqual(draftWeights, {});
const local = await worker.evaluate(() => chrome.storage.local.get(null));
assert.ok(!JSON.stringify(local.lens).includes('127.0.0.1'), 'lens holds no trace of the page');

// --- Model scorer path, against a stand-in model server on 127.0.0.1 --------
// The stand-in answers the OpenAI-compatible and Ollama APIs with canned
// judgments, so this exercises the real plumbing (service worker fetch,
// batching, parsing, decisions) without needing a model installed. It omits
// one passage on purpose: a block the model says nothing about must stay.
const judge = (text) => {
  const m = { 'local-first software': 0, 'school cybersecurity': 0, 'data privacy': 0, 'celebrity gossip': 0 };
  if (/ransomware|incident report|vendor account/i.test(text)) m['school cybersecurity'] = 0.9;
  if (/privacy|data inventory/i.test(text)) m['data privacy'] = 0.9;
  if (/sync engine|local-first/i.test(text)) m['local-first software'] = 0.9;
  if (/celebrity|pop star/i.test(text)) m['celebrity gossip'] = 0.95;
  return m;
};
let modelCalls = 0;
const modelServer = createServer((req, res) => {
  let raw = '';
  req.on('data', (c) => (raw += c));
  req.on('end', () => {
    modelCalls++;
    const body = JSON.parse(raw);
    const { passages } = JSON.parse(body.messages[1].content);
    const results = passages
      .filter((p) => !p.text.includes('spring musical'))
      .map((p) => ({ id: p.id, matches: judge(p.text), evidence: /^Correction/.test(p.text) }));
    const content = JSON.stringify({ results });
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(req.url === '/api/chat' ? { message: { content } } : { choices: [{ message: { content } }] }));
  });
}).listen(0, '127.0.0.1');
await new Promise((r) => modelServer.once('listening', r));
const modelEndpoint = `http://127.0.0.1:${modelServer.address().port}`;

for (const api of ['openai', 'ollama']) {
  await worker.evaluate((settings) => chrome.storage.local.set({ settings }), {
    threshold: 0.8,
    scorer: 'model',
    model: { api, endpoint: modelEndpoint, model: 'stand-in' }
  });
  modelCalls = 0;
  await page.reload();
  await page.waitForFunction(() => document.querySelectorAll('[data-lpz-zapped]').length > 0, null, { timeout: 15000 });
  await page.waitForTimeout(300);
  assert.ok(modelCalls > 0, `${api}: the model endpoint was called`);
  assert.equal(await isZapped('incident report'), false, `${api}: model keeps the on-topic paragraph the lexical scorer missed`);
  assert.equal(await isZapped('mild weekend'), true, `${api}: off-lens block hidden`);
  assert.equal(await isZapped('spring musical'), false, `${api}: a block the model said nothing about is never zapped`);
  assert.equal(await isZapped('Correction:'), false);
  console.log(`model scorer (${api}): hidden ${(await zappedTexts()).length}, ${modelCalls} request(s)`);
}
if (shots) await page.screenshot({ path: join(shots, 'model-scorer.jpg'), quality: 80 });

await context.close();
server.close();
modelServer.close();
console.log('browser check: all assertions passed');
