import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { buildCanonicalIndex, classifyLemmaCandidate } from '../factory/identity-adapter.mjs';
import { loadCanonicalEntries } from '../factory/validate.mjs';
import { resolveTypewriterCachePaths } from '../typewriter-cache.mjs';
import { evidenceForCandidate, loadEvidenceContext } from './literature-evidence-run.mjs';
import { DEFAULT_FULL_LITERATURE_INDEX_PATH, REPOSITORY_DIRECTORY } from './literature-index.mjs';

// Issue #392 entry validation (docs/literature-evidence-validation-plan.md). The owner judges; this tool only
// selects, blinds, seals and aggregates. Raw text and the unblinding map stay under the local cache.

const CACHE_PATHS = resolveTypewriterCachePaths();
export const VALIDATION_DIRECTORY = path.join(CACHE_PATHS.evidence, 'validation-392');
export const SELFCHECK_PATH = path.join(REPOSITORY_DIRECTORY, 'scripts/reference/literature-evidence-selfcheck-391.json');
export const STRATA = [
  { id: 'deferred_supports', count: 4, match: (row) => row.group === 'deferred' && row.evidence_use === 'supports' && row.outcome.startsWith('resolved_') },
  { id: 'deferred_no_effect', count: 2, match: (row) => row.group === 'deferred' && row.evidence_use === 'no_effect' },
  { id: 'deferred_noise', count: 3, match: (row) => row.group === 'deferred' && row.evidence_use === 'misleading_noise' },
  { id: 'deferred_other_sense', count: 1, match: (row) => row.group === 'deferred' && row.evidence_use === 'exposes_other_sense' },
  { id: 'control_included', count: 2, match: (row) => row.group === 'clear_included' },
];
export const DISPOSITIONS = ['included', 'covered', 'rejected', 'deferred'];
export const CONFIDENCES = ['high', 'medium', 'low'];
export const LITERATURE_ROLES = ['helpful', 'irrelevant', 'misleading'];
export const BASIS_TYPES = ['sense_demonstrated', 'contrast_exposed', 'none'];
export const IMPROVEMENT_MINIMUM = 5; // of the 10 deferred cases (all strata; none excluded)
export const MISLEADING_REVIEW_MINIMUM = 3; // of 12

const sha = (text) => createHash('sha256').update(text).digest('hex');

// Deterministic, reproducible: stratum rows ordered by sha256("validation-392:" + id), first `count` taken.
export function selectCohort(rows) {
  const cohort = [];
  for (const stratum of STRATA) {
    const picked = rows.filter(stratum.match)
      .map((row) => ({ row, key: sha('validation-392:' + row.candidate_id) }))
      .sort((a, b) => a.key.localeCompare(b.key))
      .slice(0, stratum.count);
    if (picked.length !== stratum.count) throw new Error(`stratum ${stratum.id} has ${picked.length} of ${stratum.count} rows`);
    for (const { row } of picked) cohort.push({ candidate_id: row.candidate_id, stratum: stratum.id, selected_location_digests: row.selected_location_digests });
  }
  const ordered = cohort.sort((a, b) => sha('order-392:' + a.candidate_id).localeCompare(sha('order-392:' + b.candidate_id)));
  return ordered.map((entry, index) => ({ blind_id: 'V' + String(index + 1).padStart(2, '0'), ...entry }));
}

const isDeferredStratum = (stratum) => stratum.startsWith('deferred_');

function validateJudgment(judgment, phase, contextCount) {
  const errors = [];
  if (!DISPOSITIONS.includes(judgment?.disposition)) errors.push('disposition');
  if (!CONFIDENCES.includes(judgment?.confidence)) errors.push('confidence');
  if (!Number.isFinite(judgment?.seconds) || judgment.seconds < 0) errors.push('seconds');
  if (typeof judgment?.basis !== 'string' || judgment.basis.trim() === '') errors.push('basis');
  if (phase === 2) {
    if (!LITERATURE_ROLES.includes(judgment?.literature_role)) errors.push('literature_role');
    if (!BASIS_TYPES.includes(judgment?.basis_type)) errors.push('basis_type');
    const cited = judgment?.cited_contexts;
    if (!Array.isArray(cited) || new Set(cited).size !== cited.length
      || cited.some((n) => !Number.isInteger(n) || n < 1 || n > (contextCount ?? 0))) errors.push('cited_contexts');
    if (typeof judgment?.conflicts_with_source_evidence !== 'boolean') errors.push('conflicts_with_source_evidence');
    if (typeof judgment?.owner_endorses_final !== 'boolean') errors.push('owner_endorses_final');
  }
  return errors;
}

// Phase 2 needs `contextCounts` (blind id → number of contexts actually revealed) so a citation must exist.
export function validateJudgments(file, blindIds, phase, contextCounts = {}) {
  const errors = [];
  for (const id of blindIds) {
    if (!file?.judgments?.[id]) { errors.push(`${id}: missing`); continue; }
    for (const field of validateJudgment(file.judgments[id], phase, contextCounts[id])) errors.push(`${id}: ${field}`);
  }
  return errors;
}

const confirmed = (disposition) => disposition !== 'deferred';
const confident = (confidence) => confidence !== 'low';

// Pre-registered classification (fixed before any judgment is read). `improvement` needs ALL of: the owner was
// deferred before the pack; a confirmed disposition with confidence ≥ medium after it; the literature marked
// helpful with a cited context whose basis is a demonstrated sense or exposed contrast (not frequency or mere
// co-occurrence); no conflict with the ordinary source evidence; and the owner endorses it as the final record.
export function classifyCase(stratum, one, two) {
  const harm = [];
  if (confirmed(one.disposition) && confident(one.confidence) && two.disposition !== one.disposition
    && (two.literature_role === 'misleading' || !two.owner_endorses_final)) harm.push('confident_judgment_displaced');
  if (confirmed(two.disposition) && two.literature_role === 'misleading') harm.push('confirmation_driven_by_misleading_evidence');
  if (confirmed(two.disposition) && two.conflicts_with_source_evidence) harm.push('conflicts_with_source_evidence');
  const improvement = isDeferredStratum(stratum) && one.disposition === 'deferred' && confirmed(two.disposition)
    && confident(two.confidence) && two.literature_role === 'helpful' && two.cited_contexts.length > 0
    && two.basis_type !== 'none' && !two.conflicts_with_source_evidence && two.owner_endorses_final && harm.length === 0;
  const changed = one.disposition !== two.disposition;
  const outcome = harm.length ? 'harm' : improvement ? 'improvement' : changed ? 'unqualified_change' : 'unchanged';
  return { outcome, harm };
}

// A seal is written once. Re-running it is allowed only for the identical answers and cohort; anything else
// (edited answers, another cohort) fails closed so a late change cannot pass the reveal check.
export function nextSeal(existing, phase1Digest, cohortDigest, now) {
  if (existing && (existing.phase1_sha256 !== phase1Digest || existing.cohort_sha256 !== cohortDigest)) {
    throw new Error('phase 1 is already sealed with different answers or cohort; refusing to reseal.');
  }
  return existing ?? { phase1_sha256: phase1Digest, cohort_sha256: cohortDigest, sealed_at: now };
}

export function assertSealed(seal, phase1Digest, cohortDigest) {
  if (!seal || seal.phase1_sha256 !== phase1Digest || seal.cohort_sha256 !== cohortDigest) {
    throw new Error('phase 1 is not sealed (or answers/cohort changed after sealing); refusing to reveal literature evidence.');
  }
}

export function aggregate(cohort, phase1, phase2, contextCounts) {
  const errors = [...validateJudgments(phase1, cohort.map((entry) => entry.blind_id), 1), ...validateJudgments(phase2, cohort.map((entry) => entry.blind_id), 2, contextCounts)];
  if (errors.length) throw new Error('judgments invalid: ' + errors.join(', '));
  const cases = cohort.map((entry) => ({ entry, ...classifyCase(entry.stratum, phase1.judgments[entry.blind_id], phase2.judgments[entry.blind_id]) }));
  const deferred = cases.filter(({ entry }) => isDeferredStratum(entry.stratum));
  const controls = cases.filter(({ entry }) => !isDeferredStratum(entry.stratum));
  const improvements = deferred.filter((item) => item.outcome === 'improvement').length;
  const harms = cases.filter((item) => item.outcome === 'harm').length;
  const misleading = cohort.filter((entry) => phase2.judgments[entry.blind_id].literature_role === 'misleading').length;
  const controlsStable = controls.every((item) => item.outcome === 'unchanged');
  const seconds = (phase) => cohort.map((entry) => phase.judgments[entry.blind_id].seconds).sort((a, b) => a - b);
  const median = (values) => (values.length ? values[Math.floor((values.length - 1) / 2)] : null);
  let recommendation = 'hold_392_literature_optional';
  if (harms === 0 && improvements >= IMPROVEMENT_MINIMUM && controlsStable) recommendation = 'candidate_for_392_entry';
  else if (harms > 0 || misleading >= MISLEADING_REVIEW_MINIMUM) recommendation = 'review_retriever_defects_then_hold_392';
  return {
    contract: 'literature-validation-392-aggregate-v1',
    cases: cohort.length,
    deferred_cases: deferred.length,
    improvements,
    improvement_minimum: IMPROVEMENT_MINIMUM,
    harms,
    misleading_roles: misleading,
    misleading_review_minimum: MISLEADING_REVIEW_MINIMUM,
    controls_stable: controlsStable,
    outcomes: Object.fromEntries(['improvement', 'unqualified_change', 'unchanged', 'harm'].map((name) => [name, cases.filter((item) => item.outcome === name).length])),
    harm_kinds: [...new Set(cases.flatMap((item) => item.harm))].sort(),
    per_stratum: Object.fromEntries(STRATA.map((stratum) => [stratum.id, Object.fromEntries(['improvement', 'unqualified_change', 'unchanged', 'harm'].map((name) => [name, cases.filter((item) => item.entry.stratum === stratum.id && item.outcome === name).length]))])),
    median_seconds_phase1: median(seconds(phase1)),
    median_seconds_phase2: median(seconds(phase2)),
    recommendation,
    limits: 'Twelve owner-judged cases; directional only, not accuracy or generalization.',
  };
}

// --- local tooling (reads the repository and local caches) ------------------------------------------------

async function readJson(file) { return JSON.parse(await readFile(file, 'utf8')); }
// Only a missing file is "absent"; an unreadable or corrupt file must fail closed, never read as absent.
// Absence is its own state, never a JSON value: a file containing `null` still exists.
export async function readOptionalJson(file) {
  let text;
  try { text = await readFile(file, 'utf8'); } catch (error) { if (error?.code === 'ENOENT') return { exists: false }; throw error; }
  return { exists: true, value: JSON.parse(text) };
}

const DIGEST_PATTERN = /^[0-9a-f]{64}$/;
export function validateSealRecord(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)
    || !DIGEST_PATTERN.test(value.phase1_sha256) || !DIGEST_PATTERN.test(value.cohort_sha256) || typeof value.sealed_at !== 'string') {
    throw new Error('seal file is invalid; refusing to continue.');
  }
  return value;
}

// Existing seal state: null when the file is absent, the validated record otherwise (invalid content throws).
export async function readSeal(file) {
  const result = await readOptionalJson(file);
  return result.exists ? validateSealRecord(result.value) : null;
}
async function writeJson(file, value) { await writeFile(file, JSON.stringify(value, null, 2) + '\n'); }
const fileDigest = async (file) => sha(await readFile(file));

const corpusParagraph = (() => {
  const documents = new Map();
  return async (ref) => {
    const [documentId, paragraphId] = ref.split('#');
    const fileId = documentId.split('.')[0];
    if (!documents.has(fileId)) documents.set(fileId, await readJson(path.join(CACHE_PATHS.root, 'corpus', fileId + '.json')));
    const document = documents.get(fileId).document.find((candidate) => candidate.id === documentId);
    return document?.paragraph.find((paragraph) => paragraph.id === paragraphId)?.form ?? null;
  };
})();

async function pastAddedGlosses(batchId, candidateId) {
  const lines = (await readFile(path.join(REPOSITORY_DIRECTORY, 'data/reviews', batchId, 'decisions.jsonl'), 'utf8')).split('\n').filter(Boolean);
  const decision = lines.map((line) => JSON.parse(line)).find((entry) => entry.source_candidate_id === candidateId);
  return new Set((decision?.reviewed_record?.senses ?? []).map((sense) => sense.gloss));
}

async function phase1Material(entry, context) {
  const [batchId] = entry.candidate_id.split('-');
  const { loadFactoryCandidate } = await import('./literature-evidence.mjs');
  const row = await loadFactoryCandidate({ batchId, candidateId: entry.candidate_id, root: REPOSITORY_DIRECTORY });
  const hidden = await pastAddedGlosses(batchId, entry.candidate_id);
  const routes = classifyLemmaCandidate(row, context.canonicalIndex).routes;
  const existingIds = [...new Set(routes.flatMap((route) => route.existingEntryIds ?? []))];
  const lines = [`# ${entry.blind_id} — 사전 자료 (문학 근거 없음)`, '', `표제어 후보: **${row.input}** · POS 가설: ${row.pos_hypotheses.join(', ')}`, ''];
  lines.push('## 관찰 표면형');
  for (const form of row.forms) lines.push(`- ${form.surface}`);
  lines.push('', '## 사용 그룹');
  for (const group of row.usage_groups) lines.push(`- ${group.group_id.split('.').pop()}: ${group.pos}`);
  lines.push('', '## 현재 기존 항목의 뜻');
  const shown = existingIds.flatMap((id) => context.entriesById.get(id) ? [context.entriesById.get(id)] : []);
  if (shown.length === 0) lines.push('(기존 항목 없음)');
  for (const found of shown) {
    lines.push(`- ${found.lemma}`);
    for (const sense of found.senses.filter((candidate) => !hidden.has(candidate.gloss))) lines.push(`  - (${sense.pos}) ${sense.gloss}`);
  }
  lines.push('', '## 말뭉치 관찰 문단');
  for (const observation of row.observations) {
    const form = row.forms.find((candidate) => candidate.form_id === observation.form_id)?.surface ?? '';
    const text = await corpusParagraph(observation.evidence.ref);
    lines.push(`### ${observation.observation_id.split('.').pop()} · ${form} · ${observation.pos}`, text ?? '(문단을 찾지 못함)', '');
  }
  return lines.join('\n');
}

function phase2Material(entry, result) {
  const lines = [`# ${entry.blind_id} — 문학 근거 (참고용 보조 근거; 품사·뜻·처분 판단 없음, 무히트는 부정 근거 아님)`, ''];
  result.contexts.forEach((context, index) => {
    lines.push(`## ${index + 1}. ${context.genre}`, '');
    for (const unit of context.units) lines.push((unit.is_hit ? '> ' : '  ') + unit.text.trim());
    lines.push('');
  });
  return lines.join('\n');
}

const PHASE1_FIELDS = '{ "disposition": "included|covered|rejected|deferred", "confidence": "high|medium|low", "basis": "짧은 근거", "seconds": 0 }';

async function prepare() {
  if ((await readOptionalJson(path.join(VALIDATION_DIRECTORY, 'owner', 'phase1-judgments.json'))).exists) {
    throw new Error('validation already prepared; refusing to overwrite recorded judgments.');
  }
  const record = await readJson(SELFCHECK_PATH);
  const cohort = selectCohort(record.rows);
  const context = await loadEvidenceContext();
  context.entriesById = new Map((await loadCanonicalEntries(REPOSITORY_DIRECTORY)).map((entry) => [entry.id, entry]));
  await mkdir(path.join(VALIDATION_DIRECTORY, 'owner', 'phase1'), { recursive: true });
  const cohortFile = path.join(VALIDATION_DIRECTORY, 'cohort.local.json');
  await writeJson(cohortFile, { contract: 'literature-validation-392-cohort-v1', selfcheck_sha256: await fileDigest(SELFCHECK_PATH), cohort });
  const template = {};
  for (const entry of cohort) {
    await writeFile(path.join(VALIDATION_DIRECTORY, 'owner', 'phase1', entry.blind_id + '.md'), await phase1Material(entry, context));
    template[entry.blind_id] = { disposition: null, confidence: null, basis: '', seconds: null };
  }
  await writeJson(path.join(VALIDATION_DIRECTORY, 'owner', 'phase1-judgments.json'), { phase: 1, fields: PHASE1_FIELDS, judgments: template });
  await writeFile(path.join(VALIDATION_DIRECTORY, 'owner', 'README.md'), [
    '# 문학 근거 검증 (#392) — 소유자 안내', '',
    '처분: `included`(새 뜻으로 수록) · `covered`(기존 뜻이 이미 포괄) · `rejected`(독립 항목/뜻으로 세우지 않음) · `deferred`(근거 부족으로 판단 불가).', '',
    '1. `phase1/V??.md`만 보고 `phase1-judgments.json`을 채운다 (처분, 확신도, 근거, 걸린 초). 문학 근거는 아직 없다.',
    '2. `pnpm run reference:literature:validate -- seal` 로 1단계를 봉인한다 (파일 digest 기록).',
    '3. `pnpm run reference:literature:validate -- reveal` 이 봉인을 확인한 뒤 `phase2/`와 `phase2-judgments.json`을 만든다.',
    '4. 2단계는 처분·확신도·근거·초 외에 `literature_role`(helpful|irrelevant|misleading), `basis_type`(sense_demonstrated|contrast_exposed|none), `cited_contexts`(문학 문맥 번호), `conflicts_with_source_evidence`, `owner_endorses_final`을 기록한다.',
    '5. 봉인 후 1단계 답을 고치지 않는다. `cohort.local.json`(층·후보 id)은 모든 판정이 끝나기 전에 열지 않는다.',
  ].join('\n') + '\n');
  console.log(JSON.stringify({ cohort_sha256: sha(JSON.stringify(cohort)), cases: cohort.length, directory: VALIDATION_DIRECTORY }, null, 2));
}

async function loadCohort() { return (await readJson(path.join(VALIDATION_DIRECTORY, 'cohort.local.json'))).cohort; }
const cohortDigest = (cohort) => sha(JSON.stringify(cohort));
const SEAL_FILE = path.join(VALIDATION_DIRECTORY, 'phase1-seal.local.json');

async function seal() {
  const cohort = await loadCohort();
  const file = path.join(VALIDATION_DIRECTORY, 'owner', 'phase1-judgments.json');
  const errors = validateJudgments(await readJson(file), cohort.map((entry) => entry.blind_id), 1);
  if (errors.length) throw new Error('phase 1 incomplete: ' + errors.join(', '));
  const existing = await readSeal(SEAL_FILE);
  const record = nextSeal(existing, await fileDigest(file), cohortDigest(cohort), new Date().toISOString());
  if (!existing) await writeJson(SEAL_FILE, record);
  console.log(existing ? 'phase 1 already sealed (unchanged)' : 'phase 1 sealed');
}

async function reveal() {
  const cohort = await loadCohort();
  const file = path.join(VALIDATION_DIRECTORY, 'owner', 'phase1-judgments.json');
  assertSealed(await readSeal(SEAL_FILE), await fileDigest(file), cohortDigest(cohort));
  const answers = path.join(VALIDATION_DIRECTORY, 'owner', 'phase2-judgments.json');
  if ((await readOptionalJson(answers)).exists) throw new Error('phase 2 already revealed; refusing to overwrite recorded judgments.');
  const context = await loadEvidenceContext();
  await mkdir(path.join(VALIDATION_DIRECTORY, 'owner', 'phase2'), { recursive: true });
  const template = {};
  const contextCounts = {};
  for (const entry of cohort) {
    const [batchId] = entry.candidate_id.split('-');
    const result = await evidenceForCandidate(context, { batchId, candidateId: entry.candidate_id, databasePath: DEFAULT_FULL_LITERATURE_INDEX_PATH, maxContexts: 5, maxPerWork: 1 });
    const digests = result.contexts.map((item) => item.location_digest);
    if (JSON.stringify(digests) !== JSON.stringify(entry.selected_location_digests)) throw new Error(`${entry.blind_id}: evidence differs from the recorded selection`);
    contextCounts[entry.blind_id] = result.contexts.length;
    await writeFile(path.join(VALIDATION_DIRECTORY, 'owner', 'phase2', entry.blind_id + '.md'), phase2Material(entry, result));
    template[entry.blind_id] = { disposition: null, confidence: null, basis: '', seconds: null, literature_role: null, basis_type: null, cited_contexts: [], conflicts_with_source_evidence: null, owner_endorses_final: null };
  }
  await writeJson(path.join(VALIDATION_DIRECTORY, 'context-counts.local.json'), contextCounts);
  await writeJson(answers, { phase: 2, judgments: template });
  console.log('phase 2 evidence written');
}

async function report() {
  const cohort = await loadCohort();
  const phase1 = await readJson(path.join(VALIDATION_DIRECTORY, 'owner', 'phase1-judgments.json'));
  const phase2 = await readJson(path.join(VALIDATION_DIRECTORY, 'owner', 'phase2-judgments.json'));
  const contextCounts = await readJson(path.join(VALIDATION_DIRECTORY, 'context-counts.local.json'));
  assertSealed(await readSeal(SEAL_FILE), await fileDigest(path.join(VALIDATION_DIRECTORY, 'owner', 'phase1-judgments.json')), cohortDigest(cohort));
  console.log(JSON.stringify(aggregate(cohort, phase1, phase2, contextCounts), null, 2));
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const commands = { prepare, seal, reveal, report };
  const command = commands[process.argv[2]];
  if (!command) { console.error('Usage: literature-validation.mjs <prepare|seal|reveal|report>'); process.exitCode = 1; } else {
    try { await command(); } catch (error) { console.error(error.message); process.exitCode = 1; }
  }
}
