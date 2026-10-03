import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';

import { admitHandoffs, authorQa } from './helpers/intake-admission.mjs';
import { buildDictionary } from '../scripts/build/dictionary.mjs';
import { findRecordsBySearchTerm } from '../scripts/build/query.mjs';
import { corpusAdapter } from '../scripts/intake/adapters/corpus-adapter.mjs';
import { syntheticAdapter } from '../scripts/intake/adapters/synthetic-adapter.mjs';
import { analysisInputDigest, runIntake } from '../scripts/intake/pipeline.mjs';

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
// Test-fixture glosses stand in for the separate, source-bound semantic QA step.
// A hand-off without an authored fixture entry is never admitted.
const GLOSSES = {
  푸르다: '풀이나 맑은 하늘처럼 선명하게 맑은 초록이나 파랑을 띠다.',
  바람: '공기가 움직여 느껴지는 흐름.',
};

async function admitAndSearch(run, query) {
  const { records, audit } = admitHandoffs(run, authorQa(run, GLOSSES));
  assert.equal(audit.blocking_finding_count, 0);
  const root = await mkdtemp(path.join(tmpdir(), 'typewriter-intake-'));
  const directory = path.join(root, 'canonical');
  try {
    await mkdir(directory);
    await writeFile(path.join(directory, 'fixture.jsonl'), `${records.map((record) => JSON.stringify(record)).join('\n')}\n`);
    const outputPath = path.join(root, 'dictionary.sqlite');
    const summary = await buildDictionary({ inputDirectory: directory, outputPath, allowDirty: true });
    const database = new DatabaseSync(outputPath, { readOnly: true });
    try {
      return { summary, found: findRecordsBySearchTerm(database, query).matches.map((match) => match.lemma) };
    } finally {
      database.close();
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

test('corpus adapter → intake → admission fixture → SQLite → direct search', async () => {
  const candidates = corpusAdapter({ candidates: [
    { proposed_lemma: '푸르다', proposed_pos: 'adjective', decision_state: 'candidate', coverage_status: 'uncovered', observed_surface_forms: [{ surface: '푸른' }] },
    { proposed_lemma: '물결무늬', proposed_pos: 'noun', decision_state: 'candidate', coverage_status: 'uncovered' },
  ] });
  const run = await runIntake({ candidates, analyzer });
  const { summary, found } = await admitAndSearch(run, '푸른');
  assert.equal(summary.recordCount, 1);
  assert.deepEqual(found, ['푸르다']);
});

test('adapter holds keep distinct reasons and are never admitted', async () => {
  const [row] = corpusAdapter({ candidates: [{ proposed_lemma: '푸르다', proposed_pos: 'adjective', decision_state: 'held', ambiguity_status: 'single_observed_analysis_unverified', coverage_status: 'surface_collision' }] });
  assert.deepEqual(row.holds, ['coverage_collision']);
  const [morph] = corpusAdapter({ candidates: [{ proposed_lemma: '푸르다', decision_state: 'held', ambiguity_status: 'held_oov_morphology', coverage_status: 'uncovered' }] });
  assert.deepEqual(morph.holds, ['analysis_ambiguous']);
  const run = await runIntake({ candidates: [row], analyzer });
  assert.equal(run.decisions[0].decision, 'hold');
});

test('shared admission rejects QA not bound to the hand-off, mismatched audits and holds', async () => {
  const withHits = (hits) => corpusAdapter({ candidates: [{ proposed_lemma: '바람', proposed_pos: 'noun', decision_state: 'candidate', coverage_status: 'uncovered', evidence: { representative_hits: hits } }] });
  const reviewed = await runIntake({ candidates: withHits([{ document_id: 'D.1', paragraph_id: 'D.1.18' }]), analyzer });
  const qa = authorQa(reviewed, GLOSSES);
  assert.equal(admitHandoffs(reviewed, qa).records.length, 1);
  for (const hits of [[], [{ document_id: 'D.2', paragraph_id: 'D.2.5' }]]) {
    const changed = await runIntake({ candidates: withHits(hits), analyzer });
    assert.throws(() => admitHandoffs(changed, qa), (error) => error.code === 'QA_HANDOFF_BINDING_MISMATCH');
  }
  assert.throws(() => admitHandoffs(reviewed, qa, { tamperAudit: true }), (error) => error.code === 'SEMANTIC_AUDIT_SOURCE_MISMATCH');
  assert.throws(() => admitHandoffs(reviewed, qa, { omitAudit: true }), (error) => /semantic audit|SEMANTIC_AUDIT/i.test(`${error.code} ${error.message}`));
  const held = await runIntake({ candidates: corpusAdapter({ candidates: [{ proposed_lemma: '바람', proposed_pos: 'noun', decision_state: 'held', ambiguity_status: 'held_oov_morphology' }] }), analyzer });
  assert.equal(admitHandoffs(held, qa).records.length, 0);
});
