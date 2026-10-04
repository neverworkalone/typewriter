import { REVIEWABLE_HOLDS } from '../intake/production-handoff.mjs';

// Stage 2 decision rows for lemma-centered candidates (issue #275). A candidate is one lemma, so
// its decision row also accounts for every usage group (prospective sense opportunity): no
// opportunity may disappear without an auditable group disposition.
//
//   included          the group's POS/sense is authored; `sense_indexes` names the reviewed senses
//   covered           proven already canonical: same lemma and POS sense (`existing_sense_id`) AND
//                     every observed form of the group is already a supported search form
//   search_coverage   meaning already canonical but listed `forms` are not supported search forms:
//                     the search/morphology coverage route, never a new lexical entry
//   rejected|deferred reason required
//
// Stage 1 never concludes `covered` from spelling or POS; only this validated disposition does.
export const GROUP_DISPOSITIONS = Object.freeze(['included', 'covered', 'search_coverage', 'rejected', 'deferred']);
const ADMITTED = new Set(['included', 'corrected']);
const isText = (value) => typeof value === 'string' && value.trim().length > 0;
const formSupported = (lemma, surface, entryIds, support) => surface === lemma || entryIds.some((id) => support.get(id)?.has(surface));

// `canonicalIndex`/`support` bind the canonical proofs and are supplied while admission is pending.
export function validateLemmaDecision(row, candidate, { canonicalIndex, support } = {}) {
  const errors = [];
  const at = `decision ${row.source_candidate_id}`;
  const groups = candidate.usage_groups;
  const decisions = row.group_decisions;
  if (!Array.isArray(decisions)) return [`${at}: group_decisions must account for every usage group`];
  if (JSON.stringify(decisions.map((entry) => entry?.group_id)) !== JSON.stringify(groups.map((group) => group.group_id))) {
    return [`${at}: group_decisions must hold exactly one entry per usage group, in order`];
  }
  const surfaceOf = new Map(candidate.forms.map((form) => [form.form_id, form.surface]));
  const admitted = ADMITTED.has(row.disposition);
  const senses = row.reviewed_record?.senses ?? [];
  const claimed = new Set();
  let includedCount = 0;
  decisions.forEach((entry, index) => {
    const group = groups[index];
    const here = `${at} group ${group.group_id}`;
    if (!GROUP_DISPOSITIONS.includes(entry.disposition)) { errors.push(`${here}: disposition must be one of ${GROUP_DISPOSITIONS.join(', ')}`); return; }
    if (!isText(entry.reason)) errors.push(`${here}: a candidate-specific reason is required`);
    const members = candidate.observations.filter((observation) => observation.group_id === group.group_id);
    if (entry.disposition === 'included') {
      includedCount += 1;
      if (!admitted) errors.push(`${here}: included group under a ${row.disposition} candidate`);
      if (!Array.isArray(entry.sense_indexes) || entry.sense_indexes.length === 0) errors.push(`${here}: sense_indexes must name the reviewed senses`);
      else {
        for (const sense of entry.sense_indexes) {
          if (!Number.isInteger(sense) || !senses[sense]) errors.push(`${here}: sense_indexes names a missing sense`);
          else if (senses[sense].pos !== group.pos) errors.push(`${here}: sense ${sense} is ${senses[sense].pos}, the group is ${group.pos}`);
          else claimed.add(sense);
        }
      }
      // Only this group's own held observations need a resolution; sibling groups never contribute.
      const holds = [...new Set(members.flatMap((observation) => observation.holds))];
      if (holds.some((hold) => !REVIEWABLE_HOLDS.includes(hold))) errors.push(`${here}: hold ${holds.join(', ')} cannot be admitted`);
      if (holds.length && !isText(entry.hold_resolution)) errors.push(`${here}: held observations require a hold_resolution`);
    } else if (entry.sense_indexes !== undefined || entry.hold_resolution !== undefined) {
      errors.push(`${here}: only an included group carries sense_indexes or hold_resolution`);
    }
    if (entry.disposition === 'covered' || entry.disposition === 'search_coverage') {
      if (!canonicalIndex) return;
      const entries = canonicalIndex.get(candidate.input) ?? [];
      const target = entries.find((record) => record.id === entry.existing_entry_id);
      if (!target?.senses.some((sense) => sense.id === entry.existing_sense_id && sense.pos === group.pos)) {
        errors.push(`${here}: ${entry.disposition} requires an existing ${group.pos} sense of ${candidate.input} (existing_entry_id, existing_sense_id)`);
        return;
      }
      if (!support) { errors.push(`${here}: search-form support index is required to prove ${entry.disposition}`); return; }
      const unsupported = [...new Set(members.map((observation) => surfaceOf.get(observation.form_id)))]
        .filter((surface) => !formSupported(candidate.input, surface, [target.id], support));
      if (entry.disposition === 'covered' && unsupported.length) errors.push(`${here}: covered but forms ${unsupported.join(', ')} are not supported search forms; use search_coverage`);
      if (entry.disposition === 'search_coverage'
        && (JSON.stringify([...(entry.forms ?? [])].sort()) !== JSON.stringify(unsupported.sort()) || unsupported.length === 0)) {
        errors.push(`${here}: search_coverage forms must be exactly the unsupported observed forms (${unsupported.join(', ') || 'none'})`);
      }
    }
  });
  if (admitted) {
    if (includedCount === 0) errors.push(`${at}: an admitted candidate needs at least one included group`);
    senses.forEach((_, index) => { if (!claimed.has(index)) errors.push(`${at}: reviewed sense ${index} is not claimed by an included usage group`); });
  } else if (includedCount) {
    errors.push(`${at}: ${row.disposition} candidate must not include a usage group`);
  }
  return errors;
}
