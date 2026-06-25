// Drift guard: the executable spotlight:skill ruleset (in spotlight-cli) and the
// agent-skill rule catalog (rules/defaults/agent-skill.yaml, which feeds the spec
// site) must list the SAME rule names. The catalog is hand-maintained only because
// the engine isn't published yet (see no-publish-until-1.0); this keeps it honest.
//
// Run: node tools/check-skill-sync.mjs   (also runs at the end of export-site-rules.mjs)
import { readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const CLI_SKILL = join(ROOT, '..', 'spotlight-cli', 'packages', 'rulesets', 'src', 'skill', 'index.ts');
const CATALOG = join(ROOT, 'rules', 'defaults', 'agent-skill.yaml');

// Rule name → severity from the cli ruleset (4-space-indented quoted 'skill-*' keys,
// each block carrying a `severity: '...'`). Default severity is 'warn' when omitted.
function cliRules(src) {
  const keys = [...src.matchAll(/^ {4}'(skill-[a-z0-9-]+)':/gm)];
  const out = new Map();
  for (let i = 0; i < keys.length; i++) {
    const block = src.slice(keys[i].index, i + 1 < keys.length ? keys[i + 1].index : src.length);
    const sev = /severity:\s*'(\w+)'/.exec(block);
    out.set(keys[i][1], sev ? sev[1] : 'warn');
  }
  return out;
}
const catalogRules = (yamlText) =>
  new Map(Object.entries((parse(yamlText) || {}).rules || {}).map(([k, v]) => [k, v?.severity ?? 'warn']));

export function checkSkillSync() {
  if (!existsSync(CLI_SKILL)) {
    console.warn(`skill-sync: cannot find ${CLI_SKILL} (spotlight-cli not a sibling checkout) — skipping.`);
    return true;
  }
  const cli = cliRules(readFileSync(CLI_SKILL, 'utf8'));
  const catalog = catalogRules(readFileSync(CATALOG, 'utf8'));
  if (cli.size === 0) {
    console.warn('skill-sync: parsed 0 rules from the cli ruleset — skipping (check the regex).');
    return true;
  }
  const onlyCli = [...cli.keys()].filter((n) => !catalog.has(n));
  const onlyCatalog = [...catalog.keys()].filter((n) => !cli.has(n));
  const sevMismatch = [...cli.keys()].filter((n) => catalog.has(n) && cli.get(n) !== catalog.get(n));
  if (onlyCli.length === 0 && onlyCatalog.length === 0 && sevMismatch.length === 0) {
    console.log(`skill-sync: OK — ${cli.size} rules match (name + severity) between spotlight:skill and the catalog.`);
    return true;
  }
  console.error('skill-sync: DRIFT between spotlight:skill (cli) and rules/defaults/agent-skill.yaml');
  if (onlyCli.length) console.error('  in cli but NOT catalog:', onlyCli.join(', '));
  if (onlyCatalog.length) console.error('  in catalog but NOT cli:', onlyCatalog.join(', '));
  for (const n of sevMismatch) console.error(`  severity mismatch: ${n} — cli '${cli.get(n)}' vs catalog '${catalog.get(n)}'`);
  return false;
}

// Run directly → exit non-zero on drift (so it can gate CI / pre-commit).
if (import.meta.url === `file://${process.argv[1]}`) {
  process.exit(checkSkillSync() ? 0 : 1);
}
