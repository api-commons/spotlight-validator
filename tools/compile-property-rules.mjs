#!/usr/bin/env node
// Generate basic "property should be present" (truthy) default rulesets for the
// artifact types that don't yet have a crafted ruleset. One truthy rule per known
// property of each format, engine-validated. Re-run after editing PROPERTIES.
//
// Emits rules/defaults/<id>.yaml for: mcp, json-schema, json-structure, json-ld,
// plans, rate-limits, finops. (apis-json, openapi, asyncapi, arazzo are left alone.)

import { writeFileSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { stringify } from 'yaml';
import core from '@spotlight-rules/spotlight-core';
import * as builtins from '@spotlight-rules/spotlight-functions';
import parsersNs from '@spotlight-rules/spotlight-parsers';

const { Spotlight, Document, Ruleset } = core;
const Yaml = parsersNs.Yaml ?? parsersNs.default?.Yaml;
const FN = { ...builtins };
const toJs = (n) => Array.isArray(n) ? n.map(toJs)
  : n && typeof n === 'object' ? Object.fromEntries(Object.entries(n).map(([k, v]) =>
      k === 'function' && typeof v === 'string' ? [k, FN[v] ?? v] : [k, toJs(v)])) : n;
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const META = (() => { try { return JSON.parse(readFileSync(join(ROOT, 'tools', 'rule-meta.json'), 'utf8')); } catch { return {}; } })();
const metaTags = (m) => [...(m?.spec ?? []).map((s) => `spec:${s}`), ...(m?.experience ?? []).map((e) => `experience:${e}`)];

// sev: 0 error, 1 warn, 2 info. Each group: { given, item, props: [[field, sev], …] }
const PROPERTIES = {
  mcp: { format: 'mcp', groups: [
    { given: '$', props: [['name', 0], ['version', 1], ['description', 1], ['protocolVersion', 2], ['capabilities', 1], ['instructions', 2]] },
    { given: '$.capabilities', item: 'capability', props: [['tools', 2], ['resources', 2], ['prompts', 2]] },
  ] },
  'json-schema': { format: 'jsonschema', groups: [
    { given: '$', props: [['$schema', 1], ['$id', 2], ['title', 2], ['description', 2], ['type', 1], ['properties', 2], ['required', 2]] },
    { given: '$.properties[*]', item: 'property', props: [['type', 2], ['description', 2]] },
  ] },
  'json-structure': { format: 'json-structure', groups: [
    { given: '$', props: [['$schema', 1], ['$id', 2], ['name', 2], ['type', 1], ['properties', 2]] },
    { given: '$.properties[*]', item: 'property', props: [['type', 2]] },
  ] },
  'json-ld': { format: 'json-ld', groups: [
    { given: '$', props: [['@context', 0], ['@type', 1], ['@id', 2]] },
  ] },
  plans: { format: 'plans', groups: [
    { given: '$', props: [['name', 0], ['description', 2], ['currency', 2], ['plans', 0]] },
    { given: '$.plans[*]', item: 'plan', props: [['name', 0], ['description', 2], ['price', 1], ['features', 2], ['limits', 2]] },
  ] },
  'rate-limits': { format: 'rate-limits', groups: [
    { given: '$', props: [['name', 0], ['description', 2], ['limits', 0]] },
    { given: '$.limits[*]', item: 'limit', props: [['name', 1], ['window', 1], ['max', 1], ['scope', 2]] },
  ] },
  finops: { format: 'finops', groups: [
    { given: '$', props: [['name', 0], ['description', 2], ['currency', 1], ['budget', 1], ['costs', 2]] },
    { given: '$.costs[*]', item: 'cost', props: [['service', 1], ['monthly', 2]] },
  ] },
};

const SEV = ['error', 'warn', 'info'];
const sanitize = (f) => f.replace(/^[@$]/, '').replace(/[^a-z0-9]+/gi, '-').toLowerCase();
function inferCategory(field) {
  const f = field.toLowerCase();
  if (/(name|title|description|summary|label|@context|@type)/.test(f)) return /context|type/.test(f) ? 'structure' : 'documentation';
  if (/version/.test(f)) return 'versioning';
  return 'structure';
}

const sp = new Spotlight();
const sample = '{}\n'; // truthy rules never throw on an empty doc; we only check construct+run
let totalRules = 0;
for (const [id, cfg] of Object.entries(PROPERTIES)) {
  const rules = {};
  const used = new Set();
  for (const g of cfg.groups) {
    for (const [field, sev] of g.props) {
      const prefix = g.item ? `${id}-${g.item}-` : `${id}-`;
      const curSlug = prefix + sanitize(field);
      const m = META[`${cfg.format}|${curSlug}`];
      let key = m?.slug ?? curSlug;
      if (used.has(key)) { let i = 2; while (used.has(`${key}-${i}`)) i++; key = `${key}-${i}`; }
      used.add(key);
      const where = g.given === '$' ? '' : ` of each ${g.item}`;
      rules[key] = {
        description: `The \`${field}\` property${where} should be present.`,
        message: `${field} should be present`,
        severity: SEV[sev],
        given: g.given,
        then: { field, function: 'truthy' },
        tags: [`format:${cfg.format}`, ...metaTags(m), ...(m ? [] : [`category:${inferCategory(field)}`])],
      };
    }
  }
  // engine-validate
  let pruned = 0;
  for (const [name, rule] of Object.entries({ ...rules })) {
    const { tags, ...rest } = rule;
    try {
      sp.setRuleset(new Ruleset(toJs({ rules: { [name]: rest } }), { source: 'v' }));
      await sp.run(new Document(sample, Yaml, 'd.yaml'));
    } catch { delete rules[name]; pruned++; }
  }
  const header = `# ${id} default ruleset — basic "property should be present" rules (one truthy
# rule per known property). A starting point; generated by tools/compile-property-rules.mjs.
`;
  writeFileSync(join(ROOT, 'rules', 'defaults', `${id}.yaml`), header + stringify({ rules }));
  totalRules += Object.keys(rules).length;
  console.log(`${id.padEnd(15)} ${Object.keys(rules).length} rules${pruned ? ` (pruned ${pruned})` : ''}`);
}
console.log(`total: ${totalRules} property rules across ${Object.keys(PROPERTIES).length} types`);
