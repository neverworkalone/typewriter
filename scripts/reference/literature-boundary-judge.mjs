import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { resolveTypewriterCachePaths } from '../typewriter-cache.mjs';
import { boundaryMatches, deriveSearchForms, fetchSubstringUnits, loadFactoryCandidate } from './literature-evidence.mjs';
import { loadEvidenceContext, supportedFormsForCandidate } from './literature-evidence-run.mjs';
import { assertLiteraturePermission, REPOSITORY_DIRECTORY } from './literature-index.mjs';
import { collectReplayCohort } from './literature-replay-cohort.mjs';
import { SELFCHECK_PATH, selectCohort, validateJudge } from './literature-validation.mjs';

// #414 judged false-positive measurement (docs/literature-evidence-boundary-issue-414.md, section C).
// This tool only samples, blinds and aggregates. The recorded judge (owner or an owner-delegated AI) labels each hit;
// the agent never does. Raw text and the unblinding map stay under the local cache; only counts leave it.

export const JUDGE_DIRECTORY = path.join(resolveTypewriterCachePaths().evidence, 'boundary-414');
export const SAMPLE_CANDIDATES = 30;
export const HITS_PER_STRATUM = 3;
export const LABELS = Object.freeze(['same_word', 'other_word', 'unclear']);
export const OTHER_WORD_TYPES = Object.freeze(['personal_name', 'compound', 'part_of_other_headword', 'hanja_homograph']);
export const CRITERIA = Object.freeze({ min_relative_other_word_reduction: 1 / 3, max_dropped_same_word_share: 0.1 });

const sha = (text) => createHash('sha256').update(text).digest('hex');
const byKey = (key) => (a, b) => (key(a) < key(b) ? -1 : key(a) > key(b) ? 1 : 0);

/** Candidates outside the #392 validation cohort, first SAMPLE_CANDIDATES by sha256("sample-414:" + id). */
export function sampleCandidateIds(deferredIds, excludedIds, count = SAMPLE_CANDIDATES) {
  const excluded = new Set(excludedIds);
  return deferredIds.filter((id) => !excluded.has(id)).sort(byKey((id) => sha('sample-414:' + id))).slice(0, count);
}

/**
 * Per candidate: up to HITS_PER_STRATUM dropped and kept units, ordered by sha256("hit-414:" + location digest).
 * `units` are distinct ({forms, text, location_digest}); a unit is kept iff any of its forms starts an eojeol,
 * exactly as the retriever decides. The shown `form` is a boundary form for kept units, the first form otherwise.
 */
export function pickHits(units, perStratum = HITS_PER_STRATUM) {
  const seen = new Set();
  const tagged = units.filter((unit) => !seen.has(unit.location_digest) && seen.add(unit.location_digest))
    .map((unit) => {
      const boundary = boundaryMatches(unit);
      return { ...unit, form: boundary[0]?.form ?? unit.forms[0], stratum: boundary.length ? 'kept' : 'dropped' };
    })
    .sort(byKey((unit) => sha('hit-414:' + unit.location_digest)));
  return ['dropped', 'kept'].flatMap((stratum) => tagged.filter((unit) => unit.stratum === stratum).slice(0, perStratum));
}

export function validateLabels(file, hitIds) {
  const errors = validateJudge(file);
  for (const id of hitIds) {
    const entry = file?.labels?.[id];
    if (!entry || !LABELS.includes(entry.label)) { errors.push(`${id}: label`); continue; }
    if (entry.label === 'other_word' && !OTHER_WORD_TYPES.includes(entry.type)) errors.push(`${id}: type`);
    if (entry.label !== 'other_word' && 'type' in entry) errors.push(`${id}: type only for other_word`);
  }
  return errors;
}

const rate = (numerator, denominator) => (denominator ? Number((numerator / denominator).toFixed(4)) : null);

/** Text-free aggregate. `mapping` is {hitId: {stratum}}; the substring baseline is dropped + kept together. */
export function aggregateLabels(mapping, labels) {
  const rows = Object.entries(mapping).map(([id, { stratum }]) => ({ stratum, ...labels[id] }));
  const judged = (list) => list.filter((row) => row.label !== 'unclear');
  const stratum = (name) => rows.filter((row) => row.stratum === name);
  const otherCount = (list) => judged(list).filter((row) => row.label === 'other_word').length;
  const baseline = rows;
  const kept = stratum('kept');
  const dropped = stratum('dropped');
  const baselineOther = rate(otherCount(baseline), judged(baseline).length);
  const keptOther = rate(otherCount(kept), judged(kept).length);
  const droppedSame = judged(dropped).filter((row) => row.label === 'same_word').length;
  const sameTotal = judged(baseline).filter((row) => row.label === 'same_word').length;
  const droppedSameShare = rate(droppedSame, sameTotal);
  const reduction = baselineOther ? Number(((baselineOther - keptOther) / baselineOther).toFixed(4)) : null;
  const types = Object.fromEntries(OTHER_WORD_TYPES.map((type) => [type, { dropped: dropped.filter((r) => r.type === type).length, kept: kept.filter((r) => r.type === type).length }]));
  return {
    hits: rows.length,
    unclear: rows.length - judged(rows).length,
    other_word_rate: { substring: baselineOther, eojeol: keptOther },
    relative_other_word_reduction: reduction,
    same_word_dropped_share: droppedSameShare,
    other_word_by_type: types,
    criteria: CRITERIA,
    criteria_met: reduction !== null && droppedSameShare !== null && reduction >= CRITERIA.min_relative_other_word_reduction && droppedSameShare <= CRITERIA.max_dropped_same_word_share,
  };
}

async function prepare(directory = JUDGE_DIRECTORY) {
  await assertLiteraturePermission();
  const context = await loadEvidenceContext();
  const record = JSON.parse(await readFile(SELFCHECK_PATH, 'utf8'));
  const validation = selectCohort(record.rows).map((entry) => entry.candidate_id);
  const cohort = (await collectReplayCohort(REPOSITORY_DIRECTORY)).filter((item) => item.category !== 'clear_included');
  const ids = sampleCandidateIds(cohort.map((item) => item.id), validation);
  const picked = [];
  for (const id of ids) {
    const item = cohort.find((entry) => entry.id === id);
    const row = await loadFactoryCandidate({ batchId: item.batch, candidateId: id });
    const searchForms = deriveSearchForms(row, supportedFormsForCandidate(row, context.canonicalIndex, context.support));
    for (const unit of pickHits(fetchSubstringUnits({ searchForms }))) picked.push({ ...unit, candidate_id: id, lemma: row.input });
  }
  const shuffled = picked.sort(byKey((hit) => sha('order-414:' + hit.candidate_id + hit.location_digest)));
  const mapping = {};
  const lines = ['# 문학 근거 히트 판정 (#414, 맹검)', '', '각 항목의 일치 형이 표제어 그대로의 쓰임이면 `same_word`, 인명·합성어·다른 표제어의 일부·한자 동형어면 `other_word`(+type), 불명이면 `unclear`.', ''];
  shuffled.forEach((hit, index) => {
    const id = 'H' + String(index + 1).padStart(3, '0');
    mapping[id] = { candidate_id: hit.candidate_id, stratum: hit.stratum, form: hit.form };
    lines.push(`## ${id} — 표제어 ${hit.lemma} · 검색형 ${hit.form}`, '', hit.text, '');
  });
  await mkdir(directory, { recursive: true });
  await writeFile(path.join(directory, 'hits.md'), lines.join('\n'), { flag: 'wx' });
  await writeFile(path.join(directory, 'mapping.local.json'), JSON.stringify(mapping, null, 2) + '\n', { flag: 'wx' });
  await writeFile(path.join(directory, 'labels.template.json'), JSON.stringify({ judge: { kind: 'ai_delegate', name: '<model>', delegated_by: 'owner' }, labels: Object.fromEntries(Object.keys(mapping).map((id) => [id, { label: '' }])) }, null, 2) + '\n', { flag: 'wx' });
  return { candidates: ids.length, hits: Object.keys(mapping).length, directory };
}

async function report(directory = JUDGE_DIRECTORY) {
  const mapping = JSON.parse(await readFile(path.join(directory, 'mapping.local.json'), 'utf8'));
  const file = JSON.parse(await readFile(path.join(directory, 'labels.json'), 'utf8'));
  const errors = validateLabels(file, Object.keys(mapping));
  if (errors.length) throw new Error('labels.json is invalid: ' + errors.slice(0, 10).join('; '));
  return { judge: file.judge, ...aggregateLabels(mapping, file.labels) };
}

if (import.meta.url === new URL(process.argv[1], 'file://').href) {
  const command = process.argv[2];
  if (!['prepare', 'report'].includes(command)) { console.error('Usage: literature-boundary-judge.mjs <prepare|report>'); process.exitCode = 1; }
  else console.log(JSON.stringify(command === 'prepare' ? await prepare() : await report(), null, 2));
}
