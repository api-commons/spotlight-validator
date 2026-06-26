// Assemble all saved artifacts into a single APIs.json 0.21 document (YAML):
// OpenAPI/AsyncAPI become individual `apis`, everything else becomes `common`
// properties, and a `rules` entry references the Spotlight governance ruleset.
// Copied identically into the validator and discovery.
import { parse, stringify } from 'yaml';

export interface ArtifactInput { name: string; content: string; lang: 'yaml' | 'json'; type?: string; url?: string }

// saved artifact type/id -> APIs.json 0.21 property `type`
const TYPE_MAP: Record<string, string> = {
  openapi: 'OpenAPI', asyncapi: 'AsyncAPI',
  jsonschema: 'JSONSchema', 'json-schema': 'JSONSchema',
  'json-structure': 'JSONStructure', 'json-ld': 'JSONLD', arazzo: 'Arazzo',
  mcp: 'X-MCP', plans: 'X-Plans', 'rate-limits': 'X-RateLimits',
  finops: 'X-FinOps', 'agent-skill': 'X-AgentSkill', 'apis-json': 'X-APIsJSON',
};
const pascal = (s: string) =>
  String(s).replace(/[^a-z0-9]+/gi, ' ').trim().split(/\s+/).map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join('') || 'Artifact';

const tryParse = (text: string): any => { try { return parse(text); } catch { return null; } };

// Best-effort type detection when an artifact didn't record its type.
function detectType(content: string): string {
  const d = tryParse(content);
  if (d && typeof d === 'object') {
    if (d.openapi || d.swagger) return 'openapi';
    if (d.asyncapi) return 'asyncapi';
    if (d.specificationVersion && d.apis) return 'apis-json';
    if (d.arazzo) return 'arazzo';
    if (d['@context']) return 'json-ld';
    if (d.$schema && (d.properties || d.type || d.$defs)) return 'json-schema';
  }
  return 'unknown';
}
function baseURLOf(content: string): string {
  const d = tryParse(content);
  const s = d?.servers;
  if (Array.isArray(s) && s[0]?.url) return String(s[0].url);
  if (s && typeof s === 'object') { const f = Object.values<any>(s)[0]; if (f?.url) return String(f.url); }
  return '';
}
function descOf(content: string): string {
  const d = tryParse(content);
  return String(d?.info?.description || d?.info?.title || '').trim();
}
function fileName(name: string, lang: string): string {
  const base = name.replace(/[^a-z0-9._-]+/gi, '-').replace(/^-+|-+$/g, '') || 'artifact';
  return /\.(ya?ml|json)$/i.test(base) ? base : `${base}.${lang === 'json' ? 'json' : 'yaml'}`;
}

export function buildApisJson(collectionName: string, artifacts: ArtifactInput[]): string {
  const today = new Date().toISOString().slice(0, 10);
  const apis: any[] = [];
  const common: any[] = [];
  for (const a of artifacts) {
    const t = a.type || detectType(a.content);
    const propType = TYPE_MAP[t] || `X-${pascal(t)}`;
    const url = a.url || fileName(a.name, a.lang);
    if (t === 'openapi' || t === 'asyncapi') {
      apis.push({
        name: a.name, description: descOf(a.content) || a.name, image: '',
        baseURL: baseURLOf(a.content) || 'https://api.example.com', humanURL: '',
        properties: [{ type: propType, name: a.name, url }],
      });
    } else {
      common.push({ type: propType, name: a.name, url });
    }
  }
  const doc: any = {
    specificationVersion: '0.21',
    name: collectionName,
    description: `APIs.json assembled from ${artifacts.length} saved artifact${artifacts.length === 1 ? '' : 's'}.`,
    created: today, modified: today,
  };
  if (apis.length) doc.apis = apis;
  if (common.length) doc.common = common;
  doc.rules = [{ type: 'SpectralRules', name: 'Spotlight Rules', url: 'https://spotlight-rules.com/spec/' }];
  return stringify(doc);
}
