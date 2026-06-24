# Third-Party Notices

Spotlight Validator ships a "best-of-breed" ruleset compiled from publicly
licensed Spectral rulesets, and bundles a small number of custom rule functions
from some of them. We are grateful to these projects. Each project's full license
is vendored under [`rules/sources/licenses/`](./rules/sources/licenses/), and the
original (unmodified) rule files are kept under
[`rules/sources/`](./rules/sources/). Provenance for every compiled rule is
recorded in its `source:` tag.

Only rules under licenses compatible with redistribution under this project are
included. The Italian Government ruleset
([italia/api-oas-checker-rules](https://github.com/italia/api-oas-checker-rules)),
which is **AGPL-3.0**, was **deliberately excluded** to avoid the network-copyleft
obligations and Apache-2.0 incompatibility.

## First-party rules

Rules tagged `source:api-evangelist` come from
[api-evangelist/rules](https://github.com/api-evangelist/rules), a first-party
ruleset within the same API Commons / API Evangelist ecosystem as this validator
(not a third party). Only the `-error`/`-warn` violation rules are compiled; the
paired `-info` positive-confirmation rules are dropped.

## Bundled (third-party) sources

| Project | Repository | License | Copyright |
| --- | --- | --- | --- |
| SPS Commerce | [SPSCommerce/sps-api-standards](https://github.com/SPSCommerce/sps-api-standards) | Apache-2.0 | SPS Commerce, Inc. |
| Baloise | [baloise-incubator/spectral-ruleset](https://github.com/baloise-incubator/spectral-ruleset) | Apache-2.0 | Baloise |
| DigitalOcean | [digitalocean/openapi](https://github.com/digitalocean/openapi) | Apache-2.0 | DigitalOcean |
| Schwarz IT | [SchwarzIT/api-linter-rules](https://github.com/SchwarzIT/api-linter-rules) | Apache-2.0 | Schwarz IT |
| Microcks | [microcks/microcks-spectral-ruleset](https://github.com/microcks/microcks-spectral-ruleset) | Apache-2.0 | The Microcks Authors |
| Adidas | [adidas/api-guidelines](https://github.com/adidas/api-guidelines) | MIT | © 2017 adidas-group |
| Paystack | [PaystackOSS/openapi](https://github.com/PaystackOSS/openapi) | MIT | © 2022 PaystackOSS |
| Team Digitale | [teamdigitale/api-openapi-samples](https://github.com/teamdigitale/api-openapi-samples) | MIT | © 2018 Roberto Polli |
| Trimble | [trimble-oss/openapi-spectral-rules](https://github.com/trimble-oss/openapi-spectral-rules) | MIT | © 2022 Trimble |

Bundled **custom rule functions** (`src/functions/<source>/`) come from
DigitalOcean (Apache-2.0), Microcks (Apache-2.0), Trimble (MIT), and Baloise
(Apache-2.0); their only modification is repointing `@stoplight/spectral-core`
imports to `@spotlight-rules/spotlight-core`. Original copyright headers are
retained where present; all are covered by the licenses above.

## Apache License 2.0 sources

SPS Commerce, Baloise, DigitalOcean, Schwarz IT, and Microcks are licensed under
the Apache License, Version 2.0. The full license text for each is vendored as
`rules/sources/licenses/<source>-LICENSE`. You may obtain a copy of the License
at http://www.apache.org/licenses/LICENSE-2.0. The compiled rules are a derivative
of these works; this file and the vendored licenses preserve the required
attribution.

## MIT License sources

Adidas, Paystack, Team Digitale, and Trimble are licensed under the MIT License.
The MIT License requires that the copyright notice and permission notice be
included in copies or substantial portions of the software; the full text for
each (including its copyright line) is vendored as
`rules/sources/licenses/<source>-LICENSE`, reproduced here by reference.

---

This project (Spotlight Validator) is itself licensed under the Apache License
2.0 — see [LICENSE](./LICENSE).
