# Typewriter

[![CI](https://github.com/neverworkalone/typewriter/actions/workflows/ci.yml/badge.svg)](https://github.com/neverworkalone/typewriter/actions/workflows/ci.yml)
[![Deep CI](https://github.com/neverworkalone/typewriter/actions/workflows/deep.yml/badge.svg)](https://github.com/neverworkalone/typewriter/actions/workflows/deep.yml)
[![GitHub Pages](https://github.com/neverworkalone/typewriter/actions/workflows/pages.yml/badge.svg)](https://github.com/neverworkalone/typewriter/actions/workflows/pages.yml)

> **작가를 위한, 말의 결을 찾는 사전.**

Typewriter is a Korean writer's dictionary for finding another word, expression,
image, mood, sensation, action, or association while keeping the texture of a
sentence in view.

The writer writes the sentence. Typewriter helps the writer find words; it does
not write or rewrite prose.

## Availability

- Install the extension from the [Chrome Web Store](https://chromewebstore.google.com/detail/typewriter/dpifnfihnakglmffddnhmefbllmnbbmk).
- **Live demo:** https://neverworkalone.net/typewriter/
- **Repository:** Public for owner-approved research and development. The owner
  has authorized distribution of Typewriter-authored dictionary output under the
  project data license and normal release checks; repository visibility does not
  expand that license to third-party content.

The Chrome Web Store listing above is the target identified in the NIKL
result-publication application. The owner confirmed on 2026-10-12 that NIKL
approved the application submitted on 2026-09-27 for the Typewriter result.
Together with the owner's release decision, this permits distribution of
the **independently authored result described in that application** under its
applicable data terms after ordinary release checks; it does not authorize
raw corpus text, passages, or local indexes. That corpus approval is separate
from the official STDICT copyright policy governing the planned new dictionary
baseline. See [Data License](DATA-LICENSE.md).

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

The Chrome extension searches its packaged dictionary on-device and stores only
saved settings in Chrome's local extension storage. It does not transmit searches
or keep search history. See the [extension privacy disclosure](PRIVACY.md).

### Lexical data and evidence

Lexical additions go through shared production, admission, and validation rules.
Editorial decisions and evidence make those choices reviewable and help reproduce
validation. Evidence files do not grant permission to redistribute the lexical
content they describe.

External dictionaries, APIs, corpora, and model output may inform research only
when their terms allow it. Raw source text and unreviewed drafts do not belong in
canonical data.

See the [editorial model](docs/editorial-model.md), [lexical quality pipeline](docs/lexical-quality-pipeline.md),
[lexical production factory design](docs/lexical-production-factory.md),
[data policy](docs/data-policy.md), [repository structure](docs/repository-structure.md),
and the [shared local reference cache](docs/local-reference-cache.md).
The independent [resumable corpus morphology runner](docs/corpus-morphology-slices.md)
stores verified analysis locally in 20 slices; its real corpus operation is tracked separately in #549.

## Development

Requirements: Node.js 24.19 or newer (Node 24 LTS) and pnpm 10.34.6 (pinned in
`package.json#packageManager`; activate it with `corepack enable` or
`npm install -g pnpm@10.34.6`). Use pnpm only: `pnpm-lock.yaml` is the sole
lockfile, and `package-lock.json` must not be regenerated. From a clean clone:

    pnpm install --frozen-lockfile --ignore-scripts
    pnpm test
    pnpm run build
    TYPEWRITER_ZIP_DIR=/tmp/typewriter-package pnpm run package

For a newly created Codex worktree that does not already have the required
dependencies, run this from the repository root. It uses only the prepared
machine-local store and creates an independent `node_modules` for this worktree:

    corepack pnpm install --offline --frozen-lockfile --ignore-scripts \
      --store-dir "$HOME/.cache/typewriter/pnpm-store"

Skip the install when the worktree already has its required dependencies; do not
symlink another worktree's `node_modules`. The shared store is already prepared
for the current lockfile. If a changed lockfile refers to missing artifacts,
report the specific cache miss. Only the owner or an explicitly authorized
one-time online frozen install may replenish the store. To prepare or refresh
the store, run this one-time command:

    corepack pnpm install --frozen-lockfile --ignore-scripts \
      --store-dir "$HOME/.cache/typewriter/pnpm-store"

Do not use that online command as the standard worktree setup path.

The default test command runs the normal CI gate, including repository
validation, regression and unit tests, product builds, and product output
contract checks. It is equivalent to `pnpm run ci:normal`. The build command creates
extension files in dist/, and the package command creates and validates an
extension ZIP. For the clean-checkout release candidate flow, install Chrome for
Testing and run `pnpm run validate:release`; see [Build and reproducibility](docs/build.md).

To build the separate GitHub Pages web candidate locally, run
`pnpm run build:web`. It writes `dist-web/` for the repository base path
`/typewriter/` and uses the same deterministic SQLite builder and browser runtime
as the extension. The output includes the product license texts and third-party
notices linked from the web product. It contains the current canonical corpus;
Typewriter-authored records may be distributed under the project data license
after the exact-revision and package-content checks in
[Data License](DATA-LICENSE.md) and [Build and reproducibility](docs/build.md).

The optional Chromium runtime check is for debugging web-page or runtime issues;
it is not part of `pnpm test` or CI. After building both products, install
Chromium once with `pnpm exec playwright install chromium`, then run
`pnpm run test:web:integration`.

Build and package commands perform engineering checks; the owner's release
decision permits independently authored Typewriter data to ship after the exact
revision, deterministic build, package-content, license/notice, and applicable
Store or Pages checks pass. Exclude raw corpus material and any specifically
identified copied or otherwise restricted third-party content. A per-record
clearance project and exhaustive historical-surface audit are not general release
prerequisites.

For focused development, Chrome checks, and clean-checkout details, see
[Development](docs/development.md) and [Build and reproducibility](docs/build.md).

## Licenses and reuse

Typewriter uses separate terms for software, documentation, data, and brand
assets:

- Original software and configuration: [Apache License 2.0](Apache-2.0.txt),
  with scope described in [LICENSE.md](LICENSE.md).
- Original documentation: [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/),
  with scope described in [LICENSE.md](LICENSE.md).
- **New STDICT-based dictionary data**, including Typewriter-authored
  **말의 결 / 연상** enrichment: [CC BY-SA 2.0 Korea](https://creativecommons.org/licenses/by-sa/2.0/kr/)
  under the scope described in [Data License](DATA-LICENSE.md). This is the
  planned replacement baseline, not a claim that it has already been imported.
  The original Typewriter code remains Apache 2.0.
- Typewriter and Never Work Alone names, logos, and visual identity: all rights
  reserved; see [Brand policy](BRAND.md).
- Third-party components retain their own licenses; see
  [Third-party notices](THIRD-PARTY-NOTICES.txt).
- **표준국어대사전 출처:** 국립국어원 『표준국어대사전』
  (https://stdict.korean.go.kr/), [저작권 정책](https://stdict.korean.go.kr/join/copyrightPolicy.do).
  새 Typewriter 사전은 표제어·뜻풀이·어휘 관계를 선별·정규화하고 자체
  말의 결·연상 관계를 추가할 예정입니다. 출처 및 변경 사실을 표시하며,
  해당 데이터에 CC BY-SA 2.0 대한민국을 적용합니다.
- **한국어기초사전 (향후 비교·보충 자료):** 국립국어원 『한국어기초사전』
  (https://krdict.korean.go.kr/), [공식 저작권 정책](https://krdict.korean.go.kr/kor/kboardPolicy/copyRightTermsInfo).
  별도 표시가 없는 자료의 라이선스는 [CC BY-SA 2.0 대한민국](https://creativecommons.org/licenses/by-sa/2.0/kr/)입니다.
  JSON은 확보했지만 아직 Typewriter canonical에 통합하지 않았습니다.
- **우리말샘 (향후 비교·보충 자료):** 국립국어원 『우리말샘』
  (https://opendict.korean.go.kr/), [공식 저작권 정책](https://opendict.korean.go.kr/service/copyrightPolicy).
  별도 표시가 없는 자료의 라이선스는 [CC BY-SA 2.0 대한민국](https://creativecommons.org/licenses/by-sa/2.0/kr/)입니다.
  JSON은 확보했지만 아직 Typewriter canonical에 통합하지 않았습니다.
  세 사전 모두 개별 저작권이 있는 용례·멀티미디어의 권리 조건을 별도로 확인해야 합니다.
- **말뭉치 참고 출처 (별도):** 국립국어원 문어 말뭉치 2025(1.0),
  국립국어원 모두의 말뭉치 (https://kli.korean.go.kr/corpus).
  원문과 로컬 인덱스는 배포하지 않습니다.

A file being present in Git, build output, or a package does not mean its content
is cleared for reuse. The [license overview](LICENSE.md) describes the file
boundaries and exclusions.
