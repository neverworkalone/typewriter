import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { readCanonicalRecords } from '../validate/canonical-jsonl.mjs';
import { canonicalRecordsSha256 } from '../validate/semantic-audit.mjs';
import { M5_13_CATALOG } from './m5-13-catalog.mjs';
import { M5_13_LEXICAL_UNIT_POOL } from './m5-13-lexical-units.mjs';

const REPOSITORY_DIRECTORY = path.resolve(new URL('../..', import.meta.url).pathname);
const SOURCE_PATH = path.join(REPOSITORY_DIRECTORY, 'data/batches/m5-13-lexical-unit-source.json');
const CURRENT_IMPORT = path.join(REPOSITORY_DIRECTORY, 'data/canonical/m5-13-expansion.jsonl');
const CURRENT_SEED = path.join(REPOSITORY_DIRECTORY, 'data/inventory/m5-target-seed.json');
const STAGE_PATH = path.join(REPOSITORY_DIRECTORY, 'data/batches/m5-13-stage.json');
const SOURCE_ID = 'm5-13-typewriter-authored-lexical-units-20260922-r4';

function sha256Json(value) {
  return createHash('sha256').update(JSON.stringify(value), 'utf8').digest('hex');
}

function sha256Bytes(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function git(args, { encoding } = {}) {
  return execFileSync('git', args, {
    cwd: REPOSITORY_DIRECTORY,
    encoding,
    maxBuffer: 16 * 1024 * 1024,
  });
}

function checkpointCanonicalSource(checkpointCommit) {
  const paths = git(['ls-tree', '-r', '--name-only', checkpointCommit, 'data/canonical'], { encoding: 'utf8' })
    .trim()
    .split('\n')
    .filter((relativePath) => relativePath.endsWith('.jsonl'))
    .sort();
  if (paths.length === 0) throw new Error(`M5-13 checkpoint ${checkpointCommit} has no canonical JSONL files`);

  const digest = createHash('sha256');
  const records = [];
  for (const relativePath of paths) {
    const bytes = git(['show', `${checkpointCommit}:${relativePath}`]);
    const canonicalPath = relativePath.slice('data/canonical/'.length);
    digest.update(canonicalPath, 'utf8');
    digest.update(Buffer.from([0]));
    digest.update(bytes);
    digest.update(Buffer.from([0]));
    for (const [lineIndex, line] of bytes.toString('utf8').split(/\r?\n/u).entries()) {
      if (line.trim().length === 0) continue;
      records.push({
        record: JSON.parse(line),
        source: canonicalPath,
        filePath: path.join(REPOSITORY_DIRECTORY, 'data/canonical', canonicalPath),
        lineNumber: lineIndex + 1,
      });
    }
  }
  return { digest: digest.digest('hex'), records };
}

const stage = JSON.parse(await readFile(STAGE_PATH, 'utf8'));
const checkpointCommit = stage.previous_stage?.checkpoint_commit;
const checkpointTree = stage.previous_stage?.checkpoint_tree;
if (!/^[0-9a-f]{40}$/u.test(checkpointCommit ?? '') || !/^[0-9a-f]{40}$/u.test(checkpointTree ?? '')) {
  throw new Error('M5-13 source requires a recorded predecessor checkpoint commit and tree');
}
const actualCheckpointTree = git(['rev-parse', `${checkpointCommit}^{tree}`], { encoding: 'utf8' }).trim();
if (actualCheckpointTree !== checkpointTree) {
  throw new Error(`M5-13 predecessor checkpoint tree mismatch: ${actualCheckpointTree}`);
}
const checkpoint = checkpointCanonicalSource(checkpointCommit);
const recordedCanonicalDigest = stage.source?.canonical_directory_sha256;
if (checkpoint.digest !== recordedCanonicalDigest
  || checkpoint.digest !== stage.input?.canonical_directory_sha256) {
  throw new Error('M5-13 predecessor canonical checkpoint digest does not match the recorded source authority');
}

if (M5_13_LEXICAL_UNIT_POOL.length !== M5_13_CATALOG.length) {
  throw new Error(
    `M5-13 authored lexical source has ${M5_13_LEXICAL_UNIT_POOL.length} units; catalog has ${M5_13_CATALOG.length}`,
  );
}

const seen = new Set();
for (const [index, unit] of M5_13_LEXICAL_UNIT_POOL.entries()) {
  const catalogRow = M5_13_CATALOG[index];
  if (unit.axis !== catalogRow.axis) {
    throw new Error(`M5-13 authored unit ${unit.lemma} is not bound to catalog axis ${catalogRow.axis}`);
  }
  if (typeof unit.lemma !== 'string' || unit.lemma.length === 0
    || typeof unit.writer_gloss !== 'string' || unit.writer_gloss.trim().length === 0
    || !['entry', 'expression'].includes(unit.record_type)
    || !['noun', 'verb', 'adjective', 'adverb', 'expression'].includes(unit.pos)) {
    throw new Error(`M5-13 authored unit ${index + 1} lacks unit-level identity, POS, record type, or meaning`);
  }
  if ((unit.record_type === 'expression') !== (unit.pos === 'expression')) {
    throw new Error(`M5-13 authored unit ${unit.lemma} has incompatible record type and POS`);
  }
  if (seen.has(unit.lemma)) throw new Error(`M5-13 authored source repeats lexical unit ${unit.lemma}`);
  seen.add(unit.lemma);
}

const { records } = await readCanonicalRecords(path.join(REPOSITORY_DIRECTORY, 'data/canonical'));
const baseRecords = records.filter(({ filePath }) => path.resolve(filePath) !== path.resolve(CURRENT_IMPORT));
if (canonicalRecordsSha256(baseRecords) !== canonicalRecordsSha256(checkpoint.records)) {
  throw new Error('M5-13 current base canonical records do not match the predecessor checkpoint');
}

const currentSeed = JSON.parse(await readFile(CURRENT_SEED, 'utf8'));
const candidateInventoryIds = new Set(M5_13_CATALOG.map((_, index) => (
  `m5-${String(2001 + index).padStart(4, '0')}`
)));
const baseSeed = {
  ...structuredClone(currentSeed),
  revision: 'm5-12',
  targets: currentSeed.targets.filter(({ inventory_id: inventoryId }) => !candidateInventoryIds.has(inventoryId)),
};
const baseSeedBytes = Buffer.from(`${JSON.stringify(baseSeed, null, 2)}\n`, 'utf8');
const recordedBaseSeedSha256 = stage.source?.seed_sha256;
if (sha256Bytes(baseSeedBytes) !== recordedBaseSeedSha256) {
  throw new Error('M5-13 reconstructed predecessor seed does not match the recorded source digest');
}
const baseForms = new Set([
  ...baseRecords.flatMap(({ record }) => [record.lemma, ...record.search_forms]),
  ...baseSeed.targets.flatMap(({ lemma, search_forms: searchForms }) => [lemma, ...searchForms]),
]);
const collisions = M5_13_LEXICAL_UNIT_POOL.filter(({ lemma }) => baseForms.has(lemma));
if (collisions.length > 0) {
  throw new Error(`M5-13 authored source collides with base or seed forms: ${collisions.slice(0, 8).map(({ lemma }) => lemma).join(', ')}`);
}

const units = M5_13_LEXICAL_UNIT_POOL.map((unit, index) => {
  const catalogRow = M5_13_CATALOG[index];
  return {
    source_unit_id: `m5-13-source-unit-${String(index + 1).padStart(4, '0')}`,
    lemma: unit.lemma,
    axis: unit.axis,
    flags: [...catalogRow.flags],
    record_type: unit.record_type,
    pos: unit.pos,
    source_kind: unit.record_type === 'expression'
      ? 'typewriter-authored-expression'
      : 'typewriter-authored-lexical-unit',
    writer_use: unit.writer_gloss,
    writer_gloss: unit.writer_gloss,
  };
});
const sourceWithoutDigest = {
  schema_version: '1',
  contract_version: 'lexical-candidate-source-v1',
  kind: 'typewriter-authored-lexical-unit-source',
  source_id: SOURCE_ID,
  authoring_mode: 'agent-authored-per-unit-semantic-source',
  base_canonical_records_sha256: canonicalRecordsSha256(baseRecords),
  base_seed_sha256: sha256Bytes(baseSeedBytes),
  pool_sha256: sha256Json(units.map(({ lemma, axis, record_type, pos, writer_gloss }) => ({
    lemma, axis, record_type, pos, writer_gloss,
  }))),
  candidate_count: units.length,
  units,
};
const source = {
  ...sourceWithoutDigest,
  artifact_sha256: sha256Json(sourceWithoutDigest),
};
await writeFile(SOURCE_PATH, `${JSON.stringify(source, null, 2)}\n`);
console.log(JSON.stringify({
  path: path.relative(REPOSITORY_DIRECTORY, SOURCE_PATH),
  candidate_count: units.length,
  axis_counts: Object.fromEntries([...new Set(units.map(({ axis }) => axis))]
    .map((axis) => [axis, units.filter((unit) => unit.axis === axis).length])),
  artifact_sha256: source.artifact_sha256,
}, null, 2));
