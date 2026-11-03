// SPDX-License-Identifier: Apache-2.0
//
// End-to-end check of the zapper extension in Chromium, against the fictional
// fixture page. Not part of CI (it needs a browser); run it by hand:
//
//   node test/browser-check.mjs [--screenshots]
//
// Needs the `playwright` package and a Chromium it can launch. It serves
// demo/ on 127.0.0.1, loads the unpacked extension, and checks that the
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
const splitter = readFileSync(join(zapperDir, 'demo/splitter.html'));
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

// Out of the box, a block that matches none of your interests stays: only a
// "less of this" match can zap. The sample lens weights gossip at only -0.5,
// so at 80% nothing is hidden.
assert.equal((await worker.evaluate(() => chrome.storage.local.get('settings'))).settings?.hideUnmatched ?? false, false);
assert.equal(await isZapped('mild weekend'), false, 'default: a block matching no interest is kept');
assert.equal(await isZapped('spring musical'), false, 'default: a block matching no interest is kept');
console.log(`default (keep unmatched): ${(await zappedTexts()).length} hidden`);
// The rest of this check uses the other choice: hide blocks that match none of your interests.
await worker.evaluate(() => chrome.storage.local.get('settings').then(({ settings }) =>
  chrome.storage.local.set({ settings: { ...(settings ?? {}), hideUnmatched: true } })));
await page.reload();
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

// The debug report: every block with its decision, and no page text unless asked.
{
  const report = await panel.evaluate((id) => chrome.tabs.sendMessage(id, { type: 'page-action', action: 'debug', text: false }), tabId);
  assert.equal(report.host, '127.0.0.1');
  assert.equal(report.url, undefined, 'no address without asking');
  assert.ok(report.blocks.length >= 10);
  assert.equal(report.blocks.filter((b) => b.zap).length, initial.length, 'report agrees with the page');
  assert.ok(report.blocks.every((b) => b.text === undefined && typeof b.trace === 'string'));
  const withText = await panel.evaluate((id) => chrome.tabs.sendMessage(id, { type: 'page-action', action: 'debug', text: true }), tabId);
  assert.ok(withText.blocks.some((b) => b.text.includes('mild weekend')));
  const worker = await panel.evaluate(() => chrome.runtime.sendMessage({ type: 'debug-info' }));
  assert.deepEqual(worker.recentErrors, []);
  await tab('Settings');
  assert.equal(await panel.isEnabled('button:text-is("Copy debug report")'), true);
  await tab('Ledger');
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

// The Lens tab on a lens that has never been saved (no versionHistory yet):
// an edit must show as saveable, not as invalid.
await tab('Lens');
await panel.fill('input[aria-label="New interest"]', 'first edit');
await panel.click('.prio button:text-is("Add")');
assert.equal(await panel.locator('.error').count(), 0, 'a fresh lens edit is not reported invalid');
assert.equal(await panel.isEnabled('button:text-is("Save new version")'), true);
await panel.click('button:text-is("Discard edits")');

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
// Back to 80%. Step until the slider reads 0.8: a key press can land while the
// panel re-renders and be lost, which made a fixed count of 30 flaky.
const zapSlider = 'input[aria-label^="Zap when"]';
for (let i = 0; i < 40 && Math.abs(Number(await panel.inputValue(zapSlider)) - 0.8) > 1e-6; i++) {
  await panel.focus(zapSlider);
  await panel.keyboard.press('ArrowRight');
}
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
// Turning hover info off takes down an open popover at once, no reload, and
// later hovers show none; turning it back on brings hovers back.
const hoverBox = panel.locator('label.check:has-text("Show the score when I hover over a block") input');
assert.equal(await hoverBox.isChecked(), true, 'hover info is on by default');
await page.hover('p:has-text("student information system is back online")');
await page.waitForTimeout(400);
assert.ok(await tipHtml(), 'hover popover shown before turning it off');
await hoverBox.uncheck();
await page.waitForTimeout(300);
assert.equal(await tipHtml(), null, 'hover info off: open popover closes without a reload');
assert.equal(await page.locator('[data-lpz-hover]').count(), 0, 'hover info off: no hover outline');
await page.mouse.move(5, 5);
await page.hover('p:has-text("student information system is back online")');
await page.waitForTimeout(400);
assert.equal(await tipHtml(), null, 'hover info off: no popover on hover');
await page.mouse.move(5, 5);
await hoverBox.check();
await page.waitForTimeout(200);
await page.hover('p:has-text("student information system is back online")');
await page.waitForTimeout(400);
assert.ok(await tipHtml(), 'hover info back on: popover shown');
await page.mouse.move(5, 5);
if (shots) await panel.screenshot({ path: join(shots, 'panel-settings.jpg'), quality: 85 });

// The panel follows the system's light or dark setting, form controls included.
const panelColors = () =>
  panel.evaluate(() => {
    const css = (el, prop) => getComputedStyle(el)[prop];
    const probe = document.body.appendChild(document.createElement('input')); // native control, unstyled by the panel
    const out = { bg: css(document.body, 'backgroundColor'), fg: css(document.body, 'color'), input: css(probe, 'backgroundColor') };
    probe.remove();
    return out;
  });
const light = await panelColors();
await panel.emulateMedia({ colorScheme: 'dark' });
const dark = await panelColors();
const lum = (rgb) => rgb.match(/\d+/g).slice(0, 3).reduce((a, n) => a + Number(n), 0) / 3;
assert.ok(lum(light.bg) > 200 && lum(light.fg) < 60, `light panel is dark on light (${light.bg}, ${light.fg})`);
assert.ok(lum(dark.bg) < 60 && lum(dark.fg) > 200, `dark panel is light on dark (${dark.bg}, ${dark.fg})`);
assert.ok(lum(dark.input) < 90, `dark panel form controls are dark too (${dark.input})`);
if (shots) await panel.screenshot({ path: join(shots, 'panel-settings-dark.jpg'), quality: 85 });
await tab('Ledger');
if (shots) await panel.screenshot({ path: join(shots, 'panel-ledger-dark.jpg'), quality: 85 });
await panel.emulateMedia({ colorScheme: 'light' });
await tab('Settings');

// Pause: the zapper is inert. Nothing is hidden, scored, or drawn.
await panel.click('#body button:text-is("Pause on this site")');
await page.waitForFunction(() => !document.querySelector('[data-lpz-zapped], [data-lpz-zapping]'), null, { timeout: 5000 });
assert.equal(await page.isVisible('text=mild weekend'), true, 'paused: nothing hidden');
await panel.waitForSelector('#count:has-text("nothing scored or hidden")');
// Content added while paused is not even split into blocks.
await page.evaluate(() => {
  const p = document.createElement('p');
  p.id = 'added-while-paused';
  p.textContent = 'A late paragraph about the mild weekend forecast and the valley rain gauges, added while paused.';
  document.querySelector('main, article, body').append(p);
});
await page.waitForTimeout(1200);
assert.equal(await page.getAttribute('#added-while-paused', 'data-lpz-id'), null, 'paused: new content is not split or scored');
await page.hover('p:has-text("student information system is back online")');
await page.waitForTimeout(400);
assert.equal(await tipHtml(), null, 'paused: no hover popover');
await page.mouse.move(5, 5);
assert.match(await panel.textContent('#paused'), /Paused on this site/, 'the panel says the site is paused');
// Resume from the header banner.
await panel.click('#paused button:text-is("Resume on this site")');
await page.waitForFunction(() => document.querySelectorAll('[data-lpz-zapped], [data-lpz-zapping]').length > 0, null, { timeout: 5000 });
await settle();
assert.equal(await panel.isHidden('#paused'), true, 'no pause banner once resumed');
assert.notEqual(await page.getAttribute('#added-while-paused', 'data-lpz-id'), null, 'resume: content added while paused is split and scored');
await page.evaluate(() => document.getElementById('added-while-paused')?.remove());
await settle();

// Pause everywhere: the same, on every site, and independent of the site's own pause.
await panel.click('#body button:text-is("Pause everywhere")');
await page.waitForFunction(() => !document.querySelector('[data-lpz-zapped], [data-lpz-zapping]'), null, { timeout: 5000 });
await panel.waitForSelector('#count:has-text("Paused everywhere")');
assert.match(await panel.textContent('#paused'), /Paused everywhere/, 'the banner says paused everywhere');
await panel.click('#body button:text-is("Pause on this site")');
await panel.waitForSelector('#paused:has-text("Paused everywhere and on this site")');
await panel.click('#paused button:text-is("Resume everywhere")');
await panel.waitForSelector('#count:has-text("Paused on this site")');
assert.equal(await page.isVisible('text=mild weekend'), true, 'the site pause outlives the browser-wide one');
await panel.click('#body button:text-is("Resume on this site")');
await page.waitForFunction(() => document.querySelectorAll('[data-lpz-zapped], [data-lpz-zapping]').length > 0, null, { timeout: 5000 });
await settle();

// --- Generic splitter: each layout in demo/splitter.html splits as marked ------
await context.route('https://splitter.example/**', (route) =>
  route.fulfill({ status: 200, contentType: 'text/html; charset=utf-8', body: splitter }));
await page.goto('https://splitter.example/');
await page.waitForSelector('[data-lpz-id]', { state: 'attached' });
await settle();
const splitProblems = await page.evaluate(() => {
  const blockOf = (el) => el.closest('[data-lpz-id]')?.getAttribute('data-lpz-id') ?? null;
  const bad = [];
  for (const el of document.querySelectorAll('[data-expect]')) {
    const want = el.getAttribute('data-expect');
    const got = blockOf(el);
    const name = el.id || el.textContent.trim().slice(0, 30);
    if (want === 'none' && (got || el.querySelector('[data-lpz-id]'))) bad.push(`${name}: should be in no block`);
    if (want === 'block' && el.getAttribute('data-lpz-id') == null) bad.push(`${name}: should be a block (is in ${got})`);
    if (want === 'ad' && (el.getAttribute('data-lpz-id') == null || !el.hasAttribute('data-lpz-ad'))) bad.push(`${name}: should be an ad slot`);
    if (want !== 'ad' && (el.hasAttribute('data-lpz-ad') || el.closest('[data-lpz-ad]'))) bad.push(`${name}: should not be an ad slot`);
    if (want.startsWith('with:') && (!got || got !== blockOf(document.getElementById(want.slice(5))))) bad.push(`${name}: should be with ${want.slice(5)} (is in ${got})`);
  }
  return bad;
});
assert.deepEqual(splitProblems, [], `splitter fixture:\n${splitProblems.join('\n')}`);
console.log('splitter fixture: every layout split as marked');
assert.equal(await page.getAttribute('#rail', 'data-lpz-id'), null, 'a tall column holding an ad is not taken as the ad slot');
assert.equal(await page.getAttribute('#filling-slot', 'data-lpz-ad'), '', 'an empty labelled slot starts as an ad slot');
await page.evaluate(() => {
  const p = document.createElement('p');
  p.id = 'filled-story';
  p.textContent = 'Stories loaded into what looked like an ad slot: the library extends its weekend hours through the winter.';
  document.getElementById('filling-slot').append(p);
});
await page.waitForFunction(() => !document.getElementById('filling-slot').hasAttribute('data-lpz-ad') &&
  !!document.getElementById('filled-story').closest('[data-lpz-id]'), null, { timeout: 5000 });
console.log('ad slots: a slot that fills with text is split like any other content');

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
let modelDelay = 40; // a model takes a moment
let aborted = 0; // requests the extension cancelled before the answer
const modelServer = createServer((req, res) => {
  let raw = '';
  inFlight++;
  maxInFlight = Math.max(maxInFlight, inFlight);
  res.on('close', () => { inFlight--; if (!res.writableFinished) aborted++; });
  req.on('data', (c) => (raw += c));
  req.on('end', async () => {
    modelCalls++;
    await new Promise((r) => setTimeout(r, modelDelay));
    if (res.destroyed) return;
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
  // Leave the page first, so the old page does not start rescoring with the
  // new settings while the new one loads (two pages would share the limit).
  await page.goto('about:blank');
  await worker.evaluate((settings) => chrome.storage.local.set({ settings }), {
    threshold: 0.8,
    scorer: 'model',
    hideUnmatched: true,
    model: { api, endpoint: modelEndpoint, model: 'stand-in', concurrency: 2 }
  });
  modelCalls = 0;
  maxInFlight = 0;
  await page.goto(pageUrl);
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

// The score cache outlives the service worker in chrome.storage.session
// (memory only), and holds scores only: no page text, no addresses.
const sessionCache = await worker.evaluate(() => chrome.storage.session.get('scoreCache'));
assert.ok(Array.isArray(sessionCache.scoreCache) && sessionCache.scoreCache.length > 0, 'score cache kept in session storage');
const cacheJson = JSON.stringify(sessionCache.scoreCache);
assert.ok(!/Riverside|weather service|127\.0\.0\.1/.test(cacheJson), 'score cache holds no page text or addresses');
assert.equal(JSON.stringify(await worker.evaluate(() => chrome.storage.local.get(null))).includes('scoreCache'), false, 'score cache never in local storage');
// Back on a page already scored: answered from the cache, no model requests.
modelCalls = 0;
await page.goto('about:blank');
await page.goto(pageUrl);
await page.waitForFunction(() => document.querySelectorAll('[data-lpz-zapped]').length > 0, null, { timeout: 15000 });
await settle();
assert.equal(modelCalls, 1, `revisit: only the block the model never answered is asked again (saw ${modelCalls})`);

// --- Speed: a model scores only blocks near the screen, and more as you scroll ---
const longPage = '<!doctype html><meta charset="utf-8"><title>Long page (fictional)</title><body>' +
  Array.from({ length: 40 }, (_, i) => `<p style="margin:0 0 600px">Paragraph ${i + 1} of a long fictional page about the valley weather service and its rain gauges, item ${i + 1}.</p>`).join('') +
  '</body>';
await context.route('https://long.example/**', (route) => route.fulfill({ status: 200, contentType: 'text/html; charset=utf-8', body: longPage }));
await worker.evaluate((settings) => chrome.storage.local.set({ settings }), {
  threshold: 0.8, scorer: 'model', hideUnmatched: true, model: { api: 'systemone', endpoint: modelEndpoint, model: 'stand-in', concurrency: 2 }
});
modelCalls = 0;
await page.goto('https://long.example/');
await page.waitForFunction(() => document.querySelectorAll('[data-lpz-zapped]').length > 0, null, { timeout: 15000 });
await settle();
const longAtTop = modelCalls;
assert.ok(longAtTop > 0 && longAtTop < 12, `long page: only blocks near the screen are scored at first (${longAtTop} of 40)`);
await page.evaluate(() => scrollTo(0, document.body.scrollHeight));
await page.waitForFunction(() => document.querySelector('p:last-of-type')?.hasAttribute('data-lpz-zapped'), null, { timeout: 15000 });
assert.ok(modelCalls > longAtTop && modelCalls < 40, `long page: scrolling to the end scores what is near it (${modelCalls} of 40)`);
console.log(`long page: ${longAtTop} of 40 blocks scored at the top, ${modelCalls} after jumping to the end`);

// --- Pause with a model: no requests while paused, and a pause mid-page cancels them ---
const freshPage = (tag) => '<!doctype html><meta charset="utf-8"><title>Pause page (fictional)</title><body>' +
  Array.from({ length: 6 }, (_, i) => `<p>Paragraph ${i + 1} of the ${tag} page, about the hill town bus timetable and its new evening routes, item ${i + 1}.</p>`).join('') +
  '</body>';
await context.route('https://pause.example/**', (route) => route.fulfill({ status: 200, contentType: 'text/html; charset=utf-8', body: freshPage('first') }));
await context.route('https://pause2.example/**', (route) => route.fulfill({ status: 200, contentType: 'text/html; charset=utf-8', body: freshPage('second') }));
const setPausedEverywhere = (on) => worker.evaluate(async (on) => {
  const { settings } = await chrome.storage.local.get('settings');
  await chrome.storage.local.set({ settings: { ...settings, paused: on } });
}, on);
const anySpark = () => findLayerNode((x) => x.nodeName === 'svg' && attrsOf(x).class === 'spark').catch(() => null);

// A site opened while paused: no model requests, no blocks, no spark, nothing hidden.
await page.goto('about:blank');
await worker.evaluate(() => chrome.storage.local.set({ sites: { 'pause.example': { paused: true } } }));
modelCalls = 0;
await page.goto('https://pause.example/');
await page.waitForTimeout(1500);
assert.equal(modelCalls, 0, 'paused on this site: the model is never asked');
assert.equal(await page.$('[data-lpz-id]'), null, 'paused on this site: the page is not even split');
assert.equal(await anySpark(), null, 'paused on this site: no scoring spark');
// Resume: scored and zapped as usual.
await worker.evaluate(() => chrome.storage.local.set({ sites: {} }));
await page.waitForFunction(() => document.querySelectorAll('[data-lpz-zapped]').length > 0, null, { timeout: 15000 });
assert.ok(modelCalls > 0, 'resume on this site: the model is asked again');

// Pause everywhere mid-page, with slow requests in flight.
await page.goto('about:blank');
modelDelay = 4000;
modelCalls = 0;
aborted = 0;
await page.goto('https://pause2.example/');
for (let i = 0; i < 100 && !(inFlight > 0 && (await anySpark())); i++) await page.waitForTimeout(25);
assert.ok(inFlight > 0, 'mid-page: requests are in flight before the pause');
await setPausedEverywhere(true);
for (let i = 0; i < 60 && inFlight > 0; i++) await page.waitForTimeout(25);
assert.equal(inFlight, 0, 'mid-page pause: requests in flight are cancelled at once');
assert.ok(aborted > 0, `mid-page pause: the model server saw the requests cancelled (${aborted})`);
const callsAtPause = modelCalls;
await page.waitForTimeout(modelDelay + 500); // past when the cancelled answers would have come
assert.equal(modelCalls, callsAtPause, `mid-page pause: no more requests while paused (${modelCalls - callsAtPause} sent)`);
assert.equal(await anySpark(), null, 'mid-page pause: the sparks are taken down');
assert.equal(await page.$('[data-lpz-zapped], [data-lpz-zapping]'), null, 'mid-page pause: nothing is hidden');
// Resume everywhere: the blocks left unscored are scored and zapped.
modelDelay = 40;
await setPausedEverywhere(false);
await page.waitForFunction(() => document.querySelectorAll('[data-lpz-zapped]').length > 0, null, { timeout: 15000 });
assert.ok(modelCalls > callsAtPause, 'resume everywhere: scoring starts again');
console.log(`pause: 0 requests while paused, ${aborted} in-flight request(s) cancelled mid-page, scoring resumed after`);

// --- Hosted model: nothing is sent until it is set up, and never from a site kept off it ---
// The real provider path (key, granted host, https) is covered by the unit tests;
// here: a half-set-up hosted scorer sends nothing anywhere and hides nothing.
await context.route('https://hosted.example/**', (route) => route.fulfill({ status: 200, contentType: 'text/html; charset=utf-8', body: freshPage('hosted') }));
await page.goto('about:blank');
await worker.evaluate((settings) => chrome.storage.local.set({ settings, sites: {}, hostedKeys: {} }), {
  threshold: 0.65, scorer: 'hosted', hideUnmatched: true,
  model: { api: 'systemone', endpoint: modelEndpoint, model: 'stand-in', concurrency: 2 },
  hosted: { provider: 'jev', model: '', accountId: '', endpoint: '', concurrency: 2 }
});
modelCalls = 0;
await page.goto('https://hosted.example/');
await page.waitForTimeout(1500);
assert.equal(modelCalls, 0, 'hosted without a key: the local model is not asked either');
assert.equal(await page.$('[data-lpz-zapped]'), null, 'hosted without a key: nothing is hidden');
// A key but no granted host: still nothing sent.
await page.goto('about:blank');
await worker.evaluate(() => chrome.storage.local.set({ hostedKeys: { jev: 'test-key' } }));
const granted = await worker.evaluate(() => chrome.permissions.contains({ origins: ['https://api.typesafe.ai/*'] }));
assert.equal(granted, false, 'no hosted host is granted up front');
await page.goto('https://hosted.example/');
await page.waitForTimeout(1500);
assert.equal(await page.$('[data-lpz-zapped]'), null, 'hosted without access granted: nothing is hidden');
// A site kept off the hosted model: split, but not scored or sent.
await page.goto('about:blank');
await worker.evaluate(() => chrome.storage.local.set({ sites: { 'hosted.example': { noHosted: true } } }));
await page.goto('https://hosted.example/');
await page.waitForTimeout(1500);
assert.equal(await page.$('[data-lpz-zapped]'), null, 'kept off the hosted model: nothing is hidden');
assert.equal(modelCalls, 0, 'kept off the hosted model: no model is asked');
const keysInPage = await page.evaluate(() => document.documentElement.outerHTML.includes('test-key'));
assert.equal(keysInPage, false, 'the hosted key never reaches the page');
await worker.evaluate(() => chrome.storage.local.set({ sites: {}, hostedKeys: {} }));
console.log('hosted: nothing sent without a key, without granted access, or on a site kept off it');

await context.close();
server.close();
modelServer.close();
console.log('browser check: all assertions passed');
