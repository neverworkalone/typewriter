# M5 relation draft template v1

This is the versioned prompt/output contract for the next bounded calibration.
It is a temporary authoring template, not canonical dictionary data. Keep the raw
response and unreviewed draft outside the repository.

## Prompt metadata

```text
template_id: typewriter-m5-relation-draft-v1
prompt_version: m5-4-relation-review-v1
relation_policy: evidence-first-optional
```

For each selected inventory start, prepare the smallest plausible set of senses.
For each sense, propose zero or more relations. Every proposed relation must have:

- a stable relation `id` that survives review;
- the exact `source_sense` and `target_sense`;
- one current relation type (`direct`, `near`, `antonym`, `mood`, `scene`,
  `sensory`, `action`, or `association`); and
- a short writer-facing reason that explains why the edge is useful for this sense.

Zero relations is valid. Do not add an edge to satisfy a count, balance a record,
or make a generated answer look complete. If the reason is only “often appears
with,” “may cause,” or “can be seen near,” leave the relation out and record an
editorial gap for review.

Before finalizing a relation, check it against the six failure categories:

1. `incidental-co-occurrence`
2. `generic-result-or-reaction`
3. `arbitrary-modifier-or-place`
4. `broad-common-category`
5. `unsupported-cross-sensory`
6. `sense-target-type-error`

The first five are usually removal reasons. The last also covers a wrong source
sense, target sense, part of speech, or relation type. A reviewer may retype or
retarget a relation when the writer-facing evidence survives the correction.

## Review output

The reviewed manifest remains the authority for `included`, `corrected`, `held`,
and `rejected`. Relation snapshots are kept separately from the manifest and are
passed to `npm run batch:diff`. The final relation-diff artifact may contain event
metadata and failure categories, but never the raw response, draft prose, external
source text, or confidence score.

The prompt is a request for candidates, not an automatic approval rule. Human
review decides sense boundaries, relation admission, and whether a weak candidate
should remain an explicit editorial gap.
