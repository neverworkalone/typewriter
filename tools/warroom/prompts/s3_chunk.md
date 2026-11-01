# Relation Factory Stage 3 — one compact edit chunk

{{s3_policy_card}}

The Stage 3 editor is `node scripts/relation/edit-cli.mjs`. Read the instructions below, return only the exact compact decision block, and do not run other commands or edit repository files.

```text
chunk {{chunk_id}}
D 1 5 9
L 4 T1
```

Use `none` as the only decision line when all rows are kept. The CLI validates the row numbers and exact same-spelling target aliases. Do not include prose, Markdown fences, or Keep rows.

Input rows are tab-separated; `\\`, `\t`, `\n`, `\r` in a field are escapes. Keep is implicit.
`S` starts a Source Sense (lemma, POS, gloss); its relation rows follow until the next `S`.
`I<n>` is an ID Relation (target, type, tier; ambiguous targets add POS, gloss); `X<n>` is a text-only Relation (text, type, tier).
The `T<k>` rows right after an `X` are that text's candidate targets (lemma, POS, gloss); `D`/`L` use the printed `n` and `T<k>` as is.

{{session_note}}This is one source-Sense-complete chunk from shard {{shard}}. Judge its full relation sets together.

{{chunk_input}}
