export const UI_GROUP_IDS = Object.freeze({
  definition: 'definition',
  synonyms: 'synonyms',
  antonyms: 'antonyms',
  texture: 'texture',
  association: 'association',
});

export const RELATION_GROUP_DEFINITIONS = Object.freeze([
  Object.freeze({
    id: UI_GROUP_IDS.definition,
    label: '뜻풀이',
    relationTypes: Object.freeze([]),
  }),
  Object.freeze({
    id: UI_GROUP_IDS.synonyms,
    label: '유의어',
    relationTypes: Object.freeze(['direct']),
  }),
  Object.freeze({
    id: UI_GROUP_IDS.antonyms,
    label: '반의어',
    relationTypes: Object.freeze(['antonym']),
  }),
  Object.freeze({
    id: UI_GROUP_IDS.texture,
    label: '말의 결',
    relationTypes: Object.freeze(['near', 'mood']),
  }),
  Object.freeze({
    id: UI_GROUP_IDS.association,
    label: '연상',
    relationTypes: Object.freeze(['scene', 'sensory', 'action', 'association']),
  }),
]);

export const RELATION_TYPE_TO_GROUP = Object.freeze({
  direct: UI_GROUP_IDS.synonyms,
  antonym: UI_GROUP_IDS.antonyms,
  near: UI_GROUP_IDS.texture,
  mood: UI_GROUP_IDS.texture,
  scene: UI_GROUP_IDS.association,
  sensory: UI_GROUP_IDS.association,
  action: UI_GROUP_IDS.association,
  association: UI_GROUP_IDS.association,
});

export const RELATION_TYPES = Object.freeze(Object.keys(RELATION_TYPE_TO_GROUP));

export function getRelationGroupId(relationType) {
  return RELATION_TYPE_TO_GROUP[relationType] || null;
}

export function getRelationGroupDefinition(groupId) {
  return RELATION_GROUP_DEFINITIONS.find(({ id }) => id === groupId) || null;
}
