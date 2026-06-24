# Spotlight Validator

A browser-based API governance playground — lint **eleven artifact types**
(APIs.json, OpenAPI, MCP, Arazzo, AsyncAPI, JSON Schema, JSON Structure, JSON-LD,
Plans, Rate Limits, FinOps) with [Spotlight](https://spotlight-rules.com) rules.
Live at **[validator.spotlight-rules.com](https://validator.spotlight-rules.com)**.

- **Search APIs.io and load real artifacts** — pick an artifact type, search the
  [APIs.io](https://apis.io) catalog, and load any result straight into the
  editor. The validator is a first-class internal consumer of the APIs.io API.
  (Requires the apis-io-aws deploy that enables CORS + the internal-tier origin.)
- **Toggle YAML ⇄ JSON** — the editor converts the artifact in place.
- **A default Spotlight ruleset per artifact type** — see
  [`rules/defaults/`](./rules/defaults); OpenAPI/AsyncAPI/Arazzo extend the
  built-in Spotlight rulesets, the rest are starter rulesets to build on.
- **Powered by Spotlight, not Spectral** — runs the published
  `@spotlight-rules/spotlight-*` engine entirely in the browser (no backend).
- **Best-of-breed rules** compiled from the first-party
  [API Evangelist](https://github.com/api-evangelist/rules) OpenAPI governance
  ruleset plus public, redistribution-compatible Spectral rulesets (SPS Commerce,
  Adidas, Trimble, Paystack, DigitalOcean, Microcks, Baloise, Team Digitale,
  Schwarz IT — all Apache-2.0 or MIT). Attribution and vendored licenses are in
  [`THIRD_PARTY_NOTICES.md`](./THIRD_PARTY_NOTICES.md) and
  [`rules/sources/`](./rules/sources). The AGPL-3.0 Italian Government ruleset is
  intentionally excluded.
- **Select rules by tag** (`source:*`, `category:*`, `format:*`) or **edit your
  own ruleset** in a Monaco editor.

## Develop

```bash
npm install
npm run compile-rules   # rebuild rules/spotlight-recommended.yaml + src/compiled-ruleset.json
npm run dev
```

Rules use built-in Spotlight functions only (so the compiled set runs with no
custom JS); rules needing custom functions are kept in `rules/sources/` for
future curation. Deployed to GitHub Pages via `.github/workflows/pages.yml`.
