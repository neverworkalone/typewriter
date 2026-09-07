<script setup>
import { computed, nextTick, ref } from 'vue';

import { SEARCH_MODES, SEARCH_STATUS } from '../domain/search-state.js';
import { SEARCH_UNSUPPORTED_REASONS } from '../runtime/search-query.js';
import { DEFAULT_SETTINGS, getBackgroundPreset } from '../ui/settings.js';
import DictionaryResult from './DictionaryResult.vue';
import ProductFooter from './ProductFooter.vue';
import SearchBar from './SearchBar.vue';

const props = defineProps({
  query: {
    type: String,
    default: '',
  },
  records: {
    type: Array,
    default: () => [],
  },
  status: {
    type: String,
    default: SEARCH_STATUS.idle,
  },
  error: {
    type: Object,
    default: null,
  },
  emptyReason: {
    type: String,
    default: null,
  },
  mode: {
    type: String,
    default: 'idle',
  },
  canGoBack: {
    type: Boolean,
    default: false,
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
  autofocus: {
    type: Boolean,
    default: false,
  },
  selectedRecordId: {
    type: String,
    default: null,
  },
});

const emit = defineEmits([
  'update:query',
  'submit',
  'clear',
  'relation',
  'back',
  'retry',
  'open-settings',
  'select-candidate',
]);

const searchBar = ref(null);
const candidateRefs = new Map();
const resultRefs = new Map();

const EMPTY_REASONS = Object.freeze({
  noExactMatch: 'no-exact-match',
  relationTargetNotFound: 'relation-target-not-found',
});

const isReady = computed(() => (
  props.records.length > 0
  && (props.status === SEARCH_STATUS.ready || props.status === SEARCH_STATUS.loading)
));
const isInitialLoading = computed(() => (
  props.status === SEARCH_STATUS.loading && props.records.length === 0
));
const isRelationTarget = computed(() => isReady.value && props.mode === 'relation-target');
const showBack = computed(() => (
  props.interactive
  && props.canGoBack
  && props.status === SEARCH_STATUS.ready
  && props.mode === SEARCH_MODES.relationTarget
  && props.records.length > 0
));
const candidateListEnabled = computed(() => (
  props.interactive
  && props.mode === SEARCH_MODES.exact
  && props.status === SEARCH_STATUS.ready
  && props.records.length > 1
));
const selectedCandidateIndex = computed(() => (
  props.records.findIndex((record) => record.id === props.selectedRecordId)
));
const backgroundPreset = computed(() => getBackgroundPreset(props.settings?.background));
const statePresentation = computed(() => {
  if (props.status === SEARCH_STATUS.loading) {
    return {
      category: 'loading',
      title: '검색 중입니다.',
      description: '잠시만 기다려 주세요.',
    };
  }

  if (props.status === SEARCH_STATUS.empty) {
    if (props.emptyReason === EMPTY_REASONS.relationTargetNotFound) {
      return {
        category: 'relation-target',
        title: '관계 대상을 찾을 수 없습니다.',
        description: '이 관계어는 현재 사전에서 확인되지 않습니다.',
      };
    }
    if (props.emptyReason === SEARCH_UNSUPPORTED_REASONS.referenceOnly) {
      return {
        category: 'unsupported',
        title: '관계어는 직접 검색할 수 없습니다.',
        description: '검색 결과에서 관계어를 눌러 탐색해 주세요.',
      };
    }
    if (props.emptyReason === SEARCH_UNSUPPORTED_REASONS.internalWhitespace) {
      return {
        category: 'unsupported',
        title: '지원하지 않는 입력 형식입니다.',
        description: '표현은 사전에 등록된 공백 그대로 입력해 주세요.',
      };
    }
    if (props.emptyReason === SEARCH_UNSUPPORTED_REASONS.emptyAfterNormalization) {
      return {
        category: 'unsupported',
        title: '검색어를 입력해 주세요.',
        description: '',
      };
    }
    return {
      category: 'no-data',
      title: '사전에 없는 말입니다.',
      description: '자주 쓰는 말이라면 등록을 요청해 보세요.',
    };
  }

  if (props.error?.kind === 'load') {
    return {
      category: 'runtime',
      title: '사전을 불러오지 못했습니다.',
      description: '패키지된 사전 파일을 확인한 뒤 다시 시도해 주세요.',
    };
  }
  if (props.error?.kind === 'query') {
    return {
      category: 'runtime',
      title: '검색을 처리하지 못했습니다.',
      description: '잠시 후 다시 시도해 주세요.',
    };
  }
  return {
    category: 'unknown',
    title: '결과를 표시할 수 없습니다.',
    description: '',
  };
});

const statusTitle = computed(() => statePresentation.value.title);
const statusDescription = computed(() => statePresentation.value.description);

const showRetry = computed(() => props.status === SEARCH_STATUS.error);

function setCandidateRef(recordId, instance) {
  if (instance) {
    candidateRefs.set(recordId, instance);
  } else {
    candidateRefs.delete(recordId);
  }
}

function setResultRef(recordId, instance) {
  const element = instance?.$el || instance;
  if (element) {
    resultRefs.set(recordId, element);
  } else {
    resultRefs.delete(recordId);
  }
}

function candidateIndex(recordId) {
  return props.records.findIndex((record) => record.id === recordId);
}

function focusSearch() {
  searchBar.value?.focus();
}

function focusCandidateAt(index, event) {
  if (!candidateListEnabled.value || props.records.length === 0) return;

  const boundedIndex = Math.max(0, Math.min(index, props.records.length - 1));
  const record = props.records[boundedIndex];
  if (!record) return;

  event?.preventDefault();
  emit('select-candidate', record.id);
  nextTick(() => candidateRefs.get(record.id)?.focus());
}

function moveCandidate(direction, event) {
  if (!candidateListEnabled.value) return;

  const currentIndex = selectedCandidateIndex.value;
  const nextIndex = currentIndex < 0
    ? direction === 'next' ? 0 : props.records.length - 1
    : currentIndex + (direction === 'next' ? 1 : -1);
  focusCandidateAt(nextIndex, event);
}

function handleSearchBarNavigation({ direction, event }) {
  moveCandidate(direction, event);
}

function handleCandidateFocus(recordId) {
  if (candidateListEnabled.value) {
    emit('select-candidate', recordId);
  }
}

function focusCandidateResult(recordId) {
  nextTick(() => {
    const result = resultRefs.get(recordId);
    if (!result) return;

    const firstRelation = result.querySelector('.relation-link:not(.is-static)');
    (firstRelation || result).focus?.();
  });
}

function handleCandidateKeydown(recordId, event) {
  if (!candidateListEnabled.value) return;

  if (event.key === 'ArrowDown') {
    moveCandidate('next', event);
    return;
  }
  if (event.key === 'ArrowUp') {
    moveCandidate('previous', event);
    return;
  }
  if (event.key === 'Enter') {
    event.preventDefault();
    emit('select-candidate', recordId);
    focusCandidateResult(recordId);
    return;
  }
  if (event.key === 'Escape') {
    event.preventDefault();
    focusSearch();
  }
}

defineExpose({ focusSearch });
</script>

<template>
  <section
    class="dictionary-panel"
    :class="[
      {
        'is-compact': compact,
        'has-results': isReady,
        'is-relation-target': isRelationTarget,
      },
      `state-${status}`,
    ]"
    :aria-busy="status === SEARCH_STATUS.loading"
    :data-background-preset="backgroundPreset.key"
    :style="{ '--dictionary-panel-background': backgroundPreset.color }"
    data-dictionary-panel
  >
    <SearchBar
      ref="searchBar"
      :model-value="query"
      :compact="compact"
      :autofocus="autofocus"
      :readonly="!interactive"
      @update:model-value="emit('update:query', $event)"
      @submit="emit('submit', $event)"
      @clear="emit('clear')"
      @navigate-candidates="handleSearchBarNavigation"
    />

    <div v-if="isReady" class="dictionary-scroll-region">
      <div
        v-if="candidateListEnabled"
        class="candidate-list"
        role="listbox"
        aria-label="검색 후보"
      >
        <div
          v-for="record in records"
          :key="record.id"
          :ref="(element) => setCandidateRef(record.id, element)"
          class="candidate-option"
          :class="{ 'is-selected': record.id === selectedRecordId }"
          :id="`search-candidate-${record.id}`"
          :data-record-id="record.id"
          role="option"
          tabindex="-1"
          :aria-selected="String(record.id === selectedRecordId)"
          :aria-posinset="candidateIndex(record.id) + 1"
          :aria-setsize="records.length"
          @focus="handleCandidateFocus(record.id)"
          @keydown="handleCandidateKeydown(record.id, $event)"
          @click="emit('select-candidate', record.id)"
        >{{ record.lemma }}</div>
      </div>
      <DictionaryResult
        v-for="record in records"
        :key="record.id"
        :ref="(instance) => setResultRef(record.id, instance)"
        :record="record"
        :settings="settings"
        :compact="compact"
        :interactive="interactive"
        :show-back="showBack"
        @relation="emit('relation', $event)"
        @back="emit('back')"
      />
      <ProductFooter
        :compact="compact"
        @open-settings="emit('open-settings')"
      />
    </div>

    <div
      v-else-if="status === SEARCH_STATUS.idle || isInitialLoading"
      class="dictionary-empty-region"
      :class="{ 'is-loading': isInitialLoading }"
    >
      <ProductFooter
        :compact="compact"
        @open-settings="emit('open-settings')"
      />
    </div>

    <div
      v-else
      class="dictionary-state-region"
      :class="{ 'is-empty': status === SEARCH_STATUS.empty }"
      :data-search-state="status"
      :data-search-category="statePresentation.category"
      :data-search-reason="emptyReason || undefined"
      role="status"
      aria-live="polite"
    >
      <div class="state-copy">
        <strong>{{ statusTitle }}</strong>
        <span v-if="statusDescription">{{ statusDescription }}</span>
      </div>
      <button
        v-if="showRetry"
        class="retry-button"
        type="button"
        @click="emit('retry')"
      >다시 시도</button>
      <ProductFooter
        :compact="compact"
        @open-settings="emit('open-settings')"
      />
    </div>
  </section>
</template>

<style scoped>
.dictionary-panel {
  display: flex;
  width: 480px;
  max-width: 100vw;
  flex-direction: column;
  gap: 8px;
  padding: 10px 10px 8px;
  overflow: hidden;
  border: 1px solid #e1ddda;
  background: var(--dictionary-panel-background, #f6f3ee);
  box-shadow: 0 4px 14px rgba(26, 36, 51, 0.12);
}

.dictionary-scroll-region {
  display: flex;
  min-height: 0;
  max-height: 487px;
  flex-direction: column;
  gap: 8px;
  padding: 8px 4px 0;
  overflow-y: auto;
  scrollbar-color: #968f89 transparent;
  scrollbar-width: thin;
}

.candidate-list {
  display: flex;
  flex-wrap: wrap;
  flex-direction: row;
  gap: 8px;
  padding-bottom: 2px;
}

.candidate-option {
  width: max-content;
  max-width: 100%;
  padding: 4px 8px;
  border: 1px solid #d8d3cf;
  border-radius: 6px;
  background: #fff;
  color: #5f5955;
  cursor: pointer;
  font: inherit;
  font-size: 13px;
  line-height: 18px;
  overflow-wrap: anywhere;
  text-align: left;
}

.candidate-option.is-selected {
  border-color: #e5534b;
  background: rgba(229, 83, 75, 0.06);
  color: #7e433e;
  font-weight: 700;
}

.candidate-option:focus-visible {
  outline: 2px solid #7e433e;
  outline-offset: 2px;
}

.dictionary-scroll-region::-webkit-scrollbar {
  width: 4px;
}

.dictionary-scroll-region::-webkit-scrollbar-track {
  background: transparent;
}

.dictionary-scroll-region::-webkit-scrollbar-thumb {
  border-radius: 999px;
  background: #968f89;
}

.dictionary-scroll-region :deep(.dictionary-result + .dictionary-result) {
  padding-top: 12px;
  border-top: 1px solid #e1ddda;
}

.retry-button:focus-visible {
  outline: 2px solid #7e433e;
  outline-offset: 2px;
  border-radius: 3px;
}

.dictionary-empty-region,
.dictionary-state-region {
  display: flex;
  min-height: 20px;
  flex-direction: column;
  gap: 8px;
}

.dictionary-state-region {
  min-height: 104px;
  justify-content: center;
  padding: 8px 4px 0;
}

.dictionary-state-region.is-empty {
  min-height: 104px;
  padding: 0 4px;
  justify-content: flex-start;
}

.dictionary-state-region.is-empty .state-copy {
  flex: 1 1 auto;
  min-height: 0;
  gap: 0;
  justify-content: center;
}

.state-copy {
  display: flex;
  flex-direction: column;
  gap: 4px;
  color: #77716b;
  text-align: center;
}

.state-copy strong {
  color: #5f5955;
  font-size: 14px;
}

.state-copy span {
  font-size: 12px;
  line-height: 18px;
}

.retry-button {
  align-self: center;
  min-height: 28px;
  padding: 4px 12px;
  border: 1px solid #e5534b;
  border-radius: 6px;
  background: #fff;
  color: #7e433e;
  cursor: pointer;
  font: inherit;
  font-size: 12px;
  font-weight: 700;
}

.dictionary-panel.is-compact {
  width: 420px;
  gap: 7px;
  padding: 8.75px 8.75px 7px;
}

.dictionary-panel.is-compact .dictionary-scroll-region {
  max-height: none;
  gap: 7px;
  padding: 7px 3.5px 0;
  overflow-y: visible;
  scrollbar-width: none;
}

.dictionary-panel.is-compact .candidate-list {
  gap: 7px;
  padding-bottom: 1.75px;
}

.dictionary-panel.is-compact .candidate-option {
  padding: 3.5px 7px;
  border-radius: 5.25px;
  font-size: 11.375px;
  line-height: 15.75px;
}

.dictionary-panel.is-compact.has-results .dictionary-scroll-region {
  min-height: 0;
}

.dictionary-panel.is-compact .dictionary-scroll-region :deep(.dictionary-result + .dictionary-result) {
  padding-top: 10.5px;
}

.dictionary-panel.is-compact .dictionary-state-region {
  min-height: 92px;
  padding-top: 7px;
}

.dictionary-panel.is-compact .state-copy strong {
  font-size: 12.25px;
}

.dictionary-panel.is-compact .state-copy span,
.dictionary-panel.is-compact .retry-button {
  font-size: 10.5px;
}

.dictionary-panel.is-compact .dictionary-scroll-region::-webkit-scrollbar {
  display: none;
}
</style>
