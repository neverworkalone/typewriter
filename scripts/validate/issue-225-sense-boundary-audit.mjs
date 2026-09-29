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
import {
  hasDistinctAuthoredWriterRoutes,
  inspectWriterRelationPath,
  WRITER_ROUTE_RELATION_TYPES,
  WRITER_ROUTE_TARGET_POS,
} from './sense-boundary.mjs';

const SCRIPT_DIRECTORY = path.dirname(fileURLToPath(import.meta.url));
const REPOSITORY_DIRECTORY = path.resolve(SCRIPT_DIRECTORY, '../..');
const DECISIONS_PATH = path.join(REPOSITORY_DIRECTORY, 'docs/audits/issue-225-sense-boundary-decisions.json');
const DECISION_SOURCE_PATH = path.join(REPOSITORY_DIRECTORY, 'data/validation/canonical-semantic-decision-source.json');
const SURFACE_FORM_REVIEW_PATH = path.join(REPOSITORY_DIRECTORY, 'data/validation/m6-3-surface-form-review.json');
const INVENTORY_PATH = path.join(REPOSITORY_DIRECTORY, 'docs/audits/issue-225-sense-boundary-audit.json');
const SUMMARY_PATH = path.join(REPOSITORY_DIRECTORY, 'docs/audits/issue-225-sense-boundary-audit.md');

function fail(message) {
  const error = new Error(message);
  error.code = 'ISSUE_225_SENSE_BOUNDARY_AUDIT';
  throw error;
}

function requireNonEmptyString(value, label) {
  if (typeof value !== 'string' || value.trim().length === 0) {
    fail(`${label} must be a non-empty string`);
  }
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

async function buildReport({ decisions, canonical, decisionSource, batchDecisionSources }) {
  if (decisions.schema_version !== '2'
    || decisions.contract_version !== 'issue-225-sense-boundary-decisions-v2'
    || decisions.issue !== 225
    || decisions.parent_issue !== 218) {
    fail('authored decision file must use the Issue #225 / parent #218 contract');
  }
  const currentById = new Map(canonical.records.map(({ record }) => [record.id, record]));
  const currentDigest = canonicalRecordsSha256(canonical.records);
  if (decisionSource.source.canonical_records_sha256 !== currentDigest) {
    fail('current semantic decision source does not bind the audited canonical snapshot');
  }
  const multisenseRecords = [...currentById.values()]
    .filter((record) => record.senses.length > 1)
    .sort((left, right) => left.id.localeCompare(right.id));
  const keepById = new Map(decisions.keep_split.map((entry) => [entry.record_id, entry]));
  const mergeById = new Map(decisions.merge_senses.map((entry) => [entry.record_id, entry]));
  const holdById = new Map(decisions.hold_overrides.map((entry) => [entry.record_id, entry]));
  const frameReviewById = new Map(decisions.frame_reviews.map((entry) => [entry.record_id, entry]));
  if (keepById.size !== decisions.keep_split.length
    || mergeById.size !== decisions.merge_senses.length
    || holdById.size !== decisions.hold_overrides.length
    || frameReviewById.size !== decisions.frame_reviews.length) {
    fail('authored decision file contains duplicate record IDs');
  }
  if (mergeById.size !== 0) {
    fail('this audit has no merge supported by positive semantic evidence; relation-path equality is insufficient');
  }
  if (multisenseRecords.length !== 249
    || multisenseRecords.reduce((sum, record) => sum + record.senses.length, 0) !== 511) {
    fail('the source snapshot no longer matches 249 multi-sense records and 511 senses');
  }
  if (frameReviewById.size !== 2) {
    fail(`expected explicit held frame reviews for w321 and w5356, found ${frameReviewById.size}`);
  }
  if (holdById.size !== 2 || !holdById.has('w321') || !holdById.has('w5356')) {
    fail('w321 and w5356 must retain their explicit unresolved-boundary rationales');
  }

  const expectedIds = new Set(multisenseRecords.map(({ id }) => id));
  const authoredIds = new Set([
    ...keepById.keys(),
    ...mergeById.keys(),
    ...holdById.keys(),
    ...frameReviewById.keys(),
  ]);
  if ([...authoredIds].some((id) => !expectedIds.has(id))) {
    fail('authored frame and disposition decisions include a record outside the complete multisense inventory');
  }

  const materializedReview = materializeSemanticReviewArtifact(
    canonical.records,
    decisionSource.authored_review,
    {
      decisionSourceId: decisionSource.source_id,
      batchDecisionSources,
    },
  );
  const reviewById = new Map(materializedReview.records.map((review) => [review.record_id, review]));
  const relationTargetsById = currentById;
  const routeTypes = new Set(WRITER_ROUTE_RELATION_TYPES);
  const targetPos = new Set(WRITER_ROUTE_TARGET_POS);

  const entries = multisenseRecords.map((record) => {
    const keep = keepById.get(record.id);
    const merge = mergeById.get(record.id);
    const hold = holdById.get(record.id);
    const frameReview = frameReviewById.get(record.id);
    const priorReview = reviewById.get(record.id);
    const relationPaths = record.senses.map((sense) => ({
      sense_id: sense.id,
      path: inspectWriterRelationPath(record, sense.id),
    }));
    const missingRelationSenseIds = relationPaths
      .filter(({ path: relationPath }) => relationPath.length === 0)
      .map(({ sense_id: senseId }) => senseId);
    const frames = keep?.frames ?? frameReview?.frames;
    const frameSenseIds = Object.keys(frames ?? {}).sort();
    const expectedSenseIds = record.senses.map(({ id }) => id).sort();
    let frameEvidence;
    if (frames !== undefined) {
      if (JSON.stringify(frameSenseIds) !== JSON.stringify(expectedSenseIds)) {
        fail(`${record.id} frame summaries do not cover its exact sense IDs`);
      }
      frameEvidence = record.senses.map((sense) => {
        const summary = frames[sense.id];
        if (typeof summary !== 'string' || summary.trim().length < 20) {
          fail(`${record.id}/${sense.id} needs a concrete sentence/argument/scene frame summary`);
        }
        return { sense_id: sense.id, summary };
      });
      if (new Set(frameEvidence.map(({ summary }) => summary)).size !== frameEvidence.length) {
        fail(`${record.id} frame summaries must distinguish every sense`);
      }
    }

    let disposition = 'hold-boundary';
    let rationale = hold?.rationale
      ?? (frameReview ? decisions.frame_review_hold_basis : decisions.default_hold_basis);
    let writerRouteEvidence;
    if (keep) {
      if (!frameEvidence) fail(`${record.id} cannot retain a split without authored frame evidence`);
      requireNonEmptyString(keep.route_contrast, `${record.id}.route_contrast`);
      requireNonEmptyString(keep.rationale, `${record.id}.rationale`);
      const routes = keep.writer_routes;
      if (!routes || JSON.stringify(Object.keys(routes).sort()) !== JSON.stringify(expectedSenseIds)) {
        fail(`${record.id} authored routes must cover its exact sense IDs`);
      }
      writerRouteEvidence = record.senses.map((sense) => {
        const route = routes[sense.id];
        if (!routeTypes.has(route.relation_type)) {
          fail(`${record.id}/${sense.id} has an unsupported authored relation direction`);
        }
        if (route.target_pos !== undefined && !targetPos.has(route.target_pos)) {
          fail(`${record.id}/${sense.id} has an unsupported authored target POS`);
        }
        if (route.target_class !== undefined
          && (typeof route.target_class !== 'string' || route.target_class.trim().length === 0)) {
          fail(`${record.id}/${sense.id} target_class must be a non-empty authored description`);
        }
        if (route.target_pos === undefined && route.target_class === undefined) {
          fail(`${record.id}/${sense.id} must name an expected target POS or semantic class`);
        }
        return { sense_id: sense.id, ...route };
      });
      for (let leftIndex = 0; leftIndex < record.senses.length; leftIndex += 1) {
        for (let rightIndex = leftIndex + 1; rightIndex < record.senses.length; rightIndex += 1) {
          const leftId = record.senses[leftIndex].id;
          const rightId = record.senses[rightIndex].id;
          if (!hasDistinctAuthoredWriterRoutes(routes[leftId], routes[rightId])) {
            fail(`${record.id} cannot retain ${leftId}/${rightId} without distinct authored writer routes`);
          }
        }
      }
      if (!priorReview?.boundary_review) fail(`${record.id} has no materialized semantic boundary review provenance`);
      disposition = 'keep-split';
      rationale = keep.rationale;
    } else if (merge) {
      fail(`${record.id} merge evidence must be added with a positive semantic review, not relation-path equality`);
    } else if (!priorReview?.boundary_review) {
      fail(`${record.id} has no materialized semantic boundary review provenance`);
    }

    const recordPaths = relationDescriptors(record, relationTargetsById);
    const targetPathSummary = relationPaths.map(({ sense_id: senseId, path: relationPath }) => ({
      sense_id: senseId,
      route: routeSummary(relationPath, relationTargetsById),
    }));
    const currentPathSignatures = relationPaths.map(({ path: relationPath }) => relationPathSignature(relationPath));
    const currentPathComparison = missingRelationSenseIds.length > 0
      ? 'incomplete'
      : new Set(currentPathSignatures).size === 1 ? 'same' : 'different';
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
      ...(writerRouteEvidence ? {
        writer_route_contrast: keep.route_contrast,
        authored_writer_routes: writerRouteEvidence,
      } : {}),
      senses: record.senses.map((sense) => ({
        sense_id: sense.id,
        pos: sense.pos,
        gloss: sense.gloss,
        relations: recordPaths.find(({ sense_id: senseId }) => senseId === sense.id).relations,
      })),
      relation_path_comparison: currentPathComparison,
      relation_path_signatures: relationPaths.map(({ sense_id: senseId, path: relationPath }) => ({
        sense_id: senseId,
        path: relationPath,
        signature: relationPathSignature(relationPath),
        route_summary: targetPathSummary.find(({ sense_id: targetSenseId }) => targetSenseId === senseId).route,
      })),
      missing_relation_sense_ids: missingRelationSenseIds,
      missing_independent_writer_route_evidence: disposition === 'hold-boundary',
      semantic_boundary_review: summarizeBoundaryReview(currentReviewRecord?.boundary_review),
      semantic_review_binding: currentReviewRecord ? {
        decision_source_id: decisionSource.source_id,
        reviewed_record_sha256: currentReviewRecord.record_sha256,
        matches_baseline_record: currentReviewRecord.record_sha256 === sha256Json(record),
      } : null,
    };
  });

  const counts = Object.fromEntries(['keep-split', 'merge-senses', 'hold-boundary']
    .map((disposition) => [disposition, entries.filter((entry) => entry.disposition === disposition).length]));
  const holdGapCounts = {
    missing_current_relation_path: entries.filter((entry) => entry.disposition === 'hold-boundary'
      && entry.missing_relation_sense_ids.length > 0).length,
    missing_authored_frame_contrast: entries.filter((entry) => entry.disposition === 'hold-boundary'
      && entry.writer_frames === undefined).length,
    missing_independent_writer_route_evidence: entries.filter((entry) => entry.missing_independent_writer_route_evidence).length,
    frame_reviewed_but_route_unresolved: entries.filter((entry) => entry.disposition === 'hold-boundary'
      && entry.writer_frames !== undefined).length,
  };
  if (counts['keep-split'] !== 42 || counts['merge-senses'] !== 0 || counts['hold-boundary'] !== 207) {
    fail('the reviewed snapshot must retain 42 independently supported splits and hold 207 unresolved boundaries');
  }
  const decisionsBytes = await readFile(DECISIONS_PATH);
  const semanticDecisionSourceBytes = await readFile(DECISION_SOURCE_PATH);
  const surfaceFormReviewBytes = await readFile(SURFACE_FORM_REVIEW_PATH);
  const totalSenseCount = canonical.records.reduce((sum, { record }) => sum + record.senses.length, 0);
  const inventory = {
    schema_version: '1',
    contract_version: 'issue-225-sense-boundary-audit-v2',
    issue: 225,
    parent_issue: 218,
    source_revision: decisions.source_revision,
    source_digests: {
      canonical_records_sha256: currentDigest,
      authored_decisions_sha256: digestBytes(decisionsBytes),
      semantic_decision_source_sha256: digestBytes(semanticDecisionSourceBytes),
      surface_form_review_sha256: digestBytes(surfaceFormReviewBytes),
    },
    inventory: {
      canonical_record_count: canonical.records.length,
      canonical_sense_count: totalSenseCount,
      multisense_record_count: multisenseRecords.length,
      multisense_sense_count: multisenseRecords.reduce((sum, record) => sum + record.senses.length, 0),
      writer_relation_path_count: entries.reduce((sum, entry) => sum
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
    const routes = entry.authored_writer_routes.map(({ sense_id: senseId, relation_type: direction, target_pos: pos, target_class: targetClass }) => (
      `${senseId}: ${direction} → ${pos ?? targetClass}`
    )).join('<br>');
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
    `| Multi-sense records reviewed | ${multisenseRecords.length} |`,
    `| Senses in those records | ${inventory.inventory.multisense_sense_count} |`,
    `| Canonical senses | ${totalSenseCount} |`,
    `| Retain split with authored frame and route contrast | ${counts['keep-split']} |`,
    `| Merge over-split senses | ${counts['merge-senses']} |`,
    `| Hold unresolved boundaries | ${counts['hold-boundary']} |`,
    '',
    '## Decision rule',
    '',
    'Retain a split only when concrete frame evidence and a separately authored next-route contrast both distinguish every sense pair. Route evidence records an expected relation family/direction and a target POS or semantic class; an existing relation tuple is not required. Current tuples are corroborating observations only: matching routes do not establish equivalence, and missing routes do not justify a merge. Hold the current split whenever writer-facing evidence is incomplete.',
    '',
    '## Retained splits',
    '',
    '| ID | Lemma | Writer-facing frames | Authored next routes |',
    '| --- | --- | --- | --- |',
    keepTable,
    '',
    '## Merge',
    '',
    'No over-split is confirmed by positive semantic evidence in this audit. Matching current relation paths alone do not justify merging senses.',
    '',
    '## Holds',
    '',
    `${holdRows.length} current splits remain unchanged. ${holdGapCounts.missing_authored_frame_contrast} lack an authored frame contrast, and ${holdGapCounts.missing_independent_writer_route_evidence} lack independently authored next-route evidence. ${holdGapCounts.frame_reviewed_but_route_unresolved} have recorded frame distinctions but still need that route evidence. Existing relation paths remain in the machine inventory as corroborating observations only.`,
    '',
    `For \`w321 미지근하다\`, the physical-temperature and figurative-response frames differ, but both current tuples point to \`near → r042-s1\`. That shared target is not positive evidence that the writer-facing boundary is equivalent, so both senses remain pending independently authored route evidence.`,
    '',
    'For `w5356 기억`, the glosses distinguish the mental act of retaining past events from remembered content that returns to mind. Preserve both senses pending concrete evidence about the writer’s next relation direction or target POS/semantic class.',
    '',
    'Held record IDs:',
    '',
    holdIds,
    '',
    `The complete sense text, POS, current relation-path observations, authored frame reviews, and per-record rationale are in [the machine inventory](issue-225-sense-boundary-audit.json).`,
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
  const [decisions, canonical, decisionSource, batchDecisionSources] = await Promise.all([
    readJson(DECISIONS_PATH),
    readCanonicalRecords(DEFAULT_CANONICAL_DIRECTORY),
    readJson(DECISION_SOURCE_PATH),
    readAuthoredBatchDecisionSources(),
  ]);
  const outputs = await buildReport({
    decisions,
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
