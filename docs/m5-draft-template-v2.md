# M5 relation draft template v2

This is the current versioned contract for the next bounded calibration after
M5-5. It is an authoring template, not canonical dictionary data. Raw model
responses, unreviewed drafts, and external reference material stay outside the
repository.

## Prompt metadata

```text
template_id: typewriter-m5-relation-draft-v2
prompt_version: m5-6-relation-process-v1
relation_policy: evidence-first-optional
default_relation_output: []
relation_quota: none
```

## Default output

Start every sense with an empty relation list. A relation is an optional
editorial candidate, not a required field to fill. Zero relations is a valid
and expected result when no writer-facing connection survives review.

Do not add a relation to satisfy a quota, balance a record, make a response look
complete, or increase coverage. The prompt must not contain a minimum, maximum,
per-type quota, or record-level relation target. When evidence is weak, return
`relations: []` and record an editorial gap for the human reviewer.

The draft shape is deliberately small:

```json
{
  "source_sense": "w000-s1",
  "relations": [],
  "editorial_gap": "관계 후보가 독립적인 작가용 쓰임으로 이어지지 않는다."
}
```

When a candidate is proposed, include only the exact source sense, target sense,
current relation type, and a short writer-facing reason. The reason is evidence
for review, not an approval signal.

## Human admission checklist

The editor evaluates every candidate before it can enter the reviewed relation
snapshot. A candidate is admitted only when every applicable question has a
clear answer:

1. Does the source sense identify the intended meaning, and does the target
   sense, part of speech, and relation direction match it exactly?
2. Is the relation type honest? A `direct` edge must survive a real sentence-slot
   substitution; a wider type must describe the actual mood, scene, sensory
   image, action, or association rather than pretending to be a substitute.
3. Can the editor explain a concrete writer-facing use for this source sense,
   beyond the target merely appearing nearby in a sentence or scene?
4. Does the candidate avoid every failure category in the review vocabulary?
5. If the candidate is retargeted or retyped, does the corrected edge still
   have independent writer-facing evidence rather than merely repairing a
   plausible-looking tuple?

Reject or omit a candidate when any answer is no. Use these categories when
recording the human decision:

| Failure category | Admission check |
| --- | --- |
| `broad-common-category` | Same broad category is not enough; the target must preserve a useful part of the source sense. |
| `arbitrary-modifier-or-place` | A place, object, modifier, or background detail needs a stable writer-facing connection, not just a possible setting. |
| `incidental-co-occurrence` | Nearby appearance or common collocation is not a relation by itself. |
| `generic-result-or-reaction` | A common consequence, response, trace, or aftermath is not automatically a mood, scene, or action edge. |
| `unsupported-cross-sensory` | A cross-sensory edge needs a concrete image and an explanation tied to the source sense. |
| `sense-target-type-error` | Wrong source sense, target sense, part of speech, direction, or relation type is rejected or corrected only with explicit editorial evidence. |

The M5-5 regression cases in
[`tests/fixtures/relation-admission/m5-5-regressions.json`](../tests/fixtures/relation-admission/m5-5-regressions.json)
are the minimum examples to check before accepting a new batch. They are
regression material, not a new expansion-gate measurement.

## Review boundary

The validator may check JSON shape, canonical identifiers, relation-diff
structure, source-artifact binding, and reproducible counts. It must not decide
semantic quality, generate a relation, or delete a relation automatically. A
human editor owns sense boundaries, direction, type, admission, retargeting,
and the decision to leave a sense empty.

The reviewed manifest and relation-diff artifact remain the authority for the
final decision. A source-sense change is represented as a remove plus an add;
it must not be hidden in a relation-id rewrite.
