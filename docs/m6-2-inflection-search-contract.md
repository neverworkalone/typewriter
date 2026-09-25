# M6-2 supported inflection-to-lemma search contract

## Decision

M6 supports a finite set of surface forms for a canonical predicate lemma. The
surface form reaches the existing `start` record and the sense or senses whose
part of speech licenses that form. It never creates a canonical record per
inflected form.

The current runtime remains exact-only until M6-3 implements this contract. The
M4 regression corpus remains a record of the M4 runtime; the separate contract
fixture in `tests/fixtures/search-regressions/m6-2-inflection-contract.json`
states the new expected behavior.

## Corpus inventory

The contract is based on `master` at `b5de2d32d2d0ce02feca8eb244baff3c95845ca5`
and the unchanged M6-1 canonical digest
`8dad0cd312a7fb8c2073c3aaf8cd2c96e70875a035877e83e9292c6c74d359b9`.
`npm run baseline:m6-1` reproduced the 5,000 searchable starts and all 5,251
current exact keys.

| Inventory measure | Count |
| --- | ---: |
| Start senses with POS `verb` | 658 |
| Start records with a `verb` sense | 569 |
| Start senses with POS `adjective` | 309 |
| Start records with an `adjective` sense | 254 |
| Start `entry` records with a verb or adjective sense | 820 |
| Single-token predicate entries | 818 |
| Multiword predicate entries excluded from generation | 2 |
| Single-token entries with both verb and adjective senses | 3 |
| Single-token predicates with an open final stem syllable | 666 |

The overlapping POS records are `w237 쓰다`, `w310 단정하다`, and `w548
고소하다`. The excluded multiword lemmas are `w883 사려 깊다` and `w2814 몸을
기대다`. These records show why generated rows must bind to a sense as well as a
record, and why M6 does not split or rewrite expression spacing.

Observed spelling features among the 818 single-token entries include 303
lemmas ending in `-하다`, 23 ending in `-르다`, and 40 stems with final `ㄹ`.
Other final-stem groups include 15 verb records with final `ㄷ`, 32 predicate
records with final `ㅂ` (17 adjective and 15 verb records), 7 verb records with
final `ㅅ`, and 10 predicate records with final `ㅎ` (2 adjective and 8 verb
records). These are spelling counts, not conjugation-class labels: final
consonant alone does not prove regular or irregular behavior.

The open-final inventory is also relevant to plain-past scope. It has 340 final
`ㅏ` stems (303 ending in `-하다`, 37 other), 33 final `ㅗ` stems (26 ending in
`-보다`, 7 ending in `-오다`, and none in another class), and 293 stems with
other final vowels. The policy below supports only the evidenced classes and
requires an explicit sense-bound exception for other open-vowel stems; it does
not infer a past form for all 666 entries from vowel harmony alone.

## Supported surface-form classes

Only `role: start`, `record_type: entry` records with a single-token citation
lemma ending in `다` are eligible. A surface form is generated only for a
canonical sense whose `pos` is supported by the rule. The fixed rule slots are:

| Rule ID | Sense POS | Supported form | Example |
| --- | --- | --- | --- |
| `verb-present-adnominal-neun` | `verb` | Present adnominal `-는` | `바라보다 → 바라보는` |
| `verb-past-adnominal-eun` | `verb` | Completed/past adnominal `-(으)ㄴ` | `먹다 → 먹은` |
| `adjective-present-adnominal-eun` | `adjective` | Present adnominal `-(으)ㄴ` | `예쁘다 → 예쁜` |
| `adjective-present-adnominal-neun-exception` | registered `adjective` senses ending in `없다` | Present adnominal `-는` | `거침없다 → 거침없는` |
| `predicate-future-adnominal-eul` | `verb`, `adjective` | Prospective adnominal `-(으)ㄹ` | `달다 → 달` |
| `predicate-plain-past-coda-bearing` | `verb`, `adjective` | Regular plain past for a coda-bearing stem | `먹다 → 먹었다`, `잡다 → 잡았다` |
| `predicate-plain-past-open-a` | `verb`, `adjective` | Required `ㅏ + 았` contraction for other open-final `ㅏ` stems | `바라다 → 바랐다` |
| `predicate-plain-past-hada` | `verb`, `adjective` | `-하다 → -했다` | `담담하다 → 담담했다` |
| `predicate-plain-past-open-o-boda` | `verb`, `adjective` | Both contracted and uncontracted forms | `보다 → 보았다`, `봤다` |
| `predicate-plain-past-required-oda` | `verb`, `adjective` | Contracted form only for `-오다` | `오다 → 왔다` |
| `predicate-plain-past-registered-exception` | explicitly registered senses | Sense-bound irregular or exceptional past | `듣다 → 들었다`, `쓰다 → 썼다` |

The fixed slots include the required M6 examples. `먹다`, `예쁘다`, `보다`, and
`오다` are not canonical records in the issue-start corpus, so those bare-lemma
examples are contract-only; they do not authorize adding records. The compound
lemmas `바라보다` and `다가오다`, and the lemma `담담하다`, are real current
records. M6-3 must preserve the distinction between a rule example and a
searchable canonical target. The fixtures bind `읽은` to `읽다`, `옅은` to both
adjective senses of `옅다`, and `잡았다` to both verb senses of `잡다`.

Apply the regular endings as follows:

- For `-는`, append it to a verb stem and remove final `ㄹ` first.
- For present adjective and completed verb `-(으)ㄴ`, attach `ㄴ` as the final
  consonant when the stem has no coda, remove final `ㄹ` and attach `ㄴ`, or
  append `은` after another coda.
- For prospective `-(으)ㄹ`, attach final `ㄹ` when the stem has no coda or
  already ends in `ㄹ`; append `을` after another coda.
- Plain past is deliberately split into closed classes. For a regular
  coda-bearing stem, append `았다` after final stem vowel `ㅏ` or `ㅗ`, and
  `었다` otherwise. For an open-final `ㅏ` stem other than `-하다`, contraction
  is required: merge final `ㅏ` with `았` by adding coda `ㅆ` (`바라다 →
  바랐다`). The `-하다` class emits `-했다` (`담담하다 → 담담했다`). For
  `-보다`, both `보았다` and `봤다` are supported: the uncontracted form appends
  `았다`, while the contracted form adds coda `ㅆ` to the final open `보`
  syllable after changing its vowel nucleus from `ㅗ` to `ㅘ`. This also yields
  `바라보았다` and `바라봤다` for `바라보다`. For `-오다`, contraction is
  required and the uncontracted form is unsupported; change the final open `오`
  nucleus from `ㅗ` to `ㅘ`, then add coda `ㅆ` (`다가오다 → 다가왔다`; `오았다`
  is rejected). Both classes use the same checked primitive in
  `scripts/inflection/contract.mjs`; their policy differs only in whether the
  uncontracted surface is also emitted. Other open-final vowel classes have no
  generic plain-past rule; they require a reviewed, sense-bound exception entry
  before a past form is projected.

Past-class precedence is: registered sense-bound exception, `-하다`, regular
coda-bearing, open-final `ㅏ`, required-contracted `-오다`, then optional
contracted/uncontracted `-보다`. The classes are constrained by this ordering:
`-하다` is not treated as the generic open-`ㅏ` class, and the `-오다` /
`-보다` policies supersede the broad coda-vowel attachment that would otherwise
emit invalid or incomplete forms. In particular, `오다` has `왔다` but not
`오았다`, while `보다` permits both `보았다` and `봤다`.

These attachment rules do not override lexical irregularity. A spelling feature
does not authorize an irregular form by itself. Irregular or exceptional
alternations must have an explicit, reviewed rule-class entry bound to the
canonical `record_id` and `sense_id`; forms not covered by a regular attachment
or registered class get no projection row. Future admission must fail closed:
each new sense with a risk-final coda (`ㄷ`, `ㅂ`, `ㅅ`, or `ㅎ`) needs a
sense-bound supported irregular class, an explicit regular classification, or
an explicit exclusion. Other unsupported open-vowel past forms also require an
explicit sense-bound exclusion. Unknown classes never fall back to generic
open-vowel past attachment. Strict admission also requires adjective senses
ending in `없다` to carry the present-adnominal class or explicitly exclude all
generated forms for that sense, regardless of whether validation runs on the default
canonical directory or a prospective dataset. The collision audit binds all
exact/generated and generated/generated candidates, including expression
records, to the reviewed M6-3 manifest. The contract fixtures exercise the current-corpus
`ㄷ` irregular (`듣다 → 들었다`), `ㅂ` irregular adjective
(`감탄스럽다 → 감탄스러운`), `ㅎ` irregular adjective (`희뿌옇다 → 희뿌연`),
`ㅡ` irregular (`쓰다 → 썼다`), `르` irregular (`부르다 → 불렀다`), `ㅅ`
irregular (`잇다 → 이었다`), and exceptional `없다` adnominals
(`거침없다 → 거침없는`, `보잘것없다 → 보잘것없는`). An unregistered open-`ㅣ`
past such as `기다렸다` is unsupported by this snapshot contract.

Each query uses one of the listed slots. The contract does not compose multiple
endings or analyze whitespace-separated tokens. It excludes connective forms
such as `-고`, `-며`, and `-(으)면`; polite or honorific endings; negation and
auxiliary chains; passive/causative derivation; particles; spelling correction;
prefix matching; and fuzzy search. In particular, `바라보며` has no generated
match under this contract.

## Candidate identity and ambiguity

The generated candidate identity is `(record_id, sense_id)`. If one form maps to
several records or senses, M6-3 must retain every supported candidate and keep
sense order from canonical data. It must not select the first lemma or collapse
ambiguity to one answer. Multiple generated paths to the same sense are
deduplicated deterministically.

The real form `쓰는` is generated by both `w237 쓰다` and `w2783 쓸다`. For
`w237`, only its three verb senses are candidates; its adjective sense is not a
match for the verb rule. The real form `들었다` likewise has two candidates:
`w201 듣다` through the registered `ㄷ` irregular class, and `w2797 들다`
through the regular coda-bearing past rule. Both forms are intentionally
ambiguous.

## Precedence and normalization

Input normalization remains the current NFC normalization followed by trimming
surrounding whitespace. No additional query rewriting is introduced.

The current lemma/search-form path runs first and keeps its complete current
result order and match provenance. Generated surface matches are appended below
all results from that path. If the same record is reached by both paths, retain
the existing lemma/search-form match once; do not replace it with generated
provenance. This ordering applies to current normalized lemma/search-form hits
too. Generated matches are ordered by record ID, then canonical sense order.

The real query `달` is already the curated `search_forms` value for `w935 달다`.
It also has the prospective-adnominal form `달다 → 달`. The result remains one
`w935` candidate with `exact-search-form` provenance; the generated path neither
duplicates it nor changes the existing match.

If no existing exact match and no supported generated form exists, the query
keeps the existing no-match or unsupported behavior. There is no fallback to a
broader search.

## Representation and build boundary

M6-3 should add a deterministic generated SQLite projection, separate from
canonical `search_forms`, with one row per supported form/sense mapping:

```text
generated_surface_forms(form, record_id, sense_id, rule_id)
```

The table is built from canonical JSONL, regular rule code, and two checked-in
M6 manifests. `data/validation/m6-2-inflection-exceptions.json` binds supported
irregular classes to canonical `(record_id, sense_id)` pairs.
`data/validation/m6-3-surface-form-review.json` binds regular classifications for
risk codas and explicit past-form exclusions to the same sense identity, and
records the reviewed exact/generated and generated/generated collision
candidate sets. Neither manifest stores lexical records or duplicate generated
forms. A missing or changed disposition fails shared admission. A new, changed,
or removed collision candidate set must be reviewed in the M6-3 manifest before
admission succeeds. Exact candidates include every `role: start` entry and
expression lemma/search form; generated candidates retain their sense and rule
identity. Index `form` for lookup and preserve deterministic source order. Keep
record and sense foreign-key checks fail-closed. Do not add generated surface
forms to canonical JSONL, create per-form records, or change canonical schema
for this contract.

The shared query adapter must return the same generated provenance and candidate
set in Extension and Web. A generated match must identify its `rule_id` and
matching sense IDs. Exact matches keep the current record-wide sense behavior;
generated matches expose only the senses licensed by the matching POS/rule.
The open-`ㅗ` contraction primitive in `scripts/inflection/contract.mjs` is
executable contract code for the M6-3 generator to reuse; it changes the nucleus
to `ㅘ` before adding coda `ㅆ` and returns no result for other stem endings.

## Future lexical admission

For every new searchable `entry` sense with POS `verb` or `adjective`, shared
admission must do one of the following:

1. classify it under each applicable supported rule and prove that the
   deterministic projection includes its expected surface form; or
2. record an explicit exclusion reason when the spelling, POS, or exception
   class is not yet supported.

An irregular-class addition requires an explicit sense-bound class entry and a
positive fixture. The admission check must also run the generated-form collision
audit against every start lemma and curated search form, and require ambiguous
surface groups to preserve all candidates. Unknown classes, missing projections,
duplicate record/sense rows, and unexplained collisions fail closed. Generated
forms are projection data and must never be copied into canonical `search_forms`
as a workaround.

## Fixture and implementation boundary

The M6-2 JSON fixture records policy expectations and canonical bindings; it is
not evidence that the runtime already supports morphology. Its test verifies
the bound canonical examples, the 5K and open-vowel inventories, the synthetic
required examples, contraction policy, ambiguity, precedence, and unsupported
boundaries. M6-3 must add runtime/build
regressions against the same contract before changing the M4 observed result for
`담담했다`.

## References

- The National Institute of Korean Language distinguishes verb `-는` from
  adjective `-(으)ㄴ`, and documents exceptional adjective behavior such as
  `있다`/`없다`: [adnominal endings](https://www.korean.go.kr/front/onlineQna/onlineQnaView.do?mn_id=&pageIndex=1&qna_seq=332462&searchCondition=&searchKeyword=),
  [the `있는` form](https://www.korean.go.kr/front/onlineQna/onlineQnaView.do?mn_id=216&pageIndex=1&qna_seq=335000&searchCondition=&searchKeyword=).
- The National Institute of Korean Language documents final `ㄹ` deletion and
  the different attachment of `-(으)ㄴ` and `-는`:
  [adnominal forms after `ㄹ`](https://www.korean.go.kr/front/onlineQna/onlineQnaView.do?mn_id=73&pageIndex=1&qna_seq=328569).
- Prospective `-(으)ㄹ` can follow both verb and adjective stems:
  [prospective adnominal form](https://www.korean.go.kr/front/mcfaq/mcfaqView.do?mcfaq_seq=8315).
- Irregular forms depend on lexical class; the National Institute documents
  `ㄷ`, `ㅂ`, and `ㅎ` alternations and the `하였다 → 했다` contraction:
  [`ㄷ` irregular forms](https://www.korean.go.kr/front/onlineQna/onlineQnaView.do?mn_id=216&qna_seq=318391),
  [`ㅂ` irregular forms](https://www.korean.go.kr/front/onlineQna/onlineQnaView.do?mn_id=216&pageIndex=1&qna_seq=311824),
  [`ㅎ` irregular forms](https://www.korean.go.kr/front/onlineQna/onlineQnaView.do?mn_id=97&pageIndex=1&qna_seq=334394),
  [`하였다 → 했다`](https://www.korean.go.kr/front/onlineQna/onlineQnaView.do?mn_id=216&pageIndex=2&qna_seq=320151).
- For open-`ㅗ` past, the National Institute states `오다` takes `왔다` and
  `보다` permits both `보았다` and `봤다`: [`오다` and `보다`](https://www.korean.go.kr/front/onlineQna/onlineQnaView.do?mn_id=216&pageIndex=1&qna_seq=318662).
- For open-final `ㅏ`, the National Institute confirms `바라다 → 바랐다` and
  the `ㅏ/ㅓ + -았/었` contraction pattern: [`바라다` past form](https://www.korean.go.kr/front/onlineQna/onlineQnaView.do?mn_id=261&pageIndex=1&qna_seq=327024).
