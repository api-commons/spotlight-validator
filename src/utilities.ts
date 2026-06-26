// Per-artifact, whole-document transformation utilities. Each utility's `run`
// receives the document text + context and returns one outcome:
//   replace  — swap the current document (undoable)
//   save     — create new saved artifacts
//   download — force-download a generated file
//   note     — just report something (no change)
// Universal utilities apply to every JSON/YAML artifact; format-specific ones
// are layered on top. Agent skills are Markdown, so they get their own set.
import { parse, stringify } from 'yaml';

export type UtilOutcome =
  | { kind: 'replace'; content: string; note: string }
  | { kind: 'save'; items: Array<{ name: string; type: string; content: string }>; note: string }
  | { kind: 'download'; name: string; content: string; mime: string; note: string }
  | { kind: 'note'; note: string };

export interface UtilCtx { type: string; lang: 'yaml' | 'json' }
export interface Utility { id: string; label: string; desc: string; run: (text: string, ctx: UtilCtx) => UtilOutcome }

// ---- helpers ----------------------------------------------------------------
const isObj = (x: any): x is Record<string, any> => x != null && typeof x === 'object' && !Array.isArray(x);
const clone = (x: any) => JSON.parse(JSON.stringify(x ?? null));
const pascal = (s: string) =>
  String(s).replace(/[^a-z0-9]+/gi, ' ').trim().split(/\s+/).map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join('') || 'Item';
const METHODS = ['get', 'post', 'put', 'patch', 'delete', 'head', 'options', 'trace'];

function parseDoc(text: string): any {
  const d = parse(text);
  if (d == null || typeof d !== 'object') throw new Error('Document does not parse as a JSON/YAML object.');
  return d;
}
function deepSortKeys(node: any): any {
  if (Array.isArray(node)) return node.map(deepSortKeys);
  if (isObj(node)) { const o: any = {}; for (const k of Object.keys(node).sort()) o[k] = deepSortKeys(node[k]); return o; }
  return node;
}
function stripFields(node: any, drop: (k: string) => boolean): any {
  if (Array.isArray(node)) return node.map((n) => stripFields(n, drop));
  if (isObj(node)) { const o: any = {}; for (const [k, v] of Object.entries(node)) { if (drop(k)) continue; o[k] = stripFields(v, drop); } return o; }
  return node;
}
function resolveRef(root: any, ref: string): any {
  if (!ref.startsWith('#/')) return undefined;
  let cur = root;
  for (const p of ref.slice(2).split('/').map((s) => s.replace(/~1/g, '/').replace(/~0/g, '~'))) {
    cur = cur?.[p];
    if (cur === undefined) return undefined;
  }
  return cur;
}
function bundleRefs(root: any): any {
  const stack: string[] = [];
  const walk = (node: any, depth: number): any => {
    if (depth > 60) return node;
    if (Array.isArray(node)) return node.map((n) => walk(n, depth + 1));
    if (isObj(node)) {
      if (typeof node.$ref === 'string' && node.$ref.startsWith('#/')) {
        if (stack.includes(node.$ref)) return { description: `Circular $ref to ${node.$ref}` };
        const target = resolveRef(root, node.$ref);
        if (target !== undefined) { stack.push(node.$ref); const r = walk(clone(target), depth + 1); stack.pop(); return r; }
      }
      const o: any = {}; for (const [k, v] of Object.entries(node)) o[k] = walk(v, depth + 1); return o;
    }
    return node;
  };
  return walk(root, 0);
}
function collectRefs(node: any, set: Set<string>) {
  if (Array.isArray(node)) node.forEach((n) => collectRefs(n, set));
  else if (isObj(node)) { if (typeof node.$ref === 'string') set.add(node.$ref); for (const v of Object.values(node)) collectRefs(v, set); }
}
// Drop components/schemas/etc. nothing references (transitively). Returns count.
function pruneComponents(root: any, compKey: string): number {
  const comps = root[compKey];
  if (!isObj(comps)) return 0;
  let removed = 0, changed = true;
  while (changed) {
    changed = false;
    const refs = new Set<string>(); collectRefs(root, refs);
    for (const [section, items] of Object.entries<any>(comps)) {
      if (!isObj(items)) continue;
      for (const name of Object.keys(items)) {
        if (!refs.has(`#/${compKey}/${section}/${name}`)) { delete items[name]; removed++; changed = true; }
      }
    }
  }
  for (const [section, items] of Object.entries<any>(comps)) if (isObj(items) && !Object.keys(items).length) delete comps[section];
  return removed;
}
function sampleFromSchema(schema: any, root: any, depth = 0): any {
  if (depth > 6 || !isObj(schema)) return null;
  if (schema.$ref) { const t = resolveRef(root, schema.$ref); return t ? sampleFromSchema(t, root, depth + 1) : null; }
  if ('example' in schema) return schema.example;
  if ('default' in schema) return schema.default;
  if (Array.isArray(schema.enum) && schema.enum.length) return schema.enum[0];
  const type = Array.isArray(schema.type) ? schema.type[0] : schema.type;
  if (schema.properties || type === 'object') {
    const o: any = {};
    for (const [k, v] of Object.entries<any>(schema.properties || {})) o[k] = sampleFromSchema(v, root, depth + 1);
    return o;
  }
  if (type === 'array') return [sampleFromSchema(schema.items || {}, root, depth + 1)];
  if (type === 'integer' || type === 'number') return 0;
  if (type === 'boolean') return false;
  if (type === 'string' || type === undefined) {
    const f = schema.format;
    return f === 'date-time' ? '2020-01-01T00:00:00Z' : f === 'date' ? '2020-01-01'
      : f === 'uuid' ? '00000000-0000-0000-0000-000000000000' : f === 'email' ? 'user@example.com' : 'string';
  }
  return null;
}
// draft-07 <-> 2020-12 tuple items migration (used both directions).
function to2020(node: any): any {
  if (Array.isArray(node)) return node.map(to2020);
  if (isObj(node)) {
    const o: any = {}; for (const [k, v] of Object.entries(node)) o[k] = to2020(v);
    if (Array.isArray(o.items)) { o.prefixItems = o.items; delete o.items; if ('additionalItems' in o) { if (o.additionalItems !== true) o.items = o.additionalItems; delete o.additionalItems; } }
    else if ('additionalItems' in o) delete o.additionalItems;
    return o;
  }
  return node;
}
function toDraft07(node: any): any {
  if (Array.isArray(node)) return node.map(toDraft07);
  if (isObj(node)) {
    const o: any = {}; for (const [k, v] of Object.entries(node)) o[k] = toDraft07(v);
    if (Array.isArray(o.prefixItems)) { if ('items' in o) o.additionalItems = o.items; o.items = o.prefixItems; delete o.prefixItems; }
    return o;
  }
  return node;
}
const yaml = (o: any) => stringify(o);

// ---- universal --------------------------------------------------------------
const universal: Utility[] = [
  { id: 'sort-keys', label: 'Sort keys', desc: 'Deep-sort every object key alphabetically for clean, stable diffs. Replaces the document.',
    run: (t) => ({ kind: 'replace', content: yaml(deepSortKeys(parseDoc(t))), note: 'Sorted all keys alphabetically.' }) },
  { id: 'redact', label: 'Strip descriptions / examples / x-*', desc: 'Remove all description, example(s), and x-* vendor extension fields. Replaces the document.',
    run: (t) => ({ kind: 'replace', content: yaml(stripFields(parseDoc(t), (k) => k === 'description' || k === 'example' || k === 'examples' || /^x-/.test(k))), note: 'Stripped descriptions, examples, and x-* extensions.' }) },
  { id: 'bundle-refs', label: 'Bundle ($ref → inline)', desc: 'Inline every internal $ref into one self-contained document (circular refs are stubbed). Replaces the document.',
    run: (t) => ({ kind: 'replace', content: yaml(bundleRefs(parseDoc(t))), note: 'Inlined internal $refs.' }) },
  { id: 'flip-format', label: 'Save as JSON / YAML', desc: 'Save a copy of the document in the other serialization (YAML ⇆ JSON).',
    run: (t, ctx) => { const d = parseDoc(t); const toJson = ctx.lang !== 'json'; return { kind: 'save', items: [{ name: toJson ? 'JSON' : 'YAML', type: ctx.type, content: toJson ? JSON.stringify(d, null, 2) : yaml(d) }], note: `Saved a ${toJson ? 'JSON' : 'YAML'} copy.` }; } },
  { id: 'gen-markdown', label: 'Generate Markdown docs', desc: 'Generate and download a Markdown summary of the document.',
    run: (t) => ({ kind: 'download', name: 'docs.md', mime: 'text/markdown', content: genMarkdown(parseDoc(t)), note: 'Generated Markdown docs.' }) },
];
function genMarkdown(d: any): string {
  const lines: string[] = [];
  const title = d.info?.title || d.name || 'API Document';
  lines.push(`# ${title}`, '');
  if (d.info?.description || d.description) lines.push(d.info?.description || d.description, '');
  if (isObj(d.paths)) {
    lines.push('## Endpoints', '');
    for (const [p, item] of Object.entries<any>(d.paths)) for (const [m, op] of Object.entries<any>(item || {}))
      if (METHODS.includes(m)) lines.push(`- \`${m.toUpperCase()} ${p}\`${op?.summary ? ` — ${op.summary}` : ''}`);
  } else if (isObj(d.channels)) {
    lines.push('## Channels', '');
    for (const c of Object.keys(d.channels)) lines.push(`- \`${c}\``);
  } else {
    lines.push('## Keys', '');
    for (const k of Object.keys(d)) lines.push(`- \`${k}\``);
  }
  return lines.join('\n') + '\n';
}

// ---- OpenAPI ----------------------------------------------------------------
function requireOpenAPI(text: string): any {
  const d = parseDoc(text);
  if ((!d.openapi && !d.swagger) || !d.paths) throw new Error('Not an OpenAPI definition (needs `openapi` and `paths`).');
  return d;
}
const openapi: Utility[] = [
  { id: 'componentize', label: 'Componentize everything', desc: 'Move inline request/response/parameter schemas into components.schemas and $ref them. Replaces the document.',
    run: (t) => { const d = requireOpenAPI(t); const n = componentize(d); return { kind: 'replace', content: yaml(d), note: `Hoisted ${n} inline schema${n === 1 ? '' : 's'} into components.` }; } },
  { id: 'split-tags', label: 'Split into OpenAPIs by tag', desc: 'Create a separate OpenAPI per tag (saved as new artifacts). Primary kept.',
    run: (t) => { const items = splitByTags(requireOpenAPI(t)); if (!items.length) throw new Error('No tagged operations found.'); return { kind: 'save', items, note: `Split into ${items.length} OpenAPI${items.length === 1 ? '' : 's'} by tag.` }; } },
  { id: 'extract-schemas', label: 'Extract JSON Schemas', desc: 'Save every component schema as a standalone JSON Schema artifact. Primary kept.',
    run: (t) => { const items = extractComponentSchemas(requireOpenAPI(t)); if (!items.length) throw new Error('No component schemas found.'); return { kind: 'save', items, note: `Saved ${items.length} JSON Schema${items.length === 1 ? '' : 's'}.` }; } },
  { id: 'prune-unused', label: 'Prune unused components', desc: 'Remove components nothing references (transitively). Replaces the document.',
    run: (t) => { const d = requireOpenAPI(t); const n = pruneComponents(d, 'components'); return { kind: 'replace', content: yaml(d), note: `Removed ${n} unused component${n === 1 ? '' : 's'}.` }; } },
  { id: 'gen-operationids', label: 'Generate missing operationIds', desc: 'Add an operationId to every operation that lacks one. Replaces the document.',
    run: (t) => { const d = requireOpenAPI(t); let n = 0; for (const [p, item] of Object.entries<any>(d.paths)) for (const [m, op] of Object.entries<any>(item || {})) if (METHODS.includes(m) && op && !op.operationId) { op.operationId = m + pascal(p); n++; } return { kind: 'replace', content: yaml(d), note: `Added ${n} operationId${n === 1 ? '' : 's'}.` }; } },
  { id: 'infer-tags', label: 'Infer tags from paths', desc: 'Tag each untagged operation by its first path segment and rebuild the top-level tags list. Replaces the document.',
    run: (t) => { const d = requireOpenAPI(t); const seen = new Set<string>(); for (const [p, item] of Object.entries<any>(d.paths)) { const seg = (p.split('/').filter(Boolean)[0] || 'default').replace(/[{}]/g, ''); for (const [m, op] of Object.entries<any>(item || {})) if (METHODS.includes(m) && op) { if (!op.tags || !op.tags.length) op.tags = [seg]; (op.tags || []).forEach((x: string) => seen.add(x)); } } d.tags = [...seen].sort().map((name) => ({ name })); return { kind: 'replace', content: yaml(d), note: `Tagged operations and rebuilt ${seen.size} tag${seen.size === 1 ? '' : 's'}.` }; } },
  { id: 'scaffold-responses', label: 'Scaffold standard error responses', desc: 'Add missing 400, 401, 429, and 500 responses to every operation. Replaces the document.',
    run: (t) => { const d = requireOpenAPI(t); let n = 0; const std: Record<string, string> = { '400': 'Bad Request', '401': 'Unauthorized', '429': 'Too Many Requests', '500': 'Internal Server Error' }; for (const item of Object.values<any>(d.paths)) for (const [m, op] of Object.entries<any>(item || {})) if (METHODS.includes(m) && op) { op.responses = op.responses || {}; for (const [code, desc] of Object.entries(std)) if (!op.responses[code]) { op.responses[code] = { description: desc }; n++; } } return { kind: 'replace', content: yaml(d), note: `Added ${n} standard error response${n === 1 ? '' : 's'}.` }; } },
  { id: 'upgrade-31', label: 'Upgrade to OpenAPI 3.1', desc: 'Set the version to 3.1.0 and migrate `nullable: true` to a nullable type. Replaces the document.',
    run: (t) => { const d = requireOpenAPI(t); d.openapi = '3.1.0'; const fix = (node: any): any => { if (Array.isArray(node)) return node.map(fix); if (isObj(node)) { const o: any = {}; for (const [k, v] of Object.entries(node)) o[k] = fix(v); if (o.nullable === true) { delete o.nullable; if (o.type && !Array.isArray(o.type)) o.type = [o.type, 'null']; } return o; } return node; }; const out = fix(d); return { kind: 'replace', content: yaml(out), note: 'Upgraded to OpenAPI 3.1 (nullable migrated).' }; } },
  { id: 'mock-examples', label: 'Generate response examples', desc: 'Synthesize an `example` for each response/request media type from its schema. Replaces the document.',
    run: (t) => { const d = requireOpenAPI(t); let n = 0; const addEx = (media: any) => { for (const m of Object.values<any>(media || {})) if (m && m.schema && !('example' in m) && !('examples' in m)) { m.example = sampleFromSchema(m.schema, d); n++; } }; for (const item of Object.values<any>(d.paths)) for (const [mm, op] of Object.entries<any>(item || {})) if (METHODS.includes(mm) && op) { addEx(op.requestBody?.content); for (const r of Object.values<any>(op.responses || {})) addEx(r?.content); } return { kind: 'replace', content: yaml(d), note: `Generated ${n} example${n === 1 ? '' : 's'}.` }; } },
];
function componentize(d: any): number {
  d.components = d.components || {}; d.components.schemas = d.components.schemas || {};
  const schemas = d.components.schemas; const used = new Set(Object.keys(schemas)); let count = 0;
  const nameFor = (base: string) => { const r = pascal(base); let n = r, i = 1; while (used.has(n)) n = r + ++i; used.add(n); return n; };
  const hoist = (holder: any, key: string, base: string) => { const s = holder?.[key]; if (!s || typeof s !== 'object' || s.$ref) return; const name = nameFor(s.title || base); schemas[name] = s; holder[key] = { $ref: `#/components/schemas/${name}` }; count++; };
  for (const [p, item] of Object.entries<any>(d.paths)) for (const [m, op] of Object.entries<any>(item || {})) {
    if (!METHODS.includes(m) || !op) continue;
    const base = op.operationId || `${m} ${p}`;
    for (const media of Object.values<any>(op.requestBody?.content || {})) hoist(media, 'schema', `${base} Request`);
    for (const [code, resp] of Object.entries<any>(op.responses || {})) for (const media of Object.values<any>(resp?.content || {})) hoist(media, 'schema', `${base} Response ${code}`);
    for (const param of op.parameters || []) hoist(param, 'schema', `${base} ${param?.name || 'Param'}`);
  }
  return count;
}
function splitByTags(d: any): Array<{ name: string; type: string; content: string }> {
  const tags = new Set<string>();
  for (const item of Object.values<any>(d.paths)) for (const [m, op] of Object.entries<any>(item || {})) if (METHODS.includes(m)) for (const tg of op?.tags || []) tags.add(tg);
  const out: Array<{ name: string; type: string; content: string }> = [];
  for (const tag of [...tags].sort()) {
    const sub: any = { ...d, paths: {} };
    for (const [p, item] of Object.entries<any>(d.paths)) {
      const kept: any = {};
      for (const [m, op] of Object.entries<any>(item || {})) { if (!METHODS.includes(m)) kept[m] = op; else if ((op?.tags || []).includes(tag)) kept[m] = op; }
      if (Object.keys(kept).some((k) => METHODS.includes(k))) sub.paths[p] = kept;
    }
    if (Array.isArray(sub.tags)) sub.tags = sub.tags.filter((x: any) => x?.name === tag);
    out.push({ name: tag, type: 'openapi', content: yaml(sub) });
  }
  return out;
}
function rewriteSchemaRefs(node: any): any {
  if (Array.isArray(node)) return node.map(rewriteSchemaRefs);
  if (isObj(node)) { const o: any = {}; for (const [k, v] of Object.entries(node)) o[k] = k === '$ref' && typeof v === 'string' ? v.replace('#/components/schemas/', '#/$defs/') : rewriteSchemaRefs(v); return o; }
  return node;
}
function extractComponentSchemas(d: any): Array<{ name: string; type: string; content: string }> {
  const schemas = d.components?.schemas || {}; const names = Object.keys(schemas); if (!names.length) return [];
  const defs: Record<string, any> = {}; for (const [n, s] of Object.entries(schemas)) defs[n] = rewriteSchemaRefs(s);
  return names.map((name) => { const root: any = { $schema: 'https://json-schema.org/draft/2020-12/schema', title: name, ...defs[name] }; const others = Object.fromEntries(Object.entries(defs).filter(([n]) => n !== name)); if (Object.keys(others).length) root.$defs = others; return { name, type: 'json-schema', content: yaml(root) }; });
}

// ---- AsyncAPI ---------------------------------------------------------------
const asyncapi: Utility[] = [
  { id: 'extract-payloads', label: 'Extract schemas as JSON Schemas', desc: 'Save every components.schemas entry as a standalone JSON Schema. Primary kept.',
    run: (t) => { const d = parseDoc(t); if (!d.asyncapi) throw new Error('Not an AsyncAPI document.'); const items = extractComponentSchemas(d); if (!items.length) throw new Error('No components.schemas found.'); return { kind: 'save', items, note: `Saved ${items.length} JSON Schema${items.length === 1 ? '' : 's'}.` }; } },
  { id: 'split-channels', label: 'Split by channel', desc: 'Create a separate AsyncAPI per channel (saved as new artifacts). Primary kept.',
    run: (t) => { const d = parseDoc(t); if (!d.asyncapi || !isObj(d.channels)) throw new Error('No channels found.'); const items = Object.keys(d.channels).map((c) => ({ name: c.replace(/[^a-z0-9]+/gi, '-'), type: 'asyncapi', content: yaml({ ...d, channels: { [c]: d.channels[c] } }) })); return { kind: 'save', items, note: `Split into ${items.length} channel artifact${items.length === 1 ? '' : 's'}.` }; } },
  { id: 'prune-unused-aas', label: 'Prune unused components', desc: 'Remove components nothing references. Replaces the document.',
    run: (t) => { const d = parseDoc(t); if (!d.asyncapi) throw new Error('Not an AsyncAPI document.'); const n = pruneComponents(d, 'components'); return { kind: 'replace', content: yaml(d), note: `Removed ${n} unused component${n === 1 ? '' : 's'}.` }; } },
];

// ---- JSON Schema ------------------------------------------------------------
const jsonschema: Utility[] = [
  { id: 'migrate-2020', label: 'Migrate to draft 2020-12', desc: 'Convert draft-07 tuple items/additionalItems to prefixItems and set $schema to 2020-12. Replaces the document.',
    run: (t) => { const d = to2020(parseDoc(t)); d.$schema = 'https://json-schema.org/draft/2020-12/schema'; return { kind: 'replace', content: yaml(d), note: 'Migrated to JSON Schema 2020-12.' }; } },
  { id: 'migrate-07', label: 'Migrate to draft-07', desc: 'Convert prefixItems back to tuple items/additionalItems and set $schema to draft-07. Replaces the document.',
    run: (t) => { const d = toDraft07(parseDoc(t)); d.$schema = 'http://json-schema.org/draft-07/schema#'; return { kind: 'replace', content: yaml(d), note: 'Migrated to JSON Schema draft-07.' }; } },
  { id: 'split-defs', label: 'Split $defs into separate schemas', desc: 'Save each $defs / definitions entry as a standalone JSON Schema. Primary kept.',
    run: (t) => { const d = parseDoc(t); const defs = d.$defs || d.definitions || {}; const names = Object.keys(defs); if (!names.length) throw new Error('No $defs / definitions found.'); const items = names.map((n) => ({ name: n, type: 'json-schema', content: yaml({ $schema: d.$schema || 'https://json-schema.org/draft/2020-12/schema', title: n, ...defs[n] }) })); return { kind: 'save', items, note: `Saved ${items.length} schema${items.length === 1 ? '' : 's'} from $defs.` }; } },
  { id: 'flatten-allof', label: 'Flatten allOf', desc: 'Merge each allOf into its parent (shallow merge of properties/required/type). Replaces the document.',
    run: (t) => { let n = 0; const fix = (node: any): any => { if (Array.isArray(node)) return node.map(fix); if (isObj(node)) { let o: any = {}; for (const [k, v] of Object.entries(node)) o[k] = fix(v); if (Array.isArray(o.allOf)) { const merged: any = { properties: {}, required: [] as string[] }; for (const m of o.allOf) { if (!isObj(m)) continue; Object.assign(merged.properties, m.properties || {}); if (Array.isArray(m.required)) merged.required.push(...m.required); for (const [k, v] of Object.entries(m)) if (k !== 'properties' && k !== 'required') merged[k] = v; } delete o.allOf; o = { ...merged, ...o, properties: { ...merged.properties, ...(o.properties || {}) }, required: [...new Set([...(merged.required || []), ...(o.required || [])])] }; if (!o.required.length) delete o.required; if (!Object.keys(o.properties).length) delete o.properties; n++; } return o; } return node; }; const out = fix(parseDoc(t)); return { kind: 'replace', content: yaml(out), note: `Flattened ${n} allOf.` }; } },
  { id: 'add-ids', label: 'Add $schema / $id', desc: 'Add a $schema (2020-12) and a placeholder $id if missing. Replaces the document.',
    run: (t) => { const d = parseDoc(t); let n = 0; if (!d.$schema) { d.$schema = 'https://json-schema.org/draft/2020-12/schema'; n++; } if (!d.$id) { d.$id = `https://example.com/schemas/${pascal(d.title || 'schema')}.json`; n++; } return { kind: 'replace', content: yaml(d), note: n ? `Added ${n} identifier field${n === 1 ? '' : 's'}.` : '$schema and $id already present.' }; } },
];

// ---- Arazzo -----------------------------------------------------------------
const arazzo: Utility[] = [
  { id: 'split-workflows', label: 'Split into one artifact per workflow', desc: 'Save each workflow as a separate Arazzo artifact (shared info/sourceDescriptions kept). Primary kept.',
    run: (t) => { const d = parseDoc(t); if (!Array.isArray(d.workflows) || !d.workflows.length) throw new Error('No workflows found.'); const items = d.workflows.map((w: any) => ({ name: w.workflowId || 'workflow', type: 'arazzo', content: yaml({ ...d, workflows: [w] }) })); return { kind: 'save', items, note: `Split into ${items.length} workflow artifact${items.length === 1 ? '' : 's'}.` }; } },
  { id: 'extract-io', label: 'Extract workflow inputs as JSON Schemas', desc: 'Save each workflow\'s `inputs` schema as a standalone JSON Schema. Primary kept.',
    run: (t) => { const d = parseDoc(t); const items = (d.workflows || []).filter((w: any) => w?.inputs).map((w: any) => ({ name: `${w.workflowId || 'workflow'} Inputs`, type: 'json-schema', content: yaml({ $schema: 'https://json-schema.org/draft/2020-12/schema', title: `${w.workflowId || 'workflow'} inputs`, ...w.inputs }) })); if (!items.length) throw new Error('No workflow inputs found.'); return { kind: 'save', items, note: `Saved ${items.length} input schema${items.length === 1 ? '' : 's'}.` }; } },
];

// ---- apis-json --------------------------------------------------------------
const apisJson: Utility[] = [
  { id: 'bump-021', label: 'Bump to 0.21', desc: 'Set specificationVersion to 0.21. Replaces the document.',
    run: (t) => { const d = parseDoc(t); d.specificationVersion = '0.21'; return { kind: 'replace', content: yaml(d), note: 'Set specificationVersion to 0.21.' }; } },
];

// ---- MCP --------------------------------------------------------------------
const mcp: Utility[] = [
  { id: 'extract-tool-schemas', label: 'Extract tool input schemas', desc: 'Save each tool\'s inputSchema as a standalone JSON Schema. Primary kept.',
    run: (t) => { const d = parseDoc(t); const tools = d.tools || d.capabilities?.tools || []; const items = (Array.isArray(tools) ? tools : []).filter((x: any) => x?.inputSchema).map((x: any) => ({ name: `${x.name || 'tool'} Input`, type: 'json-schema', content: yaml({ $schema: 'https://json-schema.org/draft/2020-12/schema', title: `${x.name || 'tool'} input`, ...x.inputSchema }) })); if (!items.length) throw new Error('No tool inputSchemas found.'); return { kind: 'save', items, note: `Saved ${items.length} tool input schema${items.length === 1 ? '' : 's'}.` }; } },
];

// ---- JSON-LD ----------------------------------------------------------------
const jsonld: Utility[] = [
  { id: 'extract-context', label: 'Extract @context', desc: 'Save the @context as a standalone JSON-LD artifact. Primary kept.',
    run: (t) => { const d = parseDoc(t); if (d['@context'] == null) throw new Error('No @context found.'); return { kind: 'save', items: [{ name: 'Context', type: 'json-ld', content: yaml({ '@context': d['@context'] }) }], note: 'Saved @context.' }; } },
];

// ---- Agent Skill (Markdown) -------------------------------------------------
const skill: Utility[] = [
  { id: 'skill-toc', label: 'Insert Table of Contents', desc: 'Build a Markdown TOC from the ## / ### headings and insert it after the frontmatter. Replaces the document.',
    run: (t) => { const lines = t.split('\n'); const toc: string[] = []; for (const l of lines) { const m = /^(#{2,3})\s+(.+?)\s*$/.exec(l); if (m) { const slug = m[2].toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, ''); toc.push(`${'  '.repeat(m[1].length - 2)}- [${m[2]}](#${slug})`); } } if (!toc.length) throw new Error('No ## / ### headings found.'); let insertAt = 0; if (lines[0]?.trim() === '---') { const end = lines.indexOf('---', 1); if (end > 0) insertAt = end + 1; } const out = [...lines.slice(0, insertAt), '', '## Contents', '', ...toc, '', ...lines.slice(insertAt)]; return { kind: 'replace', content: out.join('\n'), note: `Inserted a TOC of ${toc.length} heading${toc.length === 1 ? '' : 's'}.` }; } },
  { id: 'skill-stats', label: 'Document stats', desc: 'Report word, heading, and code-block counts (no change).',
    run: (t) => { const words = (t.match(/\S+/g) || []).length; const headings = (t.match(/^#{1,6}\s/gm) || []).length; const code = (t.match(/```/g) || []).length / 2; return { kind: 'note', note: `${words} words · ${headings} headings · ${Math.floor(code)} code block${Math.floor(code) === 1 ? '' : 's'}.` }; } },
];

// ---- registry ---------------------------------------------------------------
const BY_FORMAT: Record<string, Utility[]> = {
  openapi, asyncapi, jsonschema, arazzo, 'apis-json': apisJson, mcp, 'json-ld': jsonld,
};

// Utilities for an artifact format: agent skills (Markdown) get their own set;
// every JSON/YAML artifact gets the universal set plus any format-specific ones.
export function utilitiesFor(format: string): Utility[] {
  if (format === 'agent-skill') return skill;
  return [...universal, ...(BY_FORMAT[format] || [])];
}
