import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  INITIAL_CODES,
  compareEntryIds,
  entryIdOfSense,
  initialCodeOf,
  loadMeaningData,
  readAdjudications,
  readMeanings,
} from './contract.mjs';

/**
 * Issue #814 — read-only post-mortem source material for the #764 Meaning re-edit.
 *
 * For each initial group `c01`..`c19` this lists, without judging them, (A) every Meaning that currently merges
 * two or more canonical senses and (B) every lemma that currently has two or more Meanings (a lemma in both sets
 * is one linked entry). Each group is shown with the untouched canonical source glosses, the sense -> Meaning
 * mapping and whatever reasons earlier editing records actually wrote down. Nothing here decides whether a merge or
 * a split is right; it never writes to data/ or to the historical edit records.
 */

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const MEANING_DIR = path.join(ROOT, 'scripts', 'meaning');

export const POSTMORTEM_CODES = Object.freeze(Object.values(INITIAL_CODES));
export const NO_RECORD = '기록 없음';
export const reportName = (code) => `issue-764-${code}-postmortem`;
export const INDEX_NAME = 'issue-764-postmortem.md';
// Initials whose Meaning data is known to be awaiting a pending PR; drop the entry and regenerate once it merges.
export const PROVISIONAL = Object.freeze({ c12: '**잠정본**: [PR #798](https://github.com/neverworkalone/typewriter/pull/798)이 아직 master에 병합되지 않았다. 이 보고서는 병합 전 master 데이터 기준이며, #798 병합 후 최신 master로 재생성해야 최종본이 된다.' });
export const POSTMORTEM_CONTRACT = 'meaning-postmortem-v1';

const HISTORY_FILE = /^issue-(?:716|764|772|774)-.*\.(?:md|jsonl|json)$/u;
const SENSE_TOKEN = /w\d+-s\d+/gu;
const MEANING_TOKEN = /\bm\d+(?:_\d+)?\b/gu;
const REASON_KEYS = Object.freeze(['reason', 'rationale', 'note', 'notes', 'comment']);
const HANJA_RUN = /[\p{Script=Han}]+/gu;
const EXCERPT_LIMIT = 300;

const readJsonl = (file) => readFileSync(file, 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line));
const sha256 = (value) => createHash('sha256').update(value).digest('hex');
const clip = (text) => (text.length > EXCERPT_LIMIT ? `${text.slice(0, EXCERPT_LIMIT)}…` : text);
const compareText = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

/** Canonical index: sense -> source record/sense facts (record order and text exactly as committed). */
export function loadCanonicalIndex(canonicalDirectory) {
  const senses = new Map();
  const files = readdirSync(canonicalDirectory).filter((name) => name.endsWith('.jsonl')).sort();
  const digest = createHash('sha256');
  let recordCount = 0;
  for (const file of files) {
    const text = readFileSync(path.join(canonicalDirectory, file), 'utf8');
    digest.update(`${file}\n${sha256(text)}\n`);
    for (const line of text.split('\n')) {
      if (!line) continue;
      const record = JSON.parse(line);
      recordCount += 1;
      for (const sense of record.senses ?? []) {
        senses.set(sense.id, {
          sense_id: sense.id,
          record_id: record.id,
          record_type: record.record_type,
          lemma: record.lemma,
          search_forms: record.search_forms ?? [],
          pos: sense.pos ?? null,
          gloss: sense.gloss,
          canonical_file: `data/canonical/${file}`,
        });
      }
    }
  }
  return { senses, recordCount, files, digest: digest.digest('hex') };
}

/** Source 원어/어원 facts that earlier audits copied from STDICT (the committed canonical layer omits them). */
function loadRecordOrigins(files) {
  const origins = new Map();
  for (const file of files) {
    if (!file.endsWith('.jsonl')) continue;
    for (const row of readJsonl(path.join(MEANING_DIR, file))) {
      for (const record of row.source_records ?? []) {
        if (typeof record !== 'object' || !record.record_id) continue;
        if (!('source_original' in record) && !('source_origin' in record)) continue;
        origins.set(record.record_id, {
          source_original: record.source_original ?? [],
          source_origin: record.source_origin ?? null,
          source_audit: `scripts/meaning/${file}`,
        });
      }
    }
  }
  return origins;
}

/** Index every sense/meaning ID mentioned by an earlier editing record, keeping only what that record actually says. */
export function loadHistory() {
  const files = readdirSync(MEANING_DIR).filter((name) => HISTORY_FILE.test(name) && !name.includes('postmortem')).sort();
  const bySense = new Map();
  const push = (token, ref) => {
    if (!bySense.has(token)) bySense.set(token, []);
    bySense.get(token).push(ref);
  };
  for (const file of files) {
    const rel = `scripts/meaning/${file}`;
    const text = readFileSync(path.join(MEANING_DIR, file), 'utf8');
    if (file.endsWith('.md')) {
      text.split('\n').forEach((line, i) => {
        const tokens = new Set([...(line.match(SENSE_TOKEN) ?? []), ...(line.match(MEANING_TOKEN) ?? [])]);
        for (const token of tokens) push(token, { file: rel, line: i + 1, kind: 'markdown', text: clip(line.trim()) });
      });
    } else if (file.endsWith('.jsonl')) {
      text.split('\n').forEach((line, i) => {
        if (!line) return;
        const row = JSON.parse(line);
        const tokens = new Set(line.match(SENSE_TOKEN) ?? []);
        const reasons = REASON_KEYS.filter((key) => typeof row[key] === 'string' && row[key]).map((key) => ({ field: key, text: clip(row[key]) }));
        const decisions = [...new Set((row.groups ?? row.final_groups ?? []).map((g) => g.decision).filter(Boolean))];
        for (const token of tokens) push(token, { file: rel, line: i + 1, kind: 'jsonl', lemma: row.lemma ?? null, ...(decisions.length ? { decisions } : {}), ...(reasons.length ? { reasons } : {}) });
      });
    } else {
      const walk = (node, trail) => {
        if (Array.isArray(node)) { node.forEach((item, i) => walk(item, `${trail}[${i}]`)); return; }
        if (!node || typeof node !== 'object') return;
        const own = new Set();
        for (const value of Object.values(node)) {
          if (typeof value === 'string' && /^w\d+-s\d+$/u.test(value)) own.add(value);
          if (Array.isArray(value)) for (const item of value) if (typeof item === 'string' && /^w\d+-s\d+$/u.test(item)) own.add(item);
        }
        const reasons = REASON_KEYS.filter((key) => typeof node[key] === 'string' && node[key]).map((key) => ({ field: key, text: clip(node[key]) }));
        for (const token of own) push(token, { file: rel, kind: 'json', path: trail, ...(reasons.length ? { reasons } : {}) });
        for (const [key, value] of Object.entries(node)) if (value && typeof value === 'object') walk(value, `${trail}.${key}`);
      };
      walk(JSON.parse(text), '$');
    }
  }
  return { files, bySense, byMeaning: bySense };
}

const hanjaOf = (canonical, origin) => {
  const found = new Set();
  const scan = (value) => { for (const run of String(value ?? '').match(HANJA_RUN) ?? []) found.add(run); };
  scan(canonical.lemma);
  canonical.search_forms.forEach(scan);
  scan(canonical.gloss);
  for (const item of origin?.source_original ?? []) if (item.language_type === '한자') scan(item.original_language);
  return [...found].sort();
};

/** Build the whole read-only result for one data snapshot. */
export function buildPostmortem({ meaningsDirectory, adjudicationDirectory, canonicalDirectory }) {
  const meanings = readMeanings(meaningsDirectory);
  const adjudications = readAdjudications(adjudicationDirectory);
  const canonical = loadCanonicalIndex(canonicalDirectory);
  const validation = loadMeaningData({ meaningsDirectory, adjudicationDirectory, senses: canonical.senses, complete: true });
  const history = loadHistory();
  const origins = loadRecordOrigins(history.files);
  const errors = [...meanings.errors, ...adjudications.errors, ...validation.errors];

  const meaningOfSense = new Map();
  const droppedSenses = new Set(adjudications.rows.map((row) => row.sense_id));
  const lemmasByCode = new Map(POSTMORTEM_CODES.map((code) => [code, new Map()]));
  for (const row of meanings.rows) { // contract order: lemma, then numeric id
    for (const senseId of row.sense_ids) meaningOfSense.set(senseId, row.id);
    lemmasByCode.get(initialCodeOf(row.lemma))?.set(row.lemma, [...(lemmasByCode.get(initialCodeOf(row.lemma))?.get(row.lemma) ?? []), row]);
  }
  const canonicalByCode = new Map(POSTMORTEM_CODES.map((code) => [code, { senses: 0, records: new Set(), meaningAssigned: 0, adjudicated: 0, unaccounted: 0 }]));
  for (const info of canonical.senses.values()) {
    const bucket = canonicalByCode.get(initialCodeOf(info.lemma));
    if (!bucket) continue;
    bucket.senses += 1;
    bucket.records.add(info.record_id);
    if (meaningOfSense.has(info.sense_id)) bucket.meaningAssigned += 1;
    else if (droppedSenses.has(info.sense_id)) bucket.adjudicated += 1;
    else bucket.unaccounted += 1;
  }

  const shardFiles = (directory, code) => readdirSync(directory).filter((name) => name.startsWith(`${code}_`)).sort();
  const reports = new Map();
  for (const code of POSTMORTEM_CODES) {
    const lemmas = lemmasByCode.get(code);
    const entries = [];
    let meaningCount = 0;
    let multiSenseMeanings = 0;
    let multiMeaningLemmas = 0;
    let singleSenseSingleMeaning = 0;
    for (const [lemma, rows] of [...lemmas.entries()].sort((a, b) => compareText(a[0], b[0]))) {
      meaningCount += rows.length;
      const merged = rows.filter((row) => row.sense_ids.length >= 2);
      multiSenseMeanings += merged.length;
      const split = rows.length >= 2;
      if (split) multiMeaningLemmas += 1;
      if (!split && merged.length === 0) { singleSenseSingleMeaning += 1; continue; }
      const refString = (ref) => (ref.line ? `${ref.file}:${ref.line}` : `${ref.file}#${ref.path}`).replace('scripts/meaning/', '');
      const quoted = new Map();
      const groups = rows.map((row) => ({
        meaning_id: row.id,
        gloss: row.gloss,
        merged: row.sense_ids.length >= 2,
        senses: row.sense_ids.map((senseId) => {
          const src = canonical.senses.get(senseId);
          const origin = origins.get(src.record_id) ?? null;
          const refs = history.bySense.get(senseId) ?? [];
          for (const ref of refs) {
            for (const reason of ref.reasons ?? []) quoted.set(`${refString(ref)}:${reason.field}`, { source: refString(ref), field: reason.field, text: reason.text });
            if (ref.kind === 'markdown') quoted.set(`${refString(ref)}:md`, { source: refString(ref), field: 'markdown', text: ref.text });
          }
          const hanja = hanjaOf(src, null);
          return {
            sense_id: senseId,
            record_id: src.record_id,
            ...(src.record_type === 'entry' ? {} : { record_type: src.record_type }),
            pos: src.pos,
            canonical_gloss: src.gloss,
            canonical_shard: src.canonical_file.replace('data/canonical/', ''),
            ...(hanja.length ? { hanja_in_canonical_text: hanja } : {}),
            ...(origin ? { source_original: origin.source_original, source_origin: origin.source_origin, source_audit: origin.source_audit.replace('scripts/meaning/', '') } : {}),
            history: [...new Set(refs.map(refString))],
          };
        }),
      }));
      for (const group of groups) {
        for (const ref of history.byMeaning.get(group.meaning_id) ?? []) {
          if (ref.kind === 'markdown') quoted.set(`${refString(ref)}:md`, { source: refString(ref), field: 'markdown', text: ref.text });
        }
      }
      const recordedReasons = [...quoted.values()].sort((x, y) => compareText(x.source, y.source) || compareText(x.field, y.field));
      const hanjaSets = groups.map((group) => [...new Set(group.senses.flatMap((s) => [...(s.hanja_in_canonical_text ?? []), ...(s.source_original ?? []).filter((o) => o.language_type === '한자').map((o) => o.original_language)]))].sort().join('|'));
      entries.push({
        lemma,
        in_merged_set: merged.length > 0,
        in_split_set: split,
        meaning_count: rows.length,
        sense_count: rows.reduce((n, row) => n + row.sense_ids.length, 0),
        record_ids: [...new Set(groups.flatMap((g) => g.senses.map((s) => s.record_id)))].sort(compareEntryIds),
        distinct_hanja_across_groups: split && new Set(hanjaSets.filter(Boolean)).size > 1,
        recorded_reason_status: recordedReasons.length ? 'recorded' : NO_RECORD,
        recorded_reasons: recordedReasons,
        groups,
      });
    }
    const merged = entries.filter((e) => e.in_merged_set);
    const split = entries.filter((e) => e.in_split_set);
    const bucket = canonicalByCode.get(code);
    reports.set(code, {
      code,
      meaning_shards: shardFiles(meaningsDirectory, code),
      adjudication_shards: shardFiles(adjudicationDirectory, code),
      counts: {
        lemmas: lemmas.size,
        canonical_records: bucket.records.size,
        canonical_senses: bucket.senses,
        canonical_senses_in_meanings: bucket.meaningAssigned,
        canonical_senses_adjudicated_drop: bucket.adjudicated,
        canonical_senses_unaccounted: bucket.unaccounted,
        meanings: meaningCount,
        meanings_with_2plus_senses: multiSenseMeanings,
        lemmas_with_2plus_meanings: multiMeaningLemmas,
        review_lemmas: entries.length,
        lemmas_in_both_sets: entries.filter((e) => e.in_merged_set && e.in_split_set).length,
        single_sense_single_meaning_lemmas_not_listed: singleSenseSingleMeaning,
        lemmas_with_differing_hanja_across_groups: entries.filter((e) => e.distinct_hanja_across_groups).length,
        lemmas_without_recorded_reason: entries.filter((e) => e.recorded_reason_status === NO_RECORD).length,
      },
      entries,
      merged_lemmas: merged.length,
      split_lemmas: split.length,
    });
  }
  return {
    reports,
    errors,
    validated: { meanings: meanings.rows.length, adjudications: adjudications.rows.length, errors: errors.length },
    canonical: { files: canonical.files.length, records: canonical.recordCount, digest: canonical.digest },
    historyFiles: history.files,
    dataDigest: sha256([canonical.digest, ...meanings.rows.map((r) => JSON.stringify(r)), ...adjudications.rows.map((r) => JSON.stringify(r))].join('\n')),
  };
}

const num = (n) => n.toLocaleString('en-US');

export function renderJsonl(report) {
  return report.entries.map((entry) => JSON.stringify(entry)).join('\n') + (report.entries.length ? '\n' : '');
}

export function renderReport(report, { inputSha, dataDigest }) {
  const { code, counts: c } = report;
  const lines = [];
  lines.push(`# #764 포스트모텀 기초자료 — ${code} (#814)`, '');
  lines.push('> 이 문서는 **현재 병합/분리 상태와 근거 자료**만 모은 읽기 전용 목록이다. 병합·분리의 옳고 그름, 규칙, 수정안을 판정하지 않는다.', '');
  if (PROVISIONAL[code]) lines.push(`> ⚠️ ${PROVISIONAL[code]}`, '');
  lines.push('## 1. 입력과 규모', '');
  lines.push(`- 기준 master SHA: \`${inputSha}\``);
  lines.push(`- 데이터 다이제스트(canonical+meanings+adjudication, sha256): \`${dataDigest}\``);
  lines.push(`- Meaning shard (${report.meaning_shards.length}): ${report.meaning_shards.map((f) => `\`data/meanings/${f}\``).join(', ')}`);
  lines.push(`- adjudication shard (${report.adjudication_shards.length}): ${report.adjudication_shards.length ? report.adjudication_shards.map((f) => `\`data/adjudication/${f}\``).join(', ') : '없음'}`);
  lines.push('', '| 항목 | 수 |', '| --- | ---: |');
  const rows = [
    ['lemma (Meaning이 있는 표제어)', c.lemmas],
    ['canonical record', c.canonical_records],
    ['canonical sense', c.canonical_senses],
    ['  └ Meaning에 귀속', c.canonical_senses_in_meanings],
    ['  └ adjudication DROP', c.canonical_senses_adjudicated_drop],
    ['  └ 미귀속(구조 검증 실패 시에만 0 아님)', c.canonical_senses_unaccounted],
    ['Meaning', c.meanings],
    ['A. 2개 이상 sense를 가진 Meaning', c.meanings_with_2plus_senses],
    ['B. 2개 이상 Meaning을 가진 lemma', c.lemmas_with_2plus_meanings],
    ['A·B 양쪽에 해당하는 lemma', c.lemmas_in_both_sets],
    ['검토 대상 lemma (A∪B, 중복 제외)', c.review_lemmas],
    ['목록 제외: 단일 sense·단일 Meaning lemma', c.single_sense_single_meaning_lemmas_not_listed],
    ['참고: 그룹 간 원어(한자) 표기가 다른 lemma', c.lemmas_with_differing_hanja_across_groups],
    ['참고: 과거 기록에 인용할 이유가 없는 lemma (`기록 없음`)', c.lemmas_without_recorded_reason],
  ];
  for (const [label, n] of rows) lines.push(`| ${label} | ${num(n)} |`);
  lines.push('', '구조 집계(Meaning 귀속·DROP 대조)는 `scripts/meaning/contract.mjs`의 공통 validator(`complete: true`) 결과이며, 의미적 승인 상태를 뜻하지 않는다.', '');
  lines.push('## 2. 목록 위치와 읽는 법', '');
  lines.push(`- 전체 원문 대조 목록: [\`${reportName(code)}.jsonl\`](${reportName(code)}.jsonl) — lemma 한 줄(JSON)이 한 묶음이다. A와 B에 모두 해당하는 lemma는 한 줄에 전체 분할 상태가 들어 있다(\`in_merged_set\`, \`in_split_set\`).`);
  lines.push('- `groups[]`: 현재 Meaning 그룹. `meaning_id`, 현재 `gloss`, `merged`(2+ sense 여부)와 `senses[]`(sense ID, record ID, 품사, **canonical 원문 gloss**, canonical shard).');
  lines.push('- `senses[].history`: 과거 #716/#764/#772/#774 편집 기록 중 그 sense ID가 실제로 등장한 위치(`파일:줄` 또는 `파일#JSON경로`). lemma 수준 `recorded_reasons`: 그 기록에 적힌 문장을 그대로 인용한 것(과거 기록이 lemma 단위로 쓰였으면 그룹 단위가 아닌 lemma 단위로 붙는다)이며, 없으면 `recorded_reason_status` = `기록 없음`.');
  lines.push('- `senses[].hanja_in_canonical_text`: canonical 표제어·gloss·검색형에 문자 그대로 있는 한자 연속열. `source_original`/`source_origin`은 과거 감사 기록(`source_audit`)이 STDICT에서 옮겨 둔 값이 있을 때만 나온다.', '');
  lines.push('## 3. 출처·추적', '');
  lines.push('- `source sense ID → Meaning ID`는 `data/meanings/` 행의 `sense_ids`이며, JSONL에서 `groups[].senses[].sense_id`가 `groups[].meaning_id`에 속한다.');
  lines.push('- 원문 경로: `senses[].canonical_shard`(`data/canonical/` 아래) 의 해당 record 행. 과거 기록 인용은 출처로만 쓰며 새 판정을 만들지 않는다.', '');
  lines.push('## 4. 커버리지·제약', '');
  lines.push(`- A(2+ sense Meaning ${num(c.meanings_with_2plus_senses)}개)와 B(2+ Meaning lemma ${num(c.lemmas_with_2plus_meanings)}개)를 \`data/meanings/\`에서 전수 추출했다. 목록 줄 수는 검토 대상 lemma 수 ${num(c.review_lemmas)}와 같아야 하며 \`postmortem.test.mjs\`가 이를 재계산해 대조한다.`);
  lines.push('- 같은 STDICT record 안의 병합과 서로 다른 record 간 병합을 모두 포함한다(A는 \`sense_ids\` 길이만 기준).');
  lines.push('- 과거 이유 대조는 `scripts/meaning/issue-{716,764,772,774}-*` 의 md/jsonl/json에서 sense ID 문자열이 **정확히** 등장하는 경우만 연결한다. `s1/s2` 같은 축약 표기나 sense ID 없이 lemma만 적힌 서술은 자동 연결되지 않으므로 `기록 없음`이 “과거에 판단이 없었다”는 뜻은 아니다.');
  lines.push('- 커밋된 canonical에는 STDICT의 원어(한자) 필드가 없다. 한자 정보는 canonical 텍스트에 문자로 남아 있거나 과거 감사가 옮겨 적은 경우만 표시되며, 없는 경우 \`원어 정보 없음\`이 아니라 단지 이 저장소에서 확인할 수 없음을 뜻한다.');
  lines.push('- `distinct_hanja_across_groups`는 그룹 간 한자 표기가 서로 다르다는 사실 표시일 뿐 분리/병합 판정이 아니다.', '');
  return lines.join('\n') + '\n';
}

export function renderIndex(reports, { inputSha, dataDigest, validated, canonical }) {
  const lines = [];
  lines.push('# #764 포스트모텀 기초자료 — 통합 목차 (#814)', '');
  lines.push('> C01~C19의 **현재 병합/분리 상태를 기록한 읽기 전용 목록**의 목차다. 아래 건수는 구조 집계이며 과병합·과분리 확정 집계나 편집 규칙 제안이 아니다.', '');
  lines.push(`- 기준 master SHA: \`${inputSha}\``);
  lines.push(`- 데이터 다이제스트: \`${dataDigest}\``);
  lines.push(`- canonical: ${num(canonical.files)} shard / ${num(canonical.records)} record, Meaning ${num(validated.meanings)}행, adjudication ${num(validated.adjudications)}행, 공통 validator 오류 ${validated.errors}건`);
  lines.push('- 재생성: `node scripts/meaning/postmortem.mjs --input-sha <SHA>`; 일치 검증: `node scripts/meaning/postmortem.mjs --check`', '');
  for (const [code, note] of Object.entries(PROVISIONAL)) lines.push(`> ⚠️ ${code}: ${note}`, '');
  lines.push('| 초성 | 보고서 | 상세 목록 | Meaning | A: 2+ sense Meaning | B: 2+ Meaning lemma | 검토 lemma (A∪B) | A·B 양쪽 |', '| --- | --- | --- | ---: | ---: | ---: | ---: | ---: |');
  const total = { meanings: 0, a: 0, b: 0, r: 0, both: 0 };
  const initialOf = Object.fromEntries(Object.entries(INITIAL_CODES).map(([k, v]) => [v, k]));
  for (const code of POSTMORTEM_CODES) {
    const { counts: c } = reports.get(code);
    total.meanings += c.meanings; total.a += c.meanings_with_2plus_senses; total.b += c.lemmas_with_2plus_meanings; total.r += c.review_lemmas; total.both += c.lemmas_in_both_sets;
    lines.push(`| ${code} (${initialOf[code]}) | [md](${reportName(code)}.md) | [jsonl](${reportName(code)}.jsonl) | ${num(c.meanings)} | ${num(c.meanings_with_2plus_senses)} | ${num(c.lemmas_with_2plus_meanings)} | ${num(c.review_lemmas)} | ${num(c.lemmas_in_both_sets)} |`);
  }
  lines.push(`| 합계 | | | ${num(total.meanings)} | ${num(total.a)} | ${num(total.b)} | ${num(total.r)} | ${num(total.both)} |`, '');
  lines.push('A·B 양쪽 열은 검토 lemma 중 두 집합에 모두 속한 수이며, 합계 검토 lemma는 중복을 한 번만 센다. `c20`(한글 초성이 아닌 표제어)은 이슈 범위(C01~C19) 밖이라 포함하지 않는다.', '');
  return lines.join('\n') + '\n';
}

export function renderAll(result, { inputSha }) {
  const files = new Map();
  for (const code of POSTMORTEM_CODES) {
    const report = result.reports.get(code);
    files.set(`${reportName(code)}.md`, renderReport(report, { inputSha, dataDigest: result.dataDigest }));
    files.set(`${reportName(code)}.jsonl`, renderJsonl(report));
  }
  files.set(INDEX_NAME, renderIndex(result.reports, { inputSha, dataDigest: result.dataDigest, validated: result.validated, canonical: result.canonical }));
  return files;
}

const defaultDirectories = () => ({
  meaningsDirectory: path.join(ROOT, 'data', 'meanings'),
  adjudicationDirectory: path.join(ROOT, 'data', 'adjudication'),
  canonicalDirectory: path.join(ROOT, 'data', 'canonical'),
});

function main(argv) {
  const check = argv.includes('--check');
  const shaIndex = argv.indexOf('--input-sha');
  let inputSha = shaIndex >= 0 ? argv[shaIndex + 1] : null;
  if (!inputSha) {
    const existing = path.join(MEANING_DIR, INDEX_NAME);
    inputSha = existsSync(existing) ? /기준 master SHA: `([0-9a-f]{40})`/u.exec(readFileSync(existing, 'utf8'))?.[1] : null;
  }
  if (!/^[0-9a-f]{40}$/u.test(inputSha ?? '')) { console.error('--input-sha <40-hex master SHA> is required'); return 2; }
  const result = buildPostmortem(defaultDirectories());
  if (result.errors.length) { console.error(`common validator reported ${result.errors.length} error(s):\n${result.errors.slice(0, 20).join('\n')}`); return 1; }
  const files = renderAll(result, { inputSha });
  if (check) {
    const stale = [...files].filter(([name, content]) => !existsSync(path.join(MEANING_DIR, name)) || readFileSync(path.join(MEANING_DIR, name), 'utf8') !== content).map(([name]) => name);
    if (stale.length) { console.error(`stale post-mortem output: ${stale.join(', ')}`); return 1; }
    console.log(`post-mortem outputs match (${files.size} files)`);
    return 0;
  }
  mkdirSync(MEANING_DIR, { recursive: true });
  for (const [name, content] of files) writeFileSync(path.join(MEANING_DIR, name), content);
  console.log(`wrote ${files.size} files`);
  return 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) process.exitCode = main(process.argv.slice(2));
