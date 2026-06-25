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

// Rule keys in the cli ruleset are 4-space-indented quoted 'skill-*' object keys.
const cliRuleNames = (src) => [...src.matchAll(/^ {4}'(skill-[a-z0-9-]+)':/gm)].map((m) => m[1]);

export function checkSkillSync() {
  if (!existsSync(CLI_SKILL)) {
    console.warn(`skill-sync: cannot find ${CLI_SKILL} (spotlight-cli not a sibling checkout) — skipping.`);
    return true;
  }
  const cli = new Set(cliRuleNames(readFileSync(CLI_SKILL, 'utf8')));
  const catalog = new Set(Object.keys((parse(readFileSync(CATALOG, 'utf8')) || {}).rules || {}));
  if (cli.size === 0) {
    console.warn('skill-sync: parsed 0 rules from the cli ruleset — skipping (check the regex).');
    return true;
  }
  const onlyCli = [...cli].filter((n) => !catalog.has(n));
  const onlyCatalog = [...catalog].filter((n) => !cli.has(n));
  if (onlyCli.length === 0 && onlyCatalog.length === 0) {
    console.log(`skill-sync: OK — ${cli.size} rules match between spotlight:skill and the catalog.`);
    return true;
  }
  console.error('skill-sync: DRIFT between spotlight:skill (cli) and rules/defaults/agent-skill.yaml');
  if (onlyCli.length) console.error('  in cli but NOT catalog:', onlyCli.join(', '));
  if (onlyCatalog.length) console.error('  in catalog but NOT cli:', onlyCatalog.join(', '));
  return false;
}

// Run directly → exit non-zero on drift (so it can gate CI / pre-commit).
if (import.meta.url === `file://${process.argv[1]}`) {
  process.exit(checkSkillSync() ? 0 : 1);
}
