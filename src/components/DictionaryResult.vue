<script setup>
import { computed, ref } from 'vue';

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
  showBack: {
    type: Boolean,
    default: false,
  },
  candidateOptions: {
    type: Array,
    default: () => [],
  },
  selectedRecordId: {
    type: String,
    default: null,
  },
  selectedSenseId: {
    type: String,
    default: null,
  },
});

const emit = defineEmits([
  'relation',
  'back',
  'select-candidate',
  'candidate-focus',
  'candidate-keydown',
]);

const senses = computed(() => (Array.isArray(props.record.senses) ? props.record.senses : []));
const settings = computed(() => props.settings || DEFAULT_SETTINGS);
const showCandidatePicker = computed(() => props.candidateOptions.length > 1);
const selectedCandidateKey = computed(() => {
  if (!showCandidatePicker.value) return null;

  const selected = props.candidateOptions.find((option) => (
    option.recordId === props.selectedRecordId
    && option.senseId === props.selectedSenseId
  ));
  return selected?.key || props.candidateOptions[0]?.key || null;
});
const selectedSense = computed(() => {
  if (!showCandidatePicker.value) return null;

  const selectedOption = props.candidateOptions.find(({ key }) => (
    key === selectedCandidateKey.value
  ));
  return senses.value.find(({ id }) => id === selectedOption?.senseId)
    || senses.value[0]
    || null;
});
const visibleSenses = computed(() => {
  if (!showCandidatePicker.value) return senses.value;
  return selectedSense.value ? [selectedSense.value] : [];
});
const isPolysemous = computed(() => visibleSenses.value.length > 1);
const hasVisibleSenseRelations = computed(() => (
  visibleSenses.value.some((sense) => sense.hasRelations)
));
const candidateRefs = new Map();

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

function setCandidateRef(key, element) {
  if (element) {
    candidateRefs.set(key, element);
  } else {
    candidateRefs.delete(key);
  }
}

function focusCandidate(key) {
  candidateRefs.get(key)?.focus?.();
}

defineExpose({ focusCandidate });
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
      <button
        v-if="showBack"
        class="back-button"
        type="button"
        aria-label="이전 결과로 돌아가기"
        @click="emit('back')"
      >← 뒤로</button>
    </header>
    <div v-if="!showCandidatePicker" class="result-divider" aria-hidden="true"></div>

    <div
      v-if="showCandidatePicker"
      class="candidate-list"
      role="listbox"
      aria-label="검색 후보"
    >
      <button
        v-for="(option, optionIndex) in candidateOptions"
        :key="option.key"
        :ref="(element) => setCandidateRef(option.key, element)"
        class="candidate-option"
        :class="{ 'is-selected': option.key === selectedCandidateKey }"
        :id="`search-candidate-${option.key}`"
        :data-record-id="option.recordId"
        :data-sense-id="option.senseId || undefined"
        role="option"
        type="button"
        tabindex="-1"
        :aria-selected="String(option.key === selectedCandidateKey)"
        :aria-posinset="optionIndex + 1"
        :aria-setsize="candidateOptions.length"
        @focus="emit('candidate-focus', option)"
        @keydown="emit('candidate-keydown', { option, event: $event })"
        @click="emit('select-candidate', option)"
      >
        <span class="candidate-indicator" aria-hidden="true"></span>
        <span class="candidate-label">{{ option.label }}</span>
      </button>
    </div>

    <div v-if="senses.length === 0" class="result-no-senses">
      표시할 뜻풀이가 없습니다.
    </div>

    <section
      v-for="(sense, senseIndex) in visibleSenses"
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

    <p
      v-if="record.role === 'start' && !hasVisibleSenseRelations"
      class="editorial-gap-note"
      data-editorial-gap
    >연결된 관계어는 아직 정리되지 않았습니다.</p>
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
  gap: 16px;
  align-items: center;
  overflow: hidden;
}

.result-header h2 {
  margin: 0;
  font-size: 20px;
  font-weight: 700;
  line-height: 28px;
  white-space: nowrap;
}

.back-button {
  flex: 0 0 auto;
  padding: 0;
  border: 0;
  background: transparent;
  color: #7e433e;
  cursor: pointer;
  font: inherit;
  font-size: 14px;
  font-weight: 500;
  line-height: 17px;
  white-space: nowrap;
}

.back-button:focus-visible {
  outline: 2px solid #7e433e;
  outline-offset: 2px;
  border-radius: 2px;
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

.candidate-list {
  display: flex;
  width: max-content;
  min-width: 200px;
  max-width: 100%;
  flex-direction: column;
  gap: 1px;
  align-self: flex-start;
  margin: 8px 0 9px;
  padding: 2px 10px 2px 9px;
  border: 1px solid #e1ddda;
  border-radius: 8px;
  background: #fff;
}

.candidate-option {
  display: flex;
  width: 100%;
  min-height: 20px;
  align-items: center;
  gap: 5px;
  padding: 2px 0 2px 7px;
  border: 0;
  background: transparent;
  color: #7e433e;
  cursor: pointer;
  font: inherit;
  font-size: 13px;
  line-height: normal;
  overflow-wrap: anywhere;
  text-align: left;
}

.candidate-option.is-selected {
  color: #2b2927;
  font-weight: 500;
}

.candidate-indicator {
  flex: 0 0 2px;
  width: 2px;
  height: 16px;
  border-radius: 1px;
  background: transparent;
}

.candidate-option.is-selected .candidate-indicator {
  background: #e5534b;
}

.candidate-label {
  min-width: 0;
  overflow-wrap: anywhere;
}

.candidate-option:focus-visible {
  outline: 2px solid #7e433e;
  outline-offset: 2px;
  border-radius: 2px;
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
.no-visible-groups,
.editorial-gap-note {
  margin: 0;
  color: #77716b;
  font-size: 13px;
  line-height: 20px;
}

.editorial-gap-note {
  margin-top: 8px;
  font-size: 12px;
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

.dictionary-result.is-compact .back-button {
  font-size: 12.25px;
  line-height: 15px;
}

.dictionary-result.is-compact .result-divider {
  margin: 7px 0;
}

.dictionary-result.is-compact .candidate-list {
  min-width: 175px;
  gap: 0.875px;
  margin: 7px 0;
  padding: 1.75px 8.75px 1.75px 7.875px;
  border-radius: 7px;
}

.dictionary-result.is-compact .candidate-option {
  min-height: 17.5px;
  gap: 4.375px;
  padding: 1.75px 0 1.75px 6.125px;
  font-size: 11.375px;
}

.dictionary-result.is-compact .candidate-indicator {
  flex-basis: 1.75px;
  width: 1.75px;
  height: 14px;
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

.dictionary-result.is-compact .editorial-gap-note {
  margin-top: 7px;
  font-size: 10.5px;
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
