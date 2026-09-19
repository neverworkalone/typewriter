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
- `scripts/validate/sense-boundary.mjs` — the common mechanical duplicate,
  nested-gloss, high-confidence usage-frame, and paraphrase-overlap inspection
  used by both the complete audit and every live semantic review. Authored
  `distinct`/`retain` decisions cannot override a mechanical blocker;
- `scripts/batch/lexical-admission.mjs` — the batch-neutral producer/admission
  boundary that validates candidate bodies, reviewed canonical bodies, and the
  complete prospective dataset;
- `scripts/batch/lexical-production.mjs` — the batch-neutral candidate intake,
  source-bound semantic review, selection, and admission orchestration;
- `scripts/validate/semantic-audit.mjs` — the v3 contract that keeps
  deterministic content coverage separate from explicitly authored semantic
  decisions. `buildSemanticCoverageArtifact()` may collect facts, but it never
  creates pass/boundary/relation decisions. The current audit envelope is
  rebuilt in memory from the canonical dataset and the authored decision source;
- `data/validation/canonical-semantic-decision-source.json` — the separately
  authored source consumed by the rebuild step; it binds the review decisions by
  source ID and digest, so canonical facts alone cannot manufacture a pass;
- `data/validation/canonical-semantic-boundary-decisions.json` — the durable
  correction/review input for explicit lexical boundary decisions;
- historical `data/validation/m5-*-semantic-audit.json` envelopes — durable
  replay evidence for immutable historical canonical snapshots;
- `scripts/validate/rebuild-semantic-evidence.mjs` — rebuilds deterministic
  coverage from that decision source only and fails when the authored source is
  missing or replaced by a legacy/replay review;
- `scripts/validate/apply-semantic-corrections.mjs` — consumes a separately
  authored correction manifest, validates explicit boundary/POS/expression/
  relation decisions, and rebuilds the complete audit without manufacturing
  semantic pass rationales;
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
boundary while keeping replay deterministic. Current coverage, review, audit,
and target-inventory files are deterministic projections and are not tracked;
`config/artifact-policy.json` and `scripts/validate/artifact-policy.mjs`
enforce that boundary. Replay is an explicit historical verification mode;
generic and future admissions must use a live
`lexical-production` run with typed stage payloads. A live stage envelope
preserves the exact typed input, output, and operation details. Generic batch
validation extracts those values, executes a fresh shared producer run through
all six transitions, and compares the new outputs and transition state with the
persisted run. A state assembled by `produceLexicalProductionState()` is
therefore accepted only through the named historical validator; it cannot be
used as an active/future admission shortcut.

M5-11 adds its 550-row scope, +500 arithmetic, reserve, source digests, timing,
and authorization rules around this boundary. Every registration must provide
the complete current base, the complete prospective canonical dataset, and the
matching authored decision source; validation rebuilds the deterministic audit
bytes from those inputs. A batch delta or a validator call that regenerates its
own decisions is not admissible. New candidate-producing
workflows must also call `lexical-production` with complete candidate coverage,
source-bound semantic review rows, and selection evidence.
Batch modules may configure counts and IDs, but may not replace these shared
stages with a batch-specific quality gate.

The common lexical-quality audit also rejects structurally malformed two-token
topic fragments (while preserving productive Korean adnominal forms such as
`달리는 사람` and `작은 사람`) and mechanical sense pairs in every existing
canonical record and every future prospective canonical dataset. Historical
bad-string examples remain regression inputs rather than a production
allowlist. For a post-admission correction,
the correction manifest is an input artifact rather than a generated verdict;
its authored decision rows are digest-bound before the canonical audit and
derived M5 evidence are refreshed.

The conjunction policy is intentionally semantic rather than an ID allowlist.
Same-domain and narrowly justified common-domain coordination is recorded as a
non-blocking observation. A conjunction that joins distinct writer domains, such
as taste and mood, remains a blocker until the sense is split or the gloss is
rewritten. Semantic evidence also derives writer-domain axes without relying on
conjunction spelling, so `과/와` and connector-free merged glosses cannot bypass
the boundary check. The complete current canonical dataset is audited on every
run, and the prospective canonical dataset is audited before any canonical,
inventory, or seed mutation.
