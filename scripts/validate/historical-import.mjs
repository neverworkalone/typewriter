import { readFile } from 'node:fs/promises';

import { DEFAULT_CANONICAL_DIRECTORY, readCanonicalRecords } from './canonical-jsonl.mjs';
import { loadCanonicalBeforeFactoryAdmissions, sha256Json } from './semantic-audit.mjs';

/**
 * Bytes of a historical batch import file as they were when that batch was admitted. Later factory
 * admissions append senses to such records, so historical fixtures and validators must not bind the
 * live file; each line whose record is still exactly the live canonical record is rewound through
 * the bound admission ledger, every other line is kept byte for byte.
 */
export async function readImportBytesBeforeFactoryAdmissions(filePath, { canonicalDirectory = DEFAULT_CANONICAL_DIRECTORY, decisionSourcePath } = {}) {
  const bytes = await readFile(filePath);
  const live = await readCanonicalRecords(canonicalDirectory);
  const before = new Map((await loadCanonicalBeforeFactoryAdmissions(live.records, { decisionSourcePath })).map((info) => [(info.record ?? info).id, info.record ?? info]));
  const current = new Map(live.records.map((info) => [(info.record ?? info).id, info.record ?? info]));
  const text = bytes.toString('utf8');
  const lines = text.split('\n');
  let changed = false;
  const restored = lines.map((line) => {
    if (!line) return line;
    const record = JSON.parse(line);
    const stored = current.get(record.id);
    if (!stored || !before.has(record.id) || sha256Json(stored) !== sha256Json(record)) return line;
    const original = before.get(record.id);
    if (sha256Json(original) === sha256Json(record)) return line;
    changed = true;
    return JSON.stringify(original);
  });
  return changed ? Buffer.from(restored.join('\n'), 'utf8') : bytes;
}
