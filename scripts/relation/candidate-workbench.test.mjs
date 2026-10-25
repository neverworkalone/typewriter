import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  exportPendingCandidateReviews,
  exportPendingCandidateExploration,
  inspectCanonicalRecord,
  markCandidateSensesExplored,
  markCandidateReviews,
  mergeCandidateBatch,
  prepareCandidateBatch,
  removeCandidate,
  saveCandidateChunk,
  updateCandidateSense,
} from './candidate-workbench.mjs';

async function setup(t) {
  const repositoryDirectory = await mkdtemp(path.join(tmpdir(), 'typewriter-candidate-workbench-'));
  t.after(() => rm(repositoryDirectory, { recursive: true, force: true }));
  const canonicalDirectory = path.join(repositoryDirectory, 'data/canonical');
  const scratchDirectory = path.join(repositoryDirectory, '.warroom-scratch/001_01_b_codex');
  await mkdir(canonicalDirectory, { recursive: true });
  const canonicalPath = path.join(canonicalDirectory, 'stdict-0001.jsonl');
  const canonicalRows = Array.from({ length: 500 }, (_, index) => ({
    id: `w${String(index + 1).padStart(3, '0')}`,
    record_type: 'entry',
    role: 'start',
    lemma: `표제어 ${index + 1}`,
    search_forms: [`표제어 ${index + 1}`],
    senses: index === 0
      ? [
          { id: 'w001-s1', pos: 'noun', gloss: '첫 번째 뜻.' },
          { id: 'w001-s2', pos: 'noun', gloss: '두 번째 뜻.', semantic_note: '전체 원문 필드 보존' },
        ]
      : [{ id: `w${String(index + 1).padStart(3, '0')}-s1`, pos: 'noun', gloss: `뜻 ${index + 1}.` }],
    source: 'stdict',
  }));
  const writeCanonical = async () => writeFile(canonicalPath, `${canonicalRows.map((row) => JSON.stringify(row)).join('\n')}\n`);
  await writeCanonical();
  return { repositoryDirectory, scratchDirectory, canonicalPath, canonicalRows, writeCanonical };
}

async function prepare(context, chunkSize = 25) {
  return prepareCandidateBatch({
    shard: '001',
    batch: '01',
    method: 'b',
    model: 'codex',
    scratchDirectory: context.scratchDirectory,
    chunkSize,
    repositoryDirectory: context.repositoryDirectory,
  });
}

function candidateRows(sourceRows, candidatesBySense = {}) {
  return sourceRows.map((record) => ({
    record_id: record.id,
    senses: record.senses.map((sense) => ({
      sense_id: sense.id,
      candidates: candidatesBySense[sense.id] ?? [],
    })),
  }));
}

async function saveInput(context, rows, name = 'chunk-result.jsonl') {
  const inputPath = path.join(context.scratchDirectory, name);
  await mkdir(context.scratchDirectory, { recursive: true });
  await writeFile(inputPath, `${rows.map((row) => JSON.stringify(row)).join('\n')}\n`);
  return inputPath;
}

async function markAllPending(context, status, name = 'review-receipts.jsonl') {
  const outPath = path.join(context.scratchDirectory, 'review-pending.jsonl');
  await exportPendingCandidateReviews({
    scratchDirectory: context.scratchDirectory,
    outPath,
    replace: true,
    repositoryDirectory: context.repositoryDirectory,
  });
  const exported = (await readFile(outPath, 'utf8')).trim().split('\n').filter(Boolean).map((line) => JSON.parse(line));
  const receipts = exported.flatMap((row) => row.review.map((sense) => ({
    record_id: row.canonical_record.id,
    sense_id: sense.sense_id,
    reviewed_candidates: sense.candidates,
  })));
  const inputPath = await saveInput(context, receipts, name);
  const result = await markCandidateReviews({ scratchDirectory: context.scratchDirectory, inputPath, repositoryDirectory: context.repositoryDirectory });
  assert.equal(result.status.reviewedCount, status.candidateCount);
  assert.equal(result.status.pendingReviewCount, 0);
  return result.status;
}

async function completeEmptyChunks(context, prepared, completedChunkNumbers = []) {
  const completed = new Set(completedChunkNumbers);
  for (const chunk of prepared.chunks) {
    if (completed.has(chunk.number)) continue;
    const sourcePath = path.join(prepared.chunkDirectory, chunk.file);
    const sourceRows = (await readFile(sourcePath, 'utf8')).trim().split('\n').map((line) => JSON.parse(line));
    const inputPath = await saveInput(context, candidateRows(sourceRows), `empty-chunk-${chunk.number}.jsonl`);
    await saveCandidateChunk({
      scratchDirectory: context.scratchDirectory,
      chunk: chunk.number,
      inputPath,
      repositoryDirectory: context.repositoryDirectory,
    });
  }
}

test('prepare preserves full Canonical rows and creates bounded chunks with explicit IDs', async (t) => {
  const context = await setup(t);
  const prepared = await prepare(context, 25);
  assert.equal(prepared.status.recordCount, 500);
  assert.equal(prepared.status.senseCount, 501);
  assert.equal(prepared.status.chunkCount, 20);
  assert.equal(prepared.status.incompleteSenseCount, 501);
  assert.equal(prepared.status.incompleteChunkCount, 20);
  assert.equal(prepared.chunks[0].firstRecord, 1);
  assert.equal(prepared.chunks[0].lastRecord, 25);
  assert.equal(prepared.chunks[0].recordCount, 25);
  assert.equal(prepared.chunks[0].senseCount, 26);

  const chunkPath = path.join(prepared.chunkDirectory, prepared.chunks[0].file);
  const savedSourceRows = (await readFile(chunkPath, 'utf8')).trim().split('\n').map((line) => JSON.parse(line));
  assert.deepEqual(savedSourceRows, context.canonicalRows.slice(0, 25));
  assert.equal(savedSourceRows[0].senses[1].semantic_note, '전체 원문 필드 보존');
  assert.equal(savedSourceRows[0].source, 'stdict');

  const resumed = await prepare(context, 25);
  assert.equal(resumed.sourceChanged, false);
  assert.equal(resumed.status.candidateCount, 0);
  await assert.rejects(
    mergeCandidateBatch({ scratchDirectory: context.scratchDirectory, outPath: path.join(context.scratchDirectory, 'incomplete.jsonl'), repositoryDirectory: context.repositoryDirectory }),
    /candidate output is not saved for chunk\(s\) 001/u,
  );
  await assert.rejects(prepare(context, 24), /checkpoint uses 25-record chunks/u);
  const invalidSizeContext = await setup(t);
  await assert.rejects(prepare(invalidSizeContext, 24), /chunk-size must be an integer from 25 to 50/u);
});

test('save-chunk rejects cross-record/sense attachment and incomplete boundaries without changing checkpoint', async (t) => {
  const context = await setup(t);
  const prepared = await prepare(context);
  const checkpointPath = prepared.checkpointPath;
  const originalCheckpoint = await readFile(checkpointPath, 'utf8');
  const firstChunkPath = path.join(prepared.chunkDirectory, prepared.chunks[0].file);
  const firstRows = (await readFile(firstChunkPath, 'utf8')).trim().split('\n').map((line) => JSON.parse(line));

  const wrongSense = candidateRows(firstRows);
  wrongSense[1].senses[0].sense_id = 'w001-s1';
  const wrongSensePath = await saveInput(context, wrongSense, 'wrong-sense.jsonl');
  await assert.rejects(
    saveCandidateChunk({ scratchDirectory: context.scratchDirectory, chunk: 1, inputPath: wrongSensePath, repositoryDirectory: context.repositoryDirectory }),
    /sense_id mismatch for record_id w002; missing: w002-s1; unexpected: w001-s1/u,
  );
  assert.equal(await readFile(checkpointPath, 'utf8'), originalCheckpoint);

  const missingRecordPath = await saveInput(context, candidateRows(firstRows.slice(0, 24)), 'missing-record.jsonl');
  await assert.rejects(
    saveCandidateChunk({ scratchDirectory: context.scratchDirectory, chunk: 1, inputPath: missingRecordPath, repositoryDirectory: context.repositoryDirectory }),
    /record_id mismatch; missing: w025/u,
  );
  assert.equal(await readFile(checkpointPath, 'utf8'), originalCheckpoint);

  const missingSense = candidateRows(firstRows);
  missingSense[0].senses.pop();
  const missingSensePath = await saveInput(context, missingSense, 'missing-sense.jsonl');
  await assert.rejects(
    saveCandidateChunk({ scratchDirectory: context.scratchDirectory, chunk: 1, inputPath: missingSensePath, repositoryDirectory: context.repositoryDirectory }),
    /sense_id mismatch for record_id w001; missing: w001-s2; unexpected: none/u,
  );
  assert.equal(await readFile(checkpointPath, 'utf8'), originalCheckpoint);

  const duplicateCandidate = candidateRows(firstRows, { 'w001-s1': ['별빛', '별빛'] });
  const duplicatePath = await saveInput(context, duplicateCandidate, 'duplicate-candidate.jsonl');
  await assert.rejects(
    saveCandidateChunk({ scratchDirectory: context.scratchDirectory, chunk: 1, inputPath: duplicatePath, repositoryDirectory: context.repositoryDirectory }),
    /duplicates candidate "별빛" for record_id w001 sense_id w001-s1/u,
  );
  assert.equal(await readFile(checkpointPath, 'utf8'), originalCheckpoint);
});

test('saving a resumed chunk adds discoveries without dropping previously saved candidates', async (t) => {
  const context = await setup(t);
  const prepared = await prepare(context);
  const chunkPath = path.join(prepared.chunkDirectory, prepared.chunks[0].file);
  const sourceRows = (await readFile(chunkPath, 'utf8')).trim().split('\n').map((line) => JSON.parse(line));

  const firstInput = await saveInput(context, candidateRows(sourceRows, { 'w001-s1': ['별빛'] }), 'first-pass.jsonl');
  await saveCandidateChunk({ scratchDirectory: context.scratchDirectory, chunk: 1, inputPath: firstInput, repositoryDirectory: context.repositoryDirectory });
  const resumedInput = await saveInput(context, candidateRows(sourceRows, { 'w001-s1': ['달빛'] }), 'resumed-pass.jsonl');
  const resumed = await saveCandidateChunk({ scratchDirectory: context.scratchDirectory, chunk: 1, inputPath: resumedInput, repositoryDirectory: context.repositoryDirectory });
  assert.equal(resumed.status.candidateCount, 2);
  assert.equal(resumed.status.incompleteChunkCount, 19);

  const checkpoint = JSON.parse(await readFile(prepared.checkpointPath, 'utf8'));
  assert.deepEqual(checkpoint.records[0].senses[0].candidates, ['별빛', '달빛']);
  assert.equal(checkpoint.records[0].senses[0].explored_fingerprint.length, 64);
});

test('prepare stops on Canonical sense membership changes and preserves the old checkpoint', async (t) => {
  const context = await setup(t);
  const prepared = await prepare(context);
  const chunkPath = path.join(prepared.chunkDirectory, prepared.chunks[0].file);
  const sourceRows = (await readFile(chunkPath, 'utf8')).trim().split('\n').map((line) => JSON.parse(line));
  const inputPath = await saveInput(context, candidateRows(sourceRows, { 'w001-s1': ['별빛'] }), 'membership-seed.jsonl');
  await saveCandidateChunk({ scratchDirectory: context.scratchDirectory, chunk: 1, inputPath, repositoryDirectory: context.repositoryDirectory });
  const checkpointBefore = await readFile(prepared.checkpointPath, 'utf8');
  const chunkBefore = await readFile(chunkPath, 'utf8');

  context.canonicalRows[0].senses.push({ id: 'w001-s3', pos: 'noun', gloss: '새로운 뜻.' });
  await context.writeCanonical();
  await assert.rejects(
    prepare(context),
    /Canonical sense membership changed for record_id w001; missing sense_id\(s\): none; new sense_id\(s\): w001-s3/u,
  );
  assert.equal(await readFile(prepared.checkpointPath, 'utf8'), checkpointBefore);
  assert.equal(await readFile(chunkPath, 'utf8'), chunkBefore);
});

test('review receipts are tied to exact candidate and source sense; only changed meaning becomes stale', async (t) => {
  const context = await setup(t);
  const prepared = await prepare(context);
  const firstChunkPath = path.join(prepared.chunkDirectory, prepared.chunks[0].file);
  const firstRows = (await readFile(firstChunkPath, 'utf8')).trim().split('\n').map((line) => JSON.parse(line));
  const inputPath = await saveInput(context, candidateRows(firstRows, { 'w001-s1': ['별빛', '은하수'] }), 'initial-candidates.jsonl');
  const saved = await saveCandidateChunk({ scratchDirectory: context.scratchDirectory, chunk: 1, inputPath, repositoryDirectory: context.repositoryDirectory });
  assert.equal(saved.status.candidateCount, 2);
  assert.equal(saved.status.pendingReviewCount, 2);
  await completeEmptyChunks(context, prepared, [1]);

  const resumed = await prepare(context);
  assert.equal(resumed.status.candidateCount, 2);
  assert.equal(resumed.status.pendingReviewCount, 2);
  assert.equal(resumed.status.incompleteChunkCount, 0);

  await assert.rejects(
    mergeCandidateBatch({ scratchDirectory: context.scratchDirectory, outPath: path.join(context.scratchDirectory, 'not-ready.jsonl'), repositoryDirectory: context.repositoryDirectory }),
    /2 candidate\(s\) need AI meaning\/form review/u,
  );

  const pendingPath = path.join(context.scratchDirectory, 'pending.jsonl');
  const pending = await exportPendingCandidateReviews({ scratchDirectory: context.scratchDirectory, outPath: pendingPath, repositoryDirectory: context.repositoryDirectory });
  assert.equal(pending.candidateCount, 2);
  const exportedRows = (await readFile(pendingPath, 'utf8')).trim().split('\n').map((line) => JSON.parse(line));
  assert.equal(exportedRows.length, 1);
  assert.deepEqual(exportedRows[0].canonical_record.senses, [context.canonicalRows[0].senses[0]]);

  let status = await markAllPending(context, saved.status);
  assert.equal(status.reviewedCount, 2);
  assert.equal(status.staleReviewCount, 0);

  const editedInput = await saveInput(context, candidateRows(firstRows, { 'w001-s1': ['별빛', '은하수빛'] }), 'edited-candidates.jsonl');
  const edited = await saveCandidateChunk({ scratchDirectory: context.scratchDirectory, chunk: 1, inputPath: editedInput, repositoryDirectory: context.repositoryDirectory });
  assert.equal(edited.status.candidateCount, 3);
  assert.equal(edited.status.reviewedCount, 2);
  assert.equal(edited.status.pendingReviewCount, 1);

  context.canonicalRows[0].senses[0].gloss = '밤하늘의 빛나는 별.';
  context.canonicalRows[0].senses[1].gloss = '두 번째 뜻의 갱신.';
  await context.writeCanonical();
  const refreshed = await prepare(context);
  assert.equal(refreshed.sourceChanged, true);
  assert.equal(refreshed.status.candidateCount, 3);
  assert.equal(refreshed.status.staleReviewCount, 2);
  assert.equal(refreshed.status.pendingReviewCount, 1);
  assert.equal(refreshed.status.reviewedCount, 0);
  assert.equal(refreshed.status.staleSenseCount, 2);

  const refreshedPendingPath = path.join(context.scratchDirectory, 'pending-after-source-change.jsonl');
  await exportPendingCandidateReviews({ scratchDirectory: context.scratchDirectory, outPath: refreshedPendingPath, repositoryDirectory: context.repositoryDirectory });
  const refreshedPending = (await readFile(refreshedPendingPath, 'utf8')).trim().split('\n').map((line) => JSON.parse(line));
  assert.deepEqual(refreshedPending[0].review[0].candidates, ['별빛', '은하수', '은하수빛']);
  status = await markAllPending(context, refreshed.status, 'refreshed-receipts.jsonl');
  assert.equal(status.reviewedCount, 3);
  assert.equal(status.pendingReviewCount, 0);
  assert.equal(status.staleReviewCount, 0);

  const explorationPath = path.join(context.scratchDirectory, 'exploration-pending.jsonl');
  const exploration = await exportPendingCandidateExploration({
    scratchDirectory: context.scratchDirectory,
    outPath: explorationPath,
    repositoryDirectory: context.repositoryDirectory,
  });
  assert.equal(exploration.senseCount, 2);
  const explorationRows = (await readFile(explorationPath, 'utf8')).trim().split('\n').map((line) => JSON.parse(line));
  assert.equal(explorationRows[0].senses[0].status, 'STALE');
  assert.deepEqual(explorationRows[0].senses[0].current_candidates, ['별빛', '은하수', '은하수빛']);
  assert.equal(explorationRows[0].senses[1].status, 'STALE');
  assert.deepEqual(explorationRows[0].senses[1].current_candidates, []);
  const exploredPath = await saveInput(context, [
    { record_id: 'w001', sense_id: 'w001-s1' },
    { record_id: 'w001', sense_id: 'w001-s2' },
  ], 're-explored-sense.jsonl');
  const markedExplored = await markCandidateSensesExplored({ scratchDirectory: context.scratchDirectory, inputPath: exploredPath, repositoryDirectory: context.repositoryDirectory });
  assert.equal(markedExplored.status.staleSenseCount, 0);
  assert.equal(markedExplored.status.incompleteSenseCount, 0);
});

test('patch-sense rechecks only changed candidates and preserves peer senses and records', async (t) => {
  const context = await setup(t);
  const prepared = await prepare(context);
  const firstChunkPath = path.join(prepared.chunkDirectory, prepared.chunks[0].file);
  const firstRows = (await readFile(firstChunkPath, 'utf8')).trim().split('\n').map((line) => JSON.parse(line));
  const inputPath = await saveInput(context, candidateRows(firstRows, {
    'w001-s1': ['별빛'],
    'w001-s2': ['밤공기'],
    'w002-s1': ['산들바람'],
  }), 'patch-seed.jsonl');
  const saved = await saveCandidateChunk({ scratchDirectory: context.scratchDirectory, chunk: 1, inputPath, repositoryDirectory: context.repositoryDirectory });
  await markAllPending(context, saved.status);
  await completeEmptyChunks(context, prepared, [1]);

  const patched = await updateCandidateSense({
    scratchDirectory: context.scratchDirectory,
    recordId: 'w001',
    senseId: 'w001-s1',
    candidates: ['별빛', '달빛'],
    repositoryDirectory: context.repositoryDirectory,
  });
  assert.equal(patched.status.candidateCount, 4);
  assert.equal(patched.status.reviewedCount, 3);
  assert.equal(patched.status.pendingReviewCount, 1);
  assert.deepEqual(patched.status, {
    shard: '001', batch: '01', recordCount: 500, senseCount: 501,
    candidateCount: 4, emptySenseCount: 498, reviewedCount: 3,
    pendingReviewCount: 1, staleReviewCount: 0, chunkCount: 20,
    exploredSenseCount: 501, incompleteSenseCount: 0, staleSenseCount: 0,
    completedChunkCount: 20, incompleteChunkCount: 0,
  });

  const pendingPath = path.join(context.scratchDirectory, 'patch-pending.jsonl');
  const pending = await exportPendingCandidateReviews({ scratchDirectory: context.scratchDirectory, outPath: pendingPath, repositoryDirectory: context.repositoryDirectory });
  assert.equal(pending.candidateCount, 1);
  const pendingRows = (await readFile(pendingPath, 'utf8')).trim().split('\n').map((line) => JSON.parse(line));
  assert.deepEqual(pendingRows[0].review, [{ sense_id: 'w001-s1', candidates: ['달빛'] }]);

  const checkpointPath = prepared.checkpointPath;
  const beforeInvalidPatch = await readFile(checkpointPath, 'utf8');
  await assert.rejects(
    updateCandidateSense({
      scratchDirectory: context.scratchDirectory,
      recordId: 'w002',
      senseId: 'w001-s1',
      candidates: ['잘못된 매핑'],
      repositoryDirectory: context.repositoryDirectory,
    }),
    /unknown record_id w002 \/ sense_id w001-s1/u,
  );
  assert.equal(await readFile(checkpointPath, 'utf8'), beforeInvalidPatch);
});

test('candidate removal requires a current review and an explicit ineligible judgment', async (t) => {
  const context = await setup(t);
  const prepared = await prepare(context);
  const firstChunkPath = path.join(prepared.chunkDirectory, prepared.chunks[0].file);
  const firstRows = (await readFile(firstChunkPath, 'utf8')).trim().split('\n').map((line) => JSON.parse(line));
  const inputPath = await saveInput(context, candidateRows(firstRows, { 'w001-s1': ['별빛'] }), 'removal-candidate.jsonl');
  const saved = await saveCandidateChunk({ scratchDirectory: context.scratchDirectory, chunk: 1, inputPath, repositoryDirectory: context.repositoryDirectory });
  await completeEmptyChunks(context, prepared, [1]);

  await assert.rejects(
    removeCandidate({ scratchDirectory: context.scratchDirectory, recordId: 'w001', senseId: 'w001-s1', candidate: '별빛', confirmedIneligible: true, repositoryDirectory: context.repositoryDirectory }),
    /needs a current AI meaning\/form review before removal/u,
  );
  await markAllPending(context, saved.status);
  await assert.rejects(
    removeCandidate({ scratchDirectory: context.scratchDirectory, recordId: 'w001', senseId: 'w001-s1', candidate: '별빛', confirmedIneligible: false, repositoryDirectory: context.repositoryDirectory }),
    /requires confirmedIneligible=true/u,
  );

  const removed = await removeCandidate({
    scratchDirectory: context.scratchDirectory,
    recordId: 'w001',
    senseId: 'w001-s1',
    candidate: '별빛',
    confirmedIneligible: true,
    repositoryDirectory: context.repositoryDirectory,
  });
  assert.equal(removed.removed, '별빛');
  assert.equal(removed.status.candidateCount, 0);
  assert.equal(removed.status.completedChunkCount, 20);
  const outputPath = path.join(context.scratchDirectory, 'after-removal.jsonl');
  const merged = await mergeCandidateBatch({ scratchDirectory: context.scratchDirectory, outPath: outputPath, repositoryDirectory: context.repositoryDirectory });
  assert.equal(merged.validation.candidateCount, 0);
});

test('merge emits canonical record/sense order and validates the complete Candidate v1 batch', async (t) => {
  const context = await setup(t);
  const prepared = await prepare(context, 25);
  const firstChunkPath = path.join(prepared.chunkDirectory, prepared.chunks[0].file);
  const firstRows = (await readFile(firstChunkPath, 'utf8')).trim().split('\n').map((line) => JSON.parse(line));
  const inputPath = await saveInput(context, candidateRows(firstRows, { 'w001-s1': ['별빛'], 'w002-s1': ['산들바람'] }), 'merge-input.jsonl');
  const saved = await saveCandidateChunk({ scratchDirectory: context.scratchDirectory, chunk: 1, inputPath, repositoryDirectory: context.repositoryDirectory });
  await completeEmptyChunks(context, prepared, [1]);
  await markAllPending(context, saved.status);

  const outPath = path.join(context.scratchDirectory, 'merged-candidates.jsonl');
  const merged = await mergeCandidateBatch({ scratchDirectory: context.scratchDirectory, outPath, repositoryDirectory: context.repositoryDirectory });
  assert.deepEqual(merged.validation, {
    recordCount: 500,
    senseCount: 501,
    candidateCount: 2,
    emptySenseCount: 499,
  });
  const outputRows = (await readFile(outPath, 'utf8')).trim().split('\n').map((line) => JSON.parse(line));
  assert.equal(outputRows.length, 500);
  assert.deepEqual(outputRows.slice(0, 2).map((row) => row.record_id), ['w001', 'w002']);
  assert.deepEqual(outputRows[0].senses.map((sense) => sense.sense_id), ['w001-s1', 'w001-s2']);
  assert.deepEqual(outputRows[0].senses[0].candidates, ['별빛']);
  assert.deepEqual(outputRows[1].senses[0].candidates, ['산들바람']);
});

test('partial final-shard batch keeps its 83-record boundary and can be fully merged', async (t) => {
  const repositoryDirectory = await mkdtemp(path.join(tmpdir(), 'typewriter-candidate-workbench-tail-'));
  t.after(() => rm(repositoryDirectory, { recursive: true, force: true }));
  const canonicalDirectory = path.join(repositoryDirectory, 'data/canonical');
  const scratchDirectory = path.join(repositoryDirectory, '.warroom-scratch/428_02_b_codex');
  await mkdir(canonicalDirectory, { recursive: true });
  const canonicalRows = Array.from({ length: 583 }, (_, index) => ({
    id: `tail-${index + 1}`,
    lemma: `꼬리 표제어 ${index + 1}`,
    senses: [{ id: `tail-${index + 1}-s1`, pos: 'noun', gloss: `꼬리 뜻 ${index + 1}.` }],
    source: 'stdict',
  }));
  await writeFile(path.join(canonicalDirectory, 'stdict-0428.jsonl'), `${canonicalRows.map((row) => JSON.stringify(row)).join('\n')}\n`);
  const prepared = await prepareCandidateBatch({
    shard: '428', batch: '02', method: 'b', model: 'codex', scratchDirectory, repositoryDirectory,
  });
  assert.equal(prepared.status.recordCount, 83);
  assert.equal(prepared.status.chunkCount, 4);
  assert.equal(prepared.chunks[0].firstRecord, 501);
  assert.equal(prepared.chunks.at(-1).firstRecord, 576);
  assert.equal(prepared.chunks.at(-1).lastRecord, 583);
  assert.equal(prepared.chunks.at(-1).senseCount, 8);

  const finalChunk = prepared.chunks.at(-1);
  const finalChunkPath = path.join(prepared.chunkDirectory, finalChunk.file);
  const finalChunkRows = (await readFile(finalChunkPath, 'utf8')).trim().split('\n').map((line) => JSON.parse(line));
  const inputPath = path.join(scratchDirectory, 'tail-candidates.jsonl');
  await writeFile(inputPath, `${candidateRows(finalChunkRows, { 'tail-576-s1': ['별빛'] }).map((row) => JSON.stringify(row)).join('\n')}\n`);
  const saved = await saveCandidateChunk({ scratchDirectory, chunk: finalChunk.number, inputPath, repositoryDirectory });
  await completeEmptyChunks({ scratchDirectory, repositoryDirectory }, prepared, [finalChunk.number]);
  const receipts = [{ record_id: 'tail-576', sense_id: 'tail-576-s1', reviewed_candidates: ['별빛'] }];
  const receiptPath = path.join(scratchDirectory, 'tail-receipts.jsonl');
  await writeFile(receiptPath, `${JSON.stringify(receipts[0])}\n`);
  const marked = await markCandidateReviews({ scratchDirectory, inputPath: receiptPath, repositoryDirectory });
  assert.equal(marked.status.reviewedCount, 1);
  assert.equal(saved.status.pendingReviewCount, 1);

  const outputPath = path.join(scratchDirectory, 'tail-final.jsonl');
  const merged = await mergeCandidateBatch({ scratchDirectory, outPath: outputPath, repositoryDirectory });
  assert.deepEqual(merged.validation, { recordCount: 83, senseCount: 83, candidateCount: 1, emptySenseCount: 82 });
  const mergedRows = (await readFile(outputPath, 'utf8')).trim().split('\n').map((line) => JSON.parse(line));
  assert.equal(mergedRows[0].record_id, 'tail-501');
  assert.equal(mergedRows.at(-1).record_id, 'tail-583');
  assert.deepEqual(mergedRows[75].senses[0].candidates, ['별빛']);
});

test('inspect returns the complete Canonical record without truncating its senses', async (t) => {
  const context = await setup(t);
  const inspected = await inspectCanonicalRecord({ shard: '001', recordId: 'w001', repositoryDirectory: context.repositoryDirectory });
  assert.equal(inspected.record.id, 'w001');
  assert.deepEqual(inspected.record.senses, context.canonicalRows[0].senses);
  assert.equal(inspected.record.senses[1].semantic_note, '전체 원문 필드 보존');
});

test('merge rejects Candidate v1 violations and does not create a partial output', async (t) => {
  const context = await setup(t);
  const prepared = await prepare(context);
  const firstChunkPath = path.join(prepared.chunkDirectory, prepared.chunks[0].file);
  const firstRows = (await readFile(firstChunkPath, 'utf8')).trim().split('\n').map((line) => JSON.parse(line));
  const inputPath = await saveInput(context, candidateRows(firstRows, { 'w001-s1': ['표제어 1'] }), 'invalid-self-lemma.jsonl');
  const saved = await saveCandidateChunk({ scratchDirectory: context.scratchDirectory, chunk: 1, inputPath, repositoryDirectory: context.repositoryDirectory });
  await completeEmptyChunks(context, prepared, [1]);
  await markAllPending(context, saved.status);

  const outputPath = path.join(context.scratchDirectory, 'must-not-exist.jsonl');
  await assert.rejects(
    mergeCandidateBatch({ scratchDirectory: context.scratchDirectory, outPath: outputPath, repositoryDirectory: context.repositoryDirectory }),
    /candidate repeats source lemma "표제어 1"/u,
  );
  await assert.rejects(readFile(outputPath, 'utf8'), { code: 'ENOENT' });
});
