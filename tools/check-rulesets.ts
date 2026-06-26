// CI gate: build the active ruleset for every artifact format from the curated
// catalog (src/all-rules.json) the way the app does, construct it with the real
// Spotlight engine, and lint a representative sample. Fails if any format errors
// (a malformed `given`, an unresolved function, a bad `extends`). This is the
// sweep that caught the json-ld `$.@id` and the stray `$.paths.` trailing dot.
//
// Run: npm run check:rulesets
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { Spotlight, Document, Ruleset } = require('@spotlight-rules/spotlight-core');
const Parsers = require('@spotlight-rules/spotlight-parsers');
const { oas, asyncapi, arazzo } = require('@spotlight-rules/spotlight-rulesets');
const fmts = require('@spotlight-rules/spotlight-formats');
import { functions as compiledFunctions } from '../src/compiled-ruleset';
import * as skillFunctions from '../src/skill-functions';
import { Markdown } from '../src/markdown';
import all from '../src/all-rules.json';

const FN_MAP: any = { ...compiledFunctions, ...skillFunctions };
const BUILTIN: any = { 'spotlight:oas': oas, 'spotlight:asyncapi': asyncapi, 'spotlight:arazzo': arazzo };
const EXTENDS_FOR: any = { openapi: 'spotlight:oas', asyncapi: 'spotlight:asyncapi', arazzo: 'spotlight:arazzo' };
const FMT_ALIAS: any = { 'json-schema': 'jsonSchema', jsonschema: 'jsonSchema', 'oas3.0': 'oas3_0', 'oas3.1': 'oas3_1' };
const lookF = (n: string) => fmts[FMT_ALIAS[n] ?? n] ?? fmts[n];
const toJs = (node: any): any => {
  if (Array.isArray(node)) return node.map(toJs);
  if (node && typeof node === 'object') {
    const o: any = {};
    for (const [k, v] of Object.entries(node)) {
      if (k === 'function' && typeof v === 'string') o[k] = FN_MAP[v] ?? v;
      else if (k === 'formats' && Array.isArray(v)) o[k] = v.map((f: any) => (typeof f === 'string' ? lookF(f) : f)).filter(Boolean);
      else o[k] = toJs(v);
    }
    return o;
  }
  return node;
};
const resolveExt = (e: any): any => (Array.isArray(e) ? e : [e]).map((x: any) => (typeof x === 'string' ? BUILTIN[x] ?? x : x));
const engineRule = (r: any) => { const { source, title, reference, prompt, _format, ...rest } = r; return rest; };
function defFor(fmt: string) {
  const rules: any = {};
  for (const [n, r] of Object.entries<any>((all as any)[fmt] || {})) { if (r.source === 'builtin') continue; rules[n] = toJs(engineRule(r)); }
  const ext = EXTENDS_FOR[fmt];
  return ext ? { rules, extends: resolveExt(ext) } : { rules };
}

const SAMPLES: Record<string, string> = {
  openapi: 'openapi: "3.0.0"\ninfo: {title: t, version: "1"}\nservers: [{url: "https://x.com/v1"}]\npaths:\n  /things:\n    get:\n      operationId: getThings\n      responses: {"200": {description: ok}}',
  asyncapi: 'asyncapi: "2.6.0"\ninfo: {title: t, version: "1"}\nchannels:\n  c: {description: x}',
  arazzo: 'arazzo: "1.0.0"\ninfo: {title: t, version: "1"}\nsourceDescriptions: [{name: s, url: "https://x"}]\nworkflows: [{workflowId: w, steps: []}]',
  'apis-json': 'name: t\nspecificationVersion: "0.21"\napis: []',
  jsonschema: '$schema: "https://json-schema.org/draft/2020-12/schema"\ntype: object\nproperties: {a: {type: string}}',
  'json-structure': 'name: t',
  'json-ld': '"@context": "http://x"\n"@id": "y"\n"@type": "Thing"',
  mcp: 'name: t\ntools: []',
  plans: 'plans: []',
  'rate-limits': 'limits: []',
  finops: 'name: t',
  'agent-skill': '---\nname: test-skill\ndescription: A real description here please.\n---\n# T\n## Usage\nx\n## Examples\ny',
};

const sp = new Spotlight();
let failed = 0;
for (const fmt of Object.keys(all as any)) {
  try {
    sp.setRuleset(new Ruleset(defFor(fmt), { source: 'check' }));
    const diag = await sp.run(new Document(SAMPLES[fmt] ?? '{}', fmt === 'agent-skill' ? Markdown : Parsers.Yaml, 'check'));
    console.log(`  ok   ${fmt.padEnd(14)} (${diag.length} diagnostics)`);
  } catch (e: any) {
    console.log(`  FAIL ${fmt.padEnd(14)} ${String(e?.message || e).slice(0, 120)}`);
    failed++;
  }
}
if (failed) { console.error(`\n${failed} format(s) failed to construct/run.`); process.exit(1); }
console.log('\nAll formats construct + run against the real engine.');
