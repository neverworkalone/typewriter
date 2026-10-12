import assert from 'node:assert/strict';
import { cp, mkdir, mkdtemp, readFile, rm, symlink } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

import { buildDictionary } from '../scripts/build/dictionary.mjs';
import { loadCanonicalContext } from '../scripts/validate/canonical-context.mjs';
import { sha256Json, validateCanonicalSemanticAudit } from '../scripts/validate/semantic-audit.mjs';
import { reviewedRelationId } from '../scripts/batch/authored-semantic-decision-source.mjs';
import { applyBackfill } from '../scripts/relation/backfill-apply.mjs';
import { buildRelationIndex } from '../scripts/relation/candidate-retrieval.mjs';
import { newQueueState } from '../scripts/relation/backfill-queue.mjs';

import { openCurrentRevisionDatabasePath } from '../scripts/ci/current-revision-database.mjs';
import {
  findRecordsByExactTerm,
  findRecordsBySearchTerm,
  getSenseRelations,
} from '../scripts/build/query.mjs';
import { materializeLexicalUnitCandidates } from '../scripts/batch/lexical-production.mjs';
import {
  serializeAuthoredSemanticDecisionSource,
} from '../scripts/batch/authored-semantic-decision-source.mjs';
import {
  validateIssue211SemanticDecisionSource,
} from '../scripts/batch/validate-issue-211.mjs';
import {
  authorSemanticReviewBinding,
} from '../scripts/validate/semantic-decision-row.mjs';
import {
  DEFAULT_CANONICAL_DIRECTORY,
  readCanonicalRecords,
} from '../scripts/validate/canonical-jsonl.mjs';
import { copyShardedAuthority, readShardedJson } from './helpers/sharded-authority.mjs';

const repositoryDirectory = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
);
const admittedRecordsPath = path.join(
  repositoryDirectory,
  'data/canonical/issue-211-bounded-recovery.jsonl',
);
const candidateSourcePath = path.join(
  repositoryDirectory,
  'data/batches/issue-211-lexical-unit-source.json',
);
const semanticSourcePath = path.join(
  repositoryDirectory,
  'data/batches/issue-211-semantic-decisions.json',
);

async function openDictionary() {
  const { databasePath, outputDirectory } = await openCurrentRevisionDatabasePath({
    temporaryRoot: os.tmpdir(),
    prefix: 'typewriter-issue-211-search-',
    repositoryDirectory,
  });
  return {
    database: new DatabaseSync(databasePath, { readOnly: true }),
    outputDirectory,
  };
}

function parseJsonl(bytes) {
  return bytes.toString('utf8').split(/\r?\n/u).filter(Boolean).map((line) => JSON.parse(line));
}

async function issue211DecisionFixture() {
  const [candidateSourceBytes, semanticSourceBytes, seedBytes, canonical] = await Promise.all([
    readFile(candidateSourcePath),
    readFile(semanticSourcePath),
    readFile(path.join(repositoryDirectory, 'data/inventory/m5-target-seed.json')),
    readCanonicalRecords(DEFAULT_CANONICAL_DIRECTORY),
  ]);
  const candidateSource = JSON.parse(candidateSourceBytes.toString('utf8'));
  const semanticSource = JSON.parse(semanticSourceBytes.toString('utf8'));
  const seed = JSON.parse(seedBytes.toString('utf8'));
  const admittedIds = new Set(semanticSource.decisions
    .filter(({ decision }) => ['included', 'corrected'].includes(decision))
    .map(({ candidate_record_id: id }) => id));
  const baseRecords = canonical.records.filter(({ record }) => !admittedIds.has(record.id));
  const baseSeedTargets = seed.targets.filter(({ inventory_id: id }) => (
    !semanticSource.decisions.some((decision) => decision.inventory_id === id)
  ));
  // Rebuild the historical Issue #211 identity range from its authored decision
  // source. Later issues can append canonical IDs, so deriving this range from
  // the live dataset would silently retarget this regression fixture.
  const firstDecision = semanticSource.decisions[0];
  const firstInventoryNumber = Number(firstDecision.inventory_id.match(/^m5-(\d+)$/u)?.[1]);
  const firstCanonicalNumber = Number(firstDecision.candidate_record_id.match(/^w(\d+)$/u)?.[1]);
  const candidateSet = materializeLexicalUnitCandidates({
    batchId: candidateSource.batch_id,
    source: candidateSource,
    sourceBytes: candidateSourceBytes,
    firstInventoryNumber,
    firstCanonicalNumber,
    baseRecords,
    baseSeedTargets,
  });
  return {
    candidateSource,
    candidateRecords: candidateSet.candidateRecords,
    identities: candidateSet.identities,
    semanticSource,
    semanticSourceBytes,
  };
}

function assertCanonicalSenseRelations(database, sense, recordsById) {
  const expected = (sense.relations ?? []).map((relation, position) => {
    const target = recordsById.get(relation.target);
    const targetSense = target.senses.find(({ id }) => id === relation.target_sense);
    return {
      position, target: relation.target, target_sense: relation.target_sense ?? null,
      type: relation.type, note: relation.note ?? null, relevance: relation.relevance ?? null,
      target_lemma: target.lemma, target_pos: targetSense?.pos ?? null,
      target_gloss: targetSense?.gloss ?? null,
    };
  });
  assert.deepEqual(getSenseRelations(database, sense.id), expected,
    `${sense.id} exposes exactly the current authored canonical relations`);
}

test('Issue #211 admissions resolve exact writer queries with current authored relations', async () => {
  const admittedRecords = parseJsonl(await readFile(admittedRecordsPath));
  const canonical = await readCanonicalRecords(DEFAULT_CANONICAL_DIRECTORY);
  const recordsById = new Map(canonical.records.map(({ record }) => [record.id, record]));
  const opened = await openDictionary();
  try {
    assert.equal(admittedRecords.length, 24);
    for (const record of admittedRecords) {
      const exactRows = findRecordsByExactTerm(opened.database, record.lemma);
      assert.deepEqual(exactRows.map(({ id }) => id), [record.id], `${record.lemma} exact lookup`);

      const response = findRecordsBySearchTerm(opened.database, record.lemma);
      assert.equal(response.status, 'ready', `${record.lemma} search status`);
      assert.deepEqual(response.matches.map(({ id, match }) => ({
        id,
        kind: match.kind,
        field: match.field,
        value: match.value,
      })), [{
        id: record.id,
        kind: 'exact-lemma',
        field: 'lemma',
        value: record.lemma,
      }], `${record.lemma} exact precedence`);
      for (const sense of record.senses) {
        assertCanonicalSenseRelations(opened.database, sense, recordsById);
      }
    }

    for (const lemma of ['사람', '없다']) {
      const record = admittedRecords.find(({ lemma: candidateLemma }) => candidateLemma === lemma);
      assert.ok(record, `${lemma} is admitted`);
      assert.deepEqual(findRecordsByExactTerm(opened.database, lemma).map(({ id }) => id), [record.id]);
      assert.deepEqual(findRecordsBySearchTerm(opened.database, lemma).matches.map(({ id, match }) => ({
        id,
        kind: match.kind,
        field: match.field,
        value: match.value,
      })), [{ id: record.id, kind: 'exact-lemma', field: 'lemma', value: lemma }]);
      for (const sense of record.senses) assertCanonicalSenseRelations(opened.database, sense, recordsById);
    }

    assert.deepEqual(findRecordsByExactTerm(opened.database, '내다'), [], 'the unresolved-sense candidate remains held');
  } finally {
    opened.database.close();
    if (opened.outputDirectory) await rm(opened.outputDirectory, { recursive: true, force: true });
  }
});

test('Issue #211 shared decision admission rejects policy-only dispositions', async () => {
  const fixture = await issue211DecisionFixture();
  for (const basis of [
    'low-writer-usefulness',
    'low-vividness',
    'common-general-term',
    'zero-relations',
    'axis-deficiency',
  ]) {
    const invalid = structuredClone(fixture.semanticSource);
    const row = invalid.decisions.find(({ decision }) => decision === 'included');
    const candidate = invalid.candidate_records.find(({ id }) => id === row.candidate_record_id);
    row.decision = 'rejected';
    row.gloss_judgment = 'reject';
    row.rejection_basis = basis;
    row.decision_rationale = `${row.inventory_id} ${row.candidate_record_id}: synthetic ${basis} rejection regression.`;
    row.review_binding = authorSemanticReviewBinding(row, candidate);
    const serialized = serializeAuthoredSemanticDecisionSource(invalid);

    assert.throws(
      () => validateIssue211SemanticDecisionSource({
        candidateSource: fixture.candidateSource,
        semanticSource: serialized.source,
        semanticSourceBytes: serialized.bytes,
        identities: fixture.identities,
        candidateRecords: fixture.candidateRecords,
      }),
      (error) => error.code === 'ISSUE_211_DECISION_SOURCE_REJECTION_BASIS',
      `${basis} cannot be the sole rejection reason`,
    );
  }
});


test('Issue #211 original admission evidence has no authored relations', async () => {
  const source = JSON.parse(await readFile(semanticSourcePath, 'utf8'));
  for (const decision of source.decisions.filter(({ decision }) => ['included', 'corrected'].includes(decision))) {
    const record = source.candidate_records.find(({ id }) => id === decision.candidate_record_id);
    assert.ok(record);
    for (const sense of record.senses) assert.deepEqual(sense.relations ?? [], []);
    for (const review of decision.sense_reviews) {
      assert.equal(review.relation_decision, 'no-relations');
      assert.equal(review.relation_count, 0);
      assert.deepEqual(review.relation_ids, []);
    }
  }
});

test('source-bound backfill survives the real SQLite query path without accepting tuple drift', async () => {
  const canonical = await loadCanonicalContext();
  const index = buildRelationIndex(canonical);
  const imported = parseJsonl(await readFile(admittedRecordsPath));
  const importedIds = new Set(imported.map(({ id }) => id));
  const source = index.senses.find((sense) => importedIds.has(sense.record_id) && sense.pos === 'noun');
  assert.ok(source, 'the imported lexical entries include a noun sense');
  const related = new Set(source.relations.map(({ target_sense }) => target_sense));
  const target = index.senses.find((sense) => sense.pos === 'noun' && sense.record_id !== source.record_id && !related.has(sense.sense_id));
  assert.ok(target);
  const relation = { target: target.record_id, target_sense: target.sense_id, type: 'association', note: '합성 검색 회귀용 관계.', relevance: 4 };
  const state = newQueueState(canonical.canonicalRevision);
  state.done[source.sense_id] = {
    outcome: 'relations-reviewed', gloss_sha256: sha256Json(source.gloss), relation_count: 1,
    rationale: `${source.sense_id}: 합성 검색 회귀용 승인.`,
    approved_relations: [{ relation_id: reviewedRelationId(source.sense_id, relation), relation,
      rationale: `${source.record_id} ${source.sense_id}: 합성 검색 회귀용 근거.` }],
    reviewed_candidates: [{ id: target.sense_id, meaning_sha256: sha256Json([target.lemma, target.gloss]) }],
  };
  const root = await mkdtemp(path.join(os.tmpdir(), 'issue-211-backfill-query-'));
  const authorityPath = 'data/validation/canonical-semantic-decision-source.json';
  let database;
  try {
    await mkdir(path.join(root, 'data/validation'), { recursive: true });
    await cp(path.join(repositoryDirectory, 'data/canonical'), path.join(root, 'data/canonical'), { recursive: true });
    await copyShardedAuthority(path.join(repositoryDirectory, authorityPath), path.join(root, authorityPath));
    for (const directory of ['data/candidates', 'data/reviews']) {
      await symlink(path.join(repositoryDirectory, directory), path.join(root, directory));
    }
    await cp(path.join(repositoryDirectory, 'data/relation-backfill'), path.join(root, 'data/relation-backfill'), { recursive: true });
    const result = await applyBackfill({ root, state, index, refreshReports: false });
    assert.equal(result.status, 'applied');
    assert.equal(result.relations_appended, 1);
    const inputDirectory = path.join(root, 'data/canonical');
    await validateCanonicalSemanticAudit(inputDirectory, undefined, path.join(root, authorityPath));
    const after = await readCanonicalRecords(inputDirectory);
    const recordsById = new Map(after.records.map(({ record }) => [record.id, record]));
    const sense = recordsById.get(source.record_id).senses.find(({ id }) => id === source.sense_id);
    assert.deepEqual(sense.relations, [...source.relations, relation]);
    const outputPath = path.join(root, 'dictionary.sqlite');
    await buildDictionary({ inputDirectory, outputPath, repositoryDirectory, allowDirty: true });
    database = new DatabaseSync(outputPath, { readOnly: true });
    assert.deepEqual(findRecordsByExactTerm(database, source.lemma).map(({ id }) => id), [source.record_id]);
    assertCanonicalSenseRelations(database, sense, recordsById);
    // The comparison still rejects omission, invented rows and tuple metadata drift.
    for (const changed of [
      { ...sense, relations: sense.relations.slice(0, -1) },
      { ...sense, relations: [...sense.relations, relation] },
      { ...sense, relations: sense.relations.map((row, position) => position === sense.relations.length - 1 ? { ...row, note: '변조', relevance: 9 } : row) },
    ]) assert.throws(() => assertCanonicalSenseRelations(database, changed, recordsById), { code: 'ERR_ASSERTION' });
  } finally {
    database?.close();
    await rm(root, { recursive: true, force: true });
  }
});
