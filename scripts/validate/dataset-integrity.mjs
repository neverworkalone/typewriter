import path from 'node:path';

import {
  DEFAULT_CANONICAL_DIRECTORY,
  ValidationError,
  readCanonicalRecords,
} from './canonical-jsonl.mjs';
import { auditCanonicalLexicalQuality } from './lexical-quality.mjs';
import {
  buildCanonicalSemanticAudit,
  buildSemanticTopicEvidence,
  readSemanticAuditArtifact,
  validateSemanticAuditCoverage,
} from './semantic-audit.mjs';

const EXPECTED_PILOT_CANDIDATE_IDS = Object.freeze(
  Array.from({ length: 300 }, (_, index) => `w${String(index + 1).padStart(3, '0')}`),
);

export class DatasetIntegrityError extends ValidationError {
  constructor(message, code = 'DATASET_INTEGRITY_ERROR') {
    super(message, code);
    this.name = 'DatasetIntegrityError';
  }
}

function displayPath(filePath) {
  const relativePath = path.relative(process.cwd(), filePath);
  if (relativePath && !relativePath.startsWith('..') && !path.isAbsolute(relativePath)) {
    return relativePath;
  }
  return filePath;
}

function sourceLocation(recordInfo, suffix = '') {
  const filePath = recordInfo.filePath ?? recordInfo.source ?? '<record>';
  const lineNumber = recordInfo.lineNumber ?? '?';
  return `${displayPath(filePath)}:${lineNumber}${suffix}`;
}

function failAt(recordInfo, message, code = 'DATASET_INTEGRITY_ERROR') {
  throw new DatasetIntegrityError(`${sourceLocation(recordInfo)}: ${message}`, code);
}

function fail(message, code = 'DATASET_INTEGRITY_ERROR') {
  throw new DatasetIntegrityError(message, code);
}

function relationLocation(recordInfo, senseIndex, relationIndex) {
  return sourceLocation(
    recordInfo,
    `: senses[${senseIndex}].relations[${relationIndex}]`,
  );
}

function relationKey(relation) {
  return JSON.stringify({
    target: relation.target,
    target_sense: relation.target_sense ?? null,
    type: relation.type,
    note: relation.note,
  });
}

function indexRecords(recordInfos) {
  const recordsById = new Map();
  const sensesById = new Map();
  const candidatesById = new Map();

  for (const recordInfo of recordInfos) {
    const { record } = recordInfo;

    if (recordsById.has(record.id)) {
      failAt(
        recordInfo,
        `duplicate record id ${record.id}; first seen at ${sourceLocation(
          recordsById.get(record.id),
        )}`,
        'DUPLICATE_RECORD_ID',
      );
    }
    recordsById.set(record.id, recordInfo);

    if (Object.hasOwn(record, 'candidate_id')) {
      if (candidatesById.has(record.candidate_id)) {
        failAt(
          recordInfo,
          `duplicate candidate_id ${record.candidate_id}; first seen at ${sourceLocation(
            candidatesById.get(record.candidate_id),
          )}`,
          'DUPLICATE_CANDIDATE_ID',
        );
      }
      candidatesById.set(record.candidate_id, recordInfo);
    }

    for (const [senseIndex, sense] of record.senses.entries()) {
      if (sensesById.has(sense.id)) {
        failAt(
          recordInfo,
          `duplicate sense id ${sense.id}; first seen at ${sourceLocation(
            sensesById.get(sense.id).recordInfo,
          )}`,
          'DUPLICATE_SENSE_ID',
        );
      }

      if (!sense.id.startsWith(`${record.id}-`)) {
        failAt(
          recordInfo,
          `sense ${sense.id} does not belong to record ${record.id} (senses[${senseIndex}])`,
          'SENSE_RECORD_MISMATCH',
        );
      }

      sensesById.set(sense.id, { recordInfo, sense, senseIndex });
    }
  }

  return { recordsById, sensesById, candidatesById };
}

function validateRoleIdentity(recordInfos) {
  for (const recordInfo of recordInfos) {
    const { record } = recordInfo;

    if (record.role === 'start') {
      if (!record.id.startsWith('w')) {
        failAt(
          recordInfo,
          `role start requires a candidate record id beginning with w (received ${record.id})`,
          'START_RECORD_ID',
        );
      }

      if (!Object.hasOwn(record, 'candidate_id')) {
        failAt(
          recordInfo,
          'role start requires candidate_id equal to the record id',
          'START_CANDIDATE_MISSING',
        );
      }

      if (record.candidate_id !== record.id) {
        failAt(
          recordInfo,
          `role start candidate_id ${record.candidate_id} must equal record id ${record.id}`,
          'START_CANDIDATE_MISMATCH',
        );
      }
    }

    if (record.role === 'reference-only' && record.id.startsWith('r')) {
      if (Object.hasOwn(record, 'candidate_id')) {
        failAt(
          recordInfo,
          `pure reference-only record ${record.id} must not have candidate_id`,
          'REFERENCE_CANDIDATE_FORBIDDEN',
        );
      }
    }
  }
}

function validateRelations(recordInfos, indexes) {
  for (const sourceInfo of recordInfos) {
    const { record } = sourceInfo;

    for (const [senseIndex, sense] of record.senses.entries()) {
      const seenRelations = new Set();

      for (const [relationIndex, relation] of (sense.relations ?? []).entries()) {
        const location = relationLocation(sourceInfo, senseIndex, relationIndex);
        const key = relationKey(relation);

        if (seenRelations.has(key)) {
          throw new DatasetIntegrityError(
            `${location}: duplicate relation in source sense ${sense.id}`,
            'DUPLICATE_RELATION',
          );
        }
        seenRelations.add(key);

        const targetInfo = indexes.recordsById.get(relation.target);
        if (!targetInfo) {
          throw new DatasetIntegrityError(
            `${location}: relation target record ${relation.target} does not exist`,
            'MISSING_TARGET_RECORD',
          );
        }

        if (relation.target === record.id) {
          throw new DatasetIntegrityError(
            `${location}: self-reference to source record ${record.id} is not allowed`,
            'SELF_REFERENCE',
          );
        }

        if (Object.hasOwn(relation, 'target_sense')) {
          const targetSenseInfo = indexes.sensesById.get(relation.target_sense);
          if (!targetSenseInfo) {
            throw new DatasetIntegrityError(
              `${location}: relation target_sense ${relation.target_sense} does not exist`,
              'MISSING_TARGET_SENSE',
            );
          }

          if (targetSenseInfo.recordInfo.record.id !== targetInfo.record.id) {
            throw new DatasetIntegrityError(
              `${location}: target_sense ${relation.target_sense} belongs to record ${targetSenseInfo.recordInfo.record.id}, not ${relation.target}`,
              'TARGET_SENSE_RECORD_MISMATCH',
            );
          }
        }

        if (relation.type === 'action') {
          if (!Object.hasOwn(relation, 'target_sense')) {
            throw new DatasetIntegrityError(
              `${location}: action relation requires target_sense to verify the target part of speech`,
              'ACTION_TARGET_SENSE_MISSING',
            );
          }

          const targetSenseInfo = indexes.sensesById.get(relation.target_sense);
          if (!['verb', 'expression'].includes(targetSenseInfo.sense.pos)) {
            throw new DatasetIntegrityError(
              `${location}: action target_sense ${relation.target_sense} has pos ${targetSenseInfo.sense.pos}; expected verb or expression`,
              'ACTION_TARGET_POS',
            );
          }
        }
      }
    }
  }
}

export function validatePilotCompleteness(recordInfos) {
  const startsByCandidateId = new Map();

  for (const recordInfo of recordInfos) {
    if (recordInfo.record.role !== 'start') {
      continue;
    }

    const candidateId = recordInfo.record.candidate_id;
    const existing = startsByCandidateId.get(candidateId) ?? [];
    existing.push(recordInfo);
    startsByCandidateId.set(candidateId, existing);
  }

  const missing = EXPECTED_PILOT_CANDIDATE_IDS.filter(
    (candidateId) => !startsByCandidateId.has(candidateId),
  );
  const duplicated = EXPECTED_PILOT_CANDIDATE_IDS.filter(
    (candidateId) => (startsByCandidateId.get(candidateId)?.length ?? 0) > 1,
  );
  if (missing.length || duplicated.length) {
    const details = [];
    if (missing.length) {
      details.push(`missing start candidate(s): ${missing.join(', ')}`);
    }
    if (duplicated.length) {
      details.push(`duplicated start candidate(s): ${duplicated.join(', ')}`);
    }
    fail(
      `pilot completeness regression failed (${details.join('; ')})`,
      'PILOT_COMPLETENESS',
    );
  }
}

export function validateDatasetRecords(
  recordInfos,
  {
    checkPilotCompleteness = false,
    semanticAudit,
    requireSemanticAudit = false,
    semanticAuditBaseRecords,
    requireDecisionSource = true,
    requireTopicAnalysis = true,
  } = {},
) {
  const indexes = indexRecords(recordInfos);
  validateRoleIdentity(recordInfos);
  validateRelations(recordInfos, indexes);

  let topicEvidence;
  if (requireSemanticAudit) {
    if (semanticAudit === undefined) {
      fail('complete canonical validation requires semantic-audit coverage', 'SEMANTIC_AUDIT_REQUIRED');
    }
    try {
      validateSemanticAuditCoverage(recordInfos, semanticAudit, {
        baseRecords: semanticAuditBaseRecords,
        label: 'complete canonical semantic audit',
        requireDecisionSource,
        requireTopicAnalysis,
      });
    } catch (error) {
      fail(error.message, error.code);
    }
    try {
      topicEvidence = buildSemanticTopicEvidence(recordInfos, semanticAudit, {
        label: 'complete canonical semantic audit',
        requireTopicAnalysis,
      });
    } catch (error) {
      fail(error.message, error.code);
    }
  } else if (semanticAudit !== undefined) {
    try {
      topicEvidence = buildSemanticTopicEvidence(recordInfos, semanticAudit, {
        label: 'semantic audit',
        requireTopicAnalysis,
      });
    } catch (error) {
      fail(error.message, error.code);
    }
  }

  // The canonical directory is the product boundary.  Every record already
  // in the dictionary, every changed record, and every prospective import must
  // pass the same lexical-quality audit; batch-specific validators may add
  // arithmetic or authorization rules but cannot bypass this call.
  const lexicalQuality = auditCanonicalLexicalQuality(recordInfos, {
    scope: 'complete-canonical',
    throwOnError: false,
    topicEvidence,
  });
  if (lexicalQuality.blocking_finding_count > 0) {
    const finding = lexicalQuality.blocking_findings[0];
    const recordInfo = recordInfos.find(
      (candidate) => (candidate.record ?? candidate)?.id === finding.record_id,
    );
    if (recordInfo) {
      failAt(recordInfo, finding.message, finding.code);
    }
    fail(finding.message, finding.code);
  }

  if (checkPilotCompleteness) {
    validatePilotCompleteness(recordInfos);
  }

  return indexes;
}

export async function validateDatasetDirectory(
  directory = DEFAULT_CANONICAL_DIRECTORY,
  options = {},
) {
  const result = await readCanonicalRecords(directory);
  const isDefaultCanonical = path.resolve(directory) === path.resolve(DEFAULT_CANONICAL_DIRECTORY);
  const requireSemanticAudit = options.requireSemanticAudit ?? isDefaultCanonical;
  let semanticAudit = options.semanticAudit;
  if (requireSemanticAudit && semanticAudit === undefined) {
    if (options.semanticAuditPath) {
      semanticAudit = await readSemanticAuditArtifact(options.semanticAuditPath);
    } else if (isDefaultCanonical) {
      ({ artifact: semanticAudit } = await buildCanonicalSemanticAudit({
        canonicalDirectory: directory,
      }));
    } else {
      fail('complete canonical validation requires semantic-audit coverage', 'SEMANTIC_AUDIT_REQUIRED');
    }
  }
  const indexes = validateDatasetRecords(result.records, {
    ...options,
    semanticAudit,
    requireSemanticAudit,
  });
  const senseCount = result.records.reduce(
    (count, recordInfo) => count + recordInfo.record.senses.length,
    0,
  );
  const relationCount = result.records.reduce(
    (count, recordInfo) =>
      count +
      recordInfo.record.senses.reduce(
        (senseCountForRecord, sense) =>
          senseCountForRecord + (sense.relations?.length ?? 0),
        0,
      ),
    0,
  );

  return {
    fileCount: result.fileCount,
    recordCount: result.records.length,
    senseCount,
    relationCount,
    candidateCount: indexes.candidatesById.size,
  };
}

export async function main() {
  const checkPilotCompleteness = !process.argv.includes('--no-pilot-regression');
  const summary = await validateDatasetDirectory(DEFAULT_CANONICAL_DIRECTORY, {
    checkPilotCompleteness,
  });
  console.log(
    `Validated dataset: ${summary.fileCount} file(s) / ${summary.recordCount} record(s) / ${summary.senseCount} sense(s) / ${summary.relationCount} relation(s).`,
  );
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname)) {
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
