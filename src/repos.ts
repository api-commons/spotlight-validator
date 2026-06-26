// GitHub repo picker + a local list of repos to commit/PR against. Copied
// identically into the validator and discovery — localStorage is per-origin, so
// the key never collides between the two apps.
export interface Repo {
  fullName: string;     // owner/repo
  defaultBranch: string;
  private: boolean;
}

const GH = 'https://api.github.com';

// Repos the token can access (owned + collaborator + org member), newest first.
export async function listAccessibleRepos(token: string, maxPages = 4): Promise<Repo[]> {
  const out: Repo[] = [];
  for (let page = 1; page <= maxPages; page++) {
    const res = await fetch(`${GH}/user/repos?per_page=100&sort=updated&affiliation=owner,collaborator,organization_member&page=${page}`, {
      headers: { authorization: `Bearer ${token}`, accept: 'application/vnd.github+json' },
    });
    if (!res.ok) throw new Error(`GitHub ${res.status}: ${(await res.text()).slice(0, 160)}`);
    const batch = await res.json();
    if (!Array.isArray(batch) || batch.length === 0) break;
    for (const r of batch) out.push({ fullName: r.full_name, defaultBranch: r.default_branch || 'main', private: !!r.private });
    if (batch.length < 100) break;
  }
  return out;
}

const KEY = 'spotlight:repos';
export function loadRepos(): Repo[] {
  try { const v = JSON.parse(localStorage.getItem(KEY) || '[]'); return Array.isArray(v) ? v : []; } catch { return []; }
}
export function saveRepos(repos: Repo[]): void {
  try { localStorage.setItem(KEY, JSON.stringify(repos)); } catch { /* disabled / quota */ }
}
export function addRepo(repo: Repo): boolean {
  const repos = loadRepos();
  if (repos.some((r) => r.fullName === repo.fullName)) return false;
  repos.push(repo);
  repos.sort((a, b) => a.fullName.localeCompare(b.fullName));
  saveRepos(repos);
  return true;
}
export function removeRepo(fullName: string): void {
  saveRepos(loadRepos().filter((r) => r.fullName !== fullName));
}
