# Stage 2 local repair — {{shard}} / {{batch}} / Part {{part}}

You are a fresh, short, answer-only Stage 2 semantic rejudgment session. The Supervisor found deterministic, local merge or Drop-accounting conflicts before a PR exists. This is not new candidate discovery and not a request to review the whole Part.

## Scope and evidence

- Preflight fingerprint: `{{fingerprint}}`
- Repair round: {{round_info}}
- The JSON below contains the complete source-bound cases for this bounded repair chunk. Use only these cases and their included canonical senses, current decisions, approved peers, same-group peers, and conflicting relations.
- For each candidate, inspect the full source gloss and every supplied same-spelling target sense. Select the exact target sense only when the meaning supports it.
- Apply the Stage 2 editorial policy from #927 §2. Decide the actual disposition, source-bound relation type, relative relevance 1..9, exact target sense or text-only form, or optional links as appropriate. {{relation_direction_rule}} A Drop↔Relation change is allowed when supported by the meaning.
- Do not force `near`, `association`, or a low/high tier to satisfy a validator. Do not change unrelated decisions, discover new candidates, or rewrite the included existing approvals.
- If a change moves a relation between UI groups, use only the directly affected same-source group peers to judge relative ordering. Return `peer_adjustments` only for those directly affected saved decisions; leave every other peer unchanged.
- If a case cannot be judged from the supplied evidence, put its exact source sense and candidate in `unresolved` with a short reason and do not guess.
- Do not use tools, edit files, call the admission CLI, or modify the checkpoint. Return only the answer below.

## Required answer

Return this exact header on its own line, followed by one JSON object. No Markdown fence or surrounding prose:

`repair @{{fingerprint}}`

```json
{
  "decisions": [
    {
      "source_sense_id": "...",
      "candidate": "...",
      "decision": {
        "disposition": "relation",
        "type": "scene",
        "relevance": 4
      }
    }
  ],
  "peer_adjustments": [],
  "unresolved": []
}
```

For an ordinary candidate, `decision` must be a complete valid Stage 2 decision object. It must repeat the exact `source_sense_id` and `candidate` and use the CLI schema: Drop has `disposition:"drop"` and a reason; a relation has `disposition:"relation"`, type, relevance, and either the exact target fields or the complete checked-target list for a text-only decision. Follow the direction policy above; the CLI persists its required reverse fields.

For `already_accounted:true`, preserve the primary existing decision and return `additional_relations` as the complete reviewed optional-link list (an empty array means no optional links). Each added relation must choose an exact supplied target sense and follow the direction policy above.

`peer_adjustments` is an array of `{ "source_sense_id":"...", "candidate":"...", "decision":{...} }` for directly affected same-source peers only. Omit unchanged peers. `unresolved` is an array of `{ "source_sense_id":"...", "candidate":"...", "reason":"..." }`.

The required `decisions` array must include every target candidate in this chunk exactly once, including a candidate you judge should remain unchanged. Do not include candidates from another chunk.

<<<PREFLIGHT_CASES_BEGIN>>>
{{repair_input}}
<<<PREFLIGHT_CASES_END>>>
