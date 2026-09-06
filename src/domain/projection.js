import {
  getRelationGroupDefinition,
  getRelationGroupId,
  RELATION_GROUP_DEFINITIONS,
  UI_GROUP_IDS,
} from './relation-groups.js';

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

function projectRelationGroup(groupDefinition, relations) {
  const items = relations.filter(({ groupId }) => groupId === groupDefinition.id);
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

  return {
    id: sense.id,
    pos: sense.pos,
    gloss: sense.gloss,
    hasRelations: relations.length > 0,
    relations,
    unmappedRelations: relations.filter(({ groupId }) => groupId === null),
    activeGroupIds: groups.map(({ id }) => id),
    groups,
    relationGroups,
  };
}

export function projectRecord(record, { match = null } = {}) {
  const senses = Array.isArray(record.senses) ? record.senses : [];
  const projectedSenses = senses.map(projectSense);
  const projected = {
    id: record.id,
    recordType: record.record_type,
    role: record.role,
    candidateId: copyNullable(record.candidate_id),
    lemma: record.lemma,
    searchForms: Array.isArray(record.search_forms) ? [...record.search_forms] : [],
    senses: projectedSenses,
    hasRelations: projectedSenses.some((sense) => sense.hasRelations),
    match,
  };

  return projected;
}

export function projectSearchResults(records) {
  return records
    .filter((record) => record.role !== 'reference-only')
    .map((record, position) => projectRecord(record, {
      match: {
        kind: 'exact',
        position,
      },
    }));
}

export function projectRelationTarget(record, context = {}) {
  return projectRecord(record, {
    match: {
      kind: 'relation-target',
      ...context,
    },
  });
}

export { getRelationGroupId };
