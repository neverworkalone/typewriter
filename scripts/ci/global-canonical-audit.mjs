import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { contextSummary, loadCanonicalContext } from '../validate/canonical-context.mjs';
import { validateDatasetRecords } from '../validate/dataset-integrity.mjs';
import { auditCanonicalLexicalQuality } from '../validate/lexical-quality.mjs';
import {
  buildCanonicalSemanticAudit,
  buildSemanticTopicEvidence,
} from '../validate/semantic-audit.mjs';
import { validateTargetInventory } from '../validate/target-inventory.mjs';
import {
  buildSurfaceFormProjection,
  loadSurfaceFormExceptionManifest,
} from '../inflection/surface-form-projection.mjs';

export async function runGlobalCanonicalAudit({ canonicalContext } = {}) {
  const context = canonicalContext ?? await loadCanonicalContext();
  let semanticAudit = context.semanticAudit;
  if (!semanticAudit) {
    ({ artifact: semanticAudit } = await buildCanonicalSemanticAudit({
      canonicalContext: context,
    }));
    context.semanticAudit = semanticAudit;
  }

  const topicEvidence = context.derived.topicEvidence
    ?? buildSemanticTopicEvidence(context.records, semanticAudit, {
      hashCache: context.semanticAuditCache,
    });
  context.derived.topicEvidence = topicEvidence;
  const lexicalQuality = context.derived.lexicalQuality
    ?? auditCanonicalLexicalQuality(context.records, {
      context,
      topicEvidence,
      scope: 'complete-canonical',
      throwOnError: false,
    });
  context.derived.lexicalQuality = lexicalQuality;

  const indexes = validateDatasetRecords(context.records, {
    context,
    checkPilotCompleteness: true,
    semanticAudit,
    requireSemanticAudit: true,
    lexicalQuality,
  });
  const inventory = await validateTargetInventory({
    canonicalContext: context,
    semanticAudit,
    lexicalQuality,
    checkPilotCompleteness: true,
  });
  const surfaceFormExceptionManifest = context.derived.surfaceFormExceptionManifest
    ?? await loadSurfaceFormExceptionManifest();
  context.derived.surfaceFormExceptionManifest = surfaceFormExceptionManifest;
  const surfaceFormProjection = context.derived.surfaceFormProjection
    ?? buildSurfaceFormProjection(context.records, {
      exceptionManifest: surfaceFormExceptionManifest,
      requireExceptionTargets: true,
    });
  context.derived.surfaceFormProjection = surfaceFormProjection;

  return {
    contract_version: 'global-canonical-audit-v1',
    context: contextSummary(context),
    validation: {
      record_count: context.records.length,
      sense_count: context.statistics.senseCount,
      relation_count: context.statistics.relationCount,
      candidate_count: indexes.candidatesById.size,
      lexical_blocking_finding_count: lexicalQuality.blocking_finding_count,
      semantic_audit_complete: true,
      target_inventory_revision: inventory.revision,
      target_inventory_entry_count: inventory.inventoryEntryCount,
      surface_form_eligible_sense_count: surfaceFormProjection.coverage.eligible_sense_count,
      generated_surface_form_count: surfaceFormProjection.coverage.generated_surface_form_count,
      surface_form_exclusion_count: surfaceFormProjection.coverage.excluded_rule_count,
      surface_form_exact_collision_count: surfaceFormProjection.coverage.exact_collision_form_count,
      surface_form_ambiguous_form_count: surfaceFormProjection.coverage.ambiguous_generated_form_count,
    },
  };
}

async function main() {
  const result = await runGlobalCanonicalAudit();
  console.log(JSON.stringify(result, null, 2));
}

const isMainModule = process.argv[1]
  && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));

if (isMainModule) {
  main().catch((error) => {
    console.error(error.code ? `${error.code}: ${error.message}` : error.message);
    process.exitCode = 1;
  });
}
