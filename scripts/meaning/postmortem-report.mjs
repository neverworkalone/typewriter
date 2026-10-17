import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { INITIAL_CODES, compareEntryIds, initialCodeOf, loadMeaningData, readAdjudications, readMeanings } from './contract.mjs';

/**
 * Issue #814 — read-only post-mortem source lists for the #764 Meaning re-edit.
 *
 * For one initial group (`c01`..`c19`, default `c02`) this enumerates, without judging them, the two sets the issue
 * asks for: (A) every Meaning that currently merges two or more canonical senses and (B) every lemma that currently
 * has two or more Meanings. A lemma in both sets is written as one entry. Each group is shown with the untouched
 * canonical source glosses, the `sense -> Meaning` mapping and whatever reason text earlier editing records actually
 * contain. Nothing here decides whether a merge or a split is right; it never writes to `data/` and it never rewrites
 * a historical editing record. The same tool covers every initial code so all nineteen reports come from one path.
 */

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const MEANING_DIR = path.join(ROOT, 'scripts', 'meaning');

export const POSTMORTEM_CODES = Object.freeze(Object.values(INITIAL_CODES));
export const DEFAULT_CODE = 'c02';
export const NO_RECORD = '기록 없음';
export const reportName = (code) => `issue-764-${code}-postmortem`;

const HISTORY_FILE = /^issue-(?:716|764|772|774)-.*\.(?:md|jsonl|json)$/u;
const SENSE_TOKEN = /w\d+-s\d+/gu;
const MEANING_TOKEN = /\bm\d+(?:_\d+)?\b/gu;
const REASON_KEYS = Object.freeze(['reason', 'rationale', 'note', 'notes', 'comment']);
const HANJA_RUN = /[\p{Script=Han}]+/gu;
const CLIP = 300;
const GLOSS_CLIP = 200;

const readJsonl = (file) => readFileSync(file, 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line));
const sha256 = (value) => createHash('sha256').update(value).digest('hex');
const clip = (text, limit = CLIP) => (text.length > limit ? `${text.slice(0, limit)}…` : text);
const compareText = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
const num = (n) => n.toLocaleString('en-US');
const oneLine = (text) => String(text).replace(/\s+/gu, ' ').trim();

/** Canonical index: sense id -> the exact committed record/sense facts, plus a digest of the whole layer. */
export function loadCanonicalIndex(canonicalDirectory) {
  const senses = new Map();
  const digest = createHash('sha256');
  const files = readdirSync(canonicalDirectory).filter((name) => name.endsWith('.jsonl')).sort();
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
          canonical_shard: `data/canonical/${file}`,
        });
      }
    }
  }
  return { senses, recordCount, files, digest: digest.digest('hex') };
}

/** Past-reason index: every sense/Meaning id an earlier #716/#764/#772/#774 record mentions, with what it says. */
export function loadHistory(meaningDirectory = MEANING_DIR) {
  const files = readdirSync(meaningDirectory).filter((name) => HISTORY_FILE.test(name) && !name.includes('postmortem')).sort();
  const bySense = new Map();
  const push = (token, ref) => {
    if (!bySense.has(token)) bySense.set(token, []);
    bySense.get(token).push(ref);
  };
  const tokensIn = (text) => new Set([...(text.match(SENSE_TOKEN) ?? []), ...(text.match(MEANING_TOKEN) ?? [])]);
  for (const file of files) {
    const rel = `scripts/meaning/${file}`;
    const text = readFileSync(path.join(meaningDirectory, file), 'utf8');
    if (file.endsWith('.md')) {
      text.split('\n').forEach((line, i) => {
        const trimmed = line.trim();
        if (!trimmed) return;
        for (const token of tokensIn(trimmed)) push(token, { file: rel, line: i + 1, kind: 'markdown', text: clip(trimmed) });
      });
      continue;
    }
    if (file.endsWith('.jsonl')) {
      text.split('\n').forEach((line, i) => {
        if (!line) return;
        const row = JSON.parse(line);
        const reasons = REASON_KEYS.filter((key) => typeof row[key] === 'string' && row[key]).map((key) => ({ field: key, text: clip(row[key]) }));
        for (const token of new Set(line.match(SENSE_TOKEN) ?? [])) push(token, { file: rel, line: i + 1, kind: 'jsonl', ...(reasons.length ? { reasons } : {}) });
      });
      continue;
    }
    const walk = (node, trail) => {
      if (Array.isArray(node)) { node.forEach((item, i) => walk(item, `${trail}[${i}]`)); return; }
      if (!node || typeof node !== 'object') return;
      const own = new Set();
      for (const value of Object.values(node)) {
        if (typeof value === 'string' && /^w\d+-s\d+$/u.test(value)) own.add(value);
        if (Array.isArray(value)) for (const item of value) if (typeof item === 'string' && /^w\d+-s\d+$/u.test(item)) own.add(item);
      }
      const reasons = REASON_KEYS.filter((key) => typeof node[key] === 'string' && node[key]).map((key) => ({ field: key, text: clip(node[key]) }));
      for (const token of own) push(token, { file: rel, path: trail, kind: 'json', ...(reasons.length ? { reasons } : {}) });
      for (const [key, value] of Object.entries(node)) if (value && typeof value === 'object') walk(value, `${trail}.${key}`);
    };
    walk(JSON.parse(text), '$');
  }
  return { files, bySense };
}

const hanjaOf = (canonical, origin) => {
  const found = new Set();
  const scan = (value) => { for (const run of String(value ?? '').match(HANJA_RUN) ?? []) found.add(run); };
  scan(canonical.lemma);
  for (const form of canonical.search_forms ?? []) scan(form);
  scan(canonical.gloss);
  for (const item of origin?.source_original ?? []) if (item.language_type === '한자') scan(item.original_language);
  return [...found].sort();
};

/** Source 원어/어원 facts that earlier audits copied from STDICT (the committed canonical layer omits them). */
function loadRecordOrigins(files, meaningDirectory = MEANING_DIR) {
  const origins = new Map();
  for (const file of files) {
    if (!file.endsWith('.jsonl')) continue;
    for (const row of readJsonl(path.join(meaningDirectory, file))) {
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

/** Build the read-only lists for one initial code from a data snapshot. */
export function buildReport({ code, meaningsDirectory, adjudicationDirectory, canonicalDirectory, meaningDirectory = MEANING_DIR }) {
  if (!POSTMORTEM_CODES.includes(code)) throw new TypeError(`unknown initial code: ${code}`);
  const meanings = readMeanings(meaningsDirectory);
  const adjudications = readAdjudications(adjudicationDirectory);
  const canonical = loadCanonicalIndex(canonicalDirectory);
  const validation = loadMeaningData({ meaningsDirectory, adjudicationDirectory, senses: canonical.senses, complete: true });
  const history = loadHistory(meaningDirectory);
  const origins = loadRecordOrigins(history.files, meaningDirectory);
  const errors = [...new Set([...meanings.errors, ...adjudications.errors, ...validation.errors])];

  const rows = meanings.rows.filter((row) => initialCodeOf(row.lemma) === code);
  const byLemma = new Map();
  for (const row of rows) {
    if (!byLemma.has(row.lemma)) byLemma.set(row.lemma, []);
    byLemma.get(row.lemma).push(row);
  }
  const meaningOfSense = new Map();
  for (const row of rows) for (const senseId of row.sense_ids) meaningOfSense.set(senseId, row.id);
  const dropped = new Set(adjudications.rows.filter((row) => initialCodeOf(row.lemma) === code).map((row) => row.sense_id));

  const structural = { canonical_records: new Set(), canonical_senses: 0, canonical_senses_in_meanings: 0, canonical_senses_adjudicated_drop: 0, canonical_senses_unaccounted: 0 };
  for (const info of canonical.senses.values()) {
    if (initialCodeOf(info.lemma) !== code) continue;
    structural.canonical_senses += 1;
    structural.canonical_records.add(info.record_id);
    if (meaningOfSense.has(info.sense_id)) structural.canonical_senses_in_meanings += 1;
    else if (dropped.has(info.sense_id)) structural.canonical_senses_adjudicated_drop += 1;
    else structural.canonical_senses_unaccounted += 1;
  }

  const refString = (ref) => (ref.line ? `${ref.file}:${ref.line}` : `${ref.file}#${ref.path}`);
  const entries = [];
  const stats = {
    merged_meanings: 0,
    merged_senses: 0,
    merged_sense_distribution: new Map(),
    merged_same_record: 0,
    merged_cross_record: 0,
    merged_mixed_pos: 0,
    merged_pointer_senses: 0,
    split_lemmas: 0,
    split_meaning_distribution: new Map(),
    review_lemmas_in_both: 0,
    lemmas_with_differing_hanja: 0,
    lemmas_without_recorded_reason: 0,
  };
  let meaningCount = 0;
  let singleSenseSingleMeaning = 0;

  for (const [lemma, lemmaRows] of [...byLemma.entries()].sort((a, b) => compareText(a[0], b[0]))) {
    meaningCount += lemmaRows.length;
    const mergedRows = lemmaRows.filter((row) => row.sense_ids.length >= 2);
    const split = lemmaRows.length >= 2;
    const inBoth = mergedRows.length > 0 && split;
    if (!split && mergedRows.length === 0) { singleSenseSingleMeaning += 1; continue; }
    stats.merged_meanings += mergedRows.length;
    if (split) {
      stats.split_lemmas += 1;
      stats.split_meaning_distribution.set(lemmaRows.length, (stats.split_meaning_distribution.get(lemmaRows.length) ?? 0) + 1);
    }
    if (inBoth) stats.review_lemmas_in_both += 1;

    const groups = lemmaRows.map((row) => {
      const senses = row.sense_ids.map((senseId) => {
        const src = canonical.senses.get(senseId);
        if (!src) throw new Error(`${row.id}: canonical sense ${senseId} not found`);
        const refs = history.bySense.get(senseId) ?? [];
        const hanja = hanjaOf(src, origins.get(src.record_id));
        return {
          sense_id: senseId,
          record_id: src.record_id,
          ...(src.record_type && src.record_type !== 'entry' ? { record_type: src.record_type } : {}),
          pos: src.pos,
          canonical_gloss: src.gloss,
          canonical_shard: src.canonical_shard.replace('data/canonical/', ''),
          ...(hanja.length ? { hanja_in_canonical_text: hanja } : {}),
          history: [...new Set(refs.map(refString))],
        };
      });
      if (row.sense_ids.length >= 2) {
        stats.merged_senses += row.sense_ids.length;
        stats.merged_sense_distribution.set(row.sense_ids.length, (stats.merged_sense_distribution.get(row.sense_ids.length) ?? 0) + 1);
        const records = new Set(senses.map((s) => s.record_id));
        if (records.size === 1) stats.merged_same_record += 1; else stats.merged_cross_record += 1;
        const pos = new Set(senses.map((s) => s.pos).filter(Boolean));
        if (pos.size > 1) stats.merged_mixed_pos += 1;
        if (senses.some((s) => String(s.canonical_gloss).startsWith('→'))) stats.merged_pointer_senses += 1;
      }
      return { meaning_id: row.id, gloss: row.gloss, merged: row.sense_ids.length >= 2, senses };
    });

    const quoted = new Map();
    for (const group of groups) {
      for (const sense of group.senses) {
        for (const ref of history.bySense.get(sense.sense_id) ?? []) {
          for (const reason of ref.reasons ?? []) quoted.set(`${refString(ref)}:${reason.field}`, { source: refString(ref), field: reason.field, text: reason.text });
          if (ref.kind === 'markdown') quoted.set(`${refString(ref)}:md`, { source: refString(ref), field: 'markdown', text: ref.text });
        }
      }
      for (const ref of history.bySense.get(group.meaning_id) ?? []) {
        if (ref.kind === 'markdown') quoted.set(`${refString(ref)}:md`, { source: refString(ref), field: 'markdown', text: ref.text });
      }
    }
    const recordedReasons = [...quoted.values()].sort((x, y) => compareText(x.source, y.source) || compareText(x.field, y.field));
    if (!recordedReasons.length) stats.lemmas_without_recorded_reason += 1;
    const hanjaSets = groups.map((group) => [...new Set(group.senses.flatMap((s) => s.hanja_in_canonical_text ?? []))].sort().join('|'));
    const differingHanja = split && new Set(hanjaSets.filter(Boolean)).size > 1;
    if (differingHanja) stats.lemmas_with_differing_hanja += 1;

    entries.push({
      lemma,
      in_merged_set: mergedRows.length > 0,
      in_split_set: split,
      meaning_count: lemmaRows.length,
      sense_count: lemmaRows.reduce((n, row) => n + row.sense_ids.length, 0),
      record_ids: [...new Set(groups.flatMap((g) => g.senses.map((s) => s.record_id)))].sort(compareEntryIds),
      distinct_hanja_across_groups: differingHanja,
      recorded_reason_status: recordedReasons.length ? 'recorded' : NO_RECORD,
      recorded_reasons: recordedReasons,
      groups,
    });
  }

  const shardFiles = (directory) => readdirSync(directory).filter((name) => name.startsWith(`${code}_`) && name.endsWith('.jsonl')).sort();
  const merged = entries.filter((e) => e.in_merged_set);
  const split = entries.filter((e) => e.in_split_set);
  const matchedHistory = new Set();
  for (const entry of entries) {
    for (const group of entry.groups) for (const sense of group.senses) for (const ref of sense.history) matchedHistory.add(ref.split(/[#:]/u)[0]);
    for (const reason of entry.recorded_reasons) matchedHistory.add(reason.source.split(/[#:]/u)[0]);
  }
  return {
    code,
    meaning_shards: shardFiles(meaningsDirectory),
    adjudication_shards: shardFiles(adjudicationDirectory),
    counts: {
      lemmas: byLemma.size,
      canonical_records: structural.canonical_records.size,
      canonical_senses: structural.canonical_senses,
      canonical_senses_in_meanings: structural.canonical_senses_in_meanings,
      canonical_senses_adjudicated_drop: structural.canonical_senses_adjudicated_drop,
      canonical_senses_unaccounted: structural.canonical_senses_unaccounted,
      meanings: meaningCount,
      meanings_with_2plus_senses: stats.merged_meanings,
      lemmas_with_2plus_meanings: stats.split_lemmas,
      review_lemmas: entries.length,
      lemmas_in_both_sets: stats.review_lemmas_in_both,
      single_sense_single_meaning_lemmas_not_listed: singleSenseSingleMeaning,
      lemmas_with_differing_hanja_across_groups: stats.lemmas_with_differing_hanja,
      lemmas_without_recorded_reason: stats.lemmas_without_recorded_reason,
    },
    detail: {
      merged_senses: stats.merged_senses,
      merged_sense_distribution: [...stats.merged_sense_distribution.entries()].sort((a, b) => a[0] - b[0]),
      merged_same_record: stats.merged_same_record,
      merged_cross_record: stats.merged_cross_record,
      merged_mixed_pos: stats.merged_mixed_pos,
      merged_pointer_senses: stats.merged_pointer_senses,
      split_meaning_distribution: [...stats.split_meaning_distribution.entries()].sort((a, b) => a[0] - b[0]),
      merged_lemmas: merged.length,
      split_lemmas: split.length,
    },
    entries,
    errors,
    canonical: { files: canonical.files.length, records: canonical.recordCount, digest: canonical.digest },
    history_files: history.files,
    history_matched: [...matchedHistory].sort(),
    data_digest: sha256([canonical.digest, ...rows.map((r) => JSON.stringify(r)), ...adjudications.rows.map((r) => JSON.stringify(r))].join('\n')),
  };
}

/** JSONL sidecar: one JSON object per review lemma, carrying the full canonical text. */
export function renderJsonl(report) {
  return report.entries.map((entry) => JSON.stringify(entry)).join('\n') + (report.entries.length ? '\n' : '');
}

const tableCell = (text) => oneLine(text).replace(/\|/gu, '\\|');

const groupLine = (group, { withGlosses }) => {
  const parts = [`\`${group.meaning_id}\` — ${oneLine(group.gloss)}`];
  if (withGlosses) {
    for (const sense of group.senses) {
      const pos = sense.pos ? `${sense.pos}, ` : '';
      const hanja = sense.hanja_in_canonical_text?.length ? `, 한자 ${sense.hanja_in_canonical_text.join(' ')}` : '';
      parts.push(`- \`${sense.sense_id}\` (record \`${sense.record_id}\`, ${pos}\`${sense.canonical_shard}\`${hanja}) — ${oneLine(sense.canonical_gloss)}`);
    }
  }
  return parts;
};

export function renderReport(report, { inputSha, commit }) {
  const { code, counts: c, detail: d } = report;
  const initial = Object.entries(INITIAL_CODES).find(([, value]) => value === code)?.[0] ?? code;
  const lines = [];
  lines.push(`# #764 포스트모텀 기초자료 — ${code} (${initial}) (#814)`, '');
  lines.push('> 이 문서는 **현재 병합/분리 상태와 근거 자료**만 모은 읽기 전용 목록이다. 병합·분리의 옳고 그름, 규칙, 수정안을 판정하지 않는다.', '');
  lines.push('## 1. 입력과 규모', '');
  lines.push(`- 기준 master SHA: \`${inputSha ?? '(미지정)'}\`${commit ? ` (${commit})` : ''}`);
  lines.push(`- 데이터 다이제스트(canonical 전체 + ${code} Meaning 행 + adjudication 전체, sha256): \`${report.data_digest}\``);
  lines.push(`- canonical shard ${num(report.canonical.files)}개 / record ${num(report.canonical.records)}개(canonical 전체)`);
  lines.push(`- Meaning shard (${report.meaning_shards.length}): ${report.meaning_shards.map((f) => `\`data/meanings/${f}\``).join(', ')}`);
  lines.push(`- adjudication shard (${report.adjudication_shards.length}): ${report.adjudication_shards.length ? report.adjudication_shards.map((f) => `\`data/adjudication/${f}\``).join(', ') : '없음'}`);
  lines.push(`- 과거 기록 대조: \`scripts/meaning/issue-{716,764,772,774}-*\` ${num(report.history_files.length)}개 중 ${num(report.history_matched.length)}개 파일에서 이 초성의 sense/Meaning ID를 실제로 찾았다: ${report.history_matched.length ? report.history_matched.map((f) => `\`${f}\``).join(', ') : '없음'}`);
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

  lines.push('## 2. 병합 목록(A) — 2개 이상 sense를 가진 Meaning', '');
  lines.push(`현재 stage에서 sense ${num(d.merged_senses)}개가 ${num(c.meanings_with_2plus_senses)}개 Meaning에 묶여 있다. 이 목록은 그 Meaning **전부**이며, 같은 STDICT record 내부 병합과 서로 다른 record 간 병합을 모두 포함한다.`);
  lines.push('', '| 구분 | 수 |', '| --- | ---: |');
  lines.push(`| 병합 Meaning 전체 | ${num(c.meanings_with_2plus_senses)} |`);
  lines.push(`| 병합에 쓰인 sense | ${num(d.merged_senses)} |`);
  lines.push(`| 같은 record 내부 병합 | ${num(d.merged_same_record)} |`);
  lines.push(`| 서로 다른 record 간 병합 | ${num(d.merged_cross_record)} |`);
  lines.push(`| 품사가 섞인 병합 | ${num(d.merged_mixed_pos)} |`);
  lines.push(`| \`→\` 참조 sense를 포함한 병합 | ${num(d.merged_pointer_senses)} |`);
  lines.push(`| Meaning당 sense 수 분포 | ${d.merged_sense_distribution.map(([n, k]) => `${n}개: ${num(k)}`).join(', ')} |`);
  lines.push('', '표는 lemma 순서이며, `현재 Meaning gloss`는 길면 줄임표로 자른다. **각 sense의 canonical 원문 gloss·품사·한자·출처 shard는 sidecar JSONL에 원문 그대로 있고, 분리 lemma(§3)에 속한 그룹은 아래 §3에도 나란히 실린다.**', '');
  lines.push('| 표제어 | Meaning ID | sense 수 | record ID | 현재 Meaning gloss | 과거 기록 인용 |', '| --- | --- | ---: | --- | --- | --- |');
  for (const entry of report.entries.filter((e) => e.in_merged_set)) {
    const reason = entry.recorded_reasons.length ? `${entry.recorded_reasons.map((r) => oneLine(r.text)).join(' / ')}` : NO_RECORD;
    for (const group of entry.groups.filter((g) => g.merged)) {
      const records = [...new Set(group.senses.map((s) => s.record_id))];
      lines.push(`| ${tableCell(entry.lemma)} | \`${group.meaning_id}\` | ${group.senses.length} | ${records.map((id) => `\`${id}\``).join(' ')} | ${tableCell(clip(group.gloss, 120))} | ${tableCell(clip(reason, 80))} |`);
    }
  }
  lines.push('');

  lines.push('## 3. 분리 목록(B) — 2개 이상 Meaning을 가진 lemma', '');
  lines.push(`현재 stage에서 ${num(c.lemmas_with_2plus_meanings)}개 lemma가 둘 이상의 Meaning으로 나뉘어 있다. 아래에 lemma별로 **현재 존재하는 Meaning 그룹 전부**와 각 그룹의 source sense 원문을 나란히 싣는다.`);
  lines.push('', '| 구분 | 수 |', '| --- | ---: |');
  lines.push(`| 분리 lemma 전체 | ${num(c.lemmas_with_2plus_meanings)} |`);
  lines.push(`| A·B 양쪽 lemma(위 §2와 중복) | ${num(c.lemmas_in_both_sets)} |`);
  lines.push(`| Meaning 수 분포(lemma당) | ${d.split_meaning_distribution.map(([n, k]) => `${n}개: ${num(k)}`).join(', ')} |`);
  lines.push('');
  for (const entry of report.entries.filter((e) => e.in_split_set)) {
    const flags = [entry.in_merged_set ? 'A·B' : 'B', entry.distinct_hanja_across_groups ? '그룹 간 한자 표기 다름' : null].filter(Boolean).join(', ');
    lines.push(`### ${entry.lemma} — Meaning ${entry.meaning_count}개 (${flags})`);
    for (const group of entry.groups) {
      const [head, ...senseLines] = groupLine(group, { withGlosses: true });
      lines.push(`- ${head}`);
      for (const line of senseLines) lines.push(`  ${line}`);
    }
    if (entry.recorded_reasons.length) {
      lines.push('  과거 기록 인용:');
      for (const reason of entry.recorded_reasons) lines.push(`  - (\`${reason.source}\`, ${reason.field}) ${oneLine(reason.text)}`);
    } else {
      lines.push(`  과거 기록 인용: ${NO_RECORD}`);
    }
    lines.push('');
  }

  lines.push('## 4. 출처·추적', '');
  lines.push('- `source sense ID → Meaning ID`는 `data/meanings/` 행의 `sense_ids`이며, sidecar JSONL에서 `groups[].senses[].sense_id`가 `groups[].meaning_id`에 속한다.');
  lines.push('- 각 sense의 원문은 `data/canonical/`의 해당 record 행이다(sidecar `senses[].canonical_shard`).');
  lines.push('- sidecar의 `senses[].history`: 과거 #716/#764/#772/#774 편집 기록에서 그 sense ID가 실제로 등장한 위치(`파일:줄` 또는 `파일#JSON경로`). `recorded_reasons`: 그 기록이 실제로 적은 문장의 인용이며, 없으면 `기록 없음`이다.');
  lines.push('- `senses[].hanja_in_canonical_text`: canonical 표제어·gloss에 문자 그대로 남아 있는 한자 연속열. 과거 기록 인용은 출처로만 쓰며 새 판정을 만들지 않는다.', '');

  lines.push('## 5. 커버리지·제약', '');
  lines.push(`- A(${num(c.meanings_with_2plus_senses)}개 Meaning)와 B(${num(c.lemmas_with_2plus_meanings)}개 lemma)를 \`data/meanings/\`에서 전수 추출했다. sidecar JSONL 줄 수(${num(c.review_lemmas)})는 \`A∪B\` 검토 대상 lemma 수와 같다.`);
  lines.push('- 같은 STDICT record 안의 병합과 서로 다른 record 간 병합을 모두 포함한다(A는 `sense_ids` 길이만 기준).');
  lines.push('- 구조 집계는 공통 validator(`complete: true`)로 canonical sense의 Meaning 귀속/DROP을 대조한 결과이며, 의미적 승인 상태와 혼동하지 않는다.');
  lines.push('- 과거 이유 대조는 `scripts/meaning/issue-{716,764,772,774}-*`에서 sense/Meaning ID가 **정확히** 등장하는 경우만 연결한다. `s1/s2` 축약 표기나 ID 없이 lemma만 적힌 서술은 자동 연결되지 않으므로 `기록 없음`이 “과거 판단이 없었다”는 뜻은 아니다.');
  lines.push('- 커밋된 canonical에는 STDICT 원어(한자) 필드가 없다. 한자는 canonical 텍스트에 문자로 남았거나 과거 감사가 옮겨 적은 경우만 표시된다.');
  lines.push('- `distinct_hanja_across_groups`는 그룹 간 한자 표기가 다르다는 사실 표시일 뿐 분리/병합 판정이 아니다.');
  lines.push(`- 재산출: \`node scripts/meaning/postmortem-report.mjs ${code} --input-sha ${inputSha ?? '<SHA>'}\` · 일치 검증: \`node scripts/meaning/postmortem-report.mjs ${code} --check\``, '');
  return lines.join('\n') + '\n';
}

export function renderAll(report, { inputSha, commit }) {
  return new Map([
    [`${reportName(report.code)}.md`, renderReport(report, { inputSha, commit })],
    [`${reportName(report.code)}.jsonl`, renderJsonl(report)],
  ]);
}

const defaultDirectories = () => ({
  meaningsDirectory: path.join(ROOT, 'data', 'meanings'),
  adjudicationDirectory: path.join(ROOT, 'data', 'adjudication'),
  canonicalDirectory: path.join(ROOT, 'data', 'canonical'),
});

function main(argv) {
  const options = { code: DEFAULT_CODE, inputSha: null, commit: null, check: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--check') options.check = true;
    else if (arg === '--input-sha') options.inputSha = argv[++i];
    else if (arg === '--commit') options.commit = argv[++i];
    else if (/^c\d{2}$/u.test(arg)) options.code = arg;
    else { console.error(`unknown argument: ${arg}`); return 2; }
  }
  const existing = path.join(MEANING_DIR, `${reportName(options.code)}.md`);
  if (!options.inputSha && existsSync(existing)) options.inputSha = /기준 master SHA: `([0-9a-f]{40})`/u.exec(readFileSync(existing, 'utf8'))?.[1] ?? null;
  if (!/^[0-9a-f]{40}$/u.test(options.inputSha ?? '')) { console.error('--input-sha <40-hex master SHA> is required'); return 2; }

  const report = buildReport({ code: options.code, ...defaultDirectories() });
  if (report.errors.length) {
    console.error(`common validator reported ${report.errors.length} error(s):\n${report.errors.slice(0, 20).join('\n')}`);
    return 1;
  }
  const files = renderAll(report, { inputSha: options.inputSha, commit: options.commit });
  if (options.check) {
    const stale = [...files].filter(([name, content]) => !existsSync(path.join(MEANING_DIR, name)) || readFileSync(path.join(MEANING_DIR, name), 'utf8') !== content).map(([name]) => name);
    if (stale.length) { console.error(`stale post-mortem output: ${stale.join(', ')}`); return 1; }
    console.log(`${options.code} post-mortem outputs match (${files.size} files)`);
    return 0;
  }
  mkdirSync(MEANING_DIR, { recursive: true });
  for (const [name, content] of files) writeFileSync(path.join(MEANING_DIR, name), content);
  console.log(`wrote ${options.code}: ${[...files.keys()].join(', ')}`);
  return 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) process.exitCode = main(process.argv.slice(2));
