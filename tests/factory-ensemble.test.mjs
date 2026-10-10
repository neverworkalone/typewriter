import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { providerDescriptor } from '../scripts/factory/analyzer-providers.mjs';
import { expectedAnalyzerDigest, sha256Hex, validateCandidateBatch } from '../scripts/factory/contract.mjs';
import { alignedInContext, alignedOffset, contextSourceDigest, decisionSha256, contextDecisionsSha256, verifyDecisionsAgainstSource } from '../scripts/factory/context-fallback.mjs';
import {
  ENSEMBLE_POLICY,
  classifyObservation,
  ENSEMBLE_PROVIDER_ORDER,
  ensembleTraceSha256,
  reviewSummary,
  verifyEnsembleTraces,
} from '../scripts/factory/ensemble-resolver.mjs';
import { CONTEXT_PARAGRAPH_LOOKUP_SQL, createCorpusContextSource } from '../scripts/factory/corpus-context-source.mjs';
import { createMecabProvider, pinnedMetadata as mecabMetadata } from '../scripts/factory/mecab-provider.mjs';
import { POLICY_ALIASES, parseArguments, runStage1 } from '../scripts/factory/produce-candidates.mjs';
import { Stage1Error, compareResolutionPolicies, observationsFromCorpusEvidence, produceCandidateBatch } from '../scripts/factory/stage1.mjs';
import { resolveTypewriterCachePaths } from '../scripts/typewriter-cache.mjs';
import { loadBaseManifests, validateFactoryRepository } from '../scripts/factory/validate.mjs';
import { analysisInputDigest } from '../scripts/intake/pipeline.mjs';
import { HEX, hit, item, khaiii, kiwi, stub } from './support/khaiii-fixtures.mjs';
import { mergeUnresolved, trashIndex, restoreManifest, compactManifest, chunkText, validateTrashChunk, validateArchivedUnresolved, failedProposalLemmas, loadTrash } from '../scripts/factory/permanent-trash.mjs';
import { refillCandidateBatch } from '../scripts/factory/refill.mjs';
import { publishArtifacts, recoverArtifacts } from '../scripts/factory/artifact-transaction.mjs';
import { planHistoryMigration } from '../scripts/factory/migrate-candidate-history.mjs';
import { eligibleBatches } from '../scripts/factory/stage2-worker.mjs';
import { buildExclusionManifest, parseArguments as parseCorpusArguments } from '../scripts/reference/run-corpus-lemma-pilot.mjs';

// Synthetic providers (labeled synthetic: no native runtime runs here; the real-runtime smoke lives in
// tests/factory-ensemble-native-smoke.test.mjs and is skipped with a reason when a runtime is absent).
const mecab = (table) => { const inner = stub(table, mecabMetadata()); return { ...createMecabProvider({ analyze: inner.analyze }), calls: inner.calls }; };
const triple = ({ k = {}, h = {}, m = {} }) => [kiwi(k), khaiii(h), mecab(m)];
const P = (lemma, pos, form) => item(lemma, pos, form);
const p = (lemma, pos, form) => [P(lemma, pos, form)];

const cand = (lemma, pos, hits, extra = {}) => ({
  proposed_lemma: lemma, proposed_pos: pos, coverage_status: 'uncovered', ambiguity_status: 'clear',
  observed_surface_forms: [...new Set(hits.map((entry) => entry.matched_surface_form))].map((surface) => ({ surface })),
  evidence: { representative_hits: hits }, ...extra,
});
const h = (document, surface, paragraph = 'p1') => ({ ...hit(document, surface), paragraph_id: paragraph });
const evidenceDoc = (candidates) => ({
  contract_version: 'm9-corpus-candidate-evidence-v1',
  index: { input_manifest_sha256: HEX, logical_rows_sha256: 'b'.repeat(64) },
  extractor: { extractor_version: 'ex-1', kiwipiepy_version: '0.24.0', kiwipiepy_model_version: '0.24.0' },
  candidates,
});
async function cacheForTask(root, taskId = 'T000001') {
  const cachePaths = resolveTypewriterCachePaths({ homeDirectory: path.join(root, '.test-home'), env: {} });
  const taskDirectory = path.join(cachePaths.runs, taskId);
  await mkdir(taskDirectory, { recursive: true });
  return { cachePaths, taskDirectory, evidenceArgument: `runs/${taskId}/candidate-evidence.json` };
}
const produce = (candidates, providers, over = {}) => produceCandidateBatch({
  evidence: evidenceDoc(candidates), providers, policy: ENSEMBLE_POLICY, canonicalEntries: [], canonicalDigest: HEX, batchId: 'C000002', taskId: 'T000001', ...over,
});

// Result objects as `normalizeProviderResult` would emit for `classifyObservation` table cases.
const ok = (...paths) => ({ outcome: 'success', analyses: paths });
const results = ({ k, h: hh, m }) => ({ kiwi: k, khaiii: hh, mecab: m });
const HINT = { input: '가다', pos: 'verb' };
const classify = (cases, hint = HINT) => classifyObservation({ hint, results: results(cases) });

test('classification: stable, explicit categories and reason codes for every disagreement shape', () => {
  const gada = p('가다', 'verb', '가');
  const deul = p('걸다', 'verb', '걸');
  const geot = p('걷다', 'verb', '걷');
  const cases = [
    ['three-way agreement', { k: ok(gada), h: ok(gada), m: ok(gada) }, HINT, 'concordant', ['three_way_agreement']],
    ['Kiwi N-best non-top matches both others', { k: ok(deul, geot), h: ok(geot), m: ok(geot) }, { input: '걷다', pos: 'verb' }, 'supported_alternative', ['kiwi_alternative_supported']],
    ['one-vs-two: top and Khaiii agree, MeCab dissents without Kiwi support', { k: ok(gada), h: ok(gada), m: ok(geot) }, HINT, 'conflicted', ['one_vs_two_disagreement']],
    ['Kiwi isolated: Khaiii and MeCab agree on a reading Kiwi never ranked', { k: ok(gada), h: ok(geot), m: ok(geot) }, HINT, 'conflicted', ['kiwi_isolated_pair']],
    ['all three differ', { k: ok(gada), h: ok(geot), m: ok(deul) }, HINT, 'conflicted', ['all_three_differ']],
    ['pairwise agreement with the dissent supported by a Kiwi alternative', { k: ok(gada, geot), h: ok(gada), m: ok(geot) }, HINT, 'supported_alternative', ['kiwi_alternative_supported']],
    ['POS homograph without Kiwi support for the noun reading', { k: ok(p('다시', 'adverb')), h: ok(p('다시', 'noun')), m: ok(p('다시', 'adverb')) }, { input: '다시', pos: 'adverb' }, 'conflicted', ['one_vs_two_disagreement']],
    ['POS homograph where a Kiwi alternative supports the other POS', { k: ok(p('다시', 'adverb'), p('다시', 'noun')), h: ok(p('다시', 'noun')), m: ok(p('다시', 'adverb')) }, { input: '다시', pos: 'adverb' }, 'supported_alternative', ['kiwi_alternative_supported']],
    ['misleading common substring (extra prefix morpheme)', { k: ok([P('사', 'noun'), P('사랑하다', 'verb', '사랑하')]), h: ok(p('사랑하다', 'verb', '사랑하')), m: ok(p('사랑하다', 'verb', '사랑하')) }, { input: '사랑하다', pos: 'verb' }, 'conflicted', ['segmentation_incompatible']],
    ['compound segmentation has no single target morpheme', { k: ok([P('바람', 'noun'), P('물결', 'noun')]), h: ok(p('바람물결', 'noun')), m: ok(p('바람물결', 'noun')) }, { input: '바람물결', pos: 'noun' }, 'conflicted', ['no_single_target_morpheme']],
    ['derivation link is accepted: 망각 + 망각하다 agrees with the derived readings', {
      k: ok([P('망각', 'noun'), { ...P('망각하다', 'verb', '망각하'), derived_from: '망각', derived_from_index: 0 }]), h: ok(p('망각하다', 'verb')), m: ok(p('망각하다', 'verb')),
    }, { input: '망각하다', pos: 'verb' }, 'concordant', ['three_way_agreement']],
    ['Kiwi re-segmentation of the same stem (짠 + 하다, bare 짠) is not a rival', {
      k: ok(p('짠하다', 'adjective', '짠하'), [P('짠', 'adverb'), P('하다', 'verb', '하')], [P('짠', 'adverb')]), h: ok(p('짠하다', 'adjective', '짠하')), m: ok(p('짠하다', 'adjective', '짠하')),
    }, { input: '짠하다', pos: 'adjective' }, 'concordant', ['three_way_agreement']],
    ['a homograph path (가/noun beside 가다) is still a material rival', { k: ok(gada, p('가', 'noun')), h: ok(gada), m: ok(gada) }, HINT, 'conflicted', ['kiwi_unsupported_rival']],
    ['an unsupported Kiwi rival path blocks concordance', { k: ok(gada, p('가', 'noun')), h: ok(gada), m: ok(gada) }, HINT, 'conflicted', ['kiwi_unsupported_rival']],
    ['a mixed-script provider lemma is unresolved and excluded from typed hypotheses', {
      k: ok(p('플랜', 'noun', '플랜'), p('플랜A', 'noun', '플랜A')),
      h: ok(p('플랜', 'noun', '플랜')),
      m: ok(p('플랜', 'noun', '플랜')),
    }, { input: '플랜', pos: 'noun' }, 'unsupported_or_unknown', ['unsupported_lemma_shape']],
    ['missing/unsupported provider output', { k: ok(gada), h: { outcome: 'unsupported', analyses: [] }, m: ok(gada) }, HINT, 'unsupported_or_unknown', ['khaiii_unusable']],
    ['provider error', { k: ok(gada), h: ok(gada), m: { outcome: 'error', analyses: [] } }, HINT, 'unsupported_or_unknown', ['mecab_unusable']],
    ['provider-reported ambiguity is a conflict, never a guess', { k: { outcome: 'ambiguous', analyses: [] }, h: ok(gada), m: ok(gada) }, HINT, 'conflicted', ['kiwi_reported_ambiguous']],
  ];
  for (const [label, input, hint, category, reasons] of cases) {
    const decision = classify(input, hint);
    assert.equal(decision.category, category, label);
    assert.deepEqual(decision.reasons, reasons, label);
  }
  // Rival interpretations are recorded, not erased by the winner; the same input always gives the same decision.
  const alt = classify(cases[1][1], cases[1][2]);
  assert.deepEqual(alt.assigned, { lemma: '걷다', pos: 'verb' });
  assert.deepEqual(alt.hypotheses.map((entry) => [entry.lemma, entry.supporters]), [['걷다', ['khaiii', 'kiwi_alt', 'mecab']], ['걸다', ['kiwi_top']]]);
  assert.deepEqual(alt.rivals.map((entry) => entry.lemma), ['걸다']);
  assert.deepEqual(alt.holds, ['analysis_ambiguous'], 'the unsettled rival keeps a reviewable hold');
  assert.deepEqual(classify(cases[1][1], cases[1][2]), alt);
  const mixed = classify(cases[14][1], cases[14][2]);
  assert.deepEqual(mixed.hypotheses, [{ lemma: '플랜', pos: 'noun', supporters: ['khaiii', 'kiwi_top', 'mecab'] }]);
  assert.equal(JSON.stringify(mixed.hypotheses).includes('플랜A'), false);
});

test('a non-Hangul provider lemma stays held and yields a valid Stage 1 candidate manifest', async () => {
  const k = {
    가는: [p('가다', 'verb', '가')],
    플랜A: [p('플랜', 'noun', '플랜'), p('플랜A', 'noun', '플랜A')],
  };
  const hTable = { 가는: p('가다', 'verb', '가'), 플랜A: p('플랜', 'noun', '플랜') };
  const mTable = { 가는: p('가다', 'verb', '가'), 플랜A: p('플랜', 'noun', '플랜') };
  const result = await produce([
    cand('가다', 'verb', [h('d1', '가는')]),
    cand('플랜', 'noun', [h('d2', '플랜A')]),
  ], triple({
    k,
    h: Object.fromEntries(Object.entries(hTable).map(([surface, path]) => [surface, [path]])),
    m: Object.fromEntries(Object.entries(mTable).map(([surface, path]) => [surface, [path]])),
  }));

  assert.deepEqual(result.rows.map((row) => row.input), ['가다'], 'the unsupported analyzer lemma is never admitted');
  assert.equal(result.manifest.unresolved_observations.length, 1);
  const [queued] = result.manifest.unresolved_observations;
  assert.deepEqual([queued.surface, queued.category, queued.holds, queued.reasons], [
    '플랜A', 'unsupported_or_unknown', ['analysis_unsupported'], ['unsupported_lemma_shape'],
  ]);
  assert.deepEqual(queued.hypotheses, [{ lemma: '플랜', pos: 'noun', supporters: ['khaiii', 'kiwi_top', 'mecab'] }]);
  assert.deepEqual(validateCandidateBatch({ manifest: result.manifest, candidatesText: result.candidatesText }), []);
});

test('1: all three providers analyze the same complete unique surface set even when Kiwi resolves everything; repeats map to every observation', async () => {
  const k = { 가는: [p('가다', 'verb', '가')], 가서: [p('가다', 'verb', '가')], 짠한: [p('짠하다', 'adjective', '짠하')] };
  const providers = triple({ k, h: k, m: k });
  const result = await produce([
    cand('가다', 'verb', [h('d1', '가는'), h('d2', '가는'), h('d3', '가서')]),
    cand('짠하다', 'adjective', [h('d4', '짠한')]),
  ], providers);
  for (const provider of providers) assert.deepEqual(provider.calls, [['가는', '가서', '짠한']], `${provider.id}: one call, sorted unique surfaces, no conditional skip`);
  assert.deepEqual(result.summary.providerOrder, ['kiwi', 'khaiii', 'mecab']);
  assert.equal(result.summary.effectivePolicy, ENSEMBLE_POLICY);
  assert.deepEqual(result.summary.providerAttempts.kiwi.surfaces, 3);
  const gada = result.rows.find((row) => row.input === '가다');
  assert.deepEqual(gada.observations.map((o) => o.evidence.ref), ['d1#p1', 'd2#p1', 'd3#p1'], 'the repeated surface 가는 stays two separate source observations');
  assert.equal(result.manifest.resolution_policy, ENSEMBLE_POLICY);
  assert.deepEqual(result.manifest.analyzer_providers.map((entry) => entry.provider_id), ['kiwi', 'khaiii', 'mecab']);
  assert.deepEqual(validateCandidateBatch({ manifest: result.manifest, candidatesText: result.candidatesText }), []);
});

test('ensemble never degrades: missing, reordered, extra or crashing providers fail the whole production run closed', async () => {
  const k = { 가는: [p('가다', 'verb', '가')] };
  const base = [cand('가다', 'verb', [h('d1', '가는')])];
  await assert.rejects(() => produce(base, [kiwi(k), khaiii(k)]), /requires exactly the providers kiwi,khaiii,mecab/);
  await assert.rejects(() => produce(base, [kiwi(k)]), /never degrades/);
  await assert.rejects(() => produce(base, [khaiii(k), kiwi(k), mecab(k)]), /requires exactly/);
  const crashing = { ...mecab(k), analyze: async () => { throw new Error('boom'); } };
  await assert.rejects(() => produce(base, [kiwi(k), khaiii(k), crashing]), /mecab failed closed: boom/);
  // Metadata drift, duplicate ids, missing ids, stale digests and malformed analyses are untrustworthy coverage.
  const drift = { ...mecab(k), assertMetadata: () => { throw new Error('dictionary digest drifted'); } };
  await assert.rejects(() => produce(base, [kiwi(k), khaiii(k), drift]), /dictionary digest drifted/);
  const wrap = (provider, mutate) => ({ ...provider, analyze: async (requests) => { const response = await provider.analyze(requests); return { ...response, results: mutate(response.results, requests) }; } });
  await assert.rejects(() => produce(base, [kiwi(k), khaiii(k), wrap(mecab(k), (rows) => [...rows, rows[0]])]), /duplicate result ids/);
  await assert.rejects(() => produce(base, [kiwi(k), khaiii(k), wrap(mecab(k), () => [])]), /missing results/);
  await assert.rejects(() => produce(base, [kiwi(k), khaiii(k), wrap(mecab(k), (rows) => rows.map((row) => ({ ...row, input_digest: HEX })))]), /does not bind its surface/);
  await assert.rejects(() => produce(base, [kiwi(k), khaiii(k), wrap(mecab(k), (rows) => rows.map((row) => ({ ...row, analyses: [[{ lemma: 1 }]] })))]), /malformed/);
  await assert.rejects(() => produce(base, [kiwi(k), khaiii(k), wrap(mecab(k), (rows) => [...rows, { id: '없는표면', status: 'unsupported', analyses: [], input_digest: analysisInputDigest('없는표면') }])]), /not requested/);
  await assert.rejects(() => produceCandidateBatch({ ...{ evidence: evidenceDoc(base), providers: triple({ k, h: k, m: k }), canonicalEntries: [], canonicalDigest: HEX, batchId: 'C000002', taskId: 'T000001' }, policy: 'provider-resolution-v0' }), /unknown resolution policy/);
});

test('2/3: ensemble keeps competing Kiwi readings; a three-way vote never becomes verified correctness', async () => {
  const k = { 걸어: [p('걸다', 'verb', '걸'), p('걷다', 'verb', '걷')], 짠한: [p('짠하다', 'adjective', '짠하')], 지쳐: [p('지치다', 'verb', '지치')] };
  const hh = { 걸어: p('걷다', 'verb', '걷'), 짠한: p('짠하다', 'adjective', '짠하'), 지쳐: p('지치다', 'verb', '지치') };
  const result = await produce([
    cand('걷다', 'verb', [h('d1', '걸어')]),
    cand('짠하다', 'adjective', [h('d2', '짠한')]),
    // All three agree, but the extractor recorded an upstream hold the vote cannot clear.
    cand('지치다', 'verb', [h('d3', '지쳐')], { coverage_status: 'covered_elsewhere', ambiguity_status: 'held_analysis' }),
  ], triple({ k, h: Object.fromEntries(Object.entries(hh).map(([key, value]) => [key, [value]])), m: Object.fromEntries(Object.entries(hh).map(([key, value]) => [key, [value]])) }));
  const row = (lemma) => result.rows.find((entry) => entry.input === lemma);
  const alt = row('걷다').observations[0];
  assert.equal(alt.ensemble.category, 'supported_alternative');
  assert.deepEqual(alt.ensemble.alternatives.map((entry) => entry.lemma), ['걸다'], 'the rival reading is recorded');
  assert.deepEqual(alt.holds, ['analysis_ambiguous'], 'a supported alternative is review priority, not approval');
  assert.equal(row('걷다').review.priority, 'verify_first');
  const clear = row('짠하다').observations[0];
  assert.equal(clear.ensemble.category, 'concordant');
  assert.deepEqual(clear.holds, []);
  assert.equal(row('짠하다').review.priority, 'standard');
  const held = row('지치다').observations[0];
  assert.equal(held.ensemble.category, 'concordant');
  assert.deepEqual(held.holds, ['analysis_ambiguous', 'coverage_collision'], 'three-way agreement never clears extractor holds');
  const metrics = result.summary.ensemble;
  assert.equal(metrics.verified_correct, 'not_established');
  assert.equal(metrics.verified_wrong, 'not_established');
  assert.equal(metrics.accuracy, 'not_established');
  assert.equal(metrics.apparent_resolved, 3, 'apparent_resolved is a count of readings, not verified accuracy');
  assert.equal(JSON.stringify(result.manifest).includes('verified_correct'), false);
});

test('v2 producer holds a unanimous lemma that mismatches its source hint and passes a matching hint', async () => {
  const result = await produce([
    cand('덮이다', 'verb', [h('d-mismatch', '덮혀')]),
    cand('덮이다', 'verb', [h('d-match', '덮여')]),
  ], triple({
    k: { 덮혀: [p('덮히다', 'verb')], 덮여: [p('덮이다', 'verb')] },
    h: { 덮혀: [p('덮히다', 'verb')], 덮여: [p('덮이다', 'verb')] },
    m: { 덮혀: [p('덮히다', 'verb')], 덮여: [p('덮이다', 'verb')] },
  }));

  const mismatch = result.rows.find((row) => row.input === '덮히다').observations[0];
  assert.deepEqual(mismatch.holds, ['lemma_mismatch']);
  assert.ok(mismatch.ensemble.reasons.includes('extractor_hint_mismatch'));
  const mismatchDecision = result.ensemble.decisions.find((decision) => decision.assigned?.lemma === '덮히다');
  assert.deepEqual(mismatchDecision.holds, ['lemma_mismatch']);
  assert.equal(mismatchDecision.trace.extractor_hint.lemma, '덮이다');
  assert.ok(mismatchDecision.trace.reasons.includes('extractor_hint_mismatch'));
  assert.deepEqual(mismatchDecision.trace.observation_holds, ['lemma_mismatch']);

  const matching = result.rows.find((row) => row.input === '덮이다').observations[0];
  assert.deepEqual(matching.holds, []);
  assert.deepEqual(matching.ensemble.reasons, ['three_way_agreement']);
  const matchingDecision = result.ensemble.decisions.find((decision) => decision.assigned?.lemma === '덮이다'
    && decision.trace.extractor_hint.lemma === '덮이다');
  assert.deepEqual(matchingDecision.holds, []);
  assert.deepEqual(matchingDecision.trace.observation_holds, []);
  assert.deepEqual(validateCandidateBatch({ manifest: result.manifest, candidatesText: result.candidatesText }), []);
});

test('5/13: one lemma, separate source-bound observations; an ambiguous inflection never contaminates or vanishes because of a clear sibling', async () => {
  const k = { 가는: [p('가다', 'verb', '가')], 가서: [p('가다', 'verb', '가')], 갈: [p('갈', 'noun')] };
  const hh = { 가는: [p('가다', 'verb', '가')], 가서: [p('가다', 'verb', '가')], 갈: [p('갈다', 'verb', '갈')] };
  const mm = { 가는: [p('가다', 'verb', '가')], 가서: [p('가다', 'verb', '가')], 갈: [p('가다', 'verb', '가')] };
  const evidence = [cand('가다', 'verb', [h('d1', '가는'), h('d2', '가서'), h('d3', '갈')])];
  const without = await produce(evidence, triple({ k, h: hh, m: mm }));
  const row = without.rows[0];
  assert.equal(without.rows.length, 1, 'one lemma candidate');
  assert.deepEqual(row.forms.map((form) => form.surface), ['가는', '가서']);
  assert.deepEqual(row.observations.map((o) => [o.evidence.ref, o.holds]), [['d1#p1', []], ['d2#p1', []]], 'clear siblings keep no hold');
  assert.equal(without.manifest.candidate_count, 1);
  assert.equal(without.manifest.unresolved_observations.length, 1, 'the ambiguous inflection is preserved in the queue, never dropped');
  const [queued] = without.manifest.unresolved_observations;
  assert.deepEqual([queued.surface, queued.category, queued.verification], ['갈', 'conflicted', { state: 'needs_verification' }]);
  assert.deepEqual(queued.hypotheses.map((entry) => [entry.lemma, entry.pos, entry.supporters]), [['가다', 'verb', ['mecab']], ['갈', 'noun', ['kiwi_top']], ['갈다', 'verb', ['khaiii']]]);
  assert.equal(without.summary.metrics.unique_lemmas, 1, 'an unresolved observation is not counted as a headword');
  assert.deepEqual(validateCandidateBatch({ manifest: without.manifest, candidatesText: without.candidatesText }), []);
});

const SOURCE = {
  'd3#p1': { status: 'ok', text: '그는 천천히 갈 길을 정했다.' },
  'd9#p1': { status: 'ok', text: '우리는 갈대밭을 지나갔다.' },
};
const source = (table = SOURCE) => ({ lookup: async ({ kind, ref }) => (kind === 'corpus-paragraph' && table[ref] ? table[ref] : { status: 'absent' }) });
const FALLBACK = {
  k: { 가는: [p('가다', 'verb', '가')], 갈: [p('갈', 'noun')] },
  h: { 가는: [p('가다', 'verb', '가')], 갈: [p('갈다', 'verb', '갈')] },
  m: { 가는: [p('가다', 'verb', '가')], 갈: [p('가다', 'verb', '가')] },
};
const fallbackEvidence = [cand('가다', 'verb', [h('d1', '가는'), h('d3', '갈')])];
const queueOf = (result) => result.manifest.unresolved_observations;
const proposal = (entry, over) => ({ observation_digest: entry.observation_digest, ...over });

test('9: context confirms a source-backed lemma/POS → exactly one v2 lemma candidate with an attributed, text-free decision', async () => {
  const first = await produce(fallbackEvidence, triple(FALLBACK));
  const [entry] = queueOf(first);
  const recovered = await produce(fallbackEvidence, triple(FALLBACK), {
    contextProposals: [proposal(entry, { outcome: 'context_confirmed', lemma: '가다', pos: 'verb' })], contextSource: source(), contextAgent: 'claude',
  });
  assert.equal(recovered.rows.length, 1);
  assert.equal(recovered.manifest.candidate_count, 1);
  assert.equal(queueOf(recovered).length, 0);
  const recoveredObservation = recovered.rows[0].observations.find((o) => o.evidence.ref === 'd3#p1');
  assert.deepEqual([recoveredObservation.ensemble.resolution, recoveredObservation.ensemble.context_decision], ['context', 'D0001']);
  assert.deepEqual(recoveredObservation.holds, ['analysis_ambiguous'], 'an AI self-check recovery stays reviewable for Stage 2 and clears nothing');
  assert.equal(recoveredObservation.ensemble.category, 'conflicted', 'the morphological category is kept; the recovery is a separate attributed decision');
  assert.equal(Object.hasOwn(recovered.rows[0], 'usage_hint'), false, 'no imported v1 usage-row shape');
  const [decision] = recovered.manifest.context_fallback.decisions;
  assert.deepEqual([decision.outcome, decision.lemma, decision.pos, decision.reason_code], ['context_confirmed', '가다', 'verb', 'context_supports_reading']);
  assert.deepEqual(decision.author, { kind: 'agent-self-check', agent: 'claude' });
  assert.equal(decision.independent, false);
  assert.equal(decision.human_reviewed, false);
  assert.deepEqual(decision.considered.map((c) => c.lemma), ['가다', '갈', '갈다'], 'competing analyzer hypotheses are recorded');
  assert.equal(decision.source_digest, contextSourceDigest({ snapshot: `corpus:${HEX}:${'b'.repeat(64)}`, ref: 'd3#p1', text: SOURCE['d3#p1'].text, surface: '갈' }));
  // No paragraph text anywhere in the tracked artifacts.
  const tracked = JSON.stringify(recovered.manifest) + recovered.candidatesText;
  assert.equal(tracked.includes('천천히'), false);
  assert.equal(tracked.includes('길을'), false);
  assert.deepEqual(validateCandidateBatch({ manifest: recovered.manifest, candidatesText: recovered.candidatesText }), []);
  // 13: fallback touched only the ambiguous observation; the clear sibling is unchanged from the pre-fallback row.
  const sibling = (result) => result.rows[0].observations.find((o) => o.evidence.ref === 'd1#p1');
  assert.deepEqual(sibling(recovered), sibling(first));
});

test('10: context supports a DIFFERENT lemma/POS → the vote is not accepted; reassignment is evidence-bound and still held', async () => {
  const first = await produce(fallbackEvidence, triple(FALLBACK));
  const [entry] = queueOf(first);
  const result = await produce(fallbackEvidence, triple(FALLBACK), {
    contextProposals: [proposal(entry, { outcome: 'context_reassigned', lemma: '갈', pos: 'adverb' })], contextAgent: 'claude', contextSource: source(),
  });
  const reassigned = result.rows.find((row) => row.input === '갈');
  assert.ok(reassigned, 'the contextual result forms its own lemma candidate');
  assert.deepEqual(reassigned.observations[0].holds, ['analysis_ambiguous']);
  assert.equal(result.rows.find((row) => row.input === '가다').observations.length, 1, 'the analyzer majority did not absorb the observation');
  assert.equal(result.manifest.context_fallback.decisions[0].outcome, 'context_reassigned');
  assert.deepEqual(validateCandidateBatch({ manifest: result.manifest, candidatesText: result.candidatesText }), []);
  // A "confirmed" outcome may only name an analyzer hypothesis, a "reassigned" one may not.
  await assert.rejects(() => produce(fallbackEvidence, triple(FALLBACK), { contextProposals: [proposal(entry, { outcome: 'context_confirmed', lemma: '갈', pos: 'adverb' })], contextAgent: 'claude', contextSource: source() }), /must name an analyzer hypothesis/);
  await assert.rejects(() => produce(fallbackEvidence, triple(FALLBACK), { contextProposals: [proposal(entry, { outcome: 'context_reassigned', lemma: '가다', pos: 'verb' })], contextAgent: 'claude', contextSource: source() }), /use context_confirmed/);
});

test('11: absent/denied/weakly aligned/conflicting context keeps every hypothesis in the verification queue, uncounted', async () => {
  const first = await produce(fallbackEvidence, triple(FALLBACK));
  const [entry] = queueOf(first);
  const run = (table, extra = {}, outcome = { outcome: 'context_confirmed', lemma: '가다', pos: 'verb' }) => produce(fallbackEvidence, triple(FALLBACK), {
    contextProposals: [proposal(entry, outcome)], contextSource: table, contextAgent: 'claude', ...extra,
  });
  const cases = [
    ['no_source', source({})],
    ['permission_denied', { lookup: async () => ({ status: 'denied' }) }],
    ['permission_denied', { lookup: async () => { throw new Error('EACCES'); } }],
    ['weak_alignment', source({ 'd3#p1': { status: 'ok', text: '우리는 갈대밭을 지나갔다.' } })], // substring/prefix of a larger word is not alignment
    ['conflicting_readings', source(), { outcome: 'truth_unknown', reason_code: 'conflicting_readings' }],
  ];
  for (const [reason, table, outcome] of cases) {
    const result = await run(table, {}, outcome);
    const [queued] = queueOf(result);
    assert.equal(result.rows[0].observations.length, 1, reason);
    assert.equal(result.manifest.candidate_count, 1, `${reason}: not counted as a headword`);
    assert.deepEqual([queued.verification.state, result.manifest.context_fallback.decisions[0].reason_code], ['truth_unknown', reason]);
    assert.equal(queued.hypotheses.length, 3, 'competing hypotheses are preserved');
    assert.deepEqual(validateCandidateBatch({ manifest: result.manifest, candidatesText: result.candidatesText }), [], reason);
  }
  assert.equal(alignedInContext('우리는 갈대밭을 지나갔다.', '갈'), false);
  assert.equal(alignedInContext('그는 "갈" 길을 정했다.', '갈'), true, 'edge punctuation does not break whole-eojeol alignment');
});

test('12: recorded decisions replay deterministically without raw paragraphs; tampering and changed context fail closed', async () => {
  const first = await produce(fallbackEvidence, triple(FALLBACK));
  const [entry] = queueOf(first);
  const recorded = await produce(fallbackEvidence, triple(FALLBACK), { contextProposals: [proposal(entry, { outcome: 'context_confirmed', lemma: '가다', pos: 'verb' })], contextAgent: 'claude', contextSource: source() });
  const decisions = recorded.manifest.context_fallback.decisions;
  const replay = await produce(fallbackEvidence, triple(FALLBACK), { contextReplay: decisions }); // no contextSource: normal CI loads no paragraph
  assert.equal(replay.candidatesText, recorded.candidatesText);
  assert.deepEqual(replay.manifest, recorded.manifest);
  // Edited decision (content or digest), changed analyzer trace, wrong observation: all rejected.
  const edit = (patch, keepDigest = false) => decisions.map((decision) => { const next = { ...decision, ...patch }; return keepDigest ? next : { ...next, decision_sha256: decisionSha256(next) }; });
  await assert.rejects(() => produce(fallbackEvidence, triple(FALLBACK), { contextReplay: edit({ lemma: '가다', source_digest: HEX }, true) }), /tampered/);
  await assert.rejects(() => produce(fallbackEvidence, triple(FALLBACK), { contextReplay: edit({ trace_digest: HEX }) }), /analyzer trace changed/);
  await assert.rejects(() => produce(fallbackEvidence, triple(FALLBACK), { contextReplay: edit({ observation_digest: HEX }) }), /not an unresolved observation/);
  await assert.rejects(() => produce(fallbackEvidence, triple({ ...FALLBACK, k: { ...FALLBACK.k, 갈: [p('갈다', 'verb', '갈')] } }), { contextReplay: decisions }), /analyzer trace changed|not an unresolved/);
  await assert.rejects(() => produce(fallbackEvidence, triple(FALLBACK), { contextReplay: edit({ independent: true }) }), /agent self-check/);
  await assert.rejects(() => produce(fallbackEvidence, triple(FALLBACK), { contextReplay: edit({ human_reviewed: true }) }), /agent self-check/);
  // The local integration check recomputes the source digest from the live paragraph.
  const snapshot = `corpus:${HEX}:${'b'.repeat(64)}`;
  assert.deepEqual(await verifyDecisionsAgainstSource({ decisions, contextSource: source(), snapshot }), []);
  assert.match((await verifyDecisionsAgainstSource({ decisions, contextSource: source({ 'd3#p1': { status: 'ok', text: '그는 천천히 갈 길을 바꿨다.' } }), snapshot })).join(), /changed since/);
  assert.match((await verifyDecisionsAgainstSource({ decisions, contextSource: source({}), snapshot })).join(), /not available/);
  assert.match((await verifyDecisionsAgainstSource({ decisions, contextSource: source({ 'd3#p1': { status: 'ok', text: '갈대밭' } }), snapshot })).join(), /no longer aligns/);
  // A replay needs a policy that can express it; v1 never accepts a contextual decision.
  await assert.rejects(() => produceCandidateBatch({ evidence: evidenceDoc(fallbackEvidence), providers: [kiwi(FALLBACK.k)], canonicalEntries: [], canonicalDigest: HEX, batchId: 'C000002', taskId: 'T000001', contextReplay: decisions }), /only valid under/);
});

test('bounded batches record context decisions linked to rows, excluded lemmas, and verification queue', async () => {
  const evidence = [
    cand('가다', 'verb', [h('d1', '가는'), h('d3', '갈'), h('d4', '갈'), h('d5', '갈')]),
  ];
  const providers = triple(FALLBACK);
  const first = await produce(evidence, providers);
  const ordered = [...queueOf(first)].sort((left, right) => left.observation_digest.localeCompare(right.observation_digest));
  const [deferredEntry, retainedEntry, unknownEntry] = ordered;
  const contextProposals = [
    proposal(deferredEntry, { outcome: 'context_confirmed', lemma: '갈다', pos: 'verb' }),
    proposal(retainedEntry, { outcome: 'context_confirmed', lemma: '가다', pos: 'verb' }),
    proposal(unknownEntry, { outcome: 'truth_unknown', reason_code: 'conflicting_readings' }),
  ];
  const contextSource = source({
    [deferredEntry.evidence.ref]: { status: 'ok', text: '밭을 갈 수 있다.' },
    [retainedEntry.evidence.ref]: { status: 'ok', text: '그는 갈 길을 찾았다.' },
  });
  const bounded = await produce(evidence, providers, {
    maxCandidates: 1, contextProposals, contextSource, contextAgent: 'codex',
  });
  assert.deepEqual(bounded.rows.map((row) => row.input), ['가다']);
  assert.deepEqual(bounded.summary.deferredLemmas, ['갈다']);
  assert.deepEqual(bounded.manifest.context_fallback.decisions.map((decision) => decision.decision_id), ['D0001', 'D0002', 'D0003']);
  assert.deepEqual(bounded.manifest.context_fallback.decisions.map((decision) => decision.outcome), ['context_confirmed', 'context_confirmed', 'truth_unknown']);
  assert.equal(bounded.rows[0].observations.find((observation) => observation.ensemble.resolution === 'context').ensemble.context_decision, 'D0002');
  assert.equal(bounded.manifest.excluded_observations[0].ensemble.context_decision, 'D0001');
  assert.equal(queueOf(bounded)[0].verification.decision_id, 'D0003');
  assert.equal(bounded.manifest.ensemble.counts.observations, 4);
  assert.equal(bounded.manifest.ensemble.counts.excluded, 1);
  assert.deepEqual(validateCandidateBatch({ manifest: bounded.manifest, candidatesText: bounded.candidatesText }), []);

  const deferred = await produce(evidence, providers, {
    maxCandidates: 1, producedLemmas: new Set(['가다']), contextProposals, contextSource, contextAgent: 'codex',
  });
  assert.deepEqual(deferred.rows.map((row) => row.input), ['갈다']);
  assert.deepEqual(deferred.manifest.context_fallback.decisions.map((decision) => decision.decision_id), ['D0001', 'D0002', 'D0003']);
  assert.equal(deferred.manifest.context_fallback.decisions[0].lemma, '갈다', 'the deferred decision is recorded when its lemma is selected');
  assert.equal(deferred.rows[0].observations[0].ensemble.context_decision, deferred.manifest.context_fallback.decisions[0].decision_id);
  assert.equal(deferred.manifest.excluded_observations.length, 2);
  assert.ok(deferred.manifest.excluded_observations.every((entry) => entry.disposition === 'prior_produced_lemma' && entry.lemma === '가다'));
  assert.equal(deferred.manifest.excluded_observations.find((entry) => entry.ensemble.context_decision)?.ensemble.context_decision, 'D0002');
  assert.equal(queueOf(deferred)[0].verification.decision_id, 'D0003');
  assert.deepEqual(validateCandidateBatch({ manifest: deferred.manifest, candidatesText: deferred.candidatesText }), []);
});

test('fallback is not a bypass: blocked holds, missing source reference and assignable observations are never routed to context', async () => {
  const k = { 갈: [p('갈', 'noun')], 짠한: [p('짠하다', 'adjective', '짠하')] };
  const hh = { 갈: [p('갈다', 'verb', '갈')], 짠한: [p('짠하다', 'adjective', '짠하')] };
  const mm = { 갈: [p('가다', 'verb', '가')], 짠한: [p('짠하다', 'adjective', '짠하')] };
  const evidence = [
    cand('가다', 'verb', [h('d1', '갈')], { coverage_status: 'covered_elsewhere' }), // coverage hold
    cand('갈다', 'verb', [], {}), // no located source paragraph → no_evidence
    cand('짠하다', 'adjective', [h('d2', '짠한')]),
  ];
  const first = await produce(evidence, triple({ k, h: hh, m: mm }));
  const queue = queueOf(first);
  assert.ok(queue.length >= 2);
  for (const entry of queue) assert.equal(entry.verification.state, 'blocked', entry.surface);
  assert.deepEqual(queue.map((entry) => entry.verification.blocked_by).sort(), [['coverage_collision'], ['no_evidence', 'no_located_source']].sort());
  const blockedEntry = queue.find((entry) => entry.extractor_holds.includes('coverage_collision'));
  await assert.rejects(() => produce(evidence, triple({ k, h: hh, m: mm }), {
    contextProposals: [proposal(blockedEntry, { outcome: 'context_confirmed', lemma: '가다', pos: 'verb' })], contextAgent: 'claude', contextSource: source({ 'd1#p1': { status: 'ok', text: '갈 길' } }),
  }), /not allowed|not bypassable/);
  // An assignable observation has no queue entry, so a proposal for it is refused.
  const clear = first.rows.find((row) => row.input === '짠하다').observations[0];
  assert.equal(clear.ensemble.resolution, 'ensemble');
  await assert.rejects(() => produce(evidence, triple({ k, h: hh, m: mm }), {
    contextProposals: [{ observation_digest: HEX, outcome: 'context_confirmed', lemma: '짠하다', pos: 'adjective' }], contextAgent: 'claude', contextSource: source(),
  }), /not an unresolved observation/);
});

test('6: validator rejects forged, omitted or inconsistent ensemble traces and wrong digests', async () => {
  const first = await produce(fallbackEvidence, triple(FALLBACK));
  const [entry] = queueOf(first);
  const recovered = await produce(fallbackEvidence, triple(FALLBACK), { contextProposals: [proposal(entry, { outcome: 'context_confirmed', lemma: '가다', pos: 'verb' })], contextAgent: 'claude', contextSource: source() });
  const unknown = await produce(fallbackEvidence, triple(FALLBACK), { contextProposals: [proposal(entry, { outcome: 'truth_unknown', reason_code: 'no_source' })], contextAgent: 'claude', contextSource: source() });
  const check = (base, mutate) => {
    const manifest = structuredClone(base.manifest);
    const rows = base.candidatesText.trim().split('\n').map((line) => JSON.parse(line));
    mutate(manifest, rows);
    const text = `${rows.map((row) => JSON.stringify(row)).join('\n')}\n`;
    manifest.candidates_sha256 = sha256Hex(text);
    return validateCandidateBatch({ manifest, candidatesText: text }).join('\n');
  };
  assert.deepEqual(validateCandidateBatch({ manifest: first.manifest, candidatesText: first.candidatesText }), []);
  // Providers: omitted, reordered, replaced, policy downgraded/forged.
  const dropProvider = (id) => (manifest) => { manifest.analyzer_providers = manifest.analyzer_providers.filter((e) => e.provider_id !== id); manifest.analyzer_digest = expectedAnalyzerDigest(manifest); };
  for (const id of ENSEMBLE_PROVIDER_ORDER) assert.match(check(first, dropProvider(id)), /requires analyzer_providers exactly/, `omitting ${id}`);
  assert.match(check(first, (manifest) => { manifest.analyzer_providers.reverse(); manifest.analyzer_digest = expectedAnalyzerDigest(manifest); }), /requires analyzer_providers exactly/);
  assert.match(check(first, (manifest) => { manifest.analyzer_providers[2].identity_digest = HEX; manifest.analyzer_digest = expectedAnalyzerDigest(manifest); }), /not the pinned mecab/);
  assert.match(check(first, (manifest) => { manifest.analyzer_providers[1].identity_digest = HEX; }), /analyzer_digest must bind|not the pinned khaiii/);
  assert.match(check(first, (manifest) => { manifest.resolution_policy = 'provider-resolution-v1'; }), /analyzer_digest must bind|ensemble and context_fallback exist only/);
  // Traces and categories.
  assert.match(check(first, (manifest) => { manifest.ensemble.trace_sha256 = HEX; }), /trace_sha256 does not bind/);
  assert.match(check(first, (manifest, rows) => { rows[0].observations[0].ensemble.trace_digest = HEX; }), /trace_sha256 does not bind|review does not match/);
  assert.match(check(first, (manifest) => { manifest.unresolved_observations[0].trace_digest = HEX; }), /trace_sha256 does not bind/);
  assert.match(check(first, (manifest, rows) => { rows[0].observations[0].ensemble.category = 'conflicted'; }), /only a concordant or supported_alternative|does not match its observations/);
  assert.match(check(first, (manifest, rows) => { rows[0].review.priority = 'high'; }), /review does not match/);
  assert.match(check(first, (manifest, rows) => { delete rows[0].observations[0].ensemble; }), /ensemble must be/);
  assert.match(check(first, (manifest, rows) => { rows[0].observations[0].ensemble.reasons = ['free text']; }), /known reason codes/);
  assert.match(check(first, (manifest) => { manifest.ensemble.counts.categories.concordant += 1; }), /does not match/);
  assert.match(check(first, (manifest) => { delete manifest.ensemble; }), /missing|ensemble must be/);
  // The unresolved queue cannot silently lose an observation or claim a decision it does not have.
  assert.match(check(first, (manifest) => { manifest.unresolved_observations = []; }), /ensemble.counts|trace_sha256/);
  assert.match(check(first, (manifest) => { manifest.unresolved_observations[0].verification = { state: 'truth_unknown', decision_id: 'D0001' }; }), /trace_sha256|context decision|truth_unknown/);
  assert.match(check(first, (manifest) => { manifest.unresolved_observations[0].category = 'concordant'; }), /conflicted or unsupported_or_unknown/);
  assert.match(check(first, (manifest) => { manifest.unresolved_observations[0].verification = { state: 'blocked', blocked_by: ['coverage_collision'] }; }), /fallback blockers/);
  // Context decisions: forged outcome, dropped decision, mismatched observation, missing hold, honest attribution.
  assert.match(check(recovered, (manifest) => { manifest.context_fallback.decisions = []; manifest.context_fallback.decisions_sha256 = HEX; }), /context_fallback|names no resolving context decision|trace_sha256/);
  assert.match(check(recovered, (manifest) => { manifest.context_fallback.decisions[0].lemma = '갈다'; }), /tampered|decision_sha256/);
  assert.match(check(recovered, (manifest, rows) => { rows[0].observations.at(-1).holds = []; }), /must keep a reviewable analysis_ambiguous hold/);
  assert.match(check(recovered, (manifest, rows) => { rows[0].observations.at(-1).ensemble.context_decision = 'D0002'; }), /names no resolving context decision|context decision/);
  assert.match(check(unknown, (manifest) => { manifest.unresolved_observations[0].verification.decision_id = 'D0002'; }), /truth_unknown|context|does not match/);
  assert.match(check(unknown, (manifest) => { manifest.context_fallback.decisions = []; manifest.context_fallback.decisions_sha256 = HEX; }), /truth_unknown|context_fallback/);
  // A v1 manifest must not carry ensemble blocks.
  const v1 = await produceCandidateBatch({ evidence: evidenceDoc(fallbackEvidence), providers: [kiwi(FALLBACK.k)], canonicalEntries: [], canonicalDigest: HEX, batchId: 'C000002', taskId: 'T000001' });
  assert.match(check(v1, (manifest) => { manifest.ensemble = first.manifest.ensemble; }), /exist only under the ensemble policy/);
});

test('7: reruns are byte-identical and evidence-order independent; v1 and explicit Kiwi-only remain verifiable and unchanged', async () => {
  const tables = triple(FALLBACK);
  const a = await produce(fallbackEvidence, tables);
  const b = await produce([...fallbackEvidence].reverse(), triple(FALLBACK));
  assert.equal(a.candidatesText, b.candidatesText);
  assert.equal(sha256Hex(JSON.stringify(a.manifest)), sha256Hex(JSON.stringify(b.manifest)));
  // A different provider/model identity changes the analyzer digest (and so evidence identity).
  const changed = triple(FALLBACK);
  changed[2] = { ...changed[2], identity: { ...changed[2].identity, version: '9.9.9' } };
  assert.notEqual(providerDescriptor(changed[2]).identity_digest, providerDescriptor(triple(FALLBACK)[2]).identity_digest);
  await assert.rejects(() => produce(fallbackEvidence, changed), /not the pinned mecab/, 'an unpinned provider identity can never produce a valid ensemble batch');
  // Kiwi-only v1 default (library) is byte-identical to the pre-ensemble manifest: no provider fields, no ensemble fields.
  const v1 = await produceCandidateBatch({ evidence: evidenceDoc(fallbackEvidence), providers: [kiwi(FALLBACK.k)], canonicalEntries: [], canonicalDigest: HEX, batchId: 'C000002', taskId: 'T000001' });
  assert.equal(v1.manifest.resolution_policy, undefined);
  assert.equal(v1.manifest.analyzer_providers, undefined);
  assert.equal(v1.manifest.ensemble, undefined);
  assert.deepEqual(validateCandidateBatch({ manifest: v1.manifest, candidatesText: v1.candidatesText }), []);
  // Explicit conditional-fallback v1 with three providers still verifies under the unchanged v1 rules.
  const conditional = await produceCandidateBatch({ evidence: evidenceDoc(fallbackEvidence), providers: triple(FALLBACK), canonicalEntries: [], canonicalDigest: HEX, batchId: 'C000002', taskId: 'T000001' });
  assert.equal(conditional.manifest.resolution_policy, 'provider-resolution-v1');
  assert.deepEqual(validateCandidateBatch({ manifest: conditional.manifest, candidatesText: conditional.candidatesText }), []);
  // Per-row ensemble fields cannot be smuggled into a v1 batch.
  const smuggled = structuredClone(v1);
  const row = JSON.parse(v1.candidatesText.split('\n')[0]);
  row.review = { priority: 'high', categories: {} };
  const text = `${JSON.stringify(row)}\n`;
  assert.match(validateCandidateBatch({ manifest: { ...smuggled.manifest, candidates_sha256: sha256Hex(text), candidate_count: 1, observation_count: row.observation_total }, candidatesText: text }).join(), /unknown field review/);
});

test('CLI: ensemble is the default policy; Kiwi-only or conditional runs need the explicit v1 selector and degraded ensembles are refused', () => {
  const base = ['--evidence', 'data/reference/x/e.json', '--task-id', 'T000001'];
  const defaults = parseArguments(base);
  assert.equal(defaults.policy, ENSEMBLE_POLICY);
  assert.deepEqual(defaults.providers, ['kiwi', 'khaiii', 'mecab']);
  assert.deepEqual(parseArguments([...base, '--providers', 'kiwi,khaiii,mecab']).providers, ['kiwi', 'khaiii', 'mecab']);
  for (const providers of ['kiwi', 'kiwi,khaiii', 'kiwi,mecab', 'mecab,kiwi,khaiii', 'kiwi,khaiii,mecab,kiwi']) {
    assert.throws(() => parseArguments([...base, '--providers', providers]), /ensemble policy runs exactly|repeat/, providers);
  }
  assert.equal(parseArguments([...base, '--policy', 'v1']).policy, 'provider-resolution-v1');
  assert.deepEqual(parseArguments([...base, '--policy', 'v1']).providers, ['kiwi']);
  assert.equal(POLICY_ALIASES.ensemble, ENSEMBLE_POLICY);
  assert.throws(() => parseArguments([...base, '--policy', 'v0']), /unknown --policy/);
  assert.throws(() => parseArguments(['--evidence', 'runs/x/evidence.json', '--task-id', '../../outside']), /path-safe identifier/u);
  assert.throws(() => parseArguments([...base, '--policy', 'v1', '--context-replay', 'm.json']), /require the provider-resolution-v2-ensemble policy|require the/);
  assert.throws(() => parseArguments([...base, '--context-proposals', 'a.json', '--context-replay', 'b.json']), /exclusive/);
});

test('CLI end to end: Stage 1 reads and writes shared-cache artifacts without worktree data/reference', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'factory-ensemble-'));
  const cache = await cacheForTask(root);
  await mkdir(path.join(root, 'data/canonical'), { recursive: true });
  await mkdir(cache.cachePaths.indexes, { recursive: true });
  await writeFile(path.join(cache.taskDirectory, 'candidate-evidence.json'), JSON.stringify(evidenceDoc(fallbackEvidence)));
  const contextSource = createCorpusContextSource({
    databasePath: syntheticIndex(cache.cachePaths.indexes),
    permission: async () => {},
    expectedSnapshot: `corpus:${HEX}:${'b'.repeat(64)}`,
  });
  const logs = [];
  const deps = { root, cachePaths: cache.cachePaths, providers: triple(FALLBACK), permission: async () => {}, log: (line) => logs.push(JSON.parse(line)), contextSource };
  const args = ['--evidence', cache.evidenceArgument, '--task-id', 'T000001', '--base-ref', 'none', '--max-candidates', '1'];
  const dry = await runStage1([...args, '--dry-run', '--ensemble-trace', 'trace.jsonl', '--context-review-pack', 'pack.json'], deps);
  assert.equal(logs[0].effectivePolicy, ENSEMBLE_POLICY);
  assert.deepEqual(logs[0].providerOrder, ['kiwi', 'khaiii', 'mecab']);
  const pack = JSON.parse(await readFile(path.join(cache.taskDirectory, 'pack.json'), 'utf8'));
  assert.equal(pack[0].surface, '갈');
  assert.equal(pack[0].aligned, true);
  assert.ok(pack[0].context.includes('갈'), 'the local pack carries bounded original context');
  const trace = (await readFile(path.join(cache.taskDirectory, 'trace.jsonl'), 'utf8')).trim().split('\n').map((line) => JSON.parse(line));
  assert.deepEqual(Object.keys(trace[0].trace.providers), ['kiwi', 'khaiii', 'mecab']);
  assert.ok(JSON.stringify(trace).includes('"paths"'), 'Kiwi N-best paths are retained in the local trace');
  const attemptArgs = [...args, '--dry-run', '--attempt-log', 'attempts.jsonl'];
  await runStage1(attemptArgs, deps);
  await assert.rejects(() => runStage1(attemptArgs, deps), /EEXIST/u, 'a second worktree run cannot overwrite another task artifact');
  await assert.rejects(() => runStage1([...args, '--dry-run', '--context-review-pack', path.join(root, 'data/candidates/pack.json')], deps), /must be inside/u);
  await assert.rejects(() => runStage1([...args, '--ensemble-trace', path.join(root, 'elsewhere.jsonl')], { ...deps, providers: triple(FALLBACK) }), /must be inside/u);
  const entry = dry.manifest.unresolved_observations[0];
  await writeFile(path.join(cache.taskDirectory, 'proposals.json'), JSON.stringify({ agent: 'claude', proposals: [{ observation_digest: entry.observation_digest, outcome: 'context_confirmed', lemma: '가다', pos: 'verb' }] }));
  const produced = await runStage1([...args, '--context-proposals', 'proposals.json'], { ...deps, providers: triple(FALLBACK) });
  assert.equal(produced.rows.length, 1);
  await assert.rejects(() => readFile(path.join(root, 'data/reference')), { code: 'ENOENT' });
  assert.deepEqual(await validateFactoryRepository({ root }), []);
  // Replay in a fresh checkout-like root (no lemma produced yet) needs no context source and no paragraph.
  const fresh = await mkdtemp(path.join(tmpdir(), 'factory-ensemble-replay-'));
  const freshCache = await cacheForTask(fresh);
  await writeFile(path.join(freshCache.taskDirectory, 'candidate-evidence.json'), JSON.stringify(evidenceDoc(fallbackEvidence)));
  await writeFile(path.join(freshCache.taskDirectory, 'bad-replay.json'), JSON.stringify({ contract: 'lexical-factory-candidate-manifest-v3', batch_id: '../../outside' }));
  await assert.rejects(() => runStage1([...args, '--dry-run', '--context-replay', 'runs/T000001/bad-replay.json'],
    { ...deps, root: fresh, cachePaths: freshCache.cachePaths, providers: triple(FALLBACK) }), /invalid compact context replay reference/);
  await mkdir(path.join(fresh, 'data/validation'), { recursive: true });
  await writeFile(path.join(fresh, 'data/validation/context-replay.json'), produced.stage1DecisionsText);
  const replayed = await runStage1([...args, '--dry-run', '--context-replay', 'data/validation/context-replay.json'],
    { ...deps, root: fresh, cachePaths: freshCache.cachePaths, providers: triple(FALLBACK), contextSource: undefined });
  assert.equal(replayed.candidatesText, produced.candidatesText);
  // A raw-text field in the evidence is still refused under the ensemble policy.
  const bad = structuredClone(evidenceDoc(fallbackEvidence));
  bad.candidates[0].evidence.representative_hits[0].context = '문장 전체';
  await writeFile(path.join(cache.taskDirectory, 'bad.json'), JSON.stringify(bad));
  await assert.rejects(() => runStage1(['--evidence', 'runs/T000001/bad.json', '--task-id', 'T000001', '--base-ref', 'none'], { ...deps, providers: triple(FALLBACK) }), Stage1Error);
  contextSource.close();
});

test('Stage 1 reapplies the digest-bound corpus exclusion set after provider alternative resolution', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'factory-ensemble-exclusion-'));
  try {
    const cache = await cacheForTask(root);
    const sourceArtifacts = [{ path: 'data/reference/production/stage1-409/c18/exclude-lemma-source.json', sha256: HEX }];
    const exclusionPayload = { lemmas: ['걷다'], schema_version: 'm9-reviewed-lemma-exclusions-v1', source_artifacts: sourceArtifacts };
    const exclusionManifest = { ...exclusionPayload, exclusion_sha256: sha256Hex(JSON.stringify(exclusionPayload)) };
    await writeFile(path.join(cache.taskDirectory, 'reviewed-lemma-exclusions.json'), JSON.stringify(exclusionManifest));
    const evidence = {
      ...evidenceDoc([
        cand('걸다', 'verb', [
          { ...h('d1', '걸어'), usage_group: 'usage_a' },
          { ...h('d2', '걸어'), usage_group: 'usage_a' },
          { ...h('d1', '걸어'), usage_group: 'usage_b' },
        ]),
        cand('짠하다', 'adjective', [h('d2', '짠한')]),
      ]),
      selection: {
        excluded_candidate_lemma_count: exclusionPayload.lemmas.length,
        exclusion_sha256: exclusionManifest.exclusion_sha256,
        exclusion_source_artifacts: sourceArtifacts,
      },
      orchestration: { exclusion_manifest_sha256: exclusionManifest.exclusion_sha256 },
    };
    await writeFile(path.join(cache.taskDirectory, 'candidate-evidence.json'), JSON.stringify(evidence));
    const k = {
      걸어: [p('걸다', 'verb', '걸'), p('걷다', 'verb', '걷')],
      짠한: [p('짠하다', 'adjective', '짠하')],
    };
    const hh = {
      걸어: [p('걷다', 'verb', '걷')],
      짠한: [p('짠하다', 'adjective', '짠하')],
    };
    const deps = { root, cachePaths: cache.cachePaths, providers: triple({ k, h: hh, m: hh }), permission: async () => {}, log: () => {} };
    const args = ['--evidence', cache.evidenceArgument, '--task-id', 'T000001', '--base-ref', 'none', '--max-candidates', '1'];
    const compactResult = await runStage1(args, deps);
    const archive = await loadTrash(root);
    const history = { batch_id: compactResult.manifest.batch_id,
      unresolved: [...archive.values()].flatMap((rows) => rows.flatMap((row) => row.variants.flatMap((variant) =>
        variant.occurrences.filter((item) => item.batch_id === compactResult.manifest.batch_id).map((item) => ({
          observation_id: row.observation_id, analysis_sha256: variant.analysis_sha256, queue_id: item.queue_id,
        }))))).sort((a, b) => a.queue_id.localeCompare(b.queue_id)),
      ...JSON.parse(compactResult.stage1DecisionsText) };
    const result = { ...compactResult, manifest: restoreManifest(compactResult.manifest, history, trashIndex(archive)) };
    assert.deepEqual(result.rows.map((row) => row.input), ['짠하다'], 'the provider-supported alternative 걷다 is in the inherited exclusion source');
    assert.equal(result.summary.skippedProducedLemmas, 1);
    assert.equal(result.manifest.excluded_observations.length, 3);
    assert.ok(result.manifest.excluded_observations.every((entry) => entry.disposition === 'prior_produced_lemma'
      && entry.lemma === '걷다' && entry.pos === 'verb' && entry.surface === '걸어'));
    assert.equal(new Set(result.manifest.excluded_observations.map((entry) => entry.observation_digest)).size, 3,
      'separate paragraphs and usage groups have separate source observation identities');
    assert.equal(new Set(result.manifest.excluded_observations.map((entry) => entry.ensemble.trace_digest)).size, 1,
      'the same analyzer trace may back distinct source observations');
    assert.equal(result.manifest.ensemble.counts.input_observations, 4);
    assert.equal(result.manifest.ensemble.counts.observations, 4);
    assert.equal(result.manifest.ensemble.counts.excluded, 3);
    const omitted = structuredClone(result.manifest);
    omitted.excluded_observations.pop();
    omitted.ensemble.counts.excluded = omitted.excluded_observations.length;
    omitted.ensemble.counts.observations = omitted.observation_count + omitted.unresolved_observations.length + omitted.excluded_observations.length;
    omitted.ensemble.counts.categories = Object.fromEntries(['concordant', 'supported_alternative', 'conflicted', 'unsupported_or_unknown'].map((category) => [category, 0]));
    for (const row of result.rows) for (const [category, count] of Object.entries(row.review.categories)) omitted.ensemble.counts.categories[category] += count;
    for (const entry of omitted.unresolved_observations) omitted.ensemble.counts.categories[entry.category] += 1;
    for (const entry of omitted.excluded_observations) omitted.ensemble.counts.categories[entry.ensemble.category] += 1;
    omitted.ensemble.trace_sha256 = ensembleTraceSha256({
      providers: omitted.analyzer_providers,
      observationTraceDigests: result.rows.flatMap((row) => [JSON.stringify(['review', row.review.trace_sha256]),
        ...row.observations.map((observation) => JSON.stringify([observation.observation_digest, observation.ensemble.trace_digest]))]),
      queueTraceDigests: omitted.unresolved_observations.map((entry) => JSON.stringify([entry.observation_digest, entry.trace_digest])),
      excludedTraceDigests: omitted.excluded_observations.map((entry) => JSON.stringify([entry.observation_digest, entry.ensemble.trace_digest])),
      contextDecisionsSha256: omitted.context_fallback.decisions_sha256,
    });
    assert.match(validateCandidateBatch({ manifest: omitted, candidatesText: result.candidatesText }).join(), /independent input observation count/u,
      'recomputing disposition counts and trace digest cannot hide a producer input observation');
    const traces = result.ensemble.decisions.map((decision) => ({ observation_digest: decision.observation_digest,
      trace_digest: decision.trace_digest, trace: decision.trace }));
    assert.deepEqual(verifyEnsembleTraces({ rows: result.rows, queue: result.manifest.unresolved_observations,
      excluded: result.manifest.excluded_observations, traces }), [], 'candidate, queue, and prior-produced observations cover every analysis trace');
    assert.match(verifyEnsembleTraces({ rows: result.rows, queue: result.manifest.unresolved_observations, traces }).join(), /no recorded disposition/u);
    const missingExcluded = { ...result.manifest };
    delete missingExcluded.excluded_observations;
    assert.match(validateCandidateBatch({ manifest: missingExcluded, candidatesText: result.candidatesText }).join(), /requires excluded_observations/u);
    assert.deepEqual(await validateFactoryRepository({ root }), []);

    const duplicatedIdentity = structuredClone(result.manifest);
    duplicatedIdentity.excluded_observations[0].observation_digest = result.rows[0].observations[0].observation_digest;
    const compare = (left, right) => (left < right ? -1 : left > right ? 1 : 0);
    duplicatedIdentity.excluded_observations.sort((left, right) => compare(left.disposition, right.disposition)
      || compare(left.lemma, right.lemma) || compare(left.observation_digest, right.observation_digest));
    duplicatedIdentity.ensemble.trace_sha256 = ensembleTraceSha256({
      providers: duplicatedIdentity.analyzer_providers,
      observationTraceDigests: result.rows.flatMap((row) => [JSON.stringify(['review', row.review.trace_sha256]),
        ...row.observations.map((observation) => JSON.stringify([observation.observation_digest, observation.ensemble.trace_digest]))]),
      queueTraceDigests: duplicatedIdentity.unresolved_observations.map((entry) => JSON.stringify([entry.observation_digest, entry.trace_digest])),
      excludedTraceDigests: duplicatedIdentity.excluded_observations.map((entry) => JSON.stringify([entry.observation_digest, entry.ensemble.trace_digest])),
      contextDecisionsSha256: duplicatedIdentity.context_fallback.decisions_sha256,
    });
    const duplicateIdentityError = /observation appears in more than one ensemble disposition/u;
    assert.match(validateCandidateBatch({ manifest: duplicatedIdentity, candidatesText: result.candidatesText }).join(), duplicateIdentityError,
      'the common candidate validator rejects an identity duplicated across candidate and excluded dispositions even with a recomputed digest');
    await writeFile(path.join(root, 'data/candidates', result.manifest.batch_id, 'manifest.json'), JSON.stringify(duplicatedIdentity));
    assert.match((await validateFactoryRepository({ root })).join(), duplicateIdentityError,
      'the repository validator enforces the same cross-disposition identity invariant');

    const malformedCases = [
      ['stale-candidate-evidence.json', { ...evidence, selection: { ...evidence.selection, exclusion_sha256: 'b'.repeat(64) } }, /exclusion digest does not match candidate evidence/u],
      ['missing-exclusion-count.json', { ...evidence, selection: (({ excluded_candidate_lemma_count: _omit, ...selection }) => selection)(evidence.selection) }, /exclusion count is missing/u],
      ['missing-orchestration-digest.json', { ...evidence, orchestration: {} }, /orchestration is missing/u],
      ['missing-orchestration.json', (({ orchestration: _omit, ...rest }) => rest)(evidence), /orchestration is missing/u],
    ];
    for (const [file, malformed, expectedError] of malformedCases) {
      await writeFile(path.join(cache.taskDirectory, file), JSON.stringify(malformed));
      await assert.rejects(() => runStage1([
        '--evidence', `runs/T000001/${file}`, '--task-id', 'T000001', '--base-ref', 'none', '--dry-run',
      ], deps), expectedError);
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('v3 source accounting normalizes repeated assigned and unresolved hits to one disposition each', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'factory-ensemble-repeated-input-'));
  try {
    const evidence = [
      cand('가다', 'verb', [h('d1', '가는')], { ambiguity_status: 'held_ambiguous' }),
      cand('나다', 'verb', [h('d1', '가는')]),
      cand('가다', 'verb', [h('d2', '갈'), h('d2', '갈')]),
      cand('나다', 'verb', [h('d2', '갈')]),
    ];
    const k = { 가는: [p('가다', 'verb', '가')], 갈: [p('갈', 'noun')] };
    const hh = { 가는: [p('가다', 'verb', '가')], 갈: [p('갈다', 'verb', '갈')] };
    const mm = { 가는: [p('가다', 'verb', '가')], 갈: [p('가다', 'verb', '가')] };
    const result = await produce(evidence, triple({ k, h: hh, m: mm }));

    assert.equal(result.ensemble.decisions.length, 2, 'the producer adjudicates each unique source-observation identity once');
    assert.equal(result.manifest.ensemble.counts.input_observations, 2,
      'the independent count is derived from unique source identities before disposition, not output totals');
    assert.equal(result.manifest.ensemble.counts.observations, 2);
    assert.equal(result.manifest.observation_count, 1);
    assert.equal(result.manifest.unresolved_observations.length, 1);
    assert.deepEqual(result.rows[0].observations[0].holds, ['analysis_ambiguous'], 'repeated source identities union and preserve extractor holds');
    assert.ok(result.rows[0].observations[0].ensemble.reasons.includes('extractor_hint_mismatch'),
      'different hints at one source coordinate stay visible on the assigned disposition');
    assert.equal(result.manifest.unresolved_observations[0].extractor_hint.lemma, null,
      'conflicting hints do not select one candidate based on input order');
    assert.ok(result.manifest.unresolved_observations[0].reasons.includes('extractor_hint_mismatch'));
    assert.equal(result.summary.metrics.repeated_evidence_merged, 3,
      'assigned and unresolved raw duplicates are both visible in repeat metrics');
    const comparison = await compareResolutionPolicies({
      observations: observationsFromCorpusEvidence(evidenceDoc(evidence)).observations,
      kiwiProvider: kiwi(k), ensembleProviders: triple({ k, h: hh, m: mm }),
    });
    assert.equal(comparison.three_provider_only.assigned_observations, 2,
      'unresolved repeats do not inflate the assigned-observation metric');
    assert.deepEqual(validateCandidateBatch({ manifest: result.manifest, candidatesText: result.candidatesText }), []);

    const reversed = await produce([...evidence].reverse(), triple({ k, h: hh, m: mm }));
    assert.equal(reversed.candidatesText, result.candidatesText, 'hint conflicts do not select an outcome based on input order');
    assert.equal(reversed.manifest.ensemble.trace_sha256, result.manifest.ensemble.trace_sha256);

    const traces = result.ensemble.decisions.map((decision) => ({ observation_digest: decision.observation_digest,
      trace_digest: decision.trace_digest, trace: decision.trace }));
    assert.deepEqual(verifyEnsembleTraces({ rows: result.rows, queue: result.manifest.unresolved_observations,
      excluded: result.manifest.excluded_observations, traces }), [], 'each normalized input identity has one matching local trace');

    const directory = path.join(root, 'data/candidates', result.manifest.batch_id);
    await mkdir(directory, { recursive: true });
    await writeFile(path.join(directory, 'manifest.json'), JSON.stringify(result.manifest));
    await writeFile(path.join(directory, 'candidates.jsonl'), result.candidatesText);
    assert.deepEqual(await validateFactoryRepository({ root }), []);

    const missing = structuredClone(result.manifest);
    missing.unresolved_observations = [];
    missing.ensemble.counts.queue = 0;
    missing.ensemble.counts.observations = missing.observation_count + missing.excluded_observations.length;
    missing.ensemble.counts.categories = { concordant: 0, supported_alternative: 0, conflicted: 0, unsupported_or_unknown: 0 };
    for (const row of result.rows) for (const [category, count] of Object.entries(row.review.categories)) missing.ensemble.counts.categories[category] += count;
    for (const entry of missing.excluded_observations) missing.ensemble.counts.categories[entry.ensemble.category] += 1;
    missing.ensemble.trace_sha256 = ensembleTraceSha256({
      providers: missing.analyzer_providers,
      observationTraceDigests: result.rows.flatMap((row) => [JSON.stringify(['review', row.review.trace_sha256]),
        ...row.observations.map((observation) => JSON.stringify([observation.observation_digest, observation.ensemble.trace_digest]))]),
      queueTraceDigests: [],
      excludedTraceDigests: missing.excluded_observations.map((entry) => JSON.stringify([entry.observation_digest, entry.ensemble.trace_digest])),
      contextDecisionsSha256: missing.context_fallback.decisions_sha256,
    });
    const accountingError = /independent input observation count/u;
    assert.match(validateCandidateBatch({ manifest: missing, candidatesText: result.candidatesText }).join(), accountingError,
      'dropping the one unique unresolved identity and recomputing all output-derived fields still fails');
    await writeFile(path.join(directory, 'manifest.json'), JSON.stringify(missing));
    assert.match((await validateFactoryRepository({ root })).join(), accountingError,
      'the repository validator rejects the same omitted input identity');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('8/14: same-cohort comparison reports distinct-lemma denominators, honest unknowns, and credits no extractor-missed lemma', async () => {
  const k = { 가는: [p('가다', 'verb', '가')], 가서: [p('가다', 'verb', '가')], 갈: [p('갈', 'noun')], 걸어: [p('걸다', 'verb', '걸'), p('걷다', 'verb', '걷')] };
  const hh = { 가는: [p('가다', 'verb', '가')], 가서: [p('가다', 'verb', '가')], 갈: [p('갈다', 'verb', '갈')], 걸어: [p('걷다', 'verb', '걷')] };
  const mm = { 가는: [p('가다', 'verb', '가')], 가서: [p('가다', 'verb', '가')], 갈: [p('가다', 'verb', '가')], 걸어: [p('걷다', 'verb', '걷')] };
  const evidence = [cand('가다', 'verb', [h('d1', '가는'), h('d2', '가서'), h('d3', '갈')]), cand('걷다', 'verb', [h('d4', '걸어')])];
  const observationsOf = (await produce(evidence, triple({ k, h: hh, m: mm }))).ensemble.decisions.length;
  assert.equal(observationsOf, 4);
  const { observationsFromCorpusEvidence } = await import('../scripts/factory/stage1.mjs');
  const { observations } = observationsFromCorpusEvidence(evidenceDoc(evidence));
  const first = await produce(evidence, triple({ k, h: hh, m: mm }));
  const [queued] = queueOf(first);
  const report = await compareResolutionPolicies({
    observations, kiwiProvider: kiwi(k), ensembleProviders: triple({ k, h: hh, m: mm }),
    context: { contextProposals: [proposal(queued, { outcome: 'truth_unknown', reason_code: 'conflicting_readings' })], contextSource: source(), snapshot: 'corpus:x', contextAgent: 'claude' },
  });
  assert.equal(report.cohort.original_observations, 4);
  assert.equal(report.cohort.unique_surfaces, 4);
  assert.equal(report.kiwi_only.unique_lemmas, 3, 'Kiwi-only: 가다, 갈, 걷다/걸다 as distinct lemmas (denominator is lemmas, not 4 observations)');
  assert.equal(report.three_provider_only.unique_lemmas, 2);
  assert.equal(report.three_provider_only.unresolved_observations, 1);
  assert.equal(report.three_provider_only.needs_verification, 1);
  assert.equal(report.three_provider_only.apparent_resolved, 3, 'apparent_resolved counts machine readings (incl. the held supported alternative); it is not verified');
  assert.equal(report.three_provider_only.assigned_without_holds, 2, 'the supported alternative keeps a reviewable hold');
  assert.equal(report.three_provider_only.held_observations, 1);
  assert.deepEqual([report.three_provider_only.verified_correct, report.three_provider_only.verified_wrong, report.three_provider_only.accuracy], ['not_established', 'not_established', 'not_established']);
  assert.equal(report.three_provider_only.truth_unknown, 1);
  assert.deepEqual(report.three_provider_only.fallback, { eligible: 1, attempted: 0, evidence_resolved: 0, still_unresolved: 1 });
  assert.deepEqual(report.three_provider_plus_context.fallback, { eligible: 1, attempted: 1, evidence_resolved: 0, still_unresolved: 1 });
  assert.deepEqual(Object.keys(report.three_provider_only.provider_calls), ['kiwi', 'khaiii', 'mecab']);
  assert.ok(report.notes.some((note) => /extractor never proposed/.test(note)));
  // 14: a lemma present in the source but never proposed by the extractor is neither extracted nor credited.
  const extra = await compareResolutionPolicies({
    observations, kiwiProvider: kiwi(k), ensembleProviders: triple({ k, h: hh, m: mm }), sourceLemmas: ['가다', '걷다', '지치다'],
  });
  assert.deepEqual(extra.extractor_recall, { source_lemmas: 3, reached_by_extractor: 2, not_extracted: ['지치다'], credited_to_ensemble: 0 });
  assert.equal(extra.three_provider_only.unique_lemmas, 2, 'the missed lemma adds nothing to the ensemble yield');
});

test('analyzer digest and provider descriptors bind the ensemble policy and exact provider identities', async () => {
  const result = await produce(fallbackEvidence, triple(FALLBACK));
  assert.deepEqual(result.manifest.analyzer_providers, triple(FALLBACK).map(providerDescriptor));
  assert.equal(result.manifest.analyzer_digest, expectedAnalyzerDigest(result.manifest));
  assert.notEqual(result.manifest.analyzer_digest, expectedAnalyzerDigest({ ...result.manifest, resolution_policy: 'provider-resolution-v1' }));
  assert.notEqual(result.manifest.analyzer_digest, expectedAnalyzerDigest({ ...result.manifest, analyzer_providers: result.manifest.analyzer_providers.slice(0, 2) }));
});

test('review fix: pack windows come from the exact aligned eojeol, not an earlier substring', async () => {
  assert.deepEqual(alignedOffset('가방을 들고 가 보았다', '가'), { start: 7, end: 8 });
  assert.equal(alignedOffset('가방만 있었다', '가'), null);
  assert.deepEqual(alignedOffset('그는 "갈" 길', '갈'), { start: 4, end: 5 });
  const root = await mkdtemp(path.join(tmpdir(), 'factory-ensemble-pack-'));
  const cache = await cacheForTask(root);
  await writeFile(path.join(cache.taskDirectory, 'candidate-evidence.json'), JSON.stringify(evidenceDoc(fallbackEvidence)));
  const padding = '아주 긴 앞부분 '.repeat(30);
  const text = `갈대 ${padding}그는 천천히 갈 길을 정했다.`;
  await runStage1(['--evidence', cache.evidenceArgument, '--task-id', 'T000001', '--base-ref', 'none', '--context-review-pack', 'pack.json'],
    { root, cachePaths: cache.cachePaths, providers: triple(FALLBACK), permission: async () => {}, log: () => {}, contextSource: source({ 'd3#p1': { status: 'ok', text } }) });
  const [item] = JSON.parse(await readFile(path.join(cache.taskDirectory, 'pack.json'), 'utf8'));
  assert.equal(item.aligned, true);
  assert.ok(item.context.includes('천천히 갈 길'), 'the window shows the aligned token, not 갈대 at the start');
  assert.equal(item.context.includes('갈대'), false);
});

test('review fix: fallback eligibility in metrics uses the shared blocker predicate', async () => {
  const ok1 = p('짠하다', 'adjective', '짠하');
  const k = { 갈: [p('갈', 'noun')], 낯: [p('낯', 'noun')], 짠한: [ok1] };
  const hh = { 갈: [p('갈다', 'verb', '갈')], 낯: [p('낯다', 'verb', '낯')], 짠한: [ok1] };
  const mm = { 갈: [p('가다', 'verb', '가')], 낯: [p('낮다', 'verb', '낮')], 짠한: [ok1] };
  const evidence = [
    cand('짠하다', 'adjective', [h('d0', '짠한')]),
    cand('가다', 'verb', [h('d1', '갈')]), // eligible
    cand('가다', 'verb', [h('d2', '갈')], { coverage_status: 'covered_elsewhere' }), // blocked: coverage
    cand('낮다', 'verb', [h('d3', '낯')], { coverage_status: 'other_hold' }), // blocked: any other hold
    cand('갈다', 'verb', []), // no located source
  ];
  const result = await produce(evidence, triple({ k, h: hh, m: mm }));
  assert.equal(result.summary.ensemble.fallback.eligible, 1);
  assert.ok(result.summary.ensemble.needs_verification >= 4);
});

test('review fix: shared contract guarantees supported_alternative keeps rivals and its reviewable hold', async () => {
  const k = { 걸어: [p('걸다', 'verb', '걸'), p('걷다', 'verb', '걷')] };
  const hh = { 걸어: [p('걷다', 'verb', '걷')] };
  const base = await produce([cand('걷다', 'verb', [h('d1', '걸어')])], triple({ k, h: hh, m: hh }));
  assert.equal(base.rows[0].observations[0].ensemble.category, 'supported_alternative');
  const bad = (mutate) => {
    const rows = base.candidatesText.trim().split('\n').map((line) => JSON.parse(line));
    mutate(rows[0].observations[0]);
    const text = `${rows.map((row) => JSON.stringify(row)).join('\n')}\n`;
    return validateCandidateBatch({ manifest: { ...base.manifest, candidates_sha256: sha256Hex(text) }, candidatesText: text }).join('\n');
  };
  assert.match(bad((o) => { o.ensemble.alternatives = []; }), /non-empty rival hypotheses/);
  assert.match(bad((o) => { o.holds = []; }), /analysis_ambiguous hold/);
  assert.match(bad((o) => { o.ensemble.category = 'concordant'; }), /records no rival|review does not match|trace_sha256/);
});

test('review fix: the authoring agent must be stated explicitly, never defaulted', async () => {
  const first = await produce(fallbackEvidence, triple(FALLBACK));
  const [entry] = queueOf(first);
  const proposals = [proposal(entry, { outcome: 'context_confirmed', lemma: '가다', pos: 'verb' })];
  await assert.rejects(() => produce(fallbackEvidence, triple(FALLBACK), { contextProposals: proposals, contextSource: source() }), /authoring agent must be stated explicitly/);
  await assert.rejects(() => produce(fallbackEvidence, triple(FALLBACK), { contextProposals: proposals, contextSource: source(), contextAgent: 'Claude Opus!' }), /explicitly/);
  const codex = await produce(fallbackEvidence, triple(FALLBACK), { contextProposals: proposals, contextSource: source(), contextAgent: 'codex' });
  assert.deepEqual(codex.manifest.context_fallback.decisions[0].author, { kind: 'agent-self-check', agent: 'codex' });
  // The CLI proposals file must carry `agent`.
  const root = await mkdtemp(path.join(tmpdir(), 'factory-ensemble-agent-'));
  const cache = await cacheForTask(root);
  await writeFile(path.join(cache.taskDirectory, 'candidate-evidence.json'), JSON.stringify(evidenceDoc(fallbackEvidence)));
  await writeFile(path.join(cache.taskDirectory, 'proposals.json'), JSON.stringify({ proposals }));
  await assert.rejects(() => runStage1(['--evidence', cache.evidenceArgument, '--task-id', 'T000001', '--base-ref', 'none', '--dry-run', '--context-proposals', 'proposals.json'],
    { root, cachePaths: cache.cachePaths, providers: triple(FALLBACK), permission: async () => {}, log: () => {}, contextSource: source() }), /authoring agent must be stated explicitly/);
});

test('review fix: a malformed Provider response fails the whole ensemble run closed; an explicit unsupported stays data', async () => {
  const good = { 가는: [p('가다', 'verb', '가')], 짠한: [p('짠하다', 'adjective', '짠하')] };
  const evidence = [cand('가다', 'verb', [h('d1', '가는')]), cand('짠하다', 'adjective', [h('d2', '짠한')])];
  const withMecab = (mutate) => {
    const inner = mecab(good);
    return { ...inner, analyze: async (requests) => { const response = await inner.analyze(requests); return { ...response, results: response.results.map((row, index) => (index === 0 ? mutate(row) : row)) }; } };
  };
  const run = (mutate) => produce(evidence, [kiwi(good), khaiii(good), withMecab(mutate)]);
  await assert.rejects(() => run((row) => ({ ...row, status: 'bogus' })), /invalid result status "bogus"/);
  await assert.rejects(() => run((row) => ({ ...row, status: 'ok', analyses: [] })), /status ok without usable analyses/);
  await assert.rejects(() => run((row) => { const { analyses, ...rest } = row; return { ...rest, status: 'ok' }; }), /status ok without usable analyses/);
  await assert.rejects(() => run((row) => ({ ...row, status: 'unsupported', analyses: [[{ lemma: '가다', pos: 'verb', form: '가' }]] })), /status unsupported that carries analyses/);
  await assert.rejects(() => run(() => null), /non-object result entry|missing results/);
  // The other, valid lemma is not produced as a partial batch.
  const explicit = await run((row) => ({ ...row, status: 'unsupported', analyses: [] }));
  assert.deepEqual(explicit.rows.map((row) => row.input), ['짠하다']);
  assert.deepEqual(explicit.manifest.unresolved_observations.map((entry) => [entry.surface, entry.category, entry.reasons]), [['가는', 'unsupported_or_unknown', ['mecab_unusable']]]);
  const explicitError = await run((row) => ({ ...row, status: 'error', analyses: [] }));
  assert.equal(explicitError.manifest.unresolved_observations[0].holds[0], 'analysis_error');
});

const bigEvidence = (count, { heldTail = false, allHeld = false } = {}) => [
  cand('가다', 'verb', Array.from({ length: count - (heldTail ? 1 : 0) }, (_, i) => h(`d${String(i).padStart(3, '0')}`, '가는')), allHeld ? { ambiguity_status: 'held_extractor' } : {}),
  ...(heldTail ? [cand('가다', 'verb', [h('z999', '가는')], { ambiguity_status: 'held_extractor' })] : []),
];
const GADA = { 가는: [p('가다', 'verb', '가')] };

test('review fix: the ensemble policy never omits an observation, so no unseen hold or category can exist', async () => {
  const run = (evidence) => produce(evidence, triple({ k: GADA, h: GADA, m: GADA }));
  // 64 observations (the bound) are all retained and exactly summarized.
  const full = await run(bigEvidence(64, { heldTail: true }));
  const row = full.rows[0];
  assert.equal(row.observation_total, 64);
  assert.equal(row.observations.length, 64);
  assert.deepEqual([row.review.priority, row.review.held, row.review.categories], ['verify_first', 1, { concordant: 64 }]);
  assert.equal(full.manifest.ensemble.counts.categories.concordant, 64);
  assert.deepEqual(validateCandidateBatch({ manifest: full.manifest, candidatesText: full.candidatesText }), []);
  // Beyond the bound the run fails closed instead of omitting (even a lone hold at the end), so a
  // hold can never disappear from review priority, accounting or the trace.
  await assert.rejects(() => run(bigEvidence(65, { heldTail: true })), /never omits an observation, so split the evidence run/);
  await assert.rejects(() => run(bigEvidence(70, { allHeld: true })), /above the bound 64/);
  // The shared validator also refuses a forged row that claims omitted observations.
  const check = (mutate) => {
    const manifest = structuredClone(full.manifest);
    const rows = full.candidatesText.trim().split('\n').map((line) => JSON.parse(line));
    mutate(rows[0], manifest);
    const text = `${rows.map((entry) => JSON.stringify(entry)).join('\n')}\n`;
    manifest.candidates_sha256 = sha256Hex(text);
    manifest.observation_count = rows.reduce((sum, entry) => sum + entry.observation_total, 0);
    return validateCandidateBatch({ manifest, candidatesText: text }).join('\n');
  };
  assert.match(check((r) => { r.observation_total = 65; }), /every observation must be retained/);
  assert.match(check((r) => { r.observations.pop(); r.observation_total = 63; }), /observation_digest|review does not match|forms|every observation/);
  // Forged category/hold/priority/commitment, even with consistent derived counts, is rejected by exact recomputation.
  const exact = /review does not match the category, hold and trace records of its 64 observations/;
  assert.match(check((r) => { r.review.held = 0; r.review.priority = 'high'; }), exact);
  assert.match(check((r) => { r.review.categories = { concordant: 63, conflicted: 1 }; }), exact);
  assert.match(check((r) => { r.review.trace_sha256 = HEX; }), exact);
  assert.match(check((r, m) => { r.observations[0].ensemble.category = 'supported_alternative'; }), /supported_alternative must|review does not match/);
  assert.match(check((r, m) => { m.ensemble.counts.categories.concordant = 63; }), /does not match/);
  // The local trace check proves recorded categories/holds against the real analysis (ignored trace file).
  const traces = full.ensemble.decisions.map((decision) => ({ observation_digest: decision.observation_digest, trace_digest: decision.trace_digest, trace: decision.trace }));
  const rowsOf = full.candidatesText.trim().split('\n').map((line) => JSON.parse(line));
  assert.deepEqual(verifyEnsembleTraces({ rows: rowsOf, queue: [], traces }), []);
  const forged = structuredClone(rowsOf);
  forged[0].observations[0].holds = ['analysis_ambiguous'];
  assert.match(verifyEnsembleTraces({ rows: forged, traces }).join(), /differ from the trace's source holds/);
});

test('review fix: local trace verification accepts correct queue/context records and rejects forged holds', async () => {
  const k = { 갈: [p('갈', 'noun')], 낯: [p('낯', 'noun')], 가는: GADA.가는 };
  const hh = { 갈: [p('갈다', 'verb', '갈')], 낯: [p('낯다', 'verb', '낯')], 가는: GADA.가는 };
  const mm = { 갈: [p('가다', 'verb', '가')], 낯: [p('낮다', 'verb', '낮')], 가는: GADA.가는 };
  const evidence = [
    cand('가다', 'verb', [h('d1', '가는'), h('d3', '갈')]), // (a) hold-free unresolved (갈) beside a clear sibling
    cand('낮다', 'verb', [h('d4', '낯')], { coverage_status: 'covered_elsewhere' }), // (b) unresolved with a source hold
  ];
  const result = await produce(evidence, triple({ k, h: hh, m: mm }));
  const tracesOf = (r) => r.ensemble.decisions.map((decision) => ({ observation_digest: decision.observation_digest, trace_digest: decision.trace_digest, trace: decision.trace }));
  const rowsOf = (r) => r.candidatesText.trim().split('\n').map((line) => JSON.parse(line));
  const queue = result.manifest.unresolved_observations;
  assert.ok(queue.some((entry) => entry.extractor_holds.includes('coverage_collision')) && queue.some((entry) => entry.extractor_holds.length === 0));
  assert.deepEqual(verifyEnsembleTraces({ rows: rowsOf(result), queue, traces: tracesOf(result) }), [], '(a) and (b) pass');
  // (c) a tampered or deleted source hold fails.
  const deleted = structuredClone(queue);
  deleted.find((entry) => entry.extractor_holds.length).extractor_holds = [];
  assert.match(verifyEnsembleTraces({ rows: rowsOf(result), queue: deleted, traces: tracesOf(result) }).join(), /differ from the trace's source holds/);
  const added = structuredClone(queue);
  added.find((entry) => !entry.extractor_holds.length).extractor_holds = ['coverage_collision'];
  assert.match(verifyEnsembleTraces({ rows: rowsOf(result), queue: added, traces: tracesOf(result) }).join(), /differ from the trace's source holds/);
  // (d) a context-recovered row (extractor hold kept + reviewable analysis_ambiguous) passes; dropping the source hold fails.
  const open = queue.find((entry) => !entry.extractor_holds.length);
  const recovered = await produce(evidence, triple({ k, h: hh, m: mm }), {
    contextProposals: [proposal(open, { outcome: 'context_confirmed', lemma: '가다', pos: 'verb' })], contextAgent: 'claude', contextSource: source({ 'd3#p1': { status: 'ok', text: '그는 갈 길을 정했다.' } }),
  });
  assert.deepEqual(verifyEnsembleTraces({ rows: rowsOf(recovered), queue: recovered.manifest.unresolved_observations, traces: tracesOf(recovered) }), [], '(d) passes');
  const forgedRows = rowsOf(recovered);
  // The recovered observation had no source hold; its only hold is the reviewable context one, and a
  // source hold added to the row that the trace never had is rejected.
  forgedRows[0].observations.find((o) => o.ensemble.resolution === 'context').holds = ['analysis_ambiguous', 'coverage_collision'];
  assert.match(verifyEnsembleTraces({ rows: forgedRows, queue: recovered.manifest.unresolved_observations, traces: tracesOf(recovered) }).join(), /differ from the trace's source holds/);
  // A context recovery of an observation WITH a source hold (extractor analysis_ambiguous) keeps it:
  // the correct row passes, a row that swallowed the source hold fails.
  const held = [cand('가다', 'verb', [h('d1', '가는'), h('d3', '갈')], { ambiguity_status: 'held_extractor' })];
  const heldFirst = await produce(held, triple({ k, h: hh, m: mm }));
  const heldEntry = heldFirst.manifest.unresolved_observations.find((entry) => entry.surface === '갈');
  assert.deepEqual(heldEntry.extractor_holds, ['analysis_ambiguous']);
  const heldRecovered = await produce(held, triple({ k, h: hh, m: mm }), {
    contextProposals: [proposal(heldEntry, { outcome: 'context_confirmed', lemma: '가다', pos: 'verb' })], contextAgent: 'claude', contextSource: source({ 'd3#p1': { status: 'ok', text: '그는 갈 길을 정했다.' } }),
  });
  assert.deepEqual(verifyEnsembleTraces({ rows: rowsOf(heldRecovered), queue: [], traces: tracesOf(heldRecovered) }), []);
  const swallowed = rowsOf(heldRecovered);
  const context = swallowed[0].observations.find((o) => o.ensemble.resolution === 'context');
  context.holds = context.holds.filter((hold) => hold !== 'analysis_ambiguous');
  context.holds.push('lemma_mismatch');
  assert.match(verifyEnsembleTraces({ rows: swallowed, queue: [], traces: tracesOf(heldRecovered) }).join(), /differ from the trace's source holds/);
});

// A real (temporary, synthetic) SQLite index with the corpus index schema subset the source reads.
let indexCounter = 0;
function syntheticIndex(dir, { manifest = HEX, rows = 'b'.repeat(64), text = '그는 천천히 갈 길을 정했다.', skipMetadata = false, duplicateDocumentId = false } = {}) {
  const file = path.join(dir, `index-${indexCounter += 1}.sqlite`);
  const db = new DatabaseSync(file);
  db.exec('CREATE TABLE index_metadata (key TEXT PRIMARY KEY, value TEXT); CREATE TABLE documents (document_rowid INTEGER PRIMARY KEY, document_id TEXT); CREATE TABLE paragraphs (paragraph_rowid INTEGER PRIMARY KEY, document_rowid INTEGER, paragraph_id TEXT, form TEXT); CREATE INDEX idx_paragraphs_document_id ON paragraphs(document_rowid, paragraph_id);');
  if (!skipMetadata) db.prepare('INSERT INTO index_metadata(key, value) VALUES (?, ?), (?, ?)').run('input_manifest_sha256', manifest, 'logical_rows_sha256', rows);
  db.prepare('INSERT INTO documents VALUES (1, ?)').run('d3');
  db.prepare('INSERT INTO paragraphs VALUES (1, 1, ?, ?)').run('p1', text);
  if (duplicateDocumentId) {
    db.prepare('INSERT INTO documents VALUES (2, ?)').run('d3');
    db.prepare('INSERT INTO paragraphs VALUES (2, 2, ?, ?)').run('p1', text);
  }
  db.close();
  return file;
}

test('review fix: the corpus context source verifies the real index metadata against the evidence snapshot', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'factory-ensemble-index-'));
  const snapshot = `corpus:${HEX}:${'b'.repeat(64)}`;
  const permission = async () => {};
  const goodIndexPath = syntheticIndex(dir);
  const planDatabase = new DatabaseSync(goodIndexPath, { readOnly: true });
  const plan = planDatabase.prepare(`EXPLAIN QUERY PLAN ${CONTEXT_PARAGRAPH_LOOKUP_SQL}`).all('d3', 'p1');
  planDatabase.close();
  assert.ok(plan.some(({ detail }) => /SEARCH p USING (?:COVERING )?INDEX idx_paragraphs_document_id/u.test(detail)), JSON.stringify(plan));
  assert.ok(!plan.some(({ detail }) => /SCAN p/u.test(detail)), JSON.stringify(plan));

  const good = createCorpusContextSource({ databasePath: goodIndexPath, permission, expectedSnapshot: snapshot });
  assert.deepEqual(await good.lookup({ kind: 'corpus-paragraph', ref: 'd3#p1' }), { status: 'ok', text: '그는 천천히 갈 길을 정했다.' });
  assert.deepEqual(await good.lookup({ kind: 'corpus-paragraph', ref: 'd3#p9' }), { status: 'absent' });
  good.close();
  const ambiguous = createCorpusContextSource({ databasePath: syntheticIndex(dir, { duplicateDocumentId: true }), permission, expectedSnapshot: snapshot });
  assert.deepEqual(await ambiguous.lookup({ kind: 'corpus-paragraph', ref: 'd3#p1' }), { status: 'absent' }, 'duplicate document ids remain fail-closed');
  ambiguous.close();
  // Same document/paragraph ids and even the same text, but a different index snapshot: refused.
  const rebuilt = createCorpusContextSource({ databasePath: syntheticIndex(dir, { rows: 'c'.repeat(64) }), permission, expectedSnapshot: snapshot });
  assert.deepEqual(await rebuilt.lookup({ kind: 'corpus-paragraph', ref: 'd3#p1' }), { status: 'snapshot_mismatch' });
  rebuilt.close();
  const other = createCorpusContextSource({ databasePath: syntheticIndex(dir, { manifest: 'd'.repeat(64) }), permission, expectedSnapshot: snapshot });
  assert.deepEqual(await other.lookup({ kind: 'corpus-paragraph', ref: 'd3#p1' }), { status: 'snapshot_mismatch' });
  other.close();
  const bare = createCorpusContextSource({ databasePath: syntheticIndex(dir, { skipMetadata: true, manifest: 'e'.repeat(64) }), permission, expectedSnapshot: snapshot });
  assert.notEqual((await bare.lookup({ kind: 'corpus-paragraph', ref: 'd3#p1' })).status, 'ok', 'an index without metadata is never trusted');
  bare.close();
  assert.throws(() => createCorpusContextSource({ databasePath: 'x', permission }), /expected evidence source_snapshot/);
  assert.throws(() => createCorpusContextSource({ databasePath: 'x', permission, expectedSnapshot: 'corpus:bad' }), /expected evidence source_snapshot/);

  // Decision creation fails closed on a mismatched index; the matching index records a decision.
  const first = await produce(fallbackEvidence, triple(FALLBACK));
  const [entry] = queueOf(first);
  const proposals = [proposal(entry, { outcome: 'context_confirmed', lemma: '가다', pos: 'verb' })];
  const mismatched = createCorpusContextSource({ databasePath: syntheticIndex(dir, { rows: 'f'.repeat(64) }), permission, expectedSnapshot: snapshot });
  await assert.rejects(() => produce(fallbackEvidence, triple(FALLBACK), { contextProposals: proposals, contextAgent: 'claude', contextSource: mismatched }), /does not match the evidence source snapshot/);
  mismatched.close();
  const matching = createCorpusContextSource({ databasePath: syntheticIndex(dir), permission, expectedSnapshot: snapshot });
  const recorded = await produce(fallbackEvidence, triple(FALLBACK), { contextProposals: proposals, contextAgent: 'claude', contextSource: matching });
  assert.equal(recorded.manifest.context_fallback.decisions[0].outcome, 'context_confirmed');
  // Verification of the recorded decision against a different index snapshot is rejected too.
  const decisions = recorded.manifest.context_fallback.decisions;
  assert.deepEqual(await verifyDecisionsAgainstSource({ decisions, contextSource: matching, snapshot }), []);
  const swapped = createCorpusContextSource({ databasePath: syntheticIndex(dir, { rows: '1'.repeat(64) }), permission, expectedSnapshot: snapshot });
  assert.match((await verifyDecisionsAgainstSource({ decisions, contextSource: swapped, snapshot })).join(), /does not match the recorded source snapshot/);
  matching.close();
  swapped.close();

  // CLI path: the review pack and proposals run bind to the real index file named by the evidence digests.
  const root = await mkdtemp(path.join(tmpdir(), 'factory-ensemble-clisnap-'));
  const cache = await cacheForTask(root);
  await writeFile(path.join(cache.taskDirectory, 'candidate-evidence.json'), JSON.stringify(evidenceDoc(fallbackEvidence)));
  const args = ['--evidence', cache.evidenceArgument, '--task-id', 'T000001', '--base-ref', 'none', '--dry-run', '--context-review-pack', 'pack.json'];
  const deps = { root, cachePaths: cache.cachePaths, providers: triple(FALLBACK), permission: async () => {}, log: () => {} };
  await runStage1(args, { ...deps, contextDatabasePath: syntheticIndex(dir) });
  assert.equal(JSON.parse(await readFile(path.join(cache.taskDirectory, 'pack.json'), 'utf8'))[0].aligned, true);
  await assert.rejects(() => runStage1(args, { ...deps, providers: triple(FALLBACK), contextDatabasePath: syntheticIndex(dir, { rows: '2'.repeat(64) }) }), /does not match the evidence source snapshot/);
});

test('permanent trash merges observation histories, preserves partial candidates and bounds chunks', async () => {
  const table = { 가는: GADA.가는 };
  const result = await produce([
    cand('가다', 'verb', [h('d1', '가는'), h('d1', '갈', 'p2')]),
  ], triple({ k: table, h: table, m: table }));
  assert.deepEqual(result.rows.map((row) => row.input), ['가다']);
  assert.equal(result.manifest.unresolved_observations.length, 1);
  const second = structuredClone(result.manifest);
  second.batch_id = 'C000003';
  second.unresolved_observations[0].verification = { state: 'truth_unknown', decision_id: 'D0001' };
  const { chunks, references } = mergeUnresolved(new Map(), [result.manifest, second]);
  assert.equal(trashIndex(chunks).size, 1);
  const record = [...chunks.values()][0][0];
  assert.equal(record.variants.length, 2);
  assert.equal(record.variants.flatMap((variant) => variant.occurrences).length, 2);
  assert.deepEqual([...failedProposalLemmas(chunks)], ['가다']);
  const compact = compactManifest(result.manifest, references.get(result.manifest.batch_id));
  assert.equal(compact.manifest.unresolved_observations, undefined);
  assert.equal(compact.manifest.excluded_observations, undefined);
  assert.equal(compact.manifest.context_fallback.decisions, undefined);
  assert.equal(JSON.parse(compact.stage1DecisionsText).unresolved, undefined);
  assert.deepEqual(restoreManifest(compact.manifest, compact.history, trashIndex(chunks)), result.manifest);
  assert.deepEqual(validateCandidateBatch({ manifest: compact.manifest, candidatesText: result.candidatesText, stage1DecisionsText: compact.stage1DecisionsText }), []);
  assert.deepEqual(validateTrashChunk(chunkText([record])), []);
  const repeated = mergeUnresolved(chunks, [result.manifest]);
  assert.equal(trashIndex(repeated.chunks).size, 1);
  assert.equal(record.variants.flatMap((variant) => variant.occurrences).length, 2);
  const anotherSnapshot = { ...result.manifest, source_snapshot: `corpus:${'c'.repeat(64)}:${'d'.repeat(64)}` };
  assert.equal(trashIndex(mergeUnresolved(chunks, [anotherSnapshot]).chunks).size, 2);
  const many = structuredClone(result.manifest);
  many.unresolved_observations = Array.from({ length: 501 }, (_, i) => ({ ...many.unresolved_observations[0], queue_id: `U${String(i + 1).padStart(4, '0')}`, evidence: { kind: 'corpus-paragraph', ref: `d1#p${i}` } }));
  const split = mergeUnresolved(new Map(), [many]);
  assert.deepEqual([...split.chunks.values()].map((rows) => rows.length), [500, 1]);
  assert.deepEqual(validateTrashChunk(chunkText(split.chunks.get('T000001.jsonl'))), []);
  assert.match(validateTrashChunk(chunkText([record, record])).join(), /duplicate/);
});

test('Normal factory rejects missing or substituted valid archived observations for every new production batch', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'archive-completeness-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const cache = await cacheForTask(root);
  const table = { 가는: GADA.가는 };
  const initial = evidenceDoc([cand('가다', 'verb', [
    h('d1', '가는'), h('d1', '갈', 'p2'), h('d2', '갈', 'p3'),
  ])]);
  await writeFile(path.join(cache.taskDirectory, 'candidate-evidence.json'), JSON.stringify(initial));
  const produced = await runStage1([
    '--evidence', cache.evidenceArgument, '--task-id', 'T000001',
    '--base-ref', 'none', '--max-candidates', '1',
  ], {
    root, cachePaths: cache.cachePaths, providers: triple({ k: table, h: table, m: table }),
    permission: async () => {}, log: () => {},
  });
  assert.equal(produced.manifest.contract, 'lexical-factory-candidate-manifest-v3');
  assert.equal(produced.manifest.archive.unresolved_count, 2, 'two different source hits remain unresolved');
  assert.deepEqual(await validateFactoryRepository({ root }), []);

  const manifestPath = path.join(root, 'data/candidates/C000001/manifest.json');
  const originalManifestText = await readFile(manifestPath, 'utf8');
  const oversizedManifest = JSON.parse(originalManifestText);
  oversizedManifest.archive.unresolved_count = Number.MAX_SAFE_INTEGER;
  await writeFile(manifestPath, JSON.stringify(oversizedManifest) + '\n');
  const validateScriptUrl = new URL('../scripts/factory/validate.mjs', import.meta.url).href;
  const validationSource = `import { validateFactoryRepository } from ${JSON.stringify(validateScriptUrl)};\n`
    + 'process.stdout.write(JSON.stringify(await validateFactoryRepository({ root: process.argv[1] })));';
  const oversizedErrors = execFileSync(process.execPath,
    ['--input-type=module', '-e', validationSource, root], { encoding: 'utf8', timeout: 5000 });
  assert.match(JSON.parse(oversizedErrors).join('\n'),
    /archive unresolved occurrence count 2 differs from manifest 9007199254740991/u,
    'the shared Normal validator rejects an oversized count without iterating to it');
  await writeFile(manifestPath, originalManifestText);

  const archivePath = path.join(root, 'data/candidate-trash/T000001.jsonl');
  const original = await readFile(archivePath, 'utf8');
  const rows = original.trimEnd().split('\n').map(JSON.parse);
  assert.equal(rows.length, 2);
  await writeFile(archivePath, chunkText(rows.slice(1)));
  assert.match((await validateFactoryRepository({ root })).join('\n'),
    /archive unresolved occurrence count|missing archive occurrence/u,
    'deleting a wholly valid row must fail the shared merge-critical Normal gate');

  const substitute = structuredClone(rows[0]);
  const ref = substitute.variants[0].observation.evidence.ref + '-unrelated';
  const alternative = structuredClone(substitute.variants[0].observation);
  alternative.evidence.ref = ref;
  const source = mergeUnresolved(new Map(), [{
    batch_id: produced.manifest.batch_id,
    source_snapshot: produced.manifest.source_snapshot,
    unresolved_observations: [{ queue_id: 'U0001', ...alternative }],
  }]).chunks.get('T000001.jsonl')[0];
  assert.deepEqual(validateTrashChunk(chunkText([source])), []);
  await writeFile(archivePath, chunkText([source, rows[1]]));
  assert.match((await validateFactoryRepository({ root })).join('\n'),
    /archive unresolved observations digest differs/u,
    'substituting another individually valid observation must fail manifest digest binding');
  await writeFile(archivePath, original);
  assert.deepEqual(await validateFactoryRepository({ root }), [], 'the valid complete batch still passes');
  const oldChunks = new Map([['T000001.jsonl', rows]]);
  const second = {
    batch_id: 'C654321',
    source_snapshot: produced.manifest.source_snapshot,
    unresolved_observations: [{ queue_id: 'U0001', ...rows[0].variants[0].observation }],
  };
  const reused = mergeUnresolved(oldChunks, [second]);
  assert.deepEqual([...reused.changed], ['T000001.jsonl'], 'reuse appends an occurrence to the old chunk');
  const nextCompact = compactManifest(second, reused.references.get(second.batch_id)).manifest;
  const changedOccurrences = [...reused.chunks.values()].flatMap((chunk) => chunk.flatMap((row) =>
    row.variants.flatMap((variant) => variant.occurrences
      .filter((occurrence) => occurrence.batch_id === second.batch_id)
      .map((occurrence) => ({ row, variant, occurrence })))));
  assert.deepEqual(validateArchivedUnresolved(nextCompact, changedOccurrences), [],
    'a new batch may reuse a valid observation by modifying an existing archive chunk');
});

test('production CLI refills valid lemmas, skips trash proposals before analysis and publishes compact artifacts', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'factory-refill-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const cache = await cacheForTask(root);
  const table = { 가는: GADA.가는, 걸음: [p('걸음', 'noun')] };
  const providers = triple({ k: table, h: table, m: table });
  const initial = evidenceDoc([cand('가다', 'verb', [h('d1', '가는'), h('d1', '갈', 'p2')])]);
  await writeFile(path.join(cache.taskDirectory, 'candidate-evidence.json'), JSON.stringify(initial));
  let pages = 0;
  const produced = await runStage1(['--evidence', cache.evidenceArgument, '--task-id', 'T000001', '--base-ref', 'none', '--max-candidates', '2'], {
    root, cachePaths: cache.cachePaths, providers, permission: async () => {}, log: () => {},
    selectPage: async ({ exclusions }) => {
      pages += 1;
      assert.ok(exclusions.has('가다'));
      return { ...evidenceDoc([cand('걸음', 'noun', [h('d2', '걸음')])]), selection: { exhaustion: { contract: 'corpus-selector-exhaustion-v1', remaining_lemma_count: 0 } } };
    },
  });
  assert.equal(pages, 1);
  assert.equal(produced.rows.length, 2);
  assert.equal(produced.manifest.contract, 'lexical-factory-candidate-manifest-v3');
  assert.equal(produced.manifest.production.target, 2);
  assert.equal(produced.manifest.archive.unresolved_count, 1);
  assert.deepEqual(await validateFactoryRepository({ root }), []);
  const decisionsPath = path.join(root, produced.manifest.stage1_decisions.path);
  const decisionsText = await readFile(decisionsPath, 'utf8');
  assert.equal(produced.manifest.excluded_observations, undefined);
  assert.equal(produced.manifest.context_fallback.decisions, undefined);
  assert.equal(JSON.parse(decisionsText).unresolved, undefined);
  await rm(decisionsPath);
  assert.match((await validateFactoryRepository({ root })).join(), /missing or altered stage1-decisions/);
  await writeFile(decisionsPath, decisionsText + ' ');
  assert.match((await validateFactoryRepository({ root })).join(), /missing or altered stage1-decisions/);
  await writeFile(decisionsPath, decisionsText);
  const trash = await loadTrash(root);
  assert.deepEqual([...failedProposalLemmas(trash)], ['가다']);
  const git = (...args) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.com', ...args], { cwd: root, stdio: 'pipe' });
  git('init', '-q'); git('add', 'data'); git('commit', '-q', '-m', 'Factory baseline');
  const report = {};
  assert.deepEqual(await validateFactoryRepository({ root, base: loadBaseManifests('HEAD', root), report }), []);
  assert.deepEqual(report.archiveValidation, { checked_chunks: 0, unchanged_chunks_skipped: 1 }, 'normal validation does not read unchanged archive payloads');
  const trashPath = path.join(root, 'data/candidate-trash/T000001.jsonl');
  const originalTrash = await readFile(trashPath, 'utf8');
  await writeFile(trashPath, 'malformed\n');
  assert.match((await validateFactoryRepository({ root, base: loadBaseManifests('HEAD', root) })).join(), /JSONL|Unexpected token/);
  await writeFile(trashPath, originalTrash);
  // Valid JSON may spell a key with a Unicode escape. Decode IDs rather than
  // scanning the serialized spelling of the key in unchanged baseline chunks.
  const encodedTrash = originalTrash.replaceAll('"observation_id"', '"observ\\u0061tion_id"');
  assert.notEqual(encodedTrash, originalTrash);
  assert.deepEqual(validateTrashChunk(encodedTrash), []);
  await writeFile(trashPath, encodedTrash);
  git('add', 'data/candidate-trash/T000001.jsonl');
  git('commit', '-q', '-m', 'Escaped JSON key baseline');
  assert.deepEqual(await validateFactoryRepository({ root, base: loadBaseManifests('HEAD', root) }), []);
  // The common validator rejects cross-chunk duplicates against an unchanged
  // baseline, while a distinct observation passes the same production path.
  const extraPath = path.join(root, 'data/candidate-trash/T000002.jsonl');
  await writeFile(extraPath, originalTrash);
  assert.match((await validateFactoryRepository({ root, base: loadBaseManifests('HEAD', root) })).join(), /duplicate archive identity/);
  const originalRow = [...trash.values()][0][0];
  const observation = structuredClone(originalRow.variants[0].observation);
  observation.evidence.ref += '-distinct';
  const different = mergeUnresolved(new Map(), [{ batch_id: 'C000002', source_snapshot: produced.manifest.source_snapshot, unresolved_observations: [observation] }]);
  await writeFile(extraPath, chunkText([...different.chunks.values()][0]));
  assert.deepEqual(await validateFactoryRepository({ root, base: loadBaseManifests('HEAD', root) }), []);
  // Two changed chunks must also be compared with each other.
  const thirdPath = path.join(root, 'data/candidate-trash/T000003.jsonl');
  await writeFile(thirdPath, await readFile(extraPath, 'utf8'));
  assert.match((await validateFactoryRepository({ root, base: loadBaseManifests('HEAD', root) })).join(), /duplicate archive identity/);
  await rm(extraPath); await rm(thirdPath);
  // An earlier failed proposal is excluded before a provider is called, even
  // when a new input file accidentally supplies it again.
  const secondCache = await cacheForTask(root, 'T000002');
  await writeFile(path.join(secondCache.taskDirectory, 'candidate-evidence.json'), JSON.stringify(initial));
  const rejectingProviders = providers.map((provider) => ({ ...provider, analyze: async () => { throw new Error('must not analyze excluded proposal'); } }));
  await assert.rejects(() => runStage1(['--evidence', secondCache.evidenceArgument, '--task-id', 'T000002', '--base-ref', 'none'], {
    root, cachePaths: secondCache.cachePaths, providers: rejectingProviders, permission: async () => {}, log: () => {},
    selectPage: async () => ({ ...evidenceDoc([]), selection: { exhaustion: { contract: 'corpus-selector-exhaustion-v1', remaining_lemma_count: 0 } } }),
  }), /source exhausted/);
});

test('default refill selector derives a corpus-safe batch id from a T-prefixed task id', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'factory-refill-selector-id-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const cache = await cacheForTask(root);
  const initial = evidenceDoc([cand('가다', 'verb', [h('d1', '가는')])]);
  await writeFile(path.join(cache.taskDirectory, 'candidate-evidence.json'), JSON.stringify(initial));
  const table = { 가는: GADA.가는, 걸음: [p('걸음', 'noun')] };
  let selectorCalls = 0;
  const spawnSelector = (_executable, command, spawnOptions) => {
    selectorCalls += 1;
    assert.equal(spawnOptions.cwd, root);
    const selector = parseCorpusArguments(command.slice(1), { repositoryDirectory: root, cachePaths: cache.cachePaths });
    assert.match(selector.batchId, /^t000001-[0-9a-f]{12}$/u);
    assert.equal(selector.candidateLimit, 2);
    assert.equal(selector.includeCanonicalLemmas, true);
    assert.equal(selector.reuseAnalysisFrom, cache.taskDirectory);
    assert.equal(selector.outputDirectory, path.join(cache.taskDirectory, 'refill-C000001-000001'));
    assert.equal(selector.exclusionLemmaSources.length, 1);

    const listeners = new Map();
    const child = { on(event, listener) { listeners.set(event, listener); return child; } };
    queueMicrotask(async () => {
      try {
        await mkdir(selector.outputDirectory, { recursive: true });
        const nextPage = {
          ...evidenceDoc([cand('걸음', 'noun', [h('d2', '걸음')])]),
          selection: { exhaustion: { contract: 'corpus-selector-exhaustion-v1', remaining_lemma_count: 0 } },
        };
        await writeFile(path.join(selector.outputDirectory, 'candidate-evidence.json'), JSON.stringify(nextPage));
        listeners.get('close')?.(0);
      } catch (error) {
        listeners.get('error')?.(error);
      }
    });
    return child;
  };

  const result = await runStage1([
    '--evidence', cache.evidenceArgument, '--task-id', 'T000001', '--base-ref', 'none', '--max-candidates', '2',
  ], {
    root, cachePaths: cache.cachePaths, providers: triple({ k: table, h: table, m: table }),
    permission: async () => {}, log: () => {}, spawnSelector,
  });
  assert.equal(selectorCalls, 1);
  assert.equal(result.rows.length, 2);
  assert.equal(result.manifest.production.target, 2);
  assert.deepEqual(await validateFactoryRepository({ root }), []);
});

test('refill resumes identical inputs, fails closed on runtime errors and records true exhaustion', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'factory-refill-resume-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const table = { 가는: GADA.가는, 걸음: [p('걸음', 'noun')] };
  const providers = triple({ k: table, h: table, m: table });
  const initialEvidence = evidenceDoc([cand('가다', 'verb', [h('d1', '가는')])]);
  const args = { batchId: 'C000001', taskId: 'T000001', maxCandidates: 2, canonicalEntries: [], canonicalDigest: HEX, policy: ENSEMBLE_POLICY, providers };
  const common = { initialEvidence, arguments: args, exclusions: new Set(), checkpointPath: path.join(root, 'checkpoint.json') };
  await assert.rejects(() => refillCandidateBatch({ ...common, selectPage: async () => { throw new Error('interrupted selector'); } }), /interrupted selector/);
  const before = providers.map((provider) => provider.calls.length);
  const resumed = await refillCandidateBatch({ ...common, selectPage: async () => ({ ...evidenceDoc([cand('걸음', 'noun', [h('d2', '걸음')])]), selection: { exhaustion: { contract: 'corpus-selector-exhaustion-v1', remaining_lemma_count: 0 } } }) });
  assert.equal(resumed.rows.length, 2);
  providers.forEach((provider, index) => assert.equal(provider.calls.length, before[index] + 1, 'checkpoint avoids reanalysis of first page'));
  const short = await refillCandidateBatch({ ...common, checkpointPath: path.join(root, 'short.json'), selectPage: async () => ({ ...evidenceDoc([]), selection: { exhaustion: { contract: 'corpus-selector-exhaustion-v1', remaining_lemma_count: 0 } } }) });
  assert.equal(short.rows.length, 1);
  assert.equal(short.production.exhausted, true);
  await assert.rejects(() => refillCandidateBatch({ ...common, arguments: { ...args, maxCandidates: 3 }, selectPage: async () => {} }), /binding differs/);
  await assert.rejects(() => refillCandidateBatch({ ...common, checkpointPath: path.join(root, 'empty-not-exhausted.json'), selectPage: async () => ({ ...evidenceDoc([]), selection: { exhaustion: { contract: 'corpus-selector-exhaustion-v1', remaining_lemma_count: 1 } } }) }), /not proof/);
  const broken = providers.map((provider) => ({ ...provider, analyze: async () => { throw new Error('runtime unavailable'); } }));
  await assert.rejects(() => refillCandidateBatch({ ...common, checkpointPath: path.join(root, 'broken.json'), arguments: { ...args, providers: broken }, selectPage: async () => {} }), /failed closed/);
});

test('candidate and trash publication rolls back validation failures and recovers interrupted journal', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'factory-publish-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const files = new Map([['data/candidates/C000001/candidates.jsonl', 'new\n'], ['data/candidate-trash/T000001.jsonl', 'history\n']]);
  const journalDirectory = path.join(root, 'data/local/transaction');
  await assert.rejects(() => publishArtifacts({ root, files, journalDirectory, validate: async () => ['contract failed'] }), /contract failed/);
  await assert.rejects(() => readFile(path.join(root, 'data/candidates/C000001/candidates.jsonl')), { code: 'ENOENT' });
  await assert.rejects(() => readFile(path.join(root, 'data/candidate-trash/T000001.jsonl')), { code: 'ENOENT' });
  // A persisted journal is the recovery boundary, including an already-written
  // first file left by an interrupted process.
  await mkdir(path.join(root, 'data/candidates/C000001'), { recursive: true });
  await writeFile(path.join(root, 'data/candidates/C000001/candidates.jsonl'), 'new\n');
  const recovered = await recoverArtifacts({ root, journalDirectory, validate: async () => [] });
  assert.deepEqual(recovered, files);
  assert.equal(await readFile(path.join(root, 'data/candidate-trash/T000001.jsonl'), 'utf8'), 'history\n');
});

test('one-time history migration proves every original manifest and candidate binding before writing', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'factory-migration-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const table = { 가는: GADA.가는, 걸음: [p('걸음', 'noun')] };
  const first = await produce([cand('가다', 'verb', [h('d1', '가는')]), cand('없다', 'adjective', [h('d2', '없는')])], triple({ k: table, h: table, m: table }), { batchId: 'C000001' });
  const second = await produce([cand('걸음', 'noun', [h('d3', '걸음')]), cand('없다', 'adjective', [h('d2', '없는')])], triple({ k: table, h: table, m: table }), { batchId: 'C000002' });
  for (const result of [first, second]) {
    const directory = path.join(root, 'data/candidates', result.manifest.batch_id);
    await mkdir(directory, { recursive: true });
    await writeFile(path.join(directory, 'manifest.json'), JSON.stringify(result.manifest, null, 2) + '\n');
    await writeFile(path.join(directory, 'candidates.jsonl'), result.candidatesText);
  }
  const plan = await planHistoryMigration(root);
  assert.equal(plan.report.totals.unresolved_before, 2);
  assert.equal(plan.report.totals.unique_observations, 1);
  assert.equal(plan.report.totals.occurrences_preserved, 2);
  assert.ok(plan.report.batches.every((mapping) => mapping.before_manifest_sha256 !== mapping.after_manifest_sha256));
  assert.equal(plan.files.has('data/candidates/C000001/candidates.jsonl'), false);
  await assert.rejects(() => readFile(path.join(root, 'data/candidate-trash/T000001.jsonl')), { code: 'ENOENT' }, 'planning writes no archive');
  await publishArtifacts({ root, files: plan.files, journalDirectory: path.join(root, 'data/local/migration'), validate: () => validateFactoryRepository({ root }) });
  assert.equal(await readFile(path.join(root, 'data/candidates/C000001/candidates.jsonl'), 'utf8'), first.candidatesText);
  assert.deepEqual(await validateFactoryRepository({ root }), []);
  await assert.rejects(() => planHistoryMigration(root), /already applied/);
});

test('the 500 final-lemma target refills a short page and preserves overflow as normal deferred observations', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'factory-refill-500-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  // Structural fixture labels only, never admitted or used as lexical judgments.
  const labels = Array.from({ length: 501 }, (_, index) => `가${String.fromCodePoint(0xac00 + index)}`);
  const table = Object.fromEntries(labels.map((label) => [label, [p(label, 'noun', label)]]));
  const evidenceFor = (names) => evidenceDoc(names.map((label) => cand(label, 'noun', [h(label, label)])));
  const result = await refillCandidateBatch({
    initialEvidence: evidenceFor(labels.slice(0, 499)), exclusions: new Set(), checkpointPath: path.join(root, 'checkpoint.json'),
    arguments: { batchId: 'C000001', taskId: 'T000001', maxCandidates: 500, canonicalEntries: [], canonicalDigest: HEX, policy: ENSEMBLE_POLICY, providers: triple({ k: table, h: table, m: table }) },
    selectPage: async () => ({ ...evidenceFor(labels.slice(499)), selection: { exhaustion: { contract: 'corpus-selector-exhaustion-v1', remaining_lemma_count: 0 } } }),
  });
  assert.equal(result.rows.length, 500);
  assert.equal(result.production.pages, 2);
  assert.equal(result.manifest.selection.deferred_lemma_count, 1);
  assert.equal(result.manifest.excluded_observations[0].disposition, 'deferred_lemma');
  assert.equal(result.manifest.unresolved_observations.length, 0);
});

test('zero-yield true exhaustion persists unresolved observations in a terminal Stage 1 result', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'factory-zero-exhaustion-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const cache = await cacheForTask(root);
  await writeFile(path.join(cache.taskDirectory, 'candidate-evidence.json'), JSON.stringify(evidenceDoc([cand('없다', 'adjective', [h('d1', '없는')])])));
  const result = await runStage1(['--evidence', cache.evidenceArgument, '--task-id', 'T000001', '--base-ref', 'none'], {
    root, cachePaths: cache.cachePaths, providers: triple({}), permission: async () => {}, log: () => {},
    selectPage: async () => ({ ...evidenceDoc([]), selection: { exhaustion: { contract: 'corpus-selector-exhaustion-v1', remaining_lemma_count: 0 } } }),
  });
  assert.equal(result.manifest.status, 'exhausted');
  assert.equal(result.manifest.candidate_count, 0);
  assert.equal(result.manifest.archive.unresolved_count, 1);
  assert.equal(trashIndex(await loadTrash(root)).size, 1);
  const exclusions = await buildExclusionManifest([path.join(root, 'data/candidates/C000001/candidates.jsonl')], { repositoryDirectory: root, cachePaths: cache.cachePaths });
  assert.deepEqual(exclusions.lemmas, []);
  assert.equal(exclusions.source_artifacts.length, 2, 'an exhausted zero-row source stays bound and adds no guessed lemma');
  assert.deepEqual(await validateFactoryRepository({ root }), []);
  assert.deepEqual(eligibleBatches({ validated: true, candidates: [{ batchId: result.manifest.batch_id, manifest: result.manifest, rows: [] }], reviews: [] }), []);
  const invalid = structuredClone(result.manifest);
  invalid.production.exhausted = false;
  assert.match(validateCandidateBatch({ manifest: invalid, candidatesText: result.candidatesText }).join(), /exhaustion/);
});


test('compact batches retain source-bound candidate and excluded context bindings in the common validators', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'factory-compact-bindings-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const providers = triple(Object.fromEntries(Object.entries(FALLBACK).map(([id, table]) => [id, { ...table, 걸음: [p('걸음', 'noun')] }])));
  const evidence = [cand('가다', 'verb', [h('d1', '가는'), h('d3', '갈'), h('d4', '갈')]),
    cand('걸음', 'noun', [h('d6', '걸음')]), cand('없다', 'adjective', [h('d5', '없는')])];
  const first = await produce(evidence, providers);
  const contextProposals = queueOf(first).filter((entry) => entry.surface === '갈').map((entry) =>
    proposal(entry, { outcome: 'context_confirmed', lemma: '가다', pos: 'verb' }));
  const options = { contextProposals, contextAgent: 'codex', contextSource: source({ ...SOURCE, 'd4#p1': { status: 'ok', text: '지금 갈 방향을 정했다.' } }) };
  const retained = await produce(evidence, providers, options);
  assert.equal(retained.manifest.unresolved_observations.length, 1, 'the fixture requires current binding checks even with historical queue payloads removed');
  const makeBatch = (result) => {
    const merged = mergeUnresolved(new Map(), [result.manifest]);
    const compact = compactManifest(result.manifest, merged.references.get(result.manifest.batch_id));
    return { manifest: compact.manifest, candidatesText: result.candidatesText, stage1DecisionsText: compact.stage1DecisionsText, chunks: merged.chunks };
  };
  const restampRows = (batch, mutate) => {
    const rows = batch.candidatesText.trim().split('\n').map(JSON.parse);
    mutate(rows);
    for (const row of rows) row.review = reviewSummary(row.observations);
    batch.candidatesText = rows.map(JSON.stringify).join('\n') + '\n';
    batch.manifest.candidates_sha256 = sha256Hex(batch.candidatesText);
  };
  const restampDecisions = (batch, mutate) => {
    const details = JSON.parse(batch.stage1DecisionsText);
    mutate(details);
    details.context_fallback.decisions_sha256 = contextDecisionsSha256(details.context_fallback.decisions);
    batch.manifest.context_fallback.decisions_sha256 = details.context_fallback.decisions_sha256;
    batch.manifest.context_fallback.decision_count = details.context_fallback.decisions.length;
    batch.manifest.archive.context_decision_count = details.context_fallback.decisions.length;
    batch.stage1DecisionsText = JSON.stringify(details) + '\n';
    batch.manifest.stage1_decisions.sha256 = sha256Hex(batch.stage1DecisionsText);
  };
  const checkBoth = async (batch, expected = null) => {
    const directory = path.join(root, 'data/candidates', batch.manifest.batch_id);
    await mkdir(directory, { recursive: true });
    await mkdir(path.join(root, 'data/candidate-trash'), { recursive: true });
    await writeFile(path.join(directory, 'manifest.json'), JSON.stringify(batch.manifest));
    await writeFile(path.join(directory, 'candidates.jsonl'), batch.candidatesText);
    await writeFile(path.join(directory, 'stage1-decisions.json'), batch.stage1DecisionsText);
    for (const [name, rows] of batch.chunks) await writeFile(path.join(root, 'data/candidate-trash', name), chunkText(rows));
    const direct = validateCandidateBatch(batch);
    const repository = await validateFactoryRepository({ root });
    if (expected) { assert.match(direct.join(), expected); assert.match(repository.join(), expected); }
    else { assert.deepEqual(direct, []); assert.deepEqual(repository, []); }
  };
  const good = makeBatch(retained);
  await checkBoth(good);
  const swapped = structuredClone(good);
  restampRows(swapped, (rows) => {
    const observations = rows.flatMap((row) => row.observations).filter((entry) => entry.ensemble.resolution === 'context');
    assert.equal(observations.length, 2);
    [observations[0].ensemble.context_decision, observations[1].ensemble.context_decision] = [observations[1].ensemble.context_decision, observations[0].ensemble.context_decision];
  });
  assert.match(validateCandidateBatch({ manifest: { ...retained.manifest, candidates_sha256: swapped.manifest.candidates_sha256 }, candidatesText: swapped.candidatesText }).join(), /does not match its context decision/);
  await checkBoth(swapped, /does not match its context decision/);
  const unused = structuredClone(good);
  restampDecisions(unused, (details) => {
    const entry = structuredClone(details.context_fallback.decisions[0]);
    entry.decision_id = 'D0003'; entry.observation_digest = 'f'.repeat(64); entry.evidence.ref += '-unused';
    entry.decision_sha256 = decisionSha256(entry);
    details.context_fallback.decisions.push(entry);
  });
  await checkBoth(unused, /resolves no retained observation/);
  const excludedResult = await produce(evidence, providers, { ...options, producedLemmas: new Set(['가다']) });
  const excludedGood = makeBatch(excludedResult);
  await checkBoth(excludedGood);
  for (const [field, value] of [['lemma', '걷다'], ['pos', 'noun'], ['surface', '갈까'], ['evidence', { kind: 'corpus-paragraph', ref: 'foreign#p1' }]]) {
    const bad = structuredClone(excludedGood);
    restampDecisions(bad, (details) => {
      details.excluded_observations.find((entry) => entry.ensemble.resolution === 'context')[field] = value;
      details.excluded_observations.sort((a, b) => `${a.disposition}\0${a.lemma}\0${a.observation_digest}`.localeCompare(`${b.disposition}\0${b.lemma}\0${b.observation_digest}`));
    });
    await checkBoth(bad, /does not match its context decision/);
  }
  const wrongTrace = structuredClone(excludedGood);
  restampDecisions(wrongTrace, (details) => { details.excluded_observations.find((entry) => entry.ensemble.resolution === 'context').ensemble.trace_digest = 'f'.repeat(64); });
  await checkBoth(wrongTrace, /does not match its context decision/);
  const wrongCategories = structuredClone(good);
  wrongCategories.manifest.ensemble.counts.categories.concordant -= 1;
  wrongCategories.manifest.ensemble.counts.categories.unsupported_or_unknown += 1;
  await checkBoth(wrongCategories, /counts.categories/);
  const noQueue = makeBatch(await produce(evidence.filter((entry) => entry.proposed_lemma !== '없다'), providers, options));
  await checkBoth(noQueue);
  const wrongAggregate = structuredClone(noQueue);
  wrongAggregate.manifest.ensemble.trace_sha256 = 'f'.repeat(64);
  await checkBoth(wrongAggregate, /ensemble.trace_sha256 does not bind/);
  await checkBoth(good);
});
