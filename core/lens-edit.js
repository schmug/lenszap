// SPDX-License-Identifier: Apache-2.0
//
// Writes the reader's interest-slider changes, and their direct edits, back
// into their Lens Manifest as one new version. This is the part of the zapper that does claim LensPub
// conformance, as a Manifest Producer (spec/lenspub-protocol.md Section 7.1):
// what it writes must validate, must follow version semantics, and must be
// history-free, so the edited lens still works in any conforming engine.
//
// The rules applied here, and where they come from:
//   - A slider move is a `manual-edit` (spec/adaptation-model.md Section 3.1).
//     The zapper batches a session's moves into one version the reader
//     confirms, so many small dated versions never add up to a reading
//     timeline (docs/explorations/semantic-zapper.md Section 6.3).
//   - Impact class per change (spec/adaptation-model.md Section 4): a weight
//     change of at most 0.2 is minor, anything larger is major. The version
//     bump follows the highest class (spec/lens-manifest.md Section 6).
//   - The superseded version is recorded in versionHistory with its JCS +
//     SHA-256 content hash, and no date.
//   - A proof and publisher no longer describe an edited document, so both are
//     dropped: the edited copy is the reader's own local lens.
//   - Nothing about the page being read is ever written here.
//
// Pure and DOM-free. The SHA-256 digest function is passed in, so the same code
// runs on crypto.subtle in the browser and under Node.

import { checkAgainstSchema } from './schema-check.js';
import { LENS_MANIFEST_SCHEMA } from './lens-manifest.schema.js';

/**
 * JSON Canonicalization Scheme (RFC 8785) for the JSON values a manifest can
 * hold. Object members are sorted by UTF-16 code units; numbers and strings
 * use ECMAScript serialization, which is what JCS specifies.
 */
export function canonicalize(value) {
  if (value === null || typeof value !== 'object') {
    if (typeof value === 'number' && !Number.isFinite(value)) throw new TypeError('JCS: non-finite number');
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(',')}]`;
  const keys = Object.keys(value).filter((k) => value[k] !== undefined).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalize(value[k])}`).join(',')}}`;
}

/**
 * Content hash of a manifest version: SHA-256 over the JCS form with `proof`
 * removed (spec/lens-manifest.md Section 6), as lowercase hex.
 *
 * @param {object} manifest
 * @param {(bytes: Uint8Array) => Promise<ArrayBuffer>} sha256
 */
export async function manifestHash(manifest, sha256) {
  const { proof, ...rest } = manifest;
  const digest = await sha256(new TextEncoder().encode(canonicalize(rest)));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** Impact class of moving one weight from `from` to `to`. */
export function weightChangeImpact(from, to) {
  return Math.abs(to - from) <= 0.2 + 1e-9 ? 'minor' : 'major';
}

/** Semantic-version bump for an impact class. */
export function bumpVersion(version, impact) {
  const [major, minor, patch] = version.split('.').map(Number);
  if (impact === 'major') return `${major + 1}.0.0`;
  if (impact === 'minor') return `${major}.${minor + 1}.0`;
  return `${major}.${minor}.${patch + 1}`;
}

/**
 * The changes a draft makes, one per priority whose weight moved.
 *
 * @param {object} manifest
 * @param {Record<string, number>} draftWeights - topic → new weight
 */
export function draftChanges(manifest, draftWeights) {
  const changes = [];
  for (const p of manifest.interpretation.priorities ?? []) {
    if (!(p.topic in draftWeights)) continue;
    const to = roundWeight(draftWeights[p.topic]);
    if (to === p.weight) continue;
    changes.push({ topic: p.topic, from: p.weight, to, impact: weightChangeImpact(p.weight, to) });
  }
  return changes;
}

/**
 * Apply a draft of weights as one new manifest version.
 *
 * @param {object} manifest - the current, valid manifest; not modified
 * @param {Record<string, number>} draftWeights
 * @param {object} deps
 * @param {(bytes: Uint8Array) => Promise<ArrayBuffer>} deps.sha256
 * @param {Date} [deps.now]
 * @returns {Promise<{manifest: object, changes: object[], impact: string, dropped: string[]} | null>}
 *          null when the draft changes nothing.
 */
export async function commitDraft(manifest, draftWeights, { sha256, now = new Date() }) {
  const changes = draftChanges(manifest, draftWeights);
  if (changes.length === 0) return null;
  const next = structuredClone(manifest);
  for (const p of next.interpretation.priorities) {
    const c = changes.find((ch) => ch.topic === p.topic);
    if (c) p.weight = c.to;
  }
  const impact = changes.some((c) => c.impact === 'major') ? 'major' : 'minor';
  return { ...(await finishVersion(manifest, next, impact, sha256, now)), changes, impact };
}

const IMPACT_RANK = { trivial: 0, minor: 1, major: 2 };

/**
 * Every change between two versions of a lens, each with its impact class
 * (spec/adaptation-model.md Section 4). Priorities are matched by topic, so a
 * renamed topic is a removal plus an addition. Fields the tool sets itself
 * (lensVersion, modified, versionHistory, proof, publisher) are ignored.
 *
 * - weight moved by at most 0.2: minor; more: major
 * - priority added with |weight| at most 0.5: minor; larger: major
 * - priority removed: major
 * - anything under /interpretation/presentation only: trivial
 * - anything else, including /privacy and /adaptation: major
 */
export function lensChanges(before, after) {
  const changes = [];
  const pb = new Map((before.interpretation?.priorities ?? []).map((p) => [p.topic, p]));
  const pa = new Map((after.interpretation?.priorities ?? []).map((p) => [p.topic, p]));
  for (const [topic, p] of pb) {
    const q = pa.get(topic);
    if (!q) {
      changes.push({ path: '/interpretation/priorities', topic, op: 'remove', from: p.weight, impact: 'major' });
      continue;
    }
    const { weight: w1, ...r1 } = p;
    const { weight: w2, ...r2 } = q;
    if (w1 !== w2) changes.push({ path: '/interpretation/priorities', topic, op: 'replace', from: w1, to: w2, impact: weightChangeImpact(w1, w2) });
    if (canonicalize(r1) !== canonicalize(r2)) changes.push({ path: '/interpretation/priorities', topic, op: 'replace', field: 'domains', impact: 'major' });
  }
  for (const [topic, q] of pa) {
    if (!pb.has(topic)) {
      changes.push({ path: '/interpretation/priorities', topic, op: 'add', to: q.weight, impact: Math.abs(q.weight) <= 0.5 + 1e-9 ? 'minor' : 'major' });
    }
  }
  const strip = (m) => {
    const c = structuredClone(m ?? {});
    delete c.proof;
    delete c.versionHistory;
    if (c.metadata) for (const k of ['lensVersion', 'modified', 'publisher']) delete c.metadata[k];
    if (c.interpretation) delete c.interpretation.priorities;
    return c;
  };
  const a = strip(before);
  const b = strip(after);
  for (const key of new Set([...Object.keys(a), ...Object.keys(b)])) {
    if (key === 'interpretation') {
      const ia = a.interpretation ?? {};
      const ib = b.interpretation ?? {};
      for (const k of new Set([...Object.keys(ia), ...Object.keys(ib)])) {
        if (canonicalize(ia[k] ?? null) !== canonicalize(ib[k] ?? null)) {
          changes.push({ path: `/interpretation/${k}`, op: k in ib ? (k in ia ? 'replace' : 'add') : 'remove', impact: k === 'presentation' ? 'trivial' : 'major' });
        }
      }
    } else if (canonicalize(a[key] ?? null) !== canonicalize(b[key] ?? null)) {
      changes.push({ path: `/${key}`, op: key in b ? (key in a ? 'replace' : 'add') : 'remove', impact: 'major' });
    }
  }
  return changes;
}

/**
 * Save an edited lens (the reader's own direct edit) as one new version.
 * The version fields are the tool's to set: whatever the edit put in
 * lensVersion, modified, or versionHistory is replaced.
 *
 * @returns {Promise<{manifest: object, changes: object[], impact: string, dropped: string[]} | null>}
 *          null when the edit changes nothing.
 */
export async function commitEdit(manifest, edited, { sha256, now = new Date() }) {
  if (!edited || typeof edited !== 'object' || Array.isArray(edited)) throw new Error('A lens must be a JSON object.');
  const next = structuredClone(edited);
  next.metadata = { ...(next.metadata ?? {}), lensVersion: manifest.metadata.lensVersion };
  if (manifest.metadata.modified) next.metadata.modified = manifest.metadata.modified;
  else delete next.metadata.modified;
  if (manifest.versionHistory) next.versionHistory = manifest.versionHistory;
  else delete next.versionHistory;
  const changes = lensChanges(manifest, next);
  if (changes.length === 0) return null;
  const impact = changes.reduce((m, c) => (IMPACT_RANK[c.impact] > IMPACT_RANK[m] ? c.impact : m), 'trivial');
  return { ...(await finishVersion(manifest, next, impact, sha256, now)), changes, impact };
}

async function finishVersion(manifest, next, impact, sha256, now) {
  const dropped = [];
  const priorVersion = manifest.metadata.lensVersion;
  next.versionHistory = [
    ...(manifest.versionHistory ?? []),
    { lensVersion: priorVersion, hash: await manifestHash(manifest, sha256) }
  ];
  next.metadata.lensVersion = bumpVersion(priorVersion, impact);
  // Day granularity: a modification time to the second, across many versions,
  // is a record of when the reader was reading.
  next.metadata.modified = `${now.toISOString().slice(0, 10)}T00:00:00Z`;

  if ('proof' in next) {
    delete next.proof;
    dropped.push('proof');
  }
  if (next.metadata.publisher) {
    delete next.metadata.publisher;
    dropped.push('metadata.publisher');
  }

  const errors = checkAgainstSchema(next, LENS_MANIFEST_SCHEMA);
  if (errors.length) throw new Error(`Edited lens would not validate: ${errors.join(' ')}`);
  return { manifest: next, dropped };
}

/**
 * Validate a manifest the reader imports. The zapper is a Manifest Consumer
 * and must reject documents that fail the schema (spec/lens-manifest.md
 * Section 2).
 */
export function validateLens(manifest) {
  return checkAgainstSchema(manifest, LENS_MANIFEST_SCHEMA);
}

/**
 * Manifest features this tool reads but does not act on. Reported to the
 * reader rather than silently dropped (spec/lens-engine.md Section 4.3 states
 * this for engines; the zapper is not one, but the same candor applies).
 */
export function unsupportedFeatures(manifest) {
  const out = [];
  const i = manifest.interpretation ?? {};
  if ((i.priorities ?? []).some((p) => p.domains?.length)) out.push('Domain Scope restrictions on priorities (applied everywhere instead)');
  if (i.sources) out.push('source trust and distrust');
  if (i.presentation) out.push('presentation preferences (the zapper has no overlays)');
  if (manifest.subscriptions?.length) out.push('subscriptions');
  if (manifest.extensions) out.push('extensions');
  return out;
}

const roundWeight = (w) => Math.round(Math.min(1, Math.max(-1, Number(w))) * 100) / 100;
