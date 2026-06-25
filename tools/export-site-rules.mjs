#!/usr/bin/env node
// Export every rule (compiled best-of-breed + per-type defaults + built-in
// spotlight:* rules) into the spotlight-rules Jekyll site as:
//   - _data/rule_index.json   : { artifact: [{slug,name,experience,severity}] } (ordered)
//   - _rules/<artifact>/<slug>.md : one collection doc per rule (front matter + description)
// Run from spotlight-validator: node tools/export-site-rules.mjs
import { readFileSync, readdirSync, writeFileSync, mkdirSync, rmSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse, stringify } from 'yaml';
import { createRequire } from 'node:module';
import { checkSkillSync } from './check-skill-sync.mjs';

const require = createRequire(import.meta.url);
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SITE = join(ROOT, '..', 'spotlight-rules');
const RULES_DIR = join(SITE, '_rules');
const rs = require('@spotlight-rules/spotlight-rulesets');
const META = JSON.parse(readFileSync(join(ROOT, 'src', 'builtin-meta.json'), 'utf8'));

const FMT_TO_ARTIFACT = {
  openapi: 'openapi', 'apis-json': 'apis-json', asyncapi: 'asyncapi', arazzo: 'arazzo',
  jsonschema: 'json-schema', 'json-structure': 'json-structure', 'json-ld': 'json-ld',
  plans: 'plans', 'rate-limits': 'rate-limits', finops: 'finops', mcp: 'mcp',
  'agent-skill': 'agent-skill',
};
const ARTIFACT_LABEL = {
  'apis-json': 'APIs.json', openapi: 'OpenAPI', mcp: 'MCP', arazzo: 'Arazzo', asyncapi: 'AsyncAPI',
  'json-schema': 'JSON Schema', 'json-structure': 'JSON Structure', 'json-ld': 'JSON-LD',
  plans: 'Plans', 'rate-limits': 'Rate Limits', finops: 'FinOps',
  'agent-skill': 'Agent Skill',
};
const ACR = { api: 'API', apis: 'APIs', oas: 'OAS', url: 'URL', uri: 'URI', http: 'HTTP', https: 'HTTPS', json: 'JSON', ld: 'LD', id: 'ID', jwt: 'JWT', cors: 'CORS', mcp: 'MCP', sdk: 'SDK' };
const title = (s) => s.split(/[-/_]/).filter(Boolean).filter((w) => !/^oas[23]$/i.test(w)).map((w) => ACR[w.toLowerCase()] ?? w[0].toUpperCase() + w.slice(1)).join(' ');
const givenStr = (g) => (Array.isArray(g) ? g.join(' | ') : String(g ?? ''));
const tagVals = (tags, ns) => (tags || []).filter((t) => t.startsWith(ns + ':')).map((t) => t.slice(ns.length + 1));
const SEV = ['error', 'warn', 'info', 'hint'];
const sevOf = (s) => (typeof s === 'number' ? SEV[s] : s ?? 'warn');

const records = []; // {artifact, slug, name, severity, given, message, description, experience, spec, source, builtin}

// compiled best-of-breed
const compiled = parse(readFileSync(join(ROOT, 'rules', 'spotlight-recommended.yaml'), 'utf8')).rules;
for (const [slug, r] of Object.entries(compiled)) {
  const fmt = tagVals(r.tags, 'format')[0] || 'openapi';
  records.push({ artifact: FMT_TO_ARTIFACT[fmt] || fmt, slug, name: title(slug), severity: sevOf(r.severity),
    given: givenStr(r.given), message: r.message || '', description: r.description || '',
    experience: tagVals(r.tags, 'experience'), spec: tagVals(r.tags, 'spec'), source: tagVals(r.tags, 'source'), builtin: false });
}
// per-type default rulesets
for (const f of readdirSync(join(ROOT, 'rules', 'defaults'))) {
  if (!f.endsWith('.yaml')) continue;
  const def = parse(readFileSync(join(ROOT, 'rules', 'defaults', f), 'utf8')) || {};
  for (const [slug, r] of Object.entries(def.rules || {})) {
    const fmt = tagVals(r.tags, 'format')[0] || f.replace(/\.yaml$/, '');
    records.push({ artifact: FMT_TO_ARTIFACT[fmt] || fmt, slug, name: title(slug), severity: sevOf(r.severity),
      given: givenStr(r.given), message: r.message || '', description: r.description || '',
      experience: tagVals(r.tags, 'experience'), spec: tagVals(r.tags, 'spec'), source: [], builtin: false });
  }
}
// built-in spotlight:* rules
for (const [alias, fmt] of [['oas', 'openapi'], ['asyncapi', 'asyncapi'], ['arazzo', 'arazzo']]) {
  const r = rs[alias];
  for (const [slug, rule] of Object.entries(r?.rules ?? {})) {
    if (/^oas2[-_]/i.test(slug)) continue;
    const m = META[slug] || {};
    records.push({ artifact: FMT_TO_ARTIFACT[fmt], slug, name: title(slug), severity: sevOf(rule.severity),
      given: givenStr(rule.given), message: rule.message || '', description: rule.description || '',
      experience: m.experience || [], spec: m.spec || [], source: [], builtin: true });
  }
}

// order: by artifact (as listed), then by experience then slug
const ARTIFACT_ORDER = ['openapi', 'apis-json', 'asyncapi', 'arazzo', 'json-schema', 'json-structure', 'json-ld', 'mcp', 'plans', 'rate-limits', 'finops', 'agent-skill'];
const byArtifact = {};
for (const r of records) (byArtifact[r.artifact] ??= []).push(r);
const index = {};
if (existsSync(RULES_DIR)) rmSync(RULES_DIR, { recursive: true, force: true });
let written = 0;
for (const art of ARTIFACT_ORDER) {
  const list = (byArtifact[art] || []).sort((a, b) => (a.experience[0] || 'z').localeCompare(b.experience[0] || 'z') || a.slug.localeCompare(b.slug));
  if (!list.length) continue;
  index[art] = { label: ARTIFACT_LABEL[art] || art, rules: list.map((r) => ({ slug: r.slug, name: r.name, experience: r.experience[0] || 'other', severity: r.severity })) };
  mkdirSync(join(RULES_DIR, art), { recursive: true });
  for (const r of list) {
    // description goes in front matter (a value Liquid never re-parses) — its
    // regex/pattern text often contains `{`/`{{` that would break a Liquid body.
    const fm = stringify({
      layout: 'rule', artifact: art, artifact_label: ARTIFACT_LABEL[art] || art, slug: r.slug, title: r.name,
      severity: r.severity, given: r.given, message: r.message, description: r.description,
      experience: r.experience, spec: r.spec, source: r.source, builtin: r.builtin,
    }).trimEnd();
    writeFileSync(join(RULES_DIR, art, `${r.slug}.md`), `---\n${fm}\n---\n`);
    written++;
  }
}
mkdirSync(join(SITE, '_data'), { recursive: true });
writeFileSync(join(SITE, '_data', 'rule_index.json'), JSON.stringify(index, null, 1));
console.log(`exported ${written} rule pages across ${Object.keys(index).length} artifacts`);
for (const [a, v] of Object.entries(index)) console.log(`  ${a}: ${v.rules.length}`);

// Guard: the agent-skill catalog must mirror the executable spotlight:skill ruleset.
if (!checkSkillSync()) {
  console.error('Catalog drift detected — fix rules/defaults/agent-skill.yaml to match spotlight:skill.');
  process.exit(1);
}
