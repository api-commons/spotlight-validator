// Per-artifact transformation utilities applied to a whole document. Each
// function takes the document text and returns either a transformed document or
// a set of new artifacts to save. OpenAPI has three to start; more come later.
import { parse, stringify } from 'yaml';

const METHODS = ['get', 'post', 'put', 'patch', 'delete', 'head', 'options', 'trace'];

const pascal = (s: string): string =>
  String(s).replace(/[^a-z0-9]+/gi, ' ').trim().split(/\s+/).filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join('') || 'Schema';

function parseOpenAPI(text: string): any {
  const doc = parse(text);
  if (!doc || typeof doc !== 'object' || (!doc.openapi && !doc.swagger) || !doc.paths) {
    throw new Error('Current document is not an OpenAPI definition (needs `openapi` and `paths`).');
  }
  return doc;
}

// 1) Componentize — hoist inline request/response/parameter schemas into
// components.schemas and replace them with a $ref. Returns the new document.
export function componentizeOpenAPI(text: string): { doc: string; count: number } {
  const doc = parseOpenAPI(text);
  doc.components = doc.components || {};
  doc.components.schemas = doc.components.schemas || {};
  const schemas = doc.components.schemas;
  const used = new Set(Object.keys(schemas));
  let count = 0;
  const nameFor = (base: string) => {
    const root = pascal(base);
    let name = root;
    let i = 1;
    while (used.has(name)) name = root + ++i;
    used.add(name);
    return name;
  };
  const hoist = (holder: any, key: string, base: string) => {
    const s = holder?.[key];
    if (!s || typeof s !== 'object' || s.$ref) return;
    const name = nameFor(s.title || base);
    schemas[name] = s;
    holder[key] = { $ref: `#/components/schemas/${name}` };
    count++;
  };
  for (const [p, item] of Object.entries<any>(doc.paths || {})) {
    for (const [method, op] of Object.entries<any>(item || {})) {
      if (!METHODS.includes(method) || !op || typeof op !== 'object') continue;
      const base = op.operationId || `${method} ${p}`;
      for (const media of Object.values<any>(op.requestBody?.content || {})) hoist(media, 'schema', `${base} Request`);
      for (const [code, resp] of Object.entries<any>(op.responses || {}))
        for (const media of Object.values<any>(resp?.content || {})) hoist(media, 'schema', `${base} Response ${code}`);
      for (const param of op.parameters || []) hoist(param, 'schema', `${base} ${param?.name || 'Param'}`);
    }
  }
  return { doc: stringify(doc), count };
}

// 2) Split by tags — one OpenAPI per tag, carrying only that tag's operations
// (shared components/info/servers are kept). Returns one artifact per tag.
export function splitOpenAPIByTags(text: string): Array<{ tag: string; doc: string }> {
  const doc = parseOpenAPI(text);
  const tags = new Set<string>();
  for (const item of Object.values<any>(doc.paths || {}))
    for (const [m, op] of Object.entries<any>(item || {}))
      if (METHODS.includes(m)) for (const t of op?.tags || []) tags.add(t);

  const out: Array<{ tag: string; doc: string }> = [];
  for (const tag of [...tags].sort()) {
    const sub: any = { ...doc, paths: {} };
    for (const [p, item] of Object.entries<any>(doc.paths || {})) {
      const kept: any = {};
      for (const [m, op] of Object.entries<any>(item || {})) {
        if (!METHODS.includes(m)) kept[m] = op; // path-level params etc.
        else if ((op?.tags || []).includes(tag)) kept[m] = op;
      }
      if (Object.keys(kept).some((k) => METHODS.includes(k))) sub.paths[p] = kept;
    }
    if (Object.keys(sub.paths).length) {
      if (Array.isArray(sub.tags)) sub.tags = sub.tags.filter((t: any) => t?.name === tag);
      out.push({ tag, doc: stringify(sub) });
    }
  }
  return out;
}

// 3) Extract JSON Schemas — each component schema as a standalone, self-contained
// JSON Schema 2020-12 (sibling schemas carried in $defs; refs rewritten).
export function extractSchemasFromOpenAPI(text: string): Array<{ name: string; doc: string }> {
  const doc = parseOpenAPI(text);
  const schemas = doc.components?.schemas || {};
  const names = Object.keys(schemas);
  if (!names.length) return [];
  const rewrite = (node: any): any => {
    if (Array.isArray(node)) return node.map(rewrite);
    if (node && typeof node === 'object') {
      const o: any = {};
      for (const [k, v] of Object.entries(node))
        o[k] = k === '$ref' && typeof v === 'string' ? v.replace('#/components/schemas/', '#/$defs/') : rewrite(v);
      return o;
    }
    return node;
  };
  const defs: Record<string, any> = {};
  for (const [n, s] of Object.entries(schemas)) defs[n] = rewrite(s);
  return names.map((name) => {
    const root: any = { $schema: 'https://json-schema.org/draft/2020-12/schema', title: name, ...defs[name] };
    const others = Object.fromEntries(Object.entries(defs).filter(([n]) => n !== name));
    if (Object.keys(others).length) root.$defs = others;
    return { name, doc: stringify(root) };
  });
}
