import * as monaco from 'monaco-editor';
import EditorWorker from 'monaco-editor/esm/vs/editor/editor.worker?worker';
import JsonWorker from 'monaco-editor/esm/vs/language/json/json.worker?worker';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';
import { lint, builtinDescriptions, builtinRulesByFormat } from './spotlight';
import { Markdown } from './markdown';
import { ARTIFACTS, SAMPLES, artifactById, type ArtifactType } from './artifacts';
import allRulesRaw from './all-rules.json';
import { searchSource, loadHit, enabledSources, type Hit, type SourceId, type Tokens } from './sources';
import { loadDocs, saveDocs, upsertDoc, removeDoc, getDoc, findDoc, getActiveId, setActiveId, newId, loadRules, upsertRule, removeRule, getRule, clearAll, loadConfig, saveConfig, type SavedDoc, type Config } from './storage';
import builtinMetaRaw from './builtin-meta.json';
import { aiFix, aiFixFragment, generatePrompt, PROVIDERS, type Provider, type Finding } from './fix';
import { listAccessibleRepos, loadRepos, addRepo, removeRepo, type Repo } from './repos';
import { commitGitHub, openPrGitHub } from './git';
import { utilitiesFor } from './utilities';
import { renderDocs as renderDocsHtml, renderDocsMarkdown, standaloneDocs, DOCS_CSS } from './docs';
import { buildApisJson } from './apisjson';
import { initEngage } from './engage';
import './style.css';

// Curated experience/spec tags for the upstream spotlight:* built-in rules.
const BUILTIN_META = builtinMetaRaw as Record<string, { format: string; spec: string[]; experience: string[] }>;

self.MonacoEnvironment = {
  getWorker(_id, label) {
    return label === 'json' ? new JsonWorker() : new EditorWorker();
  },
};

const $ = <T extends HTMLElement>(sel: string) => document.querySelector(sel) as T;

// The curated rule catalog (all-rules.yaml), grouped by artifact format — the
// validator now runs THIS instead of the old compiled ruleset.
const ALL_RULES = allRulesRaw as Record<string, Record<string, any>>;
// flat name -> rule (+ its format) for lookups by a finding's code
const RULE_INDEX: Record<string, any> = {};
for (const [fmt, rules] of Object.entries(ALL_RULES)) for (const [name, r] of Object.entries(rules)) RULE_INDEX[name] = { ...(r as any), _format: fmt };
// which engine built-in ruleset each format extends (built-ins run from there,
// not from the data form; their catalog entries carry source: builtin)
const EXTENDS_FOR: Record<string, string> = { openapi: 'spotlight:oas', asyncapi: 'spotlight:asyncapi', arazzo: 'spotlight:arazzo' };
// strip catalog-only metadata the lint engine doesn't understand
function engineRule(r: any): any { const { source, title, reference, prompt, _format, ...rest } = r; return rest; }

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

// ---- rule lookups (the curated catalog + built-in metadata fallback) --------
function ruleDef(code: string): any {
  return RULE_INDEX[code];
}
function descriptionFor(code: string): string {
  return (RULE_INDEX[code]?.description as string) ?? builtinDescriptions[code] ?? '';
}
// Curated AI fix prompt from the catalog; falls back to one generated from the
// rule definition when a finding's rule has no prompt (rare).
function promptFor(code: string): string {
  return RULE_INDEX[code]?.prompt || generatePrompt(code, ruleDef(code), descriptionFor(code), labelForFormat(current.format));
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

// ---- search source selector (APIs.io default + GitHub; GitLab/Bitbucket opt-in) ----
const sourceSelect = $<HTMLSelectElement>('#source-select');
let currentSource: SourceId = 'apis.io';
export function populateSources() {
  const cfg = loadConfig();
  const enabled = enabledSources(cfg.sources);
  sourceSelect.innerHTML = enabled.map((s) => `<option value="${s.id}">${s.label}</option>`).join('');
  if (!enabled.some((s) => s.id === currentSource)) currentSource = 'apis.io';
  sourceSelect.value = currentSource;
}
function gitTokens(): Tokens {
  const c = loadConfig();
  return { github: c.github, gitlab: c.gitlab, bitbucketUser: c.bitbucketUser, bitbucket: c.bitbucket };
}
populateSources();
sourceSelect.addEventListener('change', () => { currentSource = sourceSelect.value as SourceId; });

// ---- AI fix provider (Claude / Gemini / ChatGPT) ----------------------------
const fixProviderSelect = $<HTMLSelectElement>('#fix-provider');
let currentProvider: Provider | null = null;
let lastDiagnostics: any[] = [];
let activeFixes = 0; // number of in-flight fixes (block re-render while fixing)
function configuredProviders(): Provider[] {
  const c = loadConfig();
  return (['claude', 'gemini', 'chatgpt'] as Provider[]).filter((p) => (c[p] || '').trim());
}
function refreshFixControls() {
  const provs = configuredProviders();
  ($('#fix-controls') as HTMLElement).hidden = provs.length === 0;
  fixProviderSelect.innerHTML = provs.map((p) => `<option value="${p}">${PROVIDERS[p].label}</option>`).join('');
  if (!currentProvider || !provs.includes(currentProvider)) currentProvider = provs[0] ?? null;
  if (currentProvider) fixProviderSelect.value = currentProvider;
}
fixProviderSelect.addEventListener('change', () => { currentProvider = fixProviderSelect.value as Provider; });
const fixPrecise = $<HTMLInputElement>('#fix-precise');

// The contiguous full-line span a finding points at (its node in the source).
function fragmentLines(d: any, lines: string[]): { s0: number; e0: number } {
  const s0 = Math.max(0, Math.min(lines.length - 1, d.range.start.line));
  let e0 = d.range.end.line;
  if (d.range.end.character === 0 && e0 > s0) e0 -= 1; // end sits at col 0 of the next line
  e0 = Math.min(lines.length - 1, Math.max(s0, e0));
  return { s0, e0 };
}
// Re-indent the model's fragment so its base indentation matches the original
// (guards against a model that dedents or over-indents what it returns).
function matchBaseIndent(original: string, corrected: string): string {
  const base = (s: string) => {
    const ls = s.split('\n').filter((l) => l.trim());
    return ls.length ? Math.min(...ls.map((l) => l.match(/^ */)![0].length)) : 0;
  };
  const delta = base(original) - base(corrected);
  if (delta === 0) return corrected;
  if (delta > 0) return corrected.split('\n').map((l) => (l.trim() ? ' '.repeat(delta) + l : l)).join('\n');
  return corrected.split('\n').map((l) => (l.trim() ? l.slice(Math.min(l.match(/^ */)![0].length, -delta)) : l)).join('\n');
}
function docParses(text: string): boolean {
  if (current.format === 'agent-skill') return true; // markdown — no structural parse
  try { docLang === 'json' ? JSON.parse(text) : parseYaml(text); return true; } catch { return false; }
}

// Precise fix: send ONLY the flagged fragment, splice the corrected fragment
// back into the same line span. Falls back to nothing-destructive on a bad splice.
async function fixPreciseOne(d: any, key: string): Promise<void> {
  const model = docEditor.getModel()!;
  const lines = model.getValue().split('\n');
  const { s0, e0 } = fragmentLines(d, lines);
  const original = lines.slice(s0, e0 + 1).join('\n');
  const path = Array.isArray(d.path) ? d.path.join('.') : '';
  let corrected = await aiFixFragment(currentProvider!, key, promptFor(String(d.code)), labelForFormat(current.format), path, original, docLang);
  if (!corrected.trim()) throw new Error('Model returned an empty fragment');
  corrected = matchBaseIndent(original, corrected);
  const newText = [...lines.slice(0, s0), ...corrected.split('\n'), ...lines.slice(e0 + 1)].join('\n');
  if (!docParses(newText)) throw new Error('Fix produced an invalid document — not applied');
  const range = new monaco.Range(s0 + 1, 1, e0 + 1, model.getLineMaxColumn(e0 + 1));
  docEditor.pushUndoStop();
  docEditor.executeEdits('ai-fix', [{ range, text: corrected, forceMoveMarkers: true }]);
  docEditor.pushUndoStop();
}
// Whole-document fix: send the full artifact, replace it entirely.
async function fixWholeDoc(code: string, key: string): Promise<void> {
  const findings: Finding[] = lastDiagnostics
    .filter((d) => String(d.code) === code)
    .map((d) => ({ line: d.range.start.line + 1, message: String(d.message) }));
  const fixed = await aiFix(currentProvider!, key, promptFor(code), findings, docEditor.getValue(), docLang);
  if (!fixed.trim()) throw new Error('Model returned an empty document');
  const model = docEditor.getModel()!;
  docEditor.pushUndoStop();
  docEditor.executeEdits('ai-fix', [{ range: model.getFullModelRange(), text: fixed, forceMoveMarkers: true }]);
  docEditor.pushUndoStop();
}
async function doFix(di: number, li: HTMLElement) {
  const d = lastDiagnostics[di];
  if (!d || !currentProvider) return;
  const key = (loadConfig()[currentProvider] || '').trim();
  if (!key) { refreshFixControls(); return; }
  const btn = li.querySelector<HTMLButtonElement>('.fix-btn');
  const prev = btn?.textContent ?? '✨ fix';
  const precise = fixPrecise?.checked ?? true;
  if (btn) { btn.disabled = true; btn.textContent = precise ? '… fixing node' : '… fixing doc'; btn.title = `Fixing with ${PROVIDERS[currentProvider].label}…`; }
  activeFixes++;
  try {
    if (precise) await fixPreciseOne(d, key);
    else await fixWholeDoc(String(d.code), key);
    if (btn) { btn.textContent = '✓ fixed'; btn.title = 'Applied — re-linting'; }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (btn) { btn.textContent = '✗ failed'; btn.title = msg; }
    console.error('AI fix failed for', d.code, e);
  } finally {
    activeFixes--;
    if (btn) { btn.disabled = false; window.setTimeout(() => { btn.textContent = prev; }, 2500); }
  }
}

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
// Results group by the rule's primary experience tag (falls back to category, then other).
function categoryOf(code: string): string {
  const r = ruleDef(code);
  const tags: string[] = Array.isArray(r?.tags) ? r.tags : [];
  const exp = tags.find((t) => t.startsWith('experience:'));
  if (exp) return exp.slice('experience:'.length);
  if (BUILTIN_META[code]?.experience?.[0]) return BUILTIN_META[code].experience[0];
  const cat = tags.find((t) => t.startsWith('category:'));
  return cat ? cat.slice('category:'.length) : 'other';
}
// accordion: only one result group open at a time (its category, or the first group)
let openResultCat: string | null = null;

// ---- tag filter (shared by Results + Rules) ---------------------------------
// Uniform tag list for any rule: compiled/default carry a `tags[]`; built-ins
// derive theirs from BUILTIN_META. This is what both the chips and the filter use.
function tagsFor(code: string): string[] {
  const r = ruleDef(code);
  if (Array.isArray(r?.tags)) return r.tags as string[];
  const m = BUILTIN_META[code];
  if (m) return [
    ...(m.spec || []).map((s) => `spec:${s}`),
    ...(m.experience || []).map((e) => `experience:${e}`),
    ...(m.format ? [`format:${m.format}`] : []),
  ];
  return [];
}

// Facets shown in the filter + as row chips. `format`/`source` are intentionally
// excluded (format = artifact grouping; provenance isn't useful here).
const FACET_NS = ['experience', 'spec', 'topic', 'owasp'] as const;
const FILTER_KEY = 'spotlight-validator:filter';
const activeTags = new Set<string>((() => {
  try { const v = JSON.parse(localStorage.getItem(FILTER_KEY) || '[]'); return Array.isArray(v) ? v : []; } catch { return []; }
})());
let activeTab = 'results';
function saveFilter() {
  try { localStorage.setItem(FILTER_KEY, JSON.stringify([...activeTags])); } catch { /* ignore */ }
}
// AND across namespaces, OR within a namespace. Empty filter ⇒ keep everything.
function ruleMatchesFilter(tags: string[]): boolean {
  if (activeTags.size === 0) return true;
  const tset = new Set(tags);
  const byNs: Record<string, string[]> = {};
  for (const t of activeTags) { const ns = t.split(':')[0]; (byNs[ns] ??= []).push(t); }
  return Object.values(byNs).every((group) => group.some((t) => tset.has(t)));
}
// The consistent chip set rendered on every rule listing (Results + Rules).
function tagChips(tags: string[]): string {
  const chips = (FACET_NS as readonly string[]).flatMap((ns) =>
    tags.filter((t) => t.startsWith(ns + ':')).map((t) => ({ ns, v: t.slice(ns.length + 1), t })));
  if (!chips.length) return '';
  return `<span class="chips">${chips.map((c) =>
    `<button type="button" class="chip chip-${c.ns}${activeTags.has(c.t) ? ' on' : ''}" data-tag="${escapeHtml(c.t)}" title="${c.ns}: ${escapeHtml(c.v)} — click to filter">${escapeHtml(c.v)}</button>`).join('')}</span>`;
}
// Build the facet bar from every rule's tags (union across all artifacts).
function collectFacets(): Record<string, string[]> {
  const sets: Record<string, Set<string>> = {};
  for (const ns of FACET_NS) sets[ns] = new Set();
  const consider = (tags: string[]) => { for (const t of tags) { const ns = t.split(':')[0]; if (sets[ns]) sets[ns].add(t.slice(ns.length + 1)); } };
  for (const rules of Object.values(ALL_RULES)) for (const rule of Object.values(rules)) consider(Array.isArray((rule as any)?.tags) ? (rule as any).tags : []);
  for (const a of ARTIFACTS) for (const name of builtinRulesByFormat[a.format] ?? []) consider(tagsFor(name));
  const out: Record<string, string[]> = {};
  for (const ns of FACET_NS) if (sets[ns].size) out[ns] = [...sets[ns]].sort();
  return out;
}
let facetsBuilt = false;
function buildFilterUI() {
  const facets = collectFacets();
  $('#filter-facets').innerHTML = Object.entries(facets).map(([ns, vals]) => `
    <div class="facet">
      <div class="facet-ns">${ns}</div>
      <div class="facet-chips">${vals.map((v) => {
        const t = `${ns}:${v}`;
        return `<button type="button" class="facet-chip chip-${ns}${activeTags.has(t) ? ' on' : ''}" data-tag="${escapeHtml(t)}">${escapeHtml(v)}</button>`;
      }).join('')}</div>
    </div>`).join('');
  facetsBuilt = true;
  refreshFilterState();
}
function refreshFilterState() {
  const n = activeTags.size;
  $('#filter-active').textContent = n ? `${n} active` : '';
  ($('#filter-clear') as HTMLElement).hidden = n === 0;
  document.querySelectorAll<HTMLElement>('[data-tag]').forEach((el) => el.classList.toggle('on', activeTags.has(el.dataset.tag!)));
}
function toggleTag(tag: string) {
  if (activeTags.has(tag)) activeTags.delete(tag); else activeTags.add(tag);
  saveFilter();
  refreshFilterState();
  applyFilterToView();
}
function clearFilter() { activeTags.clear(); saveFilter(); refreshFilterState(); applyFilterToView(); }
function applyFilterToView() {
  if (activeTab === 'ruleset') renderRuleset();
  else renderResults();
}

// ---- active ruleset ---------------------------------------------------------
function activeRulesetDef(): any {
  const rules: Record<string, any> = {};
  // catalog rules for this format (built-ins come via `extends`, not the data form)
  for (const [name, rule] of Object.entries(ALL_RULES[current.format] || {})) {
    if ((rule as any).source === 'builtin') continue;
    const t: string[] = Array.isArray((rule as any).tags) ? (rule as any).tags : [];
    if (t.includes('duplicate:true')) continue;
    rules[name] = engineRule(rule);
  }
  // we don't support Swagger / OpenAPI 2.0 — turn off any built-in oas2 rules
  for (const name of builtinRulesByFormat[current.format] ?? []) {
    if (/^oas2[-_]/i.test(name)) rules[name] = 'off';
  }
  // saved rule overrides for this format take priority over the originals
  const isInline = (name: string) => !!ALL_RULES[current.format]?.[name] && ALL_RULES[current.format][name].source !== 'builtin';
  for (const r of loadRules()) {
    if (r.format && r.format !== current.format) continue;
    if (r.def === 'off' || r.def === false) {
      // Disable: drop inline rules entirely (so they don't run); only the `off`
      // toggle is valid for rules that come from `extends` (Spectral would throw
      // "Cannot extend non-existing rule" if an inline rule is set to 'off').
      if (isInline(r.name)) delete rules[r.name];
      else rules[r.name] = 'off';
    } else if (isInline(r.name)) {
      // Merge the partial override ({severity, message?, description?}) onto the
      // full base definition so `given`/`then` survive.
      const base = rules[r.name] && typeof rules[r.name] === 'object'
        ? rules[r.name]
        : engineRule(ALL_RULES[current.format][r.name]);
      const patch = typeof r.def === 'object' ? r.def : { severity: r.def };
      rules[r.name] = { ...base, ...patch };
    } else {
      // Built-in (extended) rule: the engine only accepts a severity string here.
      rules[r.name] = sevOf(r.def) ?? 'warn';
    }
  }

  $('#active-count').textContent = String(Object.keys(rules).length);
  const ext = EXTENDS_FOR[current.format];
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
  const srcLabel = sourceSelect.options[sourceSelect.selectedIndex]?.textContent || currentSource;
  showResultsMessage(`Searching ${srcLabel}…`);
  try {
    const hits = await searchSource(currentSource, current, q, gitTokens());
    if (!hits.length) {
      showResultsMessage(current.searchNote ?? `No ${current.label} results for “${q}” on ${srcLabel}.`);
      return;
    }
    resultsBox.innerHTML = hits
      .map((h, i) => `<div class="hit" data-i="${i}">
        <span class="hit-name">${escapeHtml(h.name)}</span>
        <span class="hit-provider">${escapeHtml(h.repo || '')}</span>
      </div>`)
      .join('');
    resultsBox.hidden = false;
    resultsBox.querySelectorAll<HTMLElement>('.hit').forEach((el) => {
      el.addEventListener('click', () => selectHit(hits[Number(el.dataset.i)]));
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    showResultsMessage(`${srcLabel} search unavailable: ${msg}`);
  }
}
function looksLikeMarkup(text: string): boolean {
  const t = text.trimStart().slice(0, 200).toLowerCase();
  return t.startsWith('<!doctype') || /^<(html|head|body)[\s>]/.test(t);
}
async function selectHit(hit: Hit) {
  showResultsMessage(`Loading ${hit.name}…`);
  try {
    const text = await loadHit(hit, gitTokens());
    if (looksLikeMarkup(text)) {
      showResultsMessage(`“${hit.name}” links to an HTML page, not a machine-readable ${current.label} document — can’t load it.`);
      return;
    }
    // Load as YAML and store it as a named local doc (reusing one if already loaded).
    const yaml = toYaml(text);
    const name = hit.name;
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
  // Agent skills are markdown (frontmatter + body) — lint them with the markdown parser.
  const { diagnostics, error } = current.format === 'agent-skill'
    ? await lint(text, activeRulesetDef(), 'document', Markdown)
    : await lint(text, activeRulesetDef());
  diagnostics.forEach((d: any, i: number) => { d._i = i; });
  lastDiagnostics = diagnostics;
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
  renderResults();
}

// Render the results list from lastDiagnostics, honoring the active tag filter.
function renderResults() {
  const total = lastDiagnostics.length;
  const shown = lastDiagnostics.filter((d) => ruleMatchesFilter(tagsFor(String(d.code))));

  const renderRow = (d: any) => {
    const sev = sevLabel[d.severity] ?? 'warning';
    const code = String(d.code);
    return `<li class="${sev}" data-sl="${d.range.start.line + 1}" data-el="${d.range.end.line + 1}" data-code="${escapeHtml(code)}" data-di="${d._i}">
      <span class="sev ${sev}" title="${sev}"></span>
      <span class="msg">${escapeHtml(d.message)}</span>
      ${currentProvider ? `<button class="fix-btn" title="Fix with AI (${PROVIDERS[currentProvider].label})">✨ fix</button>` : ''}
      <button class="edit-btn" title="Edit this rule">✎ edit</button>
    </li>`;
  };

  // group the shown diagnostics by the category of the rule that produced them
  const groups = new Map<string, any[]>();
  for (const d of shown) {
    const cat = categoryOf(String(d.code));
    (groups.get(cat) ?? groups.set(cat, []).get(cat)!).push(d);
  }
  const ordered = [...groups.entries()].sort((a, b) => {
    const aErr = a[1].some((d) => d.severity === 0) ? 0 : 1;
    const bErr = b[1].some((d) => d.severity === 0) ? 0 : 1;
    return aErr - bErr || b[1].length - a[1].length || a[0].localeCompare(b[0]);
  });
  const activeCat = (openResultCat && groups.has(openResultCat) ? openResultCat : ordered[0]?.[0]) ?? null;
  openResultCat = activeCat;
  $('#results').innerHTML = !total
    ? '<div class="ok">No problems found 🎉</div>'
    : !shown.length
      ? '<div class="ok">No results match the active tag filter.</div>'
      : ordered
          .map(([cat, ds]) => {
            ds.sort((a, b) => a.range.start.line - b.range.start.line);
            const errs = ds.filter((d) => d.severity === 0).length;
            const open = cat === activeCat ? ' open' : '';
            return `<details class="rule-group"${open} data-cat="${escapeHtml(cat)}">
              <summary>
                <span class="group-name">${escapeHtml(titleCase(cat))}</span>
                <span class="group-count">${ds.length}${errs ? ` · ${errs} error${errs === 1 ? '' : 's'}` : ''}</span>
              </summary>
              <ul class="group-results">${ds.map(renderRow).join('')}</ul>
            </details>`;
          })
          .join('');

  $('#result-count').textContent = activeTags.size && shown.length !== total
    ? `${shown.length} of ${total} shown`
    : `${total} problem${total === 1 ? '' : 's'}`;
  $('#results')
    .querySelectorAll<HTMLDetailsElement>('details.rule-group')
    .forEach((dEl) => {
      dEl.addEventListener('toggle', () => {
        if (dEl.open) {
          openResultCat = dEl.dataset.cat!;
          // accordion — close every other group
          $('#results').querySelectorAll<HTMLDetailsElement>('details.rule-group').forEach((o) => { if (o !== dEl) o.open = false; });
        } else if (openResultCat === dEl.dataset.cat) {
          openResultCat = null;
        }
      });
    });
  $('#results')
    .querySelectorAll<HTMLLIElement>('li[data-code]')
    .forEach((li) => {
      li.addEventListener('click', () => highlightLines(Number(li.dataset.sl), Number(li.dataset.el)));
      li.addEventListener('mouseenter', (e) => showLintTip(li.dataset.code!, e));
      li.addEventListener('mousemove', positionTip);
      li.addEventListener('mouseleave', hideLintTip);
      li.querySelector<HTMLButtonElement>('.fix-btn')?.addEventListener('click', (e) => {
        e.stopPropagation();
        doFix(Number(li.dataset.di), li);
      });
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

// ---- rule-description tooltip (prominent, readable) -------------------------
const lintTip = document.createElement('div');
lintTip.className = 'lint-tooltip';
lintTip.hidden = true;
document.body.appendChild(lintTip);
function showLintTip(code: string, e: MouseEvent) {
  const desc = descriptionFor(code);
  if (!desc) return;
  lintTip.innerHTML = `<div class="tt-title">${escapeHtml(titleCase(code))}</div><div class="tt-desc">${escapeHtml(desc)}</div>`;
  lintTip.hidden = false;
  positionTip(e);
}
function positionTip(e: MouseEvent) {
  if (lintTip.hidden) return;
  const r = lintTip.getBoundingClientRect();
  let left = e.clientX - r.width - 16;
  if (left < 8) left = e.clientX + 18;
  let top = e.clientY - 8;
  if (top + r.height > window.innerHeight - 8) top = window.innerHeight - r.height - 8;
  if (top < 8) top = 8;
  lintTip.style.left = `${left}px`;
  lintTip.style.top = `${top}px`;
}
function hideLintTip() {
  lintTip.hidden = true;
}

// ---- rule editor modal ------------------------------------------------------
let modalRuleName = '';
let modalRuleFormat = ''; // format the edited rule belongs to (so overrides are scoped)
// Inline (curated) rules carry a full definition we own; built-in rules come from
// the extended ruleset. Only inline rules can have message/description overridden —
// the engine rejects a partial override of an inherited built-in rule, so those
// are severity-only.
function isInlineRule(code: string, format: string): boolean {
  const r = (ALL_RULES[format] || {})[code];
  return !!r && (r as any).source !== 'builtin';
}
const sevOf = (def: any): string | undefined => (typeof def === 'string' ? def : def?.severity);
function effectiveRuleFields(code: string, format: string): { severity: string; message: string; description: string } {
  const saved = getRule(code, format);
  const savedDef = saved && saved.def !== 'off' && saved.def !== false ? saved.def : undefined;
  const base = RULE_INDEX[code] || {};
  const savedObj = savedDef && typeof savedDef === 'object' ? savedDef : {};
  return {
    severity: sevOf(savedDef) || base.severity || 'warn',
    message: savedObj.message ?? base.message ?? '',
    description: savedObj.description ?? descriptionFor(code) ?? '',
  };
}
function openRuleModal(code: string, format: string = current.format) {
  modalRuleName = code;
  modalRuleFormat = format;
  const inline = isInlineRule(code, format);
  const f = effectiveRuleFields(code, format);
  $('#modal-title').textContent = titleCase(code);
  $('#rule-note').textContent = inline
    ? 'Edit this rule’s severity, message, and description. Saving overrides the original when linting.'
    : 'Built-in rule — only its severity can be changed. Message and description come from the built-in ruleset.';
  $<HTMLSelectElement>('#rule-severity').value = f.severity;
  const msg = $<HTMLInputElement>('#rule-message');
  const desc = $<HTMLTextAreaElement>('#rule-description');
  msg.value = f.message;
  desc.value = f.description;
  msg.disabled = desc.disabled = !inline;
  $('#rf-message-note').textContent = inline ? '' : '(built-in — read only)';
  $('#rf-desc-note').textContent = inline ? '' : '(built-in — read only)';
  ($('#modal') as HTMLElement).hidden = false;
  requestAnimationFrame(() => $<HTMLSelectElement>('#rule-severity').focus());
}
function closeModal() {
  ($('#modal') as HTMLElement).hidden = true;
}
$('#modal-close').addEventListener('click', closeModal);
$('#modal').addEventListener('click', (e) => { if (e.target === $('#modal')) closeModal(); });
$('#rule-apply').addEventListener('click', () => {
  const severity = $<HTMLSelectElement>('#rule-severity').value;
  if (isInlineRule(modalRuleName, modalRuleFormat)) {
    const def: any = { severity };
    const message = $<HTMLInputElement>('#rule-message').value.trim();
    const description = $<HTMLTextAreaElement>('#rule-description').value.trim();
    if (message) def.message = message;
    if (description) def.description = description;
    upsertRule(modalRuleName, modalRuleFormat, def);
  } else {
    // Built-in rule: the engine only accepts a severity string for an inherited rule.
    upsertRule(modalRuleName, modalRuleFormat, severity);
  }
  closeModal();
  renderSavedRules();
  runLint();
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
          <button class="store-btn git-commit" type="button" title="Commit to the selected repo">Commit ↗</button>
          <button class="store-btn git-pr" type="button" title="Open a PR on the selected repo">PR ↗</button>
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
    li.querySelector<HTMLButtonElement>('.git-commit')?.addEventListener('click', (e) => { e.stopPropagation(); gitSaveDoc(id, 'commit'); });
    li.querySelector<HTMLButtonElement>('.git-pr')?.addEventListener('click', (e) => { e.stopPropagation(); gitSaveDoc(id, 'pr'); });
    li.querySelector<HTMLButtonElement>('.store-del')?.addEventListener('click', (e) => {
      e.stopPropagation();
      removeSaved(id);
    });
  });
  populateSavedRepoSelect();
}
function renderSavedRules() {
  const rules = loadRules().sort((a, b) => b.updatedAt - a.updatedAt);
  $('#rules-count').textContent = String(rules.length);
  const list = $('#saved-rules-list');
  list.innerHTML = rules.length
    ? rules
        .map((r) => {
          const disabled = r.def === 'off' || r.def === false;
          const state = disabled ? 'disabled' : sevOf(r.def) ?? 'custom';
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
  activeTab = name;
  document.querySelectorAll<HTMLButtonElement>('.tab').forEach((t) => t.classList.toggle('active', t.dataset.tab === name));
  ($('#tab-results') as HTMLElement).hidden = name !== 'results';
  ($('#tab-ruleset') as HTMLElement).hidden = name !== 'ruleset';
  ($('#tab-docs') as HTMLElement).hidden = name !== 'docs';
  ($('#tab-utilities') as HTMLElement).hidden = name !== 'utilities';
  ($('#tab-saved') as HTMLElement).hidden = name !== 'saved';
  ($('#tab-rules') as HTMLElement).hidden = name !== 'rules';
  ($('#tab-repos') as HTMLElement).hidden = name !== 'repos';
  ($('#tab-config') as HTMLElement).hidden = name !== 'config';
  if (name === 'repos') { renderRepos(); loadAccessibleRepos(); }
  // the tag filter applies to Results + Rules; build it lazily on first use
  const filterable = name === 'results' || name === 'ruleset';
  ($('#tag-filter') as HTMLElement).hidden = !filterable;
  if (filterable && !facetsBuilt) buildFilterUI();
  if (name === 'ruleset') renderRuleset();
  if (name === 'utilities') renderUtilities();
  if (name === 'docs') renderDocs();
}

// ---- Rules tab: every rule grouped by artifact, with enable/disable ----------
// accordion: only one artifact group open at a time
let openArtifact: string | null = null;
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
    let exp = tags.find((t) => t.startsWith('experience:')) ?? tags.find((t) => t.startsWith('category:'));
    if (!exp && BUILTIN_META[name]?.experience?.[0]) exp = `experience:${BUILTIN_META[name].experience[0]}`;
    list.push({ name, category: (exp ?? 'experience:other').split(':').slice(1).join(':') });
  };
  for (const [name, rule] of Object.entries(ALL_RULES[a.format] || {})) add(name, rule);
  for (const name of builtinRulesByFormat[a.format] ?? []) {
    if (/^oas2[-_]/i.test(name)) continue; // no Swagger support
    add(name, RULE_INDEX[name] || null);
  }
  return list.sort((x, y) => x.name.localeCompare(y.name));
}
function renderRuleset() {
  // apply the active tag filter, then drop artifacts left with no matching rules
  const arts = ARTIFACTS
    .map((a) => ({ a, rules: rulesForArtifact(a).filter((r) => ruleMatchesFilter(tagsFor(r.name))) }))
    .filter((x) => x.rules.length);
  const validIds = new Set(arts.map((x) => x.a.id));
  // accordion: keep the user's open artifact, else default to the current artifact (or first)
  const activeArt = (openArtifact && validIds.has(openArtifact) ? openArtifact : (validIds.has(current.id) ? current.id : arts[0]?.a.id)) ?? null;
  openArtifact = activeArt;
  $('#ruleset-list').innerHTML = arts.length
    ? arts.map(({ a, rules }) => {
        const off = rules.filter((r) => isDisabled(r.name, a.format)).length;
        const open = a.id === activeArt ? ' open' : '';
        const rows = rules
          .map((r) => {
            const dis = isDisabled(r.name, a.format);
            return `<li data-name="${escapeHtml(r.name)}" data-format="${escapeHtml(a.format)}">
              <label class="rule-toggle">
                <input type="checkbox" data-name="${escapeHtml(r.name)}" data-format="${escapeHtml(a.format)}"${dis ? '' : ' checked'}>
                <span class="rule-tname${dis ? ' off' : ''}" title="${escapeHtml(r.name)}">${escapeHtml(titleCase(r.name))}</span>
              </label>
              ${tagChips(tagsFor(r.name))}
              <button class="edit-btn rules-edit" type="button" title="Edit this rule">✎ edit</button>
            </li>`;
          })
          .join('');
        return `<details class="rule-group"${open} data-art="${a.id}">
          <summary><span class="group-name">${escapeHtml(a.label)}</span><span class="group-count">${rules.length} rules${off ? ` · ${off} off` : ''}</span></summary>
          <ul class="ruleset-rules">${rows}</ul>
        </details>`;
      }).join('')
    : '<div class="ok">No rules match the active tag filter.</div>';
}
// delegated handlers (attached once)
$('#ruleset-list').addEventListener('click', (e) => {
  const edit = (e.target as HTMLElement).closest('.rules-edit');
  if (edit) {
    const li = edit.closest('li') as HTMLElement;
    openRuleModal(li.dataset.name!, li.dataset.format!);
  }
});
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
// `toggle` doesn't bubble — listen in the capture phase. Accordion: opening one closes the rest.
$('#ruleset-list').addEventListener('toggle', (e) => {
  const d = e.target as HTMLDetailsElement;
  if (!(d instanceof HTMLDetailsElement) || !d.dataset.art) return;
  if (d.open) {
    openArtifact = d.dataset.art;
    $('#ruleset-list').querySelectorAll<HTMLDetailsElement>('details.rule-group').forEach((o) => { if (o !== d) o.open = false; });
  } else if (openArtifact === d.dataset.art) {
    openArtifact = null;
  }
}, true);
// Hover a rule in the listing to see its description (same tooltip as Results).
$('#ruleset-list').addEventListener('mouseover', (e) => {
  const li = (e.target as HTMLElement).closest('li[data-name]') as HTMLElement | null;
  if (li) showLintTip(li.dataset.name!, e);
});
$('#ruleset-list').addEventListener('mousemove', positionTip);
$('#ruleset-list').addEventListener('mouseout', (e) => {
  const to = (e.relatedTarget as HTMLElement)?.closest?.('li[data-name]');
  if (!to) hideLintTip();
});

// ---- configuration (API keys / tokens) --------------------------------------
const CFG_FIELDS: Array<[string, keyof Config]> = [
  ['cfg-claude', 'claude'], ['cfg-gemini', 'gemini'], ['cfg-chatgpt', 'chatgpt'],
  ['cfg-github', 'github'], ['cfg-gitlab', 'gitlab'], ['cfg-bitbucketUser', 'bitbucketUser'], ['cfg-bitbucket', 'bitbucket'],
];
const CFG_SECRETS = ['cfg-claude', 'cfg-gemini', 'cfg-chatgpt', 'cfg-github', 'cfg-gitlab', 'cfg-bitbucket']; // password fields
(function initConfig() {
  const cfg = loadConfig();
  for (const [id, key] of CFG_FIELDS) {
    const el = $<HTMLInputElement>('#' + id);
    el.value = (cfg[key] as string) ?? '';
    let t: number | undefined;
    el.addEventListener('input', () => {
      clearTimeout(t);
      t = window.setTimeout(() => {
        const c = loadConfig();
        const v = el.value.trim();
        if (v) (c[key] as string) = v;
        else delete c[key];
        saveConfig(c);
        if (key === 'claude' || key === 'gemini' || key === 'chatgpt') { refreshFixControls(); runLint(); }
      }, 300);
    });
  }
  // Search-source toggles — persist to cfg.sources and re-populate the source dropdown.
  for (const id of ['github', 'gitlab', 'bitbucket'] as const) {
    const el = $<HTMLInputElement>('#src-' + id);
    el.checked = (cfg.sources?.[id]) ?? (id === 'github');
    el.addEventListener('change', () => {
      const c = loadConfig();
      c.sources = { ...(c.sources || {}), [id]: el.checked };
      saveConfig(c);
      populateSources();
    });
  }
  $<HTMLInputElement>('#cfg-show').addEventListener('change', (e) => {
    const type = (e.target as HTMLInputElement).checked ? 'text' : 'password';
    for (const id of CFG_SECRETS) $<HTMLInputElement>('#' + id).type = type;
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

// ---- upload an artifact from disk -------------------------------------------
// Detect the artifact type from a parsed document's marker keys; null = unknown.
function detectArtifactType(text: string, fileName: string): string | null {
  if (/\.md$/i.test(fileName) || /^\s*---[\s\S]*\bname:/.test(text)) return 'agent-skill';
  let d: any;
  try { d = parseYaml(text); } catch { return null; }
  if (!d || typeof d !== 'object') return null;
  if (d.openapi || d.swagger) return 'openapi';
  if (d.asyncapi) return 'asyncapi';
  if (d.arazzo) return 'arazzo';
  if (d.specificationVersion || (Array.isArray(d.apis) && d.name)) return 'apis-json';
  if (d.protocolVersion || d.serverInfo || (d.tools && !d.paths)) return 'mcp';
  if (d['@context'] || d['@graph']) return 'json-ld';
  if (Array.isArray(d.plans)) return 'plans';
  if (Array.isArray(d.limits) || d.rateLimits) return 'rate-limits';
  if (d.$schema || d.$defs || d.definitions || d.properties || d.$id) return 'json-schema';
  return null;
}
const fileInput = $<HTMLInputElement>('#doc-file');
$('#doc-upload').addEventListener('click', () => fileInput.click());
fileInput.addEventListener('change', async () => {
  const file = fileInput.files?.[0];
  if (!file) return;
  try {
    const text = await file.text();
    const isMd = /\.md$/i.test(file.name) || detectArtifactType(text, file.name) === 'agent-skill';
    const head = (text.charCodeAt(0) === 0xfeff ? text.slice(1) : text).trimStart();
    const lang: 'yaml' | 'json' = isMd ? 'yaml' : (/\.json$/i.test(file.name) || head.startsWith('{') || head.startsWith('[') ? 'json' : 'yaml');
    const type = detectArtifactType(text, file.name) ?? current.id; // fall back to the current type
    const name = file.name.replace(/\.(ya?ml|json|md|txt)$/i, '') || `Uploaded ${artifactById(type).label}`;
    let doc = findDoc(type, name);
    if (doc) Object.assign(doc, { content: text, lang, updatedAt: Date.now() });
    else doc = { id: newId(), name, type, lang, content: text, updatedAt: Date.now() };
    upsertDoc(doc);
    loadDocIntoEditor(doc);
    switchTab('results');
  } catch (e) {
    window.alert(`Could not read that file: ${e instanceof Error ? e.message : String(e)}`);
  } finally {
    fileInput.value = ''; // let the same file be re-selected later
  }
});

// Download every saved artifact as one APIs.json (0.21, YAML).
function downloadFile(name: string, text: string, mime = 'application/yaml') {
  const url = URL.createObjectURL(new Blob([text], { type: mime }));
  const a = document.createElement('a');
  a.href = url; a.download = name;
  document.body.appendChild(a); a.click(); a.remove();
  URL.revokeObjectURL(url);
}
$('#download-apisjson').addEventListener('click', () => {
  const docs = loadDocs();
  if (!docs.length) { window.alert('No saved artifacts to export yet.'); return; }
  const yaml = buildApisJson('Spotlight Validator artifacts', docs.map((d) => ({ name: d.name, content: d.content, lang: d.lang, type: d.type })));
  downloadFile('apis.yaml', yaml);
});

// ---- Docs tab: generate documentation for the current document --------------
// Load the doc stylesheet, then remap its colour variables to the dark app
// palette so the preview blends in. (Downloads keep the light defaults.)
(function injectDocsStyle() {
  const el = document.createElement('style');
  el.textContent = `${DOCS_CSS}
#docs-view { padding: 0.25rem 0.25rem 1rem; overflow: auto; }
#docs-view.doc-view {
  --dc-fg: var(--fg);
  --dc-muted: var(--muted);
  --dc-faint: var(--muted);
  --dc-line: var(--line);
  --dc-soft: var(--panel);
  --dc-th: #2b2b2c;
  --dc-code: rgba(255,255,255,0.09);
  --dc-accent: var(--info);
  --dc-border: var(--line);
}`;
  document.head.appendChild(el);
})();
function currentDocName(): string {
  const d = activeId ? getDoc(activeId) : undefined;
  return (d?.name || `Untitled ${current.label}`).replace(/\.(ya?ml|json|md)$/i, '');
}
function renderDocs() {
  const { html, error } = renderDocsHtml(current.format, docEditor.getValue());
  $('#docs-view').innerHTML = error
    ? `<div class="err">${escapeHtml(error)}</div>`
    : (html || '<div class="ok">Nothing to document yet.</div>');
}
let docsTimer: number | undefined;
function scheduleDocs() {
  clearTimeout(docsTimer);
  docsTimer = window.setTimeout(() => { if (activeTab === 'docs') renderDocs(); }, 300);
}
$('#docs-download-html').addEventListener('click', () => {
  const { html, error } = renderDocsHtml(current.format, docEditor.getValue());
  if (error) { window.alert(error); return; }
  downloadFile(`${currentDocName()}-docs.html`, standaloneDocs(currentDocName(), html), 'text/html');
});
$('#docs-download-md').addEventListener('click', () => {
  const { markdown, error } = renderDocsMarkdown(current.format, docEditor.getValue());
  if (error) { window.alert(error); return; }
  downloadFile(`${currentDocName()}-docs.md`, markdown, 'text/markdown');
});
$('#docs-print').addEventListener('click', () => {
  const { html, error } = renderDocsHtml(current.format, docEditor.getValue());
  if (error) { window.alert(error); return; }
  const w = window.open('', '_blank');
  if (!w) { window.alert('Allow pop-ups to open the printable view.'); return; }
  w.document.write(standaloneDocs(currentDocName(), html));
  w.document.close();
  w.focus();
  window.setTimeout(() => w.print(), 350);
});

// API Evangelist services — a context-aware "Get a review" front door. Reads the
// current artifact + finding count at click time so the email starts with detail.
initEngage(() => {
  const parts = [`Artifact type: ${labelForFormat(current.format)}`];
  if (lastDiagnostics.length) parts.push(`Findings currently in view: ${lastDiagnostics.length}`);
  const saved = loadDocs().length;
  if (saved) parts.push(`Saved artifacts in this session: ${saved}`);
  return 'Context from the Spotlight Validator:\n- ' + parts.join('\n- ');
});

// Reset — clears ALL local storage (saved artifacts + rule overrides) after a confirm.
$('#reset-storage').addEventListener('click', () => {
  if (!window.confirm('Reset local storage? This permanently clears every saved artifact, rule override, and saved API key/token stored in this browser. This cannot be undone.')) return;
  clearAll();
  activeId = null;
  renderSaved();
  renderSavedRules();
  setArtifact('openapi'); // start fresh from the default
});

// ---- repos ------------------------------------------------------------------
let accessibleRepos: Repo[] = [];
async function loadAccessibleRepos() {
  const token = (loadConfig().github || '').trim();
  const picker = $<HTMLSelectElement>('#repo-picker');
  if (!token) { picker.innerHTML = '<option value="">Add a GitHub token in Config →</option>'; return; }
  picker.innerHTML = '<option value="">Loading your repos…</option>';
  try {
    accessibleRepos = await listAccessibleRepos(token);
    const saved = new Set(loadRepos().map((r) => r.fullName));
    const avail = accessibleRepos.filter((r) => !saved.has(r.fullName));
    picker.innerHTML = avail.length
      ? avail.map((r) => `<option value="${escapeHtml(r.fullName)}">${escapeHtml(r.fullName)}${r.private ? ' (private)' : ''}</option>`).join('')
      : '<option value="">All accessible repos already added</option>';
  } catch (e) {
    picker.innerHTML = `<option value="">${escapeHtml(e instanceof Error ? e.message : 'Could not load repos')}</option>`;
  }
}
function renderRepos() {
  const repos = loadRepos();
  $('#repos-count').textContent = String(repos.length);
  const list = $('#repos-list');
  list.innerHTML = repos.length
    ? repos.map((r) => `<li data-name="${escapeHtml(r.fullName)}">
        <span class="store-name" title="${escapeHtml(r.fullName)}">${escapeHtml(r.fullName)}</span>
        <span class="store-meta">${r.private ? 'private' : 'public'} · ${escapeHtml(r.defaultBranch)}</span>
        <button class="store-del" type="button" title="Remove">&times;</button>
      </li>`).join('')
    : '<li class="store-empty">No repos yet — pick one above and Add.</li>';
  list.querySelectorAll<HTMLLIElement>('li[data-name]').forEach((li) => {
    li.querySelector<HTMLButtonElement>('.store-del')?.addEventListener('click', () => {
      removeRepo(li.dataset.name!); renderRepos(); loadAccessibleRepos();
    });
  });
  populateSavedRepoSelect();
}
$('#repo-add').addEventListener('click', () => {
  const full = $<HTMLSelectElement>('#repo-picker').value;
  if (!full) return;
  addRepo(accessibleRepos.find((x) => x.fullName === full) ?? { fullName: full, defaultBranch: 'main', private: false });
  renderRepos();
  loadAccessibleRepos();
});
$('#repo-refresh').addEventListener('click', loadAccessibleRepos);

// ---- save a stored artifact to a repo (commit / PR) -------------------------
function populateSavedRepoSelect() {
  const sel = $<HTMLSelectElement>('#saved-repo-select');
  const repos = loadRepos();
  const prev = sel.value;
  sel.innerHTML = repos.length
    ? repos.map((r) => `<option value="${escapeHtml(r.fullName)}">${escapeHtml(r.fullName)}</option>`).join('')
    : '<option value="">— add repos in the Repos tab —</option>';
  if (repos.some((r) => r.fullName === prev)) sel.value = prev;
}
function setGitStatus(html: string, isError = false) {
  const el = $('#saved-git-status') as HTMLElement;
  el.innerHTML = html;
  el.style.color = isError ? '#f14c4c' : '';
}
async function gitSaveDoc(id: string, kind: 'commit' | 'pr') {
  const doc = getDoc(id);
  if (!doc) return;
  const token = (loadConfig().github || '').trim();
  if (!token) return setGitStatus('Add a GitHub token in Config.', true);
  const repo = $<HTMLSelectElement>('#saved-repo-select').value;
  if (!repo) return setGitStatus('Add a repo in the Repos tab and pick it above.', true);
  const ext = doc.lang === 'json' ? 'json' : 'yaml';
  const defaultPath = `${doc.name.replace(/\.(ya?ml|json)$/i, '').replace(/[^a-z0-9._/-]+/gi, '-')}.${ext}`;
  const path = window.prompt(`File path in ${repo}:`, defaultPath);
  if (!path) return;
  const branch = loadRepos().find((r) => r.fullName === repo)?.defaultBranch || 'main';
  const message = `${kind === 'pr' ? 'Propose' : 'Update'} ${path} via spotlight-validator`;
  setGitStatus(kind === 'pr' ? 'Opening PR…' : 'Committing…');
  try {
    const url = kind === 'pr'
      ? await openPrGitHub(token, repo, path, doc.content, message, branch)
      : await commitGitHub(token, repo, path, doc.content, message, branch);
    setGitStatus(`${kind === 'pr' ? 'PR opened' : 'Committed'} ✓ <a href="${escapeHtml(url)}" target="_blank" rel="noopener">open ↗</a>`);
  } catch (e) {
    setGitStatus(`${kind} failed: ${escapeHtml(e instanceof Error ? e.message : String(e))}`, true);
  }
}

// ---- utilities (per-artifact whole-document transforms) ---------------------
function utilBaseName(): string {
  const d = activeId ? getDoc(activeId) : undefined;
  return (d?.name || `Untitled ${current.label}`).replace(/\.(ya?ml|json)$/i, '');
}
function saveNewDoc(name: string, type: string, content: string) {
  upsertDoc({ id: newId(), name, type, lang: 'yaml', content, updatedAt: Date.now() });
}
function setUtilStatus(msg: string, isError = false) {
  const el = $('#utilities-status') as HTMLElement;
  el.textContent = msg;
  el.style.color = isError ? '#f14c4c' : '';
}
// Replace the whole document via an undoable edit (Ctrl+Z reverts; re-lints).
function replaceDocument(text: string) {
  const model = docEditor.getModel();
  if (!model) return;
  docEditor.pushUndoStop();
  docEditor.executeEdits('util', [{ range: model.getFullModelRange(), text, forceMoveMarkers: true }]);
  docEditor.pushUndoStop();
}
function runUtility(format: string, id: string) {
  const util = utilitiesFor(format).find((u) => u.id === id);
  if (!util) return;
  try {
    const out = util.run(docEditor.getValue(), { type: current.id, lang: docLang });
    if (out.kind === 'replace') { replaceDocument(out.content); setUtilStatus(out.note); }
    else if (out.kind === 'download') { downloadFile(out.name, out.content, out.mime); setUtilStatus(out.note); }
    else if (out.kind === 'save') {
      const base = utilBaseName();
      for (const it of out.items) saveNewDoc(`${base} — ${it.name}`, it.type, it.content);
      renderSaved();
      setUtilStatus(`${out.note} See Saved Artifacts.`);
    } else { setUtilStatus(out.note); }
  } catch (e) {
    setUtilStatus(e instanceof Error ? e.message : String(e), true);
  }
}
function renderUtilities() {
  const listEl = $('#utilities-list');
  listEl.innerHTML = ARTIFACTS.map((a) => {
    const fns = utilitiesFor(a.format);
    const open = a.format === current.format ? ' open' : '';
    const rows = fns.length
      ? fns.map((f) => `<li class="util-row" data-art="${escapeHtml(a.format)}" data-fn="${escapeHtml(f.id)}">
          <button class="util-btn" type="button">${escapeHtml(f.label)}</button>
          <div class="util-desc small text-muted">${escapeHtml(f.desc)}</div>
        </li>`).join('')
      : '<li class="store-empty">No functions yet — coming later.</li>';
    return `<details class="rule-group"${open} data-art="${a.id}">
      <summary><span class="group-name">${escapeHtml(a.label)}</span><span class="group-count">${fns.length ? `${fns.length} function${fns.length === 1 ? '' : 's'}` : '—'}</span></summary>
      <ul class="util-list">${rows}</ul>
    </details>`;
  }).join('');
  listEl.querySelectorAll<HTMLButtonElement>('.util-btn').forEach((btn) => {
    const li = btn.closest('li.util-row') as HTMLElement;
    btn.addEventListener('click', () => runUtility(li.dataset.art!, li.dataset.fn!));
  });
}

// ---- tag filter wiring ------------------------------------------------------
$('#filter-facets').addEventListener('click', (e) => {
  const b = (e.target as HTMLElement).closest('[data-tag]') as HTMLElement | null;
  if (b) toggleTag(b.dataset.tag!);
});
$('#filter-clear').addEventListener('click', clearFilter);
// Clicking a tag chip on any rule listing toggles that tag in the filter.
// Capture phase so it beats the row's own click handler (highlight / edit).
for (const sel of ['#results', '#ruleset-list']) {
  $(sel).addEventListener('click', (e) => {
    const chip = (e.target as HTMLElement).closest('.chip[data-tag]') as HTMLElement | null;
    if (chip) { e.stopPropagation(); e.preventDefault(); toggleTag(chip.dataset.tag!); }
  }, true);
}

// ---- boot -------------------------------------------------------------------
docEditor.onDidChangeModelContent(() => {
  scheduleLint();
  scheduleDocs();
  if (!suppressSave) scheduleSave();
});
renderSavedRules();
refreshFixControls();
renderRepos();
buildFilterUI();
($('#tag-filter') as HTMLElement).hidden = false; // initial tab is Results (filterable)
const restoreId = getActiveId();
const restored = restoreId ? getDoc(restoreId) : undefined;
if (restored) loadDocIntoEditor(restored);
else setArtifact('openapi');
