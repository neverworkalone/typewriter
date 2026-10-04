import assert from 'node:assert/strict';
import { readFile, readdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';

import { B16, STEM, buildB16, tree } from '../scripts/intake/integration/b16-tree.mjs';
import { assertCanonicalOnlyFromReviewedBatches, makeBaseline } from '../scripts/batch/canonical-batch-baseline.mjs';
import { assertCanonicalImportsReviewed, classifyCandidateReview, verifyBatchIntakeArtifacts } from '../scripts/batch/validate-issue-223.mjs';

// These regressions call the SAME shared functions validate-issue-223.mjs runs on every
// tracked batch (classification before any early continue, canonical-import review check,
// intake artifact verification). They never start the complete-canonical validator;
// that single end-to-end run is the manual integration script (see docs).
const review = (ordinal, status) => ({ batch_id: `issue-223-m9-e-corpus-batch-${String(ordinal).padStart(2, '0')}-20261004`, ...(status ? { canonical_import_status: status } : {}) });

test('review-only is a B05-only exception, decided before any early continue', () => {
  assert.deepEqual(classifyCandidateReview(review(5, 'owner-deferred-review-only')), { ordinal: 5, reviewOnly: true });
  assert.deepEqual(classifyCandidateReview(review(15)), { ordinal: 15, reviewOnly: false });
  assert.deepEqual(classifyCandidateReview(review(16)), { ordinal: 16, reviewOnly: false });
  for (const ordinal of [4, 6, 15, 16, 40]) assert.throws(() => classifyCandidateReview(review(ordinal, 'owner-deferred-review-only')), /only B05/u);
  assert.throws(() => classifyCandidateReview(review(16, 'something-else')), /unsupported canonical import status/u);
});

test('a canonical import of a batch that needs the intake hand-off must have a reviewed candidate review', () => {
  const reviews = ['issue-223-m9-e-corpus-batch-15-candidate-review.json'];
  assert.equal(assertCanonicalImportsReviewed(['issue-223-m9-e-corpus-batch-15.jsonl', 'pilot.jsonl', 'm5-9-expansion.jsonl'], reviews), true);
  assert.throws(() => assertCanonicalImportsReviewed(['issue-223-m9-e-corpus-batch-16.jsonl'], reviews), /canonical import without a reviewed/u);
  assert.throws(() => assertCanonicalImportsReviewed(['issue-223-m9-e-corpus-batch-16-20261004.jsonl'], reviews), /canonical import without a reviewed/u);
  assert.equal(assertCanonicalImportsReviewed(['issue-223-m9-e-corpus-batch-16.jsonl'], [...reviews, 'issue-223-m9-e-corpus-batch-16-candidate-review.json']), true);
});

test('a normal B16 builds through the real CLIs and builder, and its artifacts pass the shared intake verification; bypasses fail', { timeout: 300000 }, async () => {
  const temp = await tree();
  try {
    const build = await buildB16(temp);
    // Old bypass: B16 without --intake-handoff is refused by the real builder.
    await assert.rejects(build.withoutHandoff(), (error) => /INTAKE_HANDOFF_REQUIRED/u.test(error.stderr));
    const built = await build.withHandoff();
    assert.equal(built.canonical_import_count, 2);

    const read = (name) => readFile(path.join(temp, 'data/batches', `${STEM}-${name}`));
    const candidateReview = JSON.parse((await read('candidate-review.json')).toString('utf8'));
    const semanticInputBytes = await read('semantic-review-input.json');
    const handoffBytes = await read('intake-handoff.json');
    const check = (overrides = {}) => verifyBatchIntakeArtifacts({ candidateReview, semanticInputBytes, handoffBytes, label: B16, ...overrides });

    assert.equal(check(), true);
    // Missing hand-off, missing integration block, tampered hand-off bytes: all refused.
    assert.throws(() => check({ handoffBytes: null }), (error) => error.code === 'INTAKE_HANDOFF_REQUIRED');
    const noBlock = JSON.parse(semanticInputBytes.toString('utf8'));
    delete noBlock.intake_handoff;
    assert.throws(() => check({ semanticInputBytes: Buffer.from(JSON.stringify(noBlock)) }), (error) => error.code === 'INTAKE_HANDOFF_REQUIRED');
    const tampered = JSON.parse(handoffBytes.toString('utf8'));
    tampered.entries[0].duplicate_count += 1;
    assert.throws(() => check({ handoffBytes: Buffer.from(JSON.stringify(tampered)) }), (error) => error.code?.startsWith('INTAKE_HANDOFF'));
    // A candidate review row without the recorded source holds cannot vouch for the hand-off.
    const stripped = structuredClone(candidateReview);
    delete stripped.decisions[0].intake_source_holds;
    assert.throws(() => check({ candidateReview: stripped }), (error) => error.code === 'INTAKE_HANDOFF_HOLD_ORIGIN');

    // Data-level gate on the produced tree: the B16 import is a validated batch; anything else is refused.
    const { readCanonicalRecords } = await import('../scripts/validate/canonical-jsonl.mjs');
    const batchFiles = (await readdir(path.join(temp, 'data/canonical'))).filter((name) => /^issue-223-m9-e-corpus-batch-\d+\.jsonl$/u.test(name));
    const importsOf = async (names) => (await Promise.all(names.map(async (name) => (await readFile(path.join(temp, 'data/canonical', name), 'utf8')).split('\n').filter(Boolean).map((line) => JSON.parse(line))))).flat();
    const before = await readCanonicalRecords(path.join(temp, 'data/canonical'));
    const b16Records = await importsOf([`${STEM}.jsonl`]);
    const imports = await importsOf(batchFiles);
    const baseline = makeBaseline({ canonicalRecords: before.records, batchImportRecords: imports, throughBatch: 16 });
    const gate = (records, batchRecords) => assertCanonicalOnlyFromReviewedBatches({ canonicalRecords: records, batchImportRecords: batchRecords, baseline });
    assert.equal(gate(before.records, imports), true);
    assert.ok(b16Records.length === 2 && imports.some((record) => record.id === b16Records[0].id));
    const injected = { id: 'w99999', record_type: 'entry', role: 'start', candidate_id: 'w99999', lemma: '시험삼음말', search_forms: ['시험삼음말'], senses: [{ id: 'w99999-s1', pos: 'noun', gloss: '시험으로 끼워 넣은 말.' }] };
    assert.throws(() => gate([...before.records, injected], imports), (error) => error.code === 'CANONICAL_RECORD_OUTSIDE_REVIEWED_BATCH');
    await writeFile(path.join(temp, 'data/canonical/zz-anything.jsonl'), `${JSON.stringify(injected)}\n`);
    const afterFile = await readCanonicalRecords(path.join(temp, 'data/canonical'));
    assert.throws(() => gate(afterFile.records, imports), (error) => error.code === 'CANONICAL_RECORD_OUTSIDE_REVIEWED_BATCH');
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});
