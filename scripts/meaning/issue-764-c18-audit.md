# Issue #764 C18 meaning boundary audit

## Scope and evidence

Source-bound agent self-check for Issue #764, range C18 (ㅍ), based on `6eb5d379537373d14f89c60206feffdb01cf7c81`. This is an agent self-check, not an independent review or human approval. The initial pass considered every C18 lemma with an existing multi-Meaning boundary or a Meaning row that already bound multiple canonical senses: 2,166 lemma groups (2,096 with multiple current Meanings; 108 with multi-sense rows across 118 rows; 38 overlap). A subsequent Stage 1 review found two missed under-merges in that pass; its follow-up corrected only `파가` and `파가하다` and did not claim a renewed semantic review of all 2,166 groups. A later Stage 2 review of the exact PR head identified overmerges in `폐기` and `피복`. This follow-up source-checked all 56 cross-record merged groups (117 unique source records) and split 17 groups where full lexical composition and the source meanings established independent words. It is a focused review of that risk slice, not a renewed semantic review of all 2,166 groups. The other 9,405 lemmas had one Meaning bound to one source sense and no internal boundary to repartition.

Each reviewed lemma was considered as a whole against all its bound canonical source senses and current Meaning rows. The executable record is [`issue-764-c18.json`](issue-764-c18.json), with exact before snapshots and final sense groups. The residual split set is fully indexed in [`issue-764-c18-residual-audit.md`](issue-764-c18-residual-audit.md).

No canonical JSONL, adjudication record, or source projection changed. No source sense was dropped; every canonical source gloss for an edited group is retained in the resulting Meaning gloss.

| Measure | Before | After |
| --- | ---: | ---: |
| C18 Meaning rows | 15,434 | 14,773 |
| Lemmas with several Meanings | 2,096 | 1,833 |
| Rows in the 385 repartitioned lemmas | 1,309 | 648 |
| C18 lemmas | 11,571 | 11,571 |
| C18 duplicate adjudications | 2 | 2 |

## Boundary decisions

- **Polysemy merged across concrete, figurative, and technical uses:** `프로그램` (plan/order, broadcast sequence, computer instructions), `파도` (water, social, and psychological waves), and `피어나다` (flowering, smoke/fire, recovery, improvement, spreading, thoughts, and smiles). The source-specific wording remains in one gloss rather than being replaced by an invented shared definition.
- **`파가` and `파가하다`:** house demolition and the Go use that prevents an opponent's house from forming are treated as one lexical extension for each lemma. Both original source glosses are retained in each resulting Meaning. The separate household-use senses `w497887-s1` and `w354932-s1` were not reassessed in this follow-up.
- **Stage 2 source-bound overmerge follow-up:** `폐기` separates 廢氣 (engine exhaust) from 廢棄 (discarding or annulling); `피복` separates 被服 (clothing) from 被覆 (covering), while physical and topological 被覆 stay together. The source-bound changes and retained glosses are recorded in the executable spec and residual audit. The same partial-component review also separates `포` (砲 weapon vs 包 chess piece), `필로` (筆勞 vs 筆路), `필부` (匹婦 vs 匹夫), `편벽하다` (偏僻 vs 便辟), `편사` (便私 vs 偏私), `폐사` (弊社 vs 弊舍), `폐장` (肺臟 vs 肺腸), `포루` (砲樓 vs 鋪樓), `표표하다` (表表 vs the floating/flapping group), `파다하다` (頗多 vs 播多), `파락`/`파락하다` (擺落 vs 破落), `파상설` (波狀雪 vs 波狀說), `파선` (波線 vs 擺線), and `표풍` (漂風 vs 飆風). The boundary tests exercise each split and retain source-bound positive controls for valid extensions.
- **Close same-class candidates retained after comparison:** `피모` keeps skin-and-hair with the body coat; `편면` keeps a specific striking face as a kind of one side; `폐관`, `폐교`, `폐업`, and `폐문` keep daily closure and lasting cessation within the same closure concept; `포장` keeps wrapping and containing/harboring; `포진` keeps military placement, spreading objects, and arranging floor seating; `포열` keeps general battle deployment and artillery deployment. Their source meanings show a natural semantic extension or the same concrete naming principle, rather than only a shared topic or one unrelated component.
- **Stage 2 scope control:** the 56 cross-record groups were checked against the original STDICT records located by the committed provenance IDs. The four local source files containing those records match their SHA-256 values in `data/provenance/stdict-source-inventory.json`; the downloaded source files themselves are not included in this PR. This pass does not claim an exhaustive semantic review of the other C18 boundaries.
- **Shared physical image merged:** `파닥` and related flap-family lemmas bring together bird wings, fish tails, and fabric/flags moving in wind when the bound source glosses describe the same quick flapping motion. `풍차` merges the windmill and its child-sized pinwheel by their wind-driven rotating blades; the clothing senses remain separate, and `→ 풍구` remains its own source-bound group.
- **Same marker identity retained across a redirect:** `표식` combines “a fixed way of indicating something” with its `→ 표지03` cross-reference; the canonical `표지03` projection identifies the marking/distinguishing sense. Its exemplar of a type, fossil or relic remains separate.
- **Independent homonyms remain split:** `파랑` keeps waves apart from the blue color; `피로` keeps public display, capture, and pyrogallol separate while combining ordinary fatigue with material fatigue; unrelated referents and senses across `피치`, `피트`, `필`, and proper-name lemmas remain distinct. The full residual set and source IDs are listed in the residual audit.

## Validation and limits

The Meaning validator passes on the complete dataset. The edit spec covers every prior source-sense binding once for each repartition, and every resulting gloss contains every bound canonical source gloss. The two pre-existing duplicate drops (`w498155-s1` → `w498126-s6`, `w365419-s1` → `w365418-s1`) remain intact; canonical data and adjudications are unchanged.

This follow-up checked source Hanja and source definitions in the original STDICT snapshot identified by repository provenance; no other dictionary or language model was used. The existing exact-coverage regression now checks the 17 boundary splits, retained polysemy controls, and the projected `폐기`(廢氣) → `배기` source relation so it cannot leak to `폐기`(廢棄). Source IDs and contrasts are preserved so individual editorial boundaries remain reviewable.
