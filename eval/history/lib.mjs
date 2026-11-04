// SPDX-License-Identifier: Apache-2.0
//
// Pure helpers for the history-lens spike (eval/history-lens.mjs): turn a
// browser's history into topic groups the reader can weight, then into a lens.
//
// Developer tooling, never loaded by the extension. Everything that touches
// page titles or addresses stays on this machine, in the git-ignored data
// folder. The lens this produces holds only the topic names and weights the
// reader chose: no address, title, count, or date (Lenses stay history-free).

import { checkAgainstSchema } from '../../core/schema-check.js';
import { LENS_MANIFEST_SCHEMA } from '../../core/lens-manifest.schema.js';

/** Chrome stores times as microseconds since 1601-01-01 UTC. */
const CHROME_EPOCH_OFFSET_MS = 11644473600000;
/** Chrome time (a BigInt: it is past Number's safe range) to ms since 1970. */
export const chromeTimeToMs = (t) => Number(BigInt(t) / 1000n) - CHROME_EPOCH_OFFSET_MS;
export const msToChromeTime = (ms) => BigInt(Math.round(ms + CHROME_EPOCH_OFFSET_MS)) * 1000n;

/** Day number (UTC) for a time in ms; coarse on purpose. */
export const dayOf = (ms) => Math.floor(ms / 86400000);

const SKIP_HOSTS = /(^|\.)(localhost|127\.0\.0\.1|accounts\.google\.com|login\.microsoftonline\.com|appleid\.apple\.com)$/;
const SKIP_PATHS = /\/(login|signin|sign-in|logout|oauth2?|auth|sso|callback)(\/|$)/i;
const SEARCH = [
  { host: /(^|\.)google\.[a-z.]+$/, path: /^\/search/ },
  { host: /(^|\.)bing\.com$/, path: /^\/search/ },
  { host: /(^|\.)duckduckgo\.com$/, path: /^\/$/, query: 'q' },
  { host: /(^|\.)search\.brave\.com$/, path: /^\/search/ },
  { host: /(^|\.)kagi\.com$/, path: /^\/search/ }
];

/**
 * Whether a history entry is a readable page worth grouping: http(s), a
 * title, not a sign-in flow, not a search results page, not this machine.
 */
export function keepEntry(url, title) {
  let u;
  try {
    u = new URL(url);
  } catch {
    return false;
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return false;
  if (!cleanTitle(title)) return false;
  const host = u.hostname.replace(/^www\./, '');
  if (SKIP_HOSTS.test(host) || /^\d+\.\d+\.\d+\.\d+$/.test(host)) return false;
  if (SKIP_PATHS.test(u.pathname)) return false;
  for (const s of SEARCH) {
    if (s.host.test(host) && s.path.test(u.pathname) && (!s.query || u.searchParams.has(s.query))) return false;
  }
  return true;
}

/** A title with whitespace collapsed and a trailing " - Site Name" left in (it helps the embedding). */
export function cleanTitle(title) {
  const t = String(title ?? '').replace(/\s+/g, ' ').trim();
  return t.length >= 3 ? t : '';
}

export const hostOf = (url) => new URL(url).hostname.replace(/^www\./, '');

/**
 * Collapse visit rows into one entry per page (host + title), so a page
 * reloaded twenty times is one page with twenty visits.
 *
 * @param {{url: string, title: string, visitTime: number}[]} rows - visitTime in ms
 * @returns {{id: string, url: string, title: string, host: string, visits: number, days: number[]}[]}
 */
export function collapseVisits(rows) {
  const pages = new Map();
  for (const { url, title, visitTime } of rows) {
    if (!keepEntry(url, title)) continue;
    const host = hostOf(url);
    const t = cleanTitle(title);
    const key = `${host}\n${t}`;
    let p = pages.get(key);
    if (!p) {
      p = { id: '', url, title: t, host, visits: 0, days: new Set() };
      pages.set(key, p);
    }
    p.visits++;
    p.days.add(dayOf(visitTime));
  }
  return [...pages.values()]
    .sort((a, b) => b.visits - a.visits || a.host.localeCompare(b.host) || a.title.localeCompare(b.title))
    .map((p, i) => ({ ...p, id: `p${i}`, days: [...p.days].sort((a, b) => a - b) }));
}

/** The text embedded for a page: its title and site. */
export const pageText = (p) => `${p.title} (${p.host})`;

/** The text embedded for a seed topic. */
export const topicText = (t) => (t.hint ? `${t.topic}: ${t.hint}` : t.topic);

export function normalize(v) {
  let n = 0;
  for (const x of v) n += x * x;
  n = Math.sqrt(n) || 1;
  return v.map((x) => x / n);
}

export function dot(a, b) {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += a[i] * b[i];
  return s;
}

/** Value at quantile q (0..1) of a list of numbers. */
export function quantile(xs, q) {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.max(0, Math.floor(q * (s.length - 1))))];
}

/**
 * Give each page its nearest seed topic, if close enough. "Close enough" is
 * relative, because cosine scales differ between embedding models: a page is
 * left unassigned when its best similarity is in the bottom `unassignedShare`
 * of all pages' best similarities.
 *
 * @param {number[][]} pageVecs - normalized
 * @param {number[][]} topicVecs - normalized
 * @returns {{topic: number[], sim: number[], cutoff: number}} topic index per page, or -1
 */
export function assignTopics(pageVecs, topicVecs, { unassignedShare = 0.3 } = {}) {
  const best = pageVecs.map((v) => {
    let bi = -1;
    let bs = -Infinity;
    topicVecs.forEach((t, i) => {
      const s = dot(v, t);
      if (s > bs) {
        bs = s;
        bi = i;
      }
    });
    return [bi, bs];
  });
  const cutoff = quantile(best.map(([, s]) => s), unassignedShare);
  return {
    topic: best.map(([i, s]) => (s > cutoff || unassignedShare === 0 ? i : -1)),
    sim: best.map(([, s]) => s),
    cutoff
  };
}

/** A small seeded PRNG (mulberry32), so groups are the same on every run. */
export function prng(seed = 1) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Cosine k-means with k-means++ seeding. Deterministic for a given seed.
 *
 * @param {number[][]} vecs - normalized
 * @returns {number[]} cluster index per vector
 */
export function kmeans(vecs, k, { seed = 1, iterations = 25 } = {}) {
  const n = vecs.length;
  if (n === 0) return [];
  k = Math.max(1, Math.min(k, n));
  const rand = prng(seed);
  const centers = [vecs[Math.floor(rand() * n)]];
  while (centers.length < k) {
    const d = vecs.map((v) => Math.max(0, 1 - Math.max(...centers.map((c) => dot(v, c)))));
    const total = d.reduce((a, b) => a + b, 0);
    if (total === 0) break;
    let r = rand() * total;
    let i = 0;
    while (i < n - 1 && (r -= d[i]) > 0) i++;
    centers.push(vecs[i]);
  }
  let assign = new Array(n).fill(0);
  for (let it = 0; it < iterations; it++) {
    const next = vecs.map((v) => {
      let bi = 0;
      let bs = -Infinity;
      centers.forEach((c, i) => {
        const s = dot(v, c);
        if (s > bs) {
          bs = s;
          bi = i;
        }
      });
      return bi;
    });
    const same = it > 0 && next.every((x, i) => x === assign[i]);
    assign = next;
    if (same) break;
    for (let c = 0; c < centers.length; c++) {
      const members = vecs.filter((_, i) => assign[i] === c);
      if (!members.length) continue;
      const sum = new Array(members[0].length).fill(0);
      for (const m of members) for (let j = 0; j < m.length; j++) sum[j] += m[j];
      centers[c] = normalize(sum);
    }
  }
  return assign;
}

/**
 * Group pages: seed topics first, then k-means over what no seed topic
 * claimed. Groups smaller than `minPages` fold into one "Everything else".
 *
 * @returns {{id: string, name: string, kind: 'topic'|'group'|'other', pages: string[], visits: number}[]}
 */
export function groupPages(pages, pageVecs, topics, topicVecs, { unassignedShare = 0.3, minPages = 5, maxGroups = 12, seed = 1 } = {}) {
  const { topic } = assignTopics(pageVecs, topicVecs, { unassignedShare });
  const buckets = new Map();
  const add = (key, base, i) => {
    if (!buckets.has(key)) buckets.set(key, { ...base, pages: [], visits: 0 });
    const b = buckets.get(key);
    b.pages.push(pages[i].id);
    b.visits += pages[i].visits;
  };
  const loose = [];
  topic.forEach((t, i) => (t >= 0 ? add(`t${t}`, { id: `t${t}`, name: topics[t].topic, kind: 'topic' }, i) : loose.push(i)));
  if (loose.length) {
    const k = Math.min(maxGroups, Math.max(1, Math.ceil(loose.length / 25)));
    const cl = kmeans(loose.map((i) => pageVecs[i]), k, { seed });
    cl.forEach((c, j) => add(`g${c}`, { id: `g${c}`, name: '', kind: 'group' }, loose[j]));
  }
  const out = [];
  const other = { id: 'other', name: 'Everything else', kind: 'other', pages: [], visits: 0 };
  for (const b of buckets.values()) {
    if (b.pages.length >= minPages) out.push(b);
    else {
      other.pages.push(...b.pages);
      other.visits += b.visits;
    }
  }
  out.sort((a, b) => b.visits - a.visits || a.id.localeCompare(b.id));
  let n = 0;
  for (const b of out) if (b.kind === 'group') b.name = `Unnamed group ${++n}`;
  if (other.pages.length) out.push(other);
  return out;
}

/**
 * A starting weight per group, from how much of the reader's browsing it is:
 * the most-visited group starts at 1, a group under `minShare` of visits at 0.
 * History can't say what the reader dislikes, so nothing starts negative.
 */
export function suggestedWeights(groups, { minShare = 0.02 } = {}) {
  const total = groups.reduce((a, g) => a + g.visits, 0) || 1;
  const max = Math.max(1, ...groups.filter((g) => g.kind !== 'other').map((g) => g.visits));
  return Object.fromEntries(
    groups.map((g) => {
      if (g.kind === 'other' || g.visits / total < minShare) return [g.id, 0];
      const w = 0.3 + (0.7 * Math.log(g.visits)) / Math.log(Math.max(2, max));
      return [g.id, Math.round(Math.min(1, w) * 20) / 20];
    })
  );
}

const TOPIC = /^[^\n]{2,80}$/;

/**
 * The lens the reader's table describes: one priority per named group with a
 * non-zero weight. With a base lens, its other fields are kept and its
 * priorities for the same topics are replaced; the caller saves it through
 * commitEdit so the version and history are the tool's.
 *
 * Nothing about the browsing goes in: no counts, addresses, titles, or dates.
 *
 * @param {{name: string, weight: number}[]} rows
 * @param {object} [base] - an existing lens
 * @returns {object} manifest (unversioned when based on `base`)
 */
export function lensFromRows(rows, base, { now = new Date() } = {}) {
  const seen = new Set();
  const priorities = [];
  for (const r of rows) {
    const topic = String(r.name ?? '').replace(/\s+/g, ' ').trim();
    const weight = Math.round(Math.max(-1, Math.min(1, Number(r.weight))) * 100) / 100;
    if (!weight || !TOPIC.test(topic) || /^Unnamed group \d+$|^Everything else$/.test(topic)) continue;
    const key = topic.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    priorities.push({ topic, weight });
  }
  if (base) {
    const kept = (base.interpretation?.priorities ?? []).filter((p) => !seen.has(p.topic.toLowerCase()));
    const out = structuredClone(base);
    out.interpretation = { ...(out.interpretation ?? {}), priorities: [...kept, ...priorities] };
    return out;
  }
  const day = `${now.toISOString().slice(0, 10)}T00:00:00Z`;
  return {
    lenspub: '0.1',
    type: 'LensManifest',
    metadata: {
      name: 'Lens from my browsing',
      description: 'Interests and weights chosen in a table of topics grouped from browsing history on this device. Holds only the chosen topics and weights.',
      lensVersion: '1.0.0',
      created: day,
      modified: day,
      language: 'en'
    },
    interpretation: { priorities },
    adaptation: { defaultPolicy: 'conservative' },
    privacy: { remoteInference: { allowed: false } }
  };
}

export const lensErrors = (manifest) => checkAgainstSchema(manifest, LENS_MANIFEST_SCHEMA);

/**
 * Three axes for the history map: the top three principal components of the
 * page vectors (power iteration with deflation; deterministic).
 *
 * @returns {number[][]} [x, y, z] per vector, each axis scaled to [-1, 1]
 */
export function project3(vecs, { seed = 1, iterations = 60 } = {}) {
  const n = vecs.length;
  if (!n) return [];
  const d = vecs[0].length;
  const mean = new Array(d).fill(0);
  for (const v of vecs) for (let j = 0; j < d; j++) mean[j] += v[j] / n;
  const X = vecs.map((v) => v.map((x, j) => x - mean[j]));
  const rand = prng(seed);
  const comps = [];
  for (let c = 0; c < Math.min(3, d); c++) {
    let w = normalize(Array.from({ length: d }, () => rand() - 0.5));
    for (let it = 0; it < iterations; it++) {
      const next = new Array(d).fill(0);
      for (const x of X) {
        const s = dot(x, w);
        for (let j = 0; j < d; j++) next[j] += s * x[j];
      }
      for (const p of comps) {
        const s = dot(next, p);
        for (let j = 0; j < d; j++) next[j] -= s * p[j];
      }
      w = normalize(next);
    }
    comps.push(w);
  }
  const pts = X.map((x) => comps.map((p) => dot(x, p)));
  for (let a = 0; a < comps.length; a++) {
    const m = Math.max(1e-9, ...pts.map((p) => Math.abs(p[a])));
    for (const p of pts) p[a] /= m;
  }
  return pts.map((p) => [p[0] ?? 0, p[1] ?? 0, p[2] ?? 0]);
}
