import {
  getRelationGroupDefinition,
  getRelationGroupId,
  RELATION_GROUP_DEFINITIONS,
  UI_GROUP_IDS,
} from './relation-groups.js';
import { isPagedRelationGroup } from './relation-paging.js';
import { compareMeaningOrder, partitionCandidates } from '../runtime/meaning-order.js';

function copyNullable(value) {
  return value === undefined ? null : value;
}

export function projectRelation(relation, sourceSenseId, sourcePosition) {
  const canonicalType = relation.type;
  const groupId = getRelationGroupId(canonicalType);

  return {
    id: `${sourceSenseId}:${sourcePosition}`,
    sourceSenseId,
    sourcePosition,
    targetId: relation.target,
    targetSenseId: copyNullable(relation.target_sense),
    targetLemma: copyNullable(relation.target_lemma),
    targetPos: copyNullable(relation.target_pos),
    targetGloss: copyNullable(relation.target_gloss),
    label: copyNullable(relation.target_lemma),
    text: copyNullable(relation.target_lemma),
    canonicalType,
    type: canonicalType,
    groupId,
    note: copyNullable(relation.note),
    relevance: copyNullable(relation.relevance),
    action: {
      type: 'open-relation-target',
      targetRecordId: relation.target,
    },
  };
}

// A record-based meaning (Issue #820) stores its source glosses one per line; each is one definition item.
function projectDefinition(sense) {
  const glosses = typeof sense.gloss === 'string' ? sense.gloss.split('\n') : [];
  const items = glosses.map((gloss, index) => ({
    id: glosses.length === 1 ? sense.id : `${sense.id}:${index}`,
    sourceSenseId: sense.id,
    text: gloss,
    gloss,
  }));
  return {
    id: UI_GROUP_IDS.definition,
    idKey: UI_GROUP_IDS.definition,
    label: getRelationGroupDefinition(UI_GROUP_IDS.definition).label,
    kind: 'definition',
    items,
  };
}

// relevance is ordinal editorial priority (1 first); source position only
// breaks ties and carries no semantic meaning. Missing relevance sorts last.
function compareByRelevance(a, b) {
  return (a.relevance ?? Infinity) - (b.relevance ?? Infinity)
    || a.sourcePosition - b.sourcePosition;
}

function projectRelationGroup(groupDefinition, relations) {
  const items = relations.filter(({ groupId }) => groupId === groupDefinition.id);
  if (isPagedRelationGroup(groupDefinition.id)) {
    items.sort(compareByRelevance);
  }
  if (items.length === 0) {
    return null;
  }

  return {
    id: groupDefinition.id,
    idKey: groupDefinition.id,
    label: groupDefinition.label,
    kind: 'relations',
    relationTypes: [...groupDefinition.relationTypes],
    items,
  };
}

export function projectSense(sense) {
  const sourceRelations = Array.isArray(sense.relations) ? sense.relations : [];
  const relations = sourceRelations.map((relation, sourcePosition) => (
    projectRelation(
      relation,
      sense.id,
      Number.isInteger(relation.position) ? relation.position : sourcePosition,
    )
  ));
  const groups = [projectDefinition(sense)];

  for (const groupDefinition of RELATION_GROUP_DEFINITIONS.slice(1)) {
    const group = projectRelationGroup(groupDefinition, relations);
    if (group) {
      groups.push(group);
    }
  }

  const relationGroups = Object.fromEntries(
    groups
      .filter(({ kind }) => kind === 'relations')
      .map((group) => [group.id, group]),
  );

  // Meaning view only: the STDICT homograph number (display order) and the source senses kept as evidence.
  const meaningFields = Array.isArray(sense.sense_ids)
    ? { homograph_no: sense.homograph_no ?? null, senseIds: [...sense.sense_ids] }
    : {};

  return {
    id: sense.id,
    pos: sense.pos,
    gloss: sense.gloss,
    ...meaningFields,
    hasRelations: relations.length > 0,
    relations,
    unmappedRelations: relations.filter(({ groupId }) => groupId === null),
    activeGroupIds: groups.map(({ id }) => id),
    groups,
    relationGroups,
  };
}

export function projectRecord(record, {
  match = null,
  senseId = null,
  senseIds = null,
} = {}) {
  const senses = Array.isArray(record.senses) ? record.senses : [];
  const projectedSenses = senses.map(projectSense);
  const licensed = (sense) => senseIds.includes(sense.id)
    || (sense.senseIds ?? []).some((memberId) => senseIds.includes(memberId));
  // A requested sense may be the meaning itself or one of its source senses (older links, duplicate senses).
  const requested = (sense) => sense.id === senseId || (sense.senseIds ?? []).includes(senseId);
  const visibleSenses = senseId && projectedSenses.some(requested)
    ? projectedSenses.filter(requested)
    : Array.isArray(senseIds)
      ? projectedSenses.filter(licensed)
      : projectedSenses;
  const projected = {
    id: record.id,
    recordType: record.record_type,
    role: record.role,
    candidateId: copyNullable(record.candidate_id),
    lemma: record.lemma,
    searchForms: Array.isArray(record.search_forms) ? [...record.search_forms] : [],
    senses: visibleSenses,
    isMeaningView: record.view === 'meaning',
    hasRelations: visibleSenses.some((sense) => sense.hasRelations),
    match,
  };

  return projected;
}

const isMeaningSense = (sense) => Array.isArray(sense.senseIds);

/**
 * Collapse the records of one lemma (homonyms) into a single result whose senses are the lemma's meanings in
 * STDICT compilation order. The result keeps the position of the lemma's first record, so the match order of
 * different lemmas is unchanged. Raw-sense records (no meaning evidence) are returned unchanged.
 */
function mergeMeaningRecords(records) {
  const byLemma = new Map();
  for (const record of records) {
    const group = byLemma.get(record.lemma);
    if (group) group.push(record);
    else byLemma.set(record.lemma, [record]);
  }

  return [...byLemma.values()].map((group) => {
    // A meaning appears in every record that contributes a member sense; keep it once.
    const meanings = [...new Map(
      group.flatMap(({ senses }) => senses).map((meaning) => [meaning.id, meaning]),
    ).values()];
    if (meanings.length === 0 || !meanings.every(isMeaningSense)) {
      return group;
    }
    return [{
      ...group[0],
      searchForms: [...new Set(group.flatMap(({ searchForms }) => searchForms))],
      senses: [...meanings].sort(compareMeaningOrder),
      hasRelations: meanings.some(({ hasRelations }) => hasRelations),
    }];
  }).flat();
}

/**
 * One default/더보기 split for the whole search: the first three candidates in display order (match order, then
 * STDICT order within a lemma) are the default view (`primarySenseIds`); all others are `moreSenseIds`. The split is
 * made across every matched record, not per lemma, and does not depend on any relation.
 */
function partitionAcrossRecords(records) {
  const meaningRecords = records.filter(({ senses }) => senses.length > 0 && senses.every(isMeaningSense));
  const { primary } = partitionCandidates(meaningRecords.flatMap(({ senses }) => senses));
  const primaryIds = new Set(primary.map(({ id }) => id));
  return records.map((record) => {
    if (!meaningRecords.includes(record)) return record;
    return {
      ...record,
      primarySenseIds: record.senses.filter(({ id }) => primaryIds.has(id)).map(({ id }) => id),
      moreSenseIds: record.senses.filter(({ id }) => !primaryIds.has(id)).map(({ id }) => id),
    };
  });
}

export function projectSearchResults(records, matches = null) {
  const matchById = Array.isArray(matches)
    ? new Map(matches.map((summary) => [summary.id, summary.match || null]))
    : null;

  const projected = records
    .map((record, position) => {
      const match = matchById?.has(record.id)
        ? matchById.get(record.id)
        : {
          kind: 'exact',
          position,
        };
      return projectRecord(record, {
        match,
        senseIds: match?.kind === 'generated-surface-form'
          ? match.senseIds
          : null,
      });
    })
    // Meaning is the candidate unit: a record with no meaning (every sense dropped, e.g. out_of_scope) has
    // nothing to show and is not a candidate. Raw-sense records keep their existing behaviour.
    .filter((record) => !record.isMeaningView || record.senses.length > 0);
  return partitionAcrossRecords(mergeMeaningRecords(projected));
}

export function projectRelationTarget(record, context = {}) {
  return projectRecord(record, {
    match: {
      kind: 'relation-target',
      ...context,
    },
    senseId: context.targetSenseId ?? null,
  });
}

export { getRelationGroupId };
