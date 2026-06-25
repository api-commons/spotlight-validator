// Shared multi-source search: APIs.io (default) + GitHub/GitLab/Bitbucket code
// search. Sources are toggled in Config. Token-arg based (no Config coupling), so
// this module is identical in spotlight-validator and spotlight-discovery.
import { searchArtifacts, loadArtifactContent } from './apisio';

export type SourceId = 'apis.io' | 'github' | 'gitlab' | 'bitbucket';
export interface SourceDef { id: SourceId; label: string; on: boolean; }
// APIs.io + GitHub on by default; GitLab + Bitbucket are opt-in.
export const SOURCES: SourceDef[] = [
  { id: 'apis.io', label: 'APIs.io', on: true },
  { id: 'github', label: 'GitHub', on: true },
  { id: 'gitlab', label: 'GitLab', on: false },
  { id: 'bitbucket', label: 'Bitbucket', on: false },
];
export const sourceEnabled = (id: SourceId, toggles?: Record<string, boolean>): boolean =>
  toggles?.[id] ?? SOURCES.find((s) => s.id === id)?.on ?? false;
export const enabledSources = (toggles?: Record<string, boolean>): SourceDef[] =>
  SOURCES.filter((s) => sourceEnabled(s.id, toggles));

export interface Tokens { github?: string; gitlab?: string; bitbucketUser?: string; bitbucket?: string }
export interface Hit { source: SourceId; name: string; repo?: string; path?: string; ref?: string; url?: string; aid?: string; type?: string }

// GitHub code-search qualifier per artifact id (appended to the user's query).
const GH_QUALIFIER: Record<string, string> = {
  'apis-json': 'filename:apis.json', openapi: 'openapi extension:yaml', asyncapi: 'asyncapi extension:yaml',
  arazzo: 'arazzo extension:yaml', 'json-schema': '"$schema" extension:json', 'json-structure': '"$schema" extension:json',
  'json-ld': '"@context"', plans: 'plans extension:yaml', 'rate-limits': 'rate-limits extension:yaml',
  finops: 'finops extension:yaml', mcp: 'mcp extension:json',
};
const b64decode = (s: string) => decodeURIComponent(escape(atob(s.replace(/\s/g, ''))));

export interface ArtifactRef { id: string; endpoint: string }

export async function searchSource(source: SourceId, artifact: ArtifactRef, query: string, tokens: Tokens): Promise<Hit[]> {
  if (source === 'apis.io') {
    const hits = await searchArtifacts(artifact.endpoint, query, 25);
    return hits.map((h) => ({ source: 'apis.io', name: h.name || h.aid, aid: h.aid, type: h.type, url: h.url } as Hit));
  }
  if (source === 'github') {
    if (!tokens.github) throw new Error('GitHub search needs a token (Config).');
    const q = `${query} ${GH_QUALIFIER[artifact.id] || ''}`.trim();
    const res = await fetch(`https://api.github.com/search/code?per_page=25&q=${encodeURIComponent(q)}`, {
      headers: { accept: 'application/vnd.github+json', authorization: `Bearer ${tokens.github}` },
    });
    if (!res.ok) throw new Error(`GitHub ${res.status}: ${(await res.json().catch(() => ({})))?.message || res.statusText}`);
    return ((await res.json()).items || []).map((it: any) => ({ source: 'github', name: it.name, repo: it.repository?.full_name, path: it.path, ref: it.repository?.default_branch, url: it.html_url } as Hit));
  }
  if (source === 'gitlab') {
    if (!tokens.gitlab) throw new Error('GitLab search needs a token (Config).');
    const res = await fetch(`https://gitlab.com/api/v4/search?scope=blobs&search=${encodeURIComponent(query || artifact.id)}`, { headers: { authorization: `Bearer ${tokens.gitlab}` } });
    if (!res.ok) throw new Error(`GitLab ${res.status}`);
    return ((await res.json()) || []).map((b: any) => ({ source: 'gitlab', name: b.basename || b.path, repo: String(b.project_id), path: b.path, ref: b.ref } as Hit));
  }
  // bitbucket
  if (!tokens.bitbucket || !tokens.bitbucketUser) throw new Error('Bitbucket search needs a username + app password (Config).');
  const res = await fetch(`https://api.bitbucket.org/2.0/workspaces/${tokens.bitbucketUser}/search/code?search_query=${encodeURIComponent(query || artifact.id)}`, { headers: { authorization: 'Basic ' + btoa(`${tokens.bitbucketUser}:${tokens.bitbucket}`) } });
  if (!res.ok) throw new Error(`Bitbucket ${res.status}`);
  return ((await res.json()).values || []).map((v: any) => ({ source: 'bitbucket', name: v.file?.path?.split('/').pop() || 'file', repo: `${tokens.bitbucketUser}/${v.file?.commit?.repository?.name || ''}`, path: v.file?.path, ref: v.file?.commit?.hash } as Hit));
}

export async function loadHit(hit: Hit, tokens: Tokens): Promise<string> {
  if (hit.source === 'apis.io') return loadArtifactContent({ aid: hit.aid!, name: hit.name, type: hit.type || 'OpenAPI', url: hit.url! } as any);
  if (hit.source === 'github') {
    const res = await fetch(`https://api.github.com/repos/${hit.repo}/contents/${hit.path}${hit.ref ? `?ref=${hit.ref}` : ''}`, { headers: { accept: 'application/vnd.github+json', ...(tokens.github ? { authorization: `Bearer ${tokens.github}` } : {}) } });
    if (!res.ok) throw new Error(`GitHub read ${res.status}`);
    return b64decode((await res.json()).content);
  }
  if (hit.source === 'gitlab') {
    const res = await fetch(`https://gitlab.com/api/v4/projects/${hit.repo}/repository/files/${encodeURIComponent(hit.path!)}?ref=${hit.ref || 'HEAD'}`, { headers: { authorization: `Bearer ${tokens.gitlab}` } });
    if (!res.ok) throw new Error(`GitLab read ${res.status}`);
    return b64decode((await res.json()).content);
  }
  const res = await fetch(`https://api.bitbucket.org/2.0/repositories/${hit.repo}/src/${hit.ref || 'HEAD'}/${hit.path}`, { headers: { authorization: 'Basic ' + btoa(`${tokens.bitbucketUser}:${tokens.bitbucket}`) } });
  if (!res.ok) throw new Error(`Bitbucket read ${res.status}`);
  return res.text();
}
