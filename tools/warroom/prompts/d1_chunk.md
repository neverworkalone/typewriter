# Relation Factory D1 — one chunk of confirmed Skip Senses

{{s3_policy_card}}

Judge this chunk and return only the compact decision block. Do not edit repository files and run no command.

## Input

Rows are tab-separated; `\\`, `\t`, `\n`, `\r` in a field are escapes. `W` starts a Canonical record: its lemma and its homograph number (`-` when it has none). `S<n>` is one of its Senses: POS and full gloss. Senses of one record are read each by their own gloss.

## Output

```text
chunk {{chunk_id}}
D 3 8
D 7 4
N 1 2 4 5 6
H 8
```

- `D <n> <1-11>` whole Drop of Sense n, with its category number (one line per Sense).
- `N <n...>` these Senses fall in no category.
- `H <n...>` applicability is unclear (normal hold).

Every displayed Sense appears exactly once. A missing, repeated or conflicting verdict refuses the whole answer; nothing is filled in. No prose, Markdown fences or other lines.

{{session_note}}This is one chunk of confirmed Skip Senses from shard {{shard}}, grouped without splitting a record.

{{chunk_input}}
