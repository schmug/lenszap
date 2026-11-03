// SPDX-License-Identifier: Apache-2.0
//
// Repository guards that don't belong to any one module.
// Run:  npm test   (or: node test/repo-checks.mjs)
//
// - manifest.json, package.json, and package-lock.json carry the same
//   MAJOR.MINOR.PATCH version, and CHANGELOG.md has an entry for it;
// - the manifest asks for no host access beyond loopback up front (local by
//   default); hosted providers are optional hosts, asked for only when the
//   reader sets one up with their own key;
// - every code file carries an SPDX-License-Identifier header.

import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { compareVersions, isShipped, parseVersion } from '../scripts/version.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
const readJson = (p) => JSON.parse(readFileSync(join(root, p), 'utf8'));

let passed = 0;
let failed = 0;
function test(name, fn) {
  try {
    fn();
    passed++;
  } catch (err) {
    failed++;
    console.error(`FAIL ${name}\n  ${err.message}`);
  }
}

const manifest = readJson('manifest.json');
const pkg = readJson('package.json');

test('manifest.json and package.json versions match', () => {
  assert.equal(manifest.version, pkg.version, 'bump with `npm version patch|minor|major`');
});

test('package-lock.json version matches package.json', () => {
  const lock = readJson('package-lock.json');
  assert.equal(lock.version, pkg.version, 'bump with `npm version`, which updates the lock too');
  assert.equal(lock.packages?.['']?.version, pkg.version);
});

test('version is MAJOR.MINOR.PATCH that Chrome accepts', () => {
  assert.ok(parseVersion(manifest.version), `${manifest.version} is not X.Y.Z`);
});

test('CHANGELOG.md has an entry for the current version', () => {
  const log = readFileSync(join(root, 'CHANGELOG.md'), 'utf8');
  assert.match(log, new RegExp(`^## ${manifest.version.replaceAll('.', '\\.')}\\b`, 'm'));
});

test('version helpers compare and classify', () => {
  assert.equal(parseVersion('1.2.3').join(), '1,2,3');
  for (const bad of ['1.2', '1.2.3.4', '1.2.3-beta', '01.2.3', '1.2.70000', 'v1.2.3']) {
    assert.equal(parseVersion(bad), null, bad);
  }
  assert.ok(compareVersions('0.10.0', '0.9.9') > 0, 'numeric, not string, order');
  assert.ok(compareVersions('1.0.0', '0.99.99') > 0);
  assert.equal(compareVersions('0.3.0', '0.3.0'), 0);
  assert.ok(compareVersions('0.3.0', '0.3.1') < 0);
  for (const f of ['manifest.json', 'core/decide.js', 'content/zap.css', 'sidepanel/sidepanel.html']) {
    assert.ok(isShipped(f), f);
  }
  for (const f of ['eval/run.mjs', 'test/repo-checks.mjs', 'README.md', 'package.json', 'scripts/dev.mjs']) {
    assert.ok(!isShipped(f), f);
  }
});

test('manifest host permissions are loopback only', () => {
  const allowed = new Set(['http://localhost/*', 'http://127.0.0.1/*', 'http://[::1]/*']);
  for (const host of manifest.host_permissions ?? []) {
    assert.ok(allowed.has(host), `host permission ${host} is not loopback`);
  }
});

test('optional host permissions are the hosted providers only, https only', () => {
  // Each is requested at runtime from the hosted-model Save button (core/hosted.js).
  // https://*/* covers a custom OpenAI-compatible endpoint; only that one origin is asked for.
  const expected = ['https://api.cloudflare.com/*', 'https://api.typesafe.ai/*', 'https://openrouter.ai/*', 'https://*/*'];
  assert.deepEqual(manifest.optional_host_permissions ?? [], expected, 'change core/hosted.js, this list, and SECURITY.md together');
  assert.ok(!(manifest.permissions ?? []).includes('<all_urls>'));
});

// Code files only; upstream/ holds verbatim LensPub copies, eval/data/ holds captures.
const SKIP_DIRS = new Set(['.git', 'node_modules', 'upstream']);
const SKIP_PATHS = new Set(['eval/data']);
const CODE = /\.(m?js|css|html)$/;

function* codeFiles(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    const rel = relative(root, full).split('\\').join('/');
    if (entry.isDirectory()) {
      if (!SKIP_DIRS.has(entry.name) && !SKIP_PATHS.has(rel)) yield* codeFiles(full);
    } else if (CODE.test(entry.name)) {
      yield rel;
    }
  }
}

test('every code file has an SPDX-License-Identifier header', () => {
  const missing = [];
  for (const rel of codeFiles(root)) {
    const head = readFileSync(join(root, rel), 'utf8').split('\n').slice(0, 5).join('\n');
    if (!head.includes('SPDX-License-Identifier: Apache-2.0')) missing.push(rel);
  }
  assert.deepEqual(missing, [], `add "SPDX-License-Identifier: Apache-2.0" near the top of: ${missing.join(', ')}`);
});

console.log(`repo checks: ${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
