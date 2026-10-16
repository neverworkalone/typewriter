# Issue #764 C18 meaning boundary audit

## Scope and evidence

Source-bound agent self-check for Issue #764, range C18 (ㅍ), based on `6eb5d379537373d14f89c60206feffdb01cf7c81`. This is an agent self-check, not an independent review or human approval. I reviewed every C18 lemma with an existing multi-Meaning boundary or a Meaning row that already bound multiple canonical senses: 2,166 lemma groups (2,096 with multiple current Meanings; 108 with multi-sense rows across 118 rows; 38 overlap). The other 9,405 lemmas had one Meaning bound to one source sense and no internal boundary to repartition.

Each reviewed lemma was considered as a whole against all its bound canonical source senses and current Meaning rows. The executable record is [`issue-764-c18.json`](issue-764-c18.json), with exact before snapshots and final sense groups. The residual split set is fully indexed in [`issue-764-c18-residual-audit.md`](issue-764-c18-residual-audit.md).

No canonical JSONL, adjudication record, or source projection changed. No source sense was dropped; every canonical source gloss for an edited group is retained in the resulting Meaning gloss.

| Measure | Before | After |
| --- | ---: | ---: |
| C18 Meaning rows | 15,434 | 14,758 |
| Lemmas with several Meanings | 2,096 | 1,824 |
| Rows in the 383 repartitioned lemmas | 1,303 | 627 |
| C18 lemmas | 11,571 | 11,571 |
| C18 duplicate adjudications | 2 | 2 |

## Boundary decisions

- **Polysemy merged across concrete, figurative, and technical uses:** `프로그램` (plan/order, broadcast sequence, computer instructions), `파도` (water, social, and psychological waves), and `피어나다` (flowering, smoke/fire, recovery, improvement, spreading, thoughts, and smiles). The source-specific wording remains in one gloss rather than being replaced by an invented shared definition.
- **Shared physical image merged:** `파닥` and related flap-family lemmas bring together bird wings, fish tails, and fabric/flags moving in wind when the bound source glosses describe the same quick flapping motion. `풍차` merges the windmill and its child-sized pinwheel by their wind-driven rotating blades; the clothing senses remain separate, and `→ 풍구` remains its own source-bound group.
- **Same marker identity retained across a redirect:** `표식` combines “a fixed way of indicating something” with its `→ 표지03` cross-reference; the canonical `표지03` projection identifies the marking/distinguishing sense. Its exemplar of a type, fossil or relic remains separate.
- **Independent homonyms remain split:** `파랑` keeps waves apart from the blue color; `피로` keeps public display, capture, and pyrogallol separate while combining ordinary fatigue with material fatigue; unrelated referents and senses across `피치`, `피트`, `필`, and proper-name lemmas remain distinct. The full residual set and source IDs are listed in the residual audit.

## Validation and limits

The Meaning validator passes on the complete dataset. The edit spec covers every prior source-sense binding once for each repartition, and every resulting gloss contains every bound canonical source gloss. The two pre-existing duplicate drops (`w498155-s1` → `w498126-s6`, `w365419-s1` → `w365418-s1`) remain intact; canonical data and adjudications are unchanged.

Decisions use the repository canonical source projections only; no external dictionary or language model was consulted. The editorial boundary is still a judgment call where one spelling has a long chain of semantic extension; source IDs and contrasts are preserved so a reviewer can challenge individual boundaries.
