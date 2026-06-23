# Spotlight Validator

A browser-based API governance playground — lint **OpenAPI**, **AsyncAPI**, and
**JSON Schema** with [Spotlight](https://spotlight-rules.com) rules. Live at
**[validator.spotlight-rules.com](https://validator.spotlight-rules.com)**.

- **Powered by Spotlight, not Spectral** — runs the published
  `@spotlight-rules/spotlight-*` engine entirely in the browser (no backend).
- **Best-of-breed rules** compiled from public Spectral rulesets (SPS Commerce,
  Italian Government, Adidas, Trimble, Paystack, DigitalOcean, Microcks, Baloise,
  Team Digitale, Schwarz IT) — see [`rules/sources/`](./rules/sources).
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
