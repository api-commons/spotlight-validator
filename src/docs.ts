// Human-readable documentation generator for the four supported artifact types.
// Parses the current document and renders it as HTML (for the Docs tab preview and
// a standalone download) and Markdown (for download). Internal $refs are resolved
// inline (with cycle protection) and description fields are rendered as Markdown.
import { parse as parseYaml } from 'yaml';

const isObj = (x: any): x is Record<string, any> => x != null && typeof x === 'object' && !Array.isArray(x);
const esc = (s: any): string =>
  String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]!));
const METHODS = ['get', 'post', 'put', 'patch', 'delete', 'head', 'options', 'trace'];
const anchor = (s: string) => String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');

// ---- minimal, safe Markdown (descriptions) ----------------------------------
// Inline formatting applied to ALREADY HTML-escaped text.
function mdInline(escaped: string): string {
  return escaped
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/(^|[^*])\*([^*\n]+)\*/g, '$1<em>$2</em>')
    .replace(/\[([^\]]+)\]\((https?:[^)\s]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>');
}
// Inline-only Markdown for a table cell (newlines flattened).
const inlineMd = (raw: any): string => mdInline(esc(String(raw ?? '').replace(/\s*\n\s*/g, ' ')).trim());
// Block Markdown for a description: paragraphs, lists, and headings.
function md(raw: any): string {
  const t = String(raw ?? '').trim();
  if (!t) return '';
  const body = esc(t).split(/\n{2,}/).map((block) => {
    const lines = block.split('\n');
    if (lines.every((l) => /^\s*[-*]\s+/.test(l))) return `<ul>${lines.map((l) => `<li>${mdInline(l.replace(/^\s*[-*]\s+/, ''))}</li>`).join('')}</ul>`;
    if (lines.every((l) => /^\s*\d+\.\s+/.test(l))) return `<ol>${lines.map((l) => `<li>${mdInline(l.replace(/^\s*\d+\.\s+/, ''))}</li>`).join('')}</ol>`;
    const h = /^(#{1,4})\s+(.*)$/.exec(lines[0]);
    if (h && lines.length === 1) { const lvl = Math.min(6, h[1].length + 2); return `<h${lvl}>${mdInline(h[2])}</h${lvl}>`; }
    return `<p>${lines.map(mdInline).join('<br>')}</p>`;
  }).join('');
  return `<div class="doc-desc">${body}</div>`;
}

// ---- $ref resolution + schema labelling -------------------------------------
const refName = (ref: string): string => String(ref).split('/').pop() || 'ref';
function resolveRef(root: any, ref: any): any {
  if (typeof ref !== 'string' || !ref.startsWith('#/')) return undefined;
  let cur = root;
  for (const seg of ref.slice(2).split('/').map((s) => s.replace(/~1/g, '/').replace(/~0/g, '~'))) {
    cur = cur?.[seg];
    if (cur === undefined) return undefined;
  }
  return cur;
}
function typeLabel(s: any): string {
  if (!isObj(s)) return '';
  if (s.$ref) return refName(s.$ref);
  if (Array.isArray(s.type)) return s.type.join(' | ');
  if (s.enum) return `enum(${s.enum.map((e: any) => JSON.stringify(e)).join(', ')})`;
  if (s.type === 'array') return `array<${s.items ? typeLabel(s.items) : 'any'}>`;
  if (s.oneOf) return 'oneOf'; if (s.anyOf) return 'anyOf'; if (s.allOf) return 'allOf';
  return s.type || (s.properties ? 'object' : '');
}
function constraints(s: any): string {
  if (!isObj(s)) return '';
  const c: string[] = [];
  for (const k of ['format', 'pattern', 'minimum', 'maximum', 'minLength', 'maxLength', 'minItems', 'maxItems', 'default'])
    if (s[k] !== undefined) c.push(`${k}: ${typeof s[k] === 'object' ? JSON.stringify(s[k]) : s[k]}`);
  return c.length ? `<div class="doc-constraints">${esc(c.join(' · '))}</div>` : '';
}
// The object schema (with properties) a schema resolves to, chasing $ref and array
// items. Returns undefined if it's not an object-with-properties.
function objSchema(s: any, root: any): any {
  let cur = s, guard = 0;
  while (isObj(cur) && cur.$ref && guard++ < 12) cur = resolveRef(root, cur.$ref);
  if (isObj(cur) && cur.type === 'array') { cur = cur.items; guard = 0; while (isObj(cur) && cur.$ref && guard++ < 12) cur = resolveRef(root, cur.$ref); }
  return isObj(cur) && isObj(cur.properties) ? cur : undefined;
}

// Recursive property table. Resolves internal $refs inline; `seen` guards cycles.
function schemaTable(schema: any, root: any, depth = 0, seen: Set<string> = new Set()): string {
  if (!isObj(schema)) return '';
  if (schema.$ref) {
    const name = refName(schema.$ref);
    const target = resolveRef(root, schema.$ref);
    if (!target || seen.has(schema.$ref) || depth > 5) return `<p class="doc-ref">→ <code>${esc(name)}</code></p>`;
    seen.add(schema.$ref);
    const inner = schemaTable(target, root, depth + 1, seen);
    seen.delete(schema.$ref);
    return `<div class="doc-ref-expand"><div class="doc-ref-name"><code>${esc(name)}</code></div>${inner}</div>`;
  }
  const props = schema.properties;
  if (!isObj(props)) {
    for (const comb of ['allOf', 'oneOf', 'anyOf'] as const)
      if (Array.isArray(schema[comb])) return `<div class="doc-comb"><span class="doc-comb-label">${comb}</span>${schema[comb].map((s: any) => schemaTable(s, root, depth + 1, seen)).join('')}</div>`;
    const t = typeLabel(schema);
    return `<p class="doc-inline-type">${t ? `<code>${esc(t)}</code>` : ''}${md(schema.description)}</p>${constraints(schema)}`;
  }
  const required: string[] = Array.isArray(schema.required) ? schema.required : [];
  const rows = Object.entries<any>(props).map(([name, p]) => {
    const refKey = isObj(p) ? (p.$ref || (p.type === 'array' && p.items?.$ref) || '') : '';
    const obj = depth < 5 ? objSchema(p, root) : undefined;
    const nested = obj && !(refKey && seen.has(refKey))
      ? (() => { if (refKey) seen.add(refKey); const h = `<div class="doc-nested">${schemaTable(obj, root, depth + 1, seen)}</div>`; if (refKey) seen.delete(refKey); return h; })()
      : '';
    return `<tr>
      <td class="doc-pname"><code>${esc(name)}</code>${required.includes(name) ? '<span class="doc-req" title="required">*</span>' : ''}</td>
      <td class="doc-ptype"><code>${esc(typeLabel(p))}</code></td>
      <td class="doc-pdesc">${isObj(p) ? inlineMd(p.description) : ''}${constraints(p)}${nested}</td>
    </tr>`;
  }).join('');
  return `<table class="doc-table"><thead><tr><th>Property</th><th>Type</th><th>Description</th></tr></thead><tbody>${rows}</tbody></table>`;
}

function pageHeader(title: string, version: any, description: any, kind: string): string {
  return `<header class="doc-header">
    <div class="doc-kind">${esc(kind)}</div>
    <h1>${esc(title || 'Untitled')}${version ? ` <span class="doc-version">v${esc(version)}</span>` : ''}</h1>
    ${md(description)}
  </header>`;
}
const section = (title: string, body: string, id?: string): string =>
  body ? `<section class="doc-section"${id ? ` id="${esc(id)}"` : ''}><h2>${esc(title)}</h2>${body}</section>` : '';

// ---- OpenAPI ----------------------------------------------------------------
function renderOpenAPI(d: any): string {
  const parts: string[] = [pageHeader(d.info?.title, d.info?.version, d.info?.description, 'OpenAPI ' + (d.openapi || d.swagger || ''))];
  if (Array.isArray(d.servers) && d.servers.length)
    parts.push(section('Servers', `<ul class="doc-list">${d.servers.map((s: any) => `<li><code>${esc(s.url)}</code>${s.description ? ` — ${inlineMd(s.description)}` : ''}</li>`).join('')}</ul>`));

  const paths = isObj(d.paths) ? d.paths : {};
  const ops: Array<{ path: string; method: string; op: any }> = [];
  for (const [p, item] of Object.entries<any>(paths))
    for (const [m, op] of Object.entries<any>(item || {})) if (METHODS.includes(m) && isObj(op)) ops.push({ path: p, method: m, op });

  const opCard = ({ path, method, op }: { path: string; method: string; op: any }) => {
    const params = [...(paths[path].parameters || []), ...(op.parameters || [])];
    const paramRows = params.length ? `<h4>Parameters</h4><table class="doc-table"><thead><tr><th>Name</th><th>In</th><th>Type</th><th>Req</th><th>Description</th></tr></thead><tbody>${
      params.map((pa: any) => `<tr><td><code>${esc(pa.name)}</code></td><td>${esc(pa.in)}</td><td><code>${esc(typeLabel(pa.schema || pa))}</code></td><td>${pa.required ? 'yes' : ''}</td><td>${inlineMd(pa.description)}</td></tr>`).join('')
    }</tbody></table>` : '';
    const body = op.requestBody?.content ? `<h4>Request body</h4>${Object.entries<any>(op.requestBody.content).map(([ct, mt]) => `<div class="doc-media"><code>${esc(ct)}</code>${schemaTable(mt.schema || {}, d)}</div>`).join('')}` : '';
    const responses = isObj(op.responses) ? `<h4>Responses</h4>${Object.entries<any>(op.responses).map(([code, r]) => `<div class="doc-resp"><span class="doc-status">${esc(code)}</span> ${inlineMd(r?.description)}${r?.content ? Object.entries<any>(r.content).map(([ct, mt]) => `<div class="doc-media"><code>${esc(ct)}</code>${schemaTable(mt.schema || {}, d)}</div>`).join('') : ''}</div>`).join('')}` : '';
    return `<div class="doc-op" id="op-${esc(anchor(method + '-' + path))}">
      <div class="doc-op-head"><span class="doc-method doc-m-${esc(method)}">${esc(method.toUpperCase())}</span><code class="doc-path">${esc(path)}</code></div>
      ${op.summary ? `<div class="doc-summary">${esc(op.summary)}</div>` : ''}
      ${op.operationId ? `<div class="doc-opid">operationId: <code>${esc(op.operationId)}</code></div>` : ''}
      ${md(op.description)}${paramRows}${body}${responses}
    </div>`;
  };

  const groups = new Map<string, typeof ops>();
  for (const o of ops) { const tag = o.op.tags?.[0] || 'default'; (groups.get(tag) ?? groups.set(tag, []).get(tag)!).push(o); }
  const opsHtml = [...groups.entries()].map(([tag, list]) =>
    `<div class="doc-tag-group"><h3 class="doc-tag">${esc(tag)}</h3>${list.map(opCard).join('')}</div>`).join('');
  parts.push(section(`Operations (${ops.length})`, opsHtml, 'operations'));

  const schemas = d.components?.schemas;
  if (isObj(schemas))
    parts.push(section(`Schemas (${Object.keys(schemas).length})`, Object.entries<any>(schemas).map(([n, s]) =>
      `<div class="doc-schema" id="schema-${esc(anchor(n))}"><h3><code>${esc(n)}</code></h3>${md(s.description)}${schemaTable(s, d)}</div>`).join(''), 'schemas'));
  return parts.join('');
}

// ---- AsyncAPI ---------------------------------------------------------------
function renderAsyncAPI(d: any): string {
  const parts: string[] = [pageHeader(d.info?.title, d.info?.version, d.info?.description, 'AsyncAPI ' + (d.asyncapi || ''))];
  if (isObj(d.servers))
    parts.push(section('Servers', `<ul class="doc-list">${Object.entries<any>(d.servers).map(([n, s]) => `<li><strong>${esc(n)}</strong> — <code>${esc(s.url || s.host || '')}</code>${s.protocol ? ` (${esc(s.protocol)})` : ''}${s.description ? ` — ${inlineMd(s.description)}` : ''}</li>`).join('')}</ul>`));

  const channels = isObj(d.channels) ? d.channels : {};
  const chHtml = Object.entries<any>(channels).map(([name, ch]) => {
    const opBlocks = ['subscribe', 'publish'].filter((k) => isObj(ch?.[k])).map((k) => {
      const op = ch[k];
      const payload = op.message?.payload || op.message?.oneOf;
      return `<div class="doc-op"><div class="doc-op-head"><span class="doc-method doc-m-${k === 'publish' ? 'post' : 'get'}">${k.toUpperCase()}</span></div>${md(op.summary || op.description)}${payload ? `<h4>Message payload</h4>${schemaTable(payload, d)}` : ''}</div>`;
    }).join('');
    const messages = isObj(ch?.messages) ? `<h4>Messages</h4>${Object.entries<any>(ch.messages).map(([mn, m]) => `<div class="doc-media"><strong>${esc(mn)}</strong>${md(m.summary || m.description)}${m.payload ? schemaTable(m.payload, d) : ''}</div>`).join('')}` : '';
    return `<div class="doc-channel"><h3><code>${esc(ch.address || name)}</code></h3>${md(ch.description)}${opBlocks}${messages}</div>`;
  }).join('');
  parts.push(section(`Channels (${Object.keys(channels).length})`, chHtml, 'channels'));

  const schemas = d.components?.schemas;
  if (isObj(schemas))
    parts.push(section(`Schemas (${Object.keys(schemas).length})`, Object.entries<any>(schemas).map(([n, s]) =>
      `<div class="doc-schema"><h3><code>${esc(n)}</code></h3>${md(s.description)}${schemaTable(s, d)}</div>`).join('')));
  return parts.join('');
}

// ---- JSON Schema ------------------------------------------------------------
function renderJsonSchema(d: any): string {
  const parts: string[] = [pageHeader(d.title, undefined, d.description, 'JSON Schema')];
  const meta: string[] = [];
  if (d.$schema) meta.push(`<li>$schema: <code>${esc(d.$schema)}</code></li>`);
  if (d.$id) meta.push(`<li>$id: <code>${esc(d.$id)}</code></li>`);
  if (d.type) meta.push(`<li>type: <code>${esc(Array.isArray(d.type) ? d.type.join(' | ') : d.type)}</code></li>`);
  if (meta.length) parts.push(section('Schema', `<ul class="doc-list">${meta.join('')}</ul>`));
  if (isObj(d.properties)) parts.push(section('Properties', schemaTable(d, d)));
  const defs = d.$defs || d.definitions;
  if (isObj(defs))
    parts.push(section(`Definitions (${Object.keys(defs).length})`, Object.entries<any>(defs).map(([n, s]) =>
      `<div class="doc-schema"><h3><code>${esc(n)}</code></h3>${md(s.description)}${schemaTable(s, d)}</div>`).join('')));
  return parts.join('');
}

// ---- Arazzo -----------------------------------------------------------------
function renderArazzo(d: any): string {
  const parts: string[] = [pageHeader(d.info?.title, d.info?.version, d.info?.summary || d.info?.description, 'Arazzo ' + (d.arazzo || ''))];
  if (Array.isArray(d.sourceDescriptions) && d.sourceDescriptions.length)
    parts.push(section('Source descriptions', `<ul class="doc-list">${d.sourceDescriptions.map((s: any) => `<li><strong>${esc(s.name)}</strong> (${esc(s.type || 'openapi')}) — <code>${esc(s.url)}</code></li>`).join('')}</ul>`));

  const workflows = Array.isArray(d.workflows) ? d.workflows : [];
  const wfHtml = workflows.map((w: any) => {
    const inputs = isObj(w.inputs) ? `<h4>Inputs</h4>${schemaTable(w.inputs, d)}` : '';
    const steps = Array.isArray(w.steps) ? `<h4>Steps (${w.steps.length})</h4><ol class="doc-steps">${w.steps.map((st: any) => `<li>
        <div class="doc-step-id"><code>${esc(st.stepId || '')}</code>${st.operationId ? ` → <code>${esc(st.operationId)}</code>` : st.operationPath ? ` → <code>${esc(st.operationPath)}</code>` : st.workflowId ? ` → workflow <code>${esc(st.workflowId)}</code>` : ''}</div>
        ${md(st.description)}
        ${Array.isArray(st.parameters) && st.parameters.length ? `<div class="doc-step-params">params: ${st.parameters.map((p: any) => `<code>${esc(p.name)}</code>`).join(', ')}</div>` : ''}
        ${Array.isArray(st.successCriteria) && st.successCriteria.length ? `<div class="doc-step-crit">success: ${st.successCriteria.map((c: any) => `<code>${esc(c.condition || c)}</code>`).join(', ')}</div>` : ''}
      </li>`).join('')}</ol>` : '';
    return `<div class="doc-workflow"><h3><code>${esc(w.workflowId || 'workflow')}</code></h3>${w.summary ? `<div class="doc-summary">${esc(w.summary)}</div>` : ''}${md(w.description)}${inputs}${steps}</div>`;
  }).join('');
  parts.push(section(`Workflows (${workflows.length})`, wfHtml, 'workflows'));
  return parts.join('');
}

// ---- APIs.json --------------------------------------------------------------
function renderApisJson(d: any): string {
  const parts: string[] = [pageHeader(d.name, d.specificationVersion, d.description, 'APIs.json ' + (d.specificationVersion || ''))];
  const meta: string[] = [];
  if (d.url) meta.push(`<li>url: <code>${esc(d.url)}</code></li>`);
  if (Array.isArray(d.tags) && d.tags.length) meta.push(`<li>tags: ${d.tags.map((t: any) => `<code>${esc(t)}</code>`).join(' ')}</li>`);
  if (meta.length) parts.push(section('Index', `<ul class="doc-list">${meta.join('')}</ul>`));
  const apiCard = (a: any) => {
    const props = Array.isArray(a.properties) ? `<h4>Properties</h4><ul class="doc-list">${a.properties.map((p: any) => `<li><code>${esc(p.type)}</code>${p.url ? ` — <a href="${esc(p.url)}" target="_blank" rel="noopener">${esc(p.url)}</a>` : ''}</li>`).join('')}</ul>` : '';
    return `<div class="doc-op"><div class="doc-op-head"><code class="doc-path">${esc(a.name || 'API')}</code></div>${md(a.description)}
      ${a.humanURL ? `<div class="doc-opid">human: <a href="${esc(a.humanURL)}" target="_blank" rel="noopener">${esc(a.humanURL)}</a></div>` : ''}
      ${a.baseURL ? `<div class="doc-opid">base: <code>${esc(a.baseURL)}</code></div>` : ''}${props}</div>`;
  };
  if (Array.isArray(d.apis)) parts.push(section(`APIs (${d.apis.length})`, d.apis.map(apiCard).join('')));
  if (Array.isArray(d.common) && d.common.length)
    parts.push(section('Common', `<ul class="doc-list">${d.common.map((p: any) => `<li><code>${esc(p.type)}</code>${p.url ? ` — <code>${esc(p.url)}</code>` : ''}</li>`).join('')}</ul>`));
  return parts.join('');
}

// ---- MCP (server.json / MCP server) -----------------------------------------
function renderMcp(d: any): string {
  const parts: string[] = [pageHeader(d.name, d.version || d.protocolVersion, d.description, 'MCP')];
  const list = (title: string, arr: any, body: (x: any) => string) =>
    Array.isArray(arr) && arr.length ? parts.push(section(`${title} (${arr.length})`, arr.map(body).join(''))) : 0;
  list('Tools', d.tools, (t: any) => `<div class="doc-op"><div class="doc-op-head"><code class="doc-path">${esc(t.name)}</code></div>${md(t.description)}${isObj(t.inputSchema) ? `<h4>Input</h4>${schemaTable(t.inputSchema, d)}` : ''}</div>`);
  list('Resources', d.resources, (r: any) => `<div class="doc-op"><div class="doc-op-head"><code class="doc-path">${esc(r.name || r.uri)}</code></div>${md(r.description)}${r.uri ? `<div class="doc-opid">uri: <code>${esc(r.uri)}</code></div>` : ''}${r.mimeType ? `<div class="doc-opid">type: <code>${esc(r.mimeType)}</code></div>` : ''}</div>`);
  list('Prompts', d.prompts, (p: any) => `<div class="doc-op"><div class="doc-op-head"><code class="doc-path">${esc(p.name)}</code></div>${md(p.description)}${Array.isArray(p.arguments) && p.arguments.length ? `<div class="doc-step-params">args: ${p.arguments.map((a: any) => `<code>${esc(a.name)}</code>`).join(', ')}</div>` : ''}</div>`);
  return parts.join('');
}

// ---- JSON-LD ----------------------------------------------------------------
function renderJsonLd(d: any): string {
  const parts: string[] = [pageHeader(d.name || d['@id'] || 'JSON-LD document', undefined, d.description, 'JSON-LD')];
  const ctx = d['@context'];
  if (isObj(ctx)) parts.push(section('@context', `<table class="doc-table"><thead><tr><th>Term</th><th>IRI / definition</th></tr></thead><tbody>${Object.entries<any>(ctx).map(([k, v]) => `<tr><td><code>${esc(k)}</code></td><td>${isObj(v) ? `<code>${esc(JSON.stringify(v))}</code>` : `<code>${esc(v)}</code>`}</td></tr>`).join('')}</tbody></table>`));
  else if (typeof ctx === 'string') parts.push(section('@context', `<p><code>${esc(ctx)}</code></p>`));
  const graph = Array.isArray(d['@graph']) ? d['@graph'] : null;
  if (graph) parts.push(section(`@graph (${graph.length})`, graph.map((n: any) => `<div class="doc-schema"><h3><code>${esc(n['@id'] || n['@type'] || 'node')}</code></h3>${n['@type'] ? `<div class="doc-opid">@type: <code>${esc(Array.isArray(n['@type']) ? n['@type'].join(', ') : n['@type'])}</code></div>` : ''}${renderValueBlock(n, new Set(['@id', '@type']))}</div>`).join('')));
  return parts.join('');
}

// ---- generic fallback (plans, rate-limits, finops, json-structure) ----------
const titleize = (k: string) => k.replace(/[-_]/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
function cellVal(v: any): string {
  if (v == null) return '';
  if (typeof v === 'object') { const j = JSON.stringify(v); return `<code>${esc(j.length > 80 ? j.slice(0, 77) + '…' : j)}</code>`; }
  return inlineMd(v);
}
// Render an object's remaining keys as a definition list / nested tables.
function renderValueBlock(obj: any, skip: Set<string>): string {
  return Object.entries<any>(obj).filter(([k]) => !skip.has(k)).map(([k, v]) => `<div class="doc-kv-row"><span class="doc-kv-key">${esc(titleize(k))}</span> ${renderValue(v)}</div>`).join('');
}
function renderValue(v: any): string {
  if (Array.isArray(v)) {
    if (!v.length) return '<span class="doc-ref">(empty)</span>';
    if (v.every((x) => x == null || typeof x !== 'object')) return `<ul class="doc-list">${v.map((x) => `<li>${cellVal(x)}</li>`).join('')}</ul>`;
    const cols = [...new Set(v.flatMap((x) => (isObj(x) ? Object.keys(x) : [])))].slice(0, 8);
    return `<table class="doc-table"><thead><tr>${cols.map((c) => `<th>${esc(titleize(c))}</th>`).join('')}</tr></thead><tbody>${v.map((x) => `<tr>${cols.map((c) => `<td>${cellVal(isObj(x) ? x[c] : '')}</td>`).join('')}</tr>`).join('')}</tbody></table>`;
  }
  if (isObj(v)) return `<dl class="doc-kv">${Object.entries<any>(v).map(([k, val]) => `<dt>${esc(titleize(k))}</dt><dd>${cellVal(val)}</dd>`).join('')}</dl>`;
  return `<span>${cellVal(v)}</span>`;
}
function renderGeneric(kind: string): (d: any) => string {
  const skip = new Set(['name', 'title', 'version', 'specificationVersion', 'description', 'summary']);
  return (d: any) => {
    const parts: string[] = [pageHeader(d.name || d.title, d.version || d.specificationVersion, d.description || d.summary, kind)];
    for (const [k, v] of Object.entries<any>(d)) if (!skip.has(k) && v != null) parts.push(section(titleize(k), renderValue(v)));
    return parts.join('');
  };
}

// ---- Agent Skill (Markdown SKILL.md) ----------------------------------------
function splitFrontmatter(text: string): { fm: any; body: string } {
  const m = /^﻿?---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(text);
  if (!m) return { fm: {}, body: text };
  let fm: any = {};
  try { fm = parseYaml(m[1]) || {}; } catch { /* ignore bad frontmatter */ }
  return { fm: isObj(fm) ? fm : {}, body: m[2] };
}
function renderAgentSkill(text: string): string {
  const { fm, body } = splitFrontmatter(text);
  const parts: string[] = [pageHeader(fm.name, fm.version, fm.description, 'Agent Skill')];
  const meta: string[] = [];
  for (const k of ['license', 'allowed-tools', 'compatibility']) if (fm[k] != null) meta.push(`<li>${esc(k)}: <code>${esc(Array.isArray(fm[k]) ? fm[k].join(', ') : fm[k])}</code></li>`);
  if (meta.length) parts.push(section('Metadata', `<ul class="doc-list">${meta.join('')}</ul>`));
  if (body.trim()) parts.push(`<section class="doc-section">${md(body)}</section>`);
  return parts.join('');
}

const RENDERERS: Record<string, (d: any) => string> = {
  openapi: renderOpenAPI, asyncapi: renderAsyncAPI, jsonschema: renderJsonSchema, arazzo: renderArazzo,
  'apis-json': renderApisJson, mcp: renderMcp, 'json-ld': renderJsonLd,
  'json-structure': renderJsonSchema, plans: renderGeneric('Plans'),
  'rate-limits': renderGeneric('Rate Limits'), finops: renderGeneric('FinOps'),
};

export interface DocsResult { html: string; error?: string; }

function parse(text: string): { d?: any; error?: string } {
  let d: any;
  try { d = parseYaml(text); } catch (e) { return { error: `Could not parse the document: ${e instanceof Error ? e.message : String(e)}` }; }
  if (!isObj(d)) return { error: 'The document is empty or not an object.' };
  return { d };
}

export function renderDocs(format: string, text: string): DocsResult {
  if (format === 'agent-skill') {
    try { return { html: renderAgentSkill(text) }; } catch (e) { return { html: '', error: `Could not render documentation: ${e instanceof Error ? e.message : String(e)}` }; }
  }
  const { d, error } = parse(text);
  if (error) return { html: '', error };
  const fn = RENDERERS[format];
  if (!fn) return { html: '', error: `No documentation renderer for “${format}”.` };
  try { return { html: fn(d) }; } catch (e) { return { html: '', error: `Could not render documentation: ${e instanceof Error ? e.message : String(e)}` }; }
}

// ---- Markdown output --------------------------------------------------------
const mdCell = (s: any): string => String(s ?? '').replace(/\s*\n\s*/g, ' ').replace(/\|/g, '\\|').trim();
// Flat property table (one level; top-level $ref resolved) as a Markdown table.
function mdProps(schema: any, root: any): string {
  let s = schema;
  let guard = 0;
  while (isObj(s) && s.$ref && guard++ < 12) s = resolveRef(root, s.$ref) || s;
  if (!isObj(s) || !isObj(s.properties)) { const t = typeLabel(s); return t ? `Type: \`${t}\`\n\n` : ''; }
  const req: string[] = Array.isArray(s.required) ? s.required : [];
  let out = '| Property | Type | Required | Description |\n|---|---|---|---|\n';
  for (const [n, p] of Object.entries<any>(s.properties))
    out += `| \`${n}\` | \`${typeLabel(p)}\` | ${req.includes(n) ? 'yes' : ''} | ${mdCell(isObj(p) ? p.description : '')} |\n`;
  return out + '\n';
}
function mdOpenAPI(d: any): string {
  const L: string[] = [`# ${d.info?.title || 'Untitled'}${d.info?.version ? ` v${d.info.version}` : ''}`, ''];
  if (d.info?.description) L.push(d.info.description, '');
  if (Array.isArray(d.servers) && d.servers.length) { L.push('## Servers', ''); for (const s of d.servers) L.push(`- \`${s.url}\`${s.description ? ` — ${mdCell(s.description)}` : ''}`); L.push(''); }
  const paths = isObj(d.paths) ? d.paths : {};
  L.push('## Operations', '');
  for (const [p, item] of Object.entries<any>(paths)) for (const [m, op] of Object.entries<any>(item || {})) {
    if (!METHODS.includes(m) || !isObj(op)) continue;
    L.push(`### \`${m.toUpperCase()} ${p}\``, '');
    if (op.summary) L.push(`**${mdCell(op.summary)}**`, '');
    if (op.operationId) L.push(`operationId: \`${op.operationId}\``, '');
    if (op.description) L.push(op.description, '');
    const params = [...(paths[p].parameters || []), ...(op.parameters || [])];
    if (params.length) { L.push('**Parameters**', '', '| Name | In | Type | Req | Description |', '|---|---|---|---|---|'); for (const pa of params) L.push(`| \`${pa.name}\` | ${pa.in} | \`${typeLabel(pa.schema || pa)}\` | ${pa.required ? 'yes' : ''} | ${mdCell(pa.description)} |`); L.push(''); }
    if (isObj(op.responses)) { L.push('**Responses**', '', '| Status | Description |', '|---|---|'); for (const [code, r] of Object.entries<any>(op.responses)) L.push(`| \`${code}\` | ${mdCell(r?.description)} |`); L.push(''); }
  }
  const schemas = d.components?.schemas;
  if (isObj(schemas)) { L.push('## Schemas', ''); for (const [n, s] of Object.entries<any>(schemas)) { L.push(`### \`${n}\``, ''); if (s.description) L.push(mdCell(s.description), ''); L.push(mdProps(s, d)); } }
  return L.join('\n');
}
function mdAsyncAPI(d: any): string {
  const L: string[] = [`# ${d.info?.title || 'Untitled'}${d.info?.version ? ` v${d.info.version}` : ''}`, ''];
  if (d.info?.description) L.push(d.info.description, '');
  const channels = isObj(d.channels) ? d.channels : {};
  L.push('## Channels', '');
  for (const [name, ch] of Object.entries<any>(channels)) {
    L.push(`### \`${ch.address || name}\``, '');
    if (ch.description) L.push(mdCell(ch.description), '');
    for (const k of ['subscribe', 'publish']) if (isObj(ch?.[k])) { L.push(`**${k}**`, ''); const pl = ch[k].message?.payload; if (pl) L.push(mdProps(pl, d)); }
    if (isObj(ch?.messages)) for (const [mn, m] of Object.entries<any>(ch.messages)) { L.push(`**Message: ${mn}**`, ''); if (m.payload) L.push(mdProps(m.payload, d)); }
  }
  const schemas = d.components?.schemas;
  if (isObj(schemas)) { L.push('## Schemas', ''); for (const [n, s] of Object.entries<any>(schemas)) { L.push(`### \`${n}\``, ''); L.push(mdProps(s, d)); } }
  return L.join('\n');
}
function mdJsonSchema(d: any): string {
  const L: string[] = [`# ${d.title || 'JSON Schema'}`, ''];
  if (d.description) L.push(d.description, '');
  if (d.type) L.push(`type: \`${Array.isArray(d.type) ? d.type.join(' | ') : d.type}\``, '');
  if (isObj(d.properties)) { L.push('## Properties', ''); L.push(mdProps(d, d)); }
  const defs = d.$defs || d.definitions;
  if (isObj(defs)) { L.push('## Definitions', ''); for (const [n, s] of Object.entries<any>(defs)) { L.push(`### \`${n}\``, ''); L.push(mdProps(s, d)); } }
  return L.join('\n');
}
function mdArazzo(d: any): string {
  const L: string[] = [`# ${d.info?.title || 'Arazzo'}${d.info?.version ? ` v${d.info.version}` : ''}`, ''];
  if (d.info?.summary || d.info?.description) L.push(d.info.summary || d.info.description, '');
  if (Array.isArray(d.sourceDescriptions) && d.sourceDescriptions.length) { L.push('## Source descriptions', ''); for (const s of d.sourceDescriptions) L.push(`- **${s.name}** (${s.type || 'openapi'}) — \`${s.url}\``); L.push(''); }
  L.push('## Workflows', '');
  for (const w of (Array.isArray(d.workflows) ? d.workflows : [])) {
    L.push(`### \`${w.workflowId || 'workflow'}\``, '');
    if (w.summary) L.push(`**${mdCell(w.summary)}**`, '');
    if (w.description) L.push(w.description, '');
    if (Array.isArray(w.steps)) { L.push('**Steps**', ''); for (const st of w.steps) L.push(`1. \`${st.stepId || ''}\`${st.operationId ? ` → \`${st.operationId}\`` : st.operationPath ? ` → \`${st.operationPath}\`` : st.workflowId ? ` → workflow \`${st.workflowId}\`` : ''}${st.description ? ` — ${mdCell(st.description)}` : ''}`); L.push(''); }
  }
  return L.join('\n');
}
// Generic Markdown dump for the loosely-structured / catch-all types.
function mdGeneric(kind: string): (d: any) => string {
  const skip = new Set(['name', 'title', 'version', 'specificationVersion', 'description', 'summary']);
  const cell = (v: any) => (v == null ? '' : typeof v === 'object' ? '`' + mdCell(JSON.stringify(v)) + '`' : mdCell(v));
  return (d: any) => {
    const L: string[] = [`# ${d.name || d.title || kind}${d.version || d.specificationVersion ? ` v${d.version || d.specificationVersion}` : ''}`, ''];
    if (d.description || d.summary) L.push(d.description || d.summary, '');
    for (const [k, v] of Object.entries<any>(d)) {
      if (skip.has(k) || v == null) continue;
      L.push(`## ${k.replace(/[-_]/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase())}`, '');
      if (Array.isArray(v) && v.length && v.some((x) => isObj(x))) {
        const cols = [...new Set(v.flatMap((x) => (isObj(x) ? Object.keys(x) : [])))].slice(0, 8);
        L.push('| ' + cols.join(' | ') + ' |', '|' + cols.map(() => '---').join('|') + '|');
        for (const x of v) L.push('| ' + cols.map((c) => cell(isObj(x) ? x[c] : '')).join(' | ') + ' |');
      } else if (Array.isArray(v)) L.push(...v.map((x) => `- ${cell(x)}`));
      else if (isObj(v)) for (const [kk, vv] of Object.entries(v)) L.push(`- **${kk}**: ${cell(vv)}`);
      else L.push(cell(v));
      L.push('');
    }
    return L.join('\n');
  };
}
const MD_RENDERERS: Record<string, (d: any) => string> = {
  openapi: mdOpenAPI, asyncapi: mdAsyncAPI, jsonschema: mdJsonSchema, arazzo: mdArazzo,
  'apis-json': mdGeneric('APIs.json'), mcp: mdGeneric('MCP'), 'json-ld': mdGeneric('JSON-LD'),
  'json-structure': mdJsonSchema, plans: mdGeneric('Plans'), 'rate-limits': mdGeneric('Rate Limits'), finops: mdGeneric('FinOps'),
};
export function renderDocsMarkdown(format: string, text: string): { markdown: string; error?: string } {
  if (format === 'agent-skill') {
    // Agent skills are already Markdown — return the body (after frontmatter).
    try { const { fm, body } = splitFrontmatter(text); return { markdown: `# ${fm.name || 'Agent Skill'}\n\n${fm.description ? fm.description + '\n\n' : ''}${body}` }; }
    catch (e) { return { markdown: '', error: `Could not render documentation: ${e instanceof Error ? e.message : String(e)}` }; }
  }
  const { d, error } = parse(text);
  if (error) return { markdown: '', error };
  const fn = MD_RENDERERS[format];
  if (!fn) return { markdown: '', error: `No documentation renderer for “${format}”.` };
  try { return { markdown: fn(d) }; } catch (e) { return { markdown: '', error: `Could not render documentation: ${e instanceof Error ? e.message : String(e)}` }; }
}

// The stylesheet used both in the app (scoped by .doc-view) and the standalone
// download. Kept here so the download is fully self-contained.
// Colours are driven by CSS variables with LIGHT defaults (so the standalone
// download / print stays printable). The in-app preview remaps these variables to
// the dark app palette — see injectDocsStyle in main.ts.
export const DOCS_CSS = `
.doc-view {
  --dc-fg: #1e1e1e; --dc-muted: #666; --dc-faint: #888; --dc-line: #e3e7ee;
  --dc-soft: #fafbfc; --dc-th: #f1f3f6; --dc-code: #eef1f5; --dc-accent: #0d6efd; --dc-border: #eee;
  color: var(--dc-fg); line-height: 1.55;
}
.doc-view a { color: var(--dc-accent); }
.doc-header { border-bottom: 2px solid var(--dc-border); padding-bottom: 0.75rem; margin-bottom: 1rem; }
.doc-kind { font-size: 0.72rem; text-transform: uppercase; letter-spacing: 1px; color: var(--dc-faint); font-weight: 700; }
.doc-header h1 { margin: 0.2rem 0; font-size: 1.7rem; }
.doc-version { font-size: 0.9rem; color: var(--dc-muted); font-weight: 500; }
.doc-desc { color: var(--dc-fg); }
.doc-desc p { margin: 0.4rem 0; }
.doc-desc ul, .doc-desc ol { margin: 0.4rem 0; padding-left: 1.3rem; }
.doc-section { margin: 1.5rem 0; }
.doc-section > h2 { font-size: 1.25rem; border-bottom: 1px solid var(--dc-border); padding-bottom: 0.3rem; }
.doc-list { margin: 0.4rem 0; padding-left: 1.2rem; }
.doc-tag { font-size: 1.05rem; color: var(--dc-accent); margin: 1rem 0 0.4rem; }
.doc-op { border: 1px solid var(--dc-line); border-radius: 8px; padding: 0.75rem 0.9rem; margin: 0.6rem 0; background: var(--dc-soft); }
.doc-op-head { display: flex; align-items: center; gap: 0.6rem; }
.doc-method { color: #fff; font-weight: 700; font-size: 0.72rem; padding: 2px 8px; border-radius: 4px; letter-spacing: 0.5px; }
.doc-m-get { background: #0d6efd; } .doc-m-post { background: #198754; } .doc-m-put { background: #fd7e14; }
.doc-m-patch { background: #6f42c1; } .doc-m-delete { background: #dc3545; } .doc-m-head, .doc-m-options, .doc-m-trace { background: #6c757d; }
.doc-path { font-size: 0.95rem; }
.doc-summary { font-weight: 600; margin: 0.4rem 0 0.2rem; }
.doc-opid { font-size: 0.8rem; color: var(--dc-muted); }
.doc-op h4 { margin: 0.7rem 0 0.3rem; font-size: 0.85rem; text-transform: uppercase; letter-spacing: 0.5px; color: var(--dc-muted); }
.doc-table { width: 100%; border-collapse: collapse; margin: 0.3rem 0; font-size: 0.9rem; }
.doc-table th, .doc-table td { border: 1px solid var(--dc-line); padding: 5px 8px; text-align: left; vertical-align: top; }
.doc-table th { background: var(--dc-th); font-size: 0.78rem; text-transform: uppercase; letter-spacing: 0.4px; color: var(--dc-muted); }
.doc-req { color: #dc3545; font-weight: 700; }
.doc-constraints { font-size: 0.8rem; color: var(--dc-faint); margin-top: 2px; }
.doc-nested { margin-top: 0.4rem; padding-left: 0.6rem; border-left: 2px solid var(--dc-line); }
.doc-ref-expand { margin: 0.2rem 0; }
.doc-ref-name { font-size: 0.82rem; color: var(--dc-accent); margin-bottom: 2px; }
.doc-comb { margin: 0.3rem 0; padding-left: 0.6rem; border-left: 2px dashed var(--dc-line); }
.doc-comb-label { font-size: 0.75rem; text-transform: uppercase; color: var(--dc-faint); font-weight: 700; }
.doc-resp { margin: 0.3rem 0; }
.doc-status { display: inline-block; font-weight: 700; font-family: ui-monospace, Menlo, monospace; background: var(--dc-code); padding: 1px 6px; border-radius: 3px; margin-right: 0.4rem; }
.doc-schema, .doc-channel, .doc-workflow { margin: 1rem 0; }
.doc-schema h3, .doc-channel h3, .doc-workflow h3 { font-size: 1rem; }
.doc-steps { padding-left: 1.2rem; }
.doc-steps li { margin: 0.5rem 0; }
.doc-step-params, .doc-step-crit { font-size: 0.82rem; color: var(--dc-muted); margin-top: 2px; }
.doc-ref { color: var(--dc-muted); }
.doc-kv { display: grid; grid-template-columns: minmax(120px, max-content) 1fr; gap: 2px 0.8rem; margin: 0.2rem 0; }
.doc-kv dt { color: var(--dc-muted); font-size: 0.85rem; }
.doc-kv dd { margin: 0; }
.doc-kv-row { margin: 0.3rem 0; }
.doc-kv-key { display: block; font-size: 0.8rem; text-transform: uppercase; letter-spacing: 0.4px; color: var(--dc-muted); margin-bottom: 2px; }
.doc-view code { background: var(--dc-code); padding: 1px 5px; border-radius: 3px; font-size: 0.88em; }
`;

export function standaloneDocs(title: string, inner: string): string {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)} — Documentation</title>
<style>body{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;max-width:900px;margin:2rem auto;padding:0 1rem;background:#fff;}${DOCS_CSS}</style>
</head><body><div class="doc-view">${inner}</div></body></html>`;
}
