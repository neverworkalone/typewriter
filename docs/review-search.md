# Typewriter — Search Review Guide

Use this guide when a PR changes search normalization, candidate generation,
ranking, ordering, homonym/sense behavior, or search regression behavior.

## Review goal

Search should help a writer who is already in the middle of writing find the
intended word, nearby alternative, or related expression quickly and
predictably.

Review the demonstrated writer workflow, not an imagined universal Korean
search system.

## Applicable sources of truth

When relevant, consult:

- [`search-regressions.md`](search-regressions.md) for the supported search
  boundary and regression corpus;
- [`search-candidates.md`](search-candidates.md) for candidate tiers and tie
  rules;
- [`domain-model.md`](domain-model.md) for UI-independent search state and
  writer-facing projection.

Do not duplicate those documents here.

## Search correctness

Check as applicable:

- normalization preserves the intended query meaning;
- supported Korean input forms continue to resolve correctly;
- candidate generation includes the required current cases;
- candidate tiers remain semantically honest;
- ranking and tie behavior are deterministic where required;
- direct alternatives are not flattened together with wider associations;
- homonyms or multiple senses are not silently collapsed into the wrong
  result;
- search-state changes do not incorrectly create navigation/history behavior;
- the implementation solves the demonstrated query rather than only the
  literal fixture.

## Regression corpus

Existing supported search behavior should be protected by automated regression
tests.

When a new reproducible search defect is fixed and the behavior is stable
enough to script, add or update a representative regression case.

Prefer representative regressions that protect the underlying rule.

Do not add many redundant test cases merely because several words exhibited
the same root cause.

## Automated validation

When the exact PR head passes the relevant search regression suite, treat that
as evidence that the covered cases remain intact.

Do not manually replay the full regression corpus.

Reviewers should focus on:

- whether the new rule is correct;
- whether the regression set actually covers the reported defect;
- whether the implementation changes the intended search semantics;
- whether the approach introduces a new current failure outside what the tests
  model.

## Scope

Do not require generalized NLP infrastructure, embeddings, vector search, or
universal linguistic normalization unless the active issue demonstrates a
current need.
