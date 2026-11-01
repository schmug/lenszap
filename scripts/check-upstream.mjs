#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
//
// Compare upstream/ with a LensPub checkout, so LensZap knows when the lens
// schema it validates against has moved.
//
//   node scripts/check-upstream.mjs /path/to/lenspub            # report differences
//   node scripts/check-upstream.mjs /path/to/lenspub --update   # copy them in, record the commit
//
// After --update, also update core/lens-manifest.schema.js and
// core/schema-check.js to match, then run npm test.

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const [lenspub, flag] = process.argv.slice(2);
if (!lenspub || !existsSync(join(lenspub, 'schemas/lens-manifest.schema.json'))) {
  console.error('Usage: node scripts/check-upstream.mjs /path/to/lenspub [--update]');
  process.exit(2);
}
const here = fileURLToPath(new URL('../upstream/', import.meta.url));
const FILES = [
  ['lens-manifest.schema.json', 'schemas/lens-manifest.schema.json'],
  ['schema-check.js', 'poc/engine/schema-check.js']
];
const commit = execFileSync('git', ['-C', lenspub, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
const pinned = readFileSync(join(here, 'LENSPUB_COMMIT'), 'utf8').trim();
let differ = 0;
for (const [ours, theirs] of FILES) {
  const a = readFileSync(join(here, ours), 'utf8');
  const b = readFileSync(join(lenspub, theirs), 'utf8');
  if (a !== b) {
    differ++;
    console.log(`differs: upstream/${ours} vs ${theirs}`);
    if (flag === '--update') writeFileSync(join(here, ours), b);
  }
}
if (flag === '--update') writeFileSync(join(here, 'LENSPUB_COMMIT'), `${commit}\n`);
console.log(
  differ
    ? `${differ} file(s) differ between pinned ${pinned.slice(0, 7)} and LensPub ${commit.slice(0, 7)}.${flag === '--update' ? ' Copied; now update core/ to match and run npm test.' : ''}`
    : `Up to date with LensPub ${commit.slice(0, 7)} (pinned ${pinned.slice(0, 7)}).`
);
process.exit(differ && flag !== '--update' ? 1 : 0);
