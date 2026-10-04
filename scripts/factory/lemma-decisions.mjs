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
// The extractor cannot tell sense directions apart (its evidence carries no `usage_group`), so a
// usage group can hold several distinguishable sense opportunities. Stage 2 therefore may split one
// group into several entries, each naming the `observation_ids` it judges; the entries of a group
// must partition its observations, so each evidence-backed opportunity gets its own disposition
// (include, cover, reject or defer) with its own reason, resolution and sense claims. A group with
// one entry and no `observation_ids` covers all of its observations.
//
// Stage 1 never concludes `covered` from spelling or POS; only this validated disposition does.
export const GROUP_DISPOSITIONS = Object.freeze(['included', 'covered', 'search_coverage', 'rejected', 'deferred']);
const ADMITTED = new Set(['included', 'corrected']);
const isText = (value) => typeof value === 'string' && value.trim().length > 0;
const formSupported = (lemma, surface, entryIds, support) => surface === lemma || entryIds.some((id) => support.get(id)?.has(surface));

// Pairs every decision entry with its group and the observations it judges. Returns
// { errors, entries: [{entry, group, members}] }; entries of one group are contiguous and, if the
// group is split, partition its observations exactly.
export function resolveGroupEntries(row, candidate) {
  const at = `decision ${row.source_candidate_id}`;
  const decisions = row.group_decisions;
  if (!Array.isArray(decisions)) return { errors: [`${at}: group_decisions must account for every usage group`], entries: [] };
  const order = [];
  for (const entry of decisions) if (order.at(-1) !== entry?.group_id) order.push(entry?.group_id);
  if (JSON.stringify(order) !== JSON.stringify(candidate.usage_groups.map((group) => group.group_id))) {
    return { errors: [`${at}: group_decisions must hold entries for every usage group, in order, each group contiguous`], entries: [] };
  }
  const errors = [];
  const entries = [];
  for (const group of candidate.usage_groups) {
    const block = decisions.filter((entry) => entry.group_id === group.group_id);
    const all = candidate.observations.filter((observation) => observation.group_id === group.group_id);
    if (block.length === 1 && block[0].observation_ids === undefined) {
      entries.push({ entry: block[0], group, members: all });
      continue;
    }
    const claimed = new Set();
    for (const entry of block) {
      const here = `${at} group ${group.group_id}`;
      const ids = entry.observation_ids;
      if (!Array.isArray(ids) || ids.length === 0 || new Set(ids).size !== ids.length) { errors.push(`${here}: a split group needs non-empty, unique observation_ids on every entry`); continue; }
      const members = ids.map((id) => all.find((observation) => observation.observation_id === id));
      if (members.some((member) => !member)) { errors.push(`${here}: observation_ids must name observations of this group`); continue; }
      if (ids.some((id) => claimed.has(id))) errors.push(`${here}: an observation is judged by more than one entry`);
      ids.forEach((id) => claimed.add(id));
      entries.push({ entry, group, members });
    }
    const missing = all.filter((observation) => !claimed.has(observation.observation_id)).map((observation) => observation.observation_id);
    if (missing.length) errors.push(`${at} group ${group.group_id}: observations ${missing.join(', ')} are not judged by any entry`);
  }
  return { errors, entries };
}

// `canonicalIndex`/`support` bind the canonical proofs and are supplied while admission is pending.
export function validateLemmaDecision(row, candidate, { canonicalIndex, support } = {}) {
  const at = `decision ${row.source_candidate_id}`;
  const resolved = resolveGroupEntries(row, candidate);
  const errors = [...resolved.errors];
  if (errors.length && resolved.entries.length === 0) return errors;
  const surfaceOf = new Map(candidate.forms.map((form) => [form.form_id, form.surface]));
  const admitted = ADMITTED.has(row.disposition);
  const senses = row.reviewed_record?.senses ?? [];
  const claimed = new Set();
  let includedCount = 0;
  resolved.entries.forEach(({ entry, group, members }) => {
    const here = `${at} group ${group.group_id}`;
    if (!GROUP_DISPOSITIONS.includes(entry.disposition)) { errors.push(`${here}: disposition must be one of ${GROUP_DISPOSITIONS.join(', ')}`); return; }
    if (!isText(entry.reason)) errors.push(`${here}: a candidate-specific reason is required`);
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
