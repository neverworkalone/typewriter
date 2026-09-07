# Typewriter — Toolchain and CI Review Guide

Use this guide when a PR changes validators, import/normalization scripts,
canonical build tooling, SQLite generation, generated artifacts, or CI
validation.

## Review goal

The toolchain should turn canonical source data into reproducible, faithful,
validated generated output.

Mechanical properties should be proven by scripts and CI rather than repeated
manual inspection.

## Canonical → generated boundary

Verify that:

- canonical source remains the editable source of truth;
- generated SQLite and other derived artifacts are produced from canonical
  input;
- generated output is not hand-edited to make a test pass;
- the build does not silently lose or alter canonical information;
- required metadata and source revision remain traceable where applicable.

## Validation responsibilities

Automate properties that can be deterministically checked.

Examples include:

- JSON/JSONL schema validity;
- duplicate IDs or records;
- dangling references;
- self-reference;
- invalid relation types;
- missing lemma or sense targets;
- contradictory mechanical metadata;
- canonical/generated count or content fidelity;
- deterministic logical SQLite output;
- database schema and index expectations;
- metadata/version checks;
- representative lookup regressions;
- package inclusion checks;
- prohibited raw-data or generated-boundary violations.

Do not require the reviewer to manually inspect thousands of records when a
deterministic validator can prove the same property more accurately.

## Trusting CI

A passing deterministic check on the exact reviewed PR head is sufficient
evidence for the property that check is designed to validate.

Do not inspect successful raw logs merely to repeat that validation.

Inspect deeper when:

- the validator itself changed;
- the test fixture or expected result changed;
- the CI workflow was weakened, removed, skipped, or made conditional;
- the result contradicts representative behavior;
- the check does not actually cover the claimed property.

## Reviewing validators

When the PR changes a validator, review both sides:

1. the validation implementation; and
2. tests proving that the validator rejects known-invalid input and accepts
   valid input.

A validator passing its own CI is not sufficient evidence that the validator
is correct.

Prefer small fixtures that demonstrate the intended invariant.

## Deterministic builds

When reproducibility is required by the active milestone, verify through
automated comparison that identical canonical input and relevant build inputs
produce identical logical output.

Do not require byte-for-byte identity when the product contract only requires
logical database equivalence unless another source of truth explicitly
requires byte identity.

## Regression principle

When manual review repeatedly finds the same deterministic class of defect,
promote that class into a validator or regression test.

The goal is for CI to permanently absorb mechanical review work once the rule
is known.

## CI failure

A failing required CI check is a blocker.

Review the failure summary first.

Inspect full logs only as needed to understand the failure or determine whether
the check itself is wrong.
