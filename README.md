# Spotlight Validator

A browser-based API governance playground — lint **OpenAPI**, **AsyncAPI**, and
**JSON Schema** with [Spotlight](https://spotlight-rules.com) rules. Live at
**[validator.spotlight-rules.com](https://validator.spotlight-rules.com)**.

- **Powered by Spotlight, not Spectral** — runs the published
  `@spotlight-rules/spotlight-*` engine entirely in the browser (no backend).
- **Best-of-breed rules** compiled from public, redistribution-compatible Spectral
  rulesets (SPS Commerce, Adidas, Trimble, Paystack, DigitalOcean, Microcks,
  Baloise, Team Digitale, Schwarz IT — all Apache-2.0 or MIT). Attribution and
  vendored licenses are in [`THIRD_PARTY_NOTICES.md`](./THIRD_PARTY_NOTICES.md)
  and [`rules/sources/`](./rules/sources). The AGPL-3.0 Italian Government ruleset
  is intentionally excluded.
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
