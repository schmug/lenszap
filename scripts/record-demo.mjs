// SPDX-License-Identifier: Apache-2.0
//
// Records a feature demo of the extension as one video: the page on the left,
// the side panel on the right, a caption bar along the bottom. Not part of CI.
//
//   node scripts/record-demo.mjs [--out FILE.webm] [--endpoint URL] [--lens FILE]
//                                [--sites a,b,c] [--stub] [--headed]
//
// Default: real sites (theverge.com, krebsonsecurity.com, news.ycombinator.com)
// scored by the model at --endpoint (default http://127.0.0.1:8181, llama-server's
// /v1/systemone). --stub instead serves demo/fixture.html and a stand-in model on
// 127.0.0.1, for trying the script with no model and no network.
//
// How it is made: headless Chromium cannot dock a side panel, so the panel page
// is opened in its own tab, pinned to the page's tab, just as test/browser-check
// does. Both tabs are captured with CDP screencasts to JPEG frames, then a third,
// separate browser replays the two frame streams side by side with captions.
// With ffmpeg on PATH each output frame is screenshotted and encoded to a sharp
// 1920x1080 H.264 .mp4; without it, Playwright's (lower quality) recorder is used.
//
// A small dot is drawn on the page and the panel to show where the pointer is.
// It is part of the recording only, never of the extension.

import { createServer } from 'node:http';
import { readFileSync, writeFileSync, mkdirSync, mkdtempSync, renameSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { parseArgs } from 'node:util';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright');

const { values: args } = parseArgs({
  options: {
    out: { type: 'string' },
    endpoint: { type: 'string', default: 'http://127.0.0.1:8181' },
    lens: { type: 'string' },
    sites: { type: 'string' },
    stub: { type: 'boolean', default: false },
    headed: { type: 'boolean', default: false },
    concurrency: { type: 'string', default: '4' }
  }
});

const root = fileURLToPath(new URL('..', import.meta.url));
const work = mkdtempSync(join(tmpdir(), 'lpz-demo-'));
const outFile = resolve(args.out ?? join(root, 'demo-recording', `lenszap-demo-${new Date().toISOString().slice(0, 10)}.webm`));
mkdirSync(join(outFile, '..'), { recursive: true });

// 1920x1080 in all: the page, the panel beside it, the caption bar below.
const PAGE = { width: 1520, height: 1004 };
const PANEL = { width: 400, height: 1004 };
const CAPTION_H = 76;

// Interests for the demo lens, unless --lens is given.
const DEMO_PRIORITIES = [
  { topic: 'cybersecurity', weight: 1, rationale: 'Breaches of personal data count here too.' },
  { topic: 'local-first software', weight: 0.9 },
  { topic: 'data privacy', weight: 0.6 },
  { topic: 'open source', weight: 0.5 },
  { topic: 'celebrity gossip', weight: -0.9 },
  { topic: 'trump', weight: -0.95 },
  { topic: 'advertisements', weight: -1 }
];

// --- Stub mode: fixture pages and a stand-in model ---------------------------
let stubServers = [];
let endpoint = args.endpoint;
let sites = (args.sites ?? 'https://www.theverge.com/,https://krebsonsecurity.com/,https://news.ycombinator.com/').split(',');
if (args.stub) {
  const fixture = readFileSync(join(root, 'demo/fixture.html'));
  const pages = createServer((req, res) => { res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }); res.end(fixture); }).listen(0, '127.0.0.1');
  const judge = (t) => ({
    cybersecurity: /ransomware|incident|vendor account|student information/i.test(t) ? 0.9 : 0.02,
    'data privacy': /privacy|data inventory/i.test(t) ? 0.9 : 0.02,
    'local-first software': /sync engine|local-first/i.test(t) ? 0.9 : 0.02,
    'celebrity gossip': /celebrity|pop star/i.test(t) ? 0.95 : 0.02
  });
  const model = createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', async () => {
      await new Promise((r) => setTimeout(r, 300 + Math.random() * 500));
      const body = JSON.parse(raw);
      const m = judge(body.state ?? '');
      const answers = {};
      for (const [key, q] of Object.entries(body.questions ?? {})) {
        const topic = Object.keys(m).find((t) => q.instructions.includes(t));
        answers[key] = { type: 'noul', noul: key === 'evidence' ? (/Correction/.test(body.state) ? 0.95 : 0.02) : m[topic] ?? 0.02 };
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ model: 'stand-in', answers }));
    });
  }).listen(0, '127.0.0.1');
  await Promise.all([pages, model].map((s) => new Promise((r) => s.once('listening', r))));
  stubServers = [pages, model];
  endpoint = `http://127.0.0.1:${model.address().port}`;
  sites = [`http://127.0.0.1:${pages.address().port}/`];
}

// --- Timeline: captions and frames -----------------------------------------
const t0 = Date.now();
const now = () => Date.now() - t0;
const captions = []; // { at, title, sub, speed }
const caption = (title, sub = '', speed = 1) => {
  captions.push({ at: now(), title, sub, speed });
  console.log(`[${(now() / 1000).toFixed(1)}s] ${title}${sub ? ` - ${sub}` : ''}`);
};
const frames = { page: [], panel: [] };
let frameN = 0;
async function screencast(cdp, key, size) {
  cdp.on('Page.screencastFrame', async ({ data, sessionId }) => {
    const file = `${key}-${String(frameN++).padStart(6, '0')}.png`;
    writeFileSync(join(work, file), Buffer.from(data, 'base64'));
    frames[key].push({ at: now(), file });
    cdp.send('Page.screencastFrameAck', { sessionId }).catch(() => {});
  });
  await cdp.send('Page.startScreencast', { format: 'png', maxWidth: size.width, maxHeight: size.height, everyNthFrame: 1 });
}

// --- The browser with the extension -----------------------------------------
const context = await chromium.launchPersistentContext(join(work, 'profile'), {
  headless: !args.headed,
  channel: 'chromium',
  viewport: PAGE,
  args: [`--disable-extensions-except=${root}`, `--load-extension=${root}`]
});
let [worker] = context.serviceWorkers();
if (!worker) worker = await context.waitForEvent('serviceworker');
const extId = new URL(worker.url()).host;

// The pointer dot, drawn above everything (recording only).
await context.addInitScript(() => {
  const draw = () => {
    if (!document.documentElement || document.getElementById('__demo_cursor')) return;
    const d = document.createElement('div');
    d.id = '__demo_cursor';
    d.setAttribute('aria-hidden', 'true');
    d.style.cssText = 'position:fixed;left:-50px;top:-50px;width:18px;height:18px;margin:-9px 0 0 -9px;border-radius:50%;' +
      'background:rgba(255,80,40,.55);border:2px solid #fff;box-shadow:0 0 0 1px rgba(0,0,0,.35);pointer-events:none;z-index:2147483647;transition:transform .1s';
    document.documentElement.appendChild(d);
    addEventListener('mousemove', (e) => { d.style.left = e.clientX + 'px'; d.style.top = e.clientY + 'px'; }, true);
    addEventListener('mousedown', () => (d.style.transform = 'scale(.6)'), true);
    addEventListener('mouseup', () => (d.style.transform = ''), true);
  };
  if (document.readyState === 'loading') addEventListener('DOMContentLoaded', draw); else draw();
});

const page = await context.newPage();
await page.goto('about:blank');
const pageCdp = await context.newCDPSession(page);
const [{ id: tabId }] = await worker.evaluate(() => chrome.tabs.query({ active: true, lastFocusedWindow: true }));
// The panel gets its own window: two tabs in one headless window share a
// surface, and the page's screencast then shrinks to the panel's size.
const [panel] = await Promise.all([
  context.waitForEvent('page'),
  pageCdp.send('Target.createTarget', { url: 'about:blank', newWindow: true, width: PANEL.width, height: PANEL.height })
]);
await panel.setViewportSize(PANEL);
const panelUrl = `chrome-extension://${extId}/sidepanel/sidepanel.html?tab=${tabId}`;
await panel.goto(panelUrl);
const panelCdp = await context.newCDPSession(panel);
// Both tabs must keep painting while not in front.
for (const c of [pageCdp, panelCdp]) await c.send('Emulation.setFocusEmulationEnabled', { enabled: true }).catch(() => {});

// Settings: the model scorer at the default threshold, and the demo lens.
await worker.evaluate((s) => chrome.storage.local.set({ settings: s }), {
  threshold: 0.65, scorer: 'model', hoverInfo: true, animate: true, paused: false,
  model: { api: 'systemone', endpoint, model: '', concurrency: Number(args.concurrency) }
});
{
  const base = JSON.parse(readFileSync(args.lens ?? join(root, 'lenses/sample-lens.json'), 'utf8'));
  if (!args.lens) {
    base.metadata.name = 'Demo lens';
    base.metadata.description = 'Cybersecurity and open source first; no celebrity gossip, Trump coverage, or ads.';
    base.interpretation.priorities = DEMO_PRIORITIES;
    base.domains = [];
  }
  const r = await panel.evaluate((manifest) => chrome.runtime.sendMessage({ type: 'commit-edit', manifest }), base);
  console.log(`lens: ${r?.lensVersion ? `saved as ${r.lensVersion}` : JSON.stringify(r)}`);
}

await screencast(pageCdp, 'page', PAGE);
await screencast(panelCdp, 'panel', PANEL);

// --- Helpers ------------------------------------------------------------------
const pause = (ms) => page.waitForTimeout(ms);
const tab = async (name) => { await glide(panel, `.tabs button:text-is("${name}")`); await panel.click(`.tabs button:text-is("${name}")`); await pause(900); };
const pointer = new Map();
async function glideTo(p, x, y, steps = 18) {
  await p.mouse.move(x, y, { steps });
  pointer.set(p, { x, y });
}
async function glide(p, selector) {
  const box = await p.locator(selector).first().boundingBox();
  if (box) await glideTo(p, box.x + box.width / 2, box.y + box.height / 2);
}
async function click(p, selector) { await glide(p, selector); await pause(250); await p.click(selector); }
async function settle(timeout = 150000) {
  // Scoring starts a moment after load and arrives in waves, so "idle" right
  // after a navigation means nothing. Wait for scoring to have begun (or a
  // grace period to pass), then for several idle checks in a row.
  const start = Date.now();
  await page.waitForSelector('[data-lpz-id]', { state: 'attached', timeout: 30000 }).catch(() => {});
  let began = false, idle = 0;
  while (Date.now() - start < timeout) {
    const busy = await page.evaluate(() => !!document.querySelector('[data-lpz-zapping]')).catch(() => true);
    const scoring = await panel.evaluate(() => !document.getElementById('progress').hidden).catch(() => false);
    if (busy || scoring) { began = true; idle = 0; } else idle++;
    if ((began || Date.now() - start > 8000) && idle >= 6) return true;
    await pause(500);
  }
  console.log('  (still scoring; moving on)');
  return false;
}
const hiddenCount = () => page.$$eval('[data-lpz-zapped]', (e) => new Set(e.map((x) => x.getAttribute('data-lpz-id'))).size).catch(() => 0);
async function smoothScroll(dy, ms = 2500) {
  const steps = Math.max(1, Math.round(ms / 50));
  for (let i = 0; i < steps; i++) { await page.mouse.wheel(0, dy / steps); await pause(50); }
}
// Hover the most central kept, scored block on screen, so its popover shows.
async function hoverKept() {
  const pt = await page.evaluate(() => {
    const vh = innerHeight, vw = innerWidth;
    let best = null;
    for (const el of document.querySelectorAll('[data-lpz-id]:not([data-lpz-zapped])')) {
      const r = el.getBoundingClientRect();
      if (r.width < 200 || r.height < 30 || r.top < 80 || r.bottom > vh - 40 || r.left < 0 || r.right > vw) continue;
      const d = Math.abs(r.top + r.height / 2 - vh / 2);
      if (!best || d < best.d) best = { d, x: r.left + Math.min(r.width / 2, 260), y: r.top + Math.min(r.height / 2, 40) };
    }
    return best;
  });
  if (!pt) return false;
  await glideTo(page, pt.x, pt.y, 25);
  await pause(3200);
  await glideTo(page, PAGE.width - 30, 40);
  return true;
}
async function visit(url) {
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 }).catch((e) => console.log(`  load: ${e.message}`));
  await page.bringToFront();
  await panel.goto(panelUrl);
  await glideTo(page, PAGE.width - 30, 40, 1);
}
const host = (u) => new URL(u).host.replace(/^www\./, '');

// --- The demo -------------------------------------------------------------------
caption('LensZap', `Hides page blocks that are off your lens, judged by a local model (${args.stub ? 'stand-in model' : 'Kev-4B via llama-server on 127.0.0.1'})`);
await pause(3500);

for (const [i, url] of sites.entries()) {
  caption(`Open ${host(url)}`, 'Each block near the screen is scored against the lens; a spark circles blocks being scored', 3);
  await visit(url);
  await settle();
  const n = await hiddenCount();
  caption(`${n} block${n === 1 ? '' : 's'} hidden on ${host(url)}`, 'The Ledger lists every hidden block, and Show puts one back');
  await pause(3000);
  await smoothScroll(900, 3000);
  caption('Scrolling scores more blocks as they come near', 'Blocks far off screen are left alone until you get there', 3);
  await settle(60000);
  await pause(1000);

  caption('Hover a block to see why', 'The popover gives the topic scores and the decision');
  if (!(await hoverKept())) await pause(1500);

  if (i === 0) {
    caption('Before shows the page as published', 'Zapped blocks come back with an outline; nodes are never removed');
    await click(panel, '#before');
    await pause(3500);
    await smoothScroll(-500, 1500);
    await pause(1500);
    await click(panel, '#before');
    caption('After: back to the zapped page');
    await pause(2500);
    if (await panel.locator('li.entry button:text-is("Show")').count()) {
      caption('Show restores one block, on this page only');
      await click(panel, 'li.entry button:text-is("Show")');
      await glideTo(panel, PANEL.width - 10, 10);
      await pause(3000);
    }
  }
  await page.evaluate(() => scrollTo({ top: 0, behavior: 'smooth' })).catch(() => {});
  await pause(1200);
}

caption('Interests', 'Sliders weight each topic; the confidence slider re-decides the page live');
await tab('Interests');
const zapSlider = 'input[aria-label^="Zap when"]';
if (await panel.locator(zapSlider).count()) {
  await glide(panel, zapSlider);
  await panel.focus(zapSlider);
  for (let k = 0; k < 15; k++) { await panel.keyboard.press('ArrowRight'); await pause(220); }
  await pause(1500);
  for (let k = 0; k < 15; k++) { await panel.keyboard.press('ArrowLeft'); await pause(120); }
  await pause(1500);
}
caption('Lens', 'The LensPub lens itself: every saved edit is a new, validated, history-free version');
await tab('Lens');
await pause(3000);
caption('Train', 'Mark blocks Keep or Zap; marks hold scores and a label only, never page text');
await tab('Train');
await pause(3000);
caption('Settings', 'Scorer, model endpoint (loopback only), display options');
await tab('Settings');
await pause(2500);

caption('Pause on this site', 'Nothing is hidden or drawn; blocks are still scored, so resuming is instant');
await click(panel, '#body button:text-is("Pause on this site")');
await pause(3500);
await click(panel, '#paused button:text-is("Resume on this site")');
await pause(2500);
caption('Pause everywhere', 'One switch for every site; the toolbar badge shows it');
await click(panel, '#body button:text-is("Pause everywhere")');
await pause(3500);
await click(panel, '#paused button:text-is("Resume everywhere")');
await pause(2500);

caption('Dark mode', 'The panel and the popover follow the system light or dark setting');
await page.emulateMedia({ colorScheme: 'dark' });
await panel.emulateMedia({ colorScheme: 'dark' });
await tab('Ledger');
await pause(1500);
await hoverKept();
await tab('Interests');
await pause(1500);
await page.emulateMedia({ colorScheme: 'light' });
await panel.emulateMedia({ colorScheme: 'light' });
caption('LensZap', 'Local only · hides by style, never by removing anything · every zap listed and restorable');
await pause(4000);
const end = now();

await pageCdp.send('Page.stopScreencast').catch(() => {});
await panelCdp.send('Page.stopScreencast').catch(() => {});
await context.close();
for (const s of stubServers) s.close();
console.log(`captured ${frames.page.length} page and ${frames.panel.length} panel frames over ${(end / 1000).toFixed(0)}s`);

// --- Replay the two streams side by side and record that ------------------------
// Speed per caption segment: long waits on the model play faster, and say so.
const segs = captions.map((c, i) => ({ ...c, until: captions[i + 1]?.at ?? end }));
const timeline = { segs, frames, end, PAGE, PANEL, CAPTION_H };
const stage = `<!doctype html><meta charset="utf-8"><style>
  html,body{margin:0;background:#111;color:#eee;font:16px system-ui,sans-serif;overflow:hidden}
  #row{display:flex;height:${PAGE.height}px}
  #pg{width:${PAGE.width}px;height:${PAGE.height}px;display:block;background:#fff}
  #pn{width:${PANEL.width}px;height:${PANEL.height}px;display:block;box-shadow:inset 2px 0 #333;background:#fff}
  #cap{height:${CAPTION_H}px;padding:12px 22px;box-sizing:border-box;border-top:2px solid #333}
  #card{position:absolute;left:0;top:0;width:100%;height:${PAGE.height}px;display:none;place-content:center;text-align:center;background:#14161a}
  #card b{display:block;font-size:64px;letter-spacing:-1px} #card span{display:block;opacity:.8;font-size:22px;margin-top:14px;max-width:1100px}
  #t{font-weight:650;font-size:22px} #s{opacity:.8;margin-top:4px} #sp{float:right;opacity:.6;font-size:14px}
</style><div id="row"><img id="pg"><img id="pn"></div><div id="card"><b></b><span></span></div><div id="cap"><span id="sp"></span><div id="t"></div><div id="s"></div></div>
<script>
const T = ${JSON.stringify(timeline)};
const last = (list, t) => { let lo = 0, hi = list.length - 1, best = null; while (lo <= hi) { const m = (lo + hi) >> 1; if (list[m].at <= t) { best = list[m]; lo = m + 1; } else hi = m - 1; } return best; };
let shown = {};
const segAt = (t) => t < T.segs[0].at ? T.segs[0] : T.segs.find((s) => t >= s.at && t < s.until) ?? T.segs.at(-1);
const imgs = { page: document.getElementById('pg'), panel: document.getElementById('pn') };
// Draw the frame for capture time t; resolves once both images are decoded.
window.render = (t) => {
  const waits = [];
  for (const k of ['page', 'panel']) {
    const f = last(T.frames[k], t);
    if (f && shown[k] !== f.file) { imgs[k].src = f.file; shown[k] = f.file; waits.push(imgs[k].decode().catch(() => {})); }
  }
  const seg = segAt(t);
  if (seg) {
    document.getElementById('t').textContent = seg.title;
    document.getElementById('s').textContent = seg.sub;
    const card = document.getElementById('card'), isCard = seg === T.segs[0] || seg === T.segs.at(-1);
    card.style.display = isCard ? 'grid' : 'none';
    if (isCard) { card.firstChild.textContent = seg.title; card.lastChild.textContent = seg.sub; }
    document.getElementById('sp').textContent = seg.speed > 1 ? 'model scoring, sped up ' + seg.speed + 'x' : '';
  }
  return Promise.all(waits);
};
// Output time → capture time: each caption segment plays at its own speed.
window.outputTimes = (fps) => {
  const out = [];
  let t = 0;
  while (t < T.end) { out.push(t); t += (1000 / fps) * (segAt(t)?.speed ?? 1); }
  return out;
};
window.play = () => new Promise((done) => {
  let t = 0, prev = performance.now();
  const tick = (wall) => {
    t += (wall - prev) * (segAt(t)?.speed ?? 1); prev = wall;
    window.render(t);
    if (t >= T.end) return done();
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
});
</script>`;
writeFileSync(join(work, 'stage.html'), stage);
const stageServer = createServer((req, res) => {
  const p = join(work, decodeURIComponent(new URL(req.url, 'http://x').pathname));
  if (!p.startsWith(work) || !existsSync(p)) { res.writeHead(404); return res.end(); }
  res.writeHead(200, { 'content-type': p.endsWith('.html') ? 'text/html' : 'image/png' });
  res.end(readFileSync(p));
}).listen(0, '127.0.0.1');
await new Promise((r) => stageServer.once('listening', r));

const size = { width: PAGE.width + PANEL.width, height: PAGE.height + CAPTION_H };
const hasFfmpeg = spawnSync('ffmpeg', ['-version']).status === 0;
const browser = await chromium.launch();
const stageUrl = `http://127.0.0.1:${stageServer.address().port}/stage.html`;
if (hasFfmpeg) {
  // Frame by frame: draw each output frame, screenshot it losslessly, and
  // pipe it to x264. Slower than real time, but sharp at full 1920x1080.
  const FPS = 30;
  const mp4 = outFile.replace(/\.(webm|mp4)$/, '') + '.mp4';
  const stagePage = await (await browser.newContext({ viewport: size, deviceScaleFactor: 1 })).newPage();
  await stagePage.goto(stageUrl);
  const times = await stagePage.evaluate((fps) => window.outputTimes(fps), FPS);
  const ff = spawn('ffmpeg', ['-y', '-loglevel', 'error', '-f', 'image2pipe', '-framerate', String(FPS), '-c:v', 'png', '-i', '-',
    '-c:v', 'libx264', '-preset', 'slow', '-crf', '16', '-tune', 'stillimage', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', mp4], { stdio: ['pipe', 'inherit', 'inherit'] });
  const finished = new Promise((r) => ff.on('close', r));
  let lastShot = null;
  for (const [i, t] of times.entries()) {
    const changed = await stagePage.evaluate(async (t) => { const before = document.body.innerHTML.length + [...document.images].map((x) => x.src).join(); await window.render(t); return before !== document.body.innerHTML.length + [...document.images].map((x) => x.src).join(); }, t);
    if (changed || !lastShot) lastShot = await stagePage.screenshot({ type: 'png' });
    if (!ff.stdin.write(lastShot)) await new Promise((r) => ff.stdin.once('drain', r));
    if (i % (FPS * 10) === 0) console.log(`  encoding ${Math.round((100 * i) / times.length)}%`);
  }
  ff.stdin.end();
  const code = await finished;
  console.log(code === 0 ? `video: ${mp4} (${size.width}x${size.height}, ${(times.length / FPS).toFixed(1)} s)` : `ffmpeg exited ${code}`);
} else {
  // No ffmpeg: Playwright's recorder, in real time. Lower quality (VP8).
  console.log('ffmpeg not found: falling back to Playwright video (lower quality). Install ffmpeg for a sharp 1080p .mp4.');
  const stageCtx = await browser.newContext({ viewport: size, recordVideo: { dir: join(work, 'video'), size } });
  const stagePage = await stageCtx.newPage();
  await stagePage.goto(stageUrl);
  await stagePage.evaluate(async (all) => { await Promise.all(all.map((f) => new Promise((r) => { const i = new Image(); i.onload = i.onerror = r; i.src = f; }))); },
    [...frames.page, ...frames.panel].map((f) => f.file));
  await stagePage.evaluate(() => window.play());
  await stagePage.waitForTimeout(500);
  const video = stagePage.video();
  await stageCtx.close();
  renameSync(await video.path(), outFile);
  console.log(`video: ${outFile}`);
}
await browser.close();
stageServer.close();
