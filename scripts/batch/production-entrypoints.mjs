// Declared registry of scripts that can write canonical lexical records (issue #251).
// `tests/production-entrypoints.test.mjs` scans scripts/ and fails when a writer
// exists that is not declared here, so a new unchecked production path cannot
// appear silently.
export const ACTIVE_PRODUCTION_ENTRYPOINTS = Object.freeze({
  'scripts/batch/build-issue-223-corpus-batch.mjs': 'Corpus batch builder (B05+). Batches from INTAKE_HANDOFF_FIRST_BATCH require the shared intake hand-off.',
  'scripts/factory/admission.mjs': 'Lexical Factory Stage 3 canonical writer; accepts only a source-bound ready review, writes deterministic entry/sense mappings, and records its admission provenance.',
});

// Historical, batch-specific pipelines. Each writes a fixed, already-completed
// batch's artifact (constant output path, no batch-id argument) and is re-verified
// by its own validator; none can admit a new batch.
export const HISTORICAL_ENTRYPOINTS = Object.freeze({
  'scripts/batch/m5-12a-pipeline.mjs': 'm5-12a-expansion.jsonl',
  'scripts/batch/m5-13-pipeline.mjs': 'm5-13-expansion.jsonl',
  'scripts/batch/m5-14-pipeline.mjs': 'm5-14-expansion.jsonl',
  'scripts/batch/m5-15-pipeline.mjs': 'm5-15-expansion.jsonl',
  'scripts/batch/promote-m5-11.mjs': 'm5-11 promotion (fixed batch)',
});

// Best-effort static tripwire (the authoritative control is the data-level
// baseline gate in validate-issue-223: any record outside a validated batch import
// changes the baseline digest, whatever wrote it). Detects a write whose arguments
// name canonical data directly, via the import path, or via an identifier that was
// assigned from an expression naming canonical data. Writes into temporary
// verification copies are ignored.
// Writes into temporary trees/copies (temp, tmp, temporary...) are not production writes.
const TEMP_TREE = /(?:^|[^A-Za-z])(?:temp|tmp)/iu;
const TEMP_OR_READ = /(?:^|[^A-Za-z])(?:temp|tmp)|await|read|JSON|map\(|filter\(/iu;
const WRITE_CALL = '(?:writeFile|writeFileSync|appendFile|appendFileSync|rename|renameSync|copyFile|copyFileSync|cp|cpSync|createWriteStream)';

export function writesCanonical(source) {
  const aliases = new Set(['importPath']);
  for (const [, name, expression] of source.matchAll(/(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*([^;]*?);/gu)) {
    // Only path-like aliases (not values read from canonical data).
    if (/canonical/iu.test(expression) && !TEMP_OR_READ.test(expression)) aliases.add(name);
  }
  const names = [...aliases].map((name) => name.replace(/\$/gu, '\\$'));
  const pattern = new RegExp(`${WRITE_CALL}\\(([^;]*?)\\)`, 'gu');
  return [...source.matchAll(pattern)].some(([, args]) => {
    if (TEMP_TREE.test(args)) return false;
    return /canonical/iu.test(args) || names.some((name) => new RegExp(`(?:^|[^\\w$.])${name}(?![\\w$])`, 'u').test(args));
  });
}

// Scripts that mention canonical data and write files, but whose write targets are
// manifests, audits, reports, metrics or inventories (checked by their write
// targets), not canonical records. Records they could not legitimately add are
// still caught by the data-level baseline gate in validate-issue-223.
export const DERIVED_ARTIFACT_WRITERS = Object.freeze([
  'scripts/batch/build-m5-10a-wave-a2-stage.mjs',
  'scripts/batch/derive-metrics.mjs',
  'scripts/batch/refresh-m5-11-derived-evidence.mjs',
  'scripts/relation/backfill-queue-cli.mjs',
  'scripts/validate/build-semantic-audit.mjs',
  'scripts/validate/canonical-context.mjs',
  'scripts/validate/rebuild-semantic-evidence.mjs',
]);
