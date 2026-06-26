// AI "fix" support for the validator. Given a rule's fix prompt, the artifact,
// and the specific lint findings, ask a user-configured model (Claude, Gemini, or
// ChatGPT) to return the corrected artifact. Keys live only in this browser
// (storage.Config) and the calls go straight from the browser to each provider.

export type Provider = 'claude' | 'gemini' | 'chatgpt';

export const PROVIDERS: Record<Provider, { label: string; model: string }> = {
  claude: { label: 'Claude', model: 'claude-sonnet-4-6' },
  gemini: { label: 'Gemini', model: 'gemini-2.0-flash' },
  chatgpt: { label: 'ChatGPT', model: 'gpt-4o' },
};

const MAX_TOKENS = 8192;

export interface Finding { line: number; message: string }

// The system instruction: return ONLY the corrected document, no fences/commentary.
function systemPrompt(lang: string): string {
  return (
    'You are an API governance assistant that repairs machine-readable API description documents ' +
    '(OpenAPI, AsyncAPI, APIs.json, JSON Schema, Arazzo, agent SKILL.md, and similar). ' +
    'You will be given a fix instruction, the locations a linter flagged, and the current document. ' +
    'Apply ONLY the change the instruction requires, preserve everything else (structure, key order, ' +
    `comments, formatting) exactly, and keep the document valid. Return ONLY the complete corrected ` +
    `document as raw ${lang} — no markdown code fences, no preamble, no explanation.`
  );
}

// Assemble the user message: rule fix prompt + flagged locations + the document.
export function buildUserContent(rulePrompt: string, findings: Finding[], artifact: string, lang: string): string {
  const locs = findings.length
    ? 'The linter flagged this rule at:\n' + findings.map((f) => `  - line ${f.line}: ${f.message}`).join('\n') + '\n\n'
    : '';
  return `${rulePrompt}\n\n${locs}Current document (${lang}):\n\n${artifact}`;
}

// Strip a leading/trailing markdown code fence if the model added one anyway.
function stripFences(text: string): string {
  const t = text.trim();
  const m = t.match(/^```[a-zA-Z0-9]*\n([\s\S]*?)\n```$/);
  return (m ? m[1] : t).trim();
}

async function callClaude(key: string, system: string, user: string, signal?: AbortSignal): Promise<string> {
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST', signal,
    headers: {
      'content-type': 'application/json',
      'x-api-key': key,
      'anthropic-version': '2023-06-01',
      'anthropic-dangerous-direct-browser-access': 'true',
    },
    body: JSON.stringify({ model: PROVIDERS.claude.model, max_tokens: MAX_TOKENS, system, messages: [{ role: 'user', content: user }] }),
  });
  if (!res.ok) throw new Error(`Claude ${res.status}: ${(await res.text()).slice(0, 300)}`);
  const data = await res.json();
  const text = data?.content?.map((b: any) => b?.text || '').join('') ?? '';
  if (!text) throw new Error('Claude returned no content');
  return text;
}

async function callGemini(key: string, system: string, user: string, signal?: AbortSignal): Promise<string> {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${PROVIDERS.gemini.model}:generateContent?key=${encodeURIComponent(key)}`;
  const res = await fetch(url, {
    method: 'POST', signal,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      systemInstruction: { parts: [{ text: system }] },
      contents: [{ role: 'user', parts: [{ text: user }] }],
      generationConfig: { maxOutputTokens: MAX_TOKENS, temperature: 0 },
    }),
  });
  if (!res.ok) throw new Error(`Gemini ${res.status}: ${(await res.text()).slice(0, 300)}`);
  const data = await res.json();
  const text = data?.candidates?.[0]?.content?.parts?.map((p: any) => p?.text || '').join('') ?? '';
  if (!text) throw new Error('Gemini returned no content');
  return text;
}

async function callChatGPT(key: string, system: string, user: string, signal?: AbortSignal): Promise<string> {
  const res = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST', signal,
    headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
    body: JSON.stringify({
      model: PROVIDERS.chatgpt.model, temperature: 0, max_tokens: MAX_TOKENS,
      messages: [{ role: 'system', content: system }, { role: 'user', content: user }],
    }),
  });
  if (!res.ok) throw new Error(`ChatGPT ${res.status}: ${(await res.text()).slice(0, 300)}`);
  const data = await res.json();
  const text = data?.choices?.[0]?.message?.content ?? '';
  if (!text) throw new Error('ChatGPT returned no content');
  return text;
}

// ---- precise / fragment mode ------------------------------------------------
// Strip code fences but PRESERVE leading indentation (only trailing whitespace
// is trimmed) so the fragment splices back at the right nesting level.
function stripFencesKeepIndent(text: string): string {
  let t = text.replace(/\r/g, '');
  const fence = t.match(/^\s*```[a-zA-Z0-9]*\n([\s\S]*?)\n```\s*$/);
  if (fence) t = fence[1];
  return t.replace(/[ \t]*\n/g, '\n').replace(/\s+$/, '');
}
function fragmentSystem(lang: string): string {
  return (
    `You are an API governance assistant that repairs a single FRAGMENT of a ${lang} API description ` +
    `document. You receive a fix instruction and one fragment (a contiguous slice of the document). ` +
    `Fix ONLY this fragment. Preserve the exact leading indentation of every line so the fragment can be ` +
    `spliced back into the document verbatim. Do not add content or keys that belong outside the fragment, ` +
    `do not change its base indentation, do not use markdown code fences, and return ONLY the corrected fragment.`
  );
}
// Reuse the rule-specific "Requirement: … To fix: …" core of the catalog prompt,
// dropping its whole-document framing, then point it at the fragment.
export function buildFragmentUser(rulePrompt: string, label: string, path: string, fragment: string): string {
  const m = rulePrompt.match(/Requirement:[\s\S]*?(?=\s+This rule is evaluated|\s+Make the smallest change|$)/);
  const core = (m ? m[0] : rulePrompt).trim();
  return `${core}\n\nThe fragment below is the value at JSONPath \`${path || '(document root)'}\` in a ${label} document. Fix only this fragment.\n\nFragment:\n${fragment}`;
}
export async function aiFixFragment(
  provider: Provider, key: string, rulePrompt: string, label: string, path: string,
  fragment: string, lang: string, signal?: AbortSignal,
): Promise<string> {
  const system = fragmentSystem(lang);
  const user = buildFragmentUser(rulePrompt, label, path, fragment);
  const fn = provider === 'claude' ? callClaude : provider === 'gemini' ? callGemini : callChatGPT;
  return stripFencesKeepIndent(await fn(key, system, user, signal));
}

// Run a whole-document fix: returns the corrected artifact text.
export async function aiFix(
  provider: Provider, key: string, rulePrompt: string, findings: Finding[],
  artifact: string, lang: string, signal?: AbortSignal,
): Promise<string> {
  const system = systemPrompt(lang);
  const user = buildUserContent(rulePrompt, findings, artifact, lang);
  const fn = provider === 'claude' ? callClaude : provider === 'gemini' ? callGemini : callChatGPT;
  return stripFences(await fn(key, system, user, signal));
}

// ---- on-the-fly prompt fallback ---------------------------------------------
// When a finding's rule has no curated prompt in the bundled catalog (e.g. a rule
// the linting ruleset carries under a different name than all-rules.yaml), build
// an equivalent fix prompt from the rule definition the validator actually ran.
const caseEx: Record<string, string> = {
  flat: 'flatcase', camel: 'camelCase (e.g. `userName`)', pascal: 'PascalCase (e.g. `UserName`)',
  kebab: 'kebab-case (e.g. `user-name`)', cobol: 'COBOL-CASE', snake: 'snake_case (e.g. `user_name`)',
  macro: 'MACRO_CASE (e.g. `USER_NAME`)',
};
function oneFix(c: any): string {
  if (!c || !c.function) return '';
  const f = c.field ? '`' + c.field + '`' : 'the targeted value';
  const fk = c.field ? '`' + c.field + '`' : 'the targeted key or value';
  const o = c.functionOptions || {};
  switch (c.function) {
    case 'truthy': return `Ensure ${f} is present and non-empty at each matching location.`;
    case 'falsy': return `Ensure ${f} is absent or empty (falsy) at each matching location.`;
    case 'defined': return `Ensure ${f} is defined at each matching location.`;
    case 'undefined': return `Remove ${f} from each matching location.`;
    case 'pattern':
      if (o.match) return `Ensure ${f} matches the regular expression \`${o.match}\`; rewrite any value that does not.`;
      if (o.notMatch) return `Ensure ${f} does NOT match the regular expression \`${o.notMatch}\`; rename or rewrite any value that does.`;
      return `Ensure ${f} matches the pattern the rule requires.`;
    case 'casing': return `Rename ${fk} to ${caseEx[o.type] || o.type + ' case'} at each matching location, updating every reference to it.`;
    case 'enumeration': return `Set ${f} to one of the allowed values: ${(o.values || []).join(', ')}.`;
    case 'length': { const b: string[] = []; if (o.min != null) b.push(`at least ${o.min}`); if (o.max != null) b.push(`at most ${o.max}`); return `Ensure the length of ${f} is ${b.join(' and ')}.`; }
    case 'schema': return `Adjust ${f} so it conforms to the schema this rule requires.`;
    case 'alphabetical': return `Sort the entries${o.keyedBy ? ' by `' + o.keyedBy + '`' : ''} into ascending alphabetical order.`;
    case 'xor': return `Include exactly one of: ${(o.properties || []).join(', ')}.`;
    default: return '';
  }
}
export function generatePrompt(slug: string, rule: any, description: string, label: string): string {
  const desc = (description || '').replace(/\s+/g, ' ').trim();
  const clauses = Array.isArray(rule?.then) ? rule.then : (rule?.then ? [rule.then] : []);
  const fix = clauses.map(oneFix).filter(Boolean).join(' Also: ');
  const given = Array.isArray(rule?.given) ? rule.given.join(' | ') : String(rule?.given ?? '');
  let p = `You are editing ${/^[AEIOU]/.test(label) ? 'an' : 'a'} ${label} document to satisfy the Spotlight API governance rule '${slug}'. `;
  if (desc) p += `Requirement: ${desc}${/[.!?]$/.test(desc) ? '' : '.'} `;
  if (fix) p += `To fix: ${fix} `;
  if (given && given !== '$' && given !== 'undefined') p += `This rule is evaluated at the JSONPath \`${given}\` — inspect every location it matches and correct only what violates the rule. `;
  p += `Make the smallest change that satisfies the rule, leave all unrelated content, key order, comments, and formatting unchanged, and keep the document valid ${label}. Return only the complete corrected document, with no commentary.`;
  return p.replace(/\s+/g, ' ').trim();
}
