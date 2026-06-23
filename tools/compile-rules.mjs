#!/usr/bin/env node
// Compile the best-of-breed ruleset from rules/sources/* into a single tagged,
// namespaced ruleset. Each rule is prefixed with its source and tagged with
// `source:<id>`, `format:<fmt>`, and `category:<cat>` so the validator can let
// users select rules by tag.
//
// Rules that depend on custom (non-built-in) functions are skipped for now, so
// the compiled ruleset runs in the browser with no custom function code. The
// raw sources are kept under rules/sources/ for reference and future curation.

import { readFileSync, readdirSync, writeFileSync, existsSync, statSync } from 'node:fs';
import { join, dirname, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse, stringify } from 'yaml';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SRC = join(ROOT, 'rules', 'sources');

// Built-in Spotlight/Spectral functions — rules using only these need no custom code.
// Must match the exports of @spotlight-rules/spotlight-functions.
const BUILTINS = new Set([
  'alphabetical', 'casing', 'defined', 'enumeration', 'falsy', 'length', 'pattern',
  'schema', 'truthy', 'undefined', 'unreferencedReusableObject', 'xor', 'or',
]);

// source id -> { label, format }
const SOURCES = {
  'adidas.yaml': { id: 'adidas', label: 'Adidas', format: 'openapi' },
  'baloise.yaml': { id: 'baloise', label: 'Baloise', format: 'openapi' },
  'digitalocean.yaml': { id: 'digitalocean', label: 'DigitalOcean', format: 'openapi' },
  'microcks.yaml': { id: 'microcks', label: 'Microcks', format: 'openapi' },
  'paystack.yaml': { id: 'paystack', label: 'Paystack', format: 'openapi' },
  'schwarz-it.yaml': { id: 'schwarz-it', label: 'Schwarz IT', format: 'openapi' },
  'team-digitale.yaml': { id: 'team-digitale', label: 'Team Digitale', format: 'openapi' },
  'trimble.yaml': { id: 'trimble', label: 'Trimble', format: 'openapi' },
};
// directory sources: each file is a category
const DIR_SOURCES = {
  'sps-commerce': { id: 'sps-commerce', label: 'SPS Commerce', format: 'openapi' },
  'italia': { id: 'italia', label: 'Italian Government', format: 'openapi' },
};

// crude category inference from a rule name / file name
const CATEGORY_KEYWORDS = [
  ['security', /secur|auth|oauth|https|secret|cors|jwt|scope/i],
  ['naming', /nam|casing|case|kebab|camel|snake|pascal/i],
  ['documentation', /doc|description|summary|example|comment|contact|license|info/i],
  ['versioning', /version|deprecat/i],
  ['pagination', /pagina|cursor|limit|offset/i],
  ['errors', /error|problem|4xx|5xx|status/i],
  ['structure', /path|url|resource|tag|operation|param|schema|response|request|header|media|ref/i],
];
function inferCategory(name, fileHint) {
  const hint = (fileHint || '').toLowerCase();
  for (const [cat, re] of CATEGORY_KEYWORDS) if (re.test(hint)) return cat;
  for (const [cat, re] of CATEGORY_KEYWORDS) if (re.test(name)) return cat;
  return 'general';
}

function usesOnlyBuiltins(rule) {
  if (rule === null || typeof rule !== 'object') return true; // severity/boolean toggles
  const then = rule.then;
  if (then === undefined) return true;
  const arr = Array.isArray(then) ? then : [then];
  return arr.every((t) => t && typeof t === 'object' && (t.function === undefined || BUILTINS.has(t.function)));
}

const compiled = {};
const stats = {};
function addSource(srcId, label, format, rulesObj, fileHint) {
  if (!rulesObj || typeof rulesObj !== 'object') return;
  stats[srcId] ??= { kept: 0, skipped: 0 };
  for (const [name, rule] of Object.entries(rulesObj)) {
    if (rule === false || rule === 'off') continue; // disabled toggles add nothing
    if (typeof rule === 'object' && rule !== null && !usesOnlyBuiltins(rule)) {
      stats[srcId].skipped++;
      continue;
    }
    if (typeof rule !== 'object' || rule === null) {
      // severity/boolean toggle of a (likely) built-in oas rule — skip (handled by extends oas)
      continue;
    }
    const key = `${srcId}/${name}`;
    const category = inferCategory(name, fileHint);
    const tags = [...new Set([...(rule.tags || []), `source:${srcId}`, `format:${format}`, `category:${category}`])];
    // whitelist valid rule keys (drop vendor extras like category/howToFix/id)
    const VALID = new Set(['description', 'documentationUrl', 'recommended', 'given', 'resolved', 'severity', 'message', 'formats', 'then', 'type', 'extensions']);
    const clean = {};
    for (const [k, v] of Object.entries(rule)) if (VALID.has(k) || k.startsWith('x-')) clean[k] = v;
    compiled[key] = { ...clean, tags, description: rule.description || name };
    stats[srcId].kept++;
  }
}

// single-file sources
for (const [file, meta] of Object.entries(SOURCES)) {
  const p = join(SRC, file);
  if (!existsSync(p)) continue;
  let doc;
  try { doc = parse(readFileSync(p, 'utf8'), { merge: true }); } catch (e) { console.error('parse', file, e.message); continue; }
  addSource(meta.id, meta.label, meta.format, doc?.rules, file);
}
// directory sources (per-file category)
for (const [dir, meta] of Object.entries(DIR_SOURCES)) {
  const dp = join(SRC, dir);
  if (!existsSync(dp) || !statSync(dp).isDirectory()) continue;
  for (const file of readdirSync(dp)) {
    if (!/\.ya?ml$/.test(file)) continue;
    let doc;
    try { doc = parse(readFileSync(join(dp, file), 'utf8'), { merge: true }); } catch (e) { console.error('parse', dir, file, e.message); continue; }
    addSource(meta.id, meta.label, meta.format, doc?.rules, basename(file, '.yml'));
  }
}

// Validate against the actual engine and prune any rule it rejects, so the
// shipped ruleset is guaranteed to construct in the browser.
const { createRequire } = await import('node:module');
const require = createRequire(import.meta.url);
const core = require('@spotlight-rules/spotlight-core');
const fns = require('@spotlight-rules/spotlight-functions');
const fmts = require('@spotlight-rules/spotlight-formats');
const { oas } = require('@spotlight-rules/spotlight-rulesets');
const FA = { 'oas3.0': 'oas3_0', 'oas3.1': 'oas3_1' };
const lf = (n) => fmts[FA[n] ?? n] ?? fmts[n];
const toJs = (node) =>
  Array.isArray(node) ? node.map(toJs)
  : node && typeof node === 'object'
    ? Object.fromEntries(Object.entries(node).map(([k, v]) =>
        k === 'function' && typeof v === 'string' ? [k, fns[v] ?? v]
        : k === 'formats' && Array.isArray(v) ? [k, v.map((f) => (typeof f === 'string' ? lf(f) : f)).filter(Boolean)]
        : [k, toJs(v)]))
    : node;

let pruned = 0;
for (let i = 0; i < 50; i++) {
  try {
    new core.Ruleset({ ...toJs({ rules: compiled }), extends: [[oas, 'recommended']] }, { source: 'compile' });
    break;
  } catch (e) {
    const errs = e?.errors ?? [];
    // path segments are JSON-pointer-escaped (~1 = /, ~0 = ~); un-escape to match rule keys
    const unesc = (k) => String(k).replace(/~1/g, '/').replace(/~0/g, '~');
    const bad = new Set(errs.map((x) => x?.path?.[1]).filter(Boolean).map(unesc));
    if (bad.size === 0) { console.error('unprunable error:', e.message); break; }
    for (const k of bad) { delete compiled[k]; pruned++; }
  }
}

const ruleset = {
  description: 'Spotlight best-of-breed OpenAPI governance ruleset, compiled from public Spectral rulesets. Built-in functions only; select rules with tags (source:*, category:*, format:*).',
  documentationUrl: 'https://github.com/api-commons/spotlight-validator',
  extends: [['spotlight:oas', 'recommended']],
  rules: compiled,
};

writeFileSync(join(ROOT, 'rules', 'spotlight-recommended.yaml'), stringify(ruleset));
writeFileSync(join(ROOT, 'src', 'compiled-ruleset.json'), JSON.stringify(ruleset, null, 2) + '\n');

const total = Object.keys(compiled).length;
console.log(`compiled ${total} rules (built-in functions only)`);
for (const [src, s] of Object.entries(stats)) console.log(`  ${src.padEnd(16)} kept ${s.kept}, skipped(custom-fn) ${s.skipped}`);
