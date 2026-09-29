import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  DEFAULT_CANONICAL_DIRECTORY,
  readCanonicalRecords,
} from './canonical-jsonl.mjs';
import {
  canonicalRecordsSha256,
  materializeSemanticReviewArtifact,
  readAuthoredBatchDecisionSources,
  sha256Json,
} from './semantic-audit.mjs';
import { inspectWriterRelationPath } from './sense-boundary.mjs';

const SCRIPT_DIRECTORY = path.dirname(fileURLToPath(import.meta.url));
const REPOSITORY_DIRECTORY = path.resolve(SCRIPT_DIRECTORY, '../..');
const DECISIONS_PATH = path.join(REPOSITORY_DIRECTORY, 'docs/audits/issue-225-sense-boundary-decisions.json');
const CORRECTION_PATH = path.join(REPOSITORY_DIRECTORY, 'data/validation/issue-225-semantic-correction-manifest.json');
const DECISION_SOURCE_PATH = path.join(REPOSITORY_DIRECTORY, 'data/validation/canonical-semantic-decision-source.json');
const SURFACE_FORM_REVIEW_PATH = path.join(REPOSITORY_DIRECTORY, 'data/validation/m6-3-surface-form-review.json');
const INVENTORY_PATH = path.join(REPOSITORY_DIRECTORY, 'docs/audits/issue-225-sense-boundary-audit.json');
const SUMMARY_PATH = path.join(REPOSITORY_DIRECTORY, 'docs/audits/issue-225-sense-boundary-audit.md');

function fail(message) {
  const error = new Error(message);
  error.code = 'ISSUE_225_SENSE_BOUNDARY_AUDIT';
  throw error;
}

function digestBytes(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

async function readJson(filePath) {
  return JSON.parse(await readFile(filePath, 'utf8'));
}

function stableUnique(values) {
  return [...new Set(values)].sort((left, right) => left.localeCompare(right));
}

function relationPathSignature(pathValue) {
  return JSON.stringify(pathValue);
}

function relationDescriptors(record, canonicalById) {
  return (record.senses ?? []).map((sense) => ({
    sense_id: sense.id,
    relations: inspectWriterRelationPath(record, sense.id).map((relation) => {
      const target = canonicalById.get(relation.target);
      if (!target) fail(`${record.id}/${sense.id} has dangling relation target ${relation.target}`);
      const targetSense = relation.target_sense
        ? target.senses.find(({ id }) => id === relation.target_sense)
        : undefined;
      if (relation.target_sense && !targetSense) {
        fail(`${record.id}/${sense.id} has dangling target sense ${relation.target_sense}`);
      }
      return {
        type: relation.type,
        target_id: relation.target,
        target_lemma: target.lemma,
        target_sense_id: relation.target_sense,
        target_pos: targetSense?.pos ?? stableUnique(target.senses.map(({ pos }) => pos)),
      };
    }),
  }));
}

function routeSummary(pathValue, targetById) {
  return pathValue.map(({ type, target, target_sense }) => {
    const record = targetById.get(target);
    const targetSense = target_sense
      ? record?.senses.find(({ id }) => id === target_sense)
      : undefined;
    const targetLabel = targetSense
      ? `${record.lemma}/${target_sense}:${targetSense.pos}`
      : `${record?.lemma ?? target} (${stableUnique(record?.senses.map(({ pos }) => pos) ?? []).join(', ')})`;
    return `${type} → ${targetLabel}`;
  }).join('<br>') || '없음';
}

function mdCell(value) {
  return String(value ?? '').replaceAll('|', '\\|').replaceAll('\n', ' ');
}

function summarizeBoundaryReview(review) {
  if (!review) return null;
  return {
    status: review.status,
    review_id: review.review_id,
    method: review.method,
    decision: review.decision,
    classification: review.classification,
    reviewed_sense_ids: review.reviewed_sense_ids,
    pairwise: (review.pairwise ?? []).map((pair) => ({
      left_sense_id: pair.left_sense_id,
      right_sense_id: pair.right_sense_id,
      relationship: pair.relationship,
      decision: pair.decision,
      left_gloss_sha256: pair.left_gloss_sha256,
      right_gloss_sha256: pair.right_gloss_sha256,
    })),
    rationale: review.rationale,
  };
}

async function buildReport({ decisions, correction, canonical, decisionSource, batchDecisionSources }) {
  if (decisions.schema_version !== '1'
    || decisions.contract_version !== 'issue-225-sense-boundary-decisions-v1'
    || decisions.issue !== 225
    || decisions.parent_issue !== 218) {
    fail('authored decision file must use the Issue #225 / parent #218 contract');
  }
  if (correction.corrections?.length !== 1 || correction.corrections[0].record_id !== 'w321') {
    fail('the Issue #225 correction manifest must contain only the reviewed w321 merge');
  }
  const w321Correction = correction.corrections[0];
  const currentById = new Map(canonical.records.map(({ record }) => [record.id, record]));
  const currentDigest = canonicalRecordsSha256(canonical.records);
  if (currentDigest !== correction.prospective_canonical_records_sha256) {
    fail('current canonical snapshot does not match the correction manifest prospective digest');
  }
  const currentW321 = currentById.get('w321');
  if (!currentW321 || sha256Json(currentW321) !== w321Correction.after_record_sha256) {
    fail('canonical w321 does not match the bound corrected record');
  }
  const baseRecords = canonical.records.map((recordInfo) => ({
    ...recordInfo,
    record: recordInfo.record.id === 'w321'
      ? w321Correction.before_record
      : recordInfo.record,
  }));
  const baseDigest = canonicalRecordsSha256(baseRecords);
  if (baseDigest !== correction.base_canonical_records_sha256
    || !correction.source_revision.endsWith(decisions.source_revision)) {
    fail('the reconstructed pre-correction canonical snapshot is not bound to the authored audit sources');
  }
  if (decisionSource.source.canonical_records_sha256 !== currentDigest) {
    fail('current semantic decision source does not bind the corrected canonical snapshot');
  }

  const baseById = new Map(baseRecords.map(({ record }) => [record.id, record]));
  const baselineMultisense = [...baseById.values()]
    .filter((record) => record.senses.length > 1)
    .sort((left, right) => left.id.localeCompare(right.id));
  const currentMultisense = [...currentById.values()].filter((record) => record.senses.length > 1);
  const keepById = new Map(decisions.keep_split.map((entry) => [entry.record_id, entry]));
  const mergeById = new Map(decisions.merge_senses.map((entry) => [entry.record_id, entry]));
  const holdById = new Map(decisions.hold_overrides.map((entry) => [entry.record_id, entry]));
  if (keepById.size !== decisions.keep_split.length
    || mergeById.size !== decisions.merge_senses.length
    || holdById.size !== decisions.hold_overrides.length) {
    fail('authored decision file contains duplicate record IDs');
  }
  if (keepById.has('w321') || holdById.has('w321')) fail('w321 must have only the merge disposition');

  const materializedReview = materializeSemanticReviewArtifact(
    canonical.records,
    decisionSource.authored_review,
    {
      decisionSourceId: decisionSource.source_id,
      batchDecisionSources,
    },
  );
  const reviewById = new Map(materializedReview.records.map((review) => [review.record_id, review]));
  const canonicalById = new Map([...currentById, ...baseById]);
  const relationTargetsById = canonicalById;
  const correctionManifestBytes = await readFile(CORRECTION_PATH);

  if (baselineMultisense.length !== 249) {
    fail(`expected 249 pre-correction multisense records, found ${baselineMultisense.length}`);
  }
  if (currentMultisense.length !== 248) {
    fail(`expected 248 post-correction multisense records, found ${currentMultisense.length}`);
  }
  if (baselineMultisense.reduce((sum, record) => sum + record.senses.length, 0) !== 511) {
    fail('pre-correction multisense inventory no longer matches 511 senses');
  }
  if (keepById.size !== 42 || mergeById.size !== 1
    || baselineMultisense.length - keepById.size - mergeById.size !== 206) {
    fail('authored dispositions must cover 42 retained splits, one merge, and 206 holds');
  }
  if (holdById.size !== 1 || !holdById.has('w5356')) {
    fail('w5356 must retain its separately authored process/content hold rationale');
  }
  const expectedIds = new Set(baselineMultisense.map(({ id }) => id));
  const authoredIds = new Set([...keepById.keys(), ...mergeById.keys(), ...holdById.keys()]);
  if ([...authoredIds].some((id) => !expectedIds.has(id))) {
    fail('authored keep and merge decisions plus the default hold do not cover the complete multisense inventory');
  }

  const entries = baselineMultisense.map((record) => {
    const keep = keepById.get(record.id);
    const merge = mergeById.get(record.id);
    const hold = holdById.get(record.id);
    const priorReview = reviewById.get(record.id);
    const relationPaths = record.senses.map((sense) => ({
      sense_id: sense.id,
      path: inspectWriterRelationPath(record, sense.id),
    }));
    const missingRelationSenseIds = relationPaths
      .filter(({ path: relationPath }) => relationPath.length === 0)
      .map(({ sense_id: senseId }) => senseId);
    const frames = keep?.frames ?? {};
    const frameSenseIds = Object.keys(frames).sort();
    const expectedSenseIds = record.senses.map(({ id }) => id).sort();

    let disposition;
    let rationale;
    let frameEvidence;
    if (keep) {
      if (JSON.stringify(frameSenseIds) !== JSON.stringify(expectedSenseIds)) {
        fail(`${record.id} retained split frame summaries do not cover its exact sense IDs`);
      }
      const frameSummaries = record.senses.map((sense) => {
        const summary = frames[sense.id];
        if (typeof summary !== 'string' || summary.trim().length < 20) {
          fail(`${record.id}/${sense.id} needs a concrete sentence/argument/scene frame summary`);
        }
        return { sense_id: sense.id, summary };
      });
      if (new Set(frameSummaries.map(({ summary }) => summary)).size !== frameSummaries.length) {
        fail(`${record.id} retained split frame summaries must distinguish every sense`);
      }
      for (let leftIndex = 0; leftIndex < record.senses.length; leftIndex += 1) {
        for (let rightIndex = leftIndex + 1; rightIndex < record.senses.length; rightIndex += 1) {
          const left = record.senses[leftIndex];
          const right = record.senses[rightIndex];
          const leftPath = inspectWriterRelationPath(record, left.id);
          const rightPath = inspectWriterRelationPath(record, right.id);
          if (leftPath.length === 0 || rightPath.length === 0
            || relationPathSignature(leftPath) === relationPathSignature(rightPath)) {
            fail(`${record.id} cannot retain ${left.id}/${right.id} without distinct non-empty writer relation paths`);
          }
        }
      }
      if (!priorReview?.boundary_review) fail(`${record.id} has no materialized semantic boundary review provenance`);
      disposition = 'keep-split';
      rationale = 'Concrete writer-facing frames and distinct non-empty relation paths are both present for every sense pair.';
      frameEvidence = frameSummaries;
    } else if (merge) {
      if (record.id !== 'w321'
        || JSON.stringify(merge.removed_sense_ids) !== JSON.stringify(w321Correction.removed_sense_ids)
        || sha256Json(record) !== w321Correction.before_record_sha256) {
        fail('w321 merge evidence does not reproduce its exact base record and removed sense set');
      }
      if (JSON.stringify(mergeById.get('w321').removed_sense_ids) !== JSON.stringify(['w321-s2'])) {
        fail('w321 must preserve w321-s1 and remove only w321-s2');
      }
      const paths = record.senses.map((sense) => relationPathSignature(inspectWriterRelationPath(record, sense.id)));
      if (paths.some((signature) => signature === '[]') || new Set(paths).size !== 1) {
        fail('w321 can merge only because both senses have the same non-empty writer route');
      }
      if (JSON.stringify(currentW321.search_forms) !== JSON.stringify(record.search_forms)
        || currentW321.id !== record.id
        || currentW321.lemma !== record.lemma
        || currentW321.senses.length !== 1
        || currentW321.senses[0].id !== 'w321-s1'
        || currentW321.senses[0].gloss !== merge.merged_gloss
        || currentW321.senses[0].relations.length !== 1) {
        fail('w321 correction must preserve identity, exact-search fields, the surviving sense ID, and one shared route');
      }
      disposition = 'merge-senses';
      rationale = merge.rationale;
    } else {
      if (!priorReview?.boundary_review) fail(`${record.id} has no materialized semantic boundary review provenance`);
      disposition = 'hold-boundary';
      rationale = hold?.rationale ?? decisions.default_hold_basis;
      if (hold && record.id !== 'w5356') fail(`unexpected explicit hold override for ${record.id}`);
    }

    const recordPaths = relationDescriptors(record, canonicalById);
    const targetPathSummary = relationPaths.map(({ sense_id: senseId, path: relationPath }) => ({
      sense_id: senseId,
      route: routeSummary(relationPath, relationTargetsById),
    }));
    const currentReviewRecord = reviewById.get(record.id);
    return {
      record_id: record.id,
      lemma: record.lemma,
      record_type: record.record_type,
      role: record.role,
      candidate_id: record.candidate_id,
      search_forms: record.search_forms,
      disposition,
      rationale,
      ...(frameEvidence ? { writer_frames: frameEvidence } : {}),
      senses: record.senses.map((sense) => ({
        sense_id: sense.id,
        pos: sense.pos,
        gloss: sense.gloss,
        relations: recordPaths.find(({ sense_id: senseId }) => senseId === sense.id).relations,
      })),
      relation_path_signatures: relationPaths.map(({ sense_id: senseId, path: relationPath }) => ({
        sense_id: senseId,
        path: relationPath,
        signature: relationPathSignature(relationPath),
        route_summary: targetPathSummary.find(({ sense_id: targetSenseId }) => targetSenseId === senseId).route,
      })),
      missing_relation_sense_ids: missingRelationSenseIds,
      semantic_boundary_review: summarizeBoundaryReview(currentReviewRecord?.boundary_review),
      semantic_review_binding: currentReviewRecord ? {
        decision_source_id: decisionSource.source_id,
        reviewed_record_sha256: currentReviewRecord.record_sha256,
        matches_baseline_record: currentReviewRecord.record_sha256 === sha256Json(record),
      } : null,
      ...(merge ? {
        correction_manifest_sha256: digestBytes(correctionManifestBytes),
        removed_sense_ids: merge.removed_sense_ids,
        exact_search_preserved: true,
        correction_evidence: {
          source_revision: correction.source_revision,
          before_record_sha256: w321Correction.before_record_sha256,
          after_record_sha256: w321Correction.after_record_sha256,
          boundary_review_id: w321Correction.semantic_review.boundary.review_id,
          boundary_reviewed_sense_ids: w321Correction.semantic_review.boundary.reviewed_sense_ids,
          boundary_rationale: w321Correction.semantic_review.boundary.rationale,
          relation_decision_rationale: w321Correction.semantic_review.senses[0].relation.rationale,
        },
      } : {}),
    };
  });

  const counts = Object.fromEntries(['keep-split', 'merge-senses', 'hold-boundary']
    .map((disposition) => [disposition, entries.filter((entry) => entry.disposition === disposition).length]));
  const holdGapCounts = {
    missing_relation_path: entries.filter((entry) => entry.disposition === 'hold-boundary'
      && entry.missing_relation_sense_ids.length > 0).length,
    missing_authored_frame_contrast: entries.filter((entry) => entry.disposition === 'hold-boundary'
      && entry.writer_frames === undefined).length,
  };
  if (counts['keep-split'] !== 42 || counts['merge-senses'] !== 1 || counts['hold-boundary'] !== 206) {
    fail('generated disposition counts do not match the complete review');
  }
  const decisionsBytes = await readFile(DECISIONS_PATH);
  const semanticDecisionSourceBytes = await readFile(DECISION_SOURCE_PATH);
  const surfaceFormReviewBytes = await readFile(SURFACE_FORM_REVIEW_PATH);
  const inventory = {
    schema_version: '1',
    contract_version: 'issue-225-sense-boundary-audit-v1',
    issue: 225,
    parent_issue: 218,
    source_revision: decisions.source_revision,
    source_digests: {
      base_canonical_records_sha256: baseDigest,
      current_canonical_records_sha256: currentDigest,
      authored_decisions_sha256: digestBytes(decisionsBytes),
      correction_manifest_sha256: digestBytes(correctionManifestBytes),
      semantic_decision_source_sha256: digestBytes(semanticDecisionSourceBytes),
      surface_form_review_sha256: digestBytes(surfaceFormReviewBytes),
    },
    inventory: {
      canonical_record_count: canonical.records.length,
      baseline_canonical_sense_count: baseRecords.reduce((sum, { record }) => sum + record.senses.length, 0),
      current_canonical_sense_count: canonical.records.reduce((sum, { record }) => sum + record.senses.length, 0),
      baseline_multisense_record_count: baselineMultisense.length,
      baseline_multisense_sense_count: 511,
      current_multisense_record_count: currentMultisense.length,
      baseline_writer_relation_path_count: entries.reduce((sum, entry) => sum
        + entry.relation_path_signatures.reduce((senseSum, item) => senseSum + item.path.length, 0), 0),
      dispositions: counts,
      hold_evidence_gaps: holdGapCounts,
    },
    decisions: entries,
  };

  const keepRows = entries.filter((entry) => entry.disposition === 'keep-split');
  const holdRows = entries.filter((entry) => entry.disposition === 'hold-boundary');
  const keepTable = keepRows.map((entry) => {
    const frames = entry.writer_frames.map(({ sense_id: senseId, summary }) => `${senseId}: ${summary}`).join('<br>');
    const routes = entry.relation_path_signatures.map(({ sense_id: senseId, route_summary: route }) => `${senseId}: ${route}`).join('<br>');
    return `| ${mdCell(entry.record_id)} | ${mdCell(entry.lemma)} | ${mdCell(frames)} | ${mdCell(routes)} |`;
  }).join('\n');
  const holdIds = holdRows.map(({ record_id: recordId }) => recordId).join(', ');
  const summary = [
    '# Issue #225 sense-boundary audit',
    '',
    `Parent: Issue #218. Source canonical revision: \`${decisions.source_revision}\`.`,
    '',
    '## Inventory',
    '',
    '| Measure | Result |',
    '| --- | ---: |',
    `| Multisense records reviewed before correction | ${baselineMultisense.length} |`,
    `| Senses in those records before correction | 511 |`,
    `| Retain split with concrete frame and distinct routes | ${counts['keep-split']} |`,
    `| Merge over-split senses | ${counts['merge-senses']} |`,
    `| Hold unresolved boundaries | ${counts['hold-boundary']} |`,
    `| Canonical senses after correction | ${inventory.inventory.current_canonical_sense_count} |`,
    `| Multisense records after correction | ${currentMultisense.length} |`,
    '',
    '## Decision rule',
    '',
    'A split is retained only when each sense pair has a concrete sentence, argument, or scene frame contrast and a distinct, non-empty writer relation path. Route identity uses relation type and target sense; note wording and relation count do not make routes distinct. A missing route is not evidence that senses are equivalent, so unresolved rows stay split and are held for later evidence.',
    '',
    '## Retained splits',
    '',
    '| ID | Lemma | Writer-facing frames | Relation routes |',
    '| --- | --- | --- | --- |',
    keepTable,
    '',
    '## Merge',
    '',
    'Only `w321 미지근하다` was merged. Its physical-temperature and figurative-response glosses reached the same `near → r042-s1` writer route. The correction keeps record ID `w321`, surviving sense ID `w321-s1`, the lemma, and curated exact search forms; it combines the two frames in one gloss and retains one existing route.',
    '',
    '## Holds',
    '',
    `${holdRows.length} records remain split because this audit lacks both required proof elements for retention. ${holdGapCounts.missing_relation_path} have at least one sense without an authored relation path; all ${holdGapCounts.missing_authored_frame_contrast} lack an authored Issue #225 frame contrast. No relation was invented to complete the inventory.`,
    '',
    'For `w5356 기억`, the glosses distinguish the mental act of retaining past events from the remembered content that returns to mind. Merging would erase that process/content contrast, but neither sense has an authored relation path. Keep both senses pending concrete writer-facing route evidence.',
    '',
    'Held record IDs:',
    '',
    holdIds,
    '',
    `The complete sense text, POS, relation target lemma/POS, source-bound semantic boundary review, missing-route IDs, and per-record rationale are in [the machine inventory](issue-225-sense-boundary-audit.json).`,
    '',
  ].join('\n');

  return {
    inventoryBytes: `${JSON.stringify(inventory, null, 2)}\n`,
    summaryBytes: summary,
  };
}

function parseArguments(argv) {
  const options = new Set(argv);
  for (const option of options) {
    if (option !== '--write') fail(`unsupported argument ${option}`);
  }
  return { write: options.has('--write') };
}

export async function runIssue225Audit({ write = false } = {}) {
  const [decisions, correction, canonical, decisionSource, batchDecisionSources] = await Promise.all([
    readJson(DECISIONS_PATH),
    readJson(CORRECTION_PATH),
    readCanonicalRecords(DEFAULT_CANONICAL_DIRECTORY),
    readJson(DECISION_SOURCE_PATH),
    readAuthoredBatchDecisionSources(),
  ]);
  const outputs = await buildReport({
    decisions,
    correction,
    canonical,
    decisionSource,
    batchDecisionSources,
  });
  if (write) {
    await writeFile(INVENTORY_PATH, outputs.inventoryBytes);
    await writeFile(SUMMARY_PATH, outputs.summaryBytes);
    return { status: 'written', inventoryPath: INVENTORY_PATH, summaryPath: SUMMARY_PATH };
  }
  const [actualInventory, actualSummary] = await Promise.all([
    readFile(INVENTORY_PATH, 'utf8'),
    readFile(SUMMARY_PATH, 'utf8'),
  ]);
  if (actualInventory !== outputs.inventoryBytes || actualSummary !== outputs.summaryBytes) {
    fail('tracked Issue #225 audit outputs are stale; run with --write and review the diff');
  }
  return { status: 'current', inventoryPath: INVENTORY_PATH, summaryPath: SUMMARY_PATH };
}

const isMainModule = process.argv[1]
  && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));

if (isMainModule) {
  const options = parseArguments(process.argv.slice(2));
  runIssue225Audit(options)
    .then((result) => console.log(JSON.stringify(result, null, 2)))
    .catch((error) => {
      console.error(error.code ? `${error.code}: ${error.message}` : error.message);
      process.exitCode = 1;
    });
}
