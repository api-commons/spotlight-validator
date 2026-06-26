// Browser-side GitHub writes — commit a file or open a PR — used to save a
// stored artifact to a repo chosen from the Repos tab. The token is the user's
// PAT (Config), sent straight from the browser to the GitHub API.
const GH = 'https://api.github.com';
const b64 = (s: string) => btoa(unescape(encodeURIComponent(s)));
const headers = (token: string) => ({ accept: 'application/vnd.github+json', authorization: `Bearer ${token}` });

async function getSha(token: string, repo: string, path: string, branch: string): Promise<string | undefined> {
  const res = await fetch(`${GH}/repos/${repo}/contents/${path}?ref=${encodeURIComponent(branch)}`, { headers: headers(token) });
  if (res.status === 404) return undefined;
  if (!res.ok) throw new Error(`GitHub ${res.status}`);
  return (await res.json()).sha;
}

export async function commitGitHub(token: string, repo: string, path: string, content: string, message: string, branch: string): Promise<string> {
  const sha = await getSha(token, repo, path, branch);
  const res = await fetch(`${GH}/repos/${repo}/contents/${path}`, {
    method: 'PUT', headers: { ...headers(token), 'content-type': 'application/json' },
    body: JSON.stringify({ message, content: b64(content), branch, ...(sha ? { sha } : {}) }),
  });
  if (!res.ok) throw new Error(`GitHub commit ${res.status}: ${(await res.json().catch(() => ({})))?.message || ''}`);
  return (await res.json()).content?.html_url || `https://github.com/${repo}/blob/${branch}/${path}`;
}

export async function openPrGitHub(token: string, repo: string, path: string, content: string, message: string, base: string): Promise<string> {
  const head = `spotlight/${path.replace(/[^a-z0-9]+/gi, '-')}-${Date.now().toString(36)}`;
  const refRes = await fetch(`${GH}/repos/${repo}/git/ref/heads/${encodeURIComponent(base)}`, { headers: headers(token) });
  if (!refRes.ok) throw new Error(`GitHub base ref ${refRes.status}`);
  const baseSha = (await refRes.json()).object.sha;
  const mk = await fetch(`${GH}/repos/${repo}/git/refs`, {
    method: 'POST', headers: { ...headers(token), 'content-type': 'application/json' },
    body: JSON.stringify({ ref: `refs/heads/${head}`, sha: baseSha }),
  });
  if (!mk.ok) throw new Error(`GitHub branch ${mk.status}`);
  await commitGitHub(token, repo, path, content, message, head);
  const pr = await fetch(`${GH}/repos/${repo}/pulls`, {
    method: 'POST', headers: { ...headers(token), 'content-type': 'application/json' },
    body: JSON.stringify({ title: message, head, base, body: 'Opened by spotlight-validator.' }),
  });
  if (!pr.ok) throw new Error(`GitHub PR ${pr.status}: ${(await pr.json().catch(() => ({})))?.message || ''}`);
  return (await pr.json()).html_url;
}
