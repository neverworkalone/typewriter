import path from 'node:path';

import { createCanonicalContext } from '../validate/canonical-context.mjs';
import { deepFreezeJson } from './immutable-digest.mjs';
import { createCanonicalAuditCache } from '../validate/semantic-audit.mjs';

/**
 * One revision-bound validation context for validators that run lexical
 * production once per historical batch against the same complete prospective
 * canonical and the same complete semantic audit.
 *
 * Passing this as `canonicalContext` lets shared admission reuse the record
 * indexes, surface-form projection, semantic-audit digests and topic projection
 * across batches. Every batch still runs its own source, decision-source, HOLD,
 * base-preservation, stage-evidence and payload checks, and a context is only
 * honored when it is the exact same prospective record array and audit object
 * (admission falls back to full recomputation otherwise).
 */
export function createSharedAdmissionContext(canonical, semanticAudit, {
  canonicalDirectory,
} = {}) {
  // Frozen inputs make digest reuse across batches sound (see immutable-digest.mjs).
  deepFreezeJson(canonical.records);
  deepFreezeJson(semanticAudit);
  const context = createCanonicalContext(canonical, {
    canonicalDirectory: path.resolve(canonicalDirectory),
  });
  context.semanticAudit = semanticAudit;
  context.semanticAuditCache = createCanonicalAuditCache(canonical.records);
  return context;
}
