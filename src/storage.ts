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
// Wipe everything the validator stores (saved artifacts, active doc, saved rules).
export function clearAll(): void {
  try {
    localStorage.removeItem(DOCS_KEY);
    localStorage.removeItem(ACTIVE_KEY);
    localStorage.removeItem(RULES_KEY);
  } catch {
    /* storage disabled */
  }
}

// ---- saved rule overrides ----------------------------------------------------
// A saved rule overrides the built-in/compiled rule of the same name for its
// format. `def` is a rule definition object, or 'off' to disable.
export interface SavedRule {
  name: string;
  format: string;
  def: any;
  updatedAt: number;
}
const RULES_KEY = 'spotlight-validator:rules';

export function loadRules(): SavedRule[] {
  try {
    const v = JSON.parse(localStorage.getItem(RULES_KEY) || '[]');
    return Array.isArray(v) ? v : [];
  } catch {
    return [];
  }
}
export function saveRules(rules: SavedRule[]): void {
  try {
    localStorage.setItem(RULES_KEY, JSON.stringify(rules));
  } catch {
    /* storage disabled or over quota */
  }
}
export function upsertRule(name: string, format: string, def: any): void {
  const rules = loadRules();
  const entry: SavedRule = { name, format, def, updatedAt: Date.now() };
  const i = rules.findIndex((r) => r.name === name && r.format === format);
  if (i >= 0) rules[i] = entry;
  else rules.push(entry);
  saveRules(rules);
}
export function removeRule(name: string, format: string): void {
  saveRules(loadRules().filter((r) => !(r.name === name && r.format === format)));
}
export function getRule(name: string, format: string): SavedRule | undefined {
  return loadRules().find((r) => r.name === name && r.format === format);
}
