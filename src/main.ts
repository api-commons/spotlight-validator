import * as monaco from 'monaco-editor';
import EditorWorker from 'monaco-editor/esm/vs/editor/editor.worker?worker';
import JsonWorker from 'monaco-editor/esm/vs/language/json/json.worker?worker';
import { parse as parseYaml } from 'yaml';
import { lint, filterRulesByTags, collectTags } from './spotlight';
import compiledRuleset from './compiled-ruleset.json';
import { SAMPLES } from './samples';
import './style.css';

self.MonacoEnvironment = {
  getWorker(_id, label) {
    return label === 'json' ? new JsonWorker() : new EditorWorker();
  },
};

type Format = 'openapi' | 'asyncapi' | 'jsonschema';
const $ = <T extends HTMLElement>(sel: string) => document.querySelector(sel) as T;

// ---- editors ----------------------------------------------------------------
const docEditor = monaco.editor.create($('#doc-editor'), {
  value: SAMPLES.openapi,
  language: 'yaml',
  automaticLayout: true,
  minimap: { enabled: false },
  fontSize: 13,
  scrollBeyondLastLine: false,
});

const STARTER_RULESET = `# Edit your ruleset (YAML). Lints live against the artifact.
extends: ["spotlight:oas"]
rules:
  paths-kebab-case:
    description: Paths should be kebab-case.
    severity: warn
    given: $.paths[*]~
    then:
      function: pattern
      functionOptions:
        match: "^(/[a-z0-9]+(-[a-z0-9]+)*|/{[a-zA-Z0-9_]+})+$"
`;
const rulesetEditor = monaco.editor.create($('#ruleset-editor'), {
  value: STARTER_RULESET,
  language: 'yaml',
  automaticLayout: true,
  minimap: { enabled: false },
  fontSize: 13,
  scrollBeyondLastLine: false,
});

// ---- tag filter UI ----------------------------------------------------------
const activeTags = new Set<string>();
const tags = collectTags(compiledRuleset);
const totalRules = Object.keys((compiledRuleset as any).rules).length;

function renderTagGroups() {
  const groups: Array<[string, string[]]> = [
    ['Source', tags.source],
    ['Category', tags.category],
  ];
  $('#tag-groups').innerHTML = groups
    .map(
      ([label, list]) => `
      <fieldset class="tag-group">
        <legend>${label}</legend>
        ${list
          .map((t) => {
            const short = t.split(':').slice(1).join(':');
            return `<label class="chip"><input type="checkbox" value="${t}" /> ${short}</label>`;
          })
          .join('')}
      </fieldset>`,
    )
    .join('');
  $('#tag-groups')
    .querySelectorAll<HTMLInputElement>('input[type=checkbox]')
    .forEach((cb) =>
      cb.addEventListener('change', () => {
        cb.checked ? activeTags.add(cb.value) : activeTags.delete(cb.value);
        runLint();
      }),
    );
}
renderTagGroups();

// ---- mode toggle ------------------------------------------------------------
let mode: 'best' | 'custom' = 'best';
function setMode(m: 'best' | 'custom') {
  mode = m;
  $('#mode-best').classList.toggle('active', m === 'best');
  $('#mode-custom').classList.toggle('active', m === 'custom');
  ($('#best-panel') as HTMLElement).hidden = m !== 'best';
  ($('#custom-panel') as HTMLElement).hidden = m !== 'custom';
  if (m === 'custom') rulesetEditor.layout();
  runLint();
}
$('#mode-best').addEventListener('click', () => setMode('best'));
$('#mode-custom').addEventListener('click', () => setMode('custom'));

// ---- format selector --------------------------------------------------------
let format: Format = 'openapi';
$('#format').addEventListener('change', (e) => {
  format = (e.target as HTMLSelectElement).value as Format;
  docEditor.setValue(SAMPLES[format]);
  runLint();
});

const EXTENDS_FOR: Record<Format, string> = {
  openapi: 'spotlight:oas',
  asyncapi: 'spotlight:asyncapi',
  jsonschema: '',
};

// ---- linting ----------------------------------------------------------------
const sevToMarker: Record<number, monaco.MarkerSeverity> = {
  0: monaco.MarkerSeverity.Error,
  1: monaco.MarkerSeverity.Warning,
  2: monaco.MarkerSeverity.Info,
  3: monaco.MarkerSeverity.Hint,
};
const sevLabel = ['error', 'warning', 'info', 'hint'];

function activeRulesetDef(): any {
  if (mode === 'custom') {
    try {
      return parseYaml(rulesetEditor.getValue()) ?? { rules: {} };
    } catch {
      return { __parseError: true, rules: {} };
    }
  }
  // best-of-breed: compiled rules filtered by tag, plus the format's built-in ruleset
  const filtered = filterRulesByTags(compiledRuleset, activeTags);
  const ext = EXTENDS_FOR[format];
  const def: any = { ...filtered, extends: ext ? [[ext, 'recommended']] : [] };
  $('#active-count').textContent = String(Object.keys(filtered.rules).length);
  return def;
}

let timer: number | undefined;
function scheduleLint() {
  clearTimeout(timer);
  timer = window.setTimeout(runLint, 250);
}

async function runLint() {
  const def = activeRulesetDef();
  if (def.__parseError) {
    $('#result-count').textContent = 'ruleset parse error';
    return;
  }
  const text = docEditor.getValue();
  const { diagnostics, error } = await lint(text, def);
  const model = docEditor.getModel()!;
  if (error) {
    monaco.editor.setModelMarkers(model, 'spotlight', []);
    $('#results').innerHTML = `<li class="err">Ruleset/lint error: ${escapeHtml(error)}</li>`;
    $('#result-count').textContent = 'error';
    return;
  }
  const markers = diagnostics.map((d: any) => ({
    severity: sevToMarker[d.severity] ?? monaco.MarkerSeverity.Warning,
    startLineNumber: d.range.start.line + 1,
    startColumn: d.range.start.character + 1,
    endLineNumber: d.range.end.line + 1,
    endColumn: d.range.end.character + 1,
    message: `${d.code}: ${d.message}`,
    code: String(d.code),
  }));
  monaco.editor.setModelMarkers(model, 'spotlight', markers);

  diagnostics.sort((a: any, b: any) => a.range.start.line - b.range.start.line);
  $('#results').innerHTML =
    diagnostics
      .map((d: any) => {
        const sev = sevLabel[d.severity] ?? 'warning';
        return `<li class="${sev}" data-line="${d.range.start.line + 1}">
          <span class="sev ${sev}">${sev}</span>
          <code>${escapeHtml(String(d.code))}</code>
          <span class="msg">${escapeHtml(d.message)}</span>
          <span class="loc">${(d.path || []).join('.') || '—'} · L${d.range.start.line + 1}</span>
        </li>`;
      })
      .join('') || '<li class="ok">No problems found 🎉</li>';

  $('#result-count').textContent = `${diagnostics.length} problem${diagnostics.length === 1 ? '' : 's'}`;
  $('#results')
    .querySelectorAll<HTMLLIElement>('li[data-line]')
    .forEach((li) =>
      li.addEventListener('click', () => {
        const line = Number(li.dataset.line);
        docEditor.revealLineInCenter(line);
        docEditor.setPosition({ lineNumber: line, column: 1 });
        docEditor.focus();
      }),
    );
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]!));
}

docEditor.onDidChangeModelContent(scheduleLint);
rulesetEditor.onDidChangeModelContent(() => mode === 'custom' && scheduleLint());
$('#doc-status').textContent = `${totalRules} compiled rules available`;
runLint();
