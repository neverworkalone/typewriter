import path from 'node:path';

import {
  DEFAULT_CANONICAL_DIRECTORY,
  ValidationError,
} from './canonical-jsonl.mjs';
import {
  createCanonicalContext,
  loadCanonicalContext,
} from './canonical-context.mjs';
import { auditCanonicalLexicalQuality } from './lexical-quality.mjs';
import {
  buildCanonicalSemanticAudit,
  buildSemanticTopicEvidence,
  readSemanticAuditArtifact,
  validateSemanticAuditCoverage,
} from './semantic-audit.mjs';
import {
  buildSurfaceFormProjection,
  loadSurfaceFormExceptionManifestSync,
  loadSurfaceFormReviewManifestSync,
} from '../inflection/surface-form-projection.mjs';

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

function indexRecords(recordInfos, context) {
  const indexes = context?.records === recordInfos
    ? context.indexes
    : createCanonicalContext({ records: recordInfos }).indexes;

  for (const issue of indexes.issues ?? []) {
    if (issue.kind === 'duplicate-record-id') {
      failAt(
        issue.recordInfo,
        `duplicate record id ${issue.recordId}; first seen at ${sourceLocation(
          issue.firstRecordInfo,
        )}`,
        'DUPLICATE_RECORD_ID',
      );
    }

    if (issue.kind === 'duplicate-candidate-id') {
      failAt(
        issue.recordInfo,
        `duplicate candidate_id ${issue.candidateId}; first seen at ${sourceLocation(
          issue.firstRecordInfo,
        )}`,
        'DUPLICATE_CANDIDATE_ID',
      );
    }

    if (issue.kind === 'duplicate-sense-id') {
      failAt(
        issue.recordInfo,
        `duplicate sense id ${issue.senseId}; first seen at ${sourceLocation(
          issue.firstSenseInfo.recordInfo,
        )}`,
        'DUPLICATE_SENSE_ID',
      );
    }

    if (issue.kind === 'sense-record-mismatch') {
      failAt(
        issue.recordInfo,
        `sense ${issue.sense.id} does not belong to record ${issue.recordId} (senses[${issue.senseIndex}])`,
        'SENSE_RECORD_MISMATCH',
      );
    }
  }

  return indexes;
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
      const indexedRelationEntries = indexes.relationsBySourceSenseId.get(sense.id);
      const relationEntryIndexes = indexedRelationEntries === undefined
        ? []
        : Array.isArray(indexedRelationEntries)
          ? indexedRelationEntries
          : [indexedRelationEntries];

      for (const relationEntryIndex of relationEntryIndexes) {
        const relationIndex = indexes.relations[relationEntryIndex].relationIndex;
        const relation = sense.relations[relationIndex];
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
    context,
    checkPilotCompleteness = false,
    semanticAudit,
    requireSemanticAudit = false,
    semanticAuditBaseRecords,
    requireDecisionSource = true,
    requireTopicAnalysis = true,
    lexicalQuality,
    requireSurfaceFormProjection = false,
    requireSurfaceFormClassifications,
    requireSurfaceFormCollisionReview,
  } = {},
) {
  if (context && !context.derived) context.derived = {};
  const indexes = indexRecords(recordInfos, context);
  validateRoleIdentity(recordInfos);
  validateRelations(recordInfos, indexes);

  const isDefaultCanonicalDirectory = context?.canonicalDirectory
    && path.resolve(context.canonicalDirectory) === path.resolve(DEFAULT_CANONICAL_DIRECTORY);
  // Apply the shared admission invariant to the full canonical corpus. Small
  // validator fixtures often reuse canonical IDs for unrelated records, so
  // they can opt in explicitly without inheriting the production exception map.
  const isCompleteCanonicalScale = recordInfos.length >= 5_000;
  if (requireSurfaceFormProjection || isDefaultCanonicalDirectory || isCompleteCanonicalScale) {
    try {
      const exceptionManifest = context?.derived?.surfaceFormExceptionManifest
        ?? loadSurfaceFormExceptionManifestSync();
      if (context) context.derived.surfaceFormExceptionManifest = exceptionManifest;
      const requireExceptionTargets = Boolean(isDefaultCanonicalDirectory);
      const requireClassDispositions = requireSurfaceFormClassifications
        ?? (requireSurfaceFormProjection || isDefaultCanonicalDirectory || isCompleteCanonicalScale);
      const requireCollisionReview = requireSurfaceFormCollisionReview
        ?? requireClassDispositions;
      const reviewManifest = context?.derived?.surfaceFormReviewManifest
        ?? (requireClassDispositions ? loadSurfaceFormReviewManifestSync() : undefined);
      if (context && reviewManifest) context.derived.surfaceFormReviewManifest = reviewManifest;
      const surfaceProjection = buildSurfaceFormProjection(recordInfos, {
        exceptionManifest,
        reviewManifest,
        requireExceptionTargets,
        requireClassDispositions,
        requireCollisionReview,
      });
      if (context) context.derived.surfaceFormProjection = surfaceProjection;
    } catch (error) {
      fail(error.message, error.code ?? 'SURFACE_FORM_PROJECTION_INVALID');
    }
  }

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
        hashCache: context?.semanticAuditCache,
      });
    } catch (error) {
      fail(error.message, error.code);
    }
    if (context?.derived?.topicEvidence && context.semanticAudit === semanticAudit) {
      topicEvidence = context.derived.topicEvidence;
    } else {
      try {
        topicEvidence = buildSemanticTopicEvidence(recordInfos, semanticAudit, {
          label: 'complete canonical semantic audit',
          requireTopicAnalysis,
          hashCache: context?.semanticAuditCache,
        });
      } catch (error) {
        fail(error.message, error.code);
      }
    }
  } else if (semanticAudit !== undefined) {
    if (context?.derived?.topicEvidence && context.semanticAudit === semanticAudit) {
      topicEvidence = context.derived.topicEvidence;
    } else {
      try {
        topicEvidence = buildSemanticTopicEvidence(recordInfos, semanticAudit, {
          label: 'semantic audit',
          requireTopicAnalysis,
          hashCache: context?.semanticAuditCache,
        });
      } catch (error) {
        fail(error.message, error.code);
      }
    }
  }
  if (context && topicEvidence && !context.derived.topicEvidence) {
    context.derived.topicEvidence = topicEvidence;
  }

  // The canonical directory is the product boundary.  Every record already
  // in the dictionary, every changed record, and every prospective import must
  // pass the same lexical-quality audit; batch-specific validators may add
  // arithmetic or authorization rules but cannot bypass this call.
  const lexicalReport = lexicalQuality ?? context?.derived?.lexicalQuality
    ?? auditCanonicalLexicalQuality(recordInfos, {
      scope: 'complete-canonical',
      throwOnError: false,
      topicEvidence: topicEvidence ?? context?.derived?.topicEvidence,
      context,
    });
  if (context && !context.derived.lexicalQuality) {
    context.derived.lexicalQuality = lexicalReport;
  }
  if (lexicalReport.blocking_finding_count > 0) {
    const finding = lexicalReport.blocking_findings[0];
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
  const context = options.canonicalContext
    ?? options.context
    ?? await loadCanonicalContext({ directory });
  const result = context;
  const isDefaultCanonical = path.resolve(directory) === path.resolve(DEFAULT_CANONICAL_DIRECTORY);
  const requireSemanticAudit = options.requireSemanticAudit ?? isDefaultCanonical;
  let semanticAudit = options.semanticAudit ?? context.semanticAudit;
  if (requireSemanticAudit && semanticAudit === undefined) {
    if (options.semanticAuditPath) {
      semanticAudit = await readSemanticAuditArtifact(options.semanticAuditPath);
    } else if (isDefaultCanonical) {
      ({ artifact: semanticAudit } = await buildCanonicalSemanticAudit({
        canonicalDirectory: directory,
        canonicalContext: context,
      }));
    } else {
      fail('complete canonical validation requires semantic-audit coverage', 'SEMANTIC_AUDIT_REQUIRED');
    }
  }
  const indexes = validateDatasetRecords(result.records, {
    ...options,
    context,
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
