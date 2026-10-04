import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';

import { admitRecords } from './helpers/intake-admission.mjs';
import { frameUsesLemma } from '../scripts/batch/semantic-self-check.mjs';
import { buildDictionary } from '../scripts/build/dictionary.mjs';
import { findRecordsBySearchTerm } from '../scripts/build/query.mjs';
import { CORPUS_ADAPTER_ID } from '../scripts/intake/adapters/corpus-adapter.mjs';
import { SYNTHETIC_ADAPTER_ID, syntheticAdapter } from '../scripts/intake/adapters/synthetic-adapter.mjs';
import { analyzeFrames, frameDisposition } from '../scripts/intake/frame-analysis.mjs';
import { analysisInputDigest } from '../scripts/intake/pipeline.mjs';
import {
  assertHandoffAdmits,
  buildProductionHandoff,
  corpusBatchCandidates,
  handoffEntryFor,
  handoffQaBinding,
  verifyProductionHandoff,
} from '../scripts/intake/production-handoff.mjs';
import { sha256Json } from '../scripts/validate/semantic-audit.mjs';

// Producer → shared intake hand-off → production gate → existing shared lexical
// admission → canonical JSONL → SQLite → direct search, for both source adapters.
const BATCH = 'issue-223-m9-e-corpus-batch-16-20261004';
const METADATA = { service_version: '1', kiwipiepy_version: '0.24.0', kiwipiepy_model_version: '0.24.0', top_n: 3 };
const P = (lemma, pos) => ({ lemma, pos, form: lemma });
const TABLE = {
  푸르다: { status: 'ok', analyses: [[P('푸르다', 'adjective')], []] },
  바람: { status: 'ok', analyses: [[P('바람', 'noun')], []] },
  물결무늬: { status: 'ok', analyses: [[P('물결', 'noun'), P('무늬', 'noun')]] },
};
const analyzer = async (requests) => ({
  metadata: METADATA,
  results: requests.map(({ id, text }) => ({ ...(TABLE[text] ?? { status: 'unsupported', analyses: [] }), id, input_digest: analysisInputDigest(text) })),
});
const GLOSSES = { 푸르다: '풀이나 맑은 하늘처럼 선명하게 맑은 초록이나 파랑을 띠다.', 바람: '공기가 움직여 느껴지는 흐름.', 물결무늬: '물결처럼 굽이치는 무늬.' };
const POS = { 푸르다: 'adjective', 바람: 'noun', 물결무늬: 'noun' };

const inventory = {
  candidates: ['푸르다', '바람', '물결무늬'].map((lemma) => ({
    proposed_lemma: lemma, proposed_pos: POS[lemma], decision_state: 'candidate', coverage_status: 'uncovered',
    ambiguity_status: 'single_observed_analysis_unverified', observed_surface_forms: [{ surface: lemma }],
  })),
};
const evidence = { candidates: inventory.candidates.map((_, index) => ({ evidence: { representative_hits: [{ document_id: `D${index}`, paragraph_id: `P${index}` }] } })) };

const sources = {
  [CORPUS_ADAPTER_ID]: () => corpusBatchCandidates(inventory, evidence),
  [SYNTHETIC_ADAPTER_ID]: () => syntheticAdapter(inventory.candidates.map((candidate) => ({ word: candidate.proposed_lemma, pos: candidate.proposed_pos }))),
};

// The authored QA step: binds each gloss to the exact hand-off entry and POS.
function review(handoff, lemma, { gloss = GLOSSES[lemma], resolution } = {}) {
  const entry = handoffEntryFor(handoff, { lemma, proposedPos: POS[lemma] });
  return {
    lemma,
    gloss,
    glossSha256: sha256Json(gloss),
    integration: { bindings: { [lemma]: handoffQaBinding(handoff, entry, { glossSha256: sha256Json(gloss), pos: POS[lemma] }) }, resolutions: resolution ? { [lemma]: resolution } : {} },
  };
}

function admit(handoff, reviews) {
  const records = reviews.map((entry, index) => {
    assertHandoffAdmits(handoff, { lemma: entry.lemma, proposedPos: POS[entry.lemma], finalPos: POS[entry.lemma], glossSha256: sha256Json(entry.gloss), integration: entry.integration, hitCount: 1 });
    const id = `w9${String(index + 1).padStart(4, '0')}`;
    return { id, record_type: 'entry', role: 'start', candidate_id: id, lemma: entry.lemma, search_forms: [entry.lemma], senses: [{ id: `${id}-s1`, pos: POS[entry.lemma], gloss: entry.gloss }] };
  });
  return admitRecords(records, { batchId: BATCH });
}

async function searchAfterBuild(records, query) {
  const root = await mkdtemp(path.join(tmpdir(), 'typewriter-prod-e2e-'));
  try {
    const directory = path.join(root, 'canonical');
    await mkdir(directory);
    await writeFile(path.join(directory, 'fixture.jsonl'), `${records.map((record) => JSON.stringify(record)).join('\n')}\n`);
    const outputPath = path.join(root, 'dictionary.sqlite');
    await buildDictionary({ inputDirectory: directory, outputPath, allowDirty: true });
    const database = new DatabaseSync(outputPath, { readOnly: true });
    try { return findRecordsBySearchTerm(database, query).matches.map((match) => match.lemma); } finally { database.close(); }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

for (const [adapterId, read] of Object.entries(sources)) {
  test(`${adapterId}: valid admission reaches canonical → SQLite → direct search; holds and tampering are refused before promotion`, async () => {
    const raw = read();
    const handoff = await buildProductionHandoff({ batchId: BATCH, rawCandidates: raw, analyzer, adapterId });
    assert.equal(verifyProductionHandoff(handoff, { rawCandidates: raw, batchId: BATCH, adapterId }), true);

    // Positive: bound reviews pass the production gate, the shared lexical admission, build and search.
    const { records, audit } = admit(handoff, [review(handoff, '푸르다'), review(handoff, '바람')]);
    assert.equal(audit.blocking_finding_count, 0);
    assert.deepEqual(await searchAfterBuild(records, '푸른'), ['푸르다']);

    // Negative: an analyzer-uncertain compound without an evidence-citing resolution never becomes a record.
    assert.throws(() => admit(handoff, [review(handoff, '물결무늬')]), (error) => error.code === 'INTAKE_HANDOFF_HOLD_UNRESOLVED');
    // With an explicit resolution citing checked contexts it is a legitimate, reviewed admission.
    const resolved = admit(handoff, [review(handoff, '물결무늬', { resolution: { checked_hit_indices: [0], rationale: '문맥 0에서 한 낱말로 쓰인다.' } })]);
    assert.equal(resolved.audit.blocking_finding_count, 0);

    // Negative: changed gloss, POS, lemma or hand-off entry invalidates the recorded QA before any record exists.
    const stale = review(handoff, '푸르다');
    assert.throws(() => admit(handoff, [{ ...stale, gloss: '다른 풀이.' }]), (error) => error.code === 'INTAKE_HANDOFF_QA_BINDING');
    assert.throws(() => admit(handoff, [{ ...stale, lemma: '바람' }]), (error) => error.code === 'INTAKE_HANDOFF_QA_BINDING');
    const relabelled = structuredClone(handoff);
    relabelled.entries.find((entry) => entry.input === '물결무늬').decision = 'semantic_qa';
    assert.throws(() => verifyProductionHandoff(relabelled, { rawCandidates: raw, batchId: BATCH, adapterId }), (error) => error.code.startsWith('INTAKE_HANDOFF'));
  });
}

test('frames: Kiwi normalizes misconjugations, but the shared form rule stays the accept gate', async () => {
  // A Kiwi-like analyzer that (as measured) explains 듣어서 and 가볍었다 as the lemma anyway.
  const normalizing = async (requests) => ({
    metadata: METADATA,
    results: requests.map(({ id, text }) => ({
      id, status: 'ok', input_digest: analysisInputDigest(text),
      analyses: [[text.includes('듣') ? P('듣다', 'verb') : text.includes('가볍') ? P('가볍다', 'adjective') : P('푸르다', 'adjective')]],
    })),
  });
  const cases = [
    { frame: '그는 소리를 듣어서 놀랐다.', lemma: '듣다', pos: 'verb', valid: false },
    { frame: '가방이 가볍었다.', lemma: '가볍다', pos: 'adjective', valid: false },
    { frame: '그는 소리를 들어서 놀랐다.', lemma: '듣다', pos: 'verb', valid: true },
    { frame: '가방이 가벼웠다.', lemma: '가볍다', pos: 'adjective', valid: true },
    { frame: '하늘이 푸르렀다.', lemma: '푸르다', pos: 'adjective', valid: true },
    { frame: '선생님이 책을 읽으세요.', lemma: '읽다', pos: 'verb', valid: true },
  ];
  const results = await analyzeFrames(normalizing, cases.map(({ frame, lemma, pos }) => ({ frame, lemma, pos })));
  results.forEach((result, index) => {
    const { frame, lemma, pos, valid } = cases[index];
    const rule = frameUsesLemma(frame, lemma, pos);
    assert.equal(rule, valid, `${frame}: form rule`);
    const disposition = frameDisposition(rule, result.verdict);
    if (!valid) {
      // Kiwi says 'uses' for the invalid frames, yet the deterministic rejection is not overridden.
      if (index < 2) assert.equal(result.verdict, 'uses');
      assert.equal(disposition, 'rejected', `${frame}: invalid frames stay rejected`);
    } else {
      assert.notEqual(disposition, 'rejected', `${frame}: genuine regular/irregular/honorific frames are not auto-rejected`);
    }
  });
});
