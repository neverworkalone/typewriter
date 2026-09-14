# Shared lexical-quality admission pipeline

Typewriter admits words through one dictionary-wide quality boundary. A batch
identifier only describes scope and arithmetic; it does not select a different
quality policy.

```text
candidate intake
  -> candidate lemma/POS/expression shape
  -> reviewed sense boundary and relation evidence
  -> deterministic quality selection
  -> shared admission validator
  -> complete prospective canonical audit
  -> canonical JSONL -> SQLite/search/package validation
```

The shared implementation is:

- `scripts/validate/lexical-quality.mjs` — lexical invariants, writer-domain
  sense-boundary observations, placeholder detection, and the complete-canonical
  audit report;
- `scripts/batch/lexical-admission.mjs` — the batch-neutral producer/admission
  boundary that validates candidate bodies, reviewed canonical bodies, and the
  complete prospective dataset;
- `scripts/validate/dataset-integrity.mjs` — invokes the lexical audit for every
  canonical validation, including `npm run validate` and CI.

M5-11 adds its 550-row scope, +500 arithmetic, reserve, source digests, timing,
and authorization rules around this boundary. Older and future reviewed import
paths must call the same admission module or the dataset validator; they may not
reimplement a separate semantic gate.

The conjunction policy is intentionally semantic rather than an ID allowlist.
Same-domain and narrowly justified common-domain coordination is recorded as a
non-blocking observation. A conjunction that joins distinct writer domains, such
as taste and mood, remains a blocker until the sense is split or the gloss is
rewritten. The complete current canonical dataset is audited on every run, and
the prospective canonical dataset is audited before any canonical, inventory, or
seed mutation.
