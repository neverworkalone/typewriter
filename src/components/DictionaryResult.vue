<script setup>
import { computed } from 'vue';

import { DEFAULT_SETTINGS } from '../ui/settings.js';

const props = defineProps({
  record: {
    type: Object,
    required: true,
  },
  settings: {
    type: Object,
    default: () => DEFAULT_SETTINGS,
  },
  compact: {
    type: Boolean,
    default: false,
  },
  interactive: {
    type: Boolean,
    default: true,
  },
});

const emit = defineEmits(['relation']);

const senses = computed(() => (Array.isArray(props.record.senses) ? props.record.senses : []));
const settings = computed(() => props.settings || DEFAULT_SETTINGS);
const isPolysemous = computed(() => senses.value.length > 1);

function isGroupVisible(group) {
  return settings.value[group.id] !== false && Array.isArray(group.items) && group.items.length > 0;
}

function visibleGroups(sense) {
  return (sense.groups || []).filter(isGroupVisible);
}

function relationText(relation) {
  return relation.text || relation.label || relation.targetLemma || relation.targetId;
}

function relationTargetId(relation) {
  return relation.action?.targetRecordId || relation.targetId;
}

function openRelation(relation) {
  if (props.interactive) {
    emit('relation', relation);
  }
}
</script>

<template>
  <article
    class="dictionary-result"
    :class="{ 'is-compact': compact }"
    data-dictionary-record
    :data-record-id="record.id"
    tabindex="-1"
  >
    <header class="result-header">
      <h2>{{ record.lemma }}</h2>
    </header>
    <div class="result-divider" aria-hidden="true"></div>

    <div v-if="senses.length === 0" class="result-no-senses">
      표시할 뜻풀이가 없습니다.
    </div>

    <section
      v-for="(sense, senseIndex) in senses"
      :key="sense.id"
      class="sense-block"
      :class="{ 'is-polysemous': isPolysemous }"
      :data-sense-id="sense.id"
    >
      <div v-if="isPolysemous" class="sense-label">
        뜻 {{ senseIndex + 1 }}<span v-if="sense.pos"> · {{ sense.pos }}</span>
      </div>

      <template v-if="visibleGroups(sense).length > 0">
        <section
          v-for="(group, groupIndex) in visibleGroups(sense)"
          :key="`${sense.id}-${group.id}`"
          class="result-section"
          :class="{ 'is-definition': group.kind === 'definition' }"
          :data-group-id="group.id"
        >
          <h3>{{ group.label }}</h3>
          <p v-if="group.kind === 'definition'" class="definition-text">
            {{ group.items[0].text || group.items[0].gloss }}
          </p>
          <div v-else class="relation-list">
            <template v-for="(relation, relationIndex) in group.items" :key="relation.id">
              <button
                v-if="interactive"
                class="relation-link"
                type="button"
                :data-target-record-id="relationTargetId(relation)"
                :title="relation.note || undefined"
                @click="openRelation(relation)"
              >{{ relationText(relation) }}</button>
              <span v-else class="relation-link is-static">{{ relationText(relation) }}</span>
              <span
                v-if="relationIndex < group.items.length - 1"
                class="relation-separator"
                aria-hidden="true"
              >·</span>
            </template>
          </div>
          <div
            v-if="groupIndex === 0 && group.kind === 'definition'"
            class="definition-divider"
            aria-hidden="true"
          ></div>
        </section>
      </template>
      <p v-else class="no-visible-groups">표시할 항목이 없습니다.</p>
    </section>
  </article>
</template>

<style scoped>
.dictionary-result {
  width: 100%;
  color: #2b2927;
}

.dictionary-result:focus-visible {
  outline: 2px solid #7e433e;
  outline-offset: 3px;
  border-radius: 3px;
}

.result-header {
  display: flex;
  min-height: 28px;
  align-items: flex-start;
  overflow: hidden;
}

.result-header h2 {
  margin: 0;
  font-size: 20px;
  font-weight: 700;
  line-height: 28px;
  white-space: nowrap;
}

.result-divider,
.definition-divider {
  width: 100%;
  height: 1px;
  background: #e1ddda;
}

.result-divider {
  margin: 8px 0;
}

.sense-block + .sense-block {
  margin-top: 12px;
  padding-top: 12px;
  border-top: 1px solid #e1ddda;
}

.sense-label {
  margin-bottom: 6px;
  color: #5f5955;
  font-size: 11px;
  font-weight: 700;
}

.result-section {
  position: relative;
  display: flex;
  flex-direction: column;
  gap: 3px;
  overflow: hidden;
  line-height: 1.35;
}

.result-section + .result-section {
  margin-top: 8px;
}

.result-section h3 {
  margin: 0;
  color: #5f5955;
  font-size: 12px;
  font-weight: 700;
  line-height: 14px;
  white-space: nowrap;
}

.definition-text {
  margin: 0;
  color: #2b2927;
  font-size: 14px;
  line-height: 22px;
  overflow-wrap: anywhere;
}

.definition-divider {
  margin-top: 5px;
}

.relation-list {
  display: flex;
  flex-wrap: wrap;
  align-items: baseline;
  column-gap: 8px;
  row-gap: 4px;
  overflow: hidden;
  white-space: normal;
}

.relation-link {
  padding: 0;
  border: 0;
  background: transparent;
  color: #7e433e;
  cursor: pointer;
  font: inherit;
  font-size: 14px;
  font-weight: 500;
  line-height: 17px;
  text-align: left;
}

.relation-link.is-static {
  cursor: default;
}

.relation-link:focus-visible {
  outline: 2px solid #7e433e;
  outline-offset: 2px;
  border-radius: 2px;
}

.relation-separator {
  margin-left: -4px;
  color: #968f89;
  font-size: 12px;
  line-height: 14px;
}

.result-no-senses,
.no-visible-groups {
  margin: 0;
  color: #77716b;
  font-size: 13px;
  line-height: 20px;
}

.no-visible-groups {
  padding: 4px 0;
}

.dictionary-result.is-compact .result-header {
  min-height: 24.5px;
}

.dictionary-result.is-compact .result-header h2 {
  font-size: 17.5px;
  line-height: 24.5px;
}

.dictionary-result.is-compact .result-divider {
  margin: 7px 0;
}

.dictionary-result.is-compact .result-section {
  gap: 2.625px;
}

.dictionary-result.is-compact .result-section + .result-section {
  margin-top: 7px;
}

.dictionary-result.is-compact .result-section h3 {
  font-size: 10.5px;
  line-height: 13px;
}

.dictionary-result.is-compact .definition-text,
.dictionary-result.is-compact .relation-link {
  font-size: 12.25px;
}

.dictionary-result.is-compact .definition-text {
  line-height: 19.25px;
}

.dictionary-result.is-compact .relation-list {
  column-gap: 7px;
  row-gap: 3.5px;
}

.dictionary-result.is-compact .relation-link {
  line-height: 15px;
}

.dictionary-result.is-compact .relation-separator {
  margin-left: -3.5px;
  font-size: 10.5px;
  line-height: 13px;
}

.dictionary-result.is-compact .definition-divider {
  margin-top: 4.375px;
}

.dictionary-result.is-compact .sense-block + .sense-block {
  margin-top: 10.5px;
  padding-top: 10.5px;
}
</style>
