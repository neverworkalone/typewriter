import { createHash } from 'node:crypto';
import path from 'node:path';

import { validateLexicalAddition } from '../../scripts/batch/lexical-admission.mjs';
import { createCanonicalContext } from '../../scripts/validate/canonical-context.mjs';
import { verifyAnalysisBinding } from '../../scripts/intake/pipeline.mjs';
import { makeProductionState, makeSemanticAudit } from './semantic-audit-fixture.mjs';

const FIXTURE_ROOT = path.resolve('tests/fixtures/lexical-quality');

// Fixture-only: predicate senses carry an explicit surface-form exclusion, as
// other synthetic admission tests do; the strict gate itself stays enabled.
function context(records) {
  const infos = records.map((record, index) => ({ record, source: `intake-fixture:${index + 1}` }));
  const result = createCanonicalContext({ records: infos }, { canonicalDirectory: path.join(FIXTURE_ROOT, 'surface-form-canonical'), source: 'fixture' });
  result.derived.surfaceFormExceptionManifest = { schema_version: 1, contract_id: 'm6-2-inflection-exceptions-v1', source_issue: 174, exceptions: [] };
  result.derived.surfaceFormReviewManifest = {
    schema_version: 1,
    contract_id: 'm6-3-searchable-predicate-review-v2',
    source_issue: 209,
    dispositions: records.filter((record) => record.record_type === 'entry').flatMap((record) => record.senses
      .filter((sense) => ['verb', 'adjective'].includes(sense.pos) && record.lemma.endsWith('다'))
      .map((sense) => ({ class_id: 'm6-3-predicate-excluded', record_id: record.id, sense_id: sense.id, reason: 'Synthetic intake fixture does not exercise inflection search.' }))),
    reviewed_collisions: { exact_generated: [], ambiguous_generated: [] },
  };
  return result;
}

// The semantic-QA fixture is bound to the exact hand-off it reviewed: identity
// key, lemma/POS, evidence references and the analysis binding.
export function qaBinding(handoff, { gloss, disposition = 'included' }) {
  return createHash('sha256').update(JSON.stringify(['qa-binding', handoff.key, handoff.lemma, handoff.pos, handoff.adapterIds ?? [], handoff.evidence ?? [], handoff.analysisBinding, disposition, gloss])).digest('hex');
}

// Simulates the QA step: reads each semantic_qa hand-off and records its gloss
// together with the binding of what it reviewed.
export function authorQa(run, glosses) {
  return Object.fromEntries(run.decisions
    .filter((entry) => entry.decision === 'semantic_qa' && glosses[entry.lemma])
    .map((entry) => [entry.lemma, { gloss: glosses[entry.lemma], binding: qaBinding(entry, { gloss: glosses[entry.lemma] }) }]));
}

// Admit hand-offs through the shared lexical admission gate. `authored` maps a
// lemma to the fixture gloss + binding from authorQa; hand-offs without one, or with a hold, are not admitted.
// `tamperAudit` lets a test prove a mismatched QA artifact is rejected.
export function admitHandoffs(run, authored, { batchId = 'intake-e2e-fixture', tamperAudit = false, omitAudit = false } = {}) {
  const records = [];
  for (const handoff of run.decisions.filter((entry) => entry.decision === 'semantic_qa')) {
    verifyAnalysisBinding(handoff, run.metadata);
    const qa = authored[handoff.lemma];
    if (!qa) continue;
    if (qa.binding !== qaBinding(handoff, { gloss: qa.gloss })) {
      const error = new Error(`semantic QA for ${handoff.lemma} is not bound to this hand-off's identity and evidence`);
      error.code = 'QA_HANDOFF_BINDING_MISMATCH';
      throw error;
    }
    const gloss = qa.gloss;
    const id = `w9${String(records.length + 1).padStart(4, '0')}`;
    records.push({ id, record_type: 'entry', role: 'start', candidate_id: id, lemma: handoff.lemma, search_forms: [handoff.lemma], senses: [{ id: `${id}-s1`, pos: handoff.pos, gloss }] });
  }
  return admitRecords(records, { batchId, tamperAudit, omitAudit });
}

// Shared lexical admission over already-assembled records (used by the production-handoff path too).
export function admitRecords(records, { batchId = 'intake-e2e-fixture', tamperAudit = false, omitAudit = false } = {}) {
  const infos = records.map((record) => ({ record, source: 'intake-handoff' }));
  const auditInfos = omitAudit ? [] : tamperAudit ? [{ record: { ...records[0], lemma: '다른말', search_forms: ['다른말'] }, source: 'intake-handoff' }] : infos;
  const semanticAudit = makeSemanticAudit(auditInfos);
  const production = makeProductionState({ batchId, candidateRecords: records, reviewedRecords: infos, prospectiveRecords: infos, semanticAudit });
  const result = validateLexicalAddition({
    batchId,
    candidateRecords: records,
    reviewedRecords: infos,
    baseRecords: [],
    prospectiveRecords: infos,
    semanticAudit,
    productionState: production.state,
    productionStateSources: production.sources,
    productionPayloads: production.payloads,
    canonicalContext: context(records),
  });
  return { records, audit: result.audit };
}
