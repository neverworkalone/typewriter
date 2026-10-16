import {
  getRelationGroupDefinition,
  getRelationGroupId,
  RELATION_GROUP_DEFINITIONS,
  UI_GROUP_IDS,
} from './relation-groups.js';
import { isPagedRelationGroup } from './relation-paging.js';
import { compareMeaningRank, partitionMeanings } from '../runtime/meaning-ranking.js';

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

function projectDefinition(sense) {
  return {
    id: UI_GROUP_IDS.definition,
    idKey: UI_GROUP_IDS.definition,
    label: getRelationGroupDefinition(UI_GROUP_IDS.definition).label,
    kind: 'definition',
    items: [{
      id: sense.id,
      sourceSenseId: sense.id,
      text: sense.gloss,
      gloss: sense.gloss,
    }],
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

  // Meaning view only: precomputed ranking counts and the source senses kept as evidence.
  const meaningFields = Number.isInteger(sense.lexical_relation_count)
    ? {
      lexical_relation_count: sense.lexical_relation_count,
      exploratory_relation_count: sense.exploratory_relation_count,
      senseIds: Array.isArray(sense.sense_ids) ? [...sense.sense_ids] : [],
    }
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
  const visibleSenses = senseId && projectedSenses.some(({ id }) => id === senseId)
    ? projectedSenses.filter(({ id }) => id === senseId)
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

const isMeaningSense = (sense) => Number.isInteger(sense.lexical_relation_count);

/**
 * Collapse the records of one lemma (homonyms) into a single result whose senses are the lemma's meanings in
 * display order, with the default view (`primarySenseIds`, at most 3) and the 더보기 remainder (`moreSenseIds`).
 * Raw-sense records (no meaning counts) are returned unchanged.
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
    const { ordered, primary, more } = partitionMeanings(meanings);
    return [{
      ...group[0],
      searchForms: [...new Set(group.flatMap(({ searchForms }) => searchForms))],
      senses: ordered,
      hasRelations: ordered.some(({ hasRelations }) => hasRelations),
      primarySenseIds: primary.map(({ id }) => id),
      moreSenseIds: more.map(({ id }) => id),
    }];
  }).flat();
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
  return mergeMeaningRecords(projected);
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
