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
import { isLoopbackEndpoint, buildRequest, parseResponse, batches, responseSchema } from '../core/model-scorer.js';
import { LENS_MANIFEST_SCHEMA } from '../core/lens-manifest.schema.js';

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

console.log(`zapper: ${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
