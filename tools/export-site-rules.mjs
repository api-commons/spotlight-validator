#!/usr/bin/env node
// Export every rule from rules/all-rules.yaml — the single consolidated source of
// truth (compiled best-of-breed + per-type defaults + built-in spotlight:* rules,
// carrying the Spotlight extensions title / tags / reference) — into the
// spotlight-rules Jekyll site:
//   - _data/rule_index.json       : { artifact: {label, rules:[{slug,name,experience,severity}]} }
//   - _rules/<artifact>/<slug>.md : one collection doc per rule (front matter + description)
// Run from spotlight-validator: node tools/export-site-rules.mjs
import { readFileSync, writeFileSync, mkdirSync, rmSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse, stringify } from 'yaml';
import { checkSkillSync } from './check-skill-sync.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SITE = join(ROOT, '..', 'spotlight-rules');
const RULES_DIR = join(SITE, '_rules');
const ARTIFACTS_DIR = join(SITE, '_artifacts');

// all-rules.yaml is grouped by format; the site uses an artifact id (json-schema, not jsonschema).
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
const ARTIFACT_DESC = {
  openapi: 'REST API descriptions — paths, operations, schemas, and security.',
  'apis-json': 'API discovery metadata — providers, APIs, and their artifacts.',
  asyncapi: 'Event-driven API descriptions — channels, messages, and operations.',
  arazzo: 'API workflow descriptions — multi-step calls across operations.',
  'json-schema': 'JSON Schema documents — types, constraints, and validation.',
  'json-structure': 'JSON Structure documents — data shapes and modeling.',
  'json-ld': 'Linked-data JSON — context, identifiers, and vocabularies.',
  mcp: 'Model Context Protocol servers — tools, resources, and prompts.',
  plans: 'API product plans — tiers, limits, and pricing.',
  'rate-limits': 'Rate-limit descriptions — quotas, windows, and policies.',
  finops: 'FinOps artifacts — cost, usage, and billing governance.',
  'agent-skill': 'Agent skills — SKILL.md metadata and tooling.',
};
const givenStr = (g) => (Array.isArray(g) ? g.join(' | ') : String(g ?? ''));
const tagVals = (tags, ns) => (tags || []).filter((t) => t.startsWith(ns + ':')).map((t) => t.slice(ns.length + 1));
const SEV = ['error', 'warn', 'info', 'hint'];
const sevOf = (s) => (typeof s === 'number' ? SEV[s] : s ?? 'info');

// Single source of truth: rules/all-rules.yaml (grouped by artifact format).
const all = parse(readFileSync(join(ROOT, 'rules', 'all-rules.yaml'), 'utf8'));
const records = [];
for (const [fmt, rules] of Object.entries(all)) {
  const artifact = FMT_TO_ARTIFACT[fmt] || fmt;
  for (const [slug, r] of Object.entries(rules)) {
    records.push({
      artifact, slug, name: r.title || slug, severity: sevOf(r.severity),
      given: givenStr(r.given), message: r.message || '', description: r.description || '',
      experience: tagVals(r.tags, 'experience'), spec: tagVals(r.tags, 'spec'),
      topic: tagVals(r.tags, 'topic'), owasp: tagVals(r.tags, 'owasp'),
      reference: r.reference || '', prompt: r.prompt || '', builtin: r.source === 'builtin',
    });
  }
}

// order: by artifact (as listed), then by experience then slug
const ARTIFACT_ORDER = ['openapi', 'apis-json', 'asyncapi', 'arazzo', 'json-schema', 'json-structure', 'json-ld', 'mcp', 'plans', 'rate-limits', 'finops', 'agent-skill'];
const byArtifact = {};
for (const r of records) (byArtifact[r.artifact] ??= []).push(r);
const index = {};
if (existsSync(RULES_DIR)) rmSync(RULES_DIR, { recursive: true, force: true });
if (existsSync(ARTIFACTS_DIR)) rmSync(ARTIFACTS_DIR, { recursive: true, force: true });
mkdirSync(ARTIFACTS_DIR, { recursive: true });
let written = 0;
for (const art of ARTIFACT_ORDER) {
  // alphabetical by display name (also orders the per-rule prev/next nav)
  const list = (byArtifact[art] || []).sort((a, b) => a.name.localeCompare(b.name));
  if (!list.length) continue;
  index[art] = {
    label: ARTIFACT_LABEL[art] || art,
    description: ARTIFACT_DESC[art] || '',
    rules: list.map((r) => ({
      slug: r.slug, name: r.name, severity: r.severity, description: r.description,
      experience: r.experience, spec: r.spec, topic: r.topic, owasp: r.owasp,
    })),
  };
  // One thin collection doc per artifact; the `artifact` layout renders the
  // listing + filter from site.data.rule_index[artifact].
  writeFileSync(join(ARTIFACTS_DIR, `${art}.md`),
    `---\n${stringify({ layout: 'artifact', artifact: art, title: ARTIFACT_LABEL[art] || art }).trimEnd()}\n---\n`);
  mkdirSync(join(RULES_DIR, art), { recursive: true });
  for (const r of list) {
    // description goes in front matter (a value Liquid never re-parses) — its
    // regex/pattern text often contains `{`/`{{` that would break a Liquid body.
    const fm = stringify({
      layout: 'rule', artifact: art, artifact_label: ARTIFACT_LABEL[art] || art, slug: r.slug, title: r.name,
      severity: r.severity, given: r.given, message: r.message, description: r.description,
      experience: r.experience, spec: r.spec, topic: r.topic, owasp: r.owasp,
      reference: r.reference, prompt: r.prompt, builtin: r.builtin,
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
  console.error('Catalog drift detected — align the agent-skill rules in rules/all-rules.yaml with spotlight:skill.');
  process.exit(1);
}
