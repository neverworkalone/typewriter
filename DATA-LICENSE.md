# Typewriter dictionary data license

## Dictionary data: CC BY-SA 2.0 Korea

Typewriter dictionary data based on the National Institute of Korean Language
(NIKL) dictionaries **표준국어대사전 (Standard Korean Language Dictionary)**,
**한국어기초사전 (Korean Basic Dictionary)**, and **우리말샘 (Open Korean
Dictionary)**, together with Typewriter-authored **말의 결 / 연상** lexical
enrichment, is provided under the
[Creative Commons Attribution–ShareAlike 2.0 Korea license (CC BY-SA 2.0 KR)](https://creativecommons.org/licenses/by-sa/2.0/kr/).

The NIKL dictionaries' eligible content is reused under each official source's
copyright policy. NIKL retains its rights to its source materials; Typewriter
licenses only its own original contributions under the same terms, to the extent
it owns or controls the relevant rights. This data policy covers licensed
dictionary content in canonical JSONL, generated `dictionary.sqlite`, and
dictionary data bundled in the Chrome Extension or web products. The separate
software in those products remains under Apache 2.0 (see [LICENSE.md](LICENSE.md)).

Commercial use and redistribution are permitted subject to attribution and
ShareAlike. Redistributors must credit the relevant original source(s), provide
the applicable license link, and indicate changes. Adaptations distributed as
derivative works must comply with ShareAlike. The project adds no separate
non-commercial, no-AI, or non-competition restriction to licensed dictionary data.

## Dictionary sources and attribution

| Source | Provider | Official site | Copyright policy |
| --- | --- | --- | --- |
| 표준국어대사전 (STDICT) | 국립국어원 | https://stdict.korean.go.kr/ | https://stdict.korean.go.kr/join/copyrightPolicy.do |
| 한국어기초사전 (KRDICT) | 국립국어원 | https://krdict.korean.go.kr/ | https://krdict.korean.go.kr/kor/kboardPolicy/copyRightTermsInfo |
| 우리말샘 | 국립국어원 | https://opendict.korean.go.kr/ | https://opendict.korean.go.kr/service/copyrightPolicy |

For eligible materials without a separately stated license, the listed
dictionary policies provide **CC BY-SA 2.0 대한민국**:
https://creativecommons.org/licenses/by-sa/2.0/kr/

Suggested attribution wording for Typewriter dictionary distributions:

> 사전 자료 출처: 국립국어원 『표준국어대사전』
> (https://stdict.korean.go.kr/), 『한국어기초사전』
> (https://krdict.korean.go.kr/), 『우리말샘』
> (https://opendict.korean.go.kr/).
> 라이선스: 저작자표시-동일조건변경허락 2.0 대한민국
> (https://creativecommons.org/licenses/by-sa/2.0/kr/).
> Typewriter는 사전 자료의 표제어·뜻풀이·어휘 관계를 선별·정규화하고
> 자체 작성한 말의 결·연상 관계를 추가합니다.

For a particular distribution, the attribution should accurately identify
the sources actually represented in the distributed content and any changes
made. Downstream distributors must preserve the required source credits and
indicate their own modifications. The Typewriter/ Never Work Alone names,
logos, and visual identities do not receive a trademark or brand license
through this data grant.

## Licensed data scope and exclusions

Eligible NIKL dictionary headwords, parts of speech, sense definitions, and
licensed sense-level links may be selected, normalized, and included in
canonical data. Typewriter-specific enrichment is authored and reviewed
independently, under the same data license.

Source-attributed example passages and multimedia (images, audio, video,
pronunciation recordings) must **not** be assumed to carry the general
dictionary-text license; use them only with separately verified permission.
Any content explicitly marked with different terms follows those terms.
Downloaded bulk JSON files and raw API responses remain outside Git and
product distributions. A licensed, selected canonical projection is distinct
from publishing the raw download.

Other external dictionaries, scraped pages, protected examples, or content
whose terms prohibit redistribution are not approved by this policy.
Reformatting or paraphrasing restricted content does not override its terms.
Check the actual downloaded datasets for source-specific exceptions before
redistributing selected content.

## NIKL Written Corpus 2025 is a separate source

The NIKL **문어 말뭉치 2025(1.0)** has its own research/reference and
result-publication permission records, described in
[docs/external-material-review-written-corpus-2025.md](docs/external-material-review-written-corpus-2025.md).
That approval concerns the **submitted Typewriter result**, not a general
license to redistribute the corpus and not the permission basis for the three
NIKL dictionaries listed above.

Do not publish the raw written corpus, its passages or excerpts, or local
corpus SQLite/FTS or morphology indexes in Git, a generated dictionary, an
extension package, or a web distribution. Keep its existing attribution and
approval-specific conditions separate from the STDICT data license.

## Release boundary

Include applicable source and Typewriter credits, link the CC BY-SA 2.0 KR
license, verify source-specific exceptions, and provide user-accessible notices
in the extension and web distributions. Maintain normal exact-revision and
package-content checks.
