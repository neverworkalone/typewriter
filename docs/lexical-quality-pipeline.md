# Shared lexical-quality admission pipeline

Typewriter admits words through one dictionary-wide quality boundary. A batch
identifier only describes scope and arithmetic; it does not select a different
quality policy.

```text
candidate intake
  -> candidate lemma/POS/expression shape
  -> reviewed sense boundary and relation evidence
  -> deterministic quality selection
  -> separately authored semantic decisions + deterministic coverage
  -> shared admission validator
  -> source-bound complete prospective audit
  -> canonical JSONL -> SQLite/search/package validation
```

The shared implementation is:

- `scripts/validate/lexical-quality.mjs` — lexical invariants, writer-domain
  sense-boundary observations, placeholder detection, and the complete-canonical
  audit report;
- `scripts/batch/lexical-admission.mjs` — the batch-neutral producer/admission
  boundary that validates candidate bodies, reviewed canonical bodies, and the
  complete prospective dataset;
- `scripts/batch/lexical-production.mjs` — the batch-neutral candidate intake,
  source-bound semantic review, selection, and admission orchestration;
- `scripts/validate/semantic-audit.mjs` — the v2 contract that keeps
  deterministic content coverage separate from explicitly authored semantic
  decisions. `buildSemanticCoverageArtifact()` may collect facts, but it never
  creates pass/boundary/relation decisions;
- `data/validation/canonical-semantic-review.json` — the separately authored
  complete decision artifact;
- `data/validation/canonical-semantic-decision-source.json` — the separately
  authored source consumed by the rebuild step; it binds the review artifact by
  source ID and digest, so canonical facts alone cannot manufacture a pass;
- `data/validation/canonical-semantic-coverage.json` — deterministic facts and
  digests derived from canonical values;
- `data/validation/canonical-semantic-audit.json` — the validated envelope that
  binds both artifacts to one canonical snapshot;
- `scripts/validate/rebuild-semantic-evidence.mjs` — rebuilds deterministic
  coverage from that decision source only and fails when the authored source is
  missing or replaced by a legacy/replay review;
- `scripts/validate/dataset-integrity.mjs` — invokes the lexical audit for every
  canonical validation, including `npm run validate` and CI.

Historical replay uses the same contract at each immutable canonical boundary.
The scoped envelopes [`data/validation/m5-10a-wave-a2-semantic-audit.json`](../data/validation/m5-10a-wave-a2-semantic-audit.json)
and [`data/validation/m5-10-wave-b-semantic-audit.json`](../data/validation/m5-10-wave-b-semantic-audit.json)
cover the complete A2 and Wave B prospective snapshots respectively. Their
separately authored review rows are retained as scoped durable evidence; each
historical manifest binds the exact envelope bytes by `review.semantic_audit_sha256`.
CI copies these committed sources to its external runner staging directory and
passes them through the A2/Wave B CLI, preserving the repository-local staging
boundary while keeping replay deterministic. Replay is an explicit historical
verification mode; generic and future admissions must use a live
`lexical-production` run with typed stage payloads.

M5-11 adds its 550-row scope, +500 arithmetic, reserve, source digests, timing,
and authorization rules around this boundary. Every registration must provide
the complete current base, the complete prospective canonical dataset, and a
pre-written matching semantic-audit envelope; a batch delta or a validator call
that regenerates its own decisions is not admissible. New candidate-producing
workflows must also call `lexical-production` with complete candidate coverage,
source-bound semantic review rows, and selection evidence.
Batch modules may configure counts and IDs, but may not replace these shared
stages with a batch-specific quality gate.

The conjunction policy is intentionally semantic rather than an ID allowlist.
Same-domain and narrowly justified common-domain coordination is recorded as a
non-blocking observation. A conjunction that joins distinct writer domains, such
as taste and mood, remains a blocker until the sense is split or the gloss is
rewritten. Semantic evidence also derives writer-domain axes without relying on
conjunction spelling, so `과/와` and connector-free merged glosses cannot bypass
the boundary check. The complete current canonical dataset is audited on every
run, and the prospective canonical dataset is audited before any canonical,
inventory, or seed mutation.
