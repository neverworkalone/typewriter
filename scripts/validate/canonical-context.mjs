import { appendFileSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';

import {
  DEFAULT_CANONICAL_DIRECTORY,
  readCanonicalRecords,
} from './canonical-jsonl.mjs';

export const CANONICAL_CONTEXT_CONTRACT_VERSION = 'canonical-context-v1';

export class CanonicalContextError extends Error {
  constructor(message, code = 'CANONICAL_CONTEXT_ERROR') {
    super(message);
    this.name = 'CanonicalContextError';
    this.code = code;
  }
}

function recordOf(recordInfoOrRecord) {
  return recordInfoOrRecord.record ?? recordInfoOrRecord;
}

function addIndex(map, key, value) {
  const existing = map.get(key);
  if (existing === undefined) {
    map.set(key, value);
  } else if (Array.isArray(existing)) {
    existing.push(value);
  } else {
    map.set(key, [existing, value]);
  }
}

function countRelations(recordInfos) {
  return recordInfos.reduce(
    (count, recordInfo) => count + recordOf(recordInfo).senses.reduce(
      (senseCount, sense) => senseCount + (sense.relations?.length ?? 0),
      0,
    ),
    0,
  );
}

function createIndexes(recordInfos) {
  const recordsById = new Map();
  const sensesById = new Map();
  const candidatesById = new Map();
  const relations = [];
  const relationsBySourceSenseId = new Map();
  const issues = [];

  for (const [recordIndex, recordInfo] of recordInfos.entries()) {
    const record = recordOf(recordInfo);

    if (recordsById.has(record.id)) {
      issues.push({
        kind: 'duplicate-record-id',
        recordInfo,
        firstRecordInfo: recordsById.get(record.id),
        recordId: record.id,
      });
    } else {
      recordsById.set(record.id, recordInfo);
    }

    if (Object.hasOwn(record, 'candidate_id')) {
      if (candidatesById.has(record.candidate_id)) {
        issues.push({
          kind: 'duplicate-candidate-id',
          recordInfo,
          firstRecordInfo: candidatesById.get(record.candidate_id),
          candidateId: record.candidate_id,
        });
      } else {
        candidatesById.set(record.candidate_id, recordInfo);
      }
    }

    for (const [senseIndex, sense] of record.senses.entries()) {
      if (sensesById.has(sense.id)) {
        issues.push({
          kind: 'duplicate-sense-id',
          recordInfo,
          firstSenseInfo: sensesById.get(sense.id),
          senseId: sense.id,
        });
      } else {
        sensesById.set(sense.id, { recordInfo, sense, senseIndex, recordIndex });
      }

      if (!sense.id.startsWith(`${record.id}-`)) {
        issues.push({
          kind: 'sense-record-mismatch',
          recordInfo,
          sense,
          senseIndex,
          recordId: record.id,
        });
      }

      for (const [relationIndex, relation] of (sense.relations ?? []).entries()) {
        const entry = {
          recordIndex,
          senseIndex,
          relationIndex,
        };
        const relationEntryIndex = relations.length;
        relations.push(entry);
        addIndex(relationsBySourceSenseId, sense.id, relationEntryIndex);
      }
    }
  }

  const stats = {
    fileCount: recordInfos.length === 0 ? 0 : undefined,
    recordCount: recordInfos.length,
    senseCount: recordInfos.reduce(
      (count, recordInfo) => count + recordOf(recordInfo).senses.length,
      0,
    ),
    relationCount: countRelations(recordInfos),
    candidateCount: candidatesById.size,
    startCount: recordInfos.filter((recordInfo) => recordOf(recordInfo).role === 'start').length,
    referenceOnlyCount: recordInfos.filter((recordInfo) => recordOf(recordInfo).role === 'reference-only').length,
    expressionCount: recordInfos.filter((recordInfo) => recordOf(recordInfo).record_type === 'expression').length,
    searchFormCount: recordInfos.reduce(
      (count, recordInfo) => count + recordOf(recordInfo).search_forms.length,
      0,
    ),
  };

  return {
    recordsById,
    sensesById,
    candidatesById,
    relations,
    relationsBySourceSenseId,
    issues,
    stats,
  };
}

function createMetrics({ fileCount, source = 'canonical-jsonl' }) {
  return {
    canonical_load_count: 1,
    canonical_parse_count: source === 'canonical-jsonl' ? 1 : 0,
    canonical_file_count: fileCount,
    canonical_index_build_count: 1,
    canonical_record_scan_count: 1,
    relation_index_build_count: 1,
    sqlite_build_count: 0,
    canonical_context_serialize_count: 0,
    canonical_context_deserialize_count: 0,
    canonical_context_rehydrate_count: 0,
  };
}

export function createCanonicalContext(
  canonical,
  {
    canonicalDirectory = DEFAULT_CANONICAL_DIRECTORY,
    source = 'canonical-jsonl',
    metrics,
  } = {},
) {
  if (!canonical || !Array.isArray(canonical.records)) {
    throw new CanonicalContextError(
      'canonical context requires a records array',
      'INVALID_CANONICAL_INPUT',
    );
  }

  const indexes = createIndexes(canonical.records);
  const context = {
    contractVersion: CANONICAL_CONTEXT_CONTRACT_VERSION,
    canonicalDirectory: path.resolve(canonicalDirectory),
    canonicalRevision: canonical.canonicalRevision ?? null,
    fileCount: canonical.fileCount ?? 0,
    records: canonical.records,
    indexes,
    statistics: {
      ...indexes.stats,
      fileCount: canonical.fileCount ?? indexes.stats.fileCount ?? 0,
    },
    metrics: metrics ?? createMetrics({
      fileCount: canonical.fileCount ?? 0,
      source,
    }),
    derived: {},
  };

  return context;
}

function serializeIndexes(context) {
  const recordIndexByInfo = new Map(
    context.records.map((recordInfo, index) => [recordInfo, index]),
  );
  const indexes = context.indexes;
  const recordEntries = [...indexes.recordsById.entries()].map(([id, recordInfo]) => [
    id,
    recordIndexByInfo.get(recordInfo),
  ]);
  const candidateEntries = [...indexes.candidatesById.entries()].map(([id, recordInfo]) => [
    id,
    recordIndexByInfo.get(recordInfo),
  ]);
  const senseEntries = [...indexes.sensesById.entries()].map(([id, value]) => [
    id,
    {
      recordIndex: recordIndexByInfo.get(value.recordInfo),
      senseIndex: value.senseIndex,
    },
  ]);
  const relationEntries = indexes.relations.map((entry) => ({
    recordIndex: entry.recordIndex,
    senseIndex: entry.senseIndex,
    relationIndex: entry.relationIndex,
  }));
  return {
    recordsById: recordEntries,
    sensesById: senseEntries,
    candidatesById: candidateEntries,
    relations: relationEntries,
    relationsBySourceSenseId: [...indexes.relationsBySourceSenseId.entries()],
    issues: indexes.issues,
    stats: indexes.stats,
  };
}

function rehydrateIndexes(records, serialized) {
  const getRecordInfo = (index) => records[index];
  const indexMap = (entries) => new Map(
    (entries ?? []).map(([key, values]) => [key, values]),
  );

  const relations = serialized.relations ?? [];
  const sensesById = new Map(
    (serialized.sensesById ?? []).map(([id, value]) => {
      const recordInfo = getRecordInfo(value.recordIndex);
      return [id, {
        recordInfo,
        recordIndex: value.recordIndex,
        sense: recordOf(recordInfo).senses[value.senseIndex],
        senseIndex: value.senseIndex,
      }];
    }),
  );

  return {
    recordsById: new Map(
      (serialized.recordsById ?? []).map(([id, index]) => [id, getRecordInfo(index)]),
    ),
    sensesById,
    candidatesById: new Map(
      (serialized.candidatesById ?? []).map(([id, index]) => [id, getRecordInfo(index)]),
    ),
    relations,
    relationsBySourceSenseId: indexMap(serialized.relationsBySourceSenseId),
    issues: serialized.issues ?? [],
    stats: serialized.stats ?? {},
  };
}

function serializeDerived(derived = {}) {
  const result = {};
  if (derived.nominalTerms instanceof Map) {
    result.nominal_terms = [...derived.nominalTerms.entries()].map(([key, values]) => [
      key,
      [...values],
    ]);
  }
  if (derived.topicEvidence) {
    result.topic_evidence = {
      ...derived.topicEvidence,
      by_sense: derived.topicEvidence.by_sense instanceof Map
        ? [...derived.topicEvidence.by_sense.entries()]
        : derived.topicEvidence.by_sense,
    };
  }
  if (derived.lexicalQuality) {
    result.lexical_quality = derived.lexicalQuality;
  }
  return result;
}

function rehydrateDerived(derived = {}) {
  const result = {};
  if (Array.isArray(derived.nominal_terms)) {
    result.nominalTerms = new Map(
      derived.nominal_terms.map(([key, values]) => [key, new Set(values)]),
    );
  }
  if (derived.topic_evidence) {
    result.topicEvidence = {
      ...derived.topic_evidence,
      by_sense: new Map(derived.topic_evidence.by_sense ?? []),
    };
  }
  if (derived.lexical_quality) {
    result.lexicalQuality = derived.lexical_quality;
  }
  return result;
}

function serializeContext(context) {
  return {
    contract_version: CANONICAL_CONTEXT_CONTRACT_VERSION,
    canonical_directory: context.canonicalDirectory,
    canonical_revision: context.canonicalRevision,
    file_count: context.fileCount,
    records: context.records,
    indexes: serializeIndexes(context),
    statistics: context.statistics,
    metrics: context.metrics,
    derived: serializeDerived(context.derived),
    ...(context.semanticAudit ? { semantic_audit: context.semanticAudit } : {}),
    ...(context.semanticDecisionSource
      ? { semantic_decision_source: context.semanticDecisionSource }
      : {}),
  };
}

function rehydrateContext(value, contextPath) {
  if (!value || value.contract_version !== CANONICAL_CONTEXT_CONTRACT_VERSION) {
    throw new CanonicalContextError(
      `${contextPath}: unsupported canonical context contract`,
      'UNSUPPORTED_CONTEXT_CONTRACT',
    );
  }
  if (
    typeof value.canonical_directory !== 'string'
    || (value.canonical_revision !== null
      && typeof value.canonical_revision !== 'string')
    || !Array.isArray(value.records)
    || !value.indexes
  ) {
    throw new CanonicalContextError(
      `${contextPath}: canonical context is missing records or indexes`,
      'INVALID_CONTEXT_SHAPE',
    );
  }

  const context = {
    contractVersion: value.contract_version,
    canonicalDirectory: path.resolve(value.canonical_directory),
    canonicalRevision: value.canonical_revision ?? null,
    fileCount: value.file_count ?? 0,
    records: value.records,
    indexes: rehydrateIndexes(value.records, value.indexes),
    statistics: value.statistics ?? value.indexes.stats ?? {},
    metrics: {
      ...(value.metrics ?? {}),
      canonical_context_deserialize_count:
        (value.metrics?.canonical_context_deserialize_count ?? 0) + 1,
      canonical_context_rehydrate_count:
        (value.metrics?.canonical_context_rehydrate_count ?? 0) + 1,
    },
    derived: rehydrateDerived(value.derived),
  };
  if (value.semantic_audit) context.semanticAudit = value.semantic_audit;
  if (value.semantic_decision_source) {
    context.semanticDecisionSource = value.semantic_decision_source;
  }
  return context;
}

export async function readCanonicalContext(contextPath, {
  expectedCanonicalDirectory,
  expectedCanonicalRevision = process.env.TYPEWRITER_CANONICAL_REVISION,
  requireCanonicalRevision = false,
} = {}) {
  let value;
  try {
    value = JSON.parse(await readFile(contextPath, 'utf8'));
  } catch (error) {
    if (error instanceof SyntaxError) {
      throw new CanonicalContextError(
        `${contextPath}: canonical context is not valid JSON (${error.message})`,
        'INVALID_CONTEXT_JSON',
      );
    }
    throw error;
  }
  const context = rehydrateContext(value, contextPath);
  if (expectedCanonicalDirectory
    && context.canonicalDirectory !== path.resolve(expectedCanonicalDirectory)) {
    throw new CanonicalContextError(
      `${contextPath}: canonical directory does not match ${expectedCanonicalDirectory}`,
      'CONTEXT_DIRECTORY_MISMATCH',
    );
  }
  if (requireCanonicalRevision && !expectedCanonicalRevision) {
    throw new CanonicalContextError(
      `${contextPath}: canonical context requires TYPEWRITER_CANONICAL_REVISION`,
      'CONTEXT_REVISION_REQUIRED',
    );
  }
  if (expectedCanonicalRevision && context.canonicalRevision !== expectedCanonicalRevision) {
    throw new CanonicalContextError(
      `${contextPath}: canonical context revision does not match the expected current revision`,
      'CONTEXT_REVISION_MISMATCH',
    );
  }
  return context;
}

export async function writeCanonicalContext(context, contextPath) {
  context.metrics.canonical_context_serialize_count =
    (context.metrics.canonical_context_serialize_count ?? 0) + 1;
  await writeFile(
    contextPath,
    `${JSON.stringify(serializeContext(context), null, 2)}\n`,
    'utf8',
  );
  return contextPath;
}

export async function loadCanonicalContext({
  directory = DEFAULT_CANONICAL_DIRECTORY,
  contextPath = process.env.TYPEWRITER_CANONICAL_CONTEXT_PATH,
} = {}) {
  if (contextPath && path.resolve(directory) === path.resolve(DEFAULT_CANONICAL_DIRECTORY)) {
    const expectedCanonicalRevision = process.env.TYPEWRITER_CANONICAL_REVISION;
    return readCanonicalContext(contextPath, {
      expectedCanonicalDirectory: directory,
      expectedCanonicalRevision,
      requireCanonicalRevision: true,
    });
  }

  const canonical = await readCanonicalRecords(directory, {
    useSharedContext: contextPath !== null,
  });
  return createCanonicalContext(canonical, {
    canonicalDirectory: directory,
  });
}

export function markSQLiteBuild(context, count = 1) {
  context.metrics.sqlite_build_count = (context.metrics.sqlite_build_count ?? 0) + count;
  const metricsPath = process.env.TYPEWRITER_PROCESS_METRICS_PATH;
  if (metricsPath && count > 0) {
    appendFileSync(
      metricsPath,
      `${JSON.stringify({
        type: 'sqlite-build',
        pid: process.pid,
        count,
        canonical_directory: context.canonicalDirectory,
        canonical_revision: context.canonicalRevision,
      })}\n`,
      'utf8',
    );
  }
  return context;
}

export function contextSummary(context) {
  return {
    contract_version: context.contractVersion,
    canonical_directory: context.canonicalDirectory,
    canonical_revision: context.canonicalRevision,
    file_count: context.fileCount,
    ...context.statistics,
    metrics: { ...context.metrics },
  };
}
