import { fileURLToPath } from 'node:url';
import path from 'node:path';

const INPUT_FIELDS = new Set([
  'checkpoint_target',
  'canonical_count_at_start',
  'canonical_count_now',
  'batches_processed',
  'candidate_yield',
  'defect_classes',
  'source_exhausted',
  'blocker',
]);
const CANDIDATE_COUNT_FIELDS = [
  'selected_count',
  'admitted_count',
  'held_count',
  'rejected_count',
];
const BLOCKERS = new Set(['product-model', 'licensing']);

function requireCount(value, label) {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new TypeError(`${label} must be a non-negative safe integer.`);
  }
  return value;
}

function requireObject(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError(`${label} must be an object.`);
  }
  return value;
}

export function buildM9ProductionProgress(inputValue) {
  const input = requireObject(inputValue, 'Progress input');
  const unexpectedFields = Object.keys(input).filter((key) => !INPUT_FIELDS.has(key));
  if (unexpectedFields.length > 0) {
    throw new TypeError(`Progress input contains unsupported fields: ${unexpectedFields.sort().join(', ')}.`);
  }

  const checkpointTarget = requireCount(input.checkpoint_target, 'checkpoint_target');
  const canonicalCountAtStart = requireCount(
    input.canonical_count_at_start,
    'canonical_count_at_start',
  );
  const canonicalCountNow = requireCount(input.canonical_count_now, 'canonical_count_now');
  const batchesProcessed = requireCount(input.batches_processed, 'batches_processed');
  if (canonicalCountNow < canonicalCountAtStart) {
    throw new RangeError('canonical_count_now cannot be below canonical_count_at_start during scale production.');
  }

  const candidateYield = requireObject(input.candidate_yield, 'candidate_yield');
  const unexpectedCandidateFields = Object.keys(candidateYield)
    .filter((key) => !CANDIDATE_COUNT_FIELDS.includes(key));
  if (unexpectedCandidateFields.length > 0) {
    throw new TypeError(`candidate_yield contains unsupported fields: ${unexpectedCandidateFields.sort().join(', ')}.`);
  }
  const candidates = Object.fromEntries(CANDIDATE_COUNT_FIELDS.map((field) => [
    field,
    requireCount(candidateYield[field], `candidate_yield.${field}`),
  ]));
  const disposedCount = candidates.admitted_count + candidates.held_count + candidates.rejected_count;
  if (!Number.isSafeInteger(disposedCount) || disposedCount !== candidates.selected_count) {
    throw new RangeError('candidate_yield.selected_count must equal admitted, held, and rejected counts combined.');
  }

  if (!Array.isArray(input.defect_classes)
    || input.defect_classes.some((value) => typeof value !== 'string' || value.trim().length === 0)) {
    throw new TypeError('defect_classes must be an array of non-empty strings.');
  }
  const defectClasses = [...new Set(input.defect_classes)].sort();
  const sourceExhausted = input.source_exhausted ?? false;
  if (typeof sourceExhausted !== 'boolean') {
    throw new TypeError('source_exhausted must be a boolean.');
  }
  const blocker = input.blocker ?? null;
  if (blocker !== null && !BLOCKERS.has(blocker)) {
    throw new TypeError('blocker must be null, "product-model", or "licensing".');
  }

  let stopReason = null;
  if (defectClasses.length > 0) stopReason = 'systemic-defect';
  else if (blocker !== null) stopReason = 'product-or-licensing-blocker';
  else if (canonicalCountNow >= checkpointTarget) stopReason = 'checkpoint-reached';
  else if (sourceExhausted) stopReason = 'source-exhaustion';

  return {
    schema_version: 1,
    checkpoint_target: checkpointTarget,
    canonical_count_at_start: canonicalCountAtStart,
    canonical_count_now: canonicalCountNow,
    net_admitted_this_run: canonicalCountNow - canonicalCountAtStart,
    remaining_to_checkpoint: Math.max(checkpointTarget - canonicalCountNow, 0),
    batches_processed: batchesProcessed,
    candidate_yield: candidates,
    defect_classes: defectClasses,
    blocker,
    continuation_required: stopReason === null,
    stop_reason: stopReason,
  };
}

async function main() {
  if (process.stdin.isTTY) {
    throw new Error('Provide one JSON progress input on stdin.');
  }
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk));
  const source = Buffer.concat(chunks).toString('utf8');
  if (!source.trim()) throw new Error('Progress input on stdin is empty.');
  const input = JSON.parse(source);
  process.stdout.write(`${JSON.stringify(buildM9ProductionProgress(input), null, 2)}\n`);
}

const isMainModule = process.argv[1]
  && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));

if (isMainModule) {
  main().catch((error) => {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  });
}
