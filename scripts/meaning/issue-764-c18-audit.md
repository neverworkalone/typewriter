# Issue #764 C18 meaning boundary audit

## Scope and evidence

Source-bound agent self-check for Issue #764, range C18 (ㅍ), based on `6eb5d379537373d14f89c60206feffdb01cf7c81`. This is an agent self-check, not an independent review or human approval. The initial pass considered every C18 lemma with an existing multi-Meaning boundary or a Meaning row that already bound multiple canonical senses: 2,166 lemma groups (2,096 with multiple current Meanings; 108 with multi-sense rows across 118 rows; 38 overlap). A subsequent Stage 1 review found two missed under-merges in that pass; its follow-up corrected only `파가` and `파가하다` and did not claim a renewed semantic review of all 2,166 groups. Later Stage 2 reviews identified overmerges in `폐기`, `피복`, `피복선`, `평시`, and `피아노`. This follow-up source-checked all 56 cross-record merged groups (117 unique source records) and split 20 groups where full lexical composition and the source meanings established independent words. It is a focused review of that risk slice, not a renewed semantic review of all 2,166 groups. The other 9,405 lemmas had one Meaning bound to one source sense and no internal boundary to repartition.

Each reviewed lemma was considered as a whole against all its bound canonical source senses and current Meaning rows. The executable record is [`issue-764-c18.json`](issue-764-c18.json), with exact before snapshots and final sense groups. The residual split set is fully indexed in [`issue-764-c18-residual-audit.md`](issue-764-c18-residual-audit.md).

No canonical JSONL, adjudication record, or source projection changed. No source sense was dropped; every canonical source gloss for an edited group is retained in the resulting Meaning gloss.

| Measure | Before | After |
| --- | ---: | ---: |
| C18 Meaning rows | 15,434 | 14,776 |
| Lemmas with several Meanings | 2,096 | 1,836 |
| Rows in the 385 repartitioned lemmas | 1,309 | 651 |
| C18 lemmas | 11,571 | 11,571 |
| C18 duplicate adjudications | 2 | 2 |

## Boundary decisions

- **Polysemy merged across concrete, figurative, and technical uses:** `프로그램` (plan/order, broadcast sequence, computer instructions), `파도` (water, social, and psychological waves), and `피어나다` (flowering, smoke/fire, recovery, improvement, spreading, thoughts, and smiles). The source-specific wording remains in one gloss rather than being replaced by an invented shared definition.
- **`파가` and `파가하다`:** house demolition and the Go use that prevents an opponent's house from forming are treated as one lexical extension for each lemma. Both original source glosses are retained in each resulting Meaning. The separate household-use senses `w497887-s1` and `w354932-s1` were not reassessed in this follow-up.
- **Stage 2 source-bound overmerge follow-up:** `폐기` separates 廢氣 (engine exhaust) from 廢棄 (discarding or annulling); `피복` separates 被服 (clothing) from 被覆 (covering), while physical and topological 被覆 stay together; `피복선` separates 被覆線 (insulated wire) from 被覆船 (a copper-clad ship). `평시` separates 平時 as mean solar time from 平時 as ordinary time; their source-bound direct links point respectively to `평균 태양시` and `평상시`. `피아노` separates the Italian `piano` dynamic mark (`피아노02`, `p`) from the English `piano` instrument loan (`피아노01`), whose source direct link is to the instrument `강금`. This distinguishes two loans whose only present relation is a shared music context and historical form. The separate full Italian compound `피아노포르테` remains one Meaning: its source calls the instrument by that original name and also uses the full term for the matching `pf` direction. The final source-bound changes and retained glosses are recorded in the executable spec and residual audit. The same partial-component review also separates `포` (砲 weapon vs 包 chess piece), `필로` (筆勞 vs 筆路), `필부` (匹婦 vs 匹夫), `편벽하다` (偏僻 vs 便辟), `편사` (便私 vs 偏私), `폐사` (弊社 vs 弊舍), `폐장` (肺臟 vs 肺腸), `포루` (砲樓 vs 鋪樓), `표표하다` (表表 vs the floating/flapping group), `파다하다` (頗多 vs 播多), `파락`/`파락하다` (擺落 vs 破落), `파상설` (波狀雪 vs 波狀說), `파선` (波線 vs 擺線), and `표풍` (漂風 vs 飆風). The boundary tests exercise each split and retain source-bound positive controls for valid extensions.
- **Close same-class candidates retained after comparison:** `피모` keeps skin-and-hair with the body coat; `편면` keeps a specific striking face as a kind of one side; `폐관`, `폐교`, `폐업`, and `폐문` keep daily closure and lasting cessation within the same closure concept; `포장` keeps wrapping and containing/harboring; `포진` keeps military placement, spreading objects, and arranging floor seating; `포열` keeps general battle deployment and artillery deployment. Their source meanings show a natural semantic extension or the same concrete naming principle, rather than only a shared topic or one unrelated component.
- **Stage 2 scope control:** all 56 cross-record groups from the pre-follow-up head were rechecked against original STDICT records. The 39 groups still merged on `6faf03b5` were source-bound rechecked; three were split (`피복선`, `평시`, and `피아노`), leaving 20 splits and 36 retained groups. The 117 original records occur in four local source files (`1595832_395000.json`, `_400000.json`, `_405000.json`, `_410000.json`); each file's SHA-256 matches `data/provenance/stdict-source-inventory.json`. The downloaded source files themselves are not included in this PR. The focused group-by-group retention reasons are recorded below. This pass does not claim an exhaustive semantic review of the other C18 boundaries.
- **Retained cross-record groups after source-bound recheck:**
  - `피갑` (皮甲/被甲): leather armor, wearing armor, and an animal's protective shell share the armor/covering concept.
  - `피막` (皮膜/被膜): both forms name membrane-like coverings.
  - `피모` (皮毛/被毛): skin-and-hair and body coat share animal covering.
  - `피부` (皮部/皮膚): plant outer tissue and vertebrate skin share the biological exterior-tissue concept.
  - `피스톤`: an engine reciprocating part and a brass-instrument valve are piston mechanisms.
  - `피폐` (疲弊/疲斃): severe exhaustion and exhaustion unto death.
  - `필수` (必修/必須/必需): required study, necessity, and essential supplies share the concept of requirement.
  - `필화` (筆花/筆華): both forms describe literary brilliance.
  - `핑핑하다`: plump elasticity, tautness, and closely matched tension are related sensory uses.
  - `편독` (徧讀/遍讀): orthographic variants with the same reading and meaning.
  - `편면` (片面/鞭面): one face and a drum's striking face.
  - `편문` (便門/偏門): an access door characterized by convenience and a subordinate side door name the same secondary-entry family.
  - `편산` (遍山/遍散): spreading over a mountain and spreading widely.
  - `편심` (片心/偏心): one-sidedness, bias, and an off-center condition share the notion of deviation from center.
  - `평문` (平文): ordinary text and its unencrypted technical use.
  - `폐관` (閉館/廢館): daily closure and cessation of an institution's operation.
  - `폐교` (閉校/廢校): pausing classes and permanently abolishing a school.
  - `폐업` (閉業/廢業): ending the day's business and discontinuing the business.
  - `폐원` (閉院/閉園): daily closure and discontinuation of hospitals, academies, kindergartens, or zoos.
  - `폐문` (閉門/廢門): closing a door and putting it out of use, including figurative cessation of work.
  - `포` 包: a sack and the measure counted by that sack.
  - `포열` (布列/砲列): general formation and its artillery-formation subtype.
  - `포장` (包裝/包藏): wrapping, containing, and keeping within.
  - `포장` (褒奬/褒章): commendation and the badge awarded for merit.
  - `포진` (布陣/布陳/鋪陳): deploying troops, spreading objects, and laying out bedding share arranging or laying out.
  - `포함` (包涵/包含): encompassing and inclusion.
  - `폭발` (爆發/暴發): physical explosion and metaphorical emotional or event outburst.
  - `표석` (標石/表石): a marker stone and the specialized grave marker.
  - `표시등` (表示燈/標示燈): lights that indicate operating state or provide visual signs.
  - `표징` (表徵/標徵): closely synonymous forms for a sign or distinguishing indication.
  - `품` 品: material/person quality and a person's character share the quality/character concept.
  - `품` 品: rank and grade order use the same written word and concept.
  - `풍풍`: related impact, airflow, and liquid-flow sound symbolism.
  - `플레어`: lens flare and solar flare are bright-light phenomena.
  - `포로` (匏蘆/蒲盧): names and senses for the gourd plant and fruit.
  - `표식` (表式/標識): a way of indicating and its marker/redirect use.

  These retained source definitions show linked meanings, variants, category membership, or action/result relations; they do not rely on a shared unrelated component alone.
- **Shared physical image merged:** `파닥` and related flap-family lemmas bring together bird wings, fish tails, and fabric/flags moving in wind when the bound source glosses describe the same quick flapping motion. `풍차` merges the windmill and its child-sized pinwheel by their wind-driven rotating blades; the clothing senses remain separate, and `→ 풍구` remains its own source-bound group.
- **Same marker identity retained across a redirect:** `표식` combines “a fixed way of indicating something” with its `→ 표지03` cross-reference; the canonical `표지03` projection identifies the marking/distinguishing sense. Its exemplar of a type, fossil or relic remains separate.
- **Independent homonyms remain split:** `파랑` keeps waves apart from the blue color; `피로` keeps public display, capture, and pyrogallol separate while combining ordinary fatigue with material fatigue; unrelated referents and senses across `피치`, `피트`, `필`, and proper-name lemmas remain distinct. The full residual set and source IDs are listed in the residual audit.

## Validation and limits

The Meaning validator passes on the complete dataset. The edit spec covers every prior source-sense binding once for each repartition, and every resulting gloss contains every bound canonical source gloss. The two pre-existing duplicate drops (`w498155-s1` → `w498126-s6`, `w365419-s1` → `w365418-s1`) remain intact; canonical data and adjudications are unchanged.

This follow-up checked source Hanja, loan-language metadata, and source definitions in the original STDICT snapshot identified by repository provenance; no other dictionary or language model was used. The exact-coverage regression checks the 20 boundary splits and retained polysemy controls. Relation-projection regressions verify that `폐기`(廢氣) → `배기` stays off `폐기`(廢棄), `피복선`(被覆線)'s wire links do not project onto `피복선`(被覆船), `평시`'s direct links stay on the mean-solar and ordinary-time Meanings, and `피아노`'s instrument direct link stays off the dynamic-mark Meaning. Source IDs and contrasts are preserved so individual editorial boundaries remain reviewable.
