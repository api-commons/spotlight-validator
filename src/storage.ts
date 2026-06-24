// Client-side persistence for validator documents (localStorage). Edits autosave
// here; the user can browse/load/remove them. Cleared when the browser cache is
// cleared. (A future "Save" will persist server-side.)
export interface SavedDoc {
  id: string;
  name: string;
  type: string; // artifact type id (openapi, apis-json, …)
  lang: 'yaml' | 'json';
  content: string;
  updatedAt: number;
}

const DOCS_KEY = 'spotlight-validator:docs';
const ACTIVE_KEY = 'spotlight-validator:active';

export function loadDocs(): SavedDoc[] {
  try {
    const v = JSON.parse(localStorage.getItem(DOCS_KEY) || '[]');
    return Array.isArray(v) ? v : [];
  } catch {
    return [];
  }
}
export function saveDocs(docs: SavedDoc[]): void {
  try {
    localStorage.setItem(DOCS_KEY, JSON.stringify(docs));
  } catch {
    /* storage disabled or over quota — fail silently */
  }
}
export function upsertDoc(doc: SavedDoc): void {
  const docs = loadDocs();
  const i = docs.findIndex((d) => d.id === doc.id);
  if (i >= 0) docs[i] = doc;
  else docs.push(doc);
  saveDocs(docs);
}
export function removeDoc(id: string): void {
  saveDocs(loadDocs().filter((d) => d.id !== id));
}
export function getDoc(id: string): SavedDoc | undefined {
  return loadDocs().find((d) => d.id === id);
}
export function findDoc(type: string, name: string): SavedDoc | undefined {
  return loadDocs().find((d) => d.type === type && d.name === name);
}
export function getActiveId(): string | null {
  return localStorage.getItem(ACTIVE_KEY);
}
export function setActiveId(id: string | null): void {
  if (id) localStorage.setItem(ACTIVE_KEY, id);
  else localStorage.removeItem(ACTIVE_KEY);
}
export function newId(): string {
  return globalThis.crypto?.randomUUID?.() ?? 'd' + Math.random().toString(36).slice(2) + Date.now().toString(36);
}
