import assert from 'node:assert/strict';
import { access } from 'node:fs/promises';
import test from 'node:test';

import { M5_13_CATALOG } from '../scripts/batch/m5-13-catalog.mjs';
import {
  buildM513CandidateRecords,
  M5_13_CANDIDATE_IDENTITIES,
} from '../scripts/batch/m5-13-candidate-source.mjs';
import {
  buildM513DecisionSource,
  candidateRecordsFromM513DecisionSource,
  readM513DecisionSource,
  validateM513DecisionSource,
} from '../scripts/batch/m5-13-decision-source.mjs';
import {
  M5_13_FINAL_SUMMARY,
  M5_13_TARGET,
  validateM513Final,
} from '../scripts/batch/m5-13-pipeline.mjs';
import {
  M513ValidationError,
  validateM513Catalog,
} from '../scripts/batch/validate-m5-13.mjs';
import { readCanonicalRecords } from '../scripts/validate/canonical-jsonl.mjs';
import {
  validateBulkGlossProjection,
  validateLexicalRecord,
} from '../scripts/validate/lexical-quality.mjs';

test('M5-13 binds all 1,100 capacity slots to shared source identities', () => {
  assert.equal(M5_13_CATALOG.length, M5_13_TARGET.selection_slot_count);
  assert.equal(M5_13_CANDIDATE_IDENTITIES.length, 1100);
  assert.equal(new Set(M5_13_CANDIDATE_IDENTITIES.map(({ inventory_id: id }) => id)).size, 1100);
  assert.equal(new Set(M5_13_CANDIDATE_IDENTITIES.map(({ candidate_record_id: id }) => id)).size, 1100);
  const first = M5_13_CANDIDATE_IDENTITIES.at(0);
  assert.deepEqual(
    {
      catalog_index: first.catalog_index,
      slot_id: first.slot_id,
      inventory_id: first.inventory_id,
      candidate_record_id: first.candidate_record_id,
      lemma: first.lemma,
      axis: first.axis,
      flags: first.flags,
      record_type: first.record_type,
      pos: first.pos,
      source_kind: first.source_kind,
    },
    {
      catalog_index: 0,
      slot_id: 'm5-13-slot-0001',
      inventory_id: 'm5-2001',
      candidate_record_id: 'w2081',
      lemma: '기대에서 읽는 문턱',
      axis: 'E',
      flags: ['mood-range'],
      record_type: 'entry',
      pos: 'noun',
      source_kind: 'typewriter-authored-composition',
    },
  );
  assert.equal(first.source_basis.composition_pattern, 'root-reading-focus');
});

test('M5-13 rejects a catalog row that smuggles an unbound inventory target', () => {
  const driftedCatalog = M5_13_CATALOG.map((entry, index) => (
    index === 0 ? { ...entry, inventory_id: 'm5-9999' } : entry
  ));

  assert.throws(
    () => validateM513Catalog(driftedCatalog),
    (error) => error instanceof M513ValidationError && error.code === 'CATALOG_SHAPE_ERROR',
  );
});

test('M5-13 shared producer emits a collision-free, quality-valid 1,100-record pool', async () => {
  const base = (await readCanonicalRecords('data/batches/m5-13-base-canonical')).records;
  const ownedTerms = new Set(base.flatMap(({ record }) => [record.lemma, ...record.search_forms]));
  const identities = M5_13_CANDIDATE_IDENTITIES;
  const candidates = buildM513CandidateRecords(identities);

  assert.equal(candidates.length, 1100);
  assert.equal(identities.filter(({ lemma }) => ownedTerms.has(lemma)).length, 0);
  for (const [index, candidate] of candidates.entries()) {
    validateLexicalRecord(candidate, {
      label: `M5-13 candidate ${identities[index].inventory_id}`,
      mode: 'candidate',
      expectedId: identities[index].candidate_record_id,
      expectedLemma: identities[index].lemma,
    });
  }
  validateBulkGlossProjection(
    candidates.map((record, index) => ({
      record,
      source: 'm5-13-test',
      filePath: 'm5-13-test',
      lineNumber: index + 1,
    })),
    { maxOccurrences: 3 },
  );
});

test('M5-13 durable decision source selects 1,000 and defers the 100-row reserve', async () => {
  const durable = await readM513DecisionSource();
  const generated = buildM513DecisionSource();
  assert.deepEqual(durable.sourceBytes, generated.bytes);
  const candidates = candidateRecordsFromM513DecisionSource(durable.source);
  const source = validateM513DecisionSource({
    source: durable.source,
    sourceBytes: durable.sourceBytes,
    identities: M5_13_CANDIDATE_IDENTITIES,
    candidateRecords: candidates,
  });
  const counts = Object.fromEntries(
    ['included', 'corrected', 'held', 'rejected', 'deferred']
      .map((decision) => [decision, source.rows.filter((row) => row.decision === decision).length]),
  );
  assert.deepEqual(counts, {
    included: 1000,
    corrected: 0,
    held: 0,
    rejected: 0,
    deferred: 100,
  });
  assert.equal(source.source.selection.capacity, 1100);
  assert.equal(source.source.selection.imported, 1000);
  assert.equal(source.source.selection.reserve, 100);
});

const promotionExists = await access('data/batches/m5-13-promotion.json')
  .then(() => true)
  .catch(() => false);

test('M5-13 final promotion preserves exact counts and complete audit', {
  skip: !promotionExists,
}, async () => {
  const result = await validateM513Final();
  assert.deepEqual(result.current, M5_13_FINAL_SUMMARY);
  assert.equal(result.gate.gate_status, 'pass');
  assert.equal(result.semantic_audit.coverage_complete, true);
  assert.equal(result.semantic_audit.review_complete, true);
});
