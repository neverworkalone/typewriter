# Typewriter dictionary data license

## New STDICT-based dictionary

The **new** Typewriter dictionary baseline, built from the National Institute of
Korean Language's **표준국어대사전 (Standard Korean Language Dictionary, STDICT)**,
and the original Typewriter **말의 결 / 연상** enrichments added to it will be
distributed under the
[Creative Commons Attribution–ShareAlike 2.0 Korea license (CC BY-SA 2.0 KR)](https://creativecommons.org/licenses/by-sa/2.0/kr/).

The official dictionary's eligible text is used under the NIKL
[STDICT copyright policy](https://stdict.korean.go.kr/join/copyrightPolicy.do).
Typewriter licenses its own original contributions on the same terms to the
extent it owns or controls those rights; it does not claim ownership of NIKL
source content. Covered lexical content in canonical JSONL, the generated
`dictionary.sqlite`, and dictionary data included in Chrome Extension and web
distributions follows this data license. Software in those distributions
remains separately licensed under Apache 2.0 (see [LICENSE.md](LICENSE.md)).

Commercial use and redistribution are permitted under the license. Redistributors
must provide appropriate attribution, a link to the license, and indicate relevant
adaptations; adaptations shared as derivative works must comply with the
ShareAlike terms. No separate non-commercial, no-AI, or competitor restriction
is added to the covered dictionary content.

This policy applies to the **new STDICT-derived baseline and its future
enrichment**; it does not claim that the still-unreplaced dataset or any
previously released data has already been replaced, or revoke existing license
grants.

## Source, modifications, and attribution

- **Source:** 국립국어원, **표준국어대사전**.
  https://stdict.korean.go.kr/
- **Source copyright policy:** https://stdict.korean.go.kr/join/copyrightPolicy.do
- **License:** CC BY-SA 2.0 대한민국.
  https://creativecommons.org/licenses/by-sa/2.0/kr/
- **Typewriter modifications (when the new baseline is built):** select
  product-needed text fields; normalize headword/search forms; map source
  entries, meanings, and licensed synonym/antonym links into the Typewriter
  canonical model; add separately authored 말의 결 and 연상 relationships.

Suggested attribution for a distribution **containing the new baseline**:

> 사전 기본 자료: 국립국어원 『표준국어대사전』
> (https://stdict.korean.go.kr/).
> 저작자표시-동일조건변경허락 2.0 대한민국
> (https://creativecommons.org/licenses/by-sa/2.0/kr/).
> Typewriter에서 표제어·뜻풀이·관계 정보를 선별·정규화하고,
> 자체 작성한 말의 결·연상 관계를 추가하였습니다.

A downstream distributor should preserve source attribution and give notice
of its own changes. The Typewriter name, logos, and visual identity do not
receive a trademark or brand license through this data grant.

## What may be included

The planned STDICT baseline may contain licensed headwords, parts of speech,
sense definitions, and licensed sense-bound lexical links needed by Typewriter.
It must **not** copy source-attributed example passages or multimedia
(images, audio, video, pronunciation recordings) merely because the main
dictionary text uses CC BY-SA; those materials can carry **separate rights**.
Material expressly marked with different terms remains governed by those terms.
The bulk downloaded source files/API responses remain outside Git; publishing
the selected, licensed canonical projection is distinct from publishing the raw
download.

Other external dictionaries, scraped pages, protected examples, or material
whose terms prohibit the intended redistribution are **not** approved for import
by this decision. Formatting or paraphrasing does not override those rights.
Check source-specific exceptions before the STDICT import is distributed; this
policy alone does not assert that the new corpus is already packaged or shipped.

## NIKL Written Corpus 2025 is a separate source

The NIKL **문어 말뭉치 2025(1.0)** has its own research/reference and
result-publication permission records, described in
[docs/external-material-review-written-corpus-2025.md](docs/external-material-review-written-corpus-2025.md).
That approval concerns the **submitted Typewriter result**, not a general
license to redistribute the corpus and not the permission basis for STDICT.

Do not publish the raw written corpus, its passages or excerpts, or local
corpus SQLite/FTS or morphology indexes in Git, a generated dictionary, an
extension package, or a web distribution. Keep its existing attribution and
approval-specific conditions separate from the STDICT data license.

## Release boundary

Before shipping the new STDICT-backed product, publish the applicable NIKL
and Typewriter credits, link the CC BY-SA 2.0 KR license, verify source-specific
exclusions, and include the notices in the actual extension or web distribution
where users can find them. Maintain normal exact-revision package checks;
this policy change does not itself constitute a shipped data migration.
