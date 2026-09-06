# M4 search regression corpus

`tests/fixtures/search-regressions/m4-baseline.json` is the shared, writer-facing
search corpus for M4 (schema version 2). It records a query, the expected policy,
the currently observed result, any selected record, and the problem
classification. It does not store an original writing sentence, external
dictionary text, or an invented lexical answer.

## Scope contract

The corpus separates the following cases:

| `input_class` | Meaning | M4 acceptance status |
| --- | --- | --- |
| `exact-lemma` | The query is a canonical lemma for a `start` record. | Baseline-supported. |
| `exact-search-form` | The query is an explicitly curated `search_forms` value. | Baseline-supported. |
| `normalization-candidate` | A narrow Unicode or surrounding-whitespace rule is approved and recorded. | Baseline-supported only for NFC and surrounding trim. |
| `no-data` | No canonical start record is asserted for the query. | Return a structured no-match; do not invent an answer. |
| `unsupported` | The current policy intentionally does not interpret the input. | Show the policy boundary, not a guessed match. |
| `editorial-gap` | A record exists, but relation or editorial coverage is not established. | `pending`; do not manufacture a relation. |

`evaluation` is `baseline` when the current exact contract is reproducible and
`pending` when the case needs evidence or a later policy decision. The editorial
gap remains pending; the two narrow normalization rules are now baseline cases.

The current M3/M4 boundary is deliberately narrow:

- Exact lemma and exact `search_forms` are supported.
- `reference-only` records can be opened through an explicit relation target, but
  are never free-search starts.
- Expressions are matched as their exact canonical phrase. Tokenization and
  expression rewriting are not implied.
- Unicode NFC canonical equivalence and trimming surrounding whitespace are the
  only approved normalization rules. The raw query, normalized key, applied
  rules, and match provenance are returned together.
- Internal whitespace rewriting, inflection handling, fuzzy search, prefix search,
  and general Korean morphology are outside the current policy.
- A missing relation is an editorial question. The corpus can record that gap but
  cannot supply a target without Typewriter editorial evidence.

These rules preserve the existing Editorial Model v1 relation types. A `direct`
relation is not promoted above `near`, `mood`, or association relations by the
fixture itself, and an `antonym` remains an antonym.

## Fixture shape

Each case has this shape:

```json
{
  "id": "stable-case-id",
  "query": "검색어",
  "input_class": "exact-lemma",
  "evaluation": "baseline",
  "expected": {
    "status": "ready",
    "result_ids": ["w026"],
    "selected_record_id": null
  },
  "actual": {
    "status": "ready",
    "result_ids": ["w026"],
    "selected_record_id": null,
    "raw_query": "  담담하다  ",
    "normalized_query": "담담하다",
    "normalization_rules": ["trim-surrounding-whitespace"],
    "reason": null,
    "matches": [{
      "record_id": "w026",
      "kind": "normalized",
      "field": "lemma",
      "value": "담담하다",
      "normalization_rules": ["trim-surrounding-whitespace"]
    }]
  },
  "selection": null,
  "assertions": [],
  "problem": "none",
  "policy": "왜 이 사례를 이 범주로 두었는지에 대한 짧은 정책 기록"
}
```

`expected.status` is one of `ready`, `no-match`, `unsupported`, or `pending`.
`actual.status` records the current query surface as `ready`, `no-match`,
`unsupported`, or `error`. `result_ids` preserve the observed order; they are
not a ranking score. When present, `raw_query`, `normalized_query`,
`normalization_rules`, `reason`, and `matches` assert the structured query
response. A match records whether the hit came from an exact lemma, exact search
form, or an approved normalization path.
`selection` is optional and is used for a chosen record or an explicit relation
target. `assertions` may preserve the required record/sense/relation boundary for
the query, without copying definitions or source prose.

The validator uses a strict allowlist for the corpus, case, observation, selection,
and assertion objects. It rejects unknown fields, duplicate case/query combinations,
contradictory result membership, duplicate IDs, invalid status/category combinations,
and source/example text fields such as `source_text`, `source_sentence`, or
`example_sentence`.

## Adding a case

1. Add the smallest query that demonstrates the writer-facing behavior. Store the
   query only; do not add the original sentence or external source text.
2. Choose one `input_class` and its matching `problem` value. Use `pending` when
   there is no demonstrated policy or editorial evidence; do not add a new
   normalization rule without an explicit narrow contract.
3. Record both `expected` and the current `actual` result. Never create a result ID
   to make an unsupported or editorial-gap case pass.
4. Add only the record, sense, relation, or selection assertions needed to preserve
   the existing contract. Keep relation type and direction explicit.
5. Run the fixture validator and the shared Node/Vitest regression tests. If the
   case changes the supported input policy, update the policy document and the
   relevant follow-up issue rather than changing the canonical data in this step.

The corpus is intentionally reusable: Node tests compare it with the canonical
SQLite query helpers, while Vitest's browser query-adapter contract forwards the
same exact baseline queries. The browser worker and Node helper import the same
pure normalizer and response builder, so they cannot silently diverge on the
approved rules. Candidate tier order is documented in
[`docs/search-candidates.md`](search-candidates.md); broader search forms remain
later M4 work.
