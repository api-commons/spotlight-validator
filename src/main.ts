import * as monaco from 'monaco-editor';
import EditorWorker from 'monaco-editor/esm/vs/editor/editor.worker?worker';
import JsonWorker from 'monaco-editor/esm/vs/language/json/json.worker?worker';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';
import { lint, builtinDescriptions } from './spotlight';
import { ruleset as compiledRuleset } from './compiled-ruleset';
import { ARTIFACTS, DEFAULT_RULESETS, SAMPLES, artifactById, type ArtifactType } from './artifacts';
import { searchArtifacts, loadArtifactContent, type SearchHit } from './apisio';
import { loadDocs, saveDocs, upsertDoc, removeDoc, getDoc, findDoc, getActiveId, setActiveId, newId, type SavedDoc } from './storage';
import './style.css';

self.MonacoEnvironment = {
  getWorker(_id, label) {
    return label === 'json' ? new JsonWorker() : new EditorWorker();
  },
};

const $ = <T extends HTMLElement>(sel: string) => document.querySelector(sel) as T;
const COMPILED_RULES: Record<string, any> = (compiledRuleset as any).rules;

// ---- state ------------------------------------------------------------------
let current: ArtifactType = artifactById('openapi');
let docLang: 'yaml' | 'json' = 'yaml';
let activeCategory = '';
let activeId: string | null = null; // id of the localStorage doc being edited
let suppressSave = false; // true while programmatically replacing editor content
const userOverrides: Record<string, any> = {}; // ruleName -> definition

// ---- editors ----------------------------------------------------------------
const docEditor = monaco.editor.create($('#doc-editor'), {
  value: SAMPLES[current.id] ?? '',
  language: 'yaml',
  automaticLayout: true,
  minimap: { enabled: false },
  fontSize: 13,
  scrollBeyondLastLine: false,
});

// Created lazily on first modal open — a Monaco editor created inside a
// display:none container renders nothing until it has real dimensions.
let ruleEditor: monaco.editor.IStandaloneCodeEditor | null = null;
function ensureRuleEditor(): monaco.editor.IStandaloneCodeEditor {
  if (!ruleEditor) {
    ruleEditor = monaco.editor.create($('#rule-editor'), {
      value: '', language: 'yaml', automaticLayout: true,
      minimap: { enabled: false }, fontSize: 13, scrollBeyondLastLine: false,
    });
  }
  return ruleEditor;
}

const ACRONYMS: Record<string, string> = {
  api: 'API', apis: 'APIs', oas: 'OAS', oas2: 'OAS2', oas3: 'OAS3', aas: 'AAS', url: 'URL', uri: 'URI',
  http: 'HTTP', https: 'HTTPS', json: 'JSON', ld: 'LD', xml: 'XML', id: 'ID', ids: 'IDs', jwt: 'JWT',
  cors: 'CORS', oauth: 'OAuth', sdk: 'SDK', ssl: 'SSL', tls: 'TLS', ui: 'UI', mcp: 'MCP',
};
function titleCase(code: string): string {
  return code.split(/[-/_]/).filter(Boolean)
    .map((w) => ACRONYMS[w.toLowerCase()] ?? w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ');
}

const highlightDecorations = docEditor.createDecorationsCollection();
function highlightLines(startLine: number, endLine: number) {
  highlightDecorations.set([
    {
      range: new monaco.Range(startLine, 1, Math.max(startLine, endLine), 1),
      options: { isWholeLine: true, className: 'lint-highlight', linesDecorationsClassName: 'lint-gutter' },
    },
  ]);
  docEditor.revealLineInCenter(startLine);
}

// ---- rule lookups (compiled best-of-breed + per-type defaults + built-ins) ---
function defaultRules(): Record<string, any> {
  return (DEFAULT_RULESETS[current.id]?.rules ?? {}) as Record<string, any>;
}
function ruleDef(code: string): any {
  return COMPILED_RULES[code] ?? defaultRules()[code];
}
function descriptionFor(code: string): string {
  const r = ruleDef(code);
  return (r?.description as string) ?? builtinDescriptions[code] ?? '';
}

// ---- artifact type selector -------------------------------------------------
const typeSelect = $<HTMLSelectElement>('#artifact-type');
for (const a of ARTIFACTS) {
  const o = document.createElement('option');
  o.value = a.id;
  o.textContent = a.label;
  if (a.id === current.id) o.selected = true;
  typeSelect.appendChild(o);
}
typeSelect.addEventListener('change', () => setArtifact(typeSelect.value));

function setArtifact(id: string) {
  hideResults();
  current = artifactById(id);
  // Reuse this type's "Untitled" draft if one exists, else start a fresh one from the sample.
  const name = `Untitled ${current.label}`;
  let doc = findDoc(id, name);
  if (!doc) {
    doc = { id: newId(), name, type: id, lang: 'yaml', content: SAMPLES[id] ?? '', updatedAt: Date.now() };
    upsertDoc(doc);
  }
  loadDocIntoEditor(doc);
}

// ---- category selector (dynamic per artifact type) --------------------------
const catSelect = $<HTMLSelectElement>('#category');
function categoriesForType(): string[] {
  const cats = new Set<string>();
  const collect = (rule: any) => {
    const t: string[] = Array.isArray(rule?.tags) ? rule.tags : [];
    for (const tag of t) if (tag.startsWith('category:')) cats.add(tag);
  };
  for (const rule of Object.values(COMPILED_RULES)) {
    const t: string[] = Array.isArray(rule?.tags) ? rule.tags : [];
    if (t.includes(`format:${current.format}`)) collect(rule);
  }
  for (const rule of Object.values(defaultRules())) collect(rule);
  return [...cats].sort();
}
function rebuildCategories() {
  const cats = categoriesForType();
  if (!cats.includes(activeCategory)) activeCategory = '';
  catSelect.innerHTML = '<option value="">All categories</option>';
  for (const t of cats) {
    const o = document.createElement('option');
    o.value = t;
    o.textContent = t.split(':').slice(1).join(':');
    if (t === activeCategory) o.selected = true;
    catSelect.appendChild(o);
  }
}
catSelect.addEventListener('change', () => {
  activeCategory = catSelect.value;
  runLint();
});

// ---- active ruleset ---------------------------------------------------------
function activeRulesetDef(): any {
  const rules: Record<string, any> = {};
  const passesCategory = (rule: any) => {
    if (!activeCategory) return true;
    const t: string[] = Array.isArray(rule?.tags) ? rule.tags : [];
    return t.includes(activeCategory);
  };
  // compiled best-of-breed rules for this format
  for (const [name, rule] of Object.entries(COMPILED_RULES)) {
    const t: string[] = Array.isArray(rule?.tags) ? rule.tags : [];
    if (!t.includes(`format:${current.format}`)) continue;
    if (t.includes('duplicate:true')) continue;
    if (!passesCategory(rule)) continue;
    rules[name] = rule;
  }
  // per-type default starter rules
  for (const [name, rule] of Object.entries(defaultRules())) {
    if (!passesCategory(rule)) continue;
    rules[name] = rule;
  }
  // user edits applied on top
  for (const [name, def] of Object.entries(userOverrides)) rules[name] = def;

  $('#active-count').textContent = String(Object.keys(rules).length);
  const ext = DEFAULT_RULESETS[current.id]?.extends;
  return ext ? { extends: ext, rules } : { rules };
}

// ---- YAML / JSON toggle -----------------------------------------------------
function setLang(lang: 'yaml' | 'json') {
  if (lang === docLang) return;
  const text = docEditor.getValue();
  let converted = text;
  try {
    const obj = parseYaml(text);
    converted = lang === 'json' ? JSON.stringify(obj, null, 2) : stringifyYaml(obj);
  } catch {
    /* leave as-is on parse failure */
  }
  docLang = lang;
  const model = docEditor.getModel();
  if (model) monaco.editor.setModelLanguage(model, lang === 'json' ? 'json' : 'yaml');
  docEditor.setValue(converted);
  $('#lang-yaml').classList.toggle('active', lang === 'yaml');
  $('#lang-json').classList.toggle('active', lang === 'json');
  persistActive();
}
$('#lang-yaml').addEventListener('click', () => setLang('yaml'));
$('#lang-json').addEventListener('click', () => setLang('json'));

// ---- APIs.io search ---------------------------------------------------------
const searchInput = $<HTMLInputElement>('#artifact-search');
const resultsBox = $('#search-results');
function hideResults() {
  resultsBox.hidden = true;
  resultsBox.innerHTML = '';
}
function showResultsMessage(msg: string) {
  resultsBox.innerHTML = `<div class="hit-msg">${escapeHtml(msg)}</div>`;
  resultsBox.hidden = false;
}
async function runSearch() {
  const q = searchInput.value.trim();
  showResultsMessage('Searching APIs.io…');
  try {
    const hits = await searchArtifacts(current.endpoint, q);
    if (!hits.length) {
      showResultsMessage(current.searchNote ?? `No ${current.label} results for “${q}”.`);
      return;
    }
    resultsBox.innerHTML = hits
      .map((h, i) => `<div class="hit" data-i="${i}">
        <span class="hit-name">${escapeHtml(h.name || h.aid)}</span>
        <span class="hit-provider">${escapeHtml(h.provider_name || h.provider_slug || '')}</span>
      </div>`)
      .join('');
    resultsBox.hidden = false;
    resultsBox.querySelectorAll<HTMLElement>('.hit').forEach((el) => {
      el.addEventListener('click', () => selectHit(hits[Number(el.dataset.i)]));
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    showResultsMessage(`APIs.io search unavailable (${msg}). The API must allow this origin (CORS) — deploy apis-io-aws.`);
  }
}
function looksLikeMarkup(text: string): boolean {
  const t = text.trimStart().slice(0, 200).toLowerCase();
  return t.startsWith('<!doctype') || /^<(html|head|body)[\s>]/.test(t);
}
async function selectHit(hit: SearchHit) {
  showResultsMessage(`Loading ${hit.name || hit.aid}…`);
  try {
    const text = await loadArtifactContent(hit);
    if (looksLikeMarkup(text)) {
      showResultsMessage(`“${hit.name || hit.aid}” links to an HTML page, not a machine-readable ${current.label} document — can’t load it.`);
      return;
    }
    // Load as YAML and store it as a named local doc (reusing one if already loaded).
    const yaml = toYaml(text);
    const name = hit.name || hit.aid;
    let doc = findDoc(current.id, name);
    if (doc) Object.assign(doc, { content: yaml, lang: 'yaml' as const, updatedAt: Date.now() });
    else doc = { id: newId(), name, type: current.id, lang: 'yaml', content: yaml, updatedAt: Date.now() };
    upsertDoc(doc);
    hideResults();
    loadDocIntoEditor(doc);
  } catch (e) {
    showResultsMessage(`Could not load artifact: ${e instanceof Error ? e.message : String(e)}`);
  }
}
function toYaml(text: string): string {
  try { return stringifyYaml(parseYaml(text)); } catch { return text; }
}
$('#artifact-search-btn').addEventListener('click', runSearch);
searchInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') runSearch(); });
document.addEventListener('click', (e) => {
  if (!resultsBox.hidden && !(e.target as HTMLElement).closest('.search-wrap')) hideResults();
});

// ---- linting ----------------------------------------------------------------
const sevToMarker: Record<number, monaco.MarkerSeverity> = {
  0: monaco.MarkerSeverity.Error, 1: monaco.MarkerSeverity.Warning,
  2: monaco.MarkerSeverity.Info, 3: monaco.MarkerSeverity.Hint,
};
const sevLabel = ['error', 'warning', 'info', 'hint'];

let timer: number | undefined;
function scheduleLint() {
  clearTimeout(timer);
  timer = window.setTimeout(runLint, 250);
}

async function runLint() {
  const text = docEditor.getValue();
  const { diagnostics, error } = await lint(text, activeRulesetDef());
  const model = docEditor.getModel()!;
  if (error) {
    monaco.editor.setModelMarkers(model, 'spotlight', []);
    $('#results').innerHTML = `<li class="err">Ruleset/lint error: ${escapeHtml(error)}</li>`;
    $('#result-count').textContent = 'error';
    return;
  }
  monaco.editor.setModelMarkers(
    model, 'spotlight',
    diagnostics.map((d: any) => ({
      severity: sevToMarker[d.severity] ?? monaco.MarkerSeverity.Warning,
      startLineNumber: d.range.start.line + 1,
      startColumn: d.range.start.character + 1,
      endLineNumber: d.range.end.line + 1,
      endColumn: d.range.end.character + 1,
      message: `${d.code}: ${d.message}`,
    })),
  );

  diagnostics.sort((a: any, b: any) => a.range.start.line - b.range.start.line);
  $('#results').innerHTML =
    diagnostics
      .map((d: any) => {
        const sev = sevLabel[d.severity] ?? 'warning';
        const code = String(d.code);
        const desc = descriptionFor(code) || d.message;
        return `<li class="${sev}" data-sl="${d.range.start.line + 1}" data-el="${d.range.end.line + 1}" data-code="${escapeHtml(code)}">
          <span class="sev ${sev}" title="${sev}"></span>
          <span class="rule-name" title="${escapeHtml(code)}">${escapeHtml(titleCase(code))}</span>
          <span class="msg" title="${escapeHtml(desc)}">${escapeHtml(d.message)}</span>
          <span class="loc">L${d.range.start.line + 1}</span>
          <button class="edit-btn" title="Edit this rule">✎ edit</button>
        </li>`;
      })
      .join('') || '<li class="ok">No problems found 🎉</li>';

  $('#result-count').textContent = `${diagnostics.length} problem${diagnostics.length === 1 ? '' : 's'}`;
  $('#results')
    .querySelectorAll<HTMLLIElement>('li[data-code]')
    .forEach((li) => {
      li.addEventListener('click', () => highlightLines(Number(li.dataset.sl), Number(li.dataset.el)));
      li.querySelector<HTMLButtonElement>('.edit-btn')?.addEventListener('click', (e) => {
        e.stopPropagation();
        highlightLines(Number(li.dataset.sl), Number(li.dataset.el));
        openRuleModal(li.dataset.code!);
      });
    });
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]!));
}

// ---- rule editor modal ------------------------------------------------------
let modalRuleName = '';
function ruleDefForEditing(code: string): any {
  if (userOverrides[code] !== undefined) return userOverrides[code];
  const r = ruleDef(code);
  if (r) {
    const { tags: _t, ...rest } = r; // hide tag noise while editing
    return rest;
  }
  return 'warn'; // built-in rule (from the extended ruleset) — edit as a severity toggle
}
function openRuleModal(code: string) {
  modalRuleName = code;
  const builtin = !ruleDef(code) && userOverrides[code] === undefined;
  $('#modal-title').textContent = titleCase(code);
  $('#rule-note').textContent = builtin
    ? 'Built-in rule from the extended ruleset — edit the severity (error/warn/info/hint/off) or replace with a full rule definition.'
    : 'Edit this rule. Apply re-lints with your change.';
  ($('#modal') as HTMLElement).hidden = false;
  const ed = ensureRuleEditor();
  ed.setValue(stringifyYaml({ [code]: ruleDefForEditing(code) }));
  requestAnimationFrame(() => { ed.layout(); ed.focus(); });
}
function closeModal() {
  ($('#modal') as HTMLElement).hidden = true;
}
$('#modal-close').addEventListener('click', closeModal);
$('#modal').addEventListener('click', (e) => { if (e.target === $('#modal')) closeModal(); });
$('#rule-apply').addEventListener('click', () => {
  if (!ruleEditor) return;
  try {
    const parsed = parseYaml(ruleEditor.getValue());
    const entry = parsed && typeof parsed === 'object' ? Object.entries(parsed)[0] : undefined;
    if (entry) userOverrides[entry[0]] = entry[1];
    closeModal();
    runLint();
  } catch {
    $('#rule-note').textContent = 'Invalid YAML — fix and try again.';
  }
});
$('#rule-reset').addEventListener('click', () => {
  delete userOverrides[modalRuleName];
  closeModal();
  runLint();
});
$('#rule-disable').addEventListener('click', () => {
  userOverrides[modalRuleName] = 'off';
  closeModal();
  runLint();
});

// ---- documents (client-side local storage) ----------------------------------
function loadDocIntoEditor(doc: SavedDoc) {
  current = artifactById(doc.type);
  typeSelect.value = current.id;
  docLang = doc.lang;
  $('#lang-yaml').classList.toggle('active', docLang === 'yaml');
  $('#lang-json').classList.toggle('active', docLang === 'json');
  suppressSave = true;
  const model = docEditor.getModel();
  if (model) monaco.editor.setModelLanguage(model, docLang === 'json' ? 'json' : 'yaml');
  docEditor.setValue(doc.content);
  suppressSave = false;
  activeId = doc.id;
  setActiveId(doc.id);
  $('#doc-status').textContent = `${doc.name} · ${current.label}`;
  rebuildCategories();
  renderSaved();
  runLint();
}

function persistActive() {
  if (!activeId) return;
  const docs = loadDocs();
  const d = docs.find((x) => x.id === activeId);
  if (!d) return;
  d.content = docEditor.getValue();
  d.lang = docLang;
  d.updatedAt = Date.now();
  saveDocs(docs);
  renderSaved();
}
let saveTimer: number | undefined;
function scheduleSave() {
  clearTimeout(saveTimer);
  saveTimer = window.setTimeout(persistActive, 500);
}

function timeAgo(ts: number): string {
  const s = Math.floor((Date.now() - ts) / 1000);
  if (s < 45) return 'just now';
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}
function renderSaved() {
  const docs = loadDocs().sort((a, b) => b.updatedAt - a.updatedAt);
  $('#saved-count').textContent = String(docs.length);
  const list = $('#saved-list');
  list.innerHTML = docs.length
    ? docs
        .map((d) => `<li class="${d.id === activeId ? 'active' : ''}" data-id="${d.id}">
          <span class="saved-name" title="${escapeHtml(d.name)}">${escapeHtml(d.name)}</span>
          <span class="saved-meta">${escapeHtml(artifactById(d.type).label)} · ${timeAgo(d.updatedAt)}</span>
          <button class="saved-load" type="button">Load</button>
          <button class="saved-del" type="button" title="Remove">&times;</button>
        </li>`)
        .join('')
    : '<li class="saved-empty">No saved documents yet — your edits autosave here.</li>';
  list.querySelectorAll<HTMLLIElement>('li[data-id]').forEach((li) => {
    const id = li.dataset.id!;
    li.querySelector<HTMLButtonElement>('.saved-load')?.addEventListener('click', () => {
      const d = getDoc(id);
      if (d) { loadDocIntoEditor(d); switchTab('results'); }
    });
    li.querySelector<HTMLButtonElement>('.saved-del')?.addEventListener('click', (e) => {
      e.stopPropagation();
      removeSaved(id);
    });
  });
}
function removeSaved(id: string) {
  removeDoc(id);
  if (id === activeId) {
    activeId = null;
    setActiveId(null);
    const rest = loadDocs().sort((a, b) => b.updatedAt - a.updatedAt);
    if (rest.length) loadDocIntoEditor(rest[0]);
    else setArtifact('openapi');
  } else {
    renderSaved();
  }
}
function switchTab(name: string) {
  document.querySelectorAll<HTMLButtonElement>('.tab').forEach((t) => t.classList.toggle('active', t.dataset.tab === name));
  ($('#tab-results') as HTMLElement).hidden = name !== 'results';
  ($('#tab-saved') as HTMLElement).hidden = name !== 'saved';
}
document.querySelectorAll<HTMLButtonElement>('.tab').forEach((t) => t.addEventListener('click', () => switchTab(t.dataset.tab!)));

// ---- boot -------------------------------------------------------------------
docEditor.onDidChangeModelContent(() => {
  scheduleLint();
  if (!suppressSave) scheduleSave();
});
const restoreId = getActiveId();
const restored = restoreId ? getDoc(restoreId) : undefined;
if (restored) loadDocIntoEditor(restored);
else setArtifact('openapi');
