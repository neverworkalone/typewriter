# M5-11 +500 admission report

Issue #97 is held before canonical admission.

## Current state

- Input canonical: **778 starts / 820 records**
- Candidate pool: **550 selected starts**
- Intended bounded import: **500 starts**
- Candidate buffer: **50 starts**
- Current canonical import: **0 rows**
- Canonical, seed, and inventory mutation: **none**

The candidate catalog is not an editorial decision artifact. The builder refuses
to manufacture sense, POS, boundary, relation, audit, or admission verdicts. A
separately supplied human-complete decision artifact and complete gate evidence
are required before an external reviewed import can be produced.

The tracked catalog contains only the 550 selection IDs, editorial axes, and
flags. It does not commit unreviewed lemma, POS, gloss, or proposed canonical
record bodies; those belong in the separately supplied external decision
artifact, which must match the catalog digest and count. Admission validation
also requires a complete observed-sense scope, at least one checked boundary,
non-vacuous sense-bound evidence, and no sense citations on `not-applicable`
boundaries. Before decisions are supplied, the editor must also provide a
separately frozen external proposal artifact: every decision binds its
candidate lemma and proposal-body digest to that artifact. The reserve count is
derived from the actual `held`/`rejected` rows, so later reserve rows may fill
the 500 admitted slots rather than forcing every unused row to be `deferred`.
Proposal records use candidate-local IDs; admission rebases those IDs to the
next deterministic canonical ID, so an earlier held/rejected row cannot alter
the frozen lexical body. Both the proposal and decision artifacts are external
inputs to the builder.
These checks apply to every candidate rather than a fixed lemma allowlist.

## Gate

`HOLD PROCESS` — editorial decision artifact, human editorial review, timing,
independent audit, and canonical promotion are incomplete. No later stage is
created or authorized.

Validation:

```sh
npm run batch:m5-11:check
```
