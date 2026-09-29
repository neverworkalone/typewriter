import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

import { buildDictionary } from '../scripts/build/dictionary.mjs';
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
  const outputDirectory = await mkdtemp(path.join(os.tmpdir(), 'typewriter-issue-211-search-'));
  const outputPath = path.join(outputDirectory, 'dictionary.sqlite');
  await buildDictionary({
    inputDirectory: DEFAULT_CANONICAL_DIRECTORY,
    outputPath,
    checkPilotCompleteness: true,
    allowDirty: true,
    repositoryDirectory,
  });
  return {
    database: new DatabaseSync(outputPath, { readOnly: true }),
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
  const firstInventoryNumber = Math.max(...baseSeedTargets.map(({ inventory_id: id }) => (
    Number(id.match(/^m5-(\d+)$/u)?.[1] ?? 0)
  ))) + 1;
  const firstCanonicalNumber = Math.max(...baseRecords.map(({ record }) => (
    Number(record.id.match(/^w(\d+)$/u)?.[1] ?? 0)
  ))) + 1;
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

test('Issue #211 admissions resolve exact writer queries without relations', async () => {
  const admittedRecords = parseJsonl(await readFile(admittedRecordsPath));
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
        assert.deepEqual(getSenseRelations(opened.database, sense.id), [], `${record.lemma}/${sense.id} has no invented relation`);
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
      assert.deepEqual(record.senses.flatMap(({ id }) => getSenseRelations(opened.database, id)), []);
    }

    assert.deepEqual(findRecordsByExactTerm(opened.database, '내다'), [], 'the unresolved-sense candidate remains held');
  } finally {
    opened.database.close();
    await rm(opened.outputDirectory, { recursive: true, force: true });
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
