import { resolveGroupEntries } from './lemma-decisions.mjs';

// Source-bound evidence scope of every admitted sense of a lemma-centered Stage 2 decision.
//
// A reviewed gloss may only describe the observations its included usage groups claim. Whether a
// gloss semantically leaks into an observation that was deferred, rejected or mapped to an
// existing canonical sense is a judgment, so the contract makes the author state the scope and
// checks everything that is mechanically checkable:
//
//   scope_declaration: {
//     admitted_observation_ids: observations of the included groups that claim this sense,
//     excluded_observation_ids: every other observation of the candidate,
//     excluded_terms:           words naming the excluded meaning, which the gloss must not use
//   }
//
// - both id lists must equal the ones derived from the decision's group_decisions;
// - while observations are excluded, at least one term is required, each term must occur in the
//   authored reason of an entry that judges an excluded observation (so it is source-bound), and
//   no term may occur in the sense gloss;
// - a term must DENOTE the excluded meaning, not merely be a word that happens to occur: it may not be
//   a generic placeholder (쓰임, 뜻, …) nor an observed surface form or the lemma itself (optionally with
//   a particle): those occur in the reason because of the sentence, not because they name a meaning.
//   Whether a term names the right meaning stays a source-bound editorial judgment; these are only
//   the mechanically refutable placeholders;
// - without excluded observations the term list must be empty.
export const SCOPE_DECLARATION_FIELD = 'scope_declaration';

const isText = (value) => typeof value === 'string' && value.trim().length > 0;
const norm = (value) => String(value).normalize('NFC');
const same = (left, right) => JSON.stringify(left) === JSON.stringify(right);

// Words that never name a meaning. They appear in almost any authored reason, so they cannot bind a gloss.
export const GENERIC_SCOPE_TERMS = Object.freeze(['쓰임', '뜻', '의미', '경우', '용법', '관찰', '판단', '보류', '제외', '포함', '확인']);
const PARTICLE = /(이|가|을|를|은|는|의|에|에서|로|으로|과|와|도|만)$/u;
const stripParticle = (word) => { const bare = word.replace(PARTICLE, ''); return bare.length >= 2 ? bare : word; };

// Per reviewed sense: the observations it may describe, the others, and the reasons that judge them.
export function expectedScopes(decision, candidate) {
  const { entries } = resolveGroupEntries(decision, candidate);
  const all = candidate.observations.map((observation) => observation.observation_id);
  return (decision.reviewed_record?.senses ?? []).map((_, index) => {
    const claims = entries.filter(({ entry }) => entry.disposition === 'included' && Array.isArray(entry.sense_indexes) && entry.sense_indexes.includes(index));
    const admitted = [...new Set(claims.flatMap(({ members }) => members.map((observation) => observation.observation_id)))].sort();
    const excluded = all.filter((id) => !admitted.includes(id)).sort();
    const reasons = entries
      .filter(({ members }) => members.some((observation) => excluded.includes(observation.observation_id)))
      .map(({ entry }) => norm(entry.reason ?? ''));
    return { admitted, excluded, reasons };
  });
}

export function validateScopeDeclarations({ decision, candidate, senseReviews, required = false }) {
  const errors = [];
  const id = decision.source_candidate_id;
  const scopes = expectedScopes(decision, candidate);
  const senses = decision.reviewed_record?.senses ?? [];
  senses.forEach((sense, index) => {
    const at = `semantic decision ${id} sense ${index + 1}`;
    const declaration = senseReviews?.[index]?.[SCOPE_DECLARATION_FIELD];
    if (declaration === undefined) {
      if (required) errors.push(`${at}: ${SCOPE_DECLARATION_FIELD} is required so the gloss is bound to the observations it may describe`);
      return;
    }
    if (declaration === null || typeof declaration !== 'object' || Array.isArray(declaration)) {
      errors.push(`${at}: ${SCOPE_DECLARATION_FIELD} must be an object`);
      return;
    }
    const unknown = Object.keys(declaration).filter((key) => !['admitted_observation_ids', 'excluded_observation_ids', 'excluded_terms'].includes(key));
    if (unknown.length) errors.push(`${at}: ${SCOPE_DECLARATION_FIELD} has unknown fields ${unknown.join(', ')}`);
    const { admitted, excluded, reasons } = scopes[index];
    if (!same(declaration.admitted_observation_ids, admitted)) {
      errors.push(`${at}: admitted_observation_ids must be exactly the observations of the included groups that claim this sense (${admitted.join(', ')})`);
    }
    if (!same(declaration.excluded_observation_ids, excluded)) {
      errors.push(`${at}: excluded_observation_ids must be exactly the other observations of the candidate (${excluded.join(', ') || 'none'})`);
    }
    const terms = declaration.excluded_terms;
    if (!Array.isArray(terms) || terms.some((term) => !isText(term)) || new Set(terms.map(norm)).size !== terms.length) {
      errors.push(`${at}: excluded_terms must be a list of distinct, non-empty words`);
      return;
    }
    if (excluded.length === 0) {
      if (terms.length) errors.push(`${at}: excluded_terms must be empty while no observation is excluded`);
      return;
    }
    if (terms.length === 0) errors.push(`${at}: excluded observations ${excluded.join(', ')} require excluded_terms naming the meaning the gloss must not describe`);
    const gloss = norm(sense.gloss);
    const observed = new Set([candidate.input, ...(candidate.forms ?? []).map((form) => form.surface)].filter(Boolean).map((word) => norm(word)));
    const observedBare = new Set([...observed].map(stripParticle));
    for (const term of terms) {
      const word = norm(term).trim();
      if (gloss.includes(word)) errors.push(`${at}: the gloss contains the excluded term ${term}; it describes a meaning outside its admitted observations`);
      if (!reasons.some((reason) => reason.includes(word))) errors.push(`${at}: excluded term ${term} does not occur in the reason that judges an excluded observation`);
      if (GENERIC_SCOPE_TERMS.includes(word)) errors.push(`${at}: excluded term ${term} is a generic placeholder and does not name the excluded meaning`);
      else if (observed.has(word) || observedBare.has(stripParticle(word))) errors.push(`${at}: excluded term ${term} is an observed form or the lemma, not the excluded meaning`);
    }
  });
  return errors;
}
