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
// that Before/After, Show, the hover popover, and live sliders work, that
// saving an interest change writes a valid new lens version, that a site rule
// makes each table-row story one block, and that a model is asked a few
// blocks at a time.

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
const linkTable = readFileSync(join(zapperDir, 'demo/link-table.html'));
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
const extId = new URL(worker.url()).host;

// The popover lives in a closed shadow root, which page scripts (and
// Playwright locators) cannot reach. CDP can.
async function findLayerNode(test) {
  const { root } = await cdp.send('DOM.getDocument', { depth: -1, pierce: true });
  let found = null;
  (function walk(n) {
    if (found) return;
    if (test(n)) found = n;
    for (const k of [...(n.children ?? []), ...(n.shadowRoots ?? [])]) walk(k);
  })(root);
  return found;
}
const attrsOf = (n) => Object.fromEntries((n.attributes ?? []).reduce((acc, v, i, all) => (i % 2 ? acc : [...acc, [v, all[i + 1]]]), []));
const textOf = (n) => (n.children ?? []).filter((c) => c.nodeType === 3).map((c) => c.nodeValue).join('').trim();
async function clickLayerButton(text) {
  const n = await findLayerNode((x) => x.nodeName === 'BUTTON' && textOf(x) === text);
  if (!n) throw new Error(`popover button not found: ${text}`);
  const { model } = await cdp.send('DOM.getBoxModel', { nodeId: n.nodeId });
  const [x1, y1, , , x3, y3] = model.content;
  await page.mouse.click((x1 + x3) / 2, (y1 + y3) / 2);
}
async function tipHtml() {
  const n = await findLayerNode((x) => x.nodeName === 'DIV' && (attrsOf(x).class ?? '').split(' ').includes('tip'));
  if (!n || 'hidden' in attrsOf(n)) return null;
  return (await cdp.send('DOM.getOuterHTML', { nodeId: n.nodeId })).outerHTML;
}

// Scoring and zapping animate; wait until every block has settled.
const settle = async () => {
  await page.waitForFunction(() => !document.querySelector('[data-lpz-zapping]'), null, { timeout: 15000 });
  await page.waitForTimeout(150);
};

const zappedTexts = () =>
  page.$$eval('[data-lpz-zapped]', (els) => els.map((e) => e.textContent.replace(/\s+/g, ' ').trim().slice(0, 50)));
const isZapped = (needle) =>
  page.evaluate((n) => [...document.querySelectorAll('[data-lpz-zapped]')].some((e) => e.textContent.includes(n)), needle);
const block = (needle) => `[data-lpz-id]:has-text(${JSON.stringify(needle)})`;

await page.goto(pageUrl);
await page.waitForSelector('[data-lpz-id]', { state: 'attached' });
await settle();

// The side panel: Chrome docks it and reflows the page. Headless Chromium
// cannot show a side panel, so the check opens the same page in a tab, pinned
// to the fixture's tab. Nothing is drawn into the page's own layout.
await page.bringToFront();
const [{ id: tabId }] = await worker.evaluate(() => chrome.tabs.query({ active: true, lastFocusedWindow: true }));
const panel = await context.newPage();
await panel.setViewportSize({ width: 380, height: 900 });
await panel.goto(`chrome-extension://${extId}/sidepanel/sidepanel.html?tab=${tabId}`);
await panel.waitForSelector('#count strong');
assert.equal(await page.evaluate(() => getComputedStyle(document.documentElement).marginRight), '0px', 'the page layout is left to Chrome');
const tab = (name) => panel.click(`.tabs button:text-is("${name}")`);

const initial = await zappedTexts();
console.log(`Hidden on load (${initial.length}):\n  ${initial.join('\n  ')}`);
assert.equal(await panel.textContent('#count strong'), String(initial.length), 'panel shows the hidden count');

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
if (shots) {
  await page.screenshot({ path: join(shots, 'after.jpg'), quality: 80 });
  await panel.screenshot({ path: join(shots, 'panel-ledger.jpg'), quality: 85 });
}

// Before/After shows the page as published, with zaps outlined.
await panel.click('#before');
await page.waitForTimeout(100);
assert.equal(await page.isVisible('text=mild weekend'), true, 'Before shows zapped blocks');
if (shots) await page.screenshot({ path: join(shots, 'before.jpg'), quality: 80 });
await panel.click('#before');
await page.waitForTimeout(100);
assert.equal(await page.isVisible('text=mild weekend'), false);

// Hovering a kept block shows its score and why it was kept.
await page.hover('p:has-text("student information system is back online")');
await page.waitForTimeout(400);
const tipShown = await tipHtml();
assert.ok(tipShown, 'hover popover shown');
assert.match(tipShown, /Kept/, 'popover says the block was kept');
assert.match(tipShown, /off-lens/, 'popover shows the off-lens score');
assert.match(tipShown, /school cybersecurity/, 'popover lists topic matches');
if (shots) await page.screenshot({ path: join(shots, 'hover.jpg'), quality: 80 });
await page.mouse.move(5, 5);

// Show restores one block on this page; every hidden block is listed.
assert.equal(await panel.locator('li.entry button:text-is("Show")').count(), initial.length, 'ledger lists every hidden block');
await panel.locator('li.entry button:text-is("Show")').first().click();
await panel.mouse.move(370, 5); // off the list, so it refreshes
await page.waitForTimeout(300);
assert.equal((await zappedTexts()).length, initial.length - 1, 'Show restored one block');

// The confidence slider re-decides the page while it moves, with no reload.
await tab('Interests');
await panel.focus('input[aria-label^="Zap when"]');
const beforeSlide = (await zappedTexts()).length;
await panel.keyboard.press('End'); // 99%
await settle();
const atTop = (await zappedTexts()).length;
await panel.keyboard.press('Home'); // 50%
await settle();
const atBottom = (await zappedTexts()).length;
console.log(`live threshold: ${beforeSlide} hidden at 80%, ${atTop} at 99%, ${atBottom} at 50%`);
assert.ok(atBottom > atTop, 'moving the confidence slider changes what is hidden right away');
for (let i = 0; i < 30; i++) await panel.keyboard.press('ArrowRight'); // back to 80%
await page.waitForTimeout(800);

// Interests: raise "celebrity gossip" from -0.5 toward 0 with the keyboard, then save.
await panel.focus('input[aria-label="celebrity gossip"]');
for (let i = 0; i < 4; i++) await panel.keyboard.press('ArrowRight'); // -0.5 → -0.3
await page.waitForTimeout(200);
if (shots) await panel.screenshot({ path: join(shots, 'panel-interests.jpg'), quality: 85 });
await panel.click('button:text-is("Save to lens")');
await page.waitForTimeout(400);
let { lens, draftWeights, settings } = await worker.evaluate(() => chrome.storage.local.get(['lens', 'draftWeights', 'settings']));
const gossip = lens.interpretation.priorities.find((p) => p.topic === 'celebrity gossip');
assert.equal(gossip.weight, -0.3);
assert.equal(lens.metadata.lensVersion, '1.5.0', 'a 0.2 change is minor: MINOR bump');
assert.deepEqual(Object.keys(lens.versionHistory.at(-1)).sort(), ['hash', 'lensVersion']);
assert.deepEqual(draftWeights, {});
assert.equal(settings.threshold, 0.8, 'threshold slider stored');

// Lens: add an interest directly, see its impact, save it as a new version.
await tab('Lens');
await panel.fill('input[aria-label="New interest"]', 'open data');
await panel.fill('input[aria-label="Weight for the new interest"]', '0.4');
await panel.click('.prio button:text-is("Add")');
assert.match(await panel.textContent('.changes'), /Add “open data”.*minor/);
if (shots) await panel.screenshot({ path: join(shots, 'panel-lens.jpg'), quality: 85 });
await panel.click('button:text-is("Save new version")');
await panel.waitForSelector('.ok:has-text("Saved as version 1.6.0")');
({ lens } = await worker.evaluate(() => chrome.storage.local.get(['lens'])));
assert.ok(lens.interpretation.priorities.some((p) => p.topic === 'open data' && p.weight === 0.4));
assert.equal(lens.metadata.lensVersion, '1.6.0', 'a small new interest is minor');
// Removing one is major.
await panel.click('button[aria-label="Remove open data"]');
await panel.click('button:text-is("Save new version")');
await panel.waitForSelector('.ok:has-text("Saved as version 2.0.0")');
// The JSON editor rejects a document that is not a lens.
await panel.click('summary:text-is("Edit as JSON")');
await panel.fill('textarea.json', '{"not": "a lens"}');
await panel.click('button:text-is("Save JSON as new version")');
await panel.waitForSelector('.error:has-text("Not saved")');
({ lens } = await worker.evaluate(() => chrome.storage.local.get(['lens'])));
assert.equal(lens.metadata.lensVersion, '2.0.0', 'an invalid edit changes nothing');
const local = await worker.evaluate(() => chrome.storage.local.get(null));
assert.ok(!JSON.stringify(local.lens).includes('127.0.0.1'), 'lens holds no trace of the page');
await settle();

// Train: mark blocks Keep or Zap on the page, get a suggestion in the panel.
await tab('Train');
await panel.click('button:text-is("Start training on this page")');
await page.waitForTimeout(200);
assert.equal(await page.isVisible('text=mild weekend'), true, 'training shows zapped blocks');
const marks = [
  ['incident report', 'Keep'],
  ['student information system is back online', 'Keep'],
  ['mild weekend', 'Zap'],
  ['spring musical', 'Zap'],
  ['Pop star spotted', 'Zap'],
  ['Otters beat', 'Zap']
];
for (const [needle, choice] of marks) {
  await page.click(block(needle), { position: { x: 5, y: 5 } });
  await page.waitForTimeout(100);
  await clickLayerButton(choice);
  await page.waitForTimeout(150);
}
assert.equal(await page.url(), pageUrl, 'clicks in training mode do not follow links');
const { training } = await worker.evaluate(() => chrome.storage.local.get(['training']));
assert.equal(training.length, marks.length, 'every mark stored');
for (const ex of training) assert.deepEqual(Object.keys(ex).sort(), ['label', 'matches'], 'a mark holds scores and a label only');
assert.ok(!JSON.stringify(training).includes('weekend'), 'no page text in training marks');
await panel.waitForSelector('.suggest');
const suggestion = await panel.textContent('.suggest');
console.log(`training suggestion: ${suggestion.replace(/\s+/g, ' ').slice(0, 200)}`);
assert.match(suggestion, /Now: 1 of 6 wrong/, 'the lexical false zap is counted');
assert.match(suggestion, /matched none of your interests/, 'and explained: it needs a new interest');
if (shots) {
  await page.screenshot({ path: join(shots, 'train.jpg'), quality: 80 });
  await panel.screenshot({ path: join(shots, 'panel-train.jpg'), quality: 85 });
}
await panel.click('button:text-is("Stop training on this page")');
await panel.click('button:text-is("Clear all marks")');
await panel.waitForTimeout(200);

// Settings live in the panel too.
await tab('Settings');
assert.ok(await panel.isVisible('text=Show the score when I hover over a block'));
if (shots) await panel.screenshot({ path: join(shots, 'panel-settings.jpg'), quality: 85 });

// --- Site rule: table-row stories are one block each -------------------------
await context.route('https://news.ycombinator.com/**', (route) =>
  route.fulfill({ status: 200, contentType: 'text/html; charset=utf-8', body: linkTable }));
await panel.close();
await page.goto('https://news.ycombinator.com/');
await page.waitForSelector('[data-lpz-id]', { state: 'attached' });
await settle();
const rows = await page.evaluate(() => {
  const ids = [...document.querySelectorAll('tr.athing')].map((tr) => tr.getAttribute('data-lpz-id'));
  const group = (id) => document.querySelectorAll(`[data-lpz-id="${id}"]`).length;
  return {
    ids,
    sizes: ids.map(group),
    chrome: document.querySelectorAll('.pagetop[data-lpz-id], .pagetop [data-lpz-id], [data-lpz-id] .pagetop, .yclinks[data-lpz-id], [data-lpz-id] .yclinks, [data-lpz-id] .morelink').length,
    football: [...document.querySelectorAll('[data-lpz-id]')].filter((e) => e.getAttribute('data-lpz-id') === document.getElementById('s4').getAttribute('data-lpz-id')).map((e) => e.hasAttribute('data-lpz-zapped'))
  };
});
console.log(`link table: ${rows.ids.length} stories, rows per block ${rows.sizes.join(',')}`);
assert.equal(rows.ids.length, 5, 'every story row is its own block');
assert.equal(new Set(rows.ids).size, 5);
assert.ok(rows.ids.every(Boolean));
assert.deepEqual(rows.sizes, [3, 3, 3, 3, 2], 'a story block includes its points row and spacer');
assert.equal(rows.chrome, 0, 'the top links, the More link, and the footer links are never blocks');
assert.ok(rows.football.length > 1 && rows.football.every(Boolean), 'zapping a story hides all of its rows');
if (shots) await page.screenshot({ path: join(shots, 'link-table.jpg'), quality: 80 });
await page.goto(pageUrl);

// --- Model scorer path, against a stand-in model server on 127.0.0.1 --------
// The stand-in answers the decision-model (/v1/systemone), OpenAI-compatible, and Ollama APIs with canned
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
let inFlight = 0;
let maxInFlight = 0;
const modelServer = createServer((req, res) => {
  let raw = '';
  inFlight++;
  maxInFlight = Math.max(maxInFlight, inFlight);
  res.on('finish', () => inFlight--);
  req.on('data', (c) => (raw += c));
  req.on('end', async () => {
    modelCalls++;
    await new Promise((r) => setTimeout(r, 40)); // a model takes a moment
    const body = JSON.parse(raw);
    if (req.url === '/v1/systemone') {
      // Decision-model API: one block per request, a noul question per topic.
      const text = body.state;
      const answers = {};
      if (!text.includes('spring musical')) {
        const m = judge(text);
        for (const [key, q] of Object.entries(body.questions)) {
          const topic = Object.keys(m).find((t) => q.instructions.includes(t));
          answers[key] = { type: 'noul', noul: key === 'evidence' ? (/Correction/.test(text) ? 0.95 : 0.02) : m[topic] ?? 0 };
        }
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ model: 'stand-in', answers, usage: { input_tokens: 0, output_tokens: 0 } }));
      return;
    }
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

for (const api of ['systemone', 'openai', 'ollama']) {
  await worker.evaluate((settings) => chrome.storage.local.set({ settings }), {
    threshold: 0.8,
    scorer: 'model',
    model: { api, endpoint: modelEndpoint, model: 'stand-in', concurrency: 2 }
  });
  modelCalls = 0;
  maxInFlight = 0;
  await page.reload();
  if (api === 'systemone') {
    // While the model works, a spark races round each block being scored.
    let spark = null;
    for (let i = 0; i < 40 && !spark; i++) {
      spark = await findLayerNode((x) => x.nodeName === 'svg' && attrsOf(x).class === 'spark').catch(() => null);
      if (!spark) await page.waitForTimeout(25);
    }
    assert.ok(spark, 'scoring spark drawn on the layer while the model works');
    if (shots) await page.screenshot({ path: join(shots, 'scoring.jpg'), quality: 80 });
  }
  await page.waitForFunction(() => document.querySelectorAll('[data-lpz-zapped]').length > 0, null, { timeout: 15000 });
  await settle();
  assert.ok(modelCalls > 0, `${api}: the model endpoint was called`);
  assert.ok(maxInFlight <= 2, `${api}: at most 2 requests at once (saw ${maxInFlight})`);
  if (api === 'systemone') {
    const n = await page.$$eval('[data-lpz-id]', (els) => new Set(els.map((e) => e.getAttribute('data-lpz-id'))).size);
    assert.equal(modelCalls, n, 'systemone: one request per block');
  }
  assert.equal(await isZapped('incident report'), false, `${api}: model keeps the on-topic paragraph the lexical scorer missed`);
  assert.equal(await isZapped('mild weekend'), true, `${api}: off-lens block hidden`);
  assert.equal(await isZapped('spring musical'), false, `${api}: a block the model said nothing about is never zapped`);
  assert.equal(await isZapped('Correction:'), false);
  console.log(`model scorer (${api}): hidden ${(await zappedTexts()).length}, ${modelCalls} request(s), at most ${maxInFlight} at once`);
}
if (shots) await page.screenshot({ path: join(shots, 'model-scorer.jpg'), quality: 80 });

await context.close();
server.close();
modelServer.close();
console.log('browser check: all assertions passed');
