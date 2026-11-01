// SPDX-License-Identifier: Apache-2.0
//
// Writes the reader's interest-slider changes back into their Lens Manifest as
// one new version. This is the part of the zapper that does claim LensPub
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

  const impact = changes.some((c) => c.impact === 'major') ? 'major' : 'minor';
  const next = structuredClone(manifest);
  const dropped = [];

  for (const p of next.interpretation.priorities) {
    const c = changes.find((ch) => ch.topic === p.topic);
    if (c) p.weight = c.to;
  }

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
  return { manifest: next, changes, impact, dropped };
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
