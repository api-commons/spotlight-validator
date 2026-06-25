#!/usr/bin/env node
// Compile the APIs.json default ruleset for the validator from the first-party
// API Evangelist apis-json rules (api-evangelist/rules/rules-apis-json-*.yml).
//
// - Merges the multi-document source files.
// - Drops the paired "-info" POSITIVE-CONFIRMATION rules (falsy / pattern-notMatch
//   on a should-be-present value) — they fire on compliant docs and are noise.
//   Keeps "-error" violations and real "-info" validations (truthy / pattern-match).
// - Strips the redundant leading "apis-json-" from rule names.
// - Infers a category and tags each rule [format:apis-json, category:*].
// - Validates every rule against the engine (construct + lint a sample) and prunes
//   any that throw.
//
// Emits rules/defaults/apis-json.yaml. Re-run after editing the source rules.

import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseAllDocuments, stringify } from 'yaml';
import core from '@spotlight-rules/spotlight-core';
import * as builtins from '@spotlight-rules/spotlight-functions';
import parsersNs from '@spotlight-rules/spotlight-parsers';

const { Spotlight, Document, Ruleset } = core;
const Yaml = parsersNs.Yaml ?? parsersNs.default?.Yaml;
// Convert data-form (string function names) to JS form (function objects) for validation.
const FN = { ...builtins };
const toJs = (node) =>
  Array.isArray(node) ? node.map(toJs)
  : node && typeof node === 'object'
    ? Object.fromEntries(Object.entries(node).map(([k, v]) =>
        k === 'function' && typeof v === 'string' ? [k, FN[v] ?? v] : [k, toJs(v)]))
    : node;
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const META = (() => { try { return JSON.parse(readFileSync(join(ROOT, 'tools', 'rule-meta.json'), 'utf8')); } catch { return {}; } })();
const metaTags = (m) => [...(m?.spec ?? []).map((s) => `spec:${s}`), ...(m?.experience ?? []).map((e) => `experience:${e}`)];
const SRC = '/Users/kinlane/GitHub/api-evangelist/rules';

// ---- gather + merge source rules (multi-doc) ----
const merged = {};
for (const f of readdirSync(SRC).filter((f) => /^rules-apis-json-.*\.yml$/.test(f))) {
  for (const doc of parseAllDocuments(readFileSync(join(SRC, f), 'utf8'))) {
    const d = doc.toJS() || {};
    if (d.rules) for (const [k, v] of Object.entries(d.rules)) merged[k] = v;
  }
}

// ---- classify ----
const isConfirmation = (rule) => {
  const t = rule?.then || {};
  const o = t.functionOptions || {};
  if (t.function === 'falsy') return true;                       // "field present" confirmation
  if (t.function === 'pattern' && o.notMatch && !o.match) return true; // "value matches" confirmation
  return false;
};

const CATEGORY_KEYWORDS = [
  ['versioning', /version/i],
  ['security', /secur|auth|oauth|https|token/i],
  ['documentation', /tag|maintainer|contact|name|description|image|doc|about|summary|overview/i],
  ['structure', /api|propert|baseurl|url|aid|common|include|format/i],
];
function inferCategory(name) {
  for (const [cat, re] of CATEGORY_KEYWORDS) if (re.test(name)) return cat;
  return 'structure';
}

const VALID = new Set(['description', 'message', 'severity', 'given', 'then', 'formats', 'resolved', 'recommended', 'documentationUrl']);
const out = {};
const used = new Set();
let dropped = 0;
for (const [origName, rule] of Object.entries(merged)) {
  if (!rule || typeof rule !== 'object') continue;
  if (origName.endsWith('-info') && isConfirmation(rule)) { dropped++; continue; }
  const clean = {};
  for (const [k, v] of Object.entries(rule)) if (VALID.has(k)) clean[k] = v;
  const curSlug = origName.replace(/^apis-json-/, '');
  const m = META[`apis-json|${curSlug}`];
  let key = m?.slug ?? curSlug;
  if (used.has(key)) { let i = 2; while (used.has(`${key}-${i}`)) i++; key = `${key}-${i}`; }
  used.add(key);
  clean.tags = ['format:apis-json', ...metaTags(m), ...(m ? [] : [`category:${inferCategory(origName)}`])];
  out[key] = clean;
}

// ---- validate against the engine, prune throwers ----
const sample = readFileSync(join(ROOT, 'samples', 'apis-json.yaml'), 'utf8');
const sp = new Spotlight();
let prunedConstruct = 0, prunedRun = 0;
async function works(name, rule) {
  try {
    sp.setRuleset(new Ruleset({ rules: { [name]: toJs(stripTags(rule)) } }, { source: 'v' }));
  } catch { return false; }
  try {
    await sp.run(new Document(sample, Yaml, 'apis.json.yaml'));
  } catch { return false; }
  return true;
}
function stripTags(rule) { const { tags, ...rest } = rule; return rest; }

for (const [name, rule] of Object.entries({ ...out })) {
  if (!(await works(name, rule))) {
    delete out[name];
    if (rule.then) prunedRun++; else prunedConstruct++;
  }
}

// ---- emit ----
const header = `# APIs.json default ruleset — compiled from the first-party API Evangelist
# apis-json rules (api-evangelist/rules). Regenerate: node tools/compile-apis-json-rules.mjs
# Positive-confirmation mirror rules are dropped; names de-prefixed; engine-validated.
`;
writeFileSync(join(ROOT, 'rules', 'defaults', 'apis-json.yaml'), header + stringify({ rules: out }));
const cats = {};
for (const r of Object.values(out)) { const c = (r.tags.find((t) => t.startsWith('category:')) || '').slice(9); cats[c] = (cats[c] || 0) + 1; }
console.log(`apis-json: ${Object.keys(out).length} rules (dropped ${dropped} confirmations, pruned ${prunedConstruct + prunedRun})`);
console.log('categories:', JSON.stringify(cats));
