# STDICT 전량 canonical의 sense·동음이의어 분포와 뜻 중복 조사 (Issue #700)

읽기 전용 조사 보고서입니다. canonical, shard, ID, sense, gloss, 관계, provenance, SQLite, importer, 검색 런타임, UI는 바꾸지 않았고, 아래 수치는 일회성 집계 스크립트(부록 A)로 계산했습니다.

## 1. 기준과 분모

| 항목 | 값 |
| --- | --- |
| 실행 시점 master HEAD | `3964a9513cf204889f25f73226feb6a05d26aee9` (#678 최종 shard 421–428 병합 직후, `git ls-remote`로 확인) |
| 입력 | `data/canonical/stdict-0001.jsonl` … `stdict-0428.jsonl` (**428 shard**) |
| record (= 원본 entry, `id = w<target_code>`) | **427,583** (`entry` 353,251 / `expression` 74,332) |
| sense | **499,359** |
| lemma (distinct) | **357,919** |
| `data/provenance/stdict-settlement.json` 허용 집합 | included entry 427,583 / included sense 499,359로 **canonical과 일치** |

- 세 단위는 서로 다릅니다. record는 원본 entry, sense는 `<record id>-s<n>`(원본 순서, 제외된 sense는 번호 공백으로 남음), lemma는 정규화 표기이며 `lemma`는 모든 record에서 `search_forms[0]`과 같습니다(불일치 0).
- `search_forms`가 2개 이상인 record는 69,291건이지만 별칭이므로 표제어로 세지 않았습니다. 모든 lemma 집계는 `lemma` 필드만 사용합니다.
- 품사별 sense는 settlement 문서와 동일하므로 반복하지 않습니다. 모든 canonical record의 `role`은 `start`입니다.

## 2. 한 record 안의 sense 개수 (다의어)

| 구간 | record 수 | record 비율 | sense 수 | sense 비율 |
| --- | ---: | ---: | ---: | ---: |
| 1 | 375,810 | 87.89% | 375,810 | 75.26% |
| 2–3 | 47,584 | 11.13% | 102,527 | 20.53% |
| 4–9 | 4,026 | 0.94% | 18,697 | 3.74% |
| 10–19 | 139 | 0.033% | 1,685 | 0.34% |
| 20+ | 24 | 0.006% | 640 | 0.13% |

- `record_type` 별: `expression`은 10개 이상이 0건이고 4–9가 22건에 그칩니다. 10개 이상 163건(139+24)은 전부 `entry`입니다.
- 10개 이상 163건의 품사 구성(record 기준): 동사 102, 동사+형용사 6, 명사 24, 부사 23, 형용사 7, 감탄사+명사 1.
- 최고치: `하다`(w363685) 45, `보다`(w149229) 39, **`가다`(w707) 34**, `나다` 32, `내다` 31, `놓다`·`들다` 29, `잡다` 28, `떨어지다` 27.
- **`가다`(w707)** 는 canonical에서 실제로 **한 record에 sense 34개**(s1–s34, 결번 없음)입니다. 동사 기본어의 원본 뜻풀이 구조이며, **동일 record 내 복수 sense**로 분류합니다. 이 사실만으로 오류나 중복이라고 판정하지 않습니다. 34개 gloss를 전수로 읽으면 이동(s1·s3·s4·s30·s33), 작동(s12·s21), 상태 변화(s9·s27·s28), 완곡 사망(s24), 보조적 용법(s34) 등 서로 다른 축이며 같은 글이 반복되지는 않습니다. 다만 한 화면에 모두 나열하면 길어지는 것은 사실입니다.

## 3. 동일 lemma의 복수 record (동형이의어)

lemma별 record 수:

| record 수 | 표기 그룹 수 | 그룹 비율 | 그룹에 속한 record | record 비율 |
| --- | ---: | ---: | ---: | ---: |
| 1 | 323,118 | 90.28% | 323,118 | 75.57% |
| 2–3 | 27,550 | 7.70% | 61,884 | 14.47% |
| 4–9 | 6,611 | 1.85% | 34,102 | 7.98% |
| 10–19 | 589 | 0.16% | 7,264 | 1.70% |
| 20+ | 51 | 0.014% | 1,215 | 0.28% |

복수 record 그룹은 34,801개이며, 소속 record는 **104,465건(24.4%)** 입니다. 상위: `조사` 32, `사장` 31, `사` 30, `비`·`전`·`장` 29, `진`·`고사`·`기`·`사사` 28.

실제 검색 UI가 마주치는 **lemma 전체 sense 수**(다의어×동음이의어 합산):

| lemma 안 sense 수 | lemma 수 | 소속 record | 소속 sense |
| --- | ---: | ---: | ---: |
| 1 | 290,875 | 290,875 | 290,875 |
| 2–3 | 52,114 | 78,367 | 116,826 |
| 4–9 | 13,290 | 43,628 | 68,303 |
| 10–19 | 1,430 | 11,534 | 17,789 |
| 20+ | 210 | 3,179 | 5,566 |

상위: `사` 54(30 record), `치다` 51(13), `진`·`정`·`장` 47, `전` 45, `하다` 45(1), `뜨다` 43(13). 10개 이상인 lemma는 1,640개, 그중 20개 이상은 210개입니다. 즉 한 record의 다의성(163건)보다 **동형이의어 합산로 인한 과밀(1,640 lemma)** 이 10배 가까이 넓습니다.

동형이의어 구분 신호: 복수 record lemma 34,801개 중 record들의 품사 서명(sense 품사 집합)이 모두 같은 것이 32,159개(92.4%), 다른 것이 2,642개(7.6%)입니다. 품사만으로는 대부분 구분되지 않습니다.

**`사전`** 은 canonical에 **22 record**가 있고 모두 서로 다른 `target_code`(w164474–w164510 구간 13건, w173019–w173021 3건, w438466–w438470 5건, w444090)입니다. 대표 gloss를 읽으면 전부 별개 동음이의어입니다.

| record | sense | 대표 gloss |
| --- | ---: | --- |
| w438470 | 1 | 낱말을 모아서 일정한 순서로 배열하고 발음·의미·어원·용법 따위를 해설한 책 (辭典) |
| w438466 | 1 | 여러 가지 사항을 모아 일정한 순서로 배열하고 각각에 해설을 붙인 책 (事典) |
| w164474 | 1 | 살아 있는 동안 |
| w438467 | 1 | 스승으로부터 전하여 받음 |
| w438468 | 1 | 국가적인 경사 때 죄인을 용서하던 일 |
| w164504 | 1 | 일이 일어나기 전 |
| w164477 | 2 | 개인 소유의 논밭 |
| w164509 | 1 | 작은 규모로 물건을 파는 집 |
| w173020 | 2 | 역사와 전기를 아울러 이르는 말 |
| w444090 | 1 | 신라에서 사찰에 관한 일을 맡아보던 관아 |

나머지 12건(w164475, w164478–w164479, w164502–w164503, w164505–w164506, w164508, w164510, w173019, w173021, w438469)도 각기 다른 한자어이며, 사전(辭典)·사전(事典)을 포함해 **중복 의심 record는 없었습니다**. 사용자에게 "사전이 반복된다"로 보이는 문제는 중복이 아니라 **구별 단서 없는 동음이의어 나열**입니다.

## 4. 뜻풀이 중복·유사성

모든 비교는 공백 정규화 후 문자열 일치, 또는 한글·영숫자 2-gram Jaccard(결정적 지표)입니다. **의미 동일 판정이나 병합 규칙이 아니며 후보 검출용**입니다.

### 4.1 정확히 같은 gloss (측정치)

| 구분 | 건수 |
| --- | --- |
| 한 record 내부에서 같은 gloss가 반복되는 record | **16** (gloss 그룹 17, sense 34) |
| 위 그룹 중 관계(`direct`/`antonym`, 출·입) 보유 | 1 |
| 같은 lemma의 서로 다른 record 사이 같은 gloss | **141 그룹 / 134 lemma / 276 record** |
| 위 그룹 중 관계 보유 sense가 포함된 그룹 | 134 / 141 |
| (참고) 서로 다른 lemma 포함 전체에서 2회 이상 나오는 gloss 종류 | 61,586 |

- record 내부 중복 16건은 소수이며, 예시(`둘찌`, `두째`, `졸립다`, `가루`, `각히`, `거시키`, `네째`)의 gloss가 `→ .` 또는 `‘’의 본말.`입니다. 원본의 참조 대상이 정규화에서 비어 사라진 **참조형 gloss 변환 문제 가능성**이 높습니다(미확인: 원본 JSON 대조는 하지 않음).
- 같은 lemma·같은 gloss의 서로 다른 record 141 그룹은 대부분 서로 동의어 링크로 연결된 쌍으로 보입니다(예: `전락하다`, `천수`, `강병`). 관계 보유 비율이 매우 높으므로 **묶거나 숨기면 `target_sense` 결합이 손상될 위험**이 큽니다. (링크가 정확히 그 쌍을 잇는지는 전수 확인하지 않았습니다.)
- 참고: gloss가 `→`로 시작하는 순수 참조 sense가 8,617건(51건은 `→ .`처럼 대상이 비어 있음), `…의 준말/본말/원말` 등 참조형이 약 4,018건입니다. 중복과는 별개로 팝업에서 뜻이 보이지 않는 표시 품질 이슈입니다.

### 4.2 유사하지만 다른 gloss (후보, 측정치 아님)

임계값은 품질 기준이 아니라 후보 폭을 보기 위한 표시용입니다.

| Jaccard ≥ | 한 record 내부 쌍 (record) | 같은 lemma 다른 record 쌍 (lemma) |
| --- | ---: | ---: |
| 0.50 | 6,268 (3,860) | 665 (533) |
| 0.70 | 2,168 (1,820) | 135 (122) |
| 0.85 | 1,518 (1,349) | 13 (13) |

관계 보유 쌍은 record 내부 664/295/124, lemma 간 149/41/7입니다(0.50/0.70/0.85 순). 한 lemma에 sense가 400개를 넘는 그룹은 없어 건너뛴 그룹은 없습니다.

### 4.3 층화 소표본 (조사용, 전체 건수로 확대 금지)

고정 시드로 위험군별 무작위 추출 후 gloss·품사·ID를 직접 읽었습니다. 분류: (a) 진짜 중복 가능성, (b) 유의미한 용법/의미 차이, (c) 별개 동음이의어, (d) 불명확.

| 위험군 | 표본 | (a) | (b) | (c) | (d) | 관찰 |
| --- | ---: | ---: | ---: | ---: | ---: | --- |
| record 내부 유사(≥0.7) | 12 | 9 | 3 | 0 | 0 | (a)는 `교훈적`, `기능적`, `관조적`, `단속적`, `독창적`, `가족적`, `대여섯째`, `자`, `도식주의적`처럼 `…것.` / `….`로 끝만 다른 쌍(관형사·명사 용법 분리). (b)는 `궁관`(동궁 vs 궁전)과 `걷다`·`갈앉히다`의 준말 참조(참조 대상 번호가 다름). |
| 같은 lemma 다른 record 유사(≥0.7) | 12 | 0 | 0 | 11 | 1 | `중장년`(중년01/장년01 vs 02), `경문`(화성/금성), `개원`(院/園), `정자형`(丁/井), `이성`, `호박색`, `주간지`(잡지/신문) 등은 한 글자 차이로 뜻이 다름. `순근하다`(순수/순박)는 (d). |
| 같은 lemma 다른 record 같은 gloss | 10 | 10 | 0 | 0 | 0 | `전락하다`, `전질하다`, `천수`, `지향성`, `집주하다`, `전락`, `강병`, `반기`, `구수`, `육부` 모두 gloss가 같고 관계 보유. 같은 단어가 원본에서 한자·어형 근거로 분리된 것으로 보입니다(한자 병기는 canonical에 없어 근거 확인 불가). |
| 다의어 ≥20 (record) | 전수 24개 중 `가다` 34 sense 전수 읽음 | 0 | 34 | 0 | 0 | 같은 글 반복 없음. 용법이 달라 분리 유지가 타당. |
| 다의어 10+ 비동사 | 3 (`축`, `길`, `쭉쭉`) | 0 | 3 | 0 | 0 | 의미/용법 차이이며 `쭉쭉`은 `죽죽` 대응 gloss 형식만 반복. |
| 동형이의어 20+ record | 3 (`기수`, `정사`, `정`) | 0 | 0 | 3 | 0 | 같은 표기·품사지만 전혀 다른 어휘(한자어 동음). |

표본이 작고 층화이므로 위 비율은 전체 중복 건수의 추정치로 쓰지 않습니다. 정성적으로 확인된 것은 세 가지입니다.

1. 같은 lemma의 다른 record는 gloss가 다르면 거의 항상 별개 어휘입니다.
2. 같은 lemma·같은 gloss의 다른 record는 중복처럼 보여도 대부분 관계가 붙어 있고, 구별 근거(한자·번호)가 canonical에 없습니다.
3. record 내부의 `-적`·`-하다` 계열 반복(끝 `것.`/`.` 차이)은 규칙으로 잡히는 유형이 뚜렷합니다.

## 5. 후속 선택을 위한 판단표

작업량은 두 갈래로 분리합니다. 아래 수치 중 *측정치*는 위 표 값이고 *추정치*는 표시했습니다.

| 작업 | 대상 | 규모 | 구분 |
| --- | --- | --- | --- |
| A. 실제 병합·그룹핑 검토 후보 | record 내부 정확 중복 | 16 record / 17 그룹 | 측정치 (대부분 `→ .` 참조 변환 문제 의심) |
| | lemma 내 정확히 같은 gloss의 다른 record | 141 그룹 / 134 lemma | 측정치, 관계 보유 134 |
| | record 내부 유사(≥0.85) | 1,349 record | 측정치(후보), 표본상 `…것.`/`.` 유형이 다수 → 규칙화 후보 |
| | lemma 간 유사(≥0.7) | 122 lemma | 측정치(후보), 표본상 대부분 별개 동음이의어 → 병합 부적합 |
| | 다의어 10+ 의 gloss 정리 | 163 record | 측정치, 표본상 중복 아님 → 병합 대상 아님 |
| B. 식별 UI 문제 | 복수 record lemma | 34,801 lemma / 104,465 record | 측정치 |
| | lemma 전체 sense 10+ | 1,640 lemma (20+는 210) | 측정치 |
| | 동형이의어 구별 단서 부족 (품사 동일) | 32,159 lemma | 측정치 |
| | 참조형 gloss (`→ …`, 준말/본말 등) | 약 8,617 + 4,018 sense | 측정치(패턴 기반, 정확도 미검증) |

**추천: 혼합.** 근거는 다음과 같습니다.

- 소량 수작업 범위: 정확 중복 record 16건과 같은 lemma 내 정확 동일 gloss 141 그룹처럼 수백 건 이하이고 위험이 큰(관계 결합) 항목은 사람이 한 건씩 확인할 만합니다. 병합·숨김은 `target_sense` 결합을 유지하는 방식이어야 합니다.
- 공통 규칙 범위: UI 과밀은 34,801개 lemma, 1,640개 긴 lemma, 12,600여 개 참조형 gloss처럼 수만 건에 걸치므로 수작업이 불가능합니다. 구별 단서(원본 동음이의 번호·한자 병기 등 canonical에 없는 정보) 노출, 긴 목록 접기, 참조형 gloss의 대상 표시는 **표시 계층의 공통 규칙**이 적합합니다. 데이터 병합 규칙으로는 삼지 않습니다.
- 유사 gloss 후보를 자동 병합하는 것은 추천하지 않습니다. 표본에서 lemma 간 유사 쌍 12건 중 11건이 별개 동음이의어였습니다.
- 임의 임계값을 품질 기준으로 선언하지 않았고, 최종 선택은 소유자에게 있습니다.

## 6. 미확인 사항

- 원본 STDICT JSON과의 재대조(참조형 gloss `→ .` 변환 원인, 동형이의어 원본 번호 `01/02` 및 한자 병기의 canonical 부재)는 하지 않았습니다.
- 정확 동일 gloss 쌍이 실제로 관계로 서로 연결된 쌍인지 전수 확인하지 않았습니다.
- 표본은 소규모 층화 표본이며(`가다` 전수 읽기 제외 약 40건) 전체 비율 추정에 쓸 수 없습니다.
- 유사 gloss 후보는 2-gram Jaccard 한 가지 지표에 의존하며 의미 판정이 아닙니다.
- 참조형 gloss 수는 정규식 기반 근사입니다.
- 검색 런타임의 실제 후보 메뉴 길이(랭킹·필터 적용 후)는 측정하지 않았고, canonical 기준 lemma 합산값만 제시했습니다.

## 부록 A. 재현 절차

저장소에 스크립트를 추가하지 않았습니다. 부록 B의 스크립트를 저장소 밖 임시 위치에 저장하고 다음 명령으로 실행하면 §2–§4의 수치가 나옵니다(약 5초).

```sh
node --max-old-space-size=6000 /path/to/census.mjs data/canonical /path/to/census.json
```

입력 확인: `data/provenance/stdict-settlement.json`의 `entries.by_status.included` = 427,583, `senses.by_status.included` = 499,359가 스크립트의 `records`·`senses` 출력과 같아야 합니다. 층화 표본은 같은 canonical에서 고정 시드(LCG, seed 7)로 추출했습니다.

핵심 집계 로직:

- record = 각 JSONL 줄, sense = `senses[]`, lemma 그룹 = `lemma` 문자열.
- 구간 = 1 / 2–3 / 4–9 / 10–19 / 20+, sense 개수는 `senses.length`, lemma 그룹 크기는 record 수 또는 sense 합.
- gloss 비교는 `replace(/\s+/g,' ').trim()` 후 문자열 일치.
- 유사도는 `[^가-힣A-Za-z0-9]` 제거 후 문자 2-gram 집합의 Jaccard, 같은 record 내부와 같은 lemma 그룹 내부에서만 쌍을 비교합니다.
- 관계 보유: sense의 `relations` 비어 있지 않음, 또는 다른 sense의 `relations[].target_sense`가 이 sense를 가리킴.

## 부록 B. 일회성 집계 스크립트 (저장소에는 추가하지 않음)

```js
// One-off read-only census over data/canonical/stdict-*.jsonl (issue #700).
import fs from 'node:fs';
import path from 'node:path';
const dir = process.argv[2];
const files = fs.readdirSync(dir).filter((f) => /^stdict-\d+\.jsonl$/.test(f)).sort();
const recs = [];
for (const f of files) for (const l of fs.readFileSync(path.join(dir, f), 'utf8').split('\n')) if (l) recs.push(JSON.parse(l));
const out = { shards: files.length, records: recs.length };
let senseTotal = 0;
const incoming = new Set();
for (const r of recs) { senseTotal += r.senses.length; for (const s of r.senses) for (const x of s.relations || []) incoming.add(x.target_sense); }
out.senses = senseTotal;
const bucket = (n) => (n === 1 ? '1' : n <= 3 ? '2-3' : n <= 9 ? '4-9' : n <= 19 ? '10-19' : '20+');
const B = ['1', '2-3', '4-9', '10-19', '20+'];
const mk = () => Object.fromEntries(B.map((b) => [b, { n: 0, senses: 0 }]));
const hasRel = (s) => (s.relations && s.relations.length) || incoming.has(s.id);
// 2. senses per record
const dist = mk(), byType = {}, byPos = {};
for (const r of recs) {
  const b = bucket(r.senses.length); dist[b].n++; dist[b].senses += r.senses.length;
  const t = r.record_type; byType[t] ??= mk(); byType[t][b].n++; byType[t][b].senses += r.senses.length;
  if (r.senses.length >= 10) { const p = [...new Set(r.senses.map((s) => s.pos))].sort().join('+'); byPos[p] = (byPos[p] || 0) + 1; }
}
out.sensesPerRecord = dist; out.sensesPerRecordByType = byType; out.ge10ByPos = byPos;
const sorted = [...recs].sort((a, b) => b.senses.length - a.senses.length);
out.topSenses = sorted.slice(0, 15).map((r) => [r.id, r.lemma, r.senses.length]);
out.ge10 = recs.filter((r) => r.senses.length >= 10).length; out.ge20 = recs.filter((r) => r.senses.length >= 20).length;
// 3. homonyms
const groups = new Map();
for (const r of recs) { if (!groups.has(r.lemma)) groups.set(r.lemma, []); groups.get(r.lemma).push(r); }
out.lemmas = groups.size;
const gd = Object.fromEntries(B.map((b) => [b, { groups: 0, records: 0, senses: 0 }]));
const gs = Object.fromEntries(B.map((b) => [b, { groups: 0, records: 0, senses: 0 }]));
const posMix = { multiRecordGroups: 0 };
for (const [l, rs] of groups) {
  const b = bucket(rs.length); gd[b].groups++; gd[b].records += rs.length;
  const sc = rs.reduce((a, r) => a + r.senses.length, 0); gd[b].senses += sc;
  const b2 = bucket(sc); gs[b2].groups++; gs[b2].records += rs.length; gs[b2].senses += sc;
}
out.recordsPerLemma = gd; out.sensesPerLemma = gs;
out.topLemmaRecords = [...groups].sort((a, b) => b[1].length - a[1].length).slice(0, 15).map(([l, rs]) => [l, rs.length, rs.reduce((a, r) => a + r.senses.length, 0)]);
out.topLemmaSenses = [...groups].sort((a, b) => b[1].reduce((x, r) => x + r.senses.length, 0) - a[1].reduce((x, r) => x + r.senses.length, 0)).slice(0, 15).map(([l, rs]) => [l, rs.length, rs.reduce((a, r) => a + r.senses.length, 0)]);
// lemma != search_forms[0]?
out.searchFormsExtra = recs.filter((r) => r.search_forms.length > 1).length;
out.lemmaNotFirstForm = recs.filter((r) => r.search_forms[0] !== r.lemma).length;
// 4. gloss duplicates
const norm = (g) => g.replace(/\s+/g, ' ').trim();
let intraRecs = 0, intraPairs = 0, intraSenses = 0, intraRelSenses = 0; const intraEx = [];
for (const r of recs) {
  const m = new Map(); for (const s of r.senses) { const g = norm(s.gloss); if (!m.has(g)) m.set(g, []); m.get(g).push(s); }
  let hit = false;
  for (const [g, ss] of m) if (ss.length > 1) { hit = true; intraPairs++; intraSenses += ss.length; if (ss.some(hasRel)) intraRelSenses++; if (intraEx.length < 8) intraEx.push([r.id, r.lemma, g.slice(0, 50), ss.length]); }
  if (hit) intraRecs++;
}
out.intraRecordExactGloss = { records: intraRecs, glossGroups: intraPairs, senses: intraSenses, groupsWithRelation: intraRelSenses, examples: intraEx };
// same lemma, different records, identical gloss
let crossGroups = 0, crossLemmas = 0, crossRecs = 0, crossRel = 0; const crossEx = []; const crossLemSet = new Set();
const crossRecSet = new Set();
for (const [l, rs] of groups) {
  if (rs.length < 2) continue;
  const m = new Map();
  for (const r of rs) for (const s of r.senses) { const g = norm(s.gloss); if (!m.has(g)) m.set(g, []); m.get(g).push([r, s]); }
  for (const [g, xs] of m) { const ids = new Set(xs.map((x) => x[0].id)); if (ids.size > 1) { crossGroups++; crossLemSet.add(l); ids.forEach((i) => crossRecSet.add(i)); if (xs.some((x) => hasRel(x[1]))) crossRel++; if (crossEx.length < 8) crossEx.push([l, [...ids], g.slice(0, 50)]); } }
}
out.crossRecordSameLemmaExactGloss = { glossGroups: crossGroups, lemmas: crossLemSet.size, records: crossRecSet.size, groupsWithRelation: crossRel, examples: crossEx };
// identical gloss anywhere across different lemmas (info only)
const allG = new Map(); for (const r of recs) for (const s of r.senses) { const g = norm(s.gloss); allG.set(g, (allG.get(g) || 0) + 1); }
out.globalGlossRepeats = { distinctGlossesRepeated: [...allG.values()].filter((v) => v > 1).length };
// similar-gloss candidates (deterministic bigram Jaccard) within records and within same-lemma groups
const bg = (g) => { const t = g.replace(/[^가-힣A-Za-z0-9]/g, ''); const s = new Set(); for (let i = 0; i < t.length - 1; i++) s.add(t.slice(i, i + 2)); return s; };
const jac = (a, b) => { if (!a.size || !b.size) return 0; let i = 0; for (const x of a) if (b.has(x)) i++; return i / (a.size + b.size - i); };
const TH = [0.5, 0.7, 0.85];
const simIntra = { recs: [new Set(), new Set(), new Set()], pairs: [0, 0, 0] }, simCross = { lemmas: [new Set(), new Set(), new Set()], pairs: [0, 0, 0] };
const simIntraRel = [0, 0, 0], simCrossRel = [0, 0, 0]; const simEx = { intra: [], cross: [] };
for (const [l, rs] of groups) {
  const items = []; for (const r of rs) for (const s of r.senses) { const g = norm(s.gloss); items.push({ r, s, g, b: bg(g) }); }
  if (items.length > 400) { out.skippedLargeGroups = (out.skippedLargeGroups || []).concat([[l, items.length]]); continue; }
  for (let i = 0; i < items.length; i++) for (let j = i + 1; j < items.length; j++) {
    const a = items[i], b = items[j]; if (a.g === b.g) continue;
    const jv = jac(a.b, b.b); if (jv < TH[0]) continue;
    const same = a.r === b.r; const tgt = same ? simIntra : simCross; const relc = same ? simIntraRel : simCrossRel;
    const rel = hasRel(a.s) || hasRel(b.s);
    for (let t = 0; t < 3; t++) if (jv >= TH[t]) { tgt.pairs[t]++; relc[t] += rel ? 1 : 0; (same ? tgt.recs : tgt.lemmas)[t].add(same ? a.r.id : l); }
    if (jv >= 0.7 && simEx[same ? 'intra' : 'cross'].length < 400) simEx[same ? 'intra' : 'cross'].push([l, a.s.id, b.s.id, +jv.toFixed(2), a.g.slice(0, 60), b.g.slice(0, 60), rel]);
  }
}
out.similarGlossCandidates = { thresholds: TH, intraRecord: { pairs: simIntra.pairs, records: simIntra.recs.map((s) => s.size), pairsWithRelation: simIntraRel }, crossRecordSameLemma: { pairs: simCross.pairs, lemmas: simCross.lemmas.map((s) => s.size), pairsWithRelation: simCrossRel } };
// relations on risk groups
let ge10rel = 0, ge10s = 0, ge10relS = 0; for (const r of recs) if (r.senses.length >= 10) { ge10s += r.senses.length; ge10relS += r.senses.filter(hasRel).length; ge10rel += r.senses.some(hasRel) ? 1 : 0; }
out.relationsOnGe10 = { records: out.ge10, recordsWithRel: ge10rel, senses: ge10s, sensesWithRel: ge10relS };
let hom = 0, homRel = 0, homS = 0; for (const rs of groups.values()) if (rs.length > 1) for (const r of rs) { hom++; homS += r.senses.length; homRel += r.senses.filter(hasRel).length; }
out.relationsOnMultiRecordLemmas = { records: hom, senses: homS, sensesWithRel: homRel };
out.record_type_counts = {}; for (const r of recs) out.record_type_counts[r.record_type] = (out.record_type_counts[r.record_type] || 0) + 1;
// homonym pos composition: multi-record lemmas whose records share identical single pos vs differ
let samePos = 0, diffPos = 0; for (const rs of groups.values()) if (rs.length > 1) { const p = new Set(rs.map((r) => [...new Set(r.senses.map((s) => s.pos))].sort().join('+'))); p.size === 1 ? samePos++ : diffPos++; }
out.multiRecordLemmaPos = { samePosSignature: samePos, differentPosSignature: diffPos };
// saved for sampling
fs.writeFileSync(process.argv[3], JSON.stringify({ out, simEx }, null, 1));
console.log(JSON.stringify(out, null, 1));
```
