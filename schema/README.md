# Artifact JSON Schemas

The latest-draft JSON Schema for every artifact type the [spotlight-validator](../) lints — one file per artifact, named `<artifact-id>.schema.json`. Bare names are the **latest** version of each spec; `-<version>` files are still-active alternate versions.

| File | Artifact | Version | Draft | Source | Size |
| --- | --- | --- | --- | --- | --- |
| `openapi.schema.json` | OpenAPI | 3.1 | draft 2020-12 | upstream | 33.2 KB |
| `openapi-3.0.schema.json` | OpenAPI | 3.0.x | draft-04 | upstream (variant) | 34.9 KB |
| `asyncapi.schema.json` | AsyncAPI | 3.0.0 | draft-07 | upstream | 388.5 KB |
| `asyncapi-2.6.schema.json` | AsyncAPI | 2.6.0 | draft-07 | upstream (variant) | 129.4 KB |
| `arazzo.schema.json` | Arazzo | 1.0 (2024-08-01) | draft 2020-12 | upstream | 31.2 KB |
| `json-schema.schema.json` | JSON Schema | draft 2020-12 | 2020-12 | upstream | 2.4 KB |
| `json-schema-draft-07.schema.json` | JSON Schema | draft-07 | draft-07 | upstream (variant) | 4.9 KB |
| `json-structure.schema.json` | JSON Structure | core meta v0 | JSON Structure meta | upstream | 16.9 KB |
| `mcp.schema.json` | Model Context Protocol | 2025-11-25 | draft 2020-12 | upstream | 170.2 KB |
| `apis-json.schema.json` | APIs.json | 0.21 | draft 2020-12 | converted | 12.4 KB |
| `json-ld.schema.json` | JSON-LD | — | draft 2020-12 | authored | 0.7 KB |
| `plans.schema.json` | API Plans | — | draft 2020-12 | authored | 1.2 KB |
| `rate-limits.schema.json` | API Rate Limits | — | draft 2020-12 | authored | 1.2 KB |
| `finops.schema.json` | API FinOps | — | draft 2020-12 | authored | 1 KB |
| `agent-skill.schema.json` | Agent Skill (SKILL.md frontmatter) | — | draft 2020-12 | authored | 1.2 KB |

## Sources

- **Upstream** schemas are the canonical published files, fetched verbatim from each spec's repo. `mcp` uses the latest dated release (2025-11-25).
- **Variants** cover the prior major versions still widely in use: OpenAPI **3.0**, AsyncAPI **2.6**, and JSON Schema **draft-07** — alongside the latest (3.1 / 3.0.0 / 2020-12).
- **`apis-json`** is APIs.json **0.21** (latest), converted to JSON from `api-commons/api-json/spec/schema_0.21.yml`.
- **Authored** schemas (`json-ld`, `plans`, `rate-limits`, `finops`, `agent-skill`) have no upstream JSON Schema and are written to match what the validator already governs (`rules/defaults/<artifact>.yaml`, and `spotlight:skill` for skills).

## Notes

- All files are valid JSON. Authored/derived schemas compile under Ajv 2020 and accept the validator's `samples/`.
- `json-schema*.schema.json` are the JSON Schema **meta-schemas**; `json-structure.schema.json` is JSON Structure's own meta-schema dialect. `openapi-3.0` is written in JSON Schema draft-04 (as the OAS 3.0 spec is).
- The `samples/openapi.yaml` example is OpenAPI **3.0.3** — it validates against `openapi-3.0.schema.json` (not the 3.1 file).
- `apis-json` 0.21 is strict (e.g. requires `maintainers`); the minimal `samples/apis-json.yaml` is a starter, not a fully-conformant document.
