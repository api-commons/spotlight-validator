#!/usr/bin/env node
// Compile the best-of-breed ruleset from rules/sources/* into a tagged,
// namespaced ruleset. Rules using built-in functions OR custom functions we have
// fetched into src/functions/<source>/ are kept; the rest are skipped.
//
// Emits:
//   src/compiled-ruleset.ts  — imports built-in + custom functions and exports
//                              { functions, ruleset } (function refs are strings
//                              resolved via the functions map at lint time).
//   rules/spotlight-recommended.yaml — human-readable.
//
// Rules are validated against the real engine and pruned if invalid.

import { readFileSync, readdirSync, writeFileSync, existsSync, statSync } from 'node:fs';
import { join, dirname, basename } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';
import { parse, stringify } from 'yaml';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SRC = join(ROOT, 'rules', 'sources');
const FN_DIR = join(ROOT, 'src', 'functions');
const require = createRequire(import.meta.url);
const builtins = require('@spotlight-rules/spotlight-functions');
const BUILTINS = new Set(Object.keys(builtins).filter((k) => typeof builtins[k] === 'function'));

// available custom functions: source -> Set(basename)
const customFns = {};
if (existsSync(FN_DIR)) {
  for (const src of readdirSync(FN_DIR)) {
    const d = join(FN_DIR, src);
    if (!statSync(d).isDirectory()) continue;
    customFns[src] = new Set(readdirSync(d).filter((f) => /\.m?js$/.test(f)).map((f) => f.replace(/\.m?js$/, '')));
  }
}

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
const DIR_SOURCES = {
  'sps-commerce': { id: 'sps-commerce', label: 'SPS Commerce', format: 'openapi' },
  italia: { id: 'italia', label: 'Italian Government', format: 'openapi' },
};

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

// What functions does a rule's `then` reference, and can we satisfy all of them?
// Returns { ok, customImports: [{ ns, src, fn }] } and mutates `then` to namespace customs.
function resolveFunctions(then, srcId) {
  const arr = Array.isArray(then) ? then : [then];
  const customImports = [];
  for (const t of arr) {
    if (!t || typeof t !== 'object' || t.function === undefined) continue;
    const fn = t.function;
    if (typeof fn !== 'string' || BUILTINS.has(fn)) continue;
    if (customFns[srcId]?.has(fn)) {
      const ns = `${srcId}:${fn}`;
      t.function = ns;
      customImports.push({ ns, src: srcId, fn });
    } else {
      return { ok: false, customImports: [] };
    }
  }
  return { ok: true, customImports };
}

const compiled = {};
const usedCustom = new Map(); // ns -> { src, fn }
const stats = {};
const VALID = new Set(['description', 'documentationUrl', 'recommended', 'given', 'resolved', 'severity', 'message', 'formats', 'then', 'type', 'extensions']);

function addSource(srcId, format, rulesObj, fileHint) {
  if (!rulesObj || typeof rulesObj !== 'object') return;
  stats[srcId] ??= { kept: 0, skipped: 0 };
  for (const [name, rule] of Object.entries(rulesObj)) {
    if (rule === false || rule === 'off') continue;
    if (typeof rule !== 'object' || rule === null) continue; // bare severity toggles handled by extends oas
    const clean = {};
    for (const [k, v] of Object.entries(rule)) if (VALID.has(k) || k.startsWith('x-')) clean[k] = structuredClone(v);
    if (clean.then !== undefined) {
      const res = resolveFunctions(clean.then, srcId);
      if (!res.ok) { stats[srcId].skipped++; continue; }
      for (const ci of res.customImports) usedCustom.set(ci.ns, { src: ci.src, fn: ci.fn });
    }
    const category = inferCategory(name, fileHint);
    const tags = [...new Set([...(rule.tags || []), `source:${srcId}`, `format:${format}`, `category:${category}`])];
    compiled[`${srcId}/${name}`] = { ...clean, tags, description: clean.description || name };
    stats[srcId].kept++;
  }
}

for (const [file, meta] of Object.entries(SOURCES)) {
  const p = join(SRC, file);
  if (!existsSync(p)) continue;
  let doc; try { doc = parse(readFileSync(p, 'utf8'), { merge: true }); } catch { continue; }
  addSource(meta.id, meta.format, doc?.rules, file);
}
for (const [dir, meta] of Object.entries(DIR_SOURCES)) {
  const dp = join(SRC, dir);
  if (!existsSync(dp) || !statSync(dp).isDirectory()) continue;
  for (const file of readdirSync(dp)) {
    if (!/\.ya?ml$/.test(file)) continue;
    let doc; try { doc = parse(readFileSync(join(dp, file), 'utf8'), { merge: true }); } catch { continue; }
    addSource(meta.id, meta.format, doc?.rules, basename(file, '.yml'));
  }
}

// ---- validate against the engine; build the function map; prune invalid rules
const core = require('@spotlight-rules/spotlight-core');
const fmts = require('@spotlight-rules/spotlight-formats');
const { oas } = require('@spotlight-rules/spotlight-rulesets');
const FA = { 'oas3.0': 'oas3_0', 'oas3.1': 'oas3_1' };
const lf = (n) => fmts[FA[n] ?? n] ?? fmts[n];

const fnMap = { ...builtins };
for (const [ns, { src, fn }] of usedCustom) {
  let file = join(FN_DIR, src, `${fn}.js`);
  if (!existsSync(file)) file = join(FN_DIR, src, `${fn}.mjs`);
  const mod = await import(pathToFileURL(file).href);
  fnMap[ns] = mod.default ?? mod;
}
const toJs = (node) =>
  Array.isArray(node) ? node.map(toJs)
  : node && typeof node === 'object'
    ? Object.fromEntries(Object.entries(node).map(([k, v]) =>
        k === 'function' && typeof v === 'string' ? [k, fnMap[v] ?? v]
        : k === 'formats' && Array.isArray(v) ? [k, v.map((f) => (typeof f === 'string' ? lf(f) : f)).filter(Boolean)]
        : [k, toJs(v)]))
    : node;

let pruned = 0;
for (let i = 0; i < 80; i++) {
  try { new core.Ruleset({ ...toJs({ rules: compiled }), extends: [[oas, 'recommended']] }, { source: 'compile' }); break; }
  catch (e) {
    const unesc = (k) => String(k).replace(/~1/g, '/').replace(/~0/g, '~');
    const bad = new Set((e?.errors ?? []).map((x) => x?.path?.[1]).filter(Boolean).map(unesc));
    if (bad.size === 0) { console.error('unprunable:', e.message); break; }
    for (const k of bad) { delete compiled[k]; pruned++; }
  }
}
// ---- mark exact-duplicate rules (same given + same then) across sources.
// Keep the first occurrence canonical; tag the rest `duplicate:true`.
const sigSeen = new Map();
let dupes = 0;
for (const [key, rule] of Object.entries(compiled)) {
  const sig = JSON.stringify([rule.given, rule.then]);
  if (sigSeen.has(sig)) {
    rule.tags = [...new Set([...(rule.tags || []), 'duplicate:true', `dup-of:${sigSeen.get(sig)}`])];
    dupes++;
  } else {
    sigSeen.set(sig, key);
  }
}

// drop now-unused custom imports (their rule may have been pruned)
const stillUsed = new Set();
for (const r of Object.values(compiled)) for (const t of (Array.isArray(r.then) ? r.then : [r.then])) if (t?.function && usedCustom.has(t.function)) stillUsed.add(t.function);

const ruleset = {
  description: 'Spotlight best-of-breed API governance ruleset, compiled from public Spectral rulesets. Select rules with tags (source:*, category:*, format:*).',
  documentationUrl: 'https://github.com/api-commons/spotlight-validator',
  extends: [['spotlight:oas', 'recommended']],
  rules: compiled,
};

// ---- emit the TS module
const imports = [];
const mapEntries = [];
let idx = 0;
for (const ns of stillUsed) {
  const { src, fn } = usedCustom.get(ns);
  const ext = existsSync(join(FN_DIR, src, `${fn}.js`)) ? 'js' : 'mjs';
  const local = `f${idx++}`;
  imports.push(`import ${local} from './functions/${src}/${fn}.${ext}';`);
  mapEntries.push(`  ${JSON.stringify(ns)}: ${local},`);
}
const ts = `/* GENERATED by tools/compile-rules.mjs — do not edit. */
import * as builtins from '@spotlight-rules/spotlight-functions';
${imports.join('\n')}

export const functions: Record<string, unknown> = {
  ...builtins,
${mapEntries.join('\n')}
};

export const ruleset = ${JSON.stringify(ruleset, null, 2)} as const;
`;
writeFileSync(join(ROOT, 'src', 'compiled-ruleset.ts'), ts);
writeFileSync(join(ROOT, 'rules', 'spotlight-recommended.yaml'), stringify(ruleset));

console.log(`compiled ${Object.keys(compiled).length} rules (${stillUsed.size} custom functions, pruned ${pruned}, ${dupes} exact duplicates tagged)`);
for (const [src, s] of Object.entries(stats)) console.log(`  ${src.padEnd(16)} kept ${s.kept}, skipped ${s.skipped}`);
