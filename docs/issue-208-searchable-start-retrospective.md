# Issue #208 — searchable-start policy and M1–M8 retrospective

Audit date: 2026-09-28

Audited source: `master` at `512fafaff857c81c80b68d603f79eeb0771cd4e2`

## Decision and scope

The current product invariant is:

> **Every valid lexical entry within Typewriter's supported lexical scope may
> serve as a searchable start.**

The policy is recorded in [`editorial-model.md`](editorial-model.md). This
retrospective identifies where the current M1–M8 contracts or implementations
still encode the older role/usefulness boundary and gives Task B the shared
system boundaries to change.

Issue #208 is policy and impact analysis only. It does not alter canonical data,
inventory seeds, candidate decisions, or generated SQLite, and it does not
recover the 25 Issue #204 candidates. Historical candidate recovery remains a
separate follow-up after the shared policy and runtime contract are corrected.

## Keep these decisions separate

| Decision | Question answered | It must not be replaced by |
| --- | --- | --- |
| Lexical validity | Is this a valid lexical unit with a resolved lemma/POS/sense identity and no unresolved duplicate or identity collision? | A usefulness score or relation count |
| Supported scope | Can the current canonical model represent this lexical category? | A judgment that an unrepresented category is low-value |
| Search eligibility | May a valid in-scope record be opened from direct exact search? | `start` versus `reference-only` history |
| Relation enrichment | Which sense-bound, directed relations are editorially justified? | Entry admission or relation-count quotas |
| Ranking/usefulness | Which returned option is most useful in a writer's task? | Lexical validity or search eligibility |

When validity or supported scope is unresolved, hold for the specific unresolved
reason. Generality, frequency, low standalone writer usefulness, low vividness,
and relation sparsity are not lexical rejection reasons.

## Supported lexical universe

The current canonical schema and validators support `entry` records with
`noun`, `adjective`, `verb`, or `adverb` senses, plus `expression` records whose
senses have POS `expression`. A fixed expression is therefore representable as
its own lexical unit. These are the supported categories for this policy; the
schema does not encode a general Korean POS inventory.

Pronouns, numerals, determiners, particles, and interjections are examples of
normal lexical categories that the current POS enum cannot represent. Their
searchable scope is unresolved and needs an explicit product decision before a
schema expansion. This audit does not broaden the schema. Categories that are
not separately encoded, such as proper nouns within `noun`, are not excluded by
the current model. The current direct lookup contract uses `lemma` and curated
`search_forms`; generated surface forms remain governed by their existing
bounded contract, and no general morphology policy is added here.

Current M1 and M8 start/reference totals describe snapshots, not a complete
statement of the supported lexical universe. `reference-only` describes the
historical relation-closure role and cannot be a permanent search veto for a
valid in-scope lexical entry.

## M1–M8 impact report

| Milestone | Impact | Current evidence and conflict | Task B boundary |
| --- | --- | --- | --- |
| M1 — Editorial model | `contract update` | [`editorial-model.md`](editorial-model.md) describes `reference-only` as a relation target not counted as a search start; [`pilot-scope.md`](pilot-scope.md) defines starts as selected from a fixed pilot list. Those describe historical scope but cannot continue as eligibility policy. | Keep old ledgers as history; put the current invariant and supported scope in the Editorial Model. |
| M2 — Schema, validator, SQLite | `implementation change` | [`canonical-record.schema.json`](../schema/canonical-record.schema.json) encodes `role`; `dataset-integrity.mjs` and `lexical-quality.mjs` bind `start` to `w…` IDs and `candidate_id`, while pure `reference-only` records follow a separate identity path. SQLite stores the role. This makes search eligibility and identity bookkeeping depend on role. | Revisit role/identity constraints in the canonical schema, shared canonical and prospective admission validators, inventory validator, and SQLite representation. Preserve lexical identity, duplicate, sense, and reference integrity checks. |
| M3 — Runtime | `implementation change` | [`sqlite-query.js`](../src/runtime/sqlite-query.js) filters lemma, search-form, and generated-surface queries to `role = 'start'`; it separately probes for a reference-only hit. [`search-query.js`](../src/runtime/search-query.js), [`search-session.js`](../src/domain/search-session.js), and [`projection.js`](../src/domain/projection.js) convert that role into an unsupported result or remove the record. Active prose contracts in [`build.md`](build.md), [`domain-model.md`](domain-model.md), and [`search-candidates.md`](search-candidates.md) also describe role-based eligibility. [`m3-handoff.md`](m3-handoff.md) records the historical M3 rule. | Remove the role-based gate across SQLite query, response normalization, session materialization, and result projection. Update active runtime/search docs; retain dated M3 handoff as historical evidence and mark it superseded by the current Editorial Model. Preserve local/offline lookup and relation navigation. |
| M4 — Search contract | `implementation change` | [`m4-handoff.md`](m4-handoff.md) and [`search-regressions.md`](search-regressions.md) protect reference-only blocking. [`runtime-query-adapter.test.mjs`](../tests/runtime-query-adapter.test.mjs) expects both lemma and search-form queries for a `reference-only` row to return `reference-only-not-searchable` on native and WASM SQLite, and asserts the dedicated probe's query plan. The M4 fixture also has `m3-reference-only-free-search-blocked`. [`DictionaryResult.vue`](../src/components/DictionaryResult.vue) shows the relation-empty disclosure only for `role === 'start'`; the Web surface uses the same `DictionaryPanel`. | Replace the block expectations with role-independent lemma/search-form reachability on native and WASM SQLite; retire or revise the reference-only probe/query-plan assertion. Update active search contracts and mark the dated M4 handoff as superseded by the current Editorial Model. Make relation-empty disclosure depend on relation state, not historical role, and preserve no-data, input normalization, collision, sense, and result-precedence boundaries. |
| M5 — Selection and admission | `implementation change` | [`m5-target-inventory.md`](m5-target-inventory.md) frames candidate selection around writer-facing axes and requires selection reason codes for planned starts. The shared producer intake requires authored `writer_use`, `writer_gloss`, and an axis. The actual shared eligibility boundary is [`authored-semantic-decision-source.mjs`](../scripts/batch/authored-semantic-decision-source.mjs): it binds `gloss_judgment` to `included`/`corrected` (`fit`), `held` (`needs-context`), or `rejected` (`reject`), then passes `fit` to the selector. [`lexical-selection.mjs`](../scripts/batch/lexical-selection.mjs) owns bounded capacity and ordering among eligible rows. | Define `fit` and hold/reject evidence in terms of lexical and structural validity, not axis, generality, standalone usefulness, texture, or relation availability. Keep capacity, audit, timing, provenance, and relation-quality gates separate. Do not alter historical dispositions in this task. |
| M6 — Quality gates | `implementation change` | M6 already reports relation correctness, relation gaps, search reachability, ranking, and writer-task usefulness separately. However, reachability covers start lemmas/forms and requires zero reference-only leaks. The [`m6-2-inflection-search-contract.md`](m6-2-inflection-search-contract.md) also limits generated surface forms and exact/generated collision candidates to `role: start`; [`surface-form-projection.mjs`](../scripts/inflection/surface-form-projection.mjs) rejects non-start exception/review targets and excludes those records from the supported surface-form and exact-collision projections. | Measure lexical reachability independently of role while preserving relation and writer-outcome dimensions. Extend only the existing bounded M6-2 surface-form classes to valid in-scope predicates regardless of historical role; review exact/generated collisions over the same supported lexical population. Keep the morphology whitelist and its sense-bound evidence. |
| M7 — Scale and release hardening | `implementation change` | The scale benchmark documents a dedicated indexed reference-only probe as a prior 500K query blocker fix. The exact-query predicates and the synthetic role mix therefore include the old eligibility rule. | Recheck the affected lookup query plan and latency after Task B changes the query path. Re-run scale/package evidence only if the runtime or index representation changes materially; leave unrelated synthetic-scale and release gates intact. |
| M8 — Release/product language | `no impact` | The M8 handoff records exact release-candidate counts, package hashes, measured readiness, and the existing redistribution hold. It does not establish a rule that only vivid or individually useful words may be admitted. The role counts are historical candidate-snapshot metadata. | Preserve package, provenance, performance, and publication gates. Future product copy or counts must not describe the role split as lexical eligibility. |

## Shared boundaries for Task B

Task B should make the behavior change once across the shared producer, validator,
database query, and domain projection layers. The identified surfaces are:

1. **Canonical identity and admission:**
   [`canonical-record.schema.json`](../schema/canonical-record.schema.json),
   [`dataset-integrity.mjs`](../scripts/validate/dataset-integrity.mjs),
   [`lexical-quality.mjs`](../scripts/validate/lexical-quality.mjs),
   [`lexical-admission.mjs`](../scripts/batch/lexical-admission.mjs), and
   [`target-inventory.mjs`](../scripts/validate/target-inventory.mjs). Reconcile
   role, ID-prefix, and `candidate_id` rules with the new separation of lexical
   identity from search eligibility.
2. **SQLite and exact-search runtime:**
   [`build.md`](build.md), [`domain-model.md`](domain-model.md),
   [`search-candidates.md`](search-candidates.md),
   [`scripts/build/query.mjs`](../scripts/build/query.mjs),
   [`sqlite-schema.mjs`](../scripts/build/sqlite-schema.mjs),
   [`sqlite-query.js`](../src/runtime/sqlite-query.js),
   [`search-query.js`](../src/runtime/search-query.js),
   [`search-session.js`](../src/domain/search-session.js), and
   [`projection.js`](../src/domain/projection.js). Search valid in-scope entries
   by lemma/search form regardless of their historical relation-closure role.
3. **Search regressions and product contract:**
   [`m4-handoff.md`](m4-handoff.md),
   [`search-regressions.md`](search-regressions.md),
   [`m4-baseline.json`](../tests/fixtures/search-regressions/m4-baseline.json),
   [`search-regressions.mjs`](../scripts/validate/search-regressions.mjs), and
   [`search-regressions.test.mjs`](../tests/search-regressions.test.mjs),
   [`runtime-query-adapter.test.mjs`](../tests/runtime-query-adapter.test.mjs).
   Include [`DictionaryResult.vue`](../src/components/DictionaryResult.vue),
   which is consumed by the Extension and the shared [`DictionaryPanel.vue`](../src/components/DictionaryPanel.vue)
   used in [`web/src/App.vue`](../web/src/App.vue), plus
   [`product-shell.test.js`](../tests/product-shell.test.js). Replace the
   reference-only block regression with generalized role-independent
   reachability coverage. Make zero-relation disclosure role-independent in
   both product surfaces. Preserve exact lemma/search-form/generated-form
   precedence, deterministic ordering, collision handling, and relation-target
   navigation.
4. **Future batch intake:**
   [`lexical-production.mjs`](../scripts/batch/lexical-production.mjs),
   [`authored-semantic-decision-source.mjs`](../scripts/batch/authored-semantic-decision-source.mjs),
   [`lexical-selection.mjs`](../scripts/batch/lexical-selection.mjs),
   [`semantic-audit-decision-source.test.mjs`](../tests/semantic-audit-decision-source.test.mjs),
   [`lexical-selection.test.mjs`](../tests/lexical-selection.test.mjs),
   [`m5-target-inventory.md`](m5-target-inventory.md), and
   [`m5-expansion-gate.md`](m5-expansion-gate.md). Keep source binding and
   bounded capacity separate from lexical eligibility. Define the shared
   `gloss_judgment` gate so a common/general candidate with no relations remains
   eligible when its lexical identity and structure are valid. Capacity may
   defer an eligible row without changing its lexical disposition.
5. **Bounded generated-surface forms:**
   [`surface-form-projection.mjs`](../scripts/inflection/surface-form-projection.mjs),
   [`surface-form-projection.mjs` validator](../scripts/validate/surface-form-projection.mjs),
   [`m6-2-inflection-search-contract.md`](m6-2-inflection-search-contract.md),
   [`m6-2-inflection-exceptions.json`](../data/validation/m6-2-inflection-exceptions.json),
   [`m6-3-surface-form-review.json`](../data/validation/m6-3-surface-form-review.json),
   [`m6-2-inflection-contract.test.mjs`](../tests/m6-2-inflection-contract.test.mjs),
   [`surface-form-projection.test.mjs`](../tests/surface-form-projection.test.mjs),
   and [`m6-2-inflection-contract.json`](../tests/fixtures/search-regressions/m6-2-inflection-contract.json).
   Include every valid in-scope predicate in the existing supported-form and
   exact/generated collision projection regardless of historical role. Remove
   role-only rejection of exception/review targets. Keep the existing POS,
   citation-form, single-token, rule-class, exception, review, and collision
   evidence constraints; this work does not authorize broader morphology.
6. **Coverage and scale evidence:**
   [`m6-1-quality-baseline.mjs`](../scripts/validate/m6-1-quality-baseline.mjs),
   [`m6-1-quality-baseline.md`](m6-1-quality-baseline.md),
   [`m6-4-quality-audit.mjs`](../scripts/validate/m6-4-quality-audit.mjs),
   [`m7-1-scale-benchmark.md`](m7-1-scale-benchmark.md), and the affected
   query-plan/scale regressions. Keep relation quality and writer usefulness
   out of the lexical-reachability denominator.

The smallest system regression set for Task B must demonstrate that a valid
ordinary entry—including one with no relations—can pass admission and direct
search regardless of role; that a valid former reference-only predicate
resolves by lemma and curated search form identically on native and WASM SQLite;
and resolves through an already supported generated form. Relation-target
navigation must remain available. Invalid identity, true duplicates,
unresolved sense boundaries, and collisions still fail or hold.
Exact/search-form/generated-form precedence and deterministic collision review
must remain intact, and a zero-relation result must show the same disclosure in
Extension and Web. The native/WASM regression must stop requiring the dedicated
reference-only probe. These are general rules, not word-specific exceptions for
`사람`, `없다`, or the Issue #204 seed list.

## Retrospective disposition

The current conflict is systemic: policy language, role/identity validation,
exact-search SQL, result filtering, the M4 fixture, M5 candidate planning, and
M6 reachability denominators all preserve the older start/reference-only split.
Task B must update those shared boundaries before any bounded recovery. No
historical candidate row is reclassified by this report.

## Completion note

This retrospective records the pre-implementation boundary. Issue #209
implemented Task B across shared lexical admission, canonical validation,
search, and Extension/Web disclosure. Issues #210 and #211 then audited the
historical inventory and completed the bounded re-review of Issue #204; Issue
#212 records the final current-state coverage and the handoff contract. The
original impact table and counts above remain historical evidence, not current
eligibility rules. See the [Issue #212 final coverage audit](issue-212-final-coverage-handoff.md).
