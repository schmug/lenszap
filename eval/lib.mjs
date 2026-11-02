// SPDX-License-Identifier: Apache-2.0
//
// Shared helpers for the eval tools (capture, label, run). Node only: these are
// developer tools, not part of the extension, and never loaded by it.
//
// An eval data directory holds two folders:
//   pages/<slug>.json   blocks captured from one page by eval/capture.mjs
//   labels/<slug>.json  your keep/zap/... label for each block, keyed by block key
// A block key is a hash of the block's text, so labels survive a recapture as
// long as the text is unchanged. Labels hold keys and labels only, no text.

import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';

/** Labels a block can have. `keep` and `zap` are judged against the lens. */
export const LABELS = Object.freeze({
  keep: 'On your lens: should stay visible.',
  zap: 'Matches an interest you weighted down ("less of this"): should be hidden.',
  neutral: 'Matches none of your interests: hidden only with "also hide blocks that match none of my interests".',
  ad: 'An ad or sponsored block: should be hidden.',
  evidence: 'A correction or primary source: must never be hidden.',
  chrome: 'Page chrome or controls the splitter should not have made a block.',
  mixed: 'Several unrelated items run together: the splitter should have split it.',
  skip: 'Not counted.'
});

/** Labels that mean "this block should be hidden" (plus neutral, when unmatched blocks are hidden). */
export const SHOULD_HIDE = new Set(['zap', 'ad']);
/** Labels that mean "this block should be visible" (plus neutral, when unmatched blocks are kept). */
export const SHOULD_KEEP = new Set(['keep', 'evidence']);
/** Labels that report a splitting problem rather than a scoring one. */
export const SPLIT_PROBLEM = new Set(['chrome', 'mixed']);

export const norm = (s) => String(s ?? '').replace(/\s+/g, ' ').trim();

/** Stable key for a block's text. */
export function blockKey(text) {
  return createHash('sha256').update(norm(text)).digest('hex').slice(0, 12);
}

/** A file-name-safe slug for a URL: host plus a short path. */
export function slugFor(url) {
  const u = new URL(url);
  const path = (u.pathname + u.search).replace(/[^a-z0-9]+/gi, '-').replace(/^-+|-+$/g, '').slice(0, 60);
  return `${u.hostname.replace(/^www\./, '')}${path ? `--${path}` : ''}`.toLowerCase();
}

const readJson = (p) => JSON.parse(readFileSync(p, 'utf8'));

/**
 * Load every captured page in a data directory, with its labels if any.
 * @returns {{slug: string, page: object, labels: Record<string, string>}[]}
 */
export function loadDataset(dir) {
  const pagesDir = join(dir, 'pages');
  if (!existsSync(pagesDir)) return [];
  return readdirSync(pagesDir)
    .filter((f) => f.endsWith('.json'))
    .sort()
    .map((f) => {
      const slug = f.slice(0, -5);
      const labelPath = join(dir, 'labels', f);
      const labels = existsSync(labelPath) ? readJson(labelPath).labels ?? {} : {};
      return { slug, page: readJson(join(pagesDir, f)), labels };
    });
}

/** Parse --flag value pairs; a flag with no value is `true`. Positional args go in `_`. */
export function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) {
      out._.push(a);
      continue;
    }
    const next = argv[i + 1];
    if (next !== undefined && !next.startsWith('--')) {
      out[a.slice(2)] = next;
      i++;
    } else out[a.slice(2)] = true;
  }
  return out;
}

/** Read a lens file, or exit with a hint about where to get one. */
export function readLens(path) {
  if (!existsSync(path)) {
    console.error(`No lens file at ${path}.`);
    console.error('Export yours from the side panel (Lens tab, Export), or leave out --lens to use the sample lens.');
    process.exit(2);
  }
  return readJson(path);
}

/**
 * Carry labels from an earlier capture of a page to a new split of the same
 * page. A block whose text is unchanged keeps its label (same key). A new
 * block whose text lies inside one old labelled block inherits that label,
 * unless the old block was labelled mixed (its parts need their own labels)
 * or the new block is under INHERIT_MIN_SHARE of it (a fragment may be chrome).
 * Everything else is left for you to label.
 *
 * @returns {{labels: Record<string,string>, kept: number, inherited: number, unlabelled: number}}
 */
export const INHERIT_MIN_SHARE = 0.4;

export function carryLabels(oldBlocks, oldLabels, newBlocks) {
  const labelled = oldBlocks
    .filter((b) => oldLabels[b.key] && oldLabels[b.key] !== 'mixed')
    .map((b) => ({ text: norm(b.text), label: oldLabels[b.key] }));
  const labels = {};
  let kept = 0, inherited = 0, unlabelled = 0;
  for (const b of newBlocks) {
    if (oldLabels[b.key]) { labels[b.key] = oldLabels[b.key]; kept++; continue; }
    const t = norm(b.text);
    // A small fragment (a byline, a comment count) does not inherit: it may be
    // chrome, and only a label says so.
    const from = t && labelled.filter((o) => o.text.includes(t) && t.length >= INHERIT_MIN_SHARE * o.text.length);
    const kinds = new Set((from || []).map((o) => o.label));
    if (kinds.size === 1) { labels[b.key] = [...kinds][0]; inherited++; } else unlabelled++;
  }
  return { labels, kept, inherited, unlabelled };
}
