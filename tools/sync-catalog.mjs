#!/usr/bin/env node
// Regenerate src/all-rules.json (the bundled catalog the validator runs) from
// rules/all-rules.yaml (the single editable source). With `--check` it fails if
// the committed bundle is stale, so CI can guarantee the two never drift.
//
//   npm run sync:catalog     # regenerate the bundle
//   npm run check:catalog    # fail if stale (CI gate)
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SRC = join(ROOT, 'rules', 'all-rules.yaml');
const OUT = join(ROOT, 'src', 'all-rules.json');

const catalog = parse(readFileSync(SRC, 'utf8'));
const json = JSON.stringify(catalog);
const ruleCount = Object.values(catalog).reduce((s, g) => s + Object.keys(g).length, 0);

if (process.argv.includes('--check')) {
  const current = existsSync(OUT) ? readFileSync(OUT, 'utf8') : '';
  if (current !== json) {
    console.error('DRIFT: src/all-rules.json is stale vs rules/all-rules.yaml.');
    console.error('Run: npm run sync:catalog');
    process.exit(1);
  }
  console.log(`catalog bundle in sync (${ruleCount} rules).`);
} else {
  writeFileSync(OUT, json);
  console.log(`wrote src/all-rules.json (${ruleCount} rules).`);
}
