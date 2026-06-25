import * as monaco from 'monaco-editor';
import EditorWorker from 'monaco-editor/esm/vs/editor/editor.worker?worker';
import JsonWorker from 'monaco-editor/esm/vs/language/json/json.worker?worker';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';
import { lint, builtinDescriptions, builtinRulesByFormat } from './spotlight';
import { ruleset as compiledRuleset } from './compiled-ruleset';
import { ARTIFACTS, DEFAULT_RULESETS, SAMPLES, artifactById, type ArtifactType } from './artifacts';
import { searchArtifacts, loadArtifactContent, type SearchHit } from './apisio';
import { loadDocs, saveDocs, upsertDoc, removeDoc, getDoc, findDoc, getActiveId, setActiveId, newId, loadRules, upsertRule, removeRule, getRule, clearAll, loadConfig, saveConfig, type SavedDoc, type Config } from './storage';
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
let activeId: string | null = null; // id of the localStorage doc being edited
let suppressSave = false; // true while programmatically replacing editor content
const labelForFormat = (fmt: string) => ARTIFACTS.find((a) => a.format === fmt)?.label ?? fmt;

// ---- editors ----------------------------------------------------------------
const docEditor = monaco.editor.create($('#doc-editor'), {
  value: SAMPLES[current.id] ?? '',
  language: 'yaml',
  theme: 'vs-dark',
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
      value: '', language: 'yaml', theme: 'vs-dark', automaticLayout: true,
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
    .filter((w) => !/^oas[23]$/i.test(w)) // scrub OAS2/OAS3 version tokens from display
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

// ---- rule category lookup (for grouping results) ----------------------------
function categoryOf(code: string): string {
  const r = ruleDef(code);
  const tags: string[] = Array.isArray(r?.tags) ? r.tags : [];
  const cat = tags.find((t) => t.startsWith('category:'));
  return cat ? cat.slice('category:'.length) : 'other';
}
// categories the user has collapsed — preserved across re-lints
const collapsedCats = new Set<string>();

// ---- active ruleset ---------------------------------------------------------
function activeRulesetDef(): any {
  const rules: Record<string, any> = {};
  // compiled best-of-breed rules for this format
  for (const [name, rule] of Object.entries(COMPILED_RULES)) {
    const t: string[] = Array.isArray(rule?.tags) ? rule.tags : [];
    if (!t.includes(`format:${current.format}`)) continue;
    if (t.includes('duplicate:true')) continue;
    rules[name] = rule;
  }
  // per-type default starter rules
  for (const [name, rule] of Object.entries(defaultRules())) {
    rules[name] = rule;
  }
  // we don't support Swagger / OpenAPI 2.0 — turn off any built-in oas2 rules
  for (const name of builtinRulesByFormat[current.format] ?? []) {
    if (/^oas2[-_]/i.test(name)) rules[name] = 'off';
  }
  // saved rule overrides for this format take priority over the originals
  const isInline = (name: string) => name in COMPILED_RULES || name in defaultRules();
  for (const r of loadRules()) {
    if (r.format && r.format !== current.format) continue;
    if (r.def === 'off' || r.def === false) {
      // Disable: drop inline rules entirely (so they don't run); only the `off`
      // toggle is valid for rules that come from `extends` (Spectral would throw
      // "Cannot extend non-existing rule" if an inline rule is set to 'off').
      if (isInline(r.name)) delete rules[r.name];
      else rules[r.name] = 'off';
    } else {
      rules[r.name] = r.def;
    }
  }

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
    $('#results').innerHTML = `<div class="err">Ruleset/lint error: ${escapeHtml(error)}</div>`;
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

  const renderRow = (d: any) => {
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
  };

  // group diagnostics by the category of the rule that produced them
  const groups = new Map<string, any[]>();
  for (const d of diagnostics) {
    const cat = categoryOf(String(d.code));
    (groups.get(cat) ?? groups.set(cat, []).get(cat)!).push(d);
  }
  // groups with errors first, then larger groups first
  const ordered = [...groups.entries()].sort((a, b) => {
    const aErr = a[1].some((d) => d.severity === 0) ? 0 : 1;
    const bErr = b[1].some((d) => d.severity === 0) ? 0 : 1;
    return aErr - bErr || b[1].length - a[1].length || a[0].localeCompare(b[0]);
  });

  $('#results').innerHTML = diagnostics.length
    ? ordered
        .map(([cat, ds]) => {
          ds.sort((a, b) => a.range.start.line - b.range.start.line);
          const errs = ds.filter((d) => d.severity === 0).length;
          const open = collapsedCats.has(cat) ? '' : ' open';
          return `<details class="rule-group"${open} data-cat="${escapeHtml(cat)}">
            <summary>
              <span class="group-name">${escapeHtml(titleCase(cat))}</span>
              <span class="group-count">${ds.length}${errs ? ` · ${errs} error${errs === 1 ? '' : 's'}` : ''}</span>
            </summary>
            <ul class="group-results">${ds.map(renderRow).join('')}</ul>
          </details>`;
        })
        .join('')
    : '<div class="ok">No problems found 🎉</div>';

  $('#result-count').textContent = `${diagnostics.length} problem${diagnostics.length === 1 ? '' : 's'}`;
  $('#results')
    .querySelectorAll<HTMLDetailsElement>('details.rule-group')
    .forEach((dEl) => {
      dEl.addEventListener('toggle', () => {
        if (dEl.open) collapsedCats.delete(dEl.dataset.cat!);
        else collapsedCats.add(dEl.dataset.cat!);
      });
    });
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
let modalRuleFormat = ''; // format the edited rule belongs to (so overrides are scoped)
function ruleDefForEditing(code: string): any {
  const saved = getRule(code, modalRuleFormat);
  if (saved) return saved.def;
  const r = ruleDef(code);
  if (r) {
    const { tags: _t, ...rest } = r; // hide tag noise while editing
    return rest;
  }
  return 'warn'; // built-in rule (from the extended ruleset) — edit as a severity toggle
}
function openRuleModal(code: string, format: string = current.format) {
  modalRuleName = code;
  modalRuleFormat = format;
  const builtin = !ruleDef(code) && !getRule(code, format);
  $('#modal-title').textContent = titleCase(code);
  $('#rule-note').textContent = builtin
    ? 'Built-in rule from the extended ruleset — edit the severity (error/warn/info/hint/off) or replace with a full rule definition.'
    : 'Edit this rule. Saving overrides the original when linting.';
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
    if (entry) upsertRule(entry[0], modalRuleFormat, entry[1]);
    closeModal();
    renderSavedRules();
    runLint();
  } catch {
    $('#rule-note').textContent = 'Invalid YAML — fix and try again.';
  }
});
$('#rule-reset').addEventListener('click', () => {
  removeRule(modalRuleName, modalRuleFormat);
  closeModal();
  renderSavedRules();
  runLint();
});
$('#rule-disable').addEventListener('click', () => {
  upsertRule(modalRuleName, modalRuleFormat, 'off');
  closeModal();
  renderSavedRules();
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
          <span class="store-name" title="${escapeHtml(d.name)}">${escapeHtml(d.name)}</span>
          <span class="store-meta">${escapeHtml(artifactById(d.type).label)} · ${timeAgo(d.updatedAt)}</span>
          <button class="store-btn" type="button">Load</button>
          <button class="store-del" type="button" title="Remove">&times;</button>
        </li>`)
        .join('')
    : '<li class="store-empty">No saved documents yet — your edits autosave here.</li>';
  list.querySelectorAll<HTMLLIElement>('li[data-id]').forEach((li) => {
    const id = li.dataset.id!;
    li.querySelector<HTMLButtonElement>('.store-btn')?.addEventListener('click', () => {
      const d = getDoc(id);
      if (d) { loadDocIntoEditor(d); switchTab('results'); }
    });
    li.querySelector<HTMLButtonElement>('.store-del')?.addEventListener('click', (e) => {
      e.stopPropagation();
      removeSaved(id);
    });
  });
}
function renderSavedRules() {
  const rules = loadRules().sort((a, b) => b.updatedAt - a.updatedAt);
  $('#rules-count').textContent = String(rules.length);
  const list = $('#saved-rules-list');
  list.innerHTML = rules.length
    ? rules
        .map((r) => {
          const disabled = r.def === 'off' || r.def === false;
          const state = disabled ? 'disabled' : typeof r.def === 'object' && r.def?.severity ? r.def.severity : 'custom';
          return `<li class="${disabled ? 'rule-off' : ''}" data-name="${escapeHtml(r.name)}" data-format="${escapeHtml(r.format)}" data-disabled="${disabled ? '1' : ''}">
            <span class="store-name" title="${escapeHtml(r.name)}">${escapeHtml(titleCase(r.name))}</span>
            <span class="store-meta">${escapeHtml(labelForFormat(r.format))} · ${escapeHtml(String(state))} · ${timeAgo(r.updatedAt)}</span>
            <button class="store-btn rule-primary" type="button">${disabled ? 'Enable' : 'Edit'}</button>
            <button class="store-del rule-del" type="button" title="Revert to original">&times;</button>
          </li>`;
        })
        .join('')
    : '<li class="store-empty">No saved rules yet — edit a rule from a result to override or disable it.</li>';
  list.querySelectorAll<HTMLLIElement>('li[data-name]').forEach((li) => {
    const name = li.dataset.name!;
    const fmt = li.dataset.format!;
    const disabled = li.dataset.disabled === '1';
    li.querySelector<HTMLButtonElement>('.rule-primary')?.addEventListener('click', () => {
      if (disabled) {
        removeRule(name, fmt); // re-enable = drop the override, reverting to the original
        renderSavedRules();
        runLint();
      } else {
        switchTab('results');
        openRuleModal(name, fmt);
      }
    });
    li.querySelector<HTMLButtonElement>('.rule-del')?.addEventListener('click', () => {
      removeRule(name, fmt);
      renderSavedRules();
      runLint();
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
  ($('#tab-ruleset') as HTMLElement).hidden = name !== 'ruleset';
  ($('#tab-saved') as HTMLElement).hidden = name !== 'saved';
  ($('#tab-rules') as HTMLElement).hidden = name !== 'rules';
  ($('#tab-config') as HTMLElement).hidden = name !== 'config';
  if (name === 'ruleset') renderRuleset();
}

// ---- Rules tab: every rule grouped by artifact, with enable/disable ----------
const expandedArtifacts = new Set<string>();
function isDisabled(name: string, format: string): boolean {
  const r = getRule(name, format);
  return !!r && (r.def === 'off' || r.def === false);
}
function rulesForArtifact(a: ArtifactType): Array<{ name: string; category: string }> {
  const list: Array<{ name: string; category: string }> = [];
  const seen = new Set<string>();
  const add = (name: string, rule: any) => {
    if (seen.has(name)) return;
    seen.add(name);
    const tags: string[] = Array.isArray(rule?.tags) ? rule.tags : [];
    const cat = (tags.find((t) => t.startsWith('category:')) ?? 'category:other').slice('category:'.length);
    list.push({ name, category: cat });
  };
  for (const [name, rule] of Object.entries(COMPILED_RULES)) {
    const t: string[] = Array.isArray((rule as any)?.tags) ? (rule as any).tags : [];
    if (t.includes(`format:${a.format}`) && !t.includes('duplicate:true')) add(name, rule);
  }
  for (const [name, rule] of Object.entries(DEFAULT_RULESETS[a.id]?.rules ?? {})) add(name, rule);
  for (const name of builtinRulesByFormat[a.format] ?? []) {
    if (/^oas2[-_]/i.test(name)) continue; // no Swagger support
    add(name, null);
  }
  return list.sort((x, y) => x.name.localeCompare(y.name));
}
function renderRuleset() {
  $('#ruleset-list').innerHTML = ARTIFACTS.map((a) => {
    const rules = rulesForArtifact(a);
    if (!rules.length) return '';
    const off = rules.filter((r) => isDisabled(r.name, a.format)).length;
    const open = expandedArtifacts.has(a.id) ? ' open' : '';
    const rows = rules
      .map((r) => {
        const dis = isDisabled(r.name, a.format);
        return `<li>
          <label class="rule-toggle">
            <input type="checkbox" data-name="${escapeHtml(r.name)}" data-format="${escapeHtml(a.format)}"${dis ? '' : ' checked'}>
            <span class="rule-tname${dis ? ' off' : ''}" title="${escapeHtml(r.name)}">${escapeHtml(titleCase(r.name))}</span>
          </label>
          <span class="rule-tcat">${escapeHtml(r.category)}</span>
        </li>`;
      })
      .join('');
    return `<details class="rule-group"${open} data-art="${a.id}">
      <summary><span class="group-name">${escapeHtml(a.label)}</span><span class="group-count">${rules.length} rules${off ? ` · ${off} off` : ''}</span></summary>
      <ul class="ruleset-rules">${rows}</ul>
    </details>`;
  }).join('');
}
// delegated handlers (attached once)
$('#ruleset-list').addEventListener('change', (e) => {
  const cb = e.target as HTMLInputElement;
  if (!(cb instanceof HTMLInputElement) || cb.type !== 'checkbox') return;
  const name = cb.dataset.name!;
  const fmt = cb.dataset.format!;
  if (cb.checked) {
    if (isDisabled(name, fmt)) removeRule(name, fmt); // re-enable = drop the 'off' override
  } else {
    upsertRule(name, fmt, 'off'); // disable
  }
  cb.closest('li')?.querySelector('.rule-tname')?.classList.toggle('off', !cb.checked);
  renderSavedRules();
  runLint();
});
// `toggle` doesn't bubble — listen in the capture phase to track expand state
$('#ruleset-list').addEventListener('toggle', (e) => {
  const d = e.target as HTMLDetailsElement;
  if (!(d instanceof HTMLDetailsElement) || !d.dataset.art) return;
  if (d.open) expandedArtifacts.add(d.dataset.art);
  else expandedArtifacts.delete(d.dataset.art);
}, true);

// ---- configuration (API keys / tokens) --------------------------------------
const CFG_FIELDS: Array<[string, keyof Config]> = [
  ['cfg-claude', 'claude'], ['cfg-gemini', 'gemini'], ['cfg-chatgpt', 'chatgpt'], ['cfg-github', 'github'],
];
(function initConfig() {
  const cfg = loadConfig();
  for (const [id, key] of CFG_FIELDS) {
    const el = $<HTMLInputElement>('#' + id);
    el.value = cfg[key] ?? '';
    let t: number | undefined;
    el.addEventListener('input', () => {
      clearTimeout(t);
      t = window.setTimeout(() => {
        const c = loadConfig();
        const v = el.value.trim();
        if (v) c[key] = v;
        else delete c[key];
        saveConfig(c);
      }, 300);
    });
  }
  $<HTMLInputElement>('#cfg-show').addEventListener('change', (e) => {
    const type = (e.target as HTMLInputElement).checked ? 'text' : 'password';
    for (const [id] of CFG_FIELDS) $<HTMLInputElement>('#' + id).type = type;
  });
})();
document.querySelectorAll<HTMLButtonElement>('.tab').forEach((t) => t.addEventListener('click', () => switchTab(t.dataset.tab!)));

// Explicit Save — names an Untitled draft, then persists immediately (alongside autosave).
function saveCurrent() {
  let d = activeId ? getDoc(activeId) : undefined;
  if (!d) {
    d = { id: newId(), name: `Untitled ${current.label}`, type: current.id, lang: docLang, content: docEditor.getValue(), updatedAt: Date.now() };
    activeId = d.id;
    setActiveId(d.id);
  }
  if (/^Untitled /.test(d.name)) {
    const name = window.prompt('Save document as:', d.name);
    if (name === null) return; // cancelled
    const trimmed = name.trim();
    if (trimmed) d.name = trimmed;
  }
  d.content = docEditor.getValue();
  d.lang = docLang;
  d.updatedAt = Date.now();
  upsertDoc(d);
  $('#doc-status').textContent = `${d.name} · ${current.label}`;
  renderSaved();
  const btn = $('#doc-save');
  btn.textContent = 'Saved ✓';
  window.setTimeout(() => { btn.textContent = 'Save'; }, 1200);
}
$('#doc-save').addEventListener('click', saveCurrent);

// Reset — clears ALL local storage (saved artifacts + rule overrides) after a confirm.
$('#reset-storage').addEventListener('click', () => {
  if (!window.confirm('Reset local storage? This permanently clears every saved artifact, rule override, and saved API key/token stored in this browser. This cannot be undone.')) return;
  clearAll();
  activeId = null;
  renderSaved();
  renderSavedRules();
  setArtifact('openapi'); // start fresh from the default
});

// ---- boot -------------------------------------------------------------------
docEditor.onDidChangeModelContent(() => {
  scheduleLint();
  if (!suppressSave) scheduleSave();
});
renderSavedRules();
const restoreId = getActiveId();
const restored = restoreId ? getDoc(restoreId) : undefined;
if (restored) loadDocIntoEditor(restored);
else setArtifact('openapi');
