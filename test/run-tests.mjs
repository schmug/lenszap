// SPDX-License-Identifier: Apache-2.0
//
// Node tests for the zapper's pure modules (zapper/core/).
// Run:  npm run zapper:test   (or: node zapper/test/run-tests.mjs)
//
// The zapper is not a LensPub engine and is not tested by conformance/. What it
// does claim, as a Manifest Producer, is checked here: every lens it writes
// validates against schemas/lens-manifest.schema.json (with Ajv, independently
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
import { siteRule, groupWithFollowing, scoringOrder, SITE_RULES } from '../core/segment.js';

const root = fileURLToPath(new URL('../..', import.meta.url));
const read = (p) => readFileSync(root + p, 'utf8');
const sampleLens = JSON.parse(read('zapper/lenses/sample-lens.json'));
const sha256 = async (bytes) => createHash('sha256').update(bytes).digest();

const require = createRequire(import.meta.url);
const Ajv2020 = require('ajv/dist/2020').default;
const addFormats = require('ajv-formats');
const ajv = new Ajv2020({ allErrors: true, strict: false });
addFormats(ajv);
const ajvValidateLens = ajv.compile(JSON.parse(read('schemas/lens-manifest.schema.json')));

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

await test('bundled schema equals schemas/lens-manifest.schema.json', () => {
  assert.deepEqual(LENS_MANIFEST_SCHEMA, JSON.parse(read('schemas/lens-manifest.schema.json')));
});

await test('schema-check.js equals poc/engine/schema-check.js below its header', () => {
  const body = (s) => s.slice(s.indexOf('// A dependency-free checker'));
  assert.equal(body(read('zapper/core/schema-check.js')), body(read('poc/engine/schema-check.js')));
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
  const { passages } = JSON.parse(read('zapper/bench/passages.json'));
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

console.log(`zapper: ${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
