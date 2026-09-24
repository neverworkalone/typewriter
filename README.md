# Typewriter

[![CI](https://github.com/neverworkalone/typewriter/actions/workflows/ci.yml/badge.svg)](https://github.com/neverworkalone/typewriter/actions/workflows/ci.yml)
[![Deep CI](https://github.com/neverworkalone/typewriter/actions/workflows/deep.yml/badge.svg)](https://github.com/neverworkalone/typewriter/actions/workflows/deep.yml)

> **작가를 위한, 말의 결을 찾는 사전.**

Typewriter is a Korean writer's dictionary for finding another word, expression,
image, mood, sensation, action, or association while keeping the texture of a
sentence in view.

The writer writes the sentence. Typewriter helps the writer find words; it does
not write or rewrite prose.

## Availability

- **Live demo:** There is no public demo yet. A link will be added here after a
  web release is approved and built from data cleared for redistribution.
- **Chrome extension:** The extension is a development prototype and has no
  Chrome Web Store listing. Its build and package contain dictionary data. The
  current canonical corpus and derived distributions remain held from
  redistribution pending record-level rights clearance, so packages must not be
  released or shared yet.
- **Repository:** This project is being prepared for public use. Repository
  visibility and product releases are separate decisions.

## Product philosophy

A conventional dictionary explains a word. A thesaurus lists similar words.
Typewriter helps a writer explore what they might want to find next.

A result should tell the writer what kind of relationship it represents:

- **direct** — can replace the source in a relevant sense
- **near** — close in meaning, but not fully interchangeable
- **mood** — shares emotional or tonal color
- **scene** — evokes a related situation
- **sensory** — shares a sensory image
- **action** — an action associated with the source's mood or situation
- **association** — a broader, writer-useful connection

These are working categories. They can change as real records and writing use
show where distinctions help.

## How it works

Canonical data is kept separate from the browser application and its generated
database:

    reference material and drafts
                  ↓
    normalization, validation, and editorial review
                  ↓
    canonical JSONL
                  ↓
    deterministic SQLite build
                  ↓
    browser runtime

Canonical JSONL is the source of truth. SQLite is generated from it. Runtime
lookup is local and does not depend on an external dictionary or AI service.

### Lexical data and evidence

Lexical additions go through shared production, admission, and validation rules.
Editorial decisions and evidence make those choices reviewable and help reproduce
validation. Evidence files do not grant permission to redistribute the lexical
content they describe.

External dictionaries, APIs, corpora, and model output may inform research only
when their terms allow it. Raw source text and unreviewed drafts do not belong in
canonical data.

See the [editorial model](docs/editorial-model.md), [lexical quality pipeline](docs/lexical-quality-pipeline.md),
[data policy](docs/data-policy.md), and [repository structure](docs/repository-structure.md).

## Development

Requirements: Node.js 22.13 or newer and npm. From a clean clone:

    npm ci --ignore-scripts --no-audit --no-fund
    npm run ci:normal
    npm test
    npm run build
    TYPEWRITER_ZIP_DIR=/tmp/typewriter-package npm run package

The normal CI command runs repository validation and its fast checkpoint. The
test command runs the Node test suite and batch contract checks. The build creates
the extension files in dist/. The package command creates and validates an
extension ZIP.

Build and package commands are useful for local engineering checks, but the
resulting files contain the current held dictionary corpus. Do not publish,
attach, or distribute them until its rights clearance and the applicable release
gates are complete.

For focused development, Chrome checks, and clean-checkout details, see
[Development](docs/development.md) and [Build and reproducibility](docs/build.md).

## Licenses and reuse

Typewriter uses separate terms for software, documentation, data, and brand
assets:

- Original software and configuration: [Apache License 2.0](Apache-2.0.txt),
  with scope described in [LICENSE.md](LICENSE.md).
- Original documentation: [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/),
  with scope described in [LICENSE.md](LICENSE.md).
- Dictionary data: CC BY 4.0 applies only to records with established
  redistribution rights. The current canonical corpus and data-bearing artifacts
  remain on hold; see [Data License](DATA-LICENSE.md).
- Typewriter and Never Work Alone names, logos, and visual identity: all rights
  reserved; see [Brand policy](BRAND.md).
- Third-party components retain their own licenses; see
  [Third-party notices](THIRD-PARTY-NOTICES.txt).

A file being present in Git, build output, or a package does not mean its content
is cleared for reuse. The [license overview](LICENSE.md) describes the file
boundaries and exclusions.

## Contributing

Code and documentation contributions should follow
[CONTRIBUTING.md](CONTRIBUTING.md), [AGENTS.md](AGENTS.md), and [REVIEW.md](REVIEW.md).
To suggest a lexical correction or report a data concern, use the
[dictionary data correction form](https://github.com/neverworkalone/typewriter/issues/new?template=dictionary-data-correction.yml).
Please describe the issue in your own words and link to references; do not paste
dictionary definitions, examples, or other restricted source text.

## Security

Please report vulnerabilities privately. See [SECURITY.md](SECURITY.md) for the
reporting path.
