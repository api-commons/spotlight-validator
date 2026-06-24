import * as monaco from 'monaco-editor';
import EditorWorker from 'monaco-editor/esm/vs/editor/editor.worker?worker';
import JsonWorker from 'monaco-editor/esm/vs/language/json/json.worker?worker';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';
import { lint, collectTags, builtinDescriptions } from './spotlight';
import { ruleset as compiledRuleset } from './compiled-ruleset';
import { SAMPLES } from './samples';
import './style.css';

self.MonacoEnvironment = {
  getWorker(_id, label) {
    return label === 'json' ? new JsonWorker() : new EditorWorker();
  },
};

type Format = 'openapi' | 'asyncapi' | 'jsonschema';
const $ = <T extends HTMLElement>(sel: string) => document.querySelector(sel) as T;
const COMPILED_RULES: Record<string, any> = (compiledRuleset as any).rules;

// ---- editors ----------------------------------------------------------------
const docEditor = monaco.editor.create($('#doc-editor'), {
  value: SAMPLES.openapi,
  language: 'yaml',
  automaticLayout: true,
  minimap: { enabled: false },
  fontSize: 13,
  scrollBeyondLastLine: false,
});

const ruleEditor = monaco.editor.create($('#rule-editor'), {
  value: '',
  language: 'yaml',
  automaticLayout: true,
  minimap: { enabled: false },
  fontSize: 13,
  scrollBeyondLastLine: false,
});

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
function descriptionFor(code: string): string {
  return (COMPILED_RULES[code]?.description as string) ?? builtinDescriptions[code] ?? '';
}

// ---- category dropdown ------------------------------------------------------
const tags = collectTags(compiledRuleset);
const totalRules = Object.keys(COMPILED_RULES).length;
let activeCategory = '';
const catSelect = $<HTMLSelectElement>('#category');
for (const t of tags.category) {
  const o = document.createElement('option');
  o.value = t;
  o.textContent = t.split(':').slice(1).join(':');
  catSelect.appendChild(o);
}
catSelect.addEventListener('change', () => {
  activeCategory = catSelect.value;
  runLint();
});

// ---- format -----------------------------------------------------------------
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

// per-rule edits applied on top of the selection (ruleName -> definition)
const userOverrides: Record<string, any> = {};

function activeRulesetDef(): any {
  const rules: Record<string, any> = {};
  for (const [name, rule] of Object.entries(COMPILED_RULES)) {
    const t: string[] = Array.isArray(rule?.tags) ? rule.tags : [];
    if (!t.includes(`format:${format}`)) continue;
    if (t.includes('duplicate:true')) continue;
    if (activeCategory && !t.includes(activeCategory)) continue;
    rules[name] = rule;
  }
  for (const [name, def] of Object.entries(userOverrides)) rules[name] = def;
  const ext = EXTENDS_FOR[format];
  $('#active-count').textContent = String(Object.keys(rules).length);
  return ext ? { extends: [[ext, 'recommended']], rules } : { rules };
}

// ---- linting ----------------------------------------------------------------
const sevToMarker: Record<number, monaco.MarkerSeverity> = {
  0: monaco.MarkerSeverity.Error,
  1: monaco.MarkerSeverity.Warning,
  2: monaco.MarkerSeverity.Info,
  3: monaco.MarkerSeverity.Hint,
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
    model,
    'spotlight',
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
          <code>${escapeHtml(code)}</code>
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
      // a) click row -> reveal + highlight the line(s) the rule applies to
      li.addEventListener('click', () => highlightLines(Number(li.dataset.sl), Number(li.dataset.el)));
      // edit button -> popup to edit the rule YAML
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
  if (COMPILED_RULES[code]) {
    const { tags: _t, ...rest } = COMPILED_RULES[code]; // hide tag noise while editing
    return rest;
  }
  return 'warn'; // built-in rule (from the extended ruleset) — edit as a severity toggle
}
function openRuleModal(code: string) {
  modalRuleName = code;
  const builtin = !COMPILED_RULES[code] && userOverrides[code] === undefined;
  $('#modal-title').textContent = code;
  $('#rule-note').textContent = builtin
    ? 'Built-in rule from the extended ruleset — edit the severity (error/warn/info/hint/off) or replace with a full rule definition.'
    : 'Edit this rule. Apply re-lints with your change.';
  ruleEditor.setValue(stringifyYaml({ [code]: ruleDefForEditing(code) }));
  ($('#modal') as HTMLElement).hidden = false;
  setTimeout(() => ruleEditor.layout(), 0);
}
function closeModal() {
  ($('#modal') as HTMLElement).hidden = true;
}
$('#modal-close').addEventListener('click', closeModal);
$('#modal').addEventListener('click', (e) => {
  if (e.target === $('#modal')) closeModal();
});
$('#rule-apply').addEventListener('click', () => {
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

docEditor.onDidChangeModelContent(scheduleLint);
$('#doc-status').textContent = `${totalRules} compiled rules available`;
runLint();
