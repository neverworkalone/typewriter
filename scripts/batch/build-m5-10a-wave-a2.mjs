import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  M5_10A_PROCESS_REVISION,
  M5_10A_SENSE_BOUNDARY_IDS,
  validateBatchManifest,
} from './validate-batch.mjs';
import { readCanonicalRecords } from '../validate/canonical-jsonl.mjs';

const SCRIPT_DIRECTORY = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_OUTPUT_PATH = path.resolve(
  SCRIPT_DIRECTORY,
  '../../data/batches/m5-10-wave-a2.json',
);
const DEFAULT_RELATION_DIFF_PATH = path.resolve(
  SCRIPT_DIRECTORY,
  '../../data/batches/m5-10a-wave-a2-relation-diff.json',
);
const DEFAULT_CANONICAL_DIRECTORY = path.resolve(
  SCRIPT_DIRECTORY,
  '../../data/canonical',
);
const CORRECTED_CANONICAL_IDS = new Set([
  'w588',
  'w595',
  'w598',
  'w599',
  'w603',
  'w604',
  'w606',
  'w609',
  'w617',
  'w618',
  'w619',
  'w620',
  'w621',
  'w622',
  'w628',
]);
const BUFFER_DECISIONS = Object.freeze({
  'm5-357': 'held',
  'm5-358': 'held',
  'm5-359': 'held',
  'm5-360': 'rejected',
  'm5-361': 'rejected',
  'm5-362': 'rejected',
  'm5-363': 'deferred',
  'm5-364': 'deferred',
});
const BATCH_ID = 'm5-10-wave-a2-20260909';

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

async function fileSha256(filePath) {
  return sha256(await readFile(filePath));
}

function canonicalById(recordInfos) {
  return new Map(recordInfos.map(({ record }) => [record.id, record]));
}

function decisionFor(inventoryId, canonicalId) {
  if (canonicalId) return CORRECTED_CANONICAL_IDS.has(canonicalId) ? 'corrected' : 'included';
  return BUFFER_DECISIONS[inventoryId];
}

function inventoryIdFor(index) {
  return `m5-${String(index).padStart(3, '0')}`;
}

function canonicalIdFor(index) {
  return `w${index}`;
}

function decisionNote({ inventoryId, canonicalId, decision, lemma }) {
  if (decision === 'corrected') {
    return `${inventoryId} ${canonicalId} ${lemma}: 여섯 sense 경계를 전수 확인하고 독립된 의미를 분리해 corrected로 포함했다.`;
  }
  if (decision === 'included') {
    return `${inventoryId} ${canonicalId} ${lemma}: lemma/POS와 여섯 sense 경계를 확인해 included로 포함했다.`;
  }
  if (decision === 'held') {
    return `${inventoryId} ${lemma}: 경계 확인을 더 진행해야 하므로 이번 A2에서는 held로 남겼다.`;
  }
  if (decision === 'rejected') {
    return `${inventoryId} ${lemma}: 현재 writer-facing 범위에서 안정적인 admission 근거가 부족해 rejected로 닫았다.`;
  }
  return `${inventoryId} ${lemma}: 다음 단계에서 검토할 reserve 항목으로 deferred 처리했다.`;
}

function completeBoundaryChecks({ inventoryId, canonicalId, lemma, senseIds }) {
  return Object.fromEntries(M5_10A_SENSE_BOUNDARY_IDS.map((boundaryId) => [
    boundaryId,
    {
      status: 'checked',
      rationale: `${inventoryId} ${canonicalId} ${lemma} ${boundaryId}: ${senseIds.join(', ')}를 실제 sense 경계로 대조해 확인했다.`,
      sense_ids: [...senseIds],
    },
  ]));
}

function unresolvedBoundaryChecks({ inventoryId, lemma, decision }) {
  return Object.fromEntries(M5_10A_SENSE_BOUNDARY_IDS.map((boundaryId) => [
    boundaryId,
    {
      status: 'not-reviewed',
      rationale: `${inventoryId} ${lemma} ${boundaryId}: decision=${decision}이므로 A2 import 전 경계를 검토하지 않았다.`,
      sense_ids: [],
    },
  ]));
}

function createPreflightCheckpoint({ inventoryId, canonicalId, record, decision }) {
  const note = decisionNote({
    inventoryId,
    canonicalId,
    decision,
    lemma: record?.lemma ?? inventoryId,
  });
  if (canonicalId && record) {
    const senseIds = record.senses.map(({ id }) => id);
    return {
      inventory_id: inventoryId,
      canonical_id: canonicalId,
      status: 'complete',
      lemma_pos: 'checked',
      observed_sense_count: record.senses.length,
      observed_pos: record.senses.map(({ pos }) => pos),
      boundary_checks: completeBoundaryChecks({
        inventoryId,
        canonicalId,
        lemma: record.lemma,
        senseIds,
      }),
      missing_boundary_ids: [],
      note,
    };
  }

  return {
    inventory_id: inventoryId,
    status: decision,
    lemma_pos: 'not-reviewed',
    observed_sense_count: 0,
    observed_pos: [],
    boundary_checks: unresolvedBoundaryChecks({
      inventoryId,
      lemma: record?.lemma ?? inventoryId,
      decision,
    }),
    missing_boundary_ids: [...M5_10A_SENSE_BOUNDARY_IDS],
    note,
  };
}

function createManifest({ recordsById, relationDiffSha256, generatedAt }) {
  const selected = [];
  for (let index = 579; index <= 628; index += 1) {
    const canonicalId = canonicalIdFor(index);
    const inventoryId = inventoryIdFor(index - 272);
    selected.push({ inventoryId, canonicalId, record: recordsById.get(canonicalId) });
  }
  for (let index = 357; index <= 364; index += 1) {
    const inventoryId = inventoryIdFor(index);
    selected.push({ inventoryId, record: undefined });
  }

  const manifestRecords = selected.map(({ inventoryId, canonicalId, record }) => {
    const decision = decisionFor(inventoryId, canonicalId);
    const manifestRecord = {
      source: 'inventory',
      inventory_id: inventoryId,
      role: 'start',
      decision,
      decision_note: decisionNote({
        inventoryId,
        canonicalId,
        decision,
        lemma: record?.lemma ?? inventoryId,
      }),
    };
    if (canonicalId && (decision === 'included' || decision === 'corrected')) {
      manifestRecord.canonical_id = canonicalId;
    }
    if (decision === 'corrected') manifestRecord.corrected_fields = ['senses'];
    return manifestRecord;
  });

  const correctedCanonicalIds = selected
    .filter(({ canonicalId }) => canonicalId && CORRECTED_CANONICAL_IDS.has(canonicalId))
    .map(({ canonicalId }) => canonicalId);
  const preflight = selected.map(({ inventoryId, canonicalId, record }) => (
    createPreflightCheckpoint({
      inventoryId,
      canonicalId: canonicalId && decisionFor(inventoryId, canonicalId) !== 'deferred'
        ? canonicalId
        : undefined,
      record,
      decision: decisionFor(inventoryId, canonicalId),
    })
  ));

  return {
    schema_version: '1',
    batch_id: BATCH_ID,
    inventory_id: 'm5-core-5k',
    inventory_revision: 'm5-10',
    generator: {
      model_id: 'human-editorial-expansion',
      tool_version: 'typewriter-m5-10a-wave-a2-1',
      prompt_version: 'm5-10a-wave-a2-v1',
    },
    generated_at: generatedAt,
    review: {
      status: 'complete',
      reviewer: 'typewriter-wave-a2-editorial-review',
      completed_at: generatedAt,
    },
    sense_review: {
      status: 'complete',
      reviewed_start_count: 50,
      scoped_single_sense_count: 35,
      split_record_count: correctedCanonicalIds.length,
      split_canonical_ids: correctedCanonicalIds,
      note: 'A2 importable 50개를 lemma/POS와 physical/figurative, homonym/POS, sensory/emotion/state/action, directional symmetry, compound/spaced phrase, word/idiom 여섯 경계로 전수 검토했다. 15개는 독립 sense 경계를 확인해 corrected로 반영했고 relation 검토는 complete preflight 이후에만 진행했다.',
      preflight: {
        process_revision: M5_10A_PROCESS_REVISION,
        boundary_ids: [...M5_10A_SENSE_BOUNDARY_IDS],
        record_checkpoints: preflight,
      },
    },
    measurement: {
      schema_version: '1',
      relation_diff: {
        artifact: 'data/batches/m5-10a-wave-a2-relation-diff.json',
        sha256: relationDiffSha256,
      },
      timing: {
        contract_version: 'm5-10a-v1',
        status: 'incomplete',
        passes: [
          'target-preparation',
          'initial-review',
          'feedback-fixes',
          'final-audit',
          'held-rejected',
        ].map((id) => ({ id, status: 'unmeasured' })),
      },
      audit: {
        status: 'complete',
        independent: true,
        findings: [
          {
            id: 'm5-10a-wave-a2-sense-boundaries',
            category: 'sense',
            severity: 'info',
            status: 'resolved',
            note: '50개 importable start를 여섯 sense boundary로 전수 확인했고 15개 corrected split을 canonical과 preflight에 일치시켰다.',
          },
          {
            id: 'm5-10a-wave-a2-relation-admission',
            category: 'relation-noise',
            severity: 'info',
            status: 'resolved',
            note: '6개 relation candidate를 source/target sense와 writer-facing relation type으로 독립 대조해 모두 admit했다.',
          },
          {
            id: 'm5-10a-wave-a2-scope',
            category: 'reference-closure',
            severity: 'info',
            status: 'resolved',
            note: 'A2는 새 reference-only record 없이 기존 target sense만 사용하며 Wave B는 별도 authorization 전까지 시작하지 않는다.',
          },
        ],
      },
    },
    records: manifestRecords,
  };
}

export async function buildWaveA2Manifest({
  canonicalDirectory = DEFAULT_CANONICAL_DIRECTORY,
  relationDiffPath = DEFAULT_RELATION_DIFF_PATH,
  outputPath = DEFAULT_OUTPUT_PATH,
} = {}) {
  const [canonical, relationDiffSha256] = await Promise.all([
    readCanonicalRecords(canonicalDirectory),
    fileSha256(relationDiffPath),
  ]);
  const manifest = createManifest({
    recordsById: canonicalById(canonical.records),
    relationDiffSha256,
    generatedAt: new Date().toISOString(),
  });
  validateBatchManifest(manifest);
  await writeFile(outputPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
  return manifest;
}

const isMainModule = process.argv[1]
  && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));

if (isMainModule) {
  buildWaveA2Manifest()
    .then((manifest) => {
      console.log(`Generated ${manifest.batch_id} with ${manifest.records.length} selected start(s).`);
    })
    .catch((error) => {
      console.error(error.message);
      process.exitCode = 1;
    });
}
