// The artifact types the validator supports. Each maps to an APIs.io catalog
// endpoint, a `format` tag used to select rules, a default Spotlight ruleset
// (rules/defaults/<id>.yaml), and a starter sample (samples/<id>.yaml).
import { parse as parseYaml } from 'yaml';

export interface ArtifactType {
  id: string; // matches the default-ruleset + sample filename
  label: string;
  endpoint: string; // APIs.io: /api/v1/<endpoint>
  format: string; // format tag used by compiled + default rules
  searchNote?: string; // shown when the catalog has no data for this type yet
}

// Order as requested.
export const ARTIFACTS: ArtifactType[] = [
  { id: 'apis-json', label: 'APIs.json', endpoint: 'apis-json', format: 'apis-json', searchNote: 'APIs.json artifacts will appear here as the APIs.io catalog indexes them.' },
  { id: 'openapi', label: 'OpenAPI', endpoint: 'openapis', format: 'openapi' },
  { id: 'mcp', label: 'MCP', endpoint: 'mcp', format: 'mcp', searchNote: 'MCP artifacts will appear here as the APIs.io catalog indexes them.' },
  { id: 'arazzo', label: 'Arazzo', endpoint: 'arazzo', format: 'arazzo', searchNote: 'No Arazzo artifacts in the APIs.io catalog yet.' },
  { id: 'asyncapi', label: 'AsyncAPI', endpoint: 'asyncapis', format: 'asyncapi' },
  { id: 'json-schema', label: 'JSON Schema', endpoint: 'json-schemas', format: 'jsonschema' },
  { id: 'json-structure', label: 'JSON Structure', endpoint: 'json-structures', format: 'json-structure' },
  { id: 'json-ld', label: 'JSON-LD', endpoint: 'json-ld', format: 'json-ld' },
  { id: 'plans', label: 'Plans', endpoint: 'plans', format: 'plans' },
  { id: 'rate-limits', label: 'Rate Limits', endpoint: 'rate-limits', format: 'rate-limits' },
  { id: 'finops', label: 'FinOps', endpoint: 'finops', format: 'finops' },
];

export const artifactById = (id: string): ArtifactType =>
  ARTIFACTS.find((a) => a.id === id) ?? ARTIFACTS[1];

const defaultFiles = import.meta.glob('../rules/defaults/*.yaml', { query: '?raw', import: 'default', eager: true }) as Record<string, string>;
const sampleFiles = import.meta.glob('../samples/*.yaml', { query: '?raw', import: 'default', eager: true }) as Record<string, string>;

function byId(files: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [p, raw] of Object.entries(files)) out[p.split('/').pop()!.replace(/\.ya?ml$/, '')] = raw;
  return out;
}

// id -> default ruleset definition (data form: { extends?, rules? }).
export const DEFAULT_RULESETS: Record<string, any> = {};
for (const [id, raw] of Object.entries(byId(defaultFiles))) DEFAULT_RULESETS[id] = parseYaml(raw) || {};

// id -> starter sample text.
export const SAMPLES: Record<string, string> = byId(sampleFiles);
