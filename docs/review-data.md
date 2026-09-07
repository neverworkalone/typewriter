# Typewriter — Data Review Guide

Use this guide when a PR changes canonical dictionary data, lexical/editorial
schema, senses, relations, or writer-facing editorial classification.

Do not use this guide for unrelated application or build changes.

## Review goal

Review dictionary data as product behavior, not merely as structured text.

The standard is not academic exhaustiveness.

The standard is a useful and honest Typewriter result for a writer.

## Canonical boundary

Canonical dictionary data is the editable source of truth.

Generated SQLite or other derived output must not become the primary editable
source.

When the PR changes canonical or generated data, verify that the source-of-
truth boundary remains intact.

Mechanical fidelity between canonical data and generated output should be
validated by automated tooling where available rather than by manually
scanning the full dataset.

## Editorial review

Inspect the changed editorial decisions where applicable.

Check whether:

- the relation type matches the writer-facing meaning;
- a `direct` relation is genuinely substitutable in the relevant sense;
- a `near` relation is close without being presented as equivalent;
- `mood`, `scene`, `sensory`, `action`, and `association` relations are useful
  without misleading the writer about equivalence;
- sense distinctions are justified by actual usage;
- grouping or ranking helps the writer find useful alternatives;
- noisy or overly distant relations crowd out more useful results;
- generated draft or confidence metadata is not being treated as editorial
  truth.

Consult [`domain-model.md`](domain-model.md) when the change affects the
current domain model or writer-facing projection.

Do not reproduce its rules here.

## Integrity validation

Schema correctness, reference integrity, duplicate detection, self-reference,
missing targets, invalid relation types, and equivalent mechanical checks
should be performed by validators and CI.

When the corresponding deterministic checks pass on the exact reviewed head,
do not manually rescan the full canonical dataset for the same property.

For large data changes, inspect only the human editorial decisions, changed
generation logic if applicable, and representative samples needed to assess
semantic quality.

## Scale

Do not block a PR because a hypothetical future dataset might require a more
general ontology.

Do block a change when it prematurely scales an editorial assumption that has
not yet been validated for the active milestone.

When large-scale generation exposes an editorial or model defect, fix the
process or model rather than patching thousands of generated records by hand.

## Regression

When a concrete editorial or integrity defect is found and can be represented
as a stable automated case, add it to the appropriate validation or regression
set.

Prefer one generalized invariant plus a small number of representative cases
over accumulating many redundant examples of the same root cause.
