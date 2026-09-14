# Toolchain Review

Use for validators, import/normalization scripts, canonical builds, SQLite,
generated artifacts, and CI.

Check:

- canonical source remains authoritative;
- generated output comes only from canonical/build inputs;
- generated artifacts are not hand-edited;
- canonical → generated data remains faithful;
- required builds are logically deterministic;
- required schema/index/metadata behavior is preserved.

Mechanical checks belong in scripts/CI, including schema validity, references,
duplicates, invalid relations, generated-data fidelity, DB structure, and
package contents.

When a validator, fixture, expected result, or CI workflow changes, verify that
the check itself is still valid.

Validator changes must include evidence that known-invalid input fails and
valid input passes.

Otherwise, a passing deterministic check is sufficient evidence for the
property it covers.

For lexical validators and regression tests:

- prefer repository-wide invariants over batch-, record-, or word-specific
  checks;
- verify that general rules run against all applicable existing canonical data;
- verify that future lexical additions reach the same rule through the common
  validation/admission path;
- allow batch-specific checks only for genuinely batch-specific constraints;
- reject fixtures that merely memorize affected canonical records when a small
  synthetic fixture can prove the general rule.
