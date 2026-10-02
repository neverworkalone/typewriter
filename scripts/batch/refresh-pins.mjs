/**
 * Re-pin the checkpoint constants that two regression tests hold for the
 * current canonical revision, in one pass.
 *
 * `tests/target-inventory.test.mjs` and `tests/artifact-policy.test.mjs` assert
 * exact canonical totals, digests, and byte counts. After every admitted batch
 * those assertions fail one at a time, so a manual re-pin costs a test run per
 * constant. This command computes every pinned value from the same builders the
 * tests use and rewrites exactly those assertions. It edits only values the
 * tests already pin, fails if an assertion pattern is missing or ambiguous, and
 * leaves the assertions themselves (and their strictness) unchanged: review the
 * resulting diff like any other pin change. `--check` writes nothing and exits
 * non-zero when a pin is stale.
 *
 *   node scripts/batch/refresh-pins.mjs [--check]
 */

import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { validateTargetInventory } from '../validate/target-inventory.mjs';
import { buildTargetInventory, serializeTargetInventory } from '../inventory/generate-target-inventory.mjs';
import { buildCanonicalSemanticAudit, serializeSemanticAuditArtifact } from '../validate/semantic-audit.mjs';
import { DEFAULT_CANONICAL_DIRECTORY, readCanonicalRecords } from '../validate/canonical-jsonl.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');

function replaceOnce(text, pattern, replacement, label) {
  const matches = text.match(new RegExp(pattern.source, `${pattern.flags.replace('g', '')}g`)) ?? [];
  if (matches.length !== 1) throw new Error(`${label}: expected exactly one assertion to re-pin, found ${matches.length}`);
  return text.replace(pattern, replacement);
}

const countsBlock = (counts) => `{\n${Object.entries(counts).map(([key, value]) => `    ${key}: ${value},`).join('\n')}\n  }`;

export async function computePins() {
  const summary = await validateTargetInventory();
  const inventory = await buildTargetInventory();
  const { artifact } = await buildCanonicalSemanticAudit();
  const canonical = await readCanonicalRecords(DEFAULT_CANONICAL_DIRECTORY);
  const auditBytes = serializeSemanticAuditArtifact(artifact);
  const inventoryBytes = serializeTargetInventory(inventory);
  return {
    summary,
    inventory,
    artifact,
    canonicalRecordCount: canonical.records.length,
    auditBytes: auditBytes.length,
    auditSha: sha256(auditBytes),
    inventoryBytes: inventoryBytes.length,
    inventorySha: sha256(inventoryBytes),
  };
}

export function repinTargetInventoryTest(text, pins) {
  const { summary } = pins;
  let next = text;
  const equal = (name, value) => {
    next = replaceOnce(next, new RegExp(`^  assert\\.equal\\(summary\\.${name}, \\d+\\);`, 'mu'), `  assert.equal(summary.${name}, ${value});`, name);
  };
  equal('inventoryEntryCount', summary.inventoryEntryCount);
  equal('canonicalRecordCount', summary.canonicalRecordCount);
  equal('currentStartCount', summary.currentStartCount);
  equal('plannedStartCount', summary.plannedStartCount);
  next = replaceOnce(next, /assert\.deepEqual\(summary\.reasonCodeCounts, \{[^}]*\}\);/u,
    `assert.deepEqual(summary.reasonCodeCounts, ${countsBlock(summary.reasonCodeCounts)});`, 'reasonCodeCounts');
  next = replaceOnce(next, /assert\.deepEqual\(summary\.recordTypeCounts, \{[^}]*\}\);/u,
    `assert.deepEqual(summary.recordTypeCounts, ${countsBlock(summary.recordTypeCounts)});`, 'recordTypeCounts');
  next = replaceOnce(next, /assert\.equal\(generated\.entries\.length, \d+\);/u,
    `assert.equal(generated.entries.length, ${summary.inventoryEntryCount});`, 'generated.entries.length');
  next = replaceOnce(next, /assert\.equal\(generated\.canonical_snapshot\.record_count, \d+\);/u,
    `assert.equal(generated.canonical_snapshot.record_count, ${summary.canonicalRecordCount});`, 'generated record_count');
  next = replaceOnce(next, /assert\.equal\(canonical\.records\.length, \d+\);/u,
    `assert.equal(canonical.records.length, ${pins.canonicalRecordCount});`, 'canonical.records.length');
  return next;
}

export function repinArtifactPolicyTest(text, pins) {
  const { artifact, inventory } = pins;
  let next = text;
  const once = (pattern, replacement, label) => { next = replaceOnce(next, pattern, replacement, label); };
  once(/assert\.equal\(artifact\.record_count, \d+\);/u, `assert.equal(artifact.record_count, ${artifact.record_count});`, 'artifact.record_count');
  once(/assert\.equal\(artifact\.source\.canonical_records_sha256, '[0-9a-f]{64}'\);/u,
    `assert.equal(artifact.source.canonical_records_sha256, '${artifact.source.canonical_records_sha256}');`, 'canonical_records_sha256');
  once(/assert\.equal\(artifact\.sense_count, \d+\);/u, `assert.equal(artifact.sense_count, ${artifact.sense_count});`, 'artifact.sense_count');
  once(/assert\.equal\(semanticAuditBytes\.length, \d+\);/u, `assert.equal(semanticAuditBytes.length, ${pins.auditBytes});`, 'semanticAuditBytes.length');
  once(/assert\.equal\(sha256\(semanticAuditBytes\), '[0-9a-f]{64}'\);/u, `assert.equal(sha256(semanticAuditBytes), '${pins.auditSha}');`, 'semanticAuditBytes sha');
  once(/assert\.equal\(inventoryBytes\.length, \d+\);/u, `assert.equal(inventoryBytes.length, ${pins.inventoryBytes});`, 'inventoryBytes.length');
  once(/assert\.equal\(sha256\(inventoryBytes\), '[0-9a-f]{64}'\);/u, `assert.equal(sha256(inventoryBytes), '${pins.inventorySha}');`, 'inventoryBytes sha');
  once(/assert\.equal\(inventory\.canonical_snapshot\.record_count, \d+\);/u,
    `assert.equal(inventory.canonical_snapshot.record_count, ${inventory.canonical_snapshot.record_count});`, 'snapshot record_count');
  once(/assert\.equal\(inventory\.canonical_snapshot\.start_count, \d+\);/u,
    `assert.equal(inventory.canonical_snapshot.start_count, ${inventory.canonical_snapshot.start_count});`, 'snapshot start_count');
  return next;
}

export async function main(argv = process.argv.slice(2)) {
  const check = argv.includes('--check');
  const pins = await computePins();
  const files = [
    ['tests/target-inventory.test.mjs', repinTargetInventoryTest],
    ['tests/artifact-policy.test.mjs', repinArtifactPolicyTest],
  ];
  let stale = 0;
  for (const [relative, repin] of files) {
    const absolute = path.join(ROOT, relative);
    const before = await readFile(absolute, 'utf8');
    const after = repin(before, pins);
    if (after !== before) {
      stale += 1;
      if (!check) await writeFile(absolute, after);
    }
    console.log(`${relative}: ${after === before ? 'current' : check ? 'STALE' : 're-pinned'}`);
  }
  if (check && stale > 0) process.exitCode = 1;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
