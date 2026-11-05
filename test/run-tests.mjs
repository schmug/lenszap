// SPDX-License-Identifier: Apache-2.0
//
// Node tests for LensZap's pure modules (core/).
// Run:  npm test   (or: node test/run-tests.mjs)
//
// The zapper is not a LensPub engine and is not tested by conformance/. What it
// does claim, as a Manifest Producer, is checked here: every lens it writes
// validates against the LensPub lens schema (upstream/lens-manifest.schema.json) (with Ajv, independently
// of the bundled checker), follows version semantics, and stays history-free.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

import { tokenize, topicMatch, looksLikeEvidence, scoreLexical, LEXICAL_SCORER_ID } from '../core/lexical-scorer.js';
import { offLensConfidence, decide, checkLedger } from '../core/decide.js';
import {
  canonicalize,
  manifestHash,
  bumpVersion,
  weightChangeImpact,
  draftChanges,
  commitDraft,
  commitEdit,
  lensChanges,
  withToolFields,
  validateLens,
  unsupportedFeatures
} from '../core/lens-edit.js';
import {
  isLoopbackEndpoint,
  buildRequest,
  parseResponse,
  batches,
  responseSchema,
  buildSystemOneRequest,
  parseSystemOneResponse,
  scoreWithEndpoint,
  modelScorerId
} from '../core/model-scorer.js';
import { LENS_MANIFEST_SCHEMA } from '../core/lens-manifest.schema.js';
import { evaluate as evalTraining, suggest, toExample, MIN_EXAMPLES } from '../core/train.js';
import { siteRule, groupWithFollowing, scoringOrder, SITE_RULES, splitDecision, hasAdMarker, isAdHost, adSlotScore } from '../core/segment.js';
import { pauseScope, pauseLabel, badgeFor, isPausedOn, pauseTransition } from '../core/pause.js';
import { shouldHold, holdDone, HOLD_MS, HOLD_MAX_MS, PENDING_MAX_MS } from '../core/hold.js';
import vm from 'node:vm';
import {
  HOSTED_PROVIDERS,
  hostedTarget,
  hostedOrigin,
  hostedMissing,
  hostedScorerId,
  effectiveScorer,
  unwrapHosted,
  withRetry,
  originPattern
} from '../core/hosted.js';

import {
  chromeTimeToMs,
  msToChromeTime,
  keepEntry,
  collapseVisits,
  assignTopics,
  kmeans,
  groupPages,
  suggestedWeights,
  lensFromRows,
  normalize,
  project3
} from '../eval/history/lib.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
const read = (p) => readFileSync(root + p, 'utf8');
const sampleLens = JSON.parse(read('lenses/sample-lens.json'));
const sha256 = async (bytes) => createHash('sha256').update(bytes).digest();

const require = createRequire(import.meta.url);
const Ajv2020 = require('ajv/dist/2020').default;
const addFormats = require('ajv-formats');
const ajv = new Ajv2020({ allErrors: true, strict: false });
addFormats(ajv);
const ajvValidateLens = ajv.compile(JSON.parse(read('upstream/lens-manifest.schema.json')));

let passed = 0;
let failed = 0;
async function test(name, fn) {
  try {
    await fn();
    passed++;
  } catch (err) {
    failed++;
    console.error(`FAIL ${name}\n  ${err.message}`);
  }
}

// --- Bundled copies stay in step with their sources ------------------------

// upstream/ holds the files from the pinned LensPub commit (upstream/LENSPUB_COMMIT);
// scripts/check-upstream.mjs compares them with a LensPub checkout.
await test('bundled schema equals upstream/lens-manifest.schema.json', () => {
  assert.deepEqual(LENS_MANIFEST_SCHEMA, JSON.parse(read('upstream/lens-manifest.schema.json')));
});

await test('schema-check.js equals upstream/schema-check.js below its header', () => {
  const body = (s) => s.slice(s.indexOf('// A dependency-free checker'));
  assert.equal(body(read('core/schema-check.js')), body(read('upstream/schema-check.js')));
});

await test('sample lens validates (Ajv and bundled checker)', () => {
  assert.ok(ajvValidateLens(sampleLens), JSON.stringify(ajvValidateLens.errors));
  assert.deepEqual(validateLens(sampleLens), []);
});

// --- Lexical scorer ---------------------------------------------------------

await test('tokenize lowercases and strips simple plurals', () => {
  assert.deepEqual(tokenize('Schools, Attacks & AI! Glass'), ['school', 'attack', 'ai', 'glass']);
});

await test('topicMatch: phrase 1, partial scaled, none 0', () => {
  assert.equal(topicMatch(tokenize('A ransomware attack hit school cybersecurity teams'), 'school cybersecurity'), 1);
  assert.equal(topicMatch(tokenize('cybersecurity at the hospital'), 'school cybersecurity'), 0.3);
  assert.equal(topicMatch(tokenize('the football final'), 'school cybersecurity'), 0);
  assert.equal(topicMatch(tokenize('anything'), 'of the'), 0);
});

await test('evidence heuristic catches corrections and primary sources', () => {
  assert.ok(looksLikeEvidence('Correction: an earlier version misstated the date.'));
  assert.ok(looksLikeEvidence("Editor's note: this story was updated."));
  assert.ok(!looksLikeEvidence('The match ended in a draw.'));
  // Found on real pages by the eval: each of these was hidden before.
  assert.ok(looksLikeEvidence('[Update: Oct. 10, 9:58 a.m. ET: A spokesperson said he was not a founder].'));
  assert.ok(looksLikeEvidence('Federal court records show that on October 8 he was arrested.'));
  assert.ok(looksLikeEvidence('On October 8, the U.K. issued sanctions (PDF) against the platform.'));
  assert.ok(looksLikeEvidence('A sentencing memo filed Sept. 19 by federal prosecutors notes that...'));
  assert.ok(!looksLikeEvidence('Software update brings a new lock screen.'), 'a bare "update" is not evidence');
});

await test('scoreLexical returns one score per block and topic', () => {
  const out = scoreLexical([{ id: 'b1', text: 'Data privacy rules' }], ['data privacy', 'local-first software']);
  assert.deepEqual(out, [{ id: 'b1', matches: { 'data privacy': 1, 'local-first software': 0 }, evidence: false }]);
});

// --- Decision ---------------------------------------------------------------

const priorities = [
  { topic: 'school cybersecurity', weight: 0.8 },
  { topic: 'data privacy', weight: 0.6 },
  { topic: 'celebrity gossip', weight: -0.5 }
];

await test('offLens: unrelated block is fully off-lens', () => {
  assert.equal(offLensConfidence({}, priorities).offLens, 1);
});

await test('offLens: perfect match scaled by weight', () => {
  const r = offLensConfidence({ 'school cybersecurity': 1 }, priorities);
  assert.equal(r.offLens, 0.2);
  assert.equal(r.best.topic, 'school cybersecurity');
});

await test('offLens: a negatively weighted match can dominate', () => {
  const r = offLensConfidence({ 'celebrity gossip': 1, 'data privacy': 1 }, priorities);
  assert.equal(r.offLens, 0.5);
  assert.equal(r.against.topic, 'celebrity gossip');
});

await test('offLens: with no positive interests, only negatives zap', () => {
  const neg = [{ topic: 'celebrity gossip', weight: -0.9 }];
  assert.equal(offLensConfidence({}, neg).offLens, 0);
  assert.equal(offLensConfidence({ 'celebrity gossip': 1 }, neg).offLens, 0.9);
});

await test('decide: threshold, exemptions, and traces', () => {
  const scores = [
    { id: 'on', matches: { 'school cybersecurity': 1 } },
    { id: 'off', matches: {} },
    { id: 'fix', matches: {}, evidence: true },
    { id: 'back', matches: {} },
    { id: 'form', matches: {} },
    { id: 'quiet', matches: {}, unscored: true }
  ];
  const out = decide({
    scores,
    priorities,
    threshold: 0.8,
    scorer: LEXICAL_SCORER_ID,
    restored: new Set(['back']),
    exempt: new Map([['form', 'structural']])
  });
  const by = Object.fromEntries(out.map((d) => [d.id, d]));
  assert.equal(by.on.zap, false);
  assert.equal(by.off.zap, true);
  assert.equal(by.fix.exempt, 'evidence');
  assert.equal(by.back.exempt, 'restored');
  assert.equal(by.form.exempt, 'structural');
  assert.equal(by.quiet.exempt, 'unscored');
  for (const d of out) {
    assert.ok(d.trace.includes(LEXICAL_SCORER_ID), `trace for ${d.id} names the scorer`);
    if (d.exempt) assert.equal(d.zap, false);
  }
});

await test('decide: rejects a threshold outside (0, 1]', () => {
  assert.throws(() => decide({ scores: [], priorities, threshold: 0, scorer: 'x' }), RangeError);
});

await test('checkLedger: detects unlisted and phantom zaps', () => {
  assert.deepEqual(checkLedger(['a', 'b'], ['b', 'a']), { ok: true, unlisted: [], phantom: [] });
  assert.deepEqual(checkLedger(['a', 'c'], ['a', 'b']), { ok: false, unlisted: ['c'], phantom: ['b'] });
});

// --- Pause: browser-wide and per site ---------------------------------------

await test('pause: browser-wide and per-site pauses are independent', () => {
  assert.equal(pauseScope({}, {}), null);
  assert.equal(pauseScope({ paused: true }, {}), 'everywhere');
  assert.equal(pauseScope({}, { paused: true }), 'site');
  assert.equal(pauseScope({ paused: true }, { paused: true }), 'both');
  assert.equal(pauseScope({ paused: false }, undefined), null);
  assert.equal(pauseLabel('everywhere'), 'Paused everywhere');
  assert.equal(pauseLabel(null), '');
});

// The cases shouldHold() and content/hold-start.js must agree on.
const HOLD_CASES = [
  [{}, undefined, false, 'off by default'],
  [{ holdFirstScreen: true, scorer: 'model' }, undefined, true, 'on'],
  [{ holdFirstScreen: true }, { threshold: 0.7 }, true, 'on, word scorer, a site with its own threshold'],
  [{ holdFirstScreen: true, scorer: 'model', paused: true }, undefined, false, 'paused everywhere'],
  [{ holdFirstScreen: true, scorer: 'model' }, { paused: true }, false, 'paused on this site'],
  [{ holdFirstScreen: true, scorer: 'hosted' }, { noHosted: true }, false, 'kept off the hosted model: scored by nothing'],
  [{ holdFirstScreen: true, scorer: 'model' }, { noHosted: true }, true, 'noHosted only matters with the hosted scorer']
];

await test('hold: only when opted in, nothing is paused, and the site is scored', () => {
  for (const [settings, site, want, why] of HOLD_CASES) assert.equal(shouldHold(settings, site), want, why);
});

await test('hold: content/hold-start.js marks the page exactly when shouldHold() says', async () => {
  const code = readFileSync(new URL('../content/hold-start.js', import.meta.url), 'utf8');
  for (const [settings, site, want, why] of HOLD_CASES) {
    const attrs = new Set();
    const html = { hasAttribute: (n) => attrs.has(n), setAttribute: (n) => attrs.add(n) };
    const ctx = {
      location: { hostname: 'a.example' },
      document: { documentElement: html, readyState: 'loading' },
      chrome: { storage: { local: { get: async () => ({ settings, sites: site ? { 'a.example': site } : {} }) } } }
    };
    ctx.window = ctx;
    ctx.window.top = ctx;
    vm.runInNewContext(code, ctx);
    await new Promise((r) => setImmediate(r));
    assert.equal(attrs.has('data-lpz-hold'), want, why);
  }
});

await test('hold: lifted once no first-screen block waits for a score', () => {
  const waiting = new Set(['b2']);
  assert.equal(holdDone([], () => true), true, 'nothing on the first screen');
  assert.equal(holdDone(['b1', 'b2'], (id) => waiting.has(id)), false);
  waiting.clear();
  assert.equal(holdDone(['b1', 'b2'], (id) => waiting.has(id)), true);
  const css = readFileSync(new URL('../content/hold.css', import.meta.url), 'utf8');
  assert.match(css, new RegExp(`html\\[data-lpz-hold\\]:not\\(\\[data-lpz-shown\\]\\) \\{\\s*animation: lpz-hold ${HOLD_MAX_MS / 1000}s`), 'the page ceiling matches HOLD_MAX_MS');
  assert.match(css, new RegExp(`\\[data-lpz-pending\\] \\{\\s*animation: lpz-hold ${PENDING_MAX_MS / 1000}s`), 'the block ceiling matches PENDING_MAX_MS');
  assert.ok(HOLD_MS < HOLD_MAX_MS, 'the script gives up well before the stylesheet does');
});

await test('pause: either pause stops a site; each site pauses on its own', () => {
  assert.equal(isPausedOn({}, {}, 'a.example'), false);
  assert.equal(isPausedOn({ paused: true }, {}, 'a.example'), true, 'paused everywhere');
  assert.equal(isPausedOn({}, { 'a.example': { paused: true } }, 'a.example'), true, 'paused on this site');
  assert.equal(isPausedOn({}, { 'a.example': { paused: true } }, 'b.example'), false, 'another site is not paused');
  assert.equal(isPausedOn({ paused: false }, undefined, 'a.example'), false);
});

await test('pause: a page stops on pause and starts again on resume, and only then', () => {
  assert.equal(pauseTransition(false, true), 'pause');
  assert.equal(pauseTransition(true, false), 'resume');
  assert.equal(pauseTransition(true, true), null, 'switching from a site pause to a browser-wide one is still paused');
  assert.equal(pauseTransition(false, false), null);
});

await test('pause: the toolbar badge says paused, and why, instead of a count', () => {
  assert.deepEqual(badgeFor({ zapped: [1, 2, 3] }).text, '3');
  assert.equal(badgeFor({ zapped: [] }).text, '');
  const all = badgeFor({ paused: true, pausedBy: 'everywhere', zapped: [] });
  assert.equal(all.text, '‖');
  assert.match(all.title, /paused everywhere/);
  assert.match(badgeFor({ paused: true, pausedBy: 'site', zapped: [] }).title, /paused on this site/);
  assert.notEqual(all.color, badgeFor({ zapped: [1] }).color, 'paused is not drawn in the zap colour');
  assert.equal(badgeFor(null, true).text, '‖', 'pages the zapper cannot run on still show a browser-wide pause');
  assert.equal(badgeFor(null, false).text, '');
});

// --- Lens editing (Manifest Producer duties) --------------------------------

await test('canonicalize: sorted keys, no whitespace, RFC 8785 numbers', () => {
  assert.equal(canonicalize({ b: [1, 'x', null], a: { d: true, c: 1e21 } }), '{"a":{"c":1e+21,"d":true},"b":[1,"x",null]}');
  assert.equal(canonicalize({ x: 0.1, y: -0 }), '{"x":0.1,"y":0}');
});

await test('manifestHash ignores key order and proof', async () => {
  const a = await manifestHash({ x: 1, y: 2, proof: { p: 1 } }, sha256);
  const b = await manifestHash({ y: 2, x: 1 }, sha256);
  assert.equal(a, b);
  assert.match(a, /^[0-9a-f]{64}$/);
});

await test('impact classes and version bumps follow the Adaptation Model', () => {
  assert.equal(weightChangeImpact(0.6, 0.8), 'minor');
  assert.equal(weightChangeImpact(0.6, 0.81), 'major');
  assert.equal(bumpVersion('1.4.2', 'minor'), '1.5.0');
  assert.equal(bumpVersion('1.4.2', 'major'), '2.0.0');
});

await test('draftChanges ignores unchanged and unknown topics', () => {
  const changes = draftChanges(sampleLens, { 'data privacy': 0.6, 'celebrity gossip': -0.7, 'not a topic': 1 });
  assert.deepEqual(changes, [{ topic: 'celebrity gossip', from: -0.5, to: -0.7, impact: 'minor' }]);
});

await test('commitDraft: no change returns null', async () => {
  assert.equal(await commitDraft(sampleLens, { 'data privacy': 0.6 }, { sha256 }), null);
});

await test('commitDraft: minor edit bumps MINOR, records history, validates', async () => {
  const now = new Date('2026-11-01T15:42:17Z');
  const r = await commitDraft(sampleLens, { 'data privacy': 0.75 }, { sha256, now });
  assert.equal(r.impact, 'minor');
  assert.equal(r.manifest.metadata.lensVersion, '1.5.0');
  assert.equal(r.manifest.metadata.modified, '2026-11-01T00:00:00Z');
  const last = r.manifest.versionHistory.at(-1);
  assert.deepEqual(Object.keys(last).sort(), ['hash', 'lensVersion']);
  assert.equal(last.lensVersion, '1.4.2');
  assert.equal(last.hash, await manifestHash(sampleLens, sha256));
  assert.ok(ajvValidateLens(r.manifest), JSON.stringify(ajvValidateLens.errors));
  assert.equal(sampleLens.metadata.lensVersion, '1.4.2', 'input not mutated');
});

await test('commitDraft: large edit bumps MAJOR; proof and publisher dropped', async () => {
  const signed = structuredClone(sampleLens);
  signed.metadata.publisher = { id: 'did:web:avery.example' };
  signed.proof = {
    type: 'DataIntegrityProof',
    cryptosuite: 'eddsa-jcs-2022',
    created: '2026-07-01T18:40:00Z',
    verificationMethod: 'did:web:avery.example#key-1',
    proofPurpose: 'assertionMethod',
    proofValue: 'z3FXQ'
  };
  assert.ok(ajvValidateLens(signed), JSON.stringify(ajvValidateLens.errors));
  const r = await commitDraft(signed, { 'local-first software': 0.2 }, { sha256 });
  assert.equal(r.impact, 'major');
  assert.equal(r.manifest.metadata.lensVersion, '2.0.0');
  assert.deepEqual(r.dropped.sort(), ['metadata.publisher', 'proof']);
  assert.ok(ajvValidateLens(r.manifest), JSON.stringify(ajvValidateLens.errors));
});

await test('commitDraft writes nothing about pages: only weights, version, history, modified change', async () => {
  const r = await commitDraft(sampleLens, { 'data privacy': 0.5 }, { sha256 });
  const strip = (m) => {
    const c = structuredClone(m);
    delete c.versionHistory;
    delete c.metadata.lensVersion;
    delete c.metadata.modified;
    c.interpretation.priorities.forEach((p) => delete p.weight);
    return canonicalize(c);
  };
  assert.equal(strip(r.manifest), strip(sampleLens));
});

await test('unsupportedFeatures lists what the zapper reads but ignores', () => {
  const list = unsupportedFeatures(sampleLens);
  assert.ok(list.some((s) => s.startsWith('Domain Scope')));
  assert.ok(list.includes('source trust and distrust'));
});

// --- Model scorer (request building and parsing only) -----------------------

await test('isLoopbackEndpoint allows only this machine', () => {
  for (const ok of ['http://localhost:11434', 'http://127.0.0.1:8080/', 'http://[::1]:1234', 'https://localhost']) {
    assert.ok(isLoopbackEndpoint(ok), ok);
  }
  for (const bad of ['https://api.example.com', 'http://192.168.1.5:11434', 'http://localhost.evil.example', 'file:///x', 'nonsense']) {
    assert.ok(!isLoopbackEndpoint(bad), bad);
  }
});

await test('buildRequest refuses a remote endpoint', () => {
  assert.throws(() => buildRequest({ api: 'ollama', endpoint: 'https://api.example.com', model: 'm' }, [], []), /this machine/);
});

await test('buildRequest: ollama and openai shapes', () => {
  const blocks = [{ id: 'b1', text: 'x'.repeat(2000) }];
  const o = buildRequest({ api: 'ollama', endpoint: 'http://localhost:11434/', model: 'qwen3:4b' }, blocks, ['t']);
  assert.equal(o.url, 'http://localhost:11434/api/chat');
  const ob = JSON.parse(o.init.body);
  assert.deepEqual(ob.format, responseSchema(['t']));
  assert.equal(JSON.parse(ob.messages[1].content).passages[0].text.length, 600);
  const a = buildRequest({ api: 'openai', endpoint: 'http://127.0.0.1:8080', model: 'clef-flash' }, blocks, ['t']);
  assert.equal(a.url, 'http://127.0.0.1:8080/v1/chat/completions');
  assert.equal(JSON.parse(a.init.body).response_format.type, 'json_schema');
});

await test('parseResponse: fenced JSON, clamping, and unscored gaps', () => {
  const content = '```json\n{"results":[{"id":"b1","matches":{"t":1.4},"evidence":true}]}\n```';
  const out = parseResponse('openai', { choices: [{ message: { content } }] }, [{ id: 'b1' }, { id: 'b2' }], ['t']);
  assert.deepEqual(out[0], { id: 'b1', matches: { t: 1 }, evidence: true });
  assert.equal(out[1].unscored, true);
  const garbage = parseResponse('ollama', { message: { content: 'not json' } }, [{ id: 'b1' }], ['t']);
  assert.equal(garbage[0].unscored, true);
});

await test('an unscored block is never zapped', () => {
  const [d] = decide({ scores: [{ id: 'b', matches: {}, unscored: true }], priorities, threshold: 0.5, scorer: 'model' });
  assert.equal(d.zap, false);
});

await test('batches splits evenly', () => {
  assert.deepEqual(batches([1, 2, 3, 4, 5], 2), [[1, 2], [3, 4], [5]]);
});

// --- Decision models (llama-server /v1/systemone) ---------------------------

const topicsT = ['school cybersecurity', 'data privacy'];

await test('buildSystemOneRequest: one noul question per topic plus evidence', () => {
  const { url, init } = buildSystemOneRequest({ endpoint: 'http://127.0.0.1:8080/' }, { id: 'b1', text: 'x'.repeat(3000) }, topicsT);
  assert.equal(url, 'http://127.0.0.1:8080/v1/systemone');
  const body = JSON.parse(init.body);
  assert.deepEqual(Object.keys(body.questions), ['t0', 't1', 'evidence']);
  assert.equal(body.questions.t0.type, 'noul');
  assert.match(body.questions.t1.instructions, /data privacy/);
  assert.ok(body.state.length < 1600, 'state is capped');
  assert.ok(!('model' in body), 'model omitted when empty');
  const withModel = JSON.parse(buildSystemOneRequest({ endpoint: 'http://localhost:8080', model: 'clef-flash' }, { id: 'b', text: 't' }, topicsT).init.body);
  assert.equal(withModel.model, 'clef-flash');
  assert.throws(() => buildSystemOneRequest({ endpoint: 'https://api.example.com' }, { id: 'b', text: 't' }, topicsT), /this machine/);
});

await test('parseSystemOneResponse: noul probabilities become matches', () => {
  const json = { answers: { t0: { type: 'noul', noul: 0.91 }, t1: { type: 'noul', noul: 1.7 }, evidence: { type: 'noul', noul: 0.8 } } };
  assert.deepEqual(parseSystemOneResponse(json, { id: 'b1' }, topicsT), {
    id: 'b1',
    matches: { 'school cybersecurity': 0.91, 'data privacy': 1 },
    evidence: true
  });
  const partial = parseSystemOneResponse({ answers: { t0: { noul: 0.2 } } }, { id: 'b2' }, topicsT);
  assert.deepEqual(partial.matches, { 'school cybersecurity': 0.2, 'data privacy': 0 });
  assert.equal(partial.unscored, undefined);
  assert.equal(parseSystemOneResponse({ error: 'x' }, { id: 'b3' }, topicsT).unscored, true);
});

await test('scoreWithEndpoint: systemone runs one request per block, in order, with concurrency', async () => {
  let inFlight = 0;
  let peak = 0;
  const calls = [];
  const fakeFetch = async (url, init) => {
    inFlight++;
    peak = Math.max(peak, inFlight);
    const body = JSON.parse(init.body);
    calls.push(url);
    await new Promise((r) => setTimeout(r, 5));
    inFlight--;
    const on = body.state.includes('ransomware') ? 0.9 : 0.05;
    return { ok: true, json: async () => ({ answers: { t0: { noul: on }, t1: { noul: 0 }, evidence: { noul: 0 } } }) };
  };
  const blocks = [
    { id: 'a', text: 'ransomware hit the district' },
    { id: 'b', text: 'football final' },
    { id: 'c', text: 'ransomware again' },
    { id: 'd', text: 'weather' },
    { id: 'e', text: 'bake sale' }
  ];
  const timings = [];
  const out = await scoreWithEndpoint({ api: 'systemone', endpoint: 'http://127.0.0.1:8080' }, blocks, topicsT, fakeFetch, {
    concurrency: 2,
    onTiming: (id) => timings.push(id)
  });
  assert.deepEqual(out.map((s) => s.id), ['a', 'b', 'c', 'd', 'e']);
  assert.deepEqual(out.map((s) => s.matches['school cybersecurity']), [0.9, 0.05, 0.9, 0.05, 0.05]);
  assert.equal(calls.length, 5);
  assert.equal(peak, 2);
  assert.equal(timings.length, 5);
});

await test('scoreWithEndpoint: an abort (a pause) cancels requests in flight and sends no more', async () => {
  const ctl = new AbortController();
  let calls = 0;
  let sawSignal = 0;
  const fakeFetch = (url, init) => {
    calls++;
    if (init.signal === ctl.signal) sawSignal++;
    if (calls === 2) ctl.abort(new Error('paused'));
    return new Promise((resolve, reject) => {
      if (init.signal.aborted) return reject(init.signal.reason);
      init.signal.addEventListener('abort', () => reject(init.signal.reason));
      setTimeout(() => resolve({ ok: true, json: async () => ({ answers: {} }) }), 50);
    });
  };
  const blocks = Array.from({ length: 10 }, (_, i) => ({ id: `b${i}`, text: `block ${i}` }));
  await assert.rejects(
    scoreWithEndpoint({ api: 'systemone', endpoint: 'http://127.0.0.1:8080' }, blocks, topicsT, fakeFetch, { concurrency: 2, signal: ctl.signal }),
    /paused/
  );
  assert.equal(calls, 2, 'no request is sent after the abort');
  assert.equal(sawSignal, 2, 'every request carries the signal');
  // Batched APIs stop too.
  const ctl2 = new AbortController();
  ctl2.abort(new Error('paused'));
  let sent = 0;
  await assert.rejects(
    scoreWithEndpoint({ api: 'openai', endpoint: 'http://127.0.0.1:8080' }, blocks, topicsT, async () => { sent++; }, { signal: ctl2.signal }),
    /paused/
  );
  assert.equal(sent, 0, 'an already-aborted call sends nothing');
});

await test('scoreWithEndpoint: the word-level evidence guard backs up the model', async () => {
  const fakeFetch = async () => ({ ok: true, json: async () => ({ answers: { t0: { noul: 0 }, t1: { noul: 0 }, evidence: { noul: 0.01 } } }) });
  const [r] = await scoreWithEndpoint(
    { api: 'systemone', endpoint: 'http://127.0.0.1:8080' },
    [{ id: 'c', text: 'Correction: the meeting is Tuesday.' }],
    topicsT,
    fakeFetch
  );
  assert.equal(r.evidence, true);
});

await test('scoreWithEndpoint: an HTTP error is reported, not swallowed', async () => {
  const fakeFetch = async () => ({ ok: false, status: 501, text: async () => 'This model is not a decision model.' });
  await assert.rejects(
    scoreWithEndpoint({ api: 'systemone', endpoint: 'http://127.0.0.1:8080' }, [{ id: 'a', text: 't' }], topicsT, fakeFetch),
    /501: This model is not a decision model/
  );
});

await test('modelScorerId names the API, and the model when set', () => {
  assert.equal(modelScorerId({ api: 'systemone', model: '' }), 'model:default@systemone');
  assert.equal(modelScorerId({ api: 'ollama', model: 'qwen3:4b' }), 'model:qwen3:4b@ollama');
});

await test('bench passages are labelled and fictional-lens compatible', () => {
  const { passages } = JSON.parse(read('bench/passages.json'));
  assert.ok(passages.length >= 20);
  for (const p of passages) assert.ok(['keep', 'zap', 'evidence'].includes(p.label), p.id);
  assert.equal(new Set(passages.map((p) => p.id)).size, passages.length);
});

await test('siteRule matches a host and its subdomains, and nothing else', () => {
  assert.equal(siteRule('news.ycombinator.com')?.name, 'Hacker News');
  assert.equal(siteRule('NEWS.ycombinator.com')?.name, 'Hacker News');
  assert.equal(siteRule('ycombinator.com'), null);
  assert.equal(siteRule('evilnews.ycombinator.com.example'), null);
  assert.equal(siteRule('example.com'), null);
  for (const r of SITE_RULES) for (const k of ['name', 'hosts', 'item', 'stop', 'structural']) assert.ok(r[k], `${r.name}.${k}`);
});

await test('groupWithFollowing takes an item and its rows up to the next stop', () => {
  // title, subtext, spacer, title, subtext, morespace, more
  const rows = ['athing', 'sub', 'spacer', 'athing', 'sub', 'morespace', 'more'].map((kind) => ({ kind }));
  rows.forEach((r, i) => (r.nextElementSibling = rows[i + 1] ?? null));
  const stop = (s) => s.kind === 'athing' || s.kind === 'morespace';
  assert.deepEqual(groupWithFollowing(rows[0], stop).map((r) => r.kind), ['athing', 'sub', 'spacer']);
  assert.deepEqual(groupWithFollowing(rows[3], stop).map((r) => r.kind), ['athing', 'sub']);
  assert.deepEqual(groupWithFollowing(rows[6], stop).map((r) => r.kind), ['more']);
});

await test('splitDecision: one titled item stays whole, several stories split, link lines are chrome', () => {
  const base = { chars: 300, letters: 250, leafy: false, containerish: true, headings: 0, storyLinks: 0, links: 0, linkChars: 0, linkLetters: 0, severalChildren: false, hasControls: false };
  // A repo card: one heading, a description and a stats row (several children).
  assert.equal(splitDecision({ ...base, headings: 1, storyLinks: 1, links: 3, linkChars: 30, linkLetters: 20, severalChildren: true }), 'block');
  // A card with no heading: one headline link, a dek, and a byline with a comment count.
  assert.equal(splitDecision({ ...base, headings: 0, storyLinks: 1, links: 3, linkChars: 70, linkLetters: 60, severalChildren: true }), 'block');
  // ...but a long section with one long link and several paragraphs still splits.
  assert.equal(splitDecision({ ...base, chars: 1000, headings: 0, storyLinks: 1, links: 1, linkChars: 40, linkLetters: 35, severalChildren: true }), 'split');
  // A card holding two teasers.
  assert.equal(splitDecision({ ...base, headings: 2, storyLinks: 2, links: 2, linkChars: 80, linkLetters: 70 }), 'split');
  // A "Most read" list: one title heading, many headline links.
  assert.equal(splitDecision({ ...base, headings: 1, storyLinks: 5, links: 5, linkChars: 200, linkLetters: 170 }), 'split');
  // Inside it, a 30-character headline is a block; outside a list of stories it is too short.
  const headline = { ...base, chars: 30, letters: 25, containerish: true, links: 1, linkChars: 30, linkLetters: 25, storyLinks: 1, hasLink: true };
  assert.equal(splitDecision({ ...headline, inStories: true }), 'block');
  assert.equal(splitDecision({ ...headline, inStories: false }), 'skip');
  // A tag line, a category list, a pager: mostly short links.
  assert.equal(splitDecision({ ...base, chars: 62, letters: 45, leafy: true, links: 5, linkChars: 50, linkLetters: 42 }), 'skip');
  // A whole page wrapper that is mostly short links (nav, repo names) is split, never skipped.
  assert.equal(splitDecision({ ...base, chars: 5000, letters: 4000, links: 300, linkChars: 4000, linkLetters: 3500, storyLinks: 0 }), 'split');
  assert.equal(splitDecision({ ...base, chars: 900, letters: 700, links: 40, linkChars: 700, linkLetters: 600, headings: 3, storyLinks: 0 }), 'split');
  // A short sidebar of short links is chrome, even with a title heading.
  assert.equal(splitDecision({ ...base, chars: 400, letters: 330, links: 25, linkChars: 360, linkLetters: 300, headings: 1, storyLinks: 0 }), 'skip');
  // A paragraph with a couple of links stays a block.
  assert.equal(splitDecision({ ...base, leafy: true, links: 2, linkChars: 30, linkLetters: 26 }), 'block');
  // Controls inside: split, so the control is never hidden with the block.
  assert.equal(splitDecision({ ...base, headings: 1, hasControls: true }), 'split');
  // Too long to be one item.
  assert.equal(splitDecision({ ...base, chars: 5000, headings: 1 }), 'split');
});

await test('carryLabels: unchanged keys keep labels, parts of one labelled block inherit, parts of a mixed block do not', async () => {
  const { carryLabels, blockKey } = await import('../eval/lib.mjs');
  const mk = (text) => ({ key: blockKey(text), text });
  const repo = mk('owner / tool A tool for things. TypeScript 120 stars today');
  const multi = mk('Story one about schools. Story two about sports.');
  const para = mk('A paragraph that does not change at all between splits.');
  const old = [repo, multi, para];
  const labels = { [repo.key]: 'keep', [multi.key]: 'mixed', [para.key]: 'zap' };
  const next = [mk('owner / tool A tool for things.'), mk('Story one about schools.'), para, mk('120 stars today')];
  const c = carryLabels(old, labels, next);
  assert.equal(c.labels[para.key], 'zap');
  assert.equal(c.labels[next[0].key], 'keep');
  assert.equal(c.labels[next[1].key], undefined);
  assert.equal(c.labels[next[3].key], undefined, 'a small fragment does not inherit');
  assert.deepEqual([c.kept, c.inherited, c.unlabelled], [1, 1, 2]);
});

await test('hideUnmatched: off by choice, only a "less of this" match zaps', () => {
  const pr = [{ topic: 'cybersecurity', weight: 1 }, { topic: 'trump', weight: -0.95 }];
  const neutral = { id: 'n', matches: { cybersecurity: 0, trump: 0 } };
  const against = { id: 'a', matches: { cybersecurity: 0, trump: 0.9 } };
  const on = { id: 'o', matches: { cybersecurity: 0.9, trump: 0 } };
  const run = (hideUnmatched) => Object.fromEntries(decide({ scores: [neutral, against, on], priorities: pr, threshold: 0.65, scorer: 'x', hideUnmatched }).map((d) => [d.id, d.zap]));
  assert.deepEqual(run(true), { n: true, a: true, o: false });
  assert.deepEqual(run(false), { n: false, a: true, o: false });
  assert.deepEqual(Object.fromEntries(decide({ scores: [neutral], priorities: pr, threshold: 0.65, scorer: 'x' }).map((d) => [d.id, d.zap])), { n: true }, 'decide() alone keeps the original default');
  assert.equal(offLensConfidence(neutral.matches, pr, { hideUnmatched: false }).offLens, 0);
});

await test('eval: neutral labels count as should-go only with hideUnmatched', async () => {
  const { compare, rates } = await import('../eval/metrics.mjs');
  const labels = { a: 'neutral', b: 'zap', c: 'keep' };
  const decisions = [{ key: 'a', zap: true }, { key: 'b', zap: true }, { key: 'c', zap: false }];
  const hide = rates(compare(decisions, labels, { hideUnmatched: true }));
  assert.deepEqual([hide.wrongZapRate, hide.missRate], [0, 0]);
  const keep = rates(compare(decisions, labels, { hideUnmatched: false }));
  assert.equal(keep.wrongZapRate, 0.5, 'a hidden neutral block is a wrong zap when unmatched blocks are kept');
});

await test('ad slots: markers and hosts, zapped only when the lens has a "less of this" about ads', () => {
  for (const t of ['themonic-ad3', 'sidebar_ad', 'widget ad-slot', 'promoted-post', 'ads']) assert.equal(hasAdMarker(t), true, t);
  for (const t of ['load-more', 'shadow', 'header', 'badge', 'download', 'thread']) assert.equal(hasAdMarker(t), false, t);
  assert.equal(isAdHost('googleads.g.doubleclick.net'), true);
  assert.equal(isAdHost('doubleclick.net.example.com'), false);
  const withAds = [{ topic: 'cybersecurity', weight: 1 }, { topic: 'advertisements', weight: -1 }];
  const [d] = decide({ scores: [adSlotScore('a', withAds)], priorities: withAds, threshold: 0.65, scorer: 'x' });
  assert.equal(d.zap, true);
  assert.match(d.trace, /advertisements/);
  const noAds = [{ topic: 'cybersecurity', weight: 1 }];
  const [k] = decide({ scores: [adSlotScore('a', noAds)], priorities: noAds, threshold: 0.65, scorer: 'x' });
  assert.equal(k.zap, false, 'no ad interest in the lens: an ad slot is left alone');
  // An interest that is positive about ads never zaps them.
  const likes = [{ topic: 'advertising industry news', weight: 1 }];
  assert.equal(adSlotScore('a', likes).unscored, true);
});

await test('scoringOrder: on screen top to bottom, then below nearest first, then above', () => {
  const vh = 800;
  const order = scoringOrder(
    [
      { id: 'above-far', top: -2000, bottom: -1800 },
      { id: 'below-far', top: 3000, bottom: 3100 },
      { id: 'visible-2', top: 400, bottom: 500 },
      { id: 'above-near', top: -300, bottom: -100 },
      { id: 'partly-visible', top: -50, bottom: 60 },
      { id: 'below-near', top: 900, bottom: 1000 }
    ],
    vh
  );
  assert.deepEqual(order, ['partly-visible', 'visible-2', 'below-near', 'below-far', 'above-near', 'above-far']);
});

await test('lensChanges classifies edits by the Adaptation Model rules', () => {
  const edit = structuredClone(sampleLens);
  const ps = edit.interpretation.priorities;
  ps.find((p) => p.topic === 'data privacy').weight = 0.7; // minor
  ps.push({ topic: 'open data', weight: 0.4 }); // added, small: minor
  let c = lensChanges(sampleLens, edit);
  assert.deepEqual(c.map((x) => [x.topic, x.op, x.impact]), [['data privacy', 'replace', 'minor'], ['open data', 'add', 'minor']]);
  ps.splice(ps.findIndex((p) => p.topic === 'celebrity gossip'), 1); // removal: major
  ps.push({ topic: 'chess', weight: 0.9 }); // added, large: major
  c = lensChanges(sampleLens, edit);
  assert.ok(c.find((x) => x.topic === 'celebrity gossip' && x.op === 'remove' && x.impact === 'major'));
  assert.ok(c.find((x) => x.topic === 'chess' && x.impact === 'major'));
  const pres = structuredClone(sampleLens);
  pres.interpretation.presentation = { density: 'compact' };
  assert.deepEqual(lensChanges(sampleLens, pres).map((x) => [x.path, x.impact]), [['/interpretation/presentation', 'trivial']]);
  const meta = structuredClone(sampleLens);
  meta.metadata.lensVersion = '9.9.9';
  meta.metadata.modified = '2030-01-01T00:00:00Z';
  assert.deepEqual(lensChanges(sampleLens, meta), [], 'version fields are not the reader\'s edit');
});

await test('commitEdit: a direct edit becomes one valid version; version fields are the tool\'s', async () => {
  assert.equal(await commitEdit(sampleLens, structuredClone(sampleLens), { sha256 }), null);
  const edit = structuredClone(sampleLens);
  edit.interpretation.priorities.push({ topic: 'open data', weight: 0.4 });
  edit.metadata.lensVersion = '42.0.0';
  edit.versionHistory = [];
  const r = await commitEdit(sampleLens, edit, { sha256, now: new Date('2026-11-01T19:40:12Z') });
  assert.equal(r.impact, 'minor');
  assert.equal(r.manifest.metadata.lensVersion, bumpVersion(sampleLens.metadata.lensVersion, 'minor'));
  assert.equal(r.manifest.versionHistory.length, (sampleLens.versionHistory ?? []).length + 1);
  assert.equal(r.manifest.metadata.modified, '2026-11-01T00:00:00Z');
  assert.ok(ajvValidateLens(r.manifest), JSON.stringify(ajvValidateLens.errors));
  const bad = structuredClone(sampleLens);
  bad.interpretation.priorities[0].weight = 3;
  await assert.rejects(commitEdit(sampleLens, bad, { sha256 }), /would not validate/);
  await assert.rejects(commitEdit(sampleLens, [], { sha256 }), /JSON object/);
});

await test('withToolFields: an edit of a lens with no version history validates as it will be saved', () => {
  assert.equal(sampleLens.versionHistory, undefined, 'the sample lens starts without one');
  const edit = structuredClone(sampleLens);
  edit.interpretation.priorities.push({ topic: 'open data', weight: 0.4 });
  const candidate = withToolFields(sampleLens, edit);
  assert.ok(!('versionHistory' in candidate), 'no versionHistory key, not an undefined one');
  assert.deepEqual(validateLens(candidate), []);
  edit.versionHistory = 'junk';
  edit.metadata.lensVersion = '9.9.9';
  assert.deepEqual(validateLens(withToolFields(sampleLens, edit)), [], 'the tool\'s fields override the edit');
});

await test('train: needs a few examples before suggesting', () => {
  const pr = [{ topic: 'a', weight: 0.8 }];
  assert.deepEqual(suggest([{ matches: { a: 1 }, label: 'keep' }], pr, 0.8), { needMore: MIN_EXAMPLES - 1 });
});

await test('train: suggests a lower threshold when the reader marks mild off-lens blocks Zap', () => {
  const pr = [{ topic: 'a', weight: 1 }];
  // offLens = 1 - match. Zap labels at 0.6–0.7 off-lens are missed at 80%.
  const ex = [
    ...[0.95, 0.9, 0.85].map((m) => ({ matches: { a: m }, label: 'keep' })),
    ...[0.4, 0.35, 0.3, 0.1].map((m) => ({ matches: { a: m }, label: 'zap' }))
  ];
  const s = suggest(ex, pr, 0.8);
  assert.equal(s.before.missed, 3);
  assert.equal(s.after.wrong, 0);
  assert.ok(s.threshold <= 0.6 && s.threshold > 0.15, `threshold ${s.threshold}`);
  assert.deepEqual(s.changes, [], 'no weight change needed');
});

await test('train: suggests raising an interest the reader keeps', () => {
  const pr = [{ topic: 'a', weight: 0.9 }, { topic: 'b', weight: 0.2 }];
  // Blocks strongly about b are kept by the reader but zapped at weight 0.2.
  const ex = [
    ...Array.from({ length: 4 }, () => ({ matches: { a: 0, b: 0.95 }, label: 'keep' })),
    ...Array.from({ length: 3 }, () => ({ matches: { a: 0.95, b: 0 }, label: 'keep' })),
    // Mildly about a, and the reader wants them gone: no threshold alone separates these
    // from the b blocks, so only a higher weight for b fixes both.
    ...Array.from({ length: 4 }, () => ({ matches: { a: 0.25, b: 0 }, label: 'zap' }))
  ];
  const s = suggest(ex, pr, 0.8);
  assert.equal(s.before.falseZaps, 4);
  assert.equal(s.after.wrong, 0);
  const b = s.changes.find((c) => c.topic === 'b');
  assert.ok(b && b.to > 0.2, JSON.stringify(s.changes));
  assert.ok(!s.changes.find((c) => c.topic === 'a'), 'leaves the interest that was not the problem');
  assert.equal(s.unmatched, 0);
  const lost = suggest([...ex, { matches: { a: 0, b: 0 }, label: 'keep' }], pr, 0.8);
  assert.equal(lost.unmatched, 1, 'a kept block matching nothing is reported, not fitted');
});

await test('train: toExample keeps numbers only, and skips evidence and unscored blocks', () => {
  const ex = toExample({ id: 'b1', matches: { a: 0.12345, z: 0.9 }, text: 'secret' }, 'zap', ['a', 'b']);
  assert.deepEqual(ex, { matches: { a: 0.123, b: 0 }, label: 'zap' });
  assert.equal(toExample({ matches: { a: 1 }, evidence: true }, 'keep', ['a']), null);
  assert.equal(toExample({ unscored: true }, 'keep', ['a']), null);
  assert.equal(toExample({ matches: { a: 1 } }, 'maybe', ['a']), null);
  assert.deepEqual(evalTraining([ex], [{ topic: 'a', weight: 1 }], 0.8), { falseZaps: 0, missed: 0, wrong: 0, total: 1 });
});

// --- Eval tooling (eval/) -----------------------------------------------------

await test('eval: compare counts wrong zaps, misses, ads, evidence, and bad splits', async () => {
  const { compare, total, rates } = await import('../eval/metrics.mjs');
  const labels = { a: 'keep', b: 'zap', c: 'ad', d: 'evidence', e: 'chrome', f: 'skip', g: 'zap' };
  const c = compare(
    [
      { key: 'a', zap: true }, { key: 'b', zap: true }, { key: 'c', zap: false }, { key: 'd', zap: true },
      { key: 'e', zap: true }, { key: 'f', zap: true }, { key: 'g', zap: false }, { key: 'unlabelled', zap: true }
    ],
    labels
  );
  assert.deepEqual(c.keptHidden, ['a']);
  assert.deepEqual(c.evidenceHidden, ['d']);
  assert.deepEqual(c.zapMissed, ['g']);
  assert.deepEqual(c.adMissed, ['c']);
  assert.equal(c.labelled, 6, 'skip and unlabelled blocks are not counted');
  const r = rates(total([c, c]));
  assert.equal(r.wrongZapRate, 1, 'both blocks that should stay were hidden');
  assert.equal(r.missRate, 2 / 3);
  assert.equal(r.precision, 1 / 3);
  assert.equal(r.splitProblemRate, 1 / 6);
  assert.deepEqual(rates(total([])), { wrongZapRate: null, missRate: null, precision: null, splitProblemRate: null });
});

await test('eval: block keys ignore whitespace, and slugs are file-safe', async () => {
  const { blockKey, slugFor } = await import('../eval/lib.mjs');
  assert.equal(blockKey('a  b\n c'), blockKey('a b c'));
  assert.match(blockKey('x'), /^[0-9a-f]{12}$/);
  assert.equal(slugFor('https://www.bbc.com/news'), 'bbc.com--news');
  assert.match(slugFor('https://ex.com/a/../b?q=<x>'), /^[a-z0-9.-]+$/);
});

await test('eval: the demo labels match the demo captures', async () => {
  const { loadDataset, LABELS } = await import('../eval/lib.mjs');
  const set = loadDataset(fileURLToPath(new URL('../eval/demo', import.meta.url)));
  assert.equal(set.length, 2);
  for (const { slug, page, labels } of set) {
    const keys = new Set(page.blocks.map((b) => b.key));
    for (const [k, v] of Object.entries(labels)) {
      assert.ok(keys.has(k), `${slug}: label for a block that is not captured: ${k}`);
      assert.ok(v in LABELS, `${slug}: unknown label ${v}`);
    }
  }
});

// --- Hosted scorer (bring your own key) ---------------------------------------

await test('hosted: a hosted target is required to opt in; https only', () => {
  // Without hosted: true, a remote URL is still refused.
  assert.throws(() => buildSystemOneRequest({ endpoint: 'https://api.typesafe.ai' }, { id: 'b', text: 't' }, topicsT), /this machine/);
  assert.throws(() => buildSystemOneRequest({ hosted: true, url: 'http://api.example.com/x' }, { id: 'b', text: 't' }, topicsT), /https/);
  assert.throws(() => buildRequest({ hosted: true, api: 'openai', url: 'not a url' }, [{ id: 'b', text: 't' }], topicsT), /https/);
});

await test('hosted: Workers AI target builds the account URL and bearer header', () => {
  const t = hostedTarget({ provider: 'workers-ai', accountId: 'acc 1', model: '' }, 'k123');
  assert.equal(t.url, 'https://api.cloudflare.com/client/v4/accounts/acc%201/ai/run/@cf/cloudflare/clef-flash');
  assert.equal(t.api, 'systemone');
  const { url, init } = buildSystemOneRequest(t, { id: 'b', text: 'passage' }, topicsT);
  assert.equal(url, t.url);
  assert.equal(init.headers.authorization, 'Bearer k123');
  assert.equal(init.headers['content-type'], 'application/json');
  assert.equal(modelScorerId(t), 'hosted:workers-ai/clef-flash');
});

await test('hosted: OpenRouter and custom use chat completions', () => {
  const o = hostedTarget({ provider: 'openrouter', model: 'some/model:free' }, 'k');
  const { url, init } = buildRequest(o, [{ id: 'b', text: 't' }], topicsT);
  assert.equal(url, 'https://openrouter.ai/api/v1/chat/completions');
  assert.equal(JSON.parse(init.body).model, 'some/model:free');
  const c = hostedTarget({ provider: 'custom', endpoint: 'https://llm.example.org/v1/', model: 'm' }, 'k');
  assert.equal(c.url, 'https://llm.example.org/v1/chat/completions');
  assert.equal(hostedOrigin({ provider: 'custom', endpoint: 'https://llm.example.org/v1' }), 'https://llm.example.org/*');
});

await test('hosted: missing fields and keys are named, http endpoints refused', () => {
  assert.deepEqual(hostedMissing({ provider: 'workers-ai', accountId: '' }, ''), ['accountId', 'key']);
  assert.deepEqual(hostedMissing({ provider: 'jev' }, 'k'), []);
  assert.deepEqual(hostedMissing({ provider: 'openrouter', model: '' }, 'k'), ['model']);
  assert.ok(hostedMissing({ provider: 'custom', endpoint: 'http://llm.example.org', model: 'm' }, 'k').includes('endpoint'));
  assert.deepEqual(hostedMissing({ provider: 'nope' }, 'k'), ['provider']);
  assert.throws(() => hostedTarget({ provider: 'jev' }, ''), /needs: key/);
  assert.equal(originPattern('http://x.example'), null);
});

await test('hosted: every provider origin is declared as optional in the manifest', () => {
  const manifest = JSON.parse(readFileSync(new URL('../manifest.json', import.meta.url), 'utf8'));
  for (const p of Object.values(HOSTED_PROVIDERS)) if (p.origin) assert.ok(manifest.optional_host_permissions.includes(p.origin), p.origin);
});

await test('hosted: a site kept off the hosted model is not scored at all', () => {
  assert.equal(effectiveScorer({ scorer: 'hosted' }, { noHosted: true }), 'none');
  assert.equal(effectiveScorer({ scorer: 'hosted' }, {}), 'hosted');
  assert.equal(effectiveScorer({ scorer: 'model' }, { noHosted: true }), 'model');
  assert.equal(effectiveScorer({}, undefined), 'lexical');
  assert.equal(hostedScorerId({ provider: 'jev', model: '' }), 'hosted:jev/jev-1.14.0');
});

await test('hosted: Workers AI {result} wrapper is unwrapped', () => {
  const ans = { answers: { t0: { noul: 0.9 }, t1: { noul: 0.1 }, evidence: { noul: 0.2 } } };
  const out = parseSystemOneResponse({ success: true, result: ans }, { id: 'b' }, ['a', 'b']);
  assert.equal(out.matches.a, 0.9);
  assert.ok(!out.unscored);
  assert.deepEqual(unwrapHosted({ result: ans }), ans);
  assert.deepEqual(unwrapHosted(ans), ans);
});

await test('hosted: withRetry retries 429 and 5xx, then returns', async () => {
  const statuses = [429, 503, 200];
  let calls = 0;
  const waits = [];
  const f = withRetry(async () => ({ status: statuses[calls++], ok: statuses[calls - 1] === 200, headers: { get: () => null } }), { sleep: async (ms) => waits.push(ms) });
  const res = await f('https://x', {});
  assert.equal(res.status, 200);
  assert.equal(calls, 3);
  assert.deepEqual(waits, [1000, 2000]);
  const ctl = new AbortController();
  ctl.abort(new Error('paused'));
  const g = withRetry(async () => ({ status: 429, headers: { get: () => '1' } }), { sleep: async () => {} });
  await assert.rejects(() => g('https://x', { signal: ctl.signal }), /paused/);
});

await test('hosted: scoreWithEndpoint sends to the hosted URL with the key', async () => {
  const t = hostedTarget({ provider: 'jev' }, 'secret');
  const seen = [];
  const fetchFn = async (url, init) => {
    seen.push({ url, auth: init.headers.authorization });
    return { ok: true, json: async () => ({ answers: { t0: { noul: 0.8 }, t1: { noul: 0 }, evidence: { noul: 0 } } }) };
  };
  const out = await scoreWithEndpoint(t, [{ id: 'b1', text: 'hello' }], ['x', 'y'], fetchFn);
  assert.equal(out[0].matches.x, 0.8);
  assert.deepEqual(seen, [{ url: 'https://api.typesafe.ai/v1/systemone', auth: 'Bearer secret' }]);
});

await test('eval: hosted targets need their keys and keep the core scorer loopback-only', async () => {
  const { hostedTarget, hostedFetch, unwrapHosted } = await import('../eval/hosted.mjs');
  assert.throws(() => hostedTarget('jev', {}), /TYPESAFE_API_KEY/);
  assert.throws(() => hostedTarget('workers-ai', { CLOUDFLARE_ACCOUNT_ID: 'a' }), /CLOUDFLARE_API_TOKEN/);
  assert.throws(() => hostedTarget('nope', {}), /Unknown/);
  const jev = hostedTarget('jev', { TYPESAFE_API_KEY: 'k' });
  assert.equal(jev.url, 'https://api.typesafe.ai/v1/systemone');
  assert.equal(jev.model, 'jev-1.14.0');
  const cf = hostedTarget('workers-ai', { CLOUDFLARE_ACCOUNT_ID: 'acct', CLOUDFLARE_API_TOKEN: 't' }, 'clef');
  assert.equal(cf.url, 'https://api.cloudflare.com/client/v4/accounts/acct/ai/run/@cf/cloudflare/clef');
  assert.equal(cf.headers.authorization, 'Bearer t');
  assert.deepEqual(unwrapHosted({ success: true, result: { answers: { t0: { noul: 0.2 } } } }), { answers: { t0: { noul: 0.2 } } });
  assert.deepEqual(unwrapHosted({ answers: {} }), { answers: {} });

  // The request is still built for loopback; hostedFetch redirects it, adds the key, and retries a 429.
  const calls = [];
  let n = 0;
  const fake = async (url, init) => {
    calls.push({ url, init });
    if (n++ === 0) return { ok: false, status: 429, headers: { get: () => null } };
    const body = JSON.parse(init.body);
    const answers = Object.fromEntries(Object.keys(body.questions).map((k) => [k, { noul: k === 't0' ? 0.9 : 0.1 }]));
    return { ok: true, status: 200, json: async () => ({ success: true, result: { answers } }) };
  };
  const f = hostedFetch(cf, { fetchFn: fake, sleep: async () => {} });
  const settings = { api: 'systemone', endpoint: 'http://127.0.0.1:9', model: cf.model };
  const [score] = await scoreWithEndpoint(settings, [{ id: 'b1', text: 'A passage.' }], ['security', 'gossip'], f);
  assert.equal(calls.length, 2, 'retried once after 429');
  assert.equal(calls[1].url, cf.url);
  assert.equal(calls[1].init.headers.authorization, 'Bearer t');
  assert.equal(JSON.parse(calls[1].init.body).model, 'clef');
  assert.equal(score.matches.security, 0.9);
  assert.equal(score.matches.gossip, 0.1);
});

// ---- History-lens spike (eval/history/lib.mjs) ----

await test('history: Chrome times convert both ways past Number range', () => {
  const ms = Date.UTC(2026, 10, 4, 12);
  const t = msToChromeTime(ms);
  assert.equal(typeof t, 'bigint');
  assert.ok(t > BigInt(Number.MAX_SAFE_INTEGER));
  assert.equal(chromeTimeToMs(t), ms);
});

await test('history: drops search results, sign-in flows, this machine, and untitled pages', () => {
  assert.equal(keepEntry('https://krebsonsecurity.com/2026/11/x/', 'A story'), true);
  assert.equal(keepEntry('https://www.google.com/search?q=x', 'x - Google Search'), false);
  assert.equal(keepEntry('https://duckduckgo.com/?q=x', 'x at DuckDuckGo'), false);
  assert.equal(keepEntry('https://accounts.google.com/v3/signin', 'Sign in'), false);
  assert.equal(keepEntry('https://example.com/login', 'Log in'), false);
  assert.equal(keepEntry('http://127.0.0.1:8181/', 'llama'), false);
  assert.equal(keepEntry('chrome://settings', 'Settings'), false);
  assert.equal(keepEntry('https://example.com/', ''), false);
  const long = collapseVisits([{ url: 'https://a.example/', title: 'x'.repeat(5000), visitTime: 0 }]);
  assert.equal(long[0].title.length, 200, 'titles are cut so one page cannot overflow the embedding batch');
});

await test('history: visits collapse to one page per site and title, most visited first', () => {
  const day = 86400000;
  const pages = collapseVisits([
    { url: 'https://a.example/1', title: 'One', visitTime: 10 * day },
    { url: 'https://a.example/1?ref=x', title: 'One ', visitTime: 10 * day + 5 },
    { url: 'https://www.a.example/1', title: 'One', visitTime: 12 * day },
    { url: 'https://b.example/', title: 'Two', visitTime: 11 * day }
  ]);
  assert.equal(pages.length, 2);
  assert.deepEqual(pages[0], { id: 'p0', url: 'https://a.example/1', title: 'One', host: 'a.example', visits: 3, days: [10, 12] });
  assert.equal(pages[1].id, 'p1');
});

const hv = (...xs) => normalize(xs);
await test('history: pages far from every seed topic are left for grouping', () => {
  const topics = [hv(1, 0, 0), hv(0, 1, 0)];
  const pagesV = [hv(1, 0.1, 0), hv(0.1, 1, 0), hv(0.9, 0.2, 0.1), hv(0, 0, 1)];
  const { topic } = assignTopics(pagesV, topics, { unassignedShare: 0.25 });
  assert.deepEqual(topic, [0, 1, 0, -1]);
});

await test('history: k-means is deterministic and separates clear clusters', () => {
  const v = [hv(1, 0, 0), hv(0.9, 0.1, 0), hv(0, 0, 1), hv(0, 0.1, 0.9)];
  const a = kmeans(v, 2, { seed: 7 });
  assert.deepEqual(a, kmeans(v, 2, { seed: 7 }));
  assert.equal(a[0], a[1]);
  assert.equal(a[2], a[3]);
  assert.notEqual(a[0], a[2]);
});

await test('history: groups fold small ones into Everything else and name the rest', () => {
  const pages = Array.from({ length: 12 }, (_, i) => ({ id: `p${i}`, visits: i < 6 ? 3 : 1 }));
  const vecs = pages.map((_, i) => (i < 6 ? hv(1, 0.01 * i, 0) : i < 11 ? hv(0, 0.01 * i, 1) : hv(0, 1, 0)));
  const groups = groupPages(pages, vecs, [{ topic: 'security' }], [hv(1, 0, 0)], { unassignedShare: 0.5, minPages: 3 });
  assert.deepEqual(groups.map((g) => [g.name, g.pages.length]), [['security', 6], ['Unnamed group 1', 6]]);
  const folded = groupPages(pages, vecs, [{ topic: 'security' }], [hv(1, 0, 0)], { unassignedShare: 0.5, minPages: 7 });
  assert.deepEqual(folded.map((g) => [g.name, g.pages.length, g.visits]), [['Everything else', 12, 24]]);
  const w = suggestedWeights(groups);
  assert.equal(w[groups[0].id], 1);
  assert.equal(suggestedWeights(folded).other, 0);
  assert.ok(Object.values(w).every((x) => x >= 0), 'history never suggests a negative weight');
});

await test('history: the lens holds only named, weighted topics and validates', () => {
  const now = new Date('2026-11-04T15:16:17Z');
  const lens = lensFromRows([
    { name: ' cybersecurity ', weight: 1 },
    { name: 'Unnamed group 2', weight: 0.5 },
    { name: 'Everything else', weight: 0.4 },
    { name: 'sports', weight: 0 },
    { name: 'Donald Trump', weight: -0.951 },
    { name: 'CYBERSECURITY', weight: 0.2 }
  ], undefined, { now });
  assert.deepEqual(lens.interpretation.priorities, [{ topic: 'cybersecurity', weight: 1 }, { topic: 'Donald Trump', weight: -0.95 }]);
  assert.equal(lens.metadata.modified, '2026-11-04T00:00:00Z');
  assert.deepEqual(validateLens(lens), []);
  assert.ok(ajvValidateLens(lens), JSON.stringify(ajvValidateLens.errors));
});

await test('history: with a base lens, same-named priorities are replaced and the rest kept', async () => {
  const edited = lensFromRows([{ name: 'data privacy', weight: 0.8 }, { name: 'sports', weight: -0.5 }], sampleLens);
  const topics = edited.interpretation.priorities.map((p) => `${p.topic}:${p.weight}`);
  assert.ok(topics.includes('local-first software:0.9'));
  assert.ok(topics.includes('data privacy:0.8'));
  assert.ok(topics.includes('sports:-0.5'));
  assert.equal(topics.filter((t) => t.startsWith('data privacy')).length, 1);
  const r = await commitEdit(sampleLens, edited, { sha256 });
  assert.ok(ajvValidateLens(r.manifest), JSON.stringify(ajvValidateLens.errors));
});

await test('history: the 3D map axes are scaled to [-1, 1] and deterministic', () => {
  const v = [hv(1, 0, 0, 0), hv(0, 1, 0, 0), hv(0, 0, 1, 0), hv(0, 0, 0, 1), hv(1, 1, 0, 0)];
  const p = project3(v);
  assert.deepEqual(p, project3(v));
  assert.equal(p.length, 5);
  for (let a = 0; a < 3; a++) assert.equal(Math.max(...p.map((x) => Math.abs(x[a]))).toFixed(6), '1.000000');
});

await test('eval browser scorer: System One questions become NLI hypotheses', async () => {
  const { questionToHypothesis, readSystemOneBody, systemOneAnswers } = await import('../eval/browser-scorer/shared.js');
  assert.equal(questionToHypothesis('Is this passage about cybersecurity?'), 'This passage is about cybersecurity.');
  assert.equal(
    questionToHypothesis('Is this passage a correction, clarification, or retraction, or does it cite a primary source such as a study?'),
    'This passage is a correction, clarification, or retraction, or it cites a primary source such as a study.'
  );
  assert.equal(questionToHypothesis('Plain statement'), 'Plain statement.');
  // The request core/model-scorer.js builds parses back into passage and hypotheses.
  const { init } = buildSystemOneRequest({ endpoint: 'http://127.0.0.1:8282' }, { id: 'b', text: 'Ransomware hit the district.' }, ['cybersecurity', 'gossip']);
  const r = readSystemOneBody(JSON.parse(init.body));
  assert.equal(r.passage, 'Ransomware hit the district.');
  assert.deepEqual(r.keys, ['t0', 't1', 'evidence']);
  assert.equal(r.hypotheses[1], 'This passage is about gossip.');
  assert.throws(() => readSystemOneBody({ state: 1 }), /state/);
  // And the answer parses with the extension's own parser.
  const json = systemOneAnswers(r.keys, [0.9, 1.4, NaN]);
  const parsed = parseSystemOneResponse(json, { id: 'b' }, ['cybersecurity', 'gossip']);
  assert.equal(parsed.matches.cybersecurity, 0.9);
  assert.equal(parsed.matches.gossip, 1, 'clamped');
  assert.equal(parsed.evidence, false, 'a missing answer is not evidence');
});

await test('eval browser scorer: cosine rescale, model paths, and the local-only guard', async () => {
  const { rescaleCosine, modelFilePath, isLocalRequest, apiForKind } = await import('../eval/browser-scorer/shared.js');
  assert.ok(Math.abs(rescaleCosine(0.4, 0.2, 0.6) - 0.5) < 1e-9);
  assert.equal(rescaleCosine(0.1, 0.2, 0.6), 0);
  assert.equal(rescaleCosine(0.9, 0.2, 0.6), 1);
  assert.equal(rescaleCosine(0.5, 0.6, 0.2), 0, 'a bad range scores nothing');
  assert.equal(modelFilePath('/models/Xenova/nli-deberta-v3-xsmall/onnx/model_fp16.onnx'), 'Xenova/nli-deberta-v3-xsmall/onnx/model_fp16.onnx');
  assert.equal(modelFilePath('/models/Qwen2.5-0.5B-MLC/resolve/main/params_shard_0.bin'), 'Qwen2.5-0.5B-MLC/params_shard_0.bin');
  assert.equal(modelFilePath('/models/a/../../etc/passwd'), null);
  assert.equal(modelFilePath('/models/a/%2e%2e/b'), null);
  assert.equal(modelFilePath('/other/a'), null);
  assert.equal(isLocalRequest('http://127.0.0.1:8282/models/x'), true);
  assert.equal(isLocalRequest('blob:http://127.0.0.1:8282/abc'), true);
  assert.equal(isLocalRequest('https://huggingface.co/x'), false);
  assert.equal(isLocalRequest('https://cdn.jsdelivr.net/npm/onnxruntime-web/dist/x.wasm'), false);
  assert.equal(apiForKind('webllm'), 'openai');
  assert.equal(apiForKind('nli'), 'systemone');
});

await test('eval two-pass: early, union, and skip combine a fast and a slow scorer', async () => {
  const { twoPass } = await import('../eval/two-pass-lib.mjs');
  const priorities = [{ topic: 'security', weight: 1 }, { topic: 'gossip', weight: -1 }];
  const m = (sec, gos) => ({ security: sec, gossip: gos });
  const labels = { a: 'zap', b: 'keep', c: 'zap', d: 'keep' };
  // a: both zap. b: fast zaps, slow keeps (a wanted flicker). c: only slow zaps, and fast is unsure. d: both keep.
  const fast = [{ id: 'a', matches: m(0, 0.9) }, { id: 'b', matches: m(0, 0.9) }, { id: 'c', matches: m(0, 0.3) }, { id: 'd', matches: m(0.9, 0) }];
  const slow = [{ id: 'a', matches: m(0, 0.9) }, { id: 'b', matches: m(0.9, 0) }, { id: 'c', matches: m(0, 0.9) }, { id: 'd', matches: m(0.9, 0) }];
  const r = twoPass([{ labels, fast, slow }], { priorities, fastAt: 0.7, slowAt: 0.65, skipBelow: 0.2 });
  assert.equal(r.slow.totals.keptHidden.length, 0);
  assert.equal(r.slow.totals.zapMissed.length, 0);
  assert.equal(r.union.totals.keptHidden.length, 1, 'union keeps the fast pass\'s mistake');
  assert.deepEqual(r.early.flickerWanted, ['b']);
  assert.equal(r.early.hiddenEarly, 1);
  assert.equal(r.early.slowCorrectZaps, 2);
  // d is rated on-lens by the fast pass (offLens 0), so the slow pass skips it.
  assert.equal(r.skip.skipped, 1);
  assert.equal(r.skip.slowCalls, 3);
  assert.equal(r.skip.totals.zapMissed.length, 0);
  const strict = twoPass([{ labels, fast, slow }], { priorities, fastAt: 0.7, slowAt: 0.65, skipBelow: 0.5 });
  assert.deepEqual(strict.skip.totals.zapMissed, ['c'], 'skipping a block the fast pass underrated misses it');
});

await test('in-browser: hypotheses, scores, and the gate', async () => {
  const ib = await import('../core/in-browser.js');
  assert.deepEqual(ib.hypotheses(['cybersecurity']), ['This passage is about cybersecurity.', ib.EVIDENCE_HYPOTHESIS]);
  const s = ib.toScore('b', ['a', 'c'], [0.9, 1.2, 0.7]);
  assert.deepEqual(s, { id: 'b', matches: { a: 0.9, c: 1 }, evidence: true });
  assert.equal(ib.toScore('b', ['a'], [0.5]).unscored, true, 'a short answer is unscored');
  assert.equal(ib.toScore('b', ['a'], [NaN, 0.1]).unscored, true);
  assert.deepEqual(ib.modelFiles('fp16').at(-1), 'onnx/model_fp16.onnx');
  assert.deepEqual(ib.modelFiles('fp32').at(-1), 'onnx/model.onnx');
  assert.equal(ib.remoteFileUrl('config.json'), `https://huggingface.co/${ib.IN_BROWSER_MODEL}/resolve/main/config.json`);

  const priorities = [{ topic: 'security', weight: 1 }, { topic: 'gossip', weight: -0.9 }];
  const m = (id, security, gossip, extra = {}) => ({ id, matches: { security, gossip }, ...extra });
  const scores = [m('on', 0.9, 0.05), m('off', 0, 0.8), m('edge', 0, 0.25), m('none', 0, 0, { unscored: true })];
  const g = ib.gateSplit(scores, priorities, { gateAt: 0.2, threshold: 0.65 });
  // gossip 0.25 × 0.9 = 0.225 ≥ 0.2: the model decides.
  assert.deepEqual(g.ask, ['off', 'edge', 'none']);
  assert.deepEqual(g.keep, ['on']);
  // The gate never sits above the zap threshold.
  assert.deepEqual(ib.gateSplit([m('x', 0, 0.3)], priorities, { gateAt: 0.5, threshold: 0.25 }).ask, ['x']);
  // With unmatched blocks hidden, a block matching nothing goes to the model.
  assert.deepEqual(ib.gateSplit([m('n', 0, 0)], priorities, { hideUnmatched: true }).ask, ['n']);

  assert.equal(ib.inBrowserMode({ scorer: 'browser' }), 'only');
  assert.equal(ib.inBrowserMode({ scorer: 'model', inBrowser: { gate: true } }), 'gate');
  assert.equal(ib.inBrowserMode({ scorer: 'hosted', inBrowser: { gate: true } }), 'gate');
  assert.equal(ib.inBrowserMode({ scorer: 'lexical', inBrowser: { gate: true } }), 'off');
  assert.equal(ib.inBrowserMode({ scorer: 'model', inBrowser: { gate: false } }), 'off');
});

await test('in-browser: the gate matches the eval two-pass skip simulation', async () => {
  const ib = await import('../core/in-browser.js');
  const { twoPass } = await import('../eval/two-pass-lib.mjs');
  const priorities = [{ topic: 'security', weight: 1 }, { topic: 'gossip', weight: -1 }];
  const fast = [0.05, 0.15, 0.25, 0.5, 0.9].map((g, i) => ({ id: `b${i}`, matches: { security: 0, gossip: g } }));
  const slow = fast.map((f) => ({ id: f.id, matches: { security: 0, gossip: 0.95 } }));
  const labels = Object.fromEntries(fast.map((f) => [f.id, 'zap']));
  const sim = twoPass([{ labels, fast, slow }], { priorities, fastAt: 0.65, slowAt: 0.65, skipBelow: 0.2 });
  const { ask } = ib.gateSplit(fast, priorities, { gateAt: 0.2, threshold: 0.65 });
  assert.equal(ask.length, sim.skip.slowCalls);
  assert.deepEqual(sim.skip.totals.zapMissed.sort(), fast.map((f) => f.id).filter((id) => !ask.includes(id)).sort());
});

console.log(`lenszap: ${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
