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
export const HITS_PER_STRATUM = 5;
// A cell (candidate × stratum) sampled below its population needs at least this many hits for its sampling variation to be evaluated.
export const MIN_SELECTED_FOR_INTERVAL = 5;
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

/** Distinct-unit counts per stratum for one candidate's substring sample (the population the picked hits are drawn from). */
export function stratumPopulation(units) {
  const seen = new Set();
  const population = { dropped: 0, kept: 0 };
  for (const unit of units) {
    if (seen.has(unit.location_digest)) continue;
    seen.add(unit.location_digest);
    population[boundaryMatches(unit).length ? 'kept' : 'dropped'] += 1;
  }
  return population;
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

export const BOOTSTRAP = Object.freeze({ resamples: 2000, interval: [0.025, 0.975], min_valid_share: 0.9 });

// Deterministic PRNG (mulberry32) seeded from the candidate ids, so the report is reproducible.
function seededRandom(seedText) {
  let state = parseInt(sha(seedText).slice(0, 8), 16) >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const judgedOf = (list) => list.filter((row) => row.label !== 'unclear');
const totalOf = (list) => list.reduce((sum, row) => sum + row.weight, 0);
const rateOf = (list, label) => {
  const base = judgedOf(list);
  return base.length ? totalOf(base.filter((row) => row.label === label)) / totalOf(base) : null;
};

function estimate(rows) {
  const kept = rows.filter((row) => row.stratum === 'kept');
  const baselineOther = rateOf(rows, 'other_word');
  const keptOther = rateOf(kept, 'other_word');
  const sameAll = totalOf(judgedOf(rows).filter((row) => row.label === 'same_word'));
  const droppedSame = totalOf(judgedOf(rows.filter((row) => row.stratum === 'dropped')).filter((row) => row.label === 'same_word'));
  return {
    baselineOther,
    keptOther,
    reduction: baselineOther && keptOther !== null ? (baselineOther - keptOther) / baselineOther : null,
    droppedSameShare: sameAll ? droppedSame / sameAll : null,
  };
}

const round4 = (value) => (value === null ? null : Number(value.toFixed(4)));
const percentile = (sorted, q) => sorted[Math.min(sorted.length - 1, Math.max(0, Math.floor(q * sorted.length)))];

/**
 * Two-stage percentile bootstrap of the two criteria quantities: candidates are resampled with replacement, and inside
 * each drawn candidate every sampled cell (candidate × stratum) redraws its `selected` hits with replacement from the
 * observed ones, so both between-candidate variation and the variation of picking only a few hits from a large stratum
 * are reflected. Cells that are fully enumerated (selected = population) have no sampling variation. If any partly
 * sampled cell has fewer than MIN_SELECTED_FOR_INTERVAL hits, that variation cannot be evaluated reliably and the
 * interval is `null` (not evaluable) instead of a degenerate one.
 */
export function bootstrapInterval(rows) {
  const clusters = [...Map.groupBy(rows, (row) => row.candidate_id).values()]
    .map((cluster) => [...Map.groupBy(cluster, (row) => row.stratum).values()]);
  const underSampled = clusters.flat().filter((cell) => cell[0].selected < cell[0].population && cell[0].selected < MIN_SELECTED_FOR_INTERVAL).length;
  const base = { method: 'two_stage_percentile_bootstrap', clusters: clusters.length, resamples: BOOTSTRAP.resamples, under_sampled_cells: underSampled };
  if (underSampled > 0) return { ...base, evaluable: false, relative_other_word_reduction: null, same_word_dropped_share: null };
  const random = seededRandom('bootstrap-414:' + rows.map((row) => row.candidate_id).sort().join(','));
  const redraw = (cell) => (cell[0].selected === cell[0].population ? cell : Array.from({ length: cell.length }, () => cell[Math.floor(random() * cell.length)]));
  const reductions = [];
  const shares = [];
  for (let index = 0; index < BOOTSTRAP.resamples; index += 1) {
    const sample = Array.from({ length: clusters.length }, () => clusters[Math.floor(random() * clusters.length)]).flat().flatMap(redraw);
    const { reduction, droppedSameShare } = estimate(sample);
    if (reduction !== null) reductions.push(reduction);
    if (droppedSameShare !== null) shares.push(droppedSameShare);
  }
  const usable = (list) => list.length >= BOOTSTRAP.resamples * BOOTSTRAP.min_valid_share;
  const interval = (list) => (usable(list)
    ? (list.sort((a, b) => a - b), [round4(percentile(list, BOOTSTRAP.interval[0])), round4(percentile(list, BOOTSTRAP.interval[1]))])
    : null);
  const result = { relative_other_word_reduction: interval(reductions), same_word_dropped_share: interval(shares) };
  return { ...base, evaluable: result.relative_other_word_reduction !== null && result.same_word_dropped_share !== null, ...result };
}

/** Rows of one candidate and stratum must agree on population/selected, and `selected` must equal the row count. */
function assertConsistentSampling(rows) {
  const groups = Map.groupBy(rows, (row) => row.candidate_id + '\0' + row.stratum);
  for (const list of groups.values()) {
    const { candidate_id: candidate, stratum, population, selected } = list[0];
    if (list.some((row) => row.population !== population || row.selected !== selected)) {
      throw new Error(`${candidate}/${stratum}: conflicting population/selected metadata across rows`);
    }
    if (list.length !== selected) throw new Error(`${candidate}/${stratum}: selected ${selected} does not match ${list.length} mapping rows`);
  }
}

/**
 * Text-free, stratum-weighted aggregate. `mapping` is {hitId: {candidate_id, stratum, population, selected}}: the
 * candidate's distinct substring units in that stratum and how many of them were picked. Each judged hit stands for
 * population/selected units (Horvitz–Thompson weight), so the over-sampling of the small dropped stratum cannot move
 * the rates. Rates describe the capped scatter sample the retriever reads, not the whole corpus. `unclear` hits are
 * excluded from the rates and reported. `criteria_met` is true only when the 95 % two-stage bootstrap
 * interval clears both criteria (lower bound of the reduction, upper bound of the dropped same-word share); the
 * point estimates alone are reported as `point_estimate_meets_criteria` and are never a decision.
 */
export function aggregateLabels(mapping, labels) {
  const rows = Object.entries(mapping).map(([id, entry]) => {
    const { candidate_id: candidate, stratum, population, selected } = entry;
    if (typeof candidate !== 'string' || !['kept', 'dropped'].includes(stratum) || !Number.isSafeInteger(population) || !Number.isSafeInteger(selected) || selected < 1 || population < selected) {
      throw new Error(`${id}: mapping needs candidate_id, a stratum and integer population >= selected >= 1`);
    }
    return { candidate_id: candidate, stratum, population, selected, weight: population / selected, ...labels[id] };
  });
  assertConsistentSampling(rows);
  const kept = rows.filter((row) => row.stratum === 'kept');
  const dropped = rows.filter((row) => row.stratum === 'dropped');
  const point = estimate(rows);
  const interval = bootstrapInterval(rows);
  const pointMet = point.reduction !== null && point.droppedSameShare !== null
    && point.reduction >= CRITERIA.min_relative_other_word_reduction && point.droppedSameShare <= CRITERIA.max_dropped_same_word_share;
  const intervalMet = interval.relative_other_word_reduction !== null && interval.same_word_dropped_share !== null
    && interval.relative_other_word_reduction[0] >= CRITERIA.min_relative_other_word_reduction
    && interval.same_word_dropped_share[1] <= CRITERIA.max_dropped_same_word_share;
  const types = Object.fromEntries(OTHER_WORD_TYPES.map((type) => [type, {
    dropped_weighted: Number(totalOf(dropped.filter((r) => r.type === type)).toFixed(2)),
    kept_weighted: Number(totalOf(kept.filter((r) => r.type === type)).toFixed(2)),
  }]));
  return {
    estimator: 'stratum_weighted_by_candidate_population_over_selected',
    sampled_hits: rows.length,
    sampled_by_stratum: { dropped: dropped.length, kept: kept.length },
    represented_units: { dropped: Math.round(totalOf(dropped)), kept: Math.round(totalOf(kept)) },
    unclear: { hits: rows.length - judgedOf(rows).length, weighted_units: Math.round(totalOf(rows) - totalOf(judgedOf(rows))) },
    other_word_rate: { substring: round4(point.baselineOther), eojeol: round4(point.keptOther) },
    relative_other_word_reduction: round4(point.reduction),
    same_word_dropped_share: round4(point.droppedSameShare),
    uncertainty: interval,
    other_word_by_type: types,
    criteria: CRITERIA,
    point_estimate_meets_criteria: pointMet,
    criteria_met: intervalMet,
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
    const units = fetchSubstringUnits({ searchForms });
    const population = stratumPopulation(units);
    const hits = pickHits(units);
    for (const unit of hits) picked.push({ ...unit, candidate_id: id, lemma: row.input, population: population[unit.stratum], selected: hits.filter((hit) => hit.stratum === unit.stratum).length });
  }
  const shuffled = picked.sort(byKey((hit) => sha('order-414:' + hit.candidate_id + hit.location_digest)));
  const mapping = {};
  const lines = ['# 문학 근거 히트 판정 (#414, 맹검)', '', '각 항목의 일치 형이 표제어 그대로의 쓰임이면 `same_word`, 인명·합성어·다른 표제어의 일부·한자 동형어면 `other_word`(+type), 불명이면 `unclear`.', ''];
  shuffled.forEach((hit, index) => {
    const id = 'H' + String(index + 1).padStart(3, '0');
    mapping[id] = { candidate_id: hit.candidate_id, stratum: hit.stratum, form: hit.form, population: hit.population, selected: hit.selected };
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
