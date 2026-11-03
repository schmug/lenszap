// SPDX-License-Identifier: Apache-2.0
//
// The extension's version: one MAJOR.MINOR.PATCH number kept in package.json,
// package-lock.json, and manifest.json, with a CHANGELOG.md entry for each.
//
//   npm version patch|minor|major   # bumps package.json + lock, then runs `sync`
//   node scripts/version.mjs sync   # copy package.json's version into manifest.json
//   node scripts/version.mjs check [base]
//       # fails if files the extension loads changed since `base` (default
//       # origin/main) and the version was not raised above base's. CI runs
//       # this on every pull request.
//
// Chrome reads only manifest.json's "version": 1–4 dot-separated integers, no
// pre-release tags. We use exactly three (semver without suffixes) so the same
// string is valid for npm and Chrome.

import { readFileSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const read = (p) => readFileSync(join(root, p), 'utf8');

/** Paths the browser loads; a change under any of them needs a version bump. */
export const SHIPPED = ['manifest.json', 'background/', 'content/', 'core/', 'sidepanel/', 'lenses/'];

const SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;

/** [major, minor, patch], or null if `v` is not a plain X.Y.Z Chrome also accepts. */
export function parseVersion(v) {
  const m = SEMVER.exec(String(v));
  if (!m) return null;
  const parts = m.slice(1).map(Number);
  return parts.every((n) => n <= 65535) ? parts : null;
}

/** Negative, zero, or positive, like a sort comparator. */
export function compareVersions(a, b) {
  const pa = parseVersion(a);
  const pb = parseVersion(b);
  if (!pa || !pb) throw new Error(`not a version: ${pa ? b : a}`);
  for (let i = 0; i < 3; i++) if (pa[i] !== pb[i]) return pa[i] - pb[i];
  return 0;
}

export function isShipped(path) {
  return SHIPPED.some((p) => (p.endsWith('/') ? path.startsWith(p) : path === p));
}

function sync() {
  const version = JSON.parse(read('package.json')).version;
  if (!parseVersion(version)) {
    throw new Error(`package.json version ${version} must be MAJOR.MINOR.PATCH with no suffix (Chrome rejects pre-release tags)`);
  }
  const text = read('manifest.json');
  const next = text.replace(/("version"\s*:\s*")[^"]*(")/, `$1${version}$2`);
  if (next !== text) writeFileSync(join(root, 'manifest.json'), next);
  if (!new RegExp(`^## ${version.replaceAll('.', '\\.')}\\b`, 'm').test(read('CHANGELOG.md'))) {
    console.log(`manifest.json is now ${version}. Add a "## ${version}" entry to CHANGELOG.md.`);
  } else {
    console.log(`manifest.json is now ${version}.`);
  }
}

function git(...args) {
  return execFileSync('git', args, { cwd: root, encoding: 'utf8' });
}

function check(base = 'origin/main') {
  const changed = git('diff', '--name-only', `${base}...HEAD`).split('\n').filter(Boolean);
  const shipped = changed.filter(isShipped);
  const now = JSON.parse(read('manifest.json')).version;
  const before = JSON.parse(git('show', `${base}:manifest.json`)).version;
  if (shipped.length === 0) {
    console.log(`No extension files changed since ${base}; version ${now} needs no bump.`);
    return;
  }
  if (compareVersions(now, before) > 0) {
    console.log(`Version ${before} → ${now} covers ${shipped.length} changed extension file(s).`);
    return;
  }
  console.error(
    `Extension files changed since ${base} but the version is still ${now}:\n` +
      shipped.map((f) => `  ${f}`).join('\n') +
      '\nRun `npm version patch` (fix), `npm version minor` (feature), or `npm version major` (breaking),' +
      '\nthen add an entry to CHANGELOG.md. See CONTRIBUTING.md "Versions".'
  );
  process.exit(1);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [cmd, arg] = process.argv.slice(2);
  if (cmd === 'sync') sync();
  else if (cmd === 'check') check(arg);
  else {
    console.error('usage: node scripts/version.mjs sync | check [base]');
    process.exit(2);
  }
}
