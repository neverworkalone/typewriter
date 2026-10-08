# 관계 후보 검색 (Issue #397)

Stage 2가 전체 사전을 읽지 않고 제한된 후보 목록만 검토하도록, 현재 canonical에서 관계 대상 후보를 기계적으로 찾는 결정론적 검색 계층이다. 구현: `scripts/relation/candidate-retrieval.mjs`.

## 권한 경계

- 산출물은 `authority: candidates_only`다. 관계 유효성, 관계 유형, `relevance`, note를 판단하지 않고 canonical을 바꾸지 않으며 역방향 간선·관계 쿼터를 만들지 않는다.
- 내부 유사도 점수는 후보 정렬에만 쓰이고 산출물에 기록하지 않는다(`rank`와 신호 코드만 남는다). 검증기는 `score/type/relevance/note` 필드를 거부한다.

## 입력과 신호

원천은 canonical 의미(sense) 또는 같은 배치의 임시(provisional) 의미(`provisional:<batch>/<candidate>/<sense_key>`, 최종 canonical ID를 만들지 않음). 신호 코드: `explicit_hint`, `relation_neighbor_of_hint`, `relation_neighbor_of_related`, `incoming_relation`, `shared_search_form`, `lemma_in_target_gloss`, `target_lemma_in_gloss`, `gloss_overlap`(lemma+gloss 문자 2-gram IDF 코사인), `literature_cooccurrence`.

- 힌트(writer-route/review 메타데이터)는 신호일 뿐이며 해석되지 않는 힌트는 아무것도 더하지 않는다.
- 문학 근거는 #391/#392 검색기의 문맥을 메모리에서만 훑고, 산출물에는 `location_digest`만 남긴다. 문학 무히트는 음성 근거가 아니다(`no_hit_is_negative_evidence: false`).
- 원천 의미와 자기 엔트리의 다른 의미, 이미 관계가 있는 대상은 제외한다. 대상의 POS와 sense 식별자는 보존한다(POS로 거르지 않음).

## 규모

canonical을 배치/세션당 한 번 `buildRelationIndex`로 색인하고 모든 원천에 재사용한다. 모델에 전체 canonical을 보내지 않는다. 후보 풀 한도(`max_candidates` 기본 200 = 탐색 UI 100개의 2배)와 임계값은 설정이며 어휘 진실이 아니다. 현재 ~12.6K sense 실측: 색인 약 0.1–0.2초, 원천당 약 2–3ms. 벡터 DB는 도입하지 않는다.

## 산출물

`contract`(`relation-candidate-retrieval-v1`), `canonical_snapshot_digest`, `config`, 원천별 `candidates[{rank, target{kind, record_id|provisional_id, sense_id, pos}, signals, literature_location_digests?}]`. `validateRelationCandidateArtifact`로 구조·스냅샷 일치를 확인한다.
