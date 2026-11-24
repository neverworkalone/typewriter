# Relation Factory Stage 4 — one selective Polish chunk

{{s3_policy_card}}

The Stage 4 editor is `node scripts/relation/s4-cli.mjs`. Judge this chunk and return only the compact decision block. Do not edit repository files.

**One permitted command.** When you want to Add or rebind to a Canonical word, run once, with every word you need together:

```sh
node scripts/relation/s4-cli.mjs lookup --text 낱말1,낱말2,낱말3
```

It prints `Q <word>` and then each exact same-spelling Canonical Sense as `sense_id, lemma, POS, gloss`. Choose the Sense whose gloss means what you intend. Do not run it for a chunk where you add nothing, and run no other command.

## Input

Rows are tab-separated; `\\`, `\t`, `\n`, `\r` in a field are escapes. `W` starts a Canonical record (lemma). `S<j>` is one of its Senses (POS, gloss). The rows after an `S` are that Sense's approved Relations:
- `F<n>` forward ID Relation (target lemma, POS, gloss, type, tier),
- `X<n>` text-only Relation (text, type, tier),
- `R<n>` reverse ID Relation stored from another word (that word's lemma, POS, gloss, type, tier).
A Sense with no rows has no Relations yet. A Relation between two Senses of this chunk is shown under both.

## Output

```text
chunk {{chunk_id}}
skip 3 7 8
D 1 5 9
C 4 mood 3
A 2 w123-s1 sensory 4
A 2 "물 뿌린 듯이" scene 5
B 6 w456-s2
M 11 12
```

- `skip <j...>` Skip these Senses as search starts.
- `D <n...>` Drop these Relations.
- `C <n> <type> <tier>` Set Type/Tier of Relation n.
- `A <j> <sense_id|"text"> <type> <tier>` Add a Relation from Sense j: a `sense_id` from `lookup`, or a quoted text when no Canonical Sense fits.
- `B <n> <sense_id|"text"> [<type> <tier>]` rebind Relation n to another counterpart (keeps Type/Tier unless given).
- `M <n> <j>` move Relation n to Sense j of the same record (wrong Sense of this word).
- `none` as the only line when every Sense is Polished with no change and none is skipped.

Write only changes and skips: no Keep rows, no prose, no Markdown fences. Every unlisted Sense is a Polished Sense with no change. The CLI checks numbers, Sense IDs and existing relations and applies everything.

{{session_note}}This is one record-complete chunk from shard {{shard}}.

{{chunk_input}}
