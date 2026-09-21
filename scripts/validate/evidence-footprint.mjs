import { execFileSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT_DIRECTORY = path.dirname(fileURLToPath(import.meta.url));
const REPOSITORY_DIRECTORY = path.resolve(SCRIPT_DIRECTORY, '../..');
const DEFAULT_BASELINE = 'a5d794a';

const ARTIFACTS = [
  'data/batches/m5-12a-semantic-decisions.json',
  'data/validation/canonical-semantic-decision-source.json',
  'data/inventory/m5-target-seed.json',
  'data/inventory/m5-target-promotions.jsonl',
  'data/batches/m5-12a-admission.json',
  'data/batches/m5-12a-promotion.json',
];

function lineCount(bytes) {
  return bytes.length === 0 ? 0 : bytes.toString('utf8').split('\n').length - 1;
}

function byteCount(value) {
  return Buffer.byteLength(JSON.stringify(value), 'utf8');
}

function baselineDiff(baseline, files) {
  const output = execFileSync(
    'git',
    ['diff', '--numstat', `${baseline}^1`, baseline, '--', ...files],
    { cwd: REPOSITORY_DIRECTORY, encoding: 'utf8' },
  );
  return Object.fromEntries(output.trim().split('\n').filter(Boolean).map((line) => {
    const [additions, deletions, file] = line.split('\t');
    return [file, { additions: Number(additions), deletions: Number(deletions) }];
  }));
}

async function readArtifact(relativePath) {
  const bytes = await readFile(path.join(REPOSITORY_DIRECTORY, relativePath));
  let value;
  try {
    value = JSON.parse(bytes.toString('utf8'));
  } catch {
    value = undefined;
  }
  return {
    path: relativePath,
    bytes: bytes.length,
    lines: lineCount(bytes),
    value,
  };
}

function sourceFieldBreakdown(source) {
  const candidateBytes = byteCount(source.candidate_records);
  const decisionBytes = byteCount(source.decisions);
  const envelope = { ...source };
  delete envelope.candidate_records;
  delete envelope.decisions;
  return {
    candidate_records: {
      count: source.candidate_records.length,
      bytes: candidateBytes,
      average_bytes: Math.round(candidateBytes / source.candidate_records.length),
    },
    decisions: {
      count: source.decisions.length,
      bytes: decisionBytes,
      average_bytes: Math.round(decisionBytes / source.decisions.length),
    },
    envelope_bytes: byteCount(envelope),
  };
}

function canonicalBindingBreakdown(source) {
  const bindings = source.authored_review.records
    .map(({ authored_batch_decision: binding }) => binding)
    .filter(Boolean);
  const bytes = byteCount(bindings);
  return {
    count: bindings.length,
    bytes,
    average_bytes: bindings.length === 0 ? 0 : Math.round(bytes / bindings.length),
  };
}

async function main() {
  const baseline = process.argv.find((argument) => argument.startsWith('--baseline='))?.slice('--baseline='.length)
    ?? DEFAULT_BASELINE;
  const files = await Promise.all(ARTIFACTS.map(readArtifact));
  const source = files.find(({ path: filePath }) => filePath.endsWith('m5-12a-semantic-decisions.json')).value;
  const canonicalAuthority = files.find(({ path: filePath }) => filePath.endsWith('canonical-semantic-decision-source.json')).value;
  const ledger = files.find(({ path: filePath }) => filePath.endsWith('m5-target-promotions.jsonl'));
  const ledgerCount = ledger.lines;
  console.log(JSON.stringify({
    baseline_commit: baseline,
    baseline_diff: baselineDiff(baseline, ARTIFACTS),
    current: files.map(({ path: filePath, bytes, lines }) => ({ path: filePath, bytes, lines })),
    field_breakdown: {
      semantic_decision_source: sourceFieldBreakdown(source),
      canonical_authored_batch_binding: canonicalBindingBreakdown(canonicalAuthority),
      promotion_ledger: {
        count: ledgerCount,
        bytes: ledger.bytes,
        average_bytes: ledgerCount === 0 ? 0 : Math.round(ledger.bytes / ledgerCount),
      },
    },
  }, null, 2));
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
